'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');
const Database = require('better-sqlite3');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { createLauncherApp } = require('../src/launcher-app');
const { ProjectError } = require('../src/launcher-projects');
const { createTaskStore, openStateDatabase } = require('../src/durable-store');

const ID_A = 'aaaaaaaaaa';
const ID_B = 'bbbbbbbbbb';
const ID_MISSING = 'cccccccccc';

let tmp;
let server;
let base;
let calls;
let fakeStatus;
let nextError;
let sent;
let dbFiles;

function fakeProjects() {
  const maybeFail = (name) => {
    if (nextError && nextError.method === name) {
      const error = nextError.error;
      nextError = null;
      throw error;
    }
  };
  const view = (id) => ({ id, name: id, path: '/w/' + id, port: id === ID_A ? 4001 : 4002, status: fakeStatus[id] });
  return {
    list: () => [ID_A, ID_B].map(view),
    get: (id) => (fakeStatus[id] ? view(id) : null),
    baseUrl: (id) => 'http://127.0.0.1:' + view(id).port,
    stateDbPath: (id) => dbFiles[id],
    touch: async (id) => { calls.push(['touch', id]); },
    add: async (p) => { maybeFail('add'); calls.push(['add', p]); return view(ID_A); },
    remove: async (id) => { maybeFail('remove'); calls.push(['remove', id]); return view(id); },
    start: async (id) => { maybeFail('start'); calls.push(['start', id]); return view(id); },
    stop: async (id) => { maybeFail('stop'); calls.push(['stop', id]); return view(id); },
    status: (id) => ({ ...view(id), logs: ['one\n', 'two\n'] }),
  };
}

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function leadTask(id, state, goal, updated) {
  return {
    id,
    contextId: 'ctx-' + id,
    status: { state, timestamp: updated },
    artifacts: [],
    history: [{
      messageId: 'm-' + id,
      contextId: 'ctx-' + id,
      taskId: id,
      role: 1,
      parts: [{ content: { $case: 'text', value: goal }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      extensions: [],
      referenceTaskIds: [],
    }],
    metadata: {},
  };
}

async function makeDb(file, tasks) {
  const state = await openStateDatabase({ filePath: file });
  try {
    const store = createTaskStore(state, 'orchestrator');
    for (const t of tasks) await store.save(t, new ServerCallContext());
  } finally {
    state.close();
  }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-app-'));
  dbFiles = {
    [ID_A]: path.join(tmp, 'a', 'state.sqlite'),
    [ID_B]: path.join(tmp, 'b', 'state.sqlite'),
    [ID_MISSING]: path.join(tmp, 'none', 'state.sqlite'),
  };
  await makeDb(dbFiles[ID_A], [
    leadTask('task-a1', TaskState.TASK_STATE_COMPLETED, 'goal of A done', '2026-01-01T00:00:00.000Z'),
    leadTask('task-a2', TaskState.TASK_STATE_WORKING, 'goal of A active', '2026-01-02T00:00:00.000Z'),
  ]);
  await makeDb(dbFiles[ID_B], [
    leadTask('task-b1', TaskState.TASK_STATE_COMPLETED, 'goal of B', '2026-01-03T00:00:00.000Z'),
  ]);
});

after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  nextError = null;
  sent = [];
  fakeStatus = { [ID_A]: 'running', [ID_B]: 'stopped', [ID_MISSING]: 'stopped' };
  if (server) server.close();
  const fakeClient = {
    getTask: async ({ id }) => ({ id, contextId: 'ctx-' + id }),
    sendMessage: async (req) => { sent.push(req); return { id: 'new-task' }; },
  };
  const app = createLauncherApp({
    projects: fakeProjects(),
    readAuthToken: () => 'tok',
    createClient: async (url) => { sent.push({ url }); return fakeClient; },
    openTasksDb: (file, options) => new Database(file, options),
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});

describe('project routes', () => {
  it('lists projects', async () => {
    const r = await api('GET', '/api/projects');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.projects.map((p) => p.id), [ID_A, ID_B]);
  });

  it('adds, starts (with touch), stops and removes', async () => {
    assert.equal((await api('POST', '/api/projects', { path: '/x' })).body.success, true);
    assert.equal((await api('POST', `/api/projects/${ID_A}/start`)).body.project.id, ID_A);
    assert.equal((await api('POST', `/api/projects/${ID_A}/stop`)).status, 200);
    assert.equal((await api('DELETE', `/api/projects/${ID_B}`)).status, 200);
    assert.deepEqual(calls, [['add', '/x'], ['start', ID_A], ['touch', ID_A], ['stop', ID_A], ['remove', ID_B]]);
  });

  it('maps ProjectError codes and unknown errors', async () => {
    const cases = [
      ['not_found', 404], ['not_a_directory', 400], ['running', 409], ['not_managed', 409], ['no_port', 503],
    ];
    for (const [code, status] of cases) {
      nextError = { method: 'start', error: new ProjectError(code, 'msg ' + code) };
      const r = await api('POST', `/api/projects/${ID_A}/start`);
      assert.equal(r.status, status, code);
      assert.deepEqual(r.body, { success: false, error: 'msg ' + code });
    }
    nextError = { method: 'add', error: new Error('boom') };
    const r = await api('POST', '/api/projects', { path: '/x' });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { success: false, error: 'boom' });
  });

  it('validates ids and unknown projects', async () => {
    for (const id of ['short', 'ZZZZZZZZZZ', 'aaaaaaaaaaa', ID_MISSING.replace(/c/g, 'd')]) {
      const r = await api('POST', `/api/projects/${id}/start`);
      assert.equal(r.status, 404, id);
    }
    assert.equal((await api('GET', '/api/projects/nothex/tasks/latest')).status, 404);
    assert.deepEqual(calls, []);
  });

  it('returns status with logs', async () => {
    const r = await api('GET', `/api/projects/${ID_A}/status`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'running');
    assert.equal(r.body.project.id, ID_A);
    assert.equal(r.body.project.logs, undefined);
    assert.deepEqual(r.body.logs, ['one\n', 'two\n']);
  });
});

