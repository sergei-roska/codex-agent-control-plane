'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'app.js'), 'utf8');
function functionSource(name) {
  const start = APP_SRC.search(new RegExp('^ {4}(?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1);
  const end = APP_SRC.indexOf('\n    }\n', start);
  assert.notEqual(end, -1);
  return APP_SRC.slice(start, end + '\n    }\n'.length);
}
function element() {
  const classes = new Set();
  return {
    disabled: false, attrs: {}, textContent: '', classes,
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
  };
}
function setup() {
  const button = element(); const status = element(); const errors = [];
  const requests = [];
  const context = {
    accountsRevision: 0, accountsRequestId: 0, accountsForceRequestId: 0, accountsForceInFlight: false,
    accountHandshakesInFlight: new Set(),
    document: { getElementById(id) { return id === 'accountsRefreshBtn' ? button : id === 'accountsRefreshStatus' ? status : element(); } },
    accountsApi(method, url) { return new Promise((resolve, reject) => requests.push({ method, url, resolve, reject })); },
    showAccountsError(message) { errors.push(message); },
    renderAccounts(data) { context.rendered = data; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('fetchAccounts'), context);
  return { context, button, status, errors, requests };
}

describe('account manual refresh', () => {
  it('forces a read, takes precedence over an older background request, and reports completion', async () => {
    const state = setup();
    const background = state.context.fetchAccounts(false);
    const refresh = state.context.fetchAccounts(true);
    assert.equal(state.requests[0].url, '/api/accounts');
    assert.equal(state.requests[1].url, '/api/accounts?force=1');
    assert.equal(state.button.disabled, true);
    assert.equal(state.button.attrs['aria-busy'], 'true');
    assert.equal(state.status.textContent, 'Refreshing...');
    state.requests[1].resolve({ generation: 'forced' });
    await refresh;
    state.requests[0].resolve({ generation: 'cached' });
    await background;
    assert.deepEqual(state.context.rendered, { generation: 'forced' });
    assert.equal(state.status.textContent, 'Accounts refreshed');
    assert.equal(state.button.disabled, false);
    assert.equal(state.button.attrs['aria-busy'], undefined);
  });

  it('reports refresh failure and ignores a stale background error', async () => {
    const state = setup();
    const background = state.context.fetchAccounts(false);
    const refresh = state.context.fetchAccounts(true);
    state.requests[1].reject(new Error('provider unavailable'));
    await refresh;
    state.requests[0].reject(new Error('stale cached failure'));
    await background;
    assert.equal(state.status.textContent, 'Refresh failed');
    assert.ok(state.status.classes.has('is-error'));
    assert.deepEqual(state.errors, ['Failed to load accounts: provider unavailable']);
    assert.equal(state.button.disabled, false);
  });
});
