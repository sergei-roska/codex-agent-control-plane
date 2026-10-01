'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { migrateProductSchema } = require('../src/product-migrations');
const { ProductStore } = require('../src/product-store');
const { ArtifactStore } = require('../src/artifact-store');
const { createAtlassianOAuthClient, REQUIRED_SCOPES, TOKEN_URL, RESOURCES_URL } = require('../src/integrations/atlassian-oauth');
const { createAtlassianReadClient } = require('../src/integrations/atlassian-read-client');
const { createAtlassianIntegration, originId } = require('../src/integrations/atlassian-integration');
const { collectSourceBundle } = require('../src/integrations/source-bundle');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

const dirs = [];
process.on('exit', () => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const scope = REQUIRED_SCOPES.join(' ');
const SITE = 'https://cred.atlassian.net';
const CLOUD = 'cred-cloud';

function response(value, status = 200) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { ok: status >= 200 && status < 300, status, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}
function tokenBody() { return { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600, token_type: 'Bearer', scope }; }
function makeOAuth(fetchImpl) {
  let saved = { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3600000, scopes: [...REQUIRED_SCOPES] };
  const tokenStore = {
    async read() { return saved && { ...saved }; },
    async write(value) { saved = { ...value }; },
    async clear() { saved = null; },
  };
  const oauth = createAtlassianOAuthClient({ clientId: 'client-id', redirectUri: 'https://orchestrator.example/oauth/callback',
    resolveClientSecret: async () => 'client-secret', tokenStore, fetchImpl });
  return { oauth, tokenStore, get saved() { return saved; } };
}
async function reconnect(oauth) {
  const { state } = await oauth.beginAuthorization({ sessionId: 'sess' });
  await oauth.completeAuthorization({ sessionId: 'sess', state, code: 'fixture-code' });
}
const jiraSite = { originId: 'jira', sourceKind: 'jira', cloudId: 'cloud-1', baseUrl: 'https://example.atlassian.net' };
const resourceOk = { async getResources() { return [{ id: 'cloud-1', url: 'https://example.atlassian.net', scopes: ['read:jira-work'] }]; }, async getAccessToken() { return 'tok'; } };

test('read client maps 401 to a credential error and marks the connection, 403 stays unauthorized', async () => {
  const marks = [];
  const oauth = { ...resourceOk, getConnectionRevision: () => 7, markReconnectRequired(arg) { marks.push(arg); } };
  const make = (status) => createAtlassianReadClient({ oauth, sites: [jiraSite], fetchImpl: async () => response({ message: 'private body' }, status) });
  await assert.rejects(make(401).getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), (error) => error.code === 'reconnect_required' && !/private/.test(error.message));
  assert.deepEqual(marks, [{ revision: 7 }]);
  await assert.rejects(make(403).getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), { code: 'unauthorized' });
  await assert.rejects(make(500).getIssue({ originId: 'jira', issueIdOrKey: 'ABC-1' }), { code: 'upstream_request_failed' });
  assert.equal(marks.length, 1);
});

const origins = [{ originId: 'jira-main', sourceKind: 'jira', baseUrl: 'https://example.atlassian.net' },
  { originId: 'conf-main', sourceKind: 'confluence', baseUrl: 'https://example.atlassian.net' }];
function providerFor(failOn) {
  return { async read(ref) {
    if (ref.externalId === failOn.id) throw Object.assign(new Error('boom'), { code: failOn.code });
    if (ref.sourceKind === 'jira') {
      return { sourceKind: 'jira', originId: 'jira-main', externalId: '1', displayKey: 'A-1', url: 'https://example.atlassian.net/browse/A-1',
        title: 'Root', text: 'root', links: [{ sourceKind: 'confluence', originId: 'conf-main', externalId: '66' }], availability: 'available' };
    }
    return { sourceKind: 'confluence', originId: 'conf-main', externalId: '66', url: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=66',
      title: 'Page', text: 'page', links: [], availability: 'available' };
  } };
}
const rootRef = { sourceKind: 'jira', originId: 'jira-main', externalId: 'A-1' };

