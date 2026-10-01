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

test('requested and reported settings round trip and default to null', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  const requested = { model: 'm', effort: 'high', serviceTier: 'fast' };
  const reported = { model: 'm2', reasoningEffort: 'high', serviceTier: null };
  ledger.record(worker({ entryId: 'e1', taskId: 't-set', requested, reported }));
  ledger.record(worker({ entryId: 'e2', taskId: 't-none' }));
  const [set] = ledger.listByTask('t-set');
  assert.deepEqual(set.requested, requested);
  assert.deepEqual(set.reported, reported);
  const [none] = ledger.listByTask('t-none');
  assert.equal(none.requested, null);
  assert.equal(none.reported, null);
  await state.close();
});

test('the settings columns are added idempotently to an older ledger table', async () => {
  const Database = require('better-sqlite3');
  const { createUsageLedgerTable } = require('../src/usage-ledger');
  const db = new Database(':memory:');
  createUsageLedgerTable(db);
  db.exec('ALTER TABLE usage_ledger DROP COLUMN requested_json');
  db.exec('ALTER TABLE usage_ledger DROP COLUMN reported_json');
  createUsageLedgerTable(db);
  createUsageLedgerTable(db);
  const names = db.prepare('PRAGMA table_info(usage_ledger)').all().map((c) => c.name);
  assert.equal(names.filter((n) => n === 'requested_json').length, 1);
  assert.ok(names.includes('reported_json'));
  db.close();
});
