'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { EventJournal } = require('../src/event-journal');
const { cachedInputShare, monetaryCost, buildTicketActivity, unavailableActivity } = require('../src/ticket-telemetry');
const { hypotheticalCost } = require('../src/usage-report');
const { migrateProductSchema } = require('../src/product-migrations');
const { ProductStore } = require('../src/product-store');
const { createDashboardApi } = require('../src/dashboard-api');

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let clock = Date.parse('2026-10-01T10:00:00.000Z');
let cmdSeq = 0;
const cmd = () => `cmd-${String(++cmdSeq).padStart(6, '0')}`;
const base = (extra = {}) => ({ commandId: cmd(), title: 'Fix login', ...extra });

async function makeStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'state.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  await migrateProductSchema({ db, filePath: file });
  const store = new ProductStore({
    db, projectId: 'proj', now: () => new Date((clock += 1000)), ...options,
  });
  return { store, db, dir };
}

const SNAPSHOT = { provider: 'openai', rolePack: 'legacy-orch', promptVersions: { intake: 'pm-intake-v1', lead: 'pm-lead-v1' } };
const PLAN = {
  stages: [{ stageId: 'build', roleId: 'orch-builder', objective: 'Build', dependencies: [], allowedFiles: ['a.js'], required: true }],
  checkIds: ['unit'],
};

function submitNew(store, title = 'Work') {
  const created = store.createTicket(base({ title })).ticket;
  const out = store.submitTicket(created.ticketId, { commandId: cmd(), expectedVersion: created.version }, SNAPSHOT);
  return { ticketId: created.ticketId, runId: out.run.runId, out };
}

function toReview(store, runId) {
  assert.equal(store.acquireLease(runId).acquired, true);
  store.saveIntakePlan(runId, {
    turn: 1,
    output: {
      readiness: 'ready', questions: [], plan: PLAN,
      classification: 'feature',
      requirements: { summary: 's', scope: [], outOfScope: [], unknowns: [], expectedOutcomes: [] },
      unsupportedReason: null,
    },
    classification: 'feature', plan: PLAN,
    checks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 1000, description: '' }],
    requirements: { summary: 's', scope: [], outOfScope: [], unknowns: [], expectedOutcomes: [] },
    validatorVersion: 'm3-plan-v1',
  });
  store.recordBranch(runId, { branchName: 'feature/work-abcdef', baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, 'task-1', 'ctx-1');
  store.moveToCandidate(runId);
  return store.completeRun(runId, {
    candidate: {
      baseCommit: 'a'.repeat(40), head: 'a'.repeat(40), branch: 'feature/work-abcdef', headMoved: false,
      manifest: [{ path: 'a.js', status: 'M', sha256: 'f'.repeat(64), size: 3 }], truncated: false,
      acceptance: {
        disposition: 'accepted', reasons: [], checks: [{ id: 'unit', exitCode: 0, timedOut: false, durationMs: 5, outputTail: 'ok' }],
        stages: [{ stageId: 'build', status: 'succeeded', attemptIds: ['att-1'] }],
      },
      integrityHash: 'h'.repeat(64),
    },
    diffArtifact: { artifactId: 'art_diff', displayName: 'candidate.diff', size: 10, sha256: 'd'.repeat(64), storageRef: 'ref/art_diff' },
    outcome: 'review',
  });
}

// ---------- cachedInputShare tests ----------

test('cachedInputShare: ratio of sums, not average of percentages', () => {
  // (cached 1, input 2) and (cached 1, input 10) => share 2/12, not (0.5 + 0.1)/2
  const entries = [
    { tokens: { cachedInputTokens: 1, inputTokens: 2 } },
    { tokens: { cachedInputTokens: 1, inputTokens: 10 } },
  ];
  const result = cachedInputShare(entries);
  assert.equal(result.status, 'available');
  assert.ok(Math.abs(result.share - 2 / 12) < 1e-10, 'share should be 2/12');
  assert.equal(result.pairedRows, 2);
  assert.equal(result.unpairedRows, 0);
});

test('cachedInputShare: unavailable when no entries', () => {
  const result = cachedInputShare([]);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.share, null);
});

test('cachedInputShare: unavailable when all entries lack token data', () => {
  const entries = [{ tokens: null }, { tokens: undefined }, {}];
  const result = cachedInputShare(entries);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.share, null);
});

test('cachedInputShare: observed zero (paired rows, denominator > 0, numerator 0)', () => {
  const entries = [{ tokens: { cachedInputTokens: 0, inputTokens: 100 } }];
  const result = cachedInputShare(entries);
  assert.equal(result.status, 'available');
  assert.equal(result.share, 0);
});

