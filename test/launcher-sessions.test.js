'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { createTaskStore, openStateDatabase } = require('../src/durable-store');
const { WriterAdmission } = require('../src/writer-admission');
const {
  SessionError,
  formatLeadTask,
  listSessions,
  getSession,
  deleteLeadTask,
  deleteSession,
} = require('../src/launcher-sessions');

function userMessage(id, text, refs = []) {
  return {
    messageId: 'm-' + id,
    contextId: '',
    taskId: id,
    role: 1,
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    extensions: [],
    referenceTaskIds: refs,
  };
}

function lead(id, contextId, state, text, timestamp, refs = [], extra = {}) {
  return {
    id,
    contextId,
    status: { state, timestamp },
    artifacts: [],
    history: [userMessage(id, text, refs)],
    metadata: {},
    ...extra,
  };
}

async function fixture(t, tasks, workerTasks = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-sessions-'));
  const state = await openStateDatabase({ filePath: path.join(dir, 'state.sqlite') });
  t.after(() => {
    return state.close().then(() => fs.rmSync(dir, { recursive: true, force: true }));
  });
  const store = createTaskStore(state, 'orchestrator');
  for (const task of tasks) await store.save(task, new ServerCallContext());
  const workerStore = createTaskStore(state, 'orch-builder');
  for (const task of workerTasks) await workerStore.save(task, new ServerCallContext());
  return state.db;
}

function journal(db, runId, attemptId, taskId) {
  db.prepare(`INSERT INTO dispatch_journal
    (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id, state, created_at, updated_at)
    VALUES (?, ?, 'a', 'reviewer', 'read-only', 'c', ?, 'finished', '2026-01-01', '2026-01-01')`)
    .run(attemptId, runId, taskId);
}

const DONE = TaskState.TASK_STATE_COMPLETED;
const CHAIN = [
  lead('t1', 'ctx-a', DONE, 'first goal', '2026-01-01T00:00:00.000Z'),
  lead('t2', 'ctx-a', DONE, 'second goal', '2026-01-02T00:00:00.000Z', ['t1']),
  lead('t3', 'ctx-a', DONE, 'third goal', '2026-01-03T00:00:00.000Z', ['t2'], {
    artifacts: [{ artifactId: 'x', parts: [], metadata: { acceptance: { disposition: 'accepted' } } }],
  }),
  lead('f1', 'ctx-b', TaskState.TASK_STATE_FAILED, 'broken goal', '2026-01-04T00:00:00.000Z'),
  lead('old1', '', DONE, 'legacy goal', '2025-12-01T00:00:00.000Z'),
];

test('listSessions groups by context_id, newest first, with summary fields', async (t) => {
  const db = await fixture(t, CHAIN);
  const sessions = listSessions(db);
  assert.deepEqual(sessions.map((s) => s.contextId), ['ctx-b', 'ctx-a', 'old1']);
  const a = sessions.find((s) => s.contextId === 'ctx-a');
  assert.equal(a.goal, 'first goal');
  assert.equal(a.turns, 3);
  assert.equal(a.state, 'TASK_STATE_COMPLETED');
  assert.equal(a.lastTaskId, 't3');
  assert.equal(a.disposition, 'accepted');
  assert.equal(typeof a.updatedAt, 'number');
  const b = sessions.find((s) => s.contextId === 'ctx-b');
  assert.equal(b.turns, 1);
  assert.equal(b.state, 'TASK_STATE_FAILED');
  assert.equal(b.disposition, null);
  assert.equal(sessions.find((s) => s.contextId === 'old1').lastTaskId, 'old1');
});

test('getSession returns turns oldest first and keeps referenceTaskIds', async (t) => {
  const db = await fixture(t, CHAIN);
  const session = getSession(db, 'ctx-a');
  assert.equal(session.contextId, 'ctx-a');
  assert.deepEqual(session.turns.map((x) => x.leadTask.id), ['t1', 't2', 't3']);
  assert.deepEqual(session.turns.map((x) => x.leadTask.goal), ['first goal', 'second goal', 'third goal']);
  assert.deepEqual(session.turns.map((x) => x.leadTask.continuesFrom), [null, 't1', 't2']);
  assert.deepEqual(session.turns[0].workers, []);
});

test('getSession accepts the task id of a row with an empty context_id; unknown id is null', async (t) => {
  const db = await fixture(t, CHAIN);
  const session = getSession(db, 'old1');
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].leadTask.goal, 'legacy goal');
  assert.equal(getSession(db, 'nope'), null);
  assert.equal(getSession(db, ''), null);
});

test('formatLeadTask reports workers from the journal', async (t) => {
  const db = await fixture(t, CHAIN);
  journal(db, 't1', 'att-1', 'w1');
  const row = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get();
  const view = formatLeadTask(db, row);
  assert.equal(view.leadTask.goal, 'first goal');
  assert.equal(view.workers.length, 1);
  assert.equal(view.workers[0].role, 'reviewer');
});

