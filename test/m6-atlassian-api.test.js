'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function fixtures() {
  const resource = { id: 'api-test-cloud', url: 'https://api-test.atlassian.net', name: 'API fixture',
    scopes: ['read:jira-work', 'read:page:confluence', 'offline_access'] };
  let revision = 0;
  let connected = false;
  let exchanges = 0;
  let outage = false;
  let reads = 0;
  const states = new Map();
  const oauth = {
    getConnectionRevision: () => revision,
    async getHealth() { return { connected, scopes: connected ? resource.scopes : [] }; },
    async getResources() { if (!connected) throw Object.assign(new Error('not connected'), { code: 'reconnect_required' }); return [{ ...resource, scopes: [...resource.scopes] }]; },
    async getAccessToken() { if (!connected) throw Object.assign(new Error('not connected'), { code: 'reconnect_required' }); return 'fixture-token'; },
    async beginAuthorization({ sessionId }) {
      const state = crypto.randomBytes(32).toString('base64url');
      states.set(state, sessionId);
      const url = new URL('https://auth.atlassian.com/authorize');
      url.searchParams.set('state', state);
      return { state, authorizationUrl: url.toString() };
    },
    cancelAuthorization({ sessionId, state }) {
      const canceled = states.get(state) === sessionId;
      if (canceled) states.delete(state);
      return { canceled };
    },
    async completeAuthorization({ sessionId, state, code }) {
      exchanges += 1;
      if (states.get(state) !== sessionId || !code) throw Object.assign(new Error('invalid fixture state'), { code: 'invalid_authorization_state' });
      states.delete(state); connected = true; revision += 1; return { connected: true };
    },
    async disconnect() { connected = false; revision += 1; return { disconnected: true }; },
  };
  const provider = { async read(reference) {
    reads += 1;
    if (outage) return { ...reference, availability: 'unavailable', title: 'Fixture outage', text: '', links: [] };
    if (reference.sourceKind !== 'jira' || !['DEMO-1', '10001'].includes(reference.externalId)) {
      return { ...reference, availability: 'missing', title: 'Fixture issue missing', text: '', links: [] };
    }
    return { sourceKind: 'jira', originId: reference.originId, externalId: '10001', displayKey: 'DEMO-1',
      url: `${resource.url}/browse/DEMO-1`, sourceRevision: 'fixture-1', title: 'Bounded fixture source',
      text: 'The issue describes a local integration fixture with explicit provenance.', links: [], availability: 'available' };
  } };
  return { oauth, provider, resource, get exchanges() { return exchanges; }, get reads() { return reads; }, set outage(value) { outage = value; } };
}

