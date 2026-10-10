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

const LIVE_ACTIVITY_DDL = `CREATE TABLE IF NOT EXISTS live_activity (
  key TEXT PRIMARY KEY, run_id TEXT, role TEXT NOT NULL, started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, ended_at TEXT, phase TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  commands INTEGER NOT NULL DEFAULT 0, file_changes INTEGER NOT NULL DEFAULT 0)`;

test('activity is null and nothing fails when live_activity is absent', async (t) => {
  const db = await fixture(t, CHAIN);
  journal(db, 't1', 'att-1', 'w1');
  const view = getSession(db, 'ctx-a').turns[0];
  assert.equal(view.workers[0].activity, null);
  assert.equal(view.workers[0].created_at, '2026-01-01');
  assert.equal(view.leadActivity, null);
  deleteSession(db, 'ctx-a');
});

test('worker activity and leadActivity are mapped from live_activity; delete removes rows', async (t) => {
  const db = await fixture(t, CHAIN);
  db.exec(LIVE_ACTIVITY_DDL);
  journal(db, 't1', 'att-1', 'w1');
  journal(db, 't1', 'att-2', 'w2');
  const ins = db.prepare(`INSERT INTO live_activity
    (key, run_id, role, started_at, updated_at, ended_at, phase, summary, commands, file_changes)
    VALUES (?, 't1', ?, 's', 'u', ?, ?, ?, ?, ?)`);
  ins.run('w1', 'reviewer', null, 'command', 'npm test', 3, 1);
  ins.run('lead:t1', 'coordinator', null, 'thinking', '', 0, 0);
  ins.run('lead:t2', 'coordinator', 'e', 'done', '', 0, 0);
  const view = getSession(db, 'ctx-a').turns[0];
  assert.deepEqual(view.workers[0].activity, {
    phase: 'command', summary: 'npm test', startedAt: 's', updatedAt: 'u', endedAt: null, commands: 3, fileChanges: 1,
  });
  assert.equal(view.workers[1].activity, null);
  assert.equal(view.leadActivity.phase, 'thinking');
  assert.equal(getSession(db, 'ctx-a').turns[1].leadActivity.endedAt, 'e');
  deleteSession(db, 'ctx-a');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM live_activity').get().n, 0);
});

test('worker objective is extracted from the worker task first user message', async (t) => {
  const json = JSON.stringify({ role: 'explorer', objective: 'Map the exit gate', allowedFiles: [] });
  const db = await fixture(t, CHAIN, [
    lead('w1', 'wc-1', DONE, json, '2026-01-01T00:00:00.000Z'),
    lead('w2', 'wc-2', DONE, 'plain text assignment', '2026-01-01T00:00:00.000Z'),
  ]);
  journal(db, 't1', 'att-1', 'w1');
  journal(db, 't1', 'att-2', 'w2');
  journal(db, 't1', 'att-3', 'missing');
  journal(db, 't1', 'att-4', 'w1');
  db.prepare("UPDATE dispatch_journal SET state = 'submitted' WHERE attempt_id IN ('att-1','att-2','att-3')").run();
  const all = getSession(db, 'ctx-a').turns[0].workers;
  assert.equal(all[3].objective, null);
  const workers = all;
  assert.equal(workers[0].objective, 'Map the exit gate');
  assert.equal(workers[1].objective, 'plain text assignment');
  assert.equal(workers[2].objective, null);
});

const LANES_DDL = `CREATE TABLE writer_lanes (
  lane_id TEXT PRIMARY KEY, context_id TEXT, task_id TEXT, workspace TEXT, path TEXT, base_commit TEXT,
  state TEXT, reason TEXT, turn_start_json TEXT, execution_id TEXT, created_at TEXT, updated_at TEXT)`;
const laneRow = (db, id, taskId, state) => db.prepare(
  `INSERT INTO writer_lanes (lane_id, context_id, task_id, workspace, path, state, created_at, updated_at)
   VALUES (?, 'worker-context', ?, '/workspace', '/lanes/x', ?, '2026-01-01', '2026-01-01')`,
).run(id, taskId, state);

test('deleteLeadTask refuses while a writer lane of the run is not terminal', async (t) => {
  for (const state of ['preparing', 'prepared', 'running', 'integrating']) {
    await t.test(state, async (t) => {
      const db = await fixture(t, CHAIN, [lead('w1', 'worker-context', DONE, 'worker result', '2026-01-01T00:00:00.000Z')]);
      journal(db, 't1', 'att-1', 'w1');
      db.exec(LANES_DDL);
      laneRow(db, 'lane-1', 'w1', state);
      assert.throws(() => deleteLeadTask(db, 't1'), (err) => err instanceof SessionError && err.code === 'writer_lane_active');
      assert.ok(db.prepare("SELECT id FROM tasks WHERE id = 't1'").get());
      assert.ok(db.prepare("SELECT id FROM tasks WHERE id = 'w1'").get());
      assert.equal(db.prepare('SELECT count(*) AS c FROM dispatch_journal').get().c, 1);
    });
  }
});

test('deleteLeadTask ignores terminal lane rows and other runs lanes', async (t) => {
  const db = await fixture(t, CHAIN, [lead('w1', 'worker-context', DONE, 'worker result', '2026-01-01T00:00:00.000Z')]);
  journal(db, 't1', 'att-1', 'w1');
  db.exec(LANES_DDL);
  laneRow(db, 'lane-1', 'w1', 'integrated');
  laneRow(db, 'lane-2', 'w1', 'not_integrated');
  laneRow(db, 'lane-3', 'w1', 'orphaned');
  laneRow(db, 'lane-4', 'other-task', 'running');
  deleteLeadTask(db, 't1');
  assert.equal(db.prepare("SELECT count(*) AS c FROM tasks WHERE id = 't1'").get().c, 0);
});

test('deleteLeadTask without a writer_lanes table behaves as before', async (t) => {
  const db = await fixture(t, CHAIN, [lead('w1', 'worker-context', DONE, 'worker result', '2026-01-01T00:00:00.000Z')]);
  journal(db, 't1', 'att-1', 'w1');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'writer_lanes'").get(), undefined);
  deleteLeadTask(db, 't1');
  assert.equal(db.prepare("SELECT count(*) AS c FROM tasks WHERE id = 't1'").get().c, 0);
});
