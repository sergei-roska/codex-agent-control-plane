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
    roleOverridesPath: (id) => path.join(tmp, id, 'role-overrides.json'),
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

function leadTask(id, state, goal, updated, contextId = 'ctx-' + id, refs = []) {
  return {
    id,
    contextId,
    status: { state, timestamp: updated },
    artifacts: [],
    history: [{
      messageId: 'm-' + id,
      contextId,
      taskId: id,
      role: 1,
      parts: [{ content: { $case: 'text', value: goal }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      extensions: [],
      referenceTaskIds: refs,
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
    leadTask('task-a3', TaskState.TASK_STATE_COMPLETED, 'follow-up of A', '2026-01-03T00:00:00.000Z', 'ctx-task-a1', ['task-a1']),
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
    assert.equal((await api('GET', '/api/projects/nothex/sessions')).status, 404);
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

const CTX = '0b9f3c1e-5a7d-4c2b-8e11-6f0a2d9b7c34';
const message = () => sent.find((x) => x.message).message;

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

describe('task send sessions', () => {
  it('a new session carries the client contextId and no references', async () => {
    const r = await api('POST', `/api/projects/${ID_A}/task/send`, { goal: 'x', contextId: CTX });
    assert.equal(r.status, 200);
    assert.equal(message().contextId, CTX);
    assert.deepEqual(message().referenceTaskIds, []);
  });

  it('continueFrom derives the contextId from the earlier task', async () => {
    const r = await api('POST', `/api/projects/${ID_A}/task/send`, { goal: 'x', continueFrom: 'task-a1' });
    assert.equal(r.status, 200);
    assert.equal(message().contextId, 'ctx-task-a1');
    assert.deepEqual(message().referenceTaskIds, ['task-a1']);
  });

  it('ignores a body contextId when continueFrom or taskId is present', async () => {
    await api('POST', `/api/projects/${ID_A}/task/send`, { goal: 'x', continueFrom: 'task-a1', contextId: CTX });
    assert.equal(message().contextId, 'ctx-task-a1');
    sent = [];
    await api('POST', `/api/projects/${ID_A}/task/send`, { goal: 'x', taskId: 'task-a2', contextId: 'not-a-uuid' });
    assert.equal(message().contextId, 'ctx-task-a2');
    assert.equal(message().taskId, 'task-a2');
  });

  it('rejects a malformed contextId', async () => {
    for (const bad of ['not-a-uuid', 42, {}, CTX + 'x']) {
      const r = await api('POST', `/api/projects/${ID_A}/task/send`, { goal: 'x', contextId: bad });
      assert.equal(r.status, 400);
    }
    assert.deepEqual(sent, []);
  });
});

describe('session routes use the project own db', () => {
  it('lists sessions grouped by context, newest first', async () => {
    const a = await api('GET', `/api/projects/${ID_A}/sessions`);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.sessions.map((x) => x.contextId), ['ctx-task-a1', 'ctx-task-a2']);
    const first = a.body.sessions[0];
    assert.equal(first.goal, 'goal of A done');
    assert.equal(first.turns, 2);
    assert.equal(first.lastTaskId, 'task-a3');
    assert.equal(first.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(Object.keys(first).sort(), ['contextId', 'disposition', 'goal', 'lastTaskId', 'state', 'turns', 'updatedAt']);
    const b = await api('GET', `/api/projects/${ID_B}/sessions`);
    assert.deepEqual(b.body.sessions.map((x) => x.contextId), ['ctx-task-b1']);
  });

  it('returns one session with turns oldest first, 404 for unknown or foreign', async () => {
    const r = await api('GET', `/api/projects/${ID_A}/sessions/ctx-task-a1`);
    assert.equal(r.status, 200);
    assert.equal(r.body.contextId, 'ctx-task-a1');
    assert.deepEqual(r.body.turns.map((t) => t.leadTask.id), ['task-a1', 'task-a3']);
    assert.equal(r.body.turns[1].leadTask.continuesFrom, 'task-a1');
    assert.deepEqual(r.body.turns[0].workers, []);
    assert.equal((await api('GET', `/api/projects/${ID_A}/sessions/nope`)).status, 404);
    assert.equal((await api('GET', `/api/projects/${ID_B}/sessions/ctx-task-a1`)).status, 404);
  });

  it('single task does not leak across projects', async () => {
    assert.equal((await api('GET', `/api/projects/${ID_A}/tasks/task-a1`)).body.leadTask.goal, 'goal of A done');
    assert.equal((await api('GET', `/api/projects/${ID_B}/tasks/task-a1`)).status, 404);
  });

  it('missing db gives empty results and 404', async () => {
    const list = await api('GET', `/api/projects/${ID_MISSING}/sessions`);
    assert.deepEqual(list.body, { sessions: [] });
    assert.equal((await api('GET', `/api/projects/${ID_MISSING}/sessions/x`)).status, 404);
    assert.equal((await api('DELETE', `/api/projects/${ID_MISSING}/sessions/x`)).status, 404);
    assert.equal((await api('GET', `/api/projects/${ID_MISSING}/tasks/x`)).status, 404);
  });

  it('single task delete is terminal-only and scoped to the project', async () => {
    assert.equal((await api('DELETE', `/api/projects/${ID_A}/tasks/task-a2`)).status, 400);
    assert.equal((await api('DELETE', `/api/projects/${ID_B}/tasks/task-a3`)).status, 404);
    const ok = await api('DELETE', `/api/projects/${ID_A}/tasks/task-a3`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deletedId, 'task-a3');
    const a = await api('GET', `/api/projects/${ID_A}/sessions/ctx-task-a1`);
    assert.deepEqual(a.body.turns.map((t) => t.leadTask.id), ['task-a1']);
  });

  it('session delete refuses an active session, 404s foreign ids, removes a terminal one', async () => {
    const active = await api('DELETE', `/api/projects/${ID_A}/sessions/ctx-task-a2`);
    assert.equal(active.status, 400);
    assert.equal(active.body.success, false);
    assert.equal((await api('DELETE', `/api/projects/${ID_B}/sessions/ctx-task-a1`)).status, 404);
    const ok = await api('DELETE', `/api/projects/${ID_A}/sessions/ctx-task-a1`);
    assert.equal(ok.status, 200);
    // task-a3 was already removed by the single-task delete test above (the db is shared)
    assert.deepEqual(ok.body.deletedIds, ['task-a1']);
    const a = await api('GET', `/api/projects/${ID_A}/sessions`);
    assert.deepEqual(a.body.sessions.map((x) => x.contextId), ['ctx-task-a2']);
    const b = await api('GET', `/api/projects/${ID_B}/sessions`);
    assert.deepEqual(b.body.sessions.map((x) => x.contextId), ['ctx-task-b1']);
  });
});

describe('favicon', () => {
  it('answers 204', async () => {
    const res = await fetch(base + '/favicon.ico');
    assert.equal(res.status, 204);
  });
});

describe('role overrides', () => {
  const overridesFile = (id) => path.join(tmp, id, 'role-overrides.json');
  const find = (team, name) => [team.lead, ...team.roles].find((role) => role.name === name);

  beforeEach(() => {
    fs.rmSync(overridesFile(ID_A), { force: true });
    fs.rmSync(overridesFile(ID_B), { force: true });
    // Overrides are edited only while the project server is stopped.
    fakeStatus[ID_A] = 'stopped';
  });

  it('serves the team of a project with defaults, override, and the models list', async () => {
    const r = await api('GET', `/api/projects/${ID_A}/team`);
    assert.equal(r.status, 200);
    assert.equal(r.body.lead.name, 'coordinator');
    assert.equal(r.body.lead.override, null);
    assert.deepEqual(r.body.lead.defaults, { model: r.body.lead.model, effort: r.body.lead.effort });
    assert.ok(r.body.models.includes(r.body.lead.model));
    assert.deepEqual(r.body.models, [...r.body.models].sort());
    assert.equal(new Set(r.body.models).size, r.body.models.length);
    assert.equal(r.body.warning, null);
    assert.equal(r.body.running, false);
    assert.equal((await api('GET', '/api/projects/dddddddddd/team')).status, 404);
  });

  it('reports running while the project server is starting or running and refuses edits with 409', async () => {
    await api('PUT', `/api/projects/${ID_A}/roles/architect/override`, { effort: 'low' });
    const before = fs.readFileSync(overridesFile(ID_A), 'utf8');
    for (const status of ['running', 'starting']) {
      fakeStatus[ID_A] = status;
      const team = await api('GET', `/api/projects/${ID_A}/team`);
      assert.equal(team.body.running, true);
      assert.equal(find(team.body, 'architect').effort, 'low');
      const put = await api('PUT', `/api/projects/${ID_A}/roles/architect/override`, { effort: 'high' });
      assert.equal(put.status, 409);
      assert.equal(put.body.success, false);
      assert.match(put.body.error, /Stop the project server/);
      const del = await api('DELETE', `/api/projects/${ID_A}/roles/architect/override`);
      assert.equal(del.status, 409);
      assert.match(del.body.error, /Stop the project server/);
      assert.equal(fs.readFileSync(overridesFile(ID_A), 'utf8'), before);
    }
    fakeStatus[ID_A] = 'stopped';
    assert.equal((await api('PUT', `/api/projects/${ID_A}/roles/architect/override`, { effort: 'high' })).status, 200);
    assert.equal((await api('GET', `/api/projects/${ID_A}/team`)).body.running, false);
  });

  it('PUT stores an override per project atomically and the team shows the effective values', async () => {
    const before = await api('GET', `/api/projects/${ID_A}/team`);
    const base = find(before.body, 'architect');
    const r = await api('PUT', `/api/projects/${ID_A}/roles/architect/override`, { model: 'gpt-6-luna', effort: 'low', extraRules: '  Prefer small modules.  ' });
    assert.equal(r.status, 200);
    const architect = find(r.body, 'architect');
    assert.equal(architect.model, 'gpt-6-luna');
    assert.equal(architect.effort, 'low');
    assert.deepEqual(architect.defaults, { model: base.model, effort: base.effort });
    assert.deepEqual(architect.override, { model: 'gpt-6-luna', effort: 'low', extraRules: 'Prefer small modules.' });
    const file = JSON.parse(fs.readFileSync(overridesFile(ID_A), 'utf8'));
    assert.equal(file.version, 1);
    assert.deepEqual(file.roles, { architect: { model: 'gpt-6-luna', effort: 'low', extraRules: 'Prefer small modules.' } });
    assert.match(file.updatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(fs.readdirSync(path.dirname(overridesFile(ID_A))).filter((name) => name.includes('.tmp-')), []);
    // Isolation: the other project is untouched and has no file.
    const other = await api('GET', `/api/projects/${ID_B}/team`);
    assert.equal(find(other.body, 'architect').override, null);
    assert.equal(fs.existsSync(overridesFile(ID_B)), false);
  });

  it('overrides the lead through the coordinator name and keeps the other fields on a partial update', async () => {
    const r = await api('PUT', `/api/projects/${ID_A}/roles/coordinator/override`, { effort: 'high' });
    assert.equal(r.status, 200);
    assert.equal(r.body.lead.effort, 'high');
    assert.equal(r.body.lead.model, r.body.lead.defaults.model);
    assert.deepEqual(r.body.lead.override, { model: null, effort: 'high', extraRules: null });
    // A legacy name resolves to the same role.
    const legacy = await api('PUT', `/api/projects/${ID_A}/roles/orch-lead/override`, { effort: 'low' });
    assert.equal(legacy.body.lead.effort, 'low');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(overridesFile(ID_A), 'utf8')).roles), ['coordinator']);
  });

  it('empty fields clear; an all-empty PUT and DELETE reset the role', async () => {
    await api('PUT', `/api/projects/${ID_A}/roles/engineer/override`, { model: 'gpt-6-luna', effort: 'low', extraRules: 'x' });
    const partial = await api('PUT', `/api/projects/${ID_A}/roles/engineer/override`, { model: '', effort: 'high', extraRules: null });
    assert.deepEqual(find(partial.body, 'engineer').override, { model: null, effort: 'high', extraRules: null });
    const cleared = await api('PUT', `/api/projects/${ID_A}/roles/engineer/override`, { model: null, effort: '', extraRules: '   ' });
    assert.equal(find(cleared.body, 'engineer').override, null);
    await api('PUT', `/api/projects/${ID_A}/roles/auditor/override`, { effort: 'low' });
    const reset = await api('DELETE', `/api/projects/${ID_A}/roles/auditor/override`);
    assert.equal(reset.status, 200);
    assert.equal(find(reset.body, 'auditor').override, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(overridesFile(ID_A), 'utf8')).roles, {});
  });

  it('rejects invalid input with 400 and a message, and writes nothing', async () => {
    const put = (role, body) => api('PUT', `/api/projects/${ID_A}/roles/${role}/override`, body);
    for (const [role, body, message] of [
      ['architect', { model: 'claude-x' }, /Invalid model/],
      ['architect', { effort: 'extreme' }, /Effort must be one of/],
      ['architect', { extraRules: 'a {{TEAM_RULES}} b' }, /must not contain/],
      ['architect', { extraRules: 'a }} b' }, /must not contain/],
      ['architect', { extraRules: 'x'.repeat(4001) }, /limited to 4000/],
      ['architect', { extraRules: 12 }, /must be text/],
      ['architect', { model: 5 }, /Invalid model/],
      ['architect', { bogus: 1 }, /Unknown override field/],
      ['nobody', { effort: 'low' }, /Unknown role/],
    ]) {
      const r = await put(role, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(r.body.success, false);
      assert.match(r.body.error, message);
    }
    assert.equal((await put('architect', { extraRules: 'x'.repeat(4000) })).status, 200);
    fs.rmSync(overridesFile(ID_A), { force: true });
    assert.equal((await api('DELETE', `/api/projects/${ID_A}/roles/nobody/override`)).status, 400);
    assert.equal(fs.existsSync(overridesFile(ID_A)), false);
  });

  it('an invalid file is reported as a warning, shows defaults, and is replaced by the next valid PUT', async () => {
    fs.writeFileSync(overridesFile(ID_A), '{ broken');
    const r = await api('GET', `/api/projects/${ID_A}/team`);
    assert.equal(r.status, 200);
    assert.match(r.body.warning, /Role overrides ignored/);
    assert.equal(find(r.body, 'architect').override, null);
    const put = await api('PUT', `/api/projects/${ID_A}/roles/architect/override`, { effort: 'low' });
    assert.equal(put.status, 200);
    assert.equal(put.body.warning, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(overridesFile(ID_A), 'utf8')).roles, { architect: { effort: 'low' } });
  });

  it('keeps the global team unchanged by project overrides', async () => {
    await api('PUT', `/api/projects/${ID_A}/roles/architect/override`, { model: 'gpt-6-luna', effort: 'low', extraRules: 'x' });
    const global = await api('GET', '/api/team');
    assert.equal(global.status, 200);
    const architect = global.body.roles.find((role) => role.name === 'architect');
    assert.notEqual(architect.model, 'gpt-6-luna');
    assert.equal('defaults' in architect, false);
    assert.equal('override' in architect, false);
    assert.equal('models' in global.body, false);
  });
});
