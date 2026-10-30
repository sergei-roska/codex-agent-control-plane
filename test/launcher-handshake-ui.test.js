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
  const elements = {
    accountsList: element(), autoSwitchToggle: element(), accountsQuotaPreview: element(),
    accountsQuota5hFill: element(), accountsQuota5hTrack: element(), accountsQuota5hValue: element(),
    accountsQuotaWeeklyFill: element(), accountsQuotaWeeklyTrack: element(), accountsQuotaWeeklyValue: element(),
  };
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
  vm.runInContext(['textEl', 'formatResetCountdown', 'limitBlock', 'renderAccountQuotaPreview', 'accountBlock', 'renderAccounts'].map(functionSource).join('\n'), context);
  context.renderAccounts(data);
  const profileCard = elements.accountsList.children[1];
  const actions = profileCard.children.at(-1);
  return { context, data, elements, button: actions.children[0], status: actions.children[1], get resolveApi() { return resolveApi; } };
}

describe('account handshake card', () => {
  it('previews active-account quotas and refreshes the summary on every render', () => {
    const card = loadCard();
    const { accountsQuotaPreview, accountsQuota5hFill, accountsQuota5hTrack, accountsQuota5hValue,
      accountsQuotaWeeklyFill, accountsQuotaWeeklyTrack, accountsQuotaWeeklyValue } = card.elements;
    card.data.profiles[0].active = false;
    card.context.renderAccounts(card.data);
    assert.equal(accountsQuota5hFill.style.width, '0%');
    assert.equal(accountsQuota5hTrack.classList.contains('is-unknown'), true);
    assert.equal(accountsQuota5hValue.textContent, '--');
    assert.match(accountsQuotaPreview.attrs['aria-label'], /No active account/);

    card.data.profiles[0].primary = { usedPercent: 65 };
    card.data.profiles[0].secondary = { usedPercent: 90 };
    card.data.profiles[0].active = true;
    card.context.renderAccounts(card.data);
    assert.equal(accountsQuota5hFill.style.width, '35%');
    assert.equal(accountsQuota5hFill.className, 'progress-bar-fill accounts-quota-preview-fill warning');
    assert.equal(accountsQuota5hTrack.classList.contains('is-unknown'), false);
    assert.equal(accountsQuota5hValue.textContent, '35%');
    assert.equal(accountsQuotaWeeklyFill.style.width, '10%');
    assert.equal(accountsQuotaWeeklyFill.className, 'progress-bar-fill accounts-quota-preview-fill danger');
    assert.equal(accountsQuotaWeeklyValue.textContent, '10%');
    assert.match(accountsQuotaPreview.attrs['aria-label'], /alpha: 5-hour quota 35% remaining; weekly quota 10% remaining/);

    card.data.profiles[0].primary = null;
    card.data.profiles[0].secondary = { usedPercent: 10 };
    card.context.renderAccounts(card.data);
    assert.equal(accountsQuota5hValue.textContent, '--');
    assert.equal(accountsQuota5hTrack.classList.contains('is-unknown'), true);
    assert.equal(accountsQuotaWeeklyFill.style.width, '90%');
    assert.match(accountsQuotaPreview.attrs['aria-label'], /5-hour quota unavailable/);

    card.data.system = { active: true, primary: { usedPercent: 105 }, secondary: { usedPercent: -5 } };
    card.context.renderAccounts(card.data);
    assert.equal(accountsQuota5hFill.style.width, '0%');
    assert.equal(accountsQuota5hFill.className, 'progress-bar-fill accounts-quota-preview-fill danger');
    assert.equal(accountsQuotaWeeklyFill.style.width, '100%');
    assert.match(accountsQuotaPreview.attrs['aria-label'], /Active account System account/);
  });

  it('does not report unknown account limit usage as fully available', () => {
    const card = loadCard();
    const profile = card.elements.accountsList.children[1];
    const primary = profile.children[1];
    const fill = primary.children[1].children[0];
    assert.equal(primary.children[0].children[1].textContent, 'Unavailable');
    assert.equal(fill.style.width, '0%');
    assert.equal(primary.children[1].classList.contains('is-unknown'), true);
  });

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
