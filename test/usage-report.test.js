'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openStateDatabase } = require('../src/durable-store');
const { UsageLedger } = require('../src/usage-ledger');
const { buildReport, parseArgs } = require('../src/usage-report');

async function fixture() {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  const add = (n, over) => {
    state.db.prepare(`INSERT INTO dispatch_journal (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id,
      state, created_at, updated_at) VALUES (?, 'run-1', ?, 'orch-builder', 'workspace-write', 'c', ?, 'finished', 'n', 'n')`)
      .run(`att-${n}`, `asg-${n}`, `task-${n}`);
    ledger.record({
      entryId: `orch-builder:task-${n}`, kind: 'worker_turn', role: 'orch-builder', taskId: `task-${n}`, model: 'known',
      effort: 'high', turns: 1, elapsedMs: 100, retries: 0, tokenSource: 'total_delta', outcome: 'completed',
      tokens: { inputTokens: 1000000, cachedInputTokens: 400000, outputTokens: 500000, reasoningOutputTokens: 1, totalTokens: 1500000 },
      permissionEvents: [], ...over,
    });
  };
  add(1, {});
  add(2, { tokens: null, tokenSource: 'unavailable', model: 'mystery', outcome: 'failed',
    permissionEvents: [
      { type: 'hook', status: 'blocked' }, { type: 'tool', status: 'failed', denial: true },
      { type: 'hook', status: 'failed' }, { type: 'tool', status: 'failed', denial: false },
      { type: 'tool', status: 'declined' }, { type: 'approval_request_declined' },
      { type: 'approval_review', status: 'denied' }, { type: 'approval_review', status: 'approved' },
    ] });
  add(3, { model: 'mystery' });
  return state;
}

test('totals are partial when some rows have unknown tokens; cost stays null', async () => {
  const state = await fixture();
  const report = buildReport(state.db, { runId: 'run-1' });
  assert.deepEqual(report.measured, { basis: 'subscription', cost: null });
  assert.equal(report.totals.rows, 3);
  assert.equal(report.totals.tokensKnownRows, 2);
  assert.equal(report.totals.tokensUnknownRows, 1);
  assert.equal(report.totals.tokensPartial, true);
  assert.equal(report.totals.tokens.totalTokens, 3000000);
  assert.equal(report.totals.permissionDenials.total, 5);
  assert.deepEqual(report.totals.permissionDenials.byType, { hook: 1, tool: 2, approval_request_declined: 1, approval_review: 1 });
  assert.deepEqual(report.totals.outcomes, { completed: 2, failed: 1 });
  assert.equal(report.attempts.find((a) => a.taskId === 'task-2').tokens, null);
  assert.equal(report.repeatedAssignments, 0);
  assert.equal(report.hypotheticalApiCost, undefined);
  await state.close();
});

test('a price table adds a separate hypothetical section and lists unpriced models', async () => {
  const state = await fixture();
  const report = buildReport(state.db, {
    runId: 'run-1',
    priceTable: { known: { inputPerMTok: 2, cachedInputPerMTok: 1, outputPerMTok: 10 } },
  });
  assert.equal(report.measured.cost, null);
  const h = report.hypotheticalApiCost;
  assert.match(h.label, /hypothetical/);
  // (600k*2 + 400k*1 + 500k*10) / 1e6 = 6.6 for the one priced row
  assert.equal(Math.round(h.estimatedCost * 1e6) / 1e6, 6.6);
  assert.equal(h.pricedRows, 1);
  assert.deepEqual(h.unpricedModels, ['mystery']);
  assert.equal(h.skippedUnknownTokenRows, 1);
  assert.equal(h.partial, true);
  await state.close();
});

test('task scope and argument validation', async () => {
  const state = await fixture();
  assert.equal(buildReport(state.db, { taskId: 'task-1' }).totals.rows, 1);
  assert.throws(() => parseArgs([]), /exactly one/);
  assert.throws(() => parseArgs(['--run', 'a', '--task', 'b']), /exactly one/);
  assert.deepEqual(parseArgs(['--run', 'a', '--state', 'x']), { runId: 'a', state: 'x' });
  await state.close();
});

