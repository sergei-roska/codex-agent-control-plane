'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');
const Database = require('better-sqlite3');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');
const { emptyCheckpoint } = require('@langchain/langgraph-checkpoint');
const { createLauncherApp } = require('../src/launcher-app');
const { createTaskStore, openStateDatabase } = require('../src/durable-store');

const ID_RUN = 'aaaaaaaaaa';
const ID_STOP = 'bbbbbbbbbb';
const ID_NODB = 'cccccccccc';
const OWNER = { kind: 'owner_pause', message: 'Paused by the owner' };

let tmp;
let dbFile;
let control; // fake project server
let controlPort;
let controlCalls;
let controlRuns;
let launcher;
let base;
let sent;
let sendError;

function leadTask(id, state, updated, contextId, metadata = {}) {
  return {
    id,
    contextId,
    status: { state, timestamp: updated },
    artifacts: [],
    history: [{
      messageId: 'm-' + id, contextId, taskId: id, role: 1,
      parts: [{ content: { $case: 'text', value: 'goal of ' + id }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      extensions: [], referenceTaskIds: [],
    }],
    metadata,
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-pause-'));
  dbFile = path.join(tmp, 'state.sqlite');
  const state = await openStateDatabase({ filePath: dbFile });
  const store = createTaskStore(state, 'orchestrator');
  await store.save(leadTask('old-paused', TaskState.TASK_STATE_INPUT_REQUIRED, '2026-01-01T00:00:00.000Z', 'ctx-old', { pause: OWNER }), new ServerCallContext());
  await store.save(leadTask('stopped-1', TaskState.TASK_STATE_INPUT_REQUIRED, '2025-12-01T00:00:00.000Z', 'ctx-stop', { pause: { kind: 'stopped', message: 'Stopped by the owner' } }), new ServerCallContext());
  await store.save(leadTask('working-1', TaskState.TASK_STATE_WORKING, '2026-01-02T00:00:00.000Z', 'ctx-work'), new ServerCallContext());
  const saver = new SqliteSaver(state.db);
  await saver.put({ configurable: { thread_id: 'working-1', checkpoint_ns: '' } }, {
    ...emptyCheckpoint(), id: 'ck-0001', ts: '2026-01-02T00:00:01.000Z', channel_values: { round: 1 }, channel_versions: { 'branch:to:decide': 1 },
  }, { source: 'loop', step: 1, parents: {} });
  await state.close();
  control = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      controlCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ runs: controlRuns }));
    });
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
  controlPort = control.address().port;
});

