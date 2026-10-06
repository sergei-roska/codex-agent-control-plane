'use strict';

// PC-1 dashboard UI: the System Prompt column and the project rules modal, driven through a small
// fake DOM with a mocked API (no browser, no network).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const DASH = path.join(__dirname, '../web/dashboard');
const read = (p) => fs.readFileSync(path.join(DASH, p), 'utf8');

class FakeEl {
  constructor(doc, tag) {
    this.doc = doc; this.tag = String(tag).toLowerCase(); this.children = []; this.parent = null;
    this.attrs = {}; this.listeners = {}; this.className = ''; this.value = ''; this.disabled = false; this.hidden = false;
    this._text = '';
    const el = this;
    this.classList = {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }
    };
    Object.defineProperty(this, 'dataset', { value: {} });
    this.el = el;
  }
  set textContent(v) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get firstChild() { return this.children[0] || null; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(n, fn) { (this.listeners[n] = this.listeners[n] || []).push(fn); }
  click() { if (this.disabled) return undefined; return this.fire('click', { target: this }); }
  fire(n, ev) { return Promise.all((this.listeners[n] || []).map((fn) => fn(Object.assign({ target: this, preventDefault() {} }, ev)))); }
  focus() { this.doc.activeElement = this; }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  closest(sel) { for (let x = this; x; x = x.parent) if (sel === '[hidden]' && x.hidden) return x; return null; }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
  find(pred) { const out = []; this.walk((n) => { if (pred(n)) out.push(n); }); return out; }
  querySelectorAll(sel) {
    const tags = sel.split(',').map((s) => s.trim());
    return this.find((n) => n !== this && tags.includes(n.tag));
  }
}

function setup({ roles, rulesData, apiHandlers = {} }) {
  const doc = { activeElement: null, listeners: {}, byId: {}, roots: [] };
  doc.createElement = (tag) => new FakeEl(doc, tag);
  doc.getElementById = (id) => doc.byId[id] || null;
  doc.addEventListener = (n, fn) => { (doc.listeners[n] = doc.listeners[n] || []).push(fn); };
  doc.fireKey = (ev) => Promise.all((doc.listeners.keydown || []).map((fn) => fn(Object.assign({ preventDefault() {} }, ev))));
  doc.querySelector = (sel) => {
    const m = /^\[data-role-rules="(.*)"\]$/.exec(sel);
    if (!m) return null;
    for (const root of doc.roots) {
      const hit = root.find((n) => n.attrs['data-role-rules'] === m[1])[0];
      if (hit) return hit;
    }
    return null;
  };

  const shell = (id, tag = 'div') => { const e = doc.createElement(tag); e.attrs.id = id; doc.byId[id] = e; return e; };
  const modal = shell('modal-role-rules');
  const box = doc.createElement('div'); modal.appendChild(box);
  ['rr-title', 'btn-rr-close', 'rr-status', 'rr-load', 'rr-content', 'rr-list', 'rr-new-text', 'rr-counter', 'btn-rr-add',
    'rr-field-error', 'btn-rr-history', 'rr-history'].forEach((id) => {
    const tag = id.startsWith('btn-') ? 'button' : (id === 'rr-new-text' ? 'textarea' : 'div');
    box.appendChild(shell(id, tag));
  });
  doc.byId['rr-content'].hidden = true;
  doc.byId['rr-history'].hidden = true;
  const tbody = shell('role-defaults-body', 'tbody');
  doc.roots.push(tbody);

  const calls = [];
  const state = { roles: JSON.parse(JSON.stringify(roles)), rules: JSON.parse(JSON.stringify(rulesData)) };
  const api = {
    apiGet: async (p) => {
      if (apiHandlers[p]) return apiHandlers[p]();
      if (p === '/settings/roles') return { roles: state.roles };
      if (/\/rules$/.test(p)) return state.rules;
      throw new Error('unexpected GET ' + p);
    },
    apiRequest: async (method, p, opts) => {
      calls.push({ method, path: p, body: opts && opts.body });
      const handler = apiHandlers[method + ' ' + p];
      if (handler) return handler(opts);
      return { revision: {}, replayed: false };
    }
  };

  class ApiError extends Error {
    constructor(status, code, message, requestId, details) { super(message); this.status = status; this.code = code; this.details = details; }
  }
  const context = Object.assign({ document: doc, window: {}, ApiError, Conn: { status: 'connected' }, console }, api);
  vm.createContext(context);
  ['js/util.js', 'js/tabs/connections.js', 'js/modals/role-rules.js'].forEach((f) => vm.runInContext(read(f), context, { filename: f }));
  const renderTable = () => {
    tbody.textContent = '';
    state.roles.forEach((row) => context.cmRoleRow(row, true).forEach((tr) => tbody.appendChild(tr)));
  };
  context.renderConnections = renderTable;
  context.reloadRoles = async () => { vm.runInContext('cm.roles = __roles', Object.assign(context, { __roles: { roles: state.roles } })); };
  vm.runInContext('initRoleRulesEvents()', context);
  renderTable();
  const ev = (code) => vm.runInContext(code, context);
  return { doc, context, calls, state, tbody, renderTable, ev, ApiError, el: (id) => doc.byId[id], rrState: () => ev('rr') };
}