test('cachedInputShare: denominator zero with paired rows yields unavailable', () => {
  // inputTokens 0 means denominator is 0 => unavailable even though rows are paired
  const entries = [{ tokens: { cachedInputTokens: 0, inputTokens: 0 } }];
  const result = cachedInputShare(entries);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.share, null);
  assert.equal(result.pairedRows, 1);
});

test('cachedInputShare: partial when some entries lack tokens, coverageNote present', () => {
  const entries = [
    { tokens: { cachedInputTokens: 1, inputTokens: 2 } },
    { tokens: null }, // unpaired
  ];
  const result = cachedInputShare(entries);
  assert.equal(result.status, 'partial');
  assert.equal(result.pairedRows, 1);
  assert.equal(result.unpairedRows, 1);
  assert.equal(result.totalRows, 2);
  assert.ok(typeof result.coverageNote === 'string', 'coverageNote should be present for partial');
  assert.ok(result.coverageNote.includes('does not represent the full run'), 'coverageNote should say not full run');
});

// ---------- monetaryCost tests ----------

test('monetaryCost: unavailable when no measuredCost field', () => {
  const entries = [
    { tokens: { inputTokens: 100, outputTokens: 50 } },
    { tokens: null },
  ];
  const result = monetaryCost(entries);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.amount, null);
});

test('monetaryCost: available when finite measuredCost exists', () => {
  const entries = [
    { measuredCost: 1.5 },
    { measuredCost: 0.5 },
  ];
  const result = monetaryCost(entries);
  assert.equal(result.status, 'available');
  assert.ok(Math.abs(result.amount - 2.0) < 1e-10);
  assert.equal(result.currency, 'USD');
});

test('monetaryCost: 0 is a real zero, not unavailable', () => {
  const entries = [{ measuredCost: 0 }];
  const result = monetaryCost(entries);
  assert.equal(result.status, 'available');
  assert.equal(result.amount, 0);
});

// ---------- hypothetical vs monetary separation ----------

test('hypotheticalCost separate from monetaryCost; measuredCost does not become hypothetical', () => {
  const entries = [
    { measuredCost: 5.0, tokens: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200 }, model: 'gpt-4o' },
  ];
  const mcost = monetaryCost(entries);
  assert.equal(mcost.status, 'available');
  assert.equal(mcost.amount, 5.0);

  const priceTable = { 'gpt-4o': { inputPerMTok: 5.0, outputPerMTok: 15.0, cachedInputPerMTok: 2.5 } };
  const hyp = hypotheticalCost(entries, priceTable);
  // hypothetical uses the priceTable formula, not measuredCost
  assert.ok(hyp.estimatedCost !== 5.0, 'hyp should not copy measuredCost');
  assert.ok(hyp.estimatedCost !== null, 'hyp should be computed when priceTable given');
  assert.ok(typeof hyp.label === 'string', 'hyp has a label');
  // monetary amount is not copied to hyp
  assert.ok(!('amount' in hyp), 'hyp has no amount field from monetary');
});

test('no priceTable => hypotheticalApiCost is null in buildTicketActivity', async () => {
  const { store, db } = await makeStore();
  const { ticketId } = submitNew(store);
  const events = new EventJournal({ db });
  events.ensureSchema();
  const result = buildTicketActivity({ productStore: store, events, ticketId });
  assert.equal(result.available, true);
  assert.equal(result.tokens.hypotheticalApiCost, null);
});

// ---------- empty ticket activity ----------

test('empty ticket (no runs): available true, sections empty/unavailable, amount null', async () => {
  const { store, db } = await makeStore();
  const created = store.createTicket(base({ title: 'Empty' })).ticket;
  const events = new EventJournal({ db });
  events.ensureSchema();
  const result = buildTicketActivity({ productStore: store, events, ticketId: created.ticketId });
  assert.equal(result.available, true);
  assert.equal(result.hiddenReasoning, false);
  assert.ok(result.note.includes('Hidden model reasoning is not available'));
  assert.equal(result.executions.length, 0);
  // No runs => no tokens
  assert.equal(result.tokens.status, 'unavailable');
  assert.equal(result.tokens.measured, null);
  assert.equal(result.tokens.monetaryCost, null);
  // runLog empty (no events)
  assert.ok(['empty', 'available'].includes(result.runLog.status));
  assert.equal(result.turns.status, 'empty');
  assert.equal(result.attempts.status, 'empty');
});

// ---------- review and rework binding ----------

