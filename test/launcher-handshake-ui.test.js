'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'app.js'), 'utf8');

function functionSource(name) {
  const start = APP_SRC.search(new RegExp('^ {4}(?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, 'function ' + name + ' not found in app.js');
  const end = APP_SRC.indexOf('\n    }\n', start);
  assert.notEqual(end, -1, 'end of function ' + name + ' not found');
  return APP_SRC.slice(start, end + '\n    }\n'.length);
}

function element() {
  const classes = new Set();
  return {
    children: [],
    attrs: {},
    style: {},
    disabled: false,
    className: '',
    _textContent: '',
    get textContent() { return this._textContent; },
    set textContent(value) {
      this._textContent = String(value);
      if (this._textContent === '') this.children = [];
    },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener(name, callback) { this.listeners ||= {}; this.listeners[name] = callback; },
    click() { this.listeners.click(); },
  };
}

function loadCard(apiResult, nowMs = Date.now()) {
  const elements = { accountsList: element(), autoSwitchToggle: element() };
  let resolveApi;
  const data = {
    system: { active: false, primary: null, secondary: null },
    profiles: [{ name: 'alpha', active: true, primary: null, secondary: null }],
    autoSwitch: false,
  };
  const FixedDate = class extends Date { static now() { return nowMs; } };
  const context = {
    Date: FixedDate,
    Number,
    document: {
      createElement: element,
      getElementById(id) { return elements[id]; },
    },
    accountsData: data,
    accountsRevision: 0,
    accountHandshakeStates: new Map(),
    accountHandshakesInFlight: new Set(),
    accountsApi() { return new Promise((resolve) => { resolveApi = () => resolve(apiResult); }); },
    fetchAccounts() {},
    showAccountsError() {},
  };
  vm.createContext(context);
  vm.runInContext(['textEl', 'formatResetCountdown', 'limitBlock', 'accountBlock', 'renderAccounts'].map(functionSource).join('\n'), context);
  context.renderAccounts(data);
  const profileCard = elements.accountsList.children[1];
  const actions = profileCard.children.at(-1);
  return { context, data, elements, button: actions.children[0], status: actions.children[1], get resolveApi() { return resolveApi; } };
}

describe('account handshake card', () => {
  it('renders the provider future reset countdown and completed handshake status', async () => {
    const nowMs = 1_800_000_000_000;
    const resetsAt = nowMs / 1000 + 5 * 60 * 60 + 60;
    const card = loadCard({
      success: true,
      turnStatus: 'completed',
      limitsRead: true,
      email: 'alpha@example.com',
      planType: 'plus',
      primary: { usedPercent: 17, windowDurationMins: 300, resetsAt },
      secondary: { usedPercent: 22 },
    }, nowMs);
    assert.equal(card.button.title, 'Send a short request and refresh this account usage window');
    card.button.click();
    card.resolveApi();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(card.data.profiles[0].primary.resetsAt, resetsAt);
    assert.equal(card.context.accountHandshakeStates.get('alpha').text, 'Turn complete; limits refreshed');
    const primaryLimit = card.elements.accountsList.children.at(-1).children[1];
    assert.match(primaryLimit.children.at(-1).textContent, /\(5h 1m\)/);
  });

  it('refreshes the selected card and marks missing reset information pending', async () => {
    const card = loadCard({
      success: true,
      turnStatus: 'completed',
      limitsRead: true,
      email: 'alpha@example.com',
      planType: 'plus',
      primary: { usedPercent: 17 },
      secondary: { usedPercent: 22 },
    });
    card.button.click();
    card.resolveApi();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(card.data.profiles[0].primary.usedPercent, 17);
    assert.equal(card.context.accountHandshakeStates.get('alpha').text, 'Limits pending');
    const rerendered = card.elements.accountsList.children.at(-1).children.at(-1).children[1];
    assert.equal(rerendered.textContent, 'Limits pending');
    assert.equal(card.context.accountHandshakesInFlight.size, 0);
  });

  it('rejects legacy success responses that do not confirm a completed turn and fresh limits', async () => {
    const card = loadCard({ success: true, email: 'alpha@example.com', planType: 'plus' });
    card.button.click();
    card.resolveApi();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(card.data.profiles[0].primary, null);
    assert.equal(card.context.accountHandshakeStates.get('alpha').kind, 'error');
    assert.match(card.context.accountHandshakeStates.get('alpha').error, /Restart the launcher/);
  });
});
