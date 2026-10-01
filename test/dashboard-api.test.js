'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { decision, assignment, makeFakeAppServer } = require('./fixtures/fake-app-server');

process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function rawGet(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard api', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-dash-api-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const tokenFile = path.join(root, 'token', 'a2a-token');
  const appServer = makeFakeAppServer({
    leadScript: [
      decision({ action: 'dispatch', assignments: [assignment('orch-explorer')] }),
      decision({ final: 'Done.' }),
    ],
  });
  const runtime = await startServer({
    port: 0,
    workspace,
    appServer,
    stateFile: path.join(root, 'state.sqlite'),
    tokenFile,
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
  });
  suite.after(async () => {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${runtime.port}`;
  const base = `${origin}/api/dashboard/v1`;
  const bearer = `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}`;

  const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });
  async function pair() {
    const res = await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } });
    assert.equal(res.status, 200);
    const { code } = await res.json();
    const exchange = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ code }),
    });
    assert.equal(exchange.status, 204);
    return exchange.headers.get('set-cookie').split(';')[0];
  }

  await suite.test('malformed percent-encoding in the path is a 400', async () => {
    const headers = { Cookie: await pair() };
    for (const p of ['/cards/%E0%A4%A', '/cards/%ZZ/events']) {
      const res = await get(p, headers);
      assert.equal(res.status, 400, p);
      assert.equal((await res.json()).error.code, 'invalid_request');
    }
  });

  await suite.test('auth boundaries', async () => {
    const unauth = await get('/cards');
    assert.equal(unauth.status, 401);
    assert.equal((await unauth.json()).error.code, 'unauthorized');
    assert.equal(unauth.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/pairing-codes`, { method: 'POST' })).status, 401);
    // The A2A bearer is not a dashboard session.
    assert.equal((await get('/cards', { Authorization: bearer })).status, 401);
    const { code, url } = await (await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } })).json();
    assert.ok(code);
    assert.equal(url, `${origin}/dashboard/#pair=${code}`);
  });

  await suite.test('bad Host is rejected', async () => {
    const res = await rawGet(runtime.port, '/api/dashboard/v1/context', { Host: 'evil.example:80' });
    assert.equal(res.status, 403);
    const page = await rawGet(runtime.port, '/dashboard/', { Host: 'evil.example:80' });
    assert.equal(page.status, 403);
  });

  await suite.test('static dashboard and redirect', async () => {
    const res = await fetch(`${origin}/dashboard/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const redirect = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/dashboard/');
  });

  await suite.test('read endpoints with a session', async () => {
    const cookie = await pair();
    const headers = { Cookie: cookie };

    const context = await (await get('/context', headers)).json();
    assert.equal(context.apiVersion, 1);
    assert.match(context.project.projectId, /^prj_[0-9a-f]{16}$/);
    assert.equal(context.project.displayName, 'workspace');
    assert.deepEqual(context.capabilities, { mutations: true, liveStream: false, events: true, ticketCommands: ['create', 'revise', 'cancel'] });
    assert.equal(context.health.eventJournal.status, 'ok');
    assert.equal(typeof context.lastEventSequence, 'number');
    assert.ok(context.server.startedAt && context.server.now);

    const rolesBody = await (await get('/roles', headers)).json();
    const { roles } = rolesBody;
    assert.equal(typeof rolesBody.activePack.packId, 'string');
    assert.ok(roles.some((role) => role.runtimeId === 'orch-lead' && role.kind === 'legacy'));
    assert.ok(roles.some((role) => role.runtimeId === 'orch-explorer' && role.kind === 'legacy'));
    assert.deepEqual(Object.keys(roles[0]).sort(), [
      'activeAttempts', 'displayName', 'effort', 'kind', 'model', 'pack', 'publicId', 'runtimeId', 'sandbox', 'serviceTier', 'settingsSource',
    ]);

    const empty = await (await get('/cards', headers)).json();
    assert.deepEqual(empty.cards, []);
    assert.deepEqual(Object.keys(empty.counts).sort(), ['backlog', 'closed', 'in_progress', 'needs_attention', 'pending']);
    assert.equal(empty.nextCursor, null);

    // Submit a fake lead run over A2A JSON-RPC.
    const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
    const task = await client.sendMessage({
      tenant: '',
      message: {
        messageId: 'dash-api-1', contextId: '', taskId: '', role: 1,
        parts: [{ content: { $case: 'text', value: 'Explore the repo' }, mediaType: 'text/plain', filename: '', metadata: undefined }],
        metadata: undefined, extensions: [], referenceTaskIds: [],
      },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
      metadata: undefined,
    }, { serviceParameters: { Authorization: bearer } });
    assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);

    const list = await (await get('/cards', headers)).json();
    assert.equal(list.cards.length, 1);
    const card = list.cards[0];
    assert.equal(card.title, 'Explore the repo');
    assert.equal(card.runtimeTaskRef.taskId, task.id);
    assert.equal(card.cardKind, 'legacy_run');
    assert.equal(card.boardColumn, 'closed');
    assert.equal(list.roleCounts['orch-lead'], 1);
    assert.equal((await (await get('/cards?column=closed&role=orch-lead&q=explore', headers)).json()).cards.length, 1);
    assert.equal((await (await get('/cards?column=backlog', headers)).json()).cards.length, 0);

    const detail = await (await get(`/cards/${card.cardId}`, headers)).json();
    assert.equal(detail.card.cardId, card.cardId);
    assert.deepEqual(detail.availableActions, []);
    assert.match(detail.resultText, /Done\./);

    const { attempts } = await (await get(`/cards/${card.cardId}/attempts`, headers)).json();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].role, 'orch-explorer');

    const usage = await (await get(`/cards/${card.cardId}/usage`, headers)).json();
    assert.ok(usage.coverage && usage.totals);

    const eventsBody = await (await get(`/cards/${card.cardId}/events`, headers)).json();
    const types = eventsBody.events.map((event) => event.type);
    assert.equal(types[0], 'run_submitted');
    assert.equal(types.at(-1), 'run_completed');
    assert.equal(eventsBody.nextAfter, eventsBody.events.at(-1).sequence);
    const tail = await (await get(`/cards/${card.cardId}/events?after=${eventsBody.events[0].sequence}&limit=1`, headers)).json();
    assert.equal(tail.events.length, 1);
    assert.equal(tail.events[0].sequence > eventsBody.events[0].sequence, true);

    // Reads do not mutate orchestrator state.
    const counts = () => Object.fromEntries(['tasks', 'dispatch_journal', 'usage_ledger', 'runtime_events']
      .map((table) => [table, runtime.state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
    const before = counts();
    for (let i = 0; i < 5; i += 1) {
      for (const p of ['/context', '/roles', '/cards', `/cards/${card.cardId}`, `/cards/${card.cardId}/attempts`,
        `/cards/${card.cardId}/usage`, `/cards/${card.cardId}/events`]) {
        assert.equal((await get(p, headers)).status, 200);
      }
    }
    assert.deepEqual(counts(), before);
  });

  await suite.test('validation and not found', async () => {
    const headers = { Cookie: await pair() };
    const bad = [
      '/cards?limit=0', '/cards?limit=101', '/cards?limit=abc', '/cards?column=nope', '/cards?role=orch-nobody',
      `/cards?q=${'x'.repeat(201)}`, '/cards?cursor=!!!', '/cards?limit=1&limit=2',
    ];
    for (const p of bad) {
      const res = await get(p, headers);
      assert.equal(res.status, 400, p);
      const body = await res.json();
      assert.equal(body.error.code, 'invalid_request');
      assert.ok(body.error.requestId);
    }
    const missing = await (await get('/cards/lr_bm9wZQ', headers));
    assert.ok([400, 404].includes(missing.status));
    const { cards } = await (await get('/cards', headers)).json();
    const cardId = cards[0].cardId;
    for (const p of ['?after=-1', '?after=x', '?limit=0', '?limit=501']) {
      assert.equal((await get(`/cards/${cardId}/events${p}`, headers)).status, 400, p);
    }
    assert.equal((await get(`/cards/${cardId}/events?limit=500`, headers)).status, 200);
    const unknown = Buffer.from('orchestrator\u0000\u0000no-such-task').toString('base64url');
    const res = await get(`/cards/lr_${unknown}`, headers);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
    const nope = await get('/nope', headers);
    assert.equal(nope.status, 404);
    assert.equal((await nope.json()).error.code, 'not_found');
    const nopeOuter = await fetch(`${origin}/api/dashboard/other`);
    assert.equal(nopeOuter.status, 404);
  });
});
