'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtlassianOAuthClient, REQUIRED_SCOPES, TOKEN_URL } = require('../src/integrations/atlassian-oauth');
const { createAtlassianReadClient } = require('../src/integrations/atlassian-read-client');

const scope = REQUIRED_SCOPES.join(' ');
function response(value, status = 200) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { ok: status >= 200 && status < 300, status, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}
function token(access = 'access-secret', refresh = 'refresh-secret', expires = 3600, scopes = scope) {
  return { access_token: access, refresh_token: refresh, expires_in: expires, token_type: 'Bearer', scope: scopes };
}
function makeOAuth({ fetchImpl, now = () => Date.now(), initial = null, ...more } = {}) {
  let saved = initial;
  const tokenStore = {
    async read() { return saved && { ...saved }; },
    async write(value) { saved = { ...value }; },
    async clear() { saved = null; },
  };
  const oauth = createAtlassianOAuthClient({ clientId: 'client-id', redirectUri: 'https://orchestrator.example/oauth/callback',
    resolveClientSecret: async () => 'client-secret', tokenStore, fetchImpl: fetchImpl || (async () => response(token())), now, ...more });
  return { oauth, tokenStore };
}
async function rejectedCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code && !/secret|token|code|upstream/i.test(error.message));
}

test('authorization uses fixed Atlassian endpoint, read scopes, and session-bound one-use state', async () => {
  const { oauth } = makeOAuth();
  const begun = await oauth.beginAuthorization({ sessionId: 'session-A' });
  const url = new URL(begun.authorizationUrl);
  assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
  assert.equal(url.searchParams.get('state'), begun.state);
  assert.deepEqual(url.searchParams.get('scope').split(' '), REQUIRED_SCOPES);
  await rejectedCode(oauth.completeAuthorization({ sessionId: 'session-B', state: begun.state, code: 'auth-code' }), 'invalid_authorization_state');
  await rejectedCode(oauth.completeAuthorization({ sessionId: 'session-A', state: begun.state, code: 'auth-code' }), 'invalid_authorization_state');
  const second = await oauth.beginAuthorization({ sessionId: 'session-A' });
  await assert.rejects(oauth.completeAuthorization({ sessionId: 'session-A', state: 'forged', code: 'auth-code' }), { code: 'invalid_authorization_state' });
  const result = await oauth.completeAuthorization({ sessionId: 'session-A', state: second.state, code: 'auth-code' });
  assert.deepEqual(result, { connected: true });
  assert.equal((await oauth.getHealth()).connected, true);
});

test('canceling an authorization frees capacity and is confined to its owning session', async () => {
  let exchanges = 0;
  const initial = { accessToken: 'existing-access', refreshToken: 'existing-refresh',
    expiresAt: Date.now() + 3600000, scopes: REQUIRED_SCOPES };
  const { oauth, tokenStore } = makeOAuth({ initial, maxPendingStates: 1,
    fetchImpl: async () => { exchanges += 1; return response(token()); } });
  const revisionBefore = oauth.getConnectionRevision();
  const healthBefore = await oauth.getHealth();
  const pending = await oauth.beginAuthorization({ sessionId: 'session-owner' });

  assert.deepEqual(oauth.cancelAuthorization({ sessionId: 'other-session', state: pending.state }), { canceled: false });
  await rejectedCode(oauth.beginAuthorization({ sessionId: 'session-owner' }), 'too_many_pending_authorizations');
  assert.deepEqual(oauth.cancelAuthorization({ sessionId: 'session-owner', state: pending.state }), { canceled: true });
  assert.deepEqual(oauth.cancelAuthorization({ sessionId: 'session-owner', state: pending.state }), { canceled: false });
  assert.deepEqual(oauth.cancelAuthorization({ sessionId: 'session-owner' }), { canceled: false });
  assert.deepEqual(oauth.cancelAuthorization(null), { canceled: false });
  assert.deepEqual(oauth.cancelAuthorization({ get state() { throw new Error('untrusted input'); } }), { canceled: false });

  const replacement = await oauth.beginAuthorization({ sessionId: 'session-owner' });
  assert.equal(typeof replacement.state, 'string');
  await rejectedCode(oauth.completeAuthorization({ sessionId: 'session-owner', state: pending.state, code: 'authorization-code' }), 'invalid_authorization_state');
  assert.equal(exchanges, 0);
  assert.deepEqual(await tokenStore.read(), initial);
  assert.equal(oauth.getConnectionRevision(), revisionBefore);
  const healthAfter = await oauth.getHealth();
  assert.deepEqual(healthAfter, { ...healthBefore, pendingAuthorizations: 1 });
  assert.deepEqual(oauth.cancelAuthorization({ sessionId: 'session-owner', state: replacement.state }), { canceled: true });
  const otherSession = await oauth.beginAuthorization({ sessionId: 'other-session' });
  const mismatchedCancel = oauth.cancelAuthorization({ sessionId: 'session-owner', state: otherSession.state });
  assert.deepEqual(mismatchedCancel, { canceled: false });
  assert.equal(JSON.stringify(mismatchedCancel).includes(otherSession.state), false);
  assert.equal(JSON.stringify(mismatchedCancel).includes('existing-access'), false);
  assert.deepEqual(await oauth.completeAuthorization({ sessionId: 'other-session', state: otherSession.state, code: 'valid-code' }), { connected: true });
  assert.equal(exchanges, 1);
});

