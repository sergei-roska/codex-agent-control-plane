'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'app.js'), 'utf8');
const CONNECTOR_START = APP_SRC.indexOf('    const CONNECTOR_POLL_MS =');
const CONNECTOR_END = APP_SRC.indexOf('\n    loadConnectors();', CONNECTOR_START);
assert.notEqual(CONNECTOR_START, -1);
assert.notEqual(CONNECTOR_END, -1);
const CONNECTOR_SRC = APP_SRC.slice(CONNECTOR_START, CONNECTOR_END);

function element() {
  const classes = new Set();
  const node = {
    children: [],
    attrs: {},
    style: {},
    disabled: false,
    className: '',
    _textContent: '',
    get textContent() {
      return this._textContent + this.children.map((child) => child.textContent || '').join('');
    },
    set textContent(value) {
      this._textContent = String(value);
      this.children = [];
    },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(name, callback) { this.listeners ||= {}; this.listeners[name] = callback; },
    click() {
      if (this.disabled) return undefined;
      return this.listeners && this.listeners.click ? this.listeners.click() : undefined;
    },
  };
  return node;
}

function findText(root, text) {
  if (root.textContent === text) return root;
  for (const child of root.children || []) {
    const found = findText(child, text);
    if (found) return found;
  }
  return null;
}

function makeHarness(initialConnectors) {
  const elements = { connectorsSlot: element(), connectorsError: element() };
  const calls = [];
  const timers = new Map();
  const tabs = [];
  let timerId = 0;
  let connectors = initialConnectors;
  let switchResponse = { authUrl: 'https://auth.example.test/authorize' };
  let switchStatus = 200;
  let enableResponse = null;
  let enableStatus = 200;
  let deferNextGet = false;
  let failNextGet = false;
  let resolveDeferredGet = null;
  const context = {
    document: {
      createElement: element,
      getElementById(id) { return elements[id]; },
    },
    window: {
      open(url, target) {
        const tab = { opener: {}, location: { href: url }, target, closed: false, close() { this.closed = true; } };
        tabs.push(tab);
        return tab;
      },
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options, tabsOpened: tabs.length });
      if (url === '/api/connectors') {
        if (failNextGet) {
          failNextGet = false;
          return { ok: false, status: 503, json: async () => ({ error: 'Status refresh failed' }) };
        }
        if (deferNextGet) {
          deferNextGet = false;
          return new Promise((resolve) => {
            resolveDeferredGet = (data) => resolve({ ok: true, status: 200, json: async () => data });
          });
        }
        return { ok: true, status: 200, json: async () => ({ connectors }) };
      }
      if (url.endsWith('/switch-account')) return {
        ok: switchStatus >= 200 && switchStatus < 300, status: switchStatus, json: async () => switchResponse,
      };
      if (url.endsWith('/enabled')) return {
        ok: enableStatus >= 200 && enableStatus < 300, status: enableStatus,
        json: async () => enableResponse || { success: true, name: 'harness-figma', enabled: JSON.parse(options.body).enabled },
      };
      throw new Error('Unexpected mocked request: ' + url);
    },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
    clearTimeout() {},
    setTimeout() { return 0; },
    encodeURIComponent,
    Date,
    JSON,
    Object,
    Array,
    String,
    Error,
  };
  vm.createContext(context);
  vm.runInContext('function textEl(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; el.textContent = text; return el; }\n' + CONNECTOR_SRC, context);
  return {
    context, elements, calls, timers, tabs,
    setConnectors(value) { connectors = value; },
    setSwitchResponse(value, status = 200) { switchResponse = value; switchStatus = status; },
    setEnableResponse(value, status = 200) { enableResponse = value; enableStatus = status; },
    deferNextConnectorGet() { deferNextGet = true; },
    failNextConnectorGet() { failNextGet = true; },
    resolveDeferredConnectorGet(data) {
      assert.equal(typeof resolveDeferredGet, 'function', 'no deferred connector GET is pending');
      const resolve = resolveDeferredGet;
      resolveDeferredGet = null;
      resolve(data);
    },
  };
}