test('source bundle propagates credential errors at any depth but keeps other provider errors as entries', async () => {
  await assert.rejects(collectSourceBundle({ provider: providerFor({ id: 'A-1', code: 'reconnect_required' }), root: rootRef, origins }), { code: 'reconnect_required' });
  await assert.rejects(collectSourceBundle({ provider: providerFor({ id: '66', code: 'reconnect_required' }), root: rootRef, origins }), { code: 'reconnect_required' });
  for (const code of ['request_timeout', 'upstream_request_failed']) {
    const bundle = await collectSourceBundle({ provider: providerFor({ id: '66', code }), root: rootRef, origins });
    assert.equal(bundle.documents[0].availability, 'available');
    assert.equal(bundle.documents[1].availability, 'unavailable');
  }
  const denied = await collectSourceBundle({ provider: providerFor({ id: '66', code: 'unauthorized' }), root: rootRef, origins });
  assert.equal(denied.documents[1].availability, 'unauthorized');
});

async function makeIntegration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-credential-'));
  dirs.push(dir);
  const db = new Database(path.join(dir, 'state.sqlite'));
  db.pragma('foreign_keys = ON');
  await migrateProductSchema({ db });
  const artifactStore = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  const productStore = new ProductStore({ db, projectId: 'project-main', now: () => new Date('2026-10-01T10:00:00.000Z') });
  const mode = { resources: 200, jira: 200, confluence: 200, issue: 'DEMO-1' };
  const fetchImpl = async (url, init) => {
    url = String(url);
    if (url === TOKEN_URL) return response(tokenBody());
    if (url === RESOURCES_URL) {
      if (mode.resources !== 200) return response({ message: 'revoked' }, mode.resources);
      if (mode.resourceList) return response(mode.resourceList);
      return response([{ id: CLOUD, url: SITE, name: 'Cred', scopes: ['read:jira-work', 'read:page:confluence', 'offline_access'] }]);
    }
    if (url.includes('/ex/jira/')) {
      if (mode.jira !== 200) return response({ message: 'nope' }, mode.jira);
      if (url.includes('/comment')) return response({ comments: [], total: 0 });
      if (url.includes('/remotelink')) return response([{ object: { url: `${SITE}/wiki/spaces/X/pages/77/Linked` } }]);
      return response({ id: mode.issue === 'DEMO-2' ? '10002' : '10001', key: mode.issue, fields: { summary: 'Credential fixture', description: null, updated: 'u1' } });
    }
    if (url.includes('/ex/confluence/')) {
      if (mode.confluence !== 200) return response({ message: 'restricted' }, mode.confluence);
      return response({ id: '77', title: 'Linked', version: { number: 1 }, body: { atlas_doc_format: { value: '{"type":"doc","version":1,"content":[]}' } } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const oauthCtx = makeOAuth(fetchImpl);
  const integration = createAtlassianIntegration({ db, productStore, artifactStore, workspace: dir, oauth: oauthCtx.oauth, fetchImpl });
  const resource = { id: CLOUD, url: SITE, name: 'Cred', scopes: ['read:jira-work', 'read:page:confluence', 'offline_access'] };
  db.prepare('INSERT INTO m6_atlassian_selected_sites (cloud_id, resource_json, selected_at) VALUES (?, ?, ?)').run(CLOUD, JSON.stringify(resource), 'now');
  const jiraOrigin = originId(CLOUD, 'jira');
  const counts = () => ({
    tickets: db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c,
    snapshots: db.prepare('SELECT COUNT(*) AS c FROM m6_source_snapshots').get().c,
    identities: db.prepare('SELECT COUNT(*) AS c FROM m6_source_identities').get().c,
    revisions: db.prepare('SELECT COUNT(*) AS c FROM requirement_revisions').get().c,
    artifacts: db.prepare('SELECT COUNT(*) AS c FROM artifacts').get().c,
    commands: db.prepare('SELECT COUNT(*) AS c FROM product_commands').get().c,
  });
  return { db, integration, productStore, oauth: oauthCtx.oauth, oauthCtx, mode, jiraOrigin, counts };
}

test('revoked credentials fail refresh and import with reconnect_required, write nothing, and flip health', async () => {
  const ctx = await makeIntegration();
  const { integration, mode, jiraOrigin, counts, oauth, productStore } = ctx;
  assert.equal((await integration.health()).state, 'connected');
  // A 403 on a linked Confluence page is per-document access, not a credential failure.
  mode.confluence = 403;
  const first = await integration.importIssue({ commandId: 'import-0001', originId: jiraOrigin, issueIdOrKey: 'DEMO-1' });
  const ticketId = first.ticket.ticketId;
  const snapshot = productStore.getTicketSourceSnapshot(ticketId, first.source.appliedSnapshotId);
  assert.ok(snapshot.bundle.documents.some((doc) => doc.sourceKind === 'confluence' && doc.availability === 'unauthorized'));
  assert.equal((await integration.health()).state, 'connected');
  mode.confluence = 200;

  const before = counts();
  const versionBefore = productStore.getTicket(ticketId).version;
  mode.resources = 401;
  await assert.rejects(integration.refreshTicket(ticketId, { commandId: 'refresh-0001', expectedVersion: versionBefore }), (error) => error.code === 'reconnect_required' && !/revoked/.test(error.message));
  assert.deepEqual(counts(), before);
  assert.equal(productStore.getTicket(ticketId).version, versionBefore);
  const health = await integration.health();
  assert.equal(health.state, 'reconnect_required');
  assert.equal(health.connected, false);
  assert.ok(ctx.oauthCtx.saved, 'stored tokens are not deleted');

  // Import of a new key fails the same way and creates no ticket.
  await assert.rejects(integration.importIssue({ commandId: 'import-0002', originId: jiraOrigin, issueIdOrKey: 'DEMO-2' }), { code: 'reconnect_required' });
  assert.deepEqual(counts(), before);

  // Successful reconnect clears the state; the failed commands were not recorded as applied.
  mode.resources = 200;
  await reconnect(oauth);
  assert.equal((await integration.health()).state, 'connected');
  mode.issue = 'DEMO-2';
  const retried = await integration.importIssue({ commandId: 'import-0002', originId: jiraOrigin, issueIdOrKey: 'DEMO-2' });
  assert.equal(retried.replayed, false);
  assert.equal(counts().tickets, before.tickets + 1);
});

const siteScopes = (scopes) => [{ id: CLOUD, url: SITE, name: 'Cred', scopes }];
for (const [label, list] of [['no sites', []], ['site without read:jira-work', siteScopes(['read:page:confluence', 'offline_access'])]]) {
  test(`lost selected site access (${label}) aborts refresh and import with reconnect_required`, async () => {
    const ctx = await makeIntegration();
    const { integration, mode, jiraOrigin, counts, oauth, productStore } = ctx;
    const first = await integration.importIssue({ commandId: 'import-0001', originId: jiraOrigin, issueIdOrKey: 'DEMO-1' });
    const ticketId = first.ticket.ticketId;
    const before = counts();
    const versionBefore = productStore.getTicket(ticketId).version;
    mode.resourceList = list;
    await assert.rejects(integration.refreshTicket(ticketId, { commandId: 'refresh-0001', expectedVersion: versionBefore }), { code: 'reconnect_required' });
    assert.deepEqual(counts(), before);
    assert.equal(productStore.getTicket(ticketId).version, versionBefore);
    const health = await integration.health();
    assert.equal(health.state, 'reconnect_required');
    assert.equal(health.connected, false);
    assert.ok(ctx.oauthCtx.saved, 'stored tokens are not deleted');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM m6_atlassian_selected_sites').get().c, 1);

    await assert.rejects(integration.importIssue({ commandId: 'import-0002', originId: jiraOrigin, issueIdOrKey: 'DEMO-2' }), { code: 'reconnect_required' });
    assert.deepEqual(counts(), before);

    mode.resourceList = null;
    await reconnect(oauth);
    assert.equal((await integration.health()).state, 'connected');
    const refreshed = await integration.refreshTicket(ticketId, { commandId: 'refresh-0001', expectedVersion: versionBefore });
    assert.equal(refreshed.replayed, false);
  });
}

test('resources route returning an empty list while a site is selected marks reconnect required', async () => {
  const ctx = await makeIntegration();
  ctx.mode.resourceList = [];
  assert.deepEqual((await ctx.integration.resources()).resources, []);
  assert.equal((await ctx.integration.health()).state, 'reconnect_required');
});

test('site lacking only read:page:confluence still imports with Confluence entries unavailable', async () => {
  const ctx = await makeIntegration();
  ctx.mode.resourceList = siteScopes(['read:jira-work', 'offline_access']);
  const result = await ctx.integration.importIssue({ commandId: 'import-0001', originId: ctx.jiraOrigin, issueIdOrKey: 'DEMO-1' });
  const snapshot = ctx.productStore.getTicketSourceSnapshot(result.ticket.ticketId, result.source.appliedSnapshotId);
  assert.ok(snapshot.bundle.documents.some((doc) => doc.sourceKind === 'confluence' && doc.availability !== 'available'));
  assert.equal((await ctx.integration.health()).state, 'connected');
});

test('a 401 from the Jira API marks the connection and aborts the import', async () => {
  const ctx = await makeIntegration();
  const { integration, mode, jiraOrigin, counts, oauth } = ctx;
  const before = counts();
  mode.jira = 401;
  await assert.rejects(integration.importIssue({ commandId: 'import-0003', originId: jiraOrigin, issueIdOrKey: 'DEMO-1' }), { code: 'reconnect_required' });
  assert.deepEqual(counts(), before);
  assert.equal((await integration.health()).state, 'reconnect_required');
  mode.jira = 200;
  await reconnect(oauth);
  assert.equal((await integration.health()).state, 'connected');
  const ok = await integration.importIssue({ commandId: 'import-0003', originId: jiraOrigin, issueIdOrKey: 'DEMO-1' });
  assert.equal(ok.replayed, false);
});

test('explicit disconnect is not reported as a credential rejection', async () => {
  const ctx = await makeIntegration();
  await ctx.oauth.disconnect();
  const health = await ctx.integration.health();
  assert.equal(health.state, 'disconnected');
});

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

test('HTTP refresh returns 409 reconnect_required with a redacted body when credentials are rejected', async (suite) => {
  if (!(await canBind())) { suite.skip('loopback binding is not permitted in this environment'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-credential-api-'));
  process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = path.join(root, 'workspace-lock');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const resource = { id: 'api-cred-cloud', url: 'https://api-cred.atlassian.net', name: 'API', scopes: ['read:jira-work', 'read:page:confluence', 'offline_access'] };
  let revoked = false;
  const oauth = {
    getConnectionRevision: () => 1,
    async getHealth() { return { connected: !revoked, reconnectRequired: revoked, scopes: resource.scopes }; },
    async getResources() { return [{ ...resource }]; },
    async getAccessToken() { return 'fixture-token'; },
    async beginAuthorization() { return { state: 's', authorizationUrl: 'https://auth.atlassian.com/authorize' }; },
    cancelAuthorization() { return { canceled: false }; },
    async completeAuthorization() { return { connected: true }; },
    async disconnect() { return { disconnected: true }; },
  };
  const provider = { async read(ref) {
    if (revoked) throw Object.assign(new Error('Bearer leaked-token-value'), { code: 'reconnect_required' });
    return { sourceKind: 'jira', originId: ref.originId, externalId: '10001', displayKey: 'DEMO-1', url: `${resource.url}/browse/DEMO-1`,
      title: 'Fixture', text: 'fixture text', links: [], availability: 'available' };
  } };
  const runtime = await startServer({ port: 0, workspace, stateFile: path.join(root, 'state.sqlite'),
    tokenFile: path.join(root, 'token', 'a2a-token'), appServer: makeFakeAppServer(), atlassianOAuth: oauth, atlassianProvider: provider,
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }) });
  suite.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.port}`;
  const base = `${origin}/api/dashboard/v1`;
  const bearer = `Bearer ${fs.readFileSync(path.join(root, 'token', 'a2a-token'), 'utf8').trim()}`;
  const issued = await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } });
  const { code } = await issued.json();
  const paired = await fetch(`${base}/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const send = (method, route, value) => fetch(`${base}${route}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const selected = await (await send('PUT', '/integrations/atlassian/site', { cloudId: resource.id })).json();
  const jira = selected.sites.find((site) => site.sourceKind === 'jira');
  const imported = await (await send('POST', '/integrations/atlassian/import', { commandId: 'import-0001', originId: jira.originId, issueIdOrKey: 'DEMO-1' })).json();
  const ticketId = imported.ticket.ticketId;
  const historyBefore = (await (await fetch(`${base}/tickets/${ticketId}/source/history`, { headers: { Cookie: cookie } })).json()).snapshots.length;
  revoked = true;
  const refreshed = await send('POST', `/tickets/${ticketId}/source/refresh`, { commandId: 'refresh-0001', expectedVersion: imported.ticket.version });
  assert.equal(refreshed.status, 409);
  const text = await refreshed.text();
  assert.equal(JSON.parse(text).error.code, 'reconnect_required');
  assert.doesNotMatch(text, /leaked-token-value|Bearer/);
  const historyAfter = (await (await fetch(`${base}/tickets/${ticketId}/source/history`, { headers: { Cookie: cookie } })).json()).snapshots.length;
  assert.equal(historyAfter, historyBefore);
});