after(() => {
  if (launcher) launcher.close();
  control.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  controlCalls = [];
  controlRuns = [];
  sent = [];
  sendError = null;
  if (launcher) launcher.close();
  const projects = {
    get: (id) => ({ id, path: '/nonexistent', status: id === ID_STOP ? 'stopped' : 'running' }),
    baseUrl: () => 'http://127.0.0.1:' + controlPort,
    stateDbPath: (id) => (id === ID_NODB ? path.join(tmp, 'none', 'state.sqlite') : dbFile),
    touch: async () => {},
  };
  const app = createLauncherApp({
    projects,
    readAuthToken: () => 'tok',
    createClient: async () => ({
      sendMessage: async (req, opts) => {
        if (sendError) throw sendError;
        sent.push({ req, opts });
        return { id: 'x' };
      },
    }),
    openTasksDb: (file, options) => new Database(file, options),
  });
  await new Promise((resolve) => { launcher = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + launcher.address().port;
});

describe('pause and pause/cancel routes', () => {
  it('pause flags the active runs through the control route with the token', async () => {
    controlRuns = [{ taskId: 'working-1', pauseRequested: true }];
    const r = await api('POST', `/api/projects/${ID_RUN}/pause`);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(r.body.runs, controlRuns);
    assert.deepEqual(controlCalls.map((c) => [c.method, c.url, c.auth]), [['POST', '/control/pause', 'Bearer tok']]);
  });

  it('pause 409s when the server is stopped or no run is active', async () => {
    const stopped = await api('POST', `/api/projects/${ID_STOP}/pause`);
    assert.equal(stopped.status, 409);
    assert.ok(stopped.body.error);
    assert.deepEqual(controlCalls, []);
    const none = await api('POST', `/api/projects/${ID_RUN}/pause`);
    assert.equal(none.status, 409);
    assert.match(none.body.error, /nothing to pause/);
  });

  it('cancel withdraws a pending request and 409s when none is pending or the server is stopped', async () => {
    controlRuns = [{ taskId: 'working-1', pauseRequested: false }];
    const ok = await api('POST', `/api/projects/${ID_RUN}/pause/cancel`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.success, true);
    assert.equal(controlCalls[0].url, '/control/pause/cancel');
    controlRuns = [];
    const none = await api('POST', `/api/projects/${ID_RUN}/pause/cancel`);
    assert.equal(none.status, 409);
    assert.match(none.body.error, /No pause request/);
    assert.equal((await api('POST', `/api/projects/${ID_STOP}/pause/cancel`)).status, 409);
  });

  it('404s an unknown project', async () => {
    assert.equal((await api('POST', '/api/projects/nothex/pause')).status, 404);
  });
});

describe('resume route', () => {
  it('sends the continue message to the paused lead task of the named session', async () => {
    const r = await api('POST', `/api/projects/${ID_RUN}/resume`, { sessionContextId: 'ctx-old' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, taskId: 'old-paused' });
    assert.equal(sent.length, 1);
    const { message, configuration } = sent[0].req;
    assert.equal(message.taskId, 'old-paused');
    assert.equal(message.contextId, 'ctx-old');
    assert.equal(message.parts[0].content.value, 'Continue.');
    assert.equal(configuration.returnImmediately, true);
    assert.deepEqual(sent[0].opts, { serviceParameters: { Authorization: 'Bearer tok' } });
  });

  it('also continues a run parked by Stop', async () => {
    const r = await api('POST', `/api/projects/${ID_RUN}/resume`, { sessionContextId: 'ctx-stop' });
    assert.deepEqual(r.body, { success: true, taskId: 'stopped-1' });
    assert.equal(sent[0].req.message.taskId, 'stopped-1');
  });

  it('409s when the latest session is not paused, the session is unknown, or the server is stopped', async () => {
    assert.equal((await api('POST', `/api/projects/${ID_RUN}/resume`)).status, 409);
    assert.equal((await api('POST', `/api/projects/${ID_RUN}/resume`, { sessionContextId: 'ctx-work' })).status, 409);
    assert.equal((await api('POST', `/api/projects/${ID_RUN}/resume`, { sessionContextId: 'nope' })).status, 409);
    assert.equal((await api('POST', `/api/projects/${ID_NODB}/resume`)).status, 409);
    assert.equal((await api('POST', `/api/projects/${ID_STOP}/resume`)).status, 409);
    assert.deepEqual(sent, []);
  });

  it('400s a non-string session id and 409s a task that is already executing', async () => {
    assert.equal((await api('POST', `/api/projects/${ID_RUN}/resume`, { sessionContextId: 7 })).status, 400);
    sendError = new Error('Task "old-paused" is already executing; concurrent messages for one task are rejected.');
    const r = await api('POST', `/api/projects/${ID_RUN}/resume`, { sessionContextId: 'ctx-old' });
    assert.equal(r.status, 409);
  });
});

describe('situation route reflects a pending pause request', () => {
  it('shows pausing within one poll while the server reports the request', async () => {
    const before = await api('GET', `/api/projects/${ID_RUN}/sessions/ctx-work/situation`);
    assert.equal(before.body.phase, 'planning');
    controlRuns = [{ taskId: 'working-1', pauseRequested: true }];
    const during = await api('GET', `/api/projects/${ID_RUN}/sessions/ctx-work/situation`);
    assert.equal(during.body.phase, 'pausing');
    assert.deepEqual(controlCalls.map((c) => [c.method, c.url, c.auth]).at(-1), ['GET', '/control/pause', 'Bearer tok']);
    controlRuns = [{ taskId: 'working-1', pauseRequested: false }];
    assert.equal((await api('GET', `/api/projects/${ID_RUN}/sessions/ctx-work/situation`)).body.phase, 'planning');
  });

  it('shows paused for a parked owner pause and still answers when the control route is down', async () => {
    const paused = await api('GET', `/api/projects/${ID_RUN}/sessions/ctx-old/situation`);
    assert.equal(paused.body.phase, 'paused');
    control.close();
    try {
      const r = await api('GET', `/api/projects/${ID_RUN}/sessions/ctx-work/situation`);
      assert.equal(r.status, 200);
      assert.equal(r.body.phase, 'planning');
    } finally {
      control = http.createServer((req, res) => { res.end('{"runs":[]}'); });
      await new Promise((resolve) => control.listen(controlPort, '127.0.0.1', resolve));
    }
  });
});