describe('connector controls UI', () => {
  it('shows connected and disabled independently and enables through the preference API', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: false }]);
    await h.context.loadConnectors();

    const slot = h.elements.connectorsSlot;
    assert.ok(findText(slot, 'Connected'));
    assert.ok(findText(slot, 'Disabled'));
    assert.ok(findText(slot, 'Enable'));

    await findText(slot, 'Enable').click();
    await new Promise((resolve) => setImmediate(resolve));
    const request = h.calls.find((call) => call.url.endsWith('/enabled'));
    assert.equal(request.options.method, 'PUT');
    assert.deepEqual(JSON.parse(request.options.body), { enabled: true });
    assert.equal(vm.runInContext('connectorList[0].enabled', h.context), true);
    assert.ok(findText(slot, 'Connected'));
    assert.equal(findText(slot, 'Disabled'), null);
    assert.ok(findText(slot, 'Disable'));
  });

  it('keeps legacy connector status and Connect behavior without exposing unsupported controls', async () => {
    const h = makeHarness([
      { name: 'harness-figma', title: 'Figma', state: 'signed_in' },
      { name: 'harness-context7', title: 'Context7', state: 'needs_sign_in' },
    ]);
    await h.context.loadConnectors();

    assert.ok(findText(h.elements.connectorsSlot, 'Connected'));
    assert.ok(findText(h.elements.connectorsSlot, 'Not connected'));
    assert.ok(findText(h.elements.connectorsSlot, 'Connect'));
    assert.equal(findText(h.elements.connectorsSlot, 'Enable'), null);
    assert.equal(findText(h.elements.connectorsSlot, 'Disable'), null);
    assert.equal(findText(h.elements.connectorsSlot, 'Switch account'), null);
    assert.ok(findText(h.elements.connectorsSlot, 'Restart the launcher to manage connectors.'));
    assert.equal(h.calls.some((call) => call.url.endsWith('/enabled') || call.url.endsWith('/switch-account')), false);
  });

  it('ignores a connector GET started before a successful enablement mutation', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: false }]);
    await h.context.loadConnectors();
    h.deferNextConnectorGet();
    const staleLoad = h.context.loadConnectors();

    await findText(h.elements.connectorsSlot, 'Enable').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vm.runInContext('connectorList[0].enabled', h.context), true);

    h.resolveDeferredConnectorGet({
      connectors: [{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: false }],
    });
    await staleLoad;
    assert.equal(vm.runInContext('connectorList[0].enabled', h.context), true);
    assert.ok(findText(h.elements.connectorsSlot, 'Disable'));
    assert.equal(findText(h.elements.connectorsSlot, 'Disabled'), null);
  });

  it('reconciles the connector list with a fresh GET after an enablement PUT fails', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }]);
    await h.context.loadConnectors();
    h.setEnableResponse({ error: 'Preference update failed' }, 500);
    h.setConnectors([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: false }]);

    await findText(h.elements.connectorsSlot, 'Disable').click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.calls.filter((call) => call.url === '/api/connectors').length, 2);
    assert.equal(vm.runInContext('connectorList[0].enabled', h.context), false);
    assert.ok(findText(h.elements.connectorsSlot, 'Enable'));
    assert.ok(findText(h.elements.connectorsSlot, 'Preference update failed'));
  });

  it('ignores an auth GET started before switching accounts even if it resolves afterward', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }]);
    await h.context.loadConnectors();
    h.deferNextConnectorGet();
    const staleLoad = h.context.loadConnectors();

    await findText(h.elements.connectorsSlot, 'Switch account').click();
    await findText(h.elements.connectorsSlot, 'Confirm switch').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(findText(h.elements.connectorsSlot, 'Status unavailable'));

    h.resolveDeferredConnectorGet({
      connectors: [{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }],
    });
    await staleLoad;
    assert.ok(findText(h.elements.connectorsSlot, 'Status unavailable'));
    assert.equal(findText(h.elements.connectorsSlot, 'Connected'), null);
    assert.equal(findText(h.elements.connectorsSlot, 'Switch account'), null);
  });

  it('reconciles after switch-account POST failure before displaying the error', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }]);
    await h.context.loadConnectors();
    h.setSwitchResponse({ error: 'Account switch failed' }, 500);
    h.setConnectors([{ name: 'harness-figma', title: 'Figma', state: 'needs_sign_in', enabled: true }]);

    await findText(h.elements.connectorsSlot, 'Switch account').click();
    await findText(h.elements.connectorsSlot, 'Confirm switch').click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.calls.filter((call) => call.url === '/api/connectors').length, 2);
    assert.ok(findText(h.elements.connectorsSlot, 'Not connected'));
    assert.ok(findText(h.elements.connectorsSlot, 'Account switch failed'));
  });

  it('marks auth status unavailable after a failed refresh while preserving enablement controls', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }]);
    await h.context.loadConnectors();
    h.failNextConnectorGet();
    await h.context.loadConnectors();

    assert.ok(findText(h.elements.connectorsSlot, 'Status unavailable'));
    assert.equal(findText(h.elements.connectorsSlot, 'Connected'), null);
    assert.equal(findText(h.elements.connectorsSlot, 'Switch account'), null);
    assert.equal(findText(h.elements.connectorsSlot, 'Connect'), null);
    assert.ok(findText(h.elements.connectorsSlot, 'Disable'));
  });

  it('asks for inline switch confirmation and does not act when canceled', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }]);
    await h.context.loadConnectors();
    await findText(h.elements.connectorsSlot, 'Switch account').click();

    assert.match(h.elements.connectorsSlot.textContent, /saved local sign-in.*current active Codex profile/i);
    assert.ok(findText(h.elements.connectorsSlot, 'Confirm switch'));
    assert.equal(h.calls.some((call) => call.url.endsWith('/switch-account')), false);
    assert.equal(h.tabs.length, 0);

    await findText(h.elements.connectorsSlot, 'Cancel').click();
    assert.ok(findText(h.elements.connectorsSlot, 'Switch account'));
    assert.equal(h.calls.some((call) => call.url.endsWith('/switch-account')), false);
    assert.equal(h.tabs.length, 0);
  });

  it('opens the switch tab in the confirm click, posts once, then polls sign-in status', async () => {
    const h = makeHarness([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }]);
    await h.context.loadConnectors();
    await findText(h.elements.connectorsSlot, 'Switch account').click();
    await findText(h.elements.connectorsSlot, 'Confirm switch').click();
    await new Promise((resolve) => setImmediate(resolve));

    const request = h.calls.find((call) => call.url.endsWith('/switch-account'));
    assert.equal(request.options.method, 'POST');
    assert.equal(request.tabsOpened, 1, 'the tab must be opened before the request starts');
    assert.equal(h.tabs[0].location.href, 'https://auth.example.test/authorize');
    assert.equal(h.tabs[0].opener, null);
    assert.match(h.elements.connectorsSlot.textContent, /Finish sign-in in the browser tab/);

    const poll = [...h.timers.values()].find((timer) => timer.delay === 5000);
    assert.ok(poll, 'sign-in polling should start after the switch response');
    h.setConnectors([{ name: 'harness-figma', title: 'Figma', state: 'signed_in', enabled: true }]);
    poll.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.calls.filter((call) => call.url === '/api/connectors').length >= 2);
    assert.equal(h.timers.size, 0, 'polling stops when the connector is ready');
  });
});