test('M6 authenticated routes bind OAuth handoff, site choice, import, refresh, and reads', async (suite) => {
  if (!(await canBind())) { suite.skip('loopback binding is not permitted in this environment'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-atlassian-api-'));
  process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = path.join(root, 'workspace-lock');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const fx = fixtures();
  const runtime = await startServer({ port: 0, workspace, stateFile: path.join(root, 'state.sqlite'),
    tokenFile: path.join(root, 'token', 'a2a-token'), appServer: makeFakeAppServer(), atlassianOAuth: fx.oauth,
    atlassianProvider: fx.provider, orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }) });
  suite.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.port}`;
  const base = `${origin}/api/dashboard/v1`;
  const bearer = `Bearer ${fs.readFileSync(path.join(root, 'token', 'a2a-token'), 'utf8').trim()}`;
  const get = (route, cookie, headers = {}) => fetch(`${base}${route}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const post = (route, cookie, value, extra = {}) => fetch(`${base}${route}`, { method: 'POST', headers: {
    ...(cookie ? { Cookie: cookie } : {}), Origin: origin, 'Content-Type': 'application/json', ...extra,
  }, body: JSON.stringify(value) });
  const put = (route, cookie, value) => fetch(`${base}${route}`, { method: 'PUT', headers: {
    ...(cookie ? { Cookie: cookie } : {}), Origin: origin, 'Content-Type': 'application/json',
  }, body: JSON.stringify(value) });
  async function pair() {
    const issued = await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } });
    const { code } = await issued.json();
    const response = await fetch(`${base}/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(response.status, 204);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const cookie = await pair();
  const otherCookie = await pair();

  await suite.test('session and CSRF guard the authenticated mutations', async () => {
    assert.equal((await get('/integrations/atlassian')).status, 401);
    const noSession = await post('/integrations/atlassian/begin', null, {});
    assert.equal(noSession.status, 401);
    const badOrigin = await post('/integrations/atlassian/begin', cookie, {}, { Origin: 'https://evil.example' });
    assert.equal(badOrigin.status, 403);
    const extraField = await post('/integrations/atlassian/begin', cookie, { unexpected: true });
    assert.equal(extraField.status, 400);
  });

  await suite.test('public callback discards denial detail and consumes malformed/replayed state without exchanging codes', async () => {
    for (let index = 0; index < 40; index += 1) {
      const started = await (await post('/integrations/atlassian/begin', cookie, {})).json();
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      const response = await fetch(`${base}/integrations/atlassian/callback?state=${state}&error=access_denied&error_description=secret+provider+text`, { redirect: 'manual' });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/dashboard/#atlassian-oauth-error=failed');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
    const started = await (await post('/integrations/atlassian/begin', cookie, {})).json();
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const malformed = await fetch(`${base}/integrations/atlassian/callback?state=${state}&code=a&code=b`, { redirect: 'manual' });
    assert.equal(malformed.headers.get('location'), '/dashboard/#atlassian-oauth-error=failed');
    const replay = await fetch(`${base}/integrations/atlassian/callback?state=${state}&code=fixture-code`, { redirect: 'manual' });
    assert.equal(replay.headers.get('location'), '/dashboard/#atlassian-oauth-error=failed');
    assert.equal(fx.exchanges, 0);
    assert.equal((await get('/integrations/atlassian', cookie)).status, 200);
  });

  await suite.test('callback handle is one-use and paired-session bound', async () => {
    const started = await (await post('/integrations/atlassian/begin', cookie, {})).json();
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const callback = await fetch(`${base}/integrations/atlassian/callback?state=${state}&code=fixture-code`, { redirect: 'manual' });
    const location = callback.headers.get('location');
    assert.match(location, /^\/dashboard\/#atlassian-oauth=[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(location, /fixture-code|state=/);
    const handle = location.split('=')[1];
    assert.equal((await post('/integrations/atlassian/complete', otherCookie, { handle })).status, 409);
    const startedAgain = await (await post('/integrations/atlassian/begin', cookie, {})).json();
    const stateAgain = new URL(startedAgain.authorizationUrl).searchParams.get('state');
    const callbackAgain = await fetch(`${base}/integrations/atlassian/callback?state=${stateAgain}&code=fixture-code`, { redirect: 'manual' });
    const goodHandle = callbackAgain.headers.get('location').split('=')[1];
    assert.deepEqual(await (await post('/integrations/atlassian/complete', cookie, { handle: goodHandle })).json(), { connected: true });
    assert.equal((await post('/integrations/atlassian/complete', cookie, { handle: goodHandle })).status, 409);
    assert.equal(fx.exchanges, 1);
  });

  await suite.test('explicit site selection imports immutable Jira identity and outage refresh preserves progress', async () => {
    const selected = await put('/integrations/atlassian/site', cookie, { cloudId: fx.resource.id });
    assert.equal(selected.status, 200);
    const sites = (await selected.json()).sites;
    assert.equal(sites.length, 2);
    const jira = sites.find((site) => site.sourceKind === 'jira');
    const imported = await post('/integrations/atlassian/import', cookie, { commandId: 'import-0001', originId: jira.originId, issueIdOrKey: 'DEMO-1' });
    assert.equal(imported.status, 200);
    const first = await imported.json();
    assert.equal(first.ticket.source, 'jira');
    assert.equal(first.ticket.version, 1);
    assert.equal(first.source.externalId, '10001');
    assert.equal(first.source.rootAvailable, true);
    const readsAfterImport = fx.reads;

    const replayed = await post('/integrations/atlassian/import', cookie, { commandId: 'import-0001', originId: jira.originId, issueIdOrKey: 'DEMO-1' });
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json()).replayed, true);
    assert.equal(fx.reads, readsAfterImport);

    const duplicate = await post('/integrations/atlassian/import', cookie, { commandId: 'import-0002', originId: jira.originId, issueIdOrKey: 'DEMO-1' });
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json();
    assert.equal(duplicateBody.duplicate, true);
    assert.equal(duplicateBody.ticket.ticketId, first.ticket.ticketId);
    assert.equal(runtime.productStore.listTicketArtifacts(first.ticket.ticketId).length, 1);

    fx.outage = true;
    const refreshed = await post(`/tickets/${first.ticket.ticketId}/source/refresh`, cookie,
      { commandId: 'refresh-0001', expectedVersion: first.ticket.version });
    assert.equal(refreshed.status, 200);
    const refreshBody = await refreshed.json();
    assert.equal(refreshBody.applied, false);
    assert.equal(refreshBody.ticket.version, first.ticket.version);
    assert.equal(refreshBody.source.rootAvailable, false);
    assert.equal(refreshBody.source.latestAvailableRootAvailable, true);
    assert.equal(runtime.productStore.listTicketArtifacts(first.ticket.ticketId).length, 1);
    const readsAfterRefresh = fx.reads;
    const refreshReplay = await post(`/tickets/${first.ticket.ticketId}/source/refresh`, cookie,
      { commandId: 'refresh-0001', expectedVersion: first.ticket.version });
    assert.equal(refreshReplay.status, 200);
    assert.equal((await refreshReplay.json()).replayed, true);
    assert.equal(fx.reads, readsAfterRefresh);

    const source = await get(`/tickets/${first.ticket.ticketId}/source`, cookie);
    assert.equal(source.status, 200);
    const history = await get(`/tickets/${first.ticket.ticketId}/source/history?limit=1`, cookie);
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.equal(historyBody.snapshots.length, 1);
    const ownSnapshot = await get(`/tickets/${first.ticket.ticketId}/source/snapshots/${historyBody.snapshots[0].snapshotId}`, cookie);
    assert.equal(ownSnapshot.status, 200);
    const foreignSnapshot = await get(`/tickets/${first.ticket.ticketId}/source/snapshots/not-owned`, cookie);
    assert.equal(foreignSnapshot.status, 404);
    assert.equal((await get(`/tickets/${first.ticket.ticketId}/source/history?limit=101`, cookie)).status, 400);
  });
});
