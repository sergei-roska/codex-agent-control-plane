'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openStateDatabase } = require('../src/durable-store');
const { UsageLedger } = require('../src/usage-ledger');

const worker = (over = {}) => ({
  entryId: 'orch-builder:task-1',
  kind: 'worker_turn',
  role: 'orch-builder',
  taskId: 'task-1',
  contextId: 'ctx-1',
  model: 'm',
  effort: 'high',
  turns: 1,
  tokens: { inputTokens: 10, outputTokens: 5 },
  tokenSource: 'total_delta',
  outcome: 'completed',
  permissionEvents: [],
  ...over,
});

function journal(db, attemptId, runId, taskId) {
  db.prepare(`INSERT INTO dispatch_journal (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id,
    state, created_at, updated_at) VALUES (?, ?, ?, 'orch-builder', 'workspace-write', 'ctx', ?, 'finished', 'now', 'now')`)
    .run(attemptId, runId, `${attemptId}-a`, taskId);
}

test('record is insert-or-ignore and reports whether a row was inserted', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  assert.equal(ledger.record(worker()), true);
  assert.equal(ledger.record(worker({ turns: 9 })), false);
  const rows = ledger.listByTask('task-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turns, 1);
  await state.close();
});

test('unknown values stay null and are never coerced to 0', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  ledger.record({ entryId: 'r:t', kind: 'worker_turn', role: 'r', taskId: 't' });
  const [row] = ledger.listByTask('t');
  for (const key of ['tokens', 'cumulativeTotal', 'elapsedMs', 'turns', 'modelRequests', 'model', 'effort', 'retries', 'appServerVersion']) {
    assert.equal(row[key], null, key);
  }
  assert.deepEqual(row.permissionEvents, []);
  await state.close();
});

test('listByRun joins worker rows through the dispatch journal and adds lead rows', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  journal(state.db, 'att-1', 'run-1', 'task-1');
  journal(state.db, 'att-2', 'run-2', 'task-2');
  ledger.record(worker());
  ledger.record(worker({ entryId: 'orch-builder:task-2', taskId: 'task-2' }));
  ledger.record({ entryId: 'lead:th:tu', kind: 'lead_turn', runId: 'run-1', role: 'lead' });
  ledger.record({ entryId: 'lead:th:tu2', kind: 'lead_turn', runId: 'run-2', role: 'lead' });
  const rows = ledger.listByRun('run-1');
  assert.deepEqual(rows.map((row) => row.entryId).sort(), ['lead:th:tu', 'orch-builder:task-1']);
  const joined = rows.find((row) => row.kind === 'worker_turn');
  assert.equal(joined.attemptId, 'att-1');
  assert.equal(joined.runId, 'run-1');
  await state.close();
});

test('workerRowsForContext counts prior worker rows of the same context', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  assert.equal(ledger.workerRowsForContext('ctx-1'), 0);
  ledger.record(worker());
  ledger.record(worker({ entryId: 'orch-builder:task-2', taskId: 'task-2' }));
  ledger.record(worker({ entryId: 'orch-builder:task-3', taskId: 'task-3', contextId: 'other' }));
  assert.equal(ledger.workerRowsForContext('ctx-1'), 2);
  assert.equal(ledger.workerRowsForContext(null), 0);
  await state.close();
});

test('listByRun also joins worker rows by context when the journal task id is null or differs', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  const jr = (attempt, ctx, task) => state.db.prepare(`INSERT INTO dispatch_journal (attempt_id, run_id, assignment_id, role,
    sandbox, context_id, task_id, state, created_at, updated_at) VALUES (?, 'run-1', ?, 'orch-builder', 'workspace-write',
    ?, ?, 'unknown', 'now', 'now')`).run(attempt, `${attempt}-a`, ctx, task);
  jr('att-a', 'ctx-a', null); // lost submission, no task id recorded
  jr('att-b', 'ctx-b', 'task-other'); // journal task differs from the one that ran
  jr('att-c', 'ctx-c', 'task-c'); // matches by both keys: must not duplicate
  ledger.record(worker({ entryId: 'r:ta', taskId: 'ta', contextId: 'ctx-a' }));
  ledger.record(worker({ entryId: 'r:tb', taskId: 'tb', contextId: 'ctx-b' }));
  ledger.record(worker({ entryId: 'r:task-c', taskId: 'task-c', contextId: 'ctx-c' }));
  ledger.record(worker({ entryId: 'r:tz', taskId: 'tz', contextId: 'ctx-none' }));
  const ids = ledger.listByRun('run-1').map((row) => row.entryId).sort();
  assert.deepEqual(ids, ['r:ta', 'r:task-c', 'r:tb']);
  await state.close();
});

