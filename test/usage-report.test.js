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