test('review and rework bound to versioned run', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  toReview(store, runId);
  const ticket = store.getTicket(ticketId);
  const run = store.getRun(runId);

  // Record a corrections review to trigger a rework run
  const review = store.recordReview(ticketId, {
    commandId: cmd(), expectedVersion: ticket.version, runId, candidateId: run.candidateId,
    integrityHash: run.candidateId ? store.getCandidate(run.candidateId).integrityHash : 'h'.repeat(64),
    verdict: 'corrections', findings: 'Please fix the login form handling',
  });

  const ticket2 = store.getTicket(ticketId);
  const reworkRun = store.getRun(ticket2.currentRunId || store.listRuns(ticketId).find((r) => r.runKind === 'rework' && r.runId !== runId).runId);
  assert.ok(reworkRun, 'rework run should exist');
  assert.equal(reworkRun.parentRunId, runId);

  const events = new EventJournal({ db });
  events.ensureSchema();
  const result = buildTicketActivity({ productStore: store, events, ticketId });

  const originalExec = result.executions.find((e) => e.runId === runId);
  const reworkExec = result.executions.find((e) => e.runId === reworkRun.runId);

  assert.ok(originalExec, 'original execution should be present');
  assert.ok(reworkExec, 'rework execution should be present');

  // Original execution has a review with the candidateId
  assert.ok(originalExec.review, 'original exec should have review');
  assert.equal(originalExec.review.candidateId, run.candidateId);
  assert.equal(originalExec.revisionId, run.revisionId);

  // Rework execution binds back to original via rework.reviewId and parentRunId
  assert.ok(reworkExec.rework, 'rework exec should have rework field');
  assert.equal(reworkExec.rework.parentRunId, runId, 'rework.parentRunId should be original run');
  // The rework run has reworkReviewId pointing to the review
  assert.ok(reworkExec.rework.reviewId, 'rework.reviewId should be set');
  assert.equal(reworkExec.parentRunId, runId);
});

// ---------- redaction ----------

test('historical run_error message is redacted when ticket activity is read', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const events = new EventJournal({ db });
  events.ensureSchema();
  db.prepare(`INSERT INTO runtime_events
    (event_id, occurred_at, type, run_id, payload_json, ticket_id)
    VALUES (?, ?, 'run_error', ?, ?, ?)`).run(
    'evt-hist-leak',
    '2026-10-01T10:00:00.000Z',
    runId,
    JSON.stringify({ message: 'connect failed password=secret token=abc' }),
    ticketId,
  );

  const result = buildTicketActivity({ productStore: store, events, ticketId });
  const json = JSON.stringify(result.runLog);
  assert.equal(json.includes('password=secret'), false);
  assert.equal(json.includes('token=abc'), false);
  assert.equal(json.includes('[REDACTED]'), true);

  const stored = db.prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?').get('evt-hist-leak');
  assert.equal(stored.payload_json.includes('password=secret'), true);
});

test('ticket activity pages more than 500 events with a truthful continuation state', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const events = new EventJournal({ db });
  events.ensureSchema();
  for (let i = 0; i < 620; i += 1) {
    events.record('run_queued', { ticketId, runId: 'task-1', payload: { ordinal: i } });
  }
  const activityStore = Object.assign(Object.create(store), {
    listRuns: () => [{ runId }],
    getRun: () => Object.assign({}, store.getRun(runId), { leadTaskId: 'task-1' }),
  });

  let after = 0;
  const sequences = [];
  let firstPage;
  do {
    const page = buildTicketActivity({ productStore: activityStore, events, ticketId, after, limit: 100 });
    if (!firstPage) firstPage = page.runLog;
    assert.ok(page.runLog.entries.length <= 100, 'each response page stays bounded');
    sequences.push(...page.runLog.entries.map((entry) => entry.sequence));
    after = page.runLog.nextAfter;
    if (!page.runLog.hasMore) break;
  } while (sequences.length < 700);

  assert.equal(firstPage.status, 'partial');
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.entries.length, 100);
  assert.equal(sequences.length, 620);
  assert.equal(new Set(sequences).size, 620, 'ticket and run streams are deduplicated by sequence');
  assert.equal(sequences.at(-1), events.lastSequence(), 'the final cursor page includes events after the old 500 row cutoff');

  const ui = fs.readFileSync(path.join(__dirname, '../web/dashboard/js/modals/ticket-run.js'), 'utf8');
  assert.match(ui, /More run log events are available\. The events shown are a partial view\./);
  assert.match(ui, /Load more events/);
});

test('Run Log preserves the continuation and exposes retry when a page is unavailable', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../web/dashboard/js/modals/ticket-run.js'), 'utf8');
  assert.match(ui, /res\.available === false \|\| \(pageLog && pageLog\.status === 'unavailable'\)/);
  assert.match(ui, /if \(trr\.activity !== activity \|\| trr\.activity\.ticketId !== ticketId\) return;/,
    'a stale page response cannot mutate a newly selected activity object');
  assert.match(ui, /activity\.loadMoreError = \(pageLog && pageLog\.reason\) \|\| \(res && res\.reason\) \|\| 'Activity unavailable'/);
  assert.match(ui, /activity\.loadMoreError \? 'Retry loading events' : 'Load more events'/);
});

