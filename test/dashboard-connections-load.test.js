'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../web/dashboard/js/tabs/connections.js'), 'utf8');

function load(handlers, timers = {}) {
  const renders = [];
  const observers = [];
  const pane = { classList: { contains: () => pane.active } , active: false };
  const context = {
    document: {
      getElementById: (id) => (id === 'tab-connections' ? pane : null),
      querySelector: () => null,
    },
    MutationObserver: function (cb) { observers.push(cb); this.observe = () => {}; },
    setTimeout: timers.setTimeout || setTimeout,
    clearTimeout: timers.clearTimeout || clearTimeout,
    AbortController,
    apiGet: (p, opts) => handlers[p](opts),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'connections.js' });
  vm.runInContext(`
    renderConnections = function () { __renders.push({ roles: cm.roles && 1, rolesLoaded: cm.rolesLoaded, accountLoaded: cm.accountLoaded }); };
    loadAtlassian = function () {};
  `, Object.assign(context, { __renders: renders }));
  return { context, renders, observers, pane, cm: () => vm.runInContext('cm', context) };
}

test('role defaults and catalog render without waiting for a never-settling /account', async () => {
  const fires = [];
  const { context, renders, cm } = load({
    '/account': () => new Promise(() => {}),
    '/models': async () => ({ catalog: { state: 'ok' }, models: [] }),
    '/settings/roles': async () => ({ roles: [] }),
  }, { setTimeout: (fn) => { fires.push(fn); return fires.length; }, clearTimeout: () => {} });
  // Only the /account timer should be left pending once the other two settle.
  const pending = vm.runInContext('loadConnections()', context);
  await new Promise((r) => setImmediate(r));
  assert.equal(cm().rolesLoaded, true);
  assert.equal(cm().catalogLoaded, true);
  assert.equal(cm().accountLoaded, false);
  assert.equal(cm().loading, true);
  assert.ok(renders.some((r) => r.roles && r.rolesLoaded && !r.accountLoaded));
  fires[0]();
  await pending;
  assert.equal(cm().loading, false);
  assert.equal(cm().accountLoaded, true);
  assert.equal(cm().account, null);
  assert.match(cm().accountError, /timed out/);
});

test('a request timeout aborts the fetch and leaves loading reusable', async () => {
  let signal = null;
  const { context, cm } = load({
    '/account': (opts) => { signal = opts.signal; return new Promise(() => {}); },
    '/models': async () => { throw new Error('boom'); },
    '/settings/roles': async () => ({ roles: [] }),
  }, { setTimeout: (fn) => setTimeout(fn, 5) });
  await vm.runInContext('loadConnections()', context);
  assert.equal(signal.aborted, true);
  assert.equal(cm().loading, false);
  assert.equal(cm().loaded, true);
  assert.match(cm().catalogError, /boom/);
  assert.match(cm().accountError, /timed out/);
});

test('a pane that becomes active without a click triggers one load', async () => {
  let accountCalls = 0;
  const { observers, pane, cm } = load({
    '/account': async () => { accountCalls += 1; return { status: 'connected' }; },
    '/models': async () => ({ catalog: { state: 'ok' }, models: [] }),
    '/settings/roles': async () => ({ roles: [] }),
  });
  assert.equal(observers.length, 1);
  observers[0]();
  assert.equal(accountCalls, 0, 'inactive pane must not load');
  pane.active = true;
  observers[0]();
  observers[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(accountCalls, 1, 'concurrent activations share one load');
  assert.equal(cm().loaded, true);
  assert.equal(cm().account.status, 'connected');
});

test('saved Atlassian sites remain visible and selected before loading the available-site list', () => {
  const { context } = load({});
  class Element {
    constructor() { this.children = []; this.hidden = false; this.value = ''; this.listeners = {}; }
    set textContent(value) { this._textContent = value; if (value === '') this.children = []; }
    get textContent() { return this._textContent || ''; }
    setAttribute(name, value) { this[name] = value; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  const elements = Object.fromEntries([
    'atlassian-status', 'atlassian-description', 'atlassian-actions', 'atlassian-resources-state',
    'atlassian-site-row', 'atlassian-site-select', 'btn-atlassian-select-site',
    'atlassian-import-panel', 'atlassian-issue-key', 'btn-atlassian-import', 'atlassian-import-site', 'atlassian-message'
  ].map(id => [id, new Element()]));
  context.document = { createElement: () => new Element(), getElementById: id => elements[id] || null };
  context.h = (tag, options = {}, children = []) => {
    const node = context.document.createElement(tag);
    if (options.class) node.className = options.class;
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.attrs) Object.entries(options.attrs).forEach(([name, value]) => node.setAttribute(name, value));
    children.filter(Boolean).forEach(child => node.appendChild(child));
    return node;
  };
  vm.runInContext(`
    ac.loaded = true;
    ac.health = { configured: true, connected: true, selectedSites: [
      { cloudId: 'saved-confluence', name: 'Docs', url: 'https://docs.example', sourceKind: 'confluence' }
    ] };
    ac.resourcesLoaded = false;
    ac.resources = [];
    ac.busy = null;
    ac.siteDraft = null;
    renderAtlassian();
  `, context);
  assert.equal(elements['atlassian-site-row'].hidden, false);
  assert.equal(elements['atlassian-site-select'].value, 'saved-confluence');
  assert.equal(elements['atlassian-site-select'].children.length, 1);
  assert.match(elements['atlassian-resources-state'].textContent, /saved Atlassian site is selected/);
  const options = JSON.parse(vm.runInContext(`JSON.stringify(acAvailableSites([], [
    { cloudId: 'saved-confluence', name: 'Docs', url: 'https://docs.example', sourceKind: 'confluence' }
  ]))`, context));
  assert.deepEqual(options, [{ id: 'saved-confluence', name: 'Docs', url: 'https://docs.example', saved: true }]);
  assert.equal(vm.runInContext(`acPreferredSiteId(acAvailableSites([], [{ cloudId: 'saved-confluence' }]), null, [{ cloudId: 'saved-confluence' }])`, context), 'saved-confluence');
  assert.equal(vm.runInContext(`acPreferredSiteId(acAvailableSites([{ id: 'new-site' }], [{ cloudId: 'saved-confluence' }]), 'new-site', [{ cloudId: 'saved-confluence' }])`, context), 'new-site');
});