test('deleteSession removes all turns and their journal rows in one go', async (t) => {
  const db = await fixture(t, CHAIN, [
    lead('w1', 'worker-context-1', DONE, 'worker result one', '2026-01-01T00:00:00.000Z'),
    lead('w3', 'worker-context-3', DONE, 'worker result three', '2026-01-03T00:00:00.000Z'),
  ]);
  new WriterAdmission({ db, workspace: '/tmp' });
  journal(db, 't1', 'att-1', 'w1');
  journal(db, 't3', 'att-3', 'w3');
  db.prepare(`INSERT INTO writer_executions
    (execution_id, workspace, role, task_id, context_id, state, created_at, updated_at)
    VALUES ('exec-released', '/workspace', 'builder', 'w1', 'worker-context-1', 'released', '2026-01-01', '2026-01-01')`).run();
  const deleted = deleteSession(db, 'ctx-a');
  assert.deepEqual(deleted, ['t1', 't2', 't3']);
  assert.equal(getSession(db, 'ctx-a'), null);
  assert.equal(db.prepare('SELECT count(*) AS c FROM dispatch_journal').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) AS c FROM writer_executions').get().c, 0);
  assert.deepEqual(listSessions(db).map((s) => s.contextId), ['ctx-b', 'old1']);
});

test('deleteSession refuses when a turn is not terminal and leaves everything intact', async (t) => {
  const tasks = [
    lead('t1', 'ctx-w', DONE, 'done turn', '2026-02-01T00:00:00.000Z'),
    lead('t2', 'ctx-w', TaskState.TASK_STATE_WORKING, 'active turn', '2026-02-02T00:00:00.000Z', ['t1']),
  ];
  const db = await fixture(t, tasks);
  journal(db, 't1', 'att-1', 'w1');
  assert.throws(() => deleteSession(db, 'ctx-w'), (err) => err instanceof SessionError && err.code === 'not_terminal');
  assert.equal(getSession(db, 'ctx-w').turns.length, 2);
  assert.equal(db.prepare('SELECT count(*) AS c FROM dispatch_journal').get().c, 1);
});

test('deleteSession refuses active or unresolved writer executions and preserves the entire session', async (t) => {
  for (const state of ['active', 'unresolved']) {
    await t.test(state, async (t) => {
      const db = await fixture(t, CHAIN, [lead('w3', 'worker-context', DONE, 'worker result', '2026-01-03T00:00:00.000Z')]);
      new WriterAdmission({ db, workspace: '/tmp' });
      journal(db, 't3', 'att-3', 'w3');
      db.prepare(`INSERT INTO writer_executions
        (execution_id, workspace, role, task_id, context_id, state, created_at, updated_at)
        VALUES ('exec-1', '/workspace', 'builder', 'w3', 'worker-context', ?, '2026-01-01', '2026-01-01')`)
        .run(state);

      assert.throws(
        () => deleteSession(db, 'ctx-a'),
        (err) => err instanceof SessionError && err.code === 'writer_execution_unresolved',
      );
      assert.deepEqual(getSession(db, 'ctx-a').turns.map((turn) => turn.leadTask.id), ['t1', 't2', 't3']);
      assert.equal(db.prepare('SELECT count(*) AS c FROM dispatch_journal').get().c, 1);
      assert.equal(db.prepare('SELECT state FROM writer_executions WHERE execution_id = ?').get('exec-1').state, state);
      assert.equal(db.prepare("SELECT count(*) AS c FROM tasks WHERE id = 'w3'").get().c, 1);
    });
  }
});

test('deleteLeadTask refuses to delete a run with a held writer execution', async (t) => {
  const db = await fixture(t, CHAIN, [lead('w1', 'worker-context', DONE, 'worker result', '2026-01-01T00:00:00.000Z')]);
  new WriterAdmission({ db, workspace: '/tmp' });
  journal(db, 't1', 'att-1', 'w1');
  db.prepare(`INSERT INTO writer_executions
    (execution_id, workspace, role, task_id, context_id, state, created_at, updated_at)
    VALUES ('exec-1', '/workspace', 'builder', 'w1', 'worker-context', 'active', '2026-01-01', '2026-01-01')`).run();

  assert.throws(
    () => deleteLeadTask(db, 't1'),
    (err) => err instanceof SessionError && err.code === 'writer_execution_unresolved',
  );
  assert.ok(db.prepare("SELECT id FROM tasks WHERE id = 't1'").get());
  assert.ok(db.prepare("SELECT id FROM tasks WHERE id = 'w1'").get());
  assert.equal(db.prepare('SELECT count(*) AS c FROM dispatch_journal').get().c, 1);
  assert.equal(db.prepare('SELECT state FROM writer_executions WHERE execution_id = ?').get('exec-1').state, 'active');
});

test('deleteSession on an unknown session throws not_found', async (t) => {
  const db = await fixture(t, CHAIN);
  assert.throws(() => deleteSession(db, 'nope'), (err) => err instanceof SessionError && err.code === 'not_found');
});

test('deleteLeadTask removes one task and its worker rows', async (t) => {
  const db = await fixture(t, CHAIN);
  journal(db, 't2', 'att-2', 'w2');
  deleteLeadTask(db, 't2');
  assert.deepEqual(getSession(db, 'ctx-a').turns.map((x) => x.leadTask.id), ['t1', 't3']);
  assert.equal(db.prepare('SELECT count(*) AS c FROM dispatch_journal').get().c, 0);
});

test('deleteLeadTask removes the run evidence and keeps another run', async (t) => {
  const db = await fixture(t, CHAIN);
  const { createEvidenceStore } = require('../src/evidence-store');
  const store = createEvidenceStore(db, { retentionDays: 30 });
  const put = (runId) => store.put({
    runId, kind: 'check_stdout', mediaType: 'text/plain; charset=utf-8',
    content: 'out', summary: 's', source: { producer: 'acceptance' },
  });
  put('t2');
  put('t2');
  const keep = put('t1');
  deleteLeadTask(db, 't2');
  assert.equal(store.listByRun('t2').length, 0);
  assert.deepEqual(store.listByRun('t1').map((r) => r.id), [keep.id]);
});