const flush = () => new Promise((r) => setImmediate(r));
const ROLE = { roleRuntimeId: 'dlv-developer', displayName: 'Developer', kind: 'worker', effective: { source: 'profile' }, rules: { rulesRevisionId: null, count: 0 } };
const LIMITS = { maxRuleChars: 50, maxRules: 3, maxTotalChars: 120 };
const rulesDoc = (rules, rev = 'rr-1') => ({
  packId: 'p', roleRuntimeId: 'dlv-developer', currentRevisionId: rules.length ? rev : null, rules, limits: LIMITS, history: []
});
const roleBtn = (h) => h.doc.querySelector('[data-role-rules="dlv-developer"]');
async function openModal(h) { roleBtn(h).click(); await flush(); await flush(); }
const type = (h, text) => { h.el('rr-new-text').value = text; return h.el('rr-new-text').fire('input', {}); };

test('table has a System Prompt column between Source and Actions and a per-role rules button', () => {
  const html = read('tabs/connections.html');
  assert.match(html, /<th>Source<\/th>\s*<th>System Prompt<\/th>\s*<th>Actions<\/th>/);
  const zero = setup({ roles: [ROLE], rulesData: rulesDoc([]) });
  assert.equal(roleBtn(zero).textContent, 'Add rules');
  assert.equal(roleBtn(zero).getAttribute('aria-label'), 'Add rules for Developer');
  const some = setup({ roles: [Object.assign({}, ROLE, { rules: { rulesRevisionId: 'rr-1', count: 3 } })], rulesData: rulesDoc([]) });
  assert.equal(roleBtn(some).textContent, 'Rules (3)');
  assert.match(roleBtn(some).getAttribute('aria-label'), /Developer/);
  const legacy = setup({ roles: [Object.assign({}, ROLE, { rules: undefined })], rulesData: rulesDoc([]) });
  assert.equal(roleBtn(legacy).textContent, 'Add rules');
});

test('modal shows the empty state, the title and the scope note', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([]) });
  await openModal(h);
  assert.equal(h.el('modal-role-rules').classList.contains('open'), true);
  assert.equal(h.el('rr-title').textContent, 'Project rules - Developer');
  assert.equal(h.el('rr-content').hidden, false);
  assert.equal(h.el('rr-list').textContent, 'No project rules for this role yet.');
  assert.equal(h.el('btn-rr-add').disabled, true);
  const shell = read('modals/role-rules.html');
  assert.match(shell, /role="dialog" aria-modal="true" aria-labelledby="rr-title"/);
  assert.match(shell, /never grant tools, access, credentials or permissions/);
  assert.match(shell, /for="rr-new-text"/);
  assert.match(shell, /id="rr-status" class="rr-status" role="status" aria-live="polite"/);
});

test('populated modal renders rule text as text and never as markup', async () => {
  const evil = '<img onerror=x> keep <b>this</b>';
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([{ ruleId: 'r1', text: evil }, { ruleId: 'r2', text: 'Second' }]) });
  await openModal(h);
  const items = h.el('rr-list').find((n) => n.attrs['data-rule-id']);
  assert.equal(items.length, 2);
  const textNode = items[0].find((n) => n.className === 'rr-rule-text')[0];
  assert.equal(textNode.textContent, evil);
  assert.equal(textNode.children.length, 0);
  assert.equal(h.el('rr-list').find((n) => n.tag === 'img').length, 0);
  const labels = h.el('rr-list').find((n) => n.tag === 'button').map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(labels, ['Edit rule 1', 'Remove rule 1', 'Edit rule 2', 'Remove rule 2']);
});

test('add sends POST with commandId and expectedRevisionId, clears the draft and refreshes the table label', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([]) });
  await openModal(h);
  await type(h, '  Always run tests  ');
  assert.equal(h.el('btn-rr-add').disabled, false);
  assert.equal(h.el('rr-counter').textContent, '34 characters left');
  // Server state after the add.
  h.state.rules = rulesDoc([{ ruleId: 'r1', text: 'Always run tests' }], 'rr-2');
  h.state.roles[0].rules = { rulesRevisionId: 'rr-2', count: 1 };
  await h.el('btn-rr-add').click();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].path, '/settings/roles/dlv-developer/rules');
  assert.equal(h.calls[0].body.text, 'Always run tests');
  assert.equal(h.calls[0].body.expectedRevisionId, null);
  assert.match(h.calls[0].body.commandId, /^rule-/);
  assert.equal(h.el('rr-new-text').value, '');
  assert.match(h.el('rr-status').textContent, /Rule added\. Applies to new runs only\./);
  assert.equal(roleBtn(h).textContent, 'Rules (1)');
  assert.equal(h.el('rr-list').find((n) => n.attrs['data-rule-id']).length, 1);
});