test('state expires and authorization responses reject write scopes and malformed tokens', async () => {
  let time = 1000;
  const { oauth } = makeOAuth({ now: () => time, stateTtlMs: 1000 });
  const begun = await oauth.beginAuthorization({ sessionId: 's' });
  time = 3000;
  await rejectedCode(oauth.completeAuthorization({ sessionId: 's', state: begun.state, code: 'c' }), 'invalid_authorization_state');
  const writeScopeClient = makeOAuth({ fetchImpl: async () => response(token('a', 'r', 3600, `${scope} write:jira-work`)) }).oauth;
  const writeState = await writeScopeClient.beginAuthorization({ sessionId: 's' });
  await rejectedCode(writeScopeClient.completeAuthorization({ sessionId: 's', state: writeState.state, code: 'c' }), 'unexpected_scope');
  const malformed = makeOAuth({ fetchImpl: async () => response({ access_token: 'bad' }) }).oauth;
  const badState = await malformed.beginAuthorization({ sessionId: 's' });
  await rejectedCode(malformed.completeAuthorization({ sessionId: 's', state: badState.state, code: 'c' }), 'invalid_token_response');
});

test('refresh rotation is serialized and the rotated secret is persisted before reuse', async () => {
  let calls = 0;
  let savedRefresh = 'old-refresh';
  const fetchImpl = async (url, init) => {
    assert.equal(url, TOKEN_URL);
    assert.equal(init.redirect, 'manual');
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const body = JSON.parse(init.body);
    assert.equal(body.refresh_token, 'old-refresh');
    return response(token('new-access', 'rotated-refresh'));
  };
  const { oauth, tokenStore } = makeOAuth({ fetchImpl, initial: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0, scopes: REQUIRED_SCOPES } });
  const originalWrite = tokenStore.write;
  tokenStore.write = async (value) => { savedRefresh = value.refreshToken; await originalWrite(value); };
  const values = await Promise.all([oauth.getAccessToken(), oauth.getAccessToken(), oauth.getAccessToken()]);
  assert.deepEqual(values, ['new-access', 'new-access', 'new-access']);
  assert.equal(calls, 1);
  assert.equal(savedRefresh, 'rotated-refresh');
});

test('revoked refresh credentials clear storage and public health never exposes secrets', async () => {
  const { oauth, tokenStore } = makeOAuth({ fetchImpl: async () => response({ error: 'invalid_grant', refresh_token: 'leak-me' }, 400),
    initial: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 0, scopes: REQUIRED_SCOPES } });
  await rejectedCode(oauth.getAccessToken(), 'reconnect_required');
  assert.equal(await tokenStore.read(), null);
  const health = await oauth.getHealth();
  assert.equal(JSON.stringify(health).includes('secret'), false);
  assert.equal(JSON.stringify(health).includes('leak-me'), false);
});

test('temporary refresh failures preserve credentials and allow a later recovery', async () => {
  let fetchCurrent = async () => { throw new Error('socket password=must-not-leak'); };
  const fetchImpl = (...args) => fetchCurrent(...args);
  const { oauth, tokenStore } = makeOAuth({ fetchImpl, initial: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0, scopes: REQUIRED_SCOPES } });
  await rejectedCode(oauth.getAccessToken(), 'credential_refresh_failed');
  assert.equal((await tokenStore.read()).refreshToken, 'old-refresh');
  fetchCurrent = async () => response(token('recovered-access', 'recovered-refresh'));
  assert.equal(await oauth.getAccessToken(), 'recovered-access');
});