test('migrates an old usage_ledger table in place; old rows read the new fields as null', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE usage_ledger (
    entry_id TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, task_id TEXT, context_id TEXT,
    attempt_id TEXT, model TEXT, effort TEXT, started_at TEXT, elapsed_ms INTEGER, turns INTEGER, model_requests INTEGER,
    retries INTEGER, tokens_json TEXT, token_source TEXT, cumulative_total_json TEXT, app_server_version TEXT,
    outcome TEXT, permission_events_json TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO usage_ledger (entry_id, kind, role, task_id, permission_events_json, recorded_at) VALUES ('old', 'worker_turn', 'r', 'old-task', '[]', 'now')").run();
  const ledger = new UsageLedger({ db });
  const [old] = ledger.listByTask('old-task');
  assert.equal(old.entryId, 'old');
  assert.equal(old.startupMs, null);
  assert.equal(old.coldStart, null);
  assert.equal(old.queueWaitMs, null);
  ledger.record(worker({ entryId: 'new', taskId: 'new-task', startupMs: 5, coldStart: false, queueWaitMs: 7 }));
  const [fresh] = ledger.listByTask('new-task');
  assert.deepEqual([fresh.startupMs, fresh.coldStart, fresh.queueWaitMs], [5, false, 7]);
  // Re-opening an already migrated table is a no-op.
  new UsageLedger({ db });
  // A read-only handle on an un-migrated table can still read.
  const old2 = new Database(':memory:');
  old2.exec(`CREATE TABLE usage_ledger (entry_id TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, task_id TEXT,
    context_id TEXT, attempt_id TEXT, model TEXT, effort TEXT, started_at TEXT, elapsed_ms INTEGER, turns INTEGER, model_requests INTEGER,
    retries INTEGER, tokens_json TEXT, token_source TEXT, cumulative_total_json TEXT, app_server_version TEXT, outcome TEXT,
    permission_events_json TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
  old2.prepare("INSERT INTO usage_ledger (entry_id, kind, role, task_id, permission_events_json, recorded_at) VALUES ('o', 'worker_turn', 'r', 't', '[]', 'now')").run();
  assert.equal(new UsageLedger({ db: old2, readonly: true }).listByTask('t')[0].queueWaitMs, null);
});

test('listByTask fills attemptId and runId from the dispatch journal', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  journal(state.db, 'att-9', 'run-9', 'task-9');
  ledger.record(worker({ entryId: 'orch-builder:task-9', taskId: 'task-9' }));
  ledger.record(worker({ entryId: 'orch-builder:task-x', taskId: 'task-x' }));
  const [row] = ledger.listByTask('task-9');
  assert.equal(row.attemptId, 'att-9');
  assert.equal(row.runId, 'run-9');
  const [plain] = ledger.listByTask('task-x');
  assert.equal(plain.attemptId, null);
  assert.equal(plain.runId, null);
  await state.close();
});

test('listAll returns every row across tasks, oldest first', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  ledger.record(worker({ entryId: 'b', taskId: 'task-b', recordedAt: '2026-10-14T00:00:02.000Z' }));
  ledger.record(worker({ entryId: 'a', taskId: 'task-a', recordedAt: '2026-10-14T00:00:01.000Z' }));
  assert.deepEqual(ledger.listAll().map((row) => row.entryId), ['a', 'b']);
  await state.close();
});