test('repeatedAssignments counts assignments sharing an objective hash recorded by the journal', async () => {
  const { DispatchJournal } = require('../src/durable-store');
  const state = await openStateDatabase({ filePath: ':memory:' });
  const journal = new DispatchJournal(state);
  const row = (n, hash) => ({
    attemptId: `run-2:r1:a${n}:t1`, runId: 'run-2', assignmentId: `run-2:r1:a${n}`, role: 'orch-builder', sandbox: 'workspace-write', contextId: `c${n}`, objectiveSha256: hash,
  });
  journal.recordSubmitting(row(0, 'same'));
  journal.recordSubmitting(row(1, 'same'));
  journal.recordSubmitting(row(2, 'other'));
  assert.equal(buildReport(state.db, { runId: 'run-2' }).repeatedAssignments, 2);
  assert.equal(buildReport(state.db, { runId: 'run-none' }).repeatedAssignments, 0);
  await state.close();
});

test('turns, elapsedMs and retries totals carry known/unknown counts and partial flags', async () => {
  const state = await fixture();
  const ledger = new UsageLedger({ db: state.db });
  state.db.prepare(`INSERT INTO dispatch_journal (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id,
    state, created_at, updated_at) VALUES ('att-9', 'run-1', 'asg-9', 'orch-builder', 'workspace-write', 'c', 'task-9', 'finished', 'n', 'n')`).run();
  ledger.record({ entryId: 'orch-builder:task-9', kind: 'worker_turn', role: 'orch-builder', taskId: 'task-9', outcome: 'failed' });
  const { totals } = buildReport(state.db, { runId: 'run-1' });
  assert.equal(totals.rows, 4);
  assert.equal(totals.turns, 3);
  assert.equal(totals.turnsKnownRows, 3);
  assert.equal(totals.turnsUnknownRows, 1);
  assert.equal(totals.turnsPartial, true);
  assert.equal(totals.elapsedMsPartial, true);
  assert.equal(totals.elapsedMsUnknownRows, 1);
  assert.equal(totals.retriesPartial, true);
  assert.equal(totals.retriesKnownRows, 3);
  const clean = buildReport(await fixture().then((s) => s.db), { runId: 'run-1' }).totals;
  assert.equal(clean.turnsPartial, false);
  assert.equal(clean.retriesUnknownRows, 0);
  await state.close();
});

test('attemptRow includes requested and reported fields from ledger', async () => {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  state.db.prepare(`INSERT INTO dispatch_journal (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id,
    state, created_at, updated_at) VALUES (?, 'run-3', ?, 'orch-builder', 'workspace-write', 'c', ?, 'finished', 'n', 'n')`)
    .run('att-a', 'asg-a', 'task-a');
  state.db.prepare(`INSERT INTO dispatch_journal (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id,
    state, created_at, updated_at) VALUES (?, 'run-3', ?, 'orch-builder', 'workspace-write', 'c', ?, 'finished', 'n', 'n')`)
    .run('att-b', 'asg-b', 'task-b');
  ledger.record({
    entryId: 'orch-builder:task-a', kind: 'worker_turn', role: 'orch-builder', taskId: 'task-a',
    requested: { foo: 'bar' }, reported: { baz: 'qux' },
    outcome: 'completed', permissionEvents: [],
  });
  ledger.record({
    entryId: 'orch-builder:task-b', kind: 'worker_turn', role: 'orch-builder', taskId: 'task-b',
    outcome: 'completed', permissionEvents: [],
  });
  const report = buildReport(state.db, { runId: 'run-3' });
  const attemptA = report.attempts.find((a) => a.taskId === 'task-a');
  const attemptB = report.attempts.find((a) => a.taskId === 'task-b');
  assert.deepEqual(attemptA.requested, { foo: 'bar' });
  assert.deepEqual(attemptA.reported, { baz: 'qux' });
  assert.equal(attemptB.requested, null);
  assert.equal(attemptB.reported, null);
  await state.close();
});

