'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createAuditedFetch } = require('../src/integrations/atlassian-egress');
const { createAtlassianIntegration } = require('../src/integrations/atlassian-integration');
const { EventJournal } = require('../src/event-journal');

function harness(baseImpl) {
  const calls = [];
  const events = [];
  const base = baseImpl || (async () => ({ status: 200 }));
  const audited = createAuditedFetch(async (url, init) => { calls.push({ url, init }); return base(url, init); }, { record: (payload) => events.push(payload) });
  return { calls, events, audited };
}

test('allowed GET is recorded with status and pathname only', async () => {
  const { calls, events, audited } = harness();
  const response = await audited('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/DEMO-1/comment?startAt=0&secret=abc#frag',
    { method: 'GET', headers: { authorization: 'Bearer top-secret' } });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'GET');
  assert.equal(events[0].host, 'api.atlassian.com');
  assert.equal(events[0].path, '/ex/jira/cloud-1/rest/api/3/issue/DEMO-1/comment');
  assert.equal(events[0].status, 200);
  assert.equal(events[0].outcome, 'sent');
  assert.equal(typeof events[0].durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /secret|startAt|top-secret|frag/);
});

test('default method is GET and accessible-resources and confluence GETs are allowed', async () => {
  const { calls, audited } = harness();
  await audited('https://api.atlassian.com/oauth/token/accessible-resources');
  await audited('https://api.atlassian.com/ex/confluence/cloud-1/wiki/api/v2/pages/1');
  assert.equal(calls.length, 2);
});

test('token POST is allowed', async () => {
  const { calls, events, audited } = harness();
  await audited('https://auth.atlassian.com/oauth/token', { method: 'post', body: '{"client_secret":"s"}' });
  assert.equal(calls.length, 1);
  assert.equal(events[0].method, 'POST');
  assert.equal(events[0].host, 'auth.atlassian.com');
  assert.equal(events[0].path, '/oauth/token');
  assert.equal(events[0].outcome, 'sent');
  assert.doesNotMatch(JSON.stringify(events), /client_secret/);
});

test('disallowed requests are denied without calling the base fetch', async () => {
  const cases = [
    ['https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue', { method: 'POST' }],
    ['https://api.atlassian.com/oauth/token', { method: 'POST' }],
    ['https://auth.atlassian.com/oauth/token', { method: 'GET' }],
    ['https://auth.atlassian.com/oauth/token/extra', { method: 'POST' }],
    ['https://example.com/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'GET' }],
    ['https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'PUT' }],
    ['https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'DELETE' }],
    ['https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'PATCH' }],
    ['https://api.atlassian.com/rest/api/3/issue/1', { method: 'GET' }],
    ['https://user:pw@api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'GET' }],
    ['http://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'GET' }],
    ['https://api.atlassian.com:8443/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'GET' }],
    ['https://api.atlassian.com.evil.test/ex/jira/cloud-1/rest/api/3/issue/1', { method: 'GET' }],
    ['not a url', { method: 'GET' }],
  ];
  for (const [url, init] of cases) {
    const { calls, events, audited } = harness();
    await assert.rejects(audited(url, init), { code: 'egress_denied' }, `${init.method} ${url}`);
    assert.equal(calls.length, 0, `${init.method} ${url}`);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, 'denied');
  }
});

test('a base fetch failure is recorded as error and rethrown', async () => {
  const boom = new TypeError('network down');
  const { events, audited } = harness(async () => { throw boom; });
  await assert.rejects(audited('https://api.atlassian.com/ex/jira/c/rest/api/3/issue/1'), (error) => error === boom);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'error');
  assert.equal(events[0].errorName, 'TypeError');
  assert.equal(events[0].status, undefined);
});

test('a throwing recorder never breaks the request', async () => {
  const audited = createAuditedFetch(async () => ({ status: 204 }), { record: () => { throw new Error('journal down'); } });
  assert.equal((await audited('https://api.atlassian.com/ex/jira/c/rest/api/3/issue/1')).status, 204);
  await assert.rejects(audited('https://api.atlassian.com/ex/jira/c/rest/api/3/issue/1', { method: 'POST' }), { code: 'egress_denied' });
});

test('integration import journals every Atlassian call and never a query string', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-atlassian-egress-'));
  const db = new Database(':memory:');
  const events = new EventJournal({ db });
  events.ensureSchema();
  const resource = { id: 'egress-cloud', url: 'https://e.atlassian.net', name: 'E', scopes: ['read:jira-work', 'offline_access'] };
  const oauth = {
    getConnectionRevision: () => 1,
    async getHealth() { return { connected: true }; },
    async getResources() { return [resource]; },
    async getAccessToken() { return 'fixture-only-token'; },
    async beginAuthorization() { throw new Error('unused'); },
    cancelAuthorization() { return { canceled: false }; },
    async completeAuthorization() { throw new Error('unused'); },
    async disconnect() { return { disconnected: true }; },
  };
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push({ url, method: init.method });
    const pathname = new URL(url).pathname;
    const body = pathname.endsWith('/comment') ? { comments: [], total: 0, startAt: 0, maxResults: 50 }
      : pathname.endsWith('/remotelink') ? [] : { id: '10001', key: 'DEMO-1', fields: { summary: 'Fixture', description: null, issuetype: { name: 'Task' } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const productStore = { importSourceBundle: () => ({ artifactAttached: true }) };
  const service = createAtlassianIntegration({ db, productStore, artifactStore: { store: () => ({ storageRef: 'x' }), remove() {} },
    workspace: root, config: { callbackOrigin: 'http://127.0.0.1:4321' }, oauth, fetchImpl, events });
  try {
    await service.selectSite({ cloudId: 'egress-cloud' });
    const origin = (await service.health()).selectedSites.find((site) => site.sourceKind === 'jira');
    await service.importIssue({ commandId: 'egress-command-1', originId: origin.originId, issueIdOrKey: 'DEMO-1' }).catch(() => {});
    assert.ok(fetched.length >= 1, 'import should issue at least one request');
    assert.ok(fetched.some((call) => call.url.includes('?')), 'fixture should exercise a query string');
    const egress = db.prepare("SELECT payload_json FROM runtime_events WHERE type = 'atlassian_egress'").all().map((row) => JSON.parse(row.payload_json));
    assert.equal(egress.length, fetched.length);
    for (const entry of egress) {
      assert.equal(entry.method, 'GET');
      assert.equal(entry.host, 'api.atlassian.com');
      assert.equal(entry.outcome, 'sent');
      assert.equal(entry.status, 200);
      assert.doesNotMatch(entry.path, /[?#]/);
    }
    assert.doesNotMatch(JSON.stringify(egress), /fixture-only-token|startAt|maxResults/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