test('findings with sk- secret are redacted', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  toReview(store, runId);
  const ticket = store.getTicket(ticketId);
  const run = store.getRun(runId);
  const candidate = store.getCandidate(run.candidateId);

  // Insert a leaky review directly
  db.prepare(
    'INSERT INTO reviews (review_id, ticket_id, run_id, revision_id, plan_revision_id, candidate_id, integrity_hash, verdict, findings, actor, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('rvw_leak', ticketId, runId, run.revisionId, run.planRevisionId, candidate.candidateId, candidate.integrityHash,
    'corrections', 'model sk-LEAKME99abcd said no', 'operator', cmd(), new Date().toISOString());

  const events = new EventJournal({ db });
  events.ensureSchema();
  const result = buildTicketActivity({ productStore: store, events, ticketId });
  const json = JSON.stringify(result);
  assert.equal(json.includes('LEAKME99'), false, 'sk- key should be redacted');
  assert.ok(json.includes('REDACTED'), 'should include redaction marker');
});

// ---------- error resilience ----------

test('throwing listRuns returns available:false and does not throw', () => {
  const badStore = {
    listRuns() { throw new Error('disk exploded'); },
    getRun() { return null; },
    db: new Database(':memory:'),
  };
  const events = { listByTicket: () => [], listByRun: () => [] };
  let result;
  assert.doesNotThrow(() => {
    result = buildTicketActivity({ productStore: badStore, events, ticketId: 'tkt_x' });
  });
  assert.equal(result.available, false);
  assert.ok(result.reason.includes('disk exploded'));
});

test('usage read failure returns section unavailable, overall available:true', async () => {
  const { store, db } = await makeStore();
  const { ticketId } = submitNew(store);
  const badDb = Object.create(db);
  badDb.prepare = function(sql) {
    if (sql.includes('usage_ledger')) throw new Error('usage broken');
    return db.prepare(sql);
  };
  const badStore = Object.assign(Object.create(store), { db: badDb });
  const events = new EventJournal({ db });
  events.ensureSchema();
  // This should not throw and should return partial availability
  let result;
  assert.doesNotThrow(() => {
    result = buildTicketActivity({ productStore: badStore, events, ticketId });
  });
  assert.equal(result.available, true);
  assert.equal(result.tokens.status, 'unavailable');
});

// ---------- HTTP endpoint tests ----------

test('GET /tickets/:id/activity returns 200 for empty ticket', async (t) => {
  const { store, db } = await makeStore();
  const created = store.createTicket(base({ title: 'Empty HTTP' })).ticket;
  const events = new EventJournal({ db });
  events.ensureSchema();
  const app = express();
  app.use(createDashboardApi({
    projection: { listCards: () => ({ cards: [] }) },
    events,
    projectId: 'prj_test',
    productStore: store,
    artifactStore: {},
    auth: { originGuard: (req, res, next) => next() },
    workspace: process.cwd(),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) {} resolve(); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/tickets/${created.ticketId}/activity`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.executions.length, 0);
});

test('GET /tickets/:id/activity returns 200 with available:false when store throws', async (t) => {
  const { db } = await makeStore();
  const events = new EventJournal({ db });
  events.ensureSchema();
  const throwingStore = {
    getTicket: () => ({ ticketId: 'tkt_fake', version: 1, status: 'backlog', currentRevisionId: 'rev_1' }),
    listRuns() { throw new Error('store exploded mid-activity'); },
    getRun() { return null; },
    db,
  };
  const app = express();
  app.use(createDashboardApi({
    projection: { listCards: () => ({ cards: [] }) },
    events,
    projectId: 'prj_test',
    productStore: throwingStore,
    artifactStore: {},
    auth: { originGuard: (req, res, next) => next() },
    workspace: process.cwd(),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) {} resolve(); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/tickets/tkt_fake/activity`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.ok(body.reason);
});

test('GET /tickets/unknown/activity returns 404', async (t) => {
  const { store, db } = await makeStore();
  const events = new EventJournal({ db });
  events.ensureSchema();
  const app = express();
  app.use(createDashboardApi({
    projection: { listCards: () => ({ cards: [] }) },
    events,
    projectId: 'prj_test',
    productStore: store,
    artifactStore: {},
    auth: { originGuard: (req, res, next) => next() },
    workspace: process.cwd(),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) {} resolve(); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/tickets/tkt_nonexistent/activity`);
  assert.equal(res.status, 404);
});