async function productFixture() {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const ledger = new UsageLedger({ db: state.db });
  state.db.exec(`CREATE TABLE runs (run_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, lead_task_id TEXT, created_at TEXT NOT NULL)`);
  const run = (id, lead) => state.db.prepare(`INSERT INTO runs (run_id, ticket_id, lead_task_id, created_at)
    VALUES (?, 'tkt-1', ?, ?)`)
    .run(id, lead, `t-${id}`);
  run('prun-1', 'lead-1');
  run('prun-2', 'lead-2');
  const tokens = (i, c, o) => ({ inputTokens: i, cachedInputTokens: c, outputTokens: o, totalTokens: i + o });
  const row = (entryId, kind, runIdValue, role, taskIdValue, t) => ledger.record({
    entryId, kind, runId: runIdValue, role, taskId: taskIdValue, turns: 1, elapsedMs: 10, tokens: t, permissionEvents: [],
  });
  row('i1', 'intake_turn', 'prun-1', 'dlv-project-manager', null, tokens(100, 40, 5));
  row('l1', 'lead_turn', 'lead-1', 'dlv-project-manager', 'lead-1', tokens(200, 80, 10));
  state.db.prepare(`INSERT INTO dispatch_journal (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id,
    state, created_at, updated_at) VALUES ('a1', 'lead-1', 'asg1', 'dlv-builder', 'workspace-write', 'c', 'w1', 'finished', 'n', 'n')`).run();
  row('w1', 'worker_turn', 'lead-1', 'dlv-builder', 'w1', tokens(300, 100, 20));
  row('i2', 'intake_turn', 'prun-2', 'dlv-project-manager', null, tokens(10, 0, 1));
  row('l2', 'lead_turn', 'lead-2', 'dlv-project-manager', 'lead-2', null);
  return state;
}

test('ticket id resolves to all product runs with intake, lead and worker rows', async () => {
  const state = await productFixture();
  const report = buildReport(state.db, { taskId: 'tkt-1', strict: true });
  assert.deepEqual(report.scope, { ticketId: 'tkt-1' });
  assert.equal(report.totals.rows, 5);
  assert.equal(report.totals.tokens.inputTokens, 610);
  assert.equal(report.totals.tokens.cachedInputTokens, 220);
  assert.equal(report.totals.tokens.outputTokens, 36);
  assert.equal(report.totals.tokensPartial, true);
  assert.deepEqual(Object.keys(report.byKind), ['intake_turn', 'lead_turn', 'worker_turn']);
  assert.equal(report.byKind.intake_turn.input, 110);
  assert.equal(report.byKind.lead_turn.input, 200);
  assert.equal(report.byKind.lead_turn.tokensPartial, true);
  assert.equal(report.byRoleKind['dlv-project-manager+intake_turn'].turns, 2);
  assert.equal(report.byRoleKind['dlv-builder+worker_turn'].output, 20);
  assert.equal(report.byRun['prun-1'].input, 600);
  assert.equal(report.byRun['prun-1'].leadTaskId, 'lead-1');
  assert.equal(report.byRun['prun-2'].input, 10);
  assert.equal(report.measured.cost, null);
  await state.close();
});

test('product run id resolves to its own rows; lead run id keeps working; unknown ids error in strict mode', async () => {
  const state = await productFixture();
  const product = buildReport(state.db, { runId: 'prun-1' });
  assert.deepEqual(product.scope, { runId: 'prun-1', ticketId: 'tkt-1' });
  assert.equal(product.totals.rows, 3);
  const lead = buildReport(state.db, { runId: 'lead-1', strict: true });
  assert.equal(lead.totals.rows, 2);
  assert.equal(lead.byRun, undefined);
  assert.throws(() => buildReport(state.db, { runId: 'nope', strict: true }), /Unknown run id/);
  assert.throws(() => buildReport(state.db, { taskId: 'nope', strict: true }), /Unknown ticket or task id/);
  assert.equal(buildReport(state.db, { taskId: 'w1', strict: true }).totals.rows, 1);
  await state.close();
});