test('edit sends PUT and remove asks for confirmation then sends DELETE with a body', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([{ ruleId: 'r1', text: 'One' }, { ruleId: 'r2', text: 'Two' }], 'rr-5') });
  await openModal(h);
  const btn = (label) => h.el('rr-list').find((n) => n.tag === 'button' && n.getAttribute('aria-label') === label)[0];
  btn('Edit rule 1').click();
  const ta = h.el('rr-list').find((n) => n.tag === 'textarea')[0];
  assert.equal(ta.value, 'One');
  const save = () => h.el('rr-list').find((n) => n.tag === 'button' && n.textContent === 'Save')[0];
  assert.equal(save().disabled, true, 'unchanged text cannot be saved');
  ta.value = 'One changed';
  await ta.fire('input', {});
  await save().click();
  await flush();
  assert.equal(h.calls[0].method, 'PUT');
  assert.equal(h.calls[0].path, '/settings/roles/dlv-developer/rules/r1');
  assert.equal(h.calls[0].body.text, 'One changed');
  assert.equal(h.calls[0].body.expectedRevisionId, 'rr-5');
  assert.match(h.calls[0].body.commandId, /^rule-/);
  btn('Remove rule 2').click();
  assert.equal(h.calls.length, 1, 'remove needs a confirmation');
  assert.match(h.el('rr-list').textContent, /Remove this rule\?/);
  await btn('Confirm remove rule 2').click();
  await flush();
  assert.equal(h.calls[1].method, 'DELETE');
  assert.equal(h.calls[1].path, '/settings/roles/dlv-developer/rules/r2');
  assert.deepEqual(Object.keys(h.calls[1].body).sort(), ['commandId', 'expectedRevisionId']);
  assert.equal(h.calls[1].body.expectedRevisionId, 'rr-5');
});

test('409 stale_version reloads the rules and keeps the draft', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([]) });
  await openModal(h);
  await type(h, 'Keep me');
  const apiRequest = h.context.apiRequest;
  h.context.apiRequest = async (m, p, o) => {
    await apiRequest(m, p, o);
    throw new h.ApiError(409, 'stale_version', 'stale', 'req', { currentRevisionId: 'rr-9' });
  };
  h.state.rules = rulesDoc([{ ruleId: 'x', text: 'Someone else' }], 'rr-9');
  await h.el('btn-rr-add').click();
  await flush();
  assert.equal(h.el('rr-status').textContent, 'Rules changed elsewhere; reloaded.');
  assert.equal(h.el('rr-status').getAttribute('role'), 'alert');
  assert.equal(h.el('rr-new-text').value, 'Keep me');
  assert.match(h.el('rr-list').textContent, /Someone else/);
  assert.equal(h.el('btn-rr-add').disabled, false);
});

test('server field errors are shown inline and network errors keep the draft', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([]) });
  await openModal(h);
  await type(h, 'Too much for the server');
  let failure = new h.ApiError(400, 'validation_failed', 'Rule text exceeds the limit.');
  h.context.apiRequest = async () => { throw failure; };
  await h.el('btn-rr-add').click();
  await flush();
  assert.equal(h.el('rr-field-error').textContent, 'Rule text exceeds the limit.');
  assert.equal(h.el('rr-new-text').value, 'Too much for the server');
  failure = new h.ApiError(0, 'network_error', 'Cannot reach the orchestrator');
  await h.el('btn-rr-add').click();
  await flush();
  assert.match(h.el('rr-status').textContent, /Cannot reach the orchestrator/);
  assert.equal(h.el('rr-new-text').value, 'Too much for the server');
  assert.equal(h.el('btn-rr-add').disabled, false, 'retry stays possible');
});