test('failed rotated-token persistence retries the candidate without replaying the old refresh token', async () => {
  let refreshCalls = 0;
  const { oauth, tokenStore } = makeOAuth({ fetchImpl: async () => { refreshCalls += 1; return response(token('rotated-access', 'rotated-refresh')); },
    initial: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0, scopes: REQUIRED_SCOPES } });
  const write = tokenStore.write;
  let failWrite = true;
  tokenStore.write = async (value) => { if (failWrite) { failWrite = false; throw new Error('db secret'); } return write(value); };
  await rejectedCode(oauth.getAccessToken(), 'credential_store_failed');
  assert.equal(refreshCalls, 1);
  tokenStore.write = write;
  assert.equal(await oauth.getAccessToken(), 'rotated-access');
  assert.equal(refreshCalls, 1);
  assert.equal((await tokenStore.read()).refreshToken, 'rotated-refresh');
});

test('failed disconnect and failed reauthorization cannot reload the previous account', async () => {
  const { oauth, tokenStore } = makeOAuth({ fetchImpl: async () => response({ error: 'temporarily_unavailable' }, 503),
    initial: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3600000, scopes: REQUIRED_SCOPES } });
  const clear = tokenStore.clear;
  tokenStore.clear = async () => { throw new Error('store secret'); };
  await rejectedCode(oauth.disconnect(), 'credential_store_failed');
  assert.equal((await oauth.getHealth()).connected, false);
  await rejectedCode(oauth.getAccessToken(), 'reconnect_required');

  const next = await oauth.beginAuthorization({ sessionId: 's' });
  await rejectedCode(oauth.completeAuthorization({ sessionId: 's', state: next.state, code: 'new-code' }), 'upstream_request_failed');
  await rejectedCode(oauth.getAccessToken(), 'reconnect_required');
  assert.equal((await oauth.getHealth()).connected, false);
  tokenStore.clear = clear;
});

test('read deadlines cover resource discovery and token acquisition and stop API dispatch', async () => {
  let apiCalls = 0;
  const sites = [{ originId: 'jira', sourceKind: 'jira', cloudId: 'cloud-1', baseUrl: 'https://example.atlassian.net' }];
  const make = (oauth) => createAtlassianReadClient({ oauth, sites, timeoutMs: 100,
    fetchImpl: async () => { apiCalls += 1; return response({}); } });
  const resourceHang = make({ async getResources() { return new Promise(() => {}); }, async getAccessToken() { return 'token'; } });
  await rejectedCode(resourceHang.getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), 'request_timeout');
  const tokenHang = make({ async getResources() { return [{ id: 'cloud-1', url: 'https://example.atlassian.net', scopes: ['read:jira-work'] }]; },
    async getAccessToken() { return new Promise(() => {}); } });
  await rejectedCode(tokenHang.getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), 'request_timeout');
  assert.equal(apiCalls, 0);
});

test('read client discards a response when the OAuth connection changes during the API call', async () => {
  let revision = 1;
  let releaseFetch;
  let apiStarted;
  const started = new Promise((resolve) => { apiStarted = resolve; });
  const client = createAtlassianReadClient({ timeoutMs: 1000,
    oauth: { getConnectionRevision() { return revision; }, async getResources() { return [{ id: 'cloud-1', url: 'https://example.atlassian.net', scopes: ['read:jira-work'] }]; }, async getAccessToken() { return 'safe-token'; } },
    sites: [{ originId: 'jira', sourceKind: 'jira', cloudId: 'cloud-1', baseUrl: 'https://example.atlassian.net' }],
    fetchImpl: () => { apiStarted(); return new Promise((resolve) => { releaseFetch = resolve; }); } });
  const pending = client.getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' });
  await started;
  revision += 1;
  releaseFetch(response({ secret: 'stale' }));
  await rejectedCode(pending, 'connection_changed');
});