describe('task send', () => {
  it('requires a running project', async () => {
    const r = await api('POST', `/api/projects/${ID_B}/task/send`, { goal: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.body.success, false);
    assert.deepEqual(sent, []);
  });

  it('uses the project base url, touches and sends', async () => {
    const r = await api('POST', `/api/projects/${ID_A}/task/send`, { goal: 'do it', checks: ['npm test'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, result: { id: 'new-task' } });
    assert.equal(sent[0].url, 'http://127.0.0.1:4001');
    assert.equal(sent[1].message.parts[0].content.value, 'do it');
    assert.deepEqual(calls, [['touch', ID_A]]);
  });

  it('rejects taskId together with continueFrom', async () => {
    const r = await api('POST', `/api/projects/${ID_A}/task/send`, { goal: 'x', taskId: 't', continueFrom: 'u' });
    assert.equal(r.status, 400);
  });
});

describe('task read routes use the project own db', () => {
  it('latest', async () => {
    const a = await api('GET', `/api/projects/${ID_A}/tasks/latest`);
    assert.equal(a.body.leadTask.id, 'task-a2');
    assert.equal(a.body.leadTask.goal, 'goal of A active');
    const b = await api('GET', `/api/projects/${ID_B}/tasks/latest`);
    assert.equal(b.body.leadTask.id, 'task-b1');
  });

  it('history', async () => {
    const a = await api('GET', `/api/projects/${ID_A}/tasks/history`);
    assert.deepEqual(a.body.tasks.map((t) => t.id), ['task-a2', 'task-a1']);
    const b = await api('GET', `/api/projects/${ID_B}/tasks/history`);
    assert.deepEqual(b.body.tasks.map((t) => t.id), ['task-b1']);
  });

  it('single task does not leak across projects', async () => {
    assert.equal((await api('GET', `/api/projects/${ID_A}/tasks/task-a1`)).body.leadTask.goal, 'goal of A done');
    assert.equal((await api('GET', `/api/projects/${ID_B}/tasks/task-a1`)).status, 404);
  });

  it('missing db gives empty results and 404', async () => {
    fakeStatus[ID_MISSING] = 'stopped';
    const latest = await api('GET', `/api/projects/${ID_MISSING}/tasks/latest`);
    assert.deepEqual(latest.body, { leadTask: null, workers: [] });
    assert.deepEqual((await api('GET', `/api/projects/${ID_MISSING}/tasks/history`)).body, { tasks: [] });
    assert.equal((await api('GET', `/api/projects/${ID_MISSING}/tasks/x`)).status, 404);
  });

  it('delete is terminal-only and scoped to the project', async () => {
    assert.equal((await api('DELETE', `/api/projects/${ID_A}/tasks/task-a2`)).status, 400);
    assert.equal((await api('DELETE', `/api/projects/${ID_B}/tasks/task-a1`)).status, 404);
    const ok = await api('DELETE', `/api/projects/${ID_A}/tasks/task-a1`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deletedId, 'task-a1');
    const a = await api('GET', `/api/projects/${ID_A}/tasks/history`);
    assert.deepEqual(a.body.tasks.map((t) => t.id), ['task-a2']);
    const b = await api('GET', `/api/projects/${ID_B}/tasks/history`);
    assert.deepEqual(b.body.tasks.map((t) => t.id), ['task-b1']);
  });
});