test('limits disable the Add button and the counter reports the overflow', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([{ ruleId: 'r1', text: 'a'.repeat(40) }]) });
  await openModal(h);
  await type(h, 'b'.repeat(50));
  assert.equal(h.el('btn-rr-add').disabled, false);
  await type(h, 'b'.repeat(51));
  assert.equal(h.el('btn-rr-add').disabled, true);
  assert.equal(h.el('rr-counter').textContent, '1 characters over the limit');
  await type(h, '   ');
  assert.equal(h.el('btn-rr-add').disabled, true);
  // Total budget: 40 + 50 + 40 > 120 once a second long rule exists.
  const full = setup({ roles: [ROLE], rulesData: rulesDoc([{ ruleId: 'r1', text: 'a'.repeat(50) }, { ruleId: 'r2', text: 'a'.repeat(50) }]) });
  await openModal(full);
  await type(full, 'c'.repeat(30));
  assert.equal(full.el('btn-rr-add').disabled, true);
  const maxed = setup({ roles: [ROLE], rulesData: rulesDoc([{ ruleId: 'a', text: 'x' }, { ruleId: 'b', text: 'y' }, { ruleId: 'c', text: 'z' }]) });
  await openModal(maxed);
  await type(maxed, 'ok');
  assert.equal(maxed.el('btn-rr-add').disabled, true);
  assert.match(maxed.el('rr-counter').textContent, /Rule limit reached \(3\)/);
});

test('mutations are disabled while the dashboard is disconnected', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([{ ruleId: 'r1', text: 'One' }]) });
  await openModal(h);
  h.context.Conn.status = 'reconnecting';
  await type(h, 'draft');
  assert.equal(h.el('btn-rr-add').disabled, true);
});

test('load failure shows Retry that reloads', async () => {
  let fail = true;
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([]), apiHandlers: {
    '/settings/roles/dlv-developer/rules': async () => {
      if (fail) throw new Error('boom');
      return rulesDoc([]);
    }
  } });
  await openModal(h);
  assert.equal(h.el('rr-content').hidden, true);
  assert.match(h.el('rr-load').textContent, /Rules unavailable: boom/);
  fail = false;
  await h.el('rr-load').find((n) => n.attrs.id === 'btn-rr-retry')[0].click();
  await flush();
  assert.equal(h.el('rr-content').hidden, false);
  assert.equal(h.el('rr-load').textContent, '');
});

test('history is collapsible and read-only', async () => {
  const doc = rulesDoc([{ ruleId: 'r1', text: 'One' }]);
  doc.history = [{ rulesRevisionId: 'rr-1', actor: 'sr', createdAt: '2026-10-01T10:00:00.000Z', changeKind: 'add', changeRuleId: 'r1', ruleCount: 1 }];
  const h = setup({ roles: [ROLE], rulesData: doc });
  await openModal(h);
  assert.equal(h.el('rr-history').hidden, true);
  await h.el('btn-rr-history').click();
  assert.equal(h.el('rr-history').hidden, false);
  assert.equal(h.el('btn-rr-history').getAttribute('aria-expanded'), 'true');
  assert.match(h.el('rr-history').textContent, /Added.*by sr.*1 rule/);
  assert.equal(h.el('rr-history').find((n) => n.tag === 'button').length, 0);
});

test('Esc closes the modal and focus returns to the (re-rendered) Add rules button', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([]) });
  const opener = roleBtn(h);
  await openModal(h);
  assert.equal(h.doc.activeElement, h.el('btn-rr-close'), 'focus moves into the dialog');
  h.renderTable();
  assert.notEqual(roleBtn(h), opener);
  await h.doc.fireKey({ key: 'Escape' });
  assert.equal(h.el('modal-role-rules').classList.contains('open'), false);
  assert.equal(h.doc.activeElement, roleBtn(h));
  assert.equal(h.rrState().open, false);
});

test('Tab is trapped inside the dialog', async () => {
  const h = setup({ roles: [ROLE], rulesData: rulesDoc([]) });
  await openModal(h);
  const items = h.el('modal-role-rules').querySelectorAll('button, textarea').filter((el) => !el.disabled && !el.closest('[hidden]'));
  const first = items[0];
  const last = items[items.length - 1];
  last.focus();
  await h.doc.fireKey({ key: 'Tab', shiftKey: false });
  assert.equal(h.doc.activeElement, first);
  await h.doc.fireKey({ key: 'Tab', shiftKey: true });
  assert.equal(h.doc.activeElement, last);
});

test('the modal is registered in the build and the generated index.html is in sync', () => {
  const build = read('build.js');
  assert.match(build, /modals\/role-rules\.html/);
  assert.match(build, /js\/modals\/role-rules\.js/);
  const index = read('index.html');
  assert.match(index, /id="modal-role-rules"/);
  assert.match(index, /<script src="js\/modals\/role-rules\.js"><\/script>/);
  assert.match(index, /<th>System Prompt<\/th>/);
  assert.match(read('css/main.css'), /modals\/role-rules\.css/);
  for (const f of ['modals/role-rules.html', 'js/modals/role-rules.js', 'css/modals/role-rules.css']) {
    assert.doesNotMatch(read(f), /[^\x00-\x7F]/, f + ' must be ASCII');
  }
});