test('malformed saved scopes and control characters in bearer tokens are rejected', async () => {
  const badScopes = makeOAuth({ initial: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600000, scopes: ['read:jira-work', ''] } }).oauth;
  await rejectedCode(badScopes.getAccessToken(), 'invalid_saved_credentials');
  const badToken = makeOAuth({ initial: { accessToken: 'bad\r\ntoken', refreshToken: 'r', expiresAt: Date.now() + 3600000, scopes: REQUIRED_SCOPES } }).oauth;
  await rejectedCode(badToken.getAccessToken(), 'invalid_saved_credentials');
  const badClock = makeOAuth({ now: () => Number.NaN });
  const state = await badClock.oauth.beginAuthorization({ sessionId: 's' }).catch((error) => error);
  assert.equal(state.code, 'invalid_clock');
});

test('disconnect invalidates a callback in flight and prevents credential resurrection', async () => {
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const { oauth, tokenStore } = makeOAuth({ fetchImpl });
  const begun = await oauth.beginAuthorization({ sessionId: 's' });
  const completion = oauth.completeAuthorization({ sessionId: 's', state: begun.state, code: 'secret-code' });
  while (!resolveFetch) await new Promise((resolve) => setImmediate(resolve));
  await oauth.disconnect();
  resolveFetch(response(token()));
  await rejectedCode(completion, 'connection_changed');
  assert.equal(await tokenStore.read(), null);
  assert.deepEqual(await oauth.getHealth(), { connected: false, expiresAt: null, scopes: [], pendingAuthorizations: 0 });
});

test('newer accepted authorization wins over an older callback completing later', async () => {
  let releaseFirst;
  const fetchImpl = async (_url, init) => {
    const code = JSON.parse(init.body).code;
    if (code === 'older') await new Promise((resolve) => { releaseFirst = resolve; });
    return response(token(`${code}-access`, `${code}-refresh`));
  };
  const { oauth, tokenStore } = makeOAuth({ fetchImpl });
  const older = await oauth.beginAuthorization({ sessionId: 's' });
  const newer = await oauth.beginAuthorization({ sessionId: 's' });
  const oldAttempt = oauth.completeAuthorization({ sessionId: 's', state: older.state, code: 'older' });
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await oauth.completeAuthorization({ sessionId: 's', state: newer.state, code: 'newer' });
  releaseFirst();
  await rejectedCode(oldAttempt, 'connection_changed');
  assert.equal((await tokenStore.read()).accessToken, 'newer-access');
});

test('injected store and secret resolver failures are sanitized and persisted scopes are validated', async () => {
  const brokenStore = { async read() { throw new Error('password=do-not-leak'); }, async write() {}, async clear() {} };
  const unreadable = createAtlassianOAuthClient({ clientId: 'id', redirectUri: 'https://app.example/cb', tokenStore: brokenStore,
    resolveClientSecret: async () => 'secret', fetchImpl: async () => response(token()) });
  await rejectedCode(unreadable.getAccessToken(), 'credential_store_failed');
  const brokenSecret = createAtlassianOAuthClient({ clientId: 'id', redirectUri: 'https://app.example/cb',
    tokenStore: { async read() { return null; }, async write() {}, async clear() {} },
    resolveClientSecret: async () => { throw new Error('secret=do-not-leak'); }, fetchImpl: async () => response(token()) });
  const state = await brokenSecret.beginAuthorization({ sessionId: 's' });
  await rejectedCode(brokenSecret.completeAuthorization({ sessionId: 's', state: state.state, code: 'c' }), 'client_configuration_error');
  const corrupt = makeOAuth({ initial: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60000, scopes: ['write:jira-work'] } }).oauth;
  await rejectedCode(corrupt.getAccessToken(), 'invalid_saved_credentials');
});

test('response reads enforce byte limits, deadlines, and reject redirects', async () => {
  const redirect = makeOAuth({ fetchImpl: async () => response({}, 302) }).oauth;
  const start = await redirect.beginAuthorization({ sessionId: 's' });
  await rejectedCode(redirect.completeAuthorization({ sessionId: 's', state: start.state, code: 'c' }), 'redirect_rejected');
  const large = makeOAuth({ fetchImpl: async () => response('x'.repeat(1024 * 1024 + 1)) }).oauth;
  const largeState = await large.beginAuthorization({ sessionId: 's' });
  await rejectedCode(large.completeAuthorization({ sessionId: 's', state: largeState.state, code: 'c' }), 'response_too_large');
  const slowBody = makeOAuth({ timeoutMs: 100, fetchImpl: async () => ({ ok: true, status: 200,
    body: new ReadableStream({ pull() { return new Promise(() => {}); } }) }) }).oauth;
  const slowState = await slowBody.beginAuthorization({ sessionId: 's' });
  await rejectedCode(slowBody.completeAuthorization({ sessionId: 's', state: slowState.state, code: 'c' }), 'request_timeout');
});

test('read client checks exact selected site and read scope before making fixed GET requests', async () => {
  const calls = [];
  const oauth = { async getAccessToken() { return 'opaque-token'; }, async getResources() {
    return [{ id: 'cloud-1', url: 'https://example.atlassian.net', scopes: ['read:jira-work'] }];
  } };
  const client = createAtlassianReadClient({ oauth, sites: [{ originId: 'jira-main', sourceKind: 'jira', cloudId: 'cloud-1', baseUrl: 'https://example.atlassian.net' }],
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ ok: true }); } });
  assert.deepEqual(await client.getIssue({ originId: 'jira-main', issueIdOrKey: 'ABC-2' }), { ok: true });
  assert.equal(calls[0].url, 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ABC-2');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer opaque-token');
  assert.deepEqual(Object.keys(client).sort(), ['getComments', 'getIssue', 'getPage', 'getRemoteLinks']);
  await assert.rejects(Promise.resolve().then(() => client.getIssue({ originId: 'jira-main', issueIdOrKey: 'ABC-2?x=1' })), { code: 'invalid_issue_reference' });
  await assert.rejects(Promise.resolve().then(() => client.getComments({ originId: 'jira-main', issueIdOrKey: 'ABC-2', maxResults: 101 })), { code: 'invalid_comment_query' });
});

test('read client rejects unauthorized sites, missing scopes, redirects, and URL/path injection', async () => {
  let network = 0;
  const base = { async getAccessToken() { return 'token'; }, async getResources() { return [{ id: 'cloud-1', url: 'https://other.atlassian.net', scopes: ['read:jira-work'] }]; } };
  const make = (oauth = base) => createAtlassianReadClient({ oauth,
    sites: [{ originId: 'jira', sourceKind: 'jira', cloudId: 'cloud-1', baseUrl: 'https://example.atlassian.net' }],
    fetchImpl: async () => { network += 1; return response({}); } });
  await assert.rejects(make().getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), { code: 'site_not_authorized' });
  const noScope = { ...base, async getResources() { return [{ id: 'cloud-1', url: 'https://example.atlassian.net', scopes: [] }]; } };
  await assert.rejects(make(noScope).getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), { code: 'scope_not_authorized' });
  assert.equal(network, 0);
  const credentialedResource = { ...base, async getResources() { return [{ id: 'cloud-1', url: 'https://user:pass@example.atlassian.net', scopes: ['read:jira-work'] }]; } };
  await assert.rejects(make(credentialedResource).getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), { code: 'site_not_authorized' });
  const redirectClient = createAtlassianReadClient({ oauth: { ...base, async getResources() { return [{ id: 'cloud-1', url: 'https://example.atlassian.net', scopes: ['read:jira-work'] }]; } },
    sites: [{ originId: 'jira', sourceKind: 'jira', cloudId: 'cloud-1', baseUrl: 'https://example.atlassian.net' }], fetchImpl: async () => response({}, 301) });
  await assert.rejects(redirectClient.getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), { code: 'redirect_rejected' });
});

test('Confluence reads use the fixed page endpoint and atlas document format', async () => {
  const calls = [];
  const oauth = { async getAccessToken() { return 'token'; }, async getResources() { return [{ id: 'same-cloud-id', url: 'https://wiki.example', scopes: ['read:page:confluence'] }]; } };
  const client = createAtlassianReadClient({ oauth, sites: [{ originId: 'wiki', sourceKind: 'confluence', cloudId: 'same-cloud-id', baseUrl: 'https://wiki.example' }],
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ id: '123' }); } });
  await client.getPage({ originId: 'wiki', pageId: '123' });
  assert.equal(calls[0].url, 'https://api.atlassian.com/ex/confluence/same-cloud-id/wiki/api/v2/pages/123?body-format=atlas_doc_format');
  assert.equal(calls[0].init.method, 'GET');
  await assert.rejects(Promise.resolve().then(() => client.getPage({ originId: 'wiki', pageId: '123/../../secret' })), { code: 'invalid_page_reference' });
});
