'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');
const { emptyCheckpoint } = require('@langchain/langgraph-checkpoint');
const { createTaskStore, openStateDatabase } = require('../src/durable-store');
const { buildSituation, ownerPausedLead, gitStatus, phaseOf, nodeOf, nextStepsOf, parsePorcelain, parseShortstat } = require('../src/session-situation');

// The store takes SDK enum values and keeps the state names, which is what the projection reads.
const DONE = TaskState.TASK_STATE_COMPLETED;
const WORKING = TaskState.TASK_STATE_WORKING;
const INPUT = TaskState.TASK_STATE_INPUT_REQUIRED;
const NAME = { [DONE]: 'TASK_STATE_COMPLETED', [WORKING]: 'TASK_STATE_WORKING', [INPUT]: 'TASK_STATE_INPUT_REQUIRED' };
const DONE_NAME = NAME[DONE];

function leadTask(id, state, updated, contextId) {
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
      parts: [{ content: { $case: 'text', value: 'goal of ' + id }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      extensions: [],
      referenceTaskIds: [],
    }],
    metadata: {},
  };
}

const REPORT = (summary, filesChanged) => JSON.stringify({
  outcome: 'completed', summary, filesChanged, filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null,
});

// A checkpoint in the saver's own format: channel values, channel versions and a timestamp.
function checkpoint(n, values, versions, ts) {
  return { ...emptyCheckpoint(), id: `ck-${String(n).padStart(4, '0')}`, ts, channel_values: values, channel_versions: versions };
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-situation-'));
  const state = await openStateDatabase({ filePath: path.join(dir, 'state.sqlite') });
  t.after(() => state.close().then(() => fs.rmSync(dir, { recursive: true, force: true })));
  const store = createTaskStore(state, 'orchestrator');
  const tasks = [
    // ctx-run: an older finished turn, then a running turn with a checkpoint mid-batch.
    leadTask('run-0', DONE, '2026-03-01T09:00:00.000Z', 'ctx-run'),
    leadTask('run-1', WORKING, '2026-03-02T10:00:00.000Z', 'ctx-run'),
    leadTask('done-1', DONE, '2026-03-03T10:00:00.000Z', 'ctx-done'),
    leadTask('pause-1', INPUT, '2026-03-04T10:00:00.000Z', 'ctx-pause'),
    leadTask('owner-1', INPUT, '2026-03-05T10:00:00.000Z', 'ctx-owner'),
    leadTask('bare-1', WORKING, '2026-03-06T10:00:00.000Z', 'ctx-bare'),
    // PAUSE-01: parked on an owner pause at the gate node and at decide; a restart pause is not one.
    { ...leadTask('park-gate', INPUT, '2026-03-07T10:00:00.000Z', 'ctx-park-gate'), metadata: { pause: { kind: 'owner_pause', message: 'Paused by the owner' } } },
    { ...leadTask('park-decide', INPUT, '2026-03-08T10:00:00.000Z', 'ctx-park-decide'), metadata: { pause: { kind: 'owner_pause', message: 'Paused by the owner' } } },
    { ...leadTask('park-stopped', INPUT, '2026-03-10T10:00:00.000Z', 'ctx-park-stopped'), metadata: { pause: { kind: 'stopped', message: 'Stopped by the owner' } } },
    { ...leadTask('park-restart', INPUT, '2026-03-09T10:00:00.000Z', 'ctx-park-restart'), metadata: { pause: { kind: 'restart' } } },
    { ...leadTask('system-run', WORKING, '2026-03-11T10:00:00.000Z', 'ctx-system-run') },
    { ...leadTask('system-wait', INPUT, '2026-03-12T10:00:00.000Z', 'ctx-system-wait'), metadata: { pause: { kind: 'system_repair' } } },
    { ...leadTask('system-owner', INPUT, '2026-03-13T10:00:00.000Z', 'ctx-system-owner'), metadata: { pause: { kind: 'owner_pause', message: 'Paused by the owner' } } },
  ];
  for (const task of tasks) await store.save(task, new ServerCallContext());
  state.db.exec(`CREATE TABLE IF NOT EXISTS live_activity (
    key TEXT PRIMARY KEY, run_id TEXT, role TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    ended_at TEXT, phase TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', commands INTEGER NOT NULL DEFAULT 0,
    file_changes INTEGER NOT NULL DEFAULT 0)`);
  const live = state.db.prepare(`INSERT INTO live_activity (key, run_id, role, started_at, updated_at, ended_at, phase)
    VALUES (?, NULL, 'engineer', ?, ?, ?, 'done')`);
  live.run('w-1', '2026-03-02T10:01:00.000Z', '2026-03-02T10:05:00.000Z', '2026-03-02T10:05:00.000Z');
  live.run('w-2', '2026-03-02T10:02:00.000Z', '2026-03-02T10:03:00.000Z', '2026-03-02T10:03:00.000Z');
  live.run('w-3', '2026-03-02T10:04:00.000Z', '2026-03-02T10:06:00.000Z', null);
  live.run('wd-3', '2026-03-03T10:20:00.000Z', '2026-03-03T10:25:00.000Z', '2026-03-03T10:25:00.000Z');
  state.db.prepare(`INSERT INTO live_activity (key, run_id, role, started_at, updated_at, ended_at, phase)
    VALUES ('lead:run-1', 'run-1', 'coordinator', '2026-03-02T10:00:30.000Z', '2026-03-02T10:06:30.000Z', NULL, 'working')`).run();

  state.db.exec(`CREATE TABLE IF NOT EXISTS writer_executions (
    execution_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, role TEXT NOT NULL, task_id TEXT NOT NULL,
    context_id TEXT NOT NULL, state TEXT NOT NULL, delta_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const writer = state.db.prepare(`INSERT INTO writer_executions
    (execution_id, workspace, role, task_id, context_id, state, delta_json, created_at, updated_at)
    VALUES (?, '/w', 'engineer', ?, 'c', 'released', ?, '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z')`);
  // The engine measured w-1 (known) and w-2 (not known: its path list must not be used).
  writer.run('x-1', 'w-1', JSON.stringify({ known: true, headChanged: false, changedPaths: ['src/parser.js'] }));
  writer.run('x-2', 'w-2', JSON.stringify({ known: false, headChanged: false, changedPaths: ['ignored.txt'] }));
  writer.run('x-3', 'wd-3', JSON.stringify({ known: true, headChanged: false, changedPaths: ['tests/measured.py'] }));

  const saver = new SqliteSaver(state.db);
  const put = (threadId, cp, step) => saver.put({ configurable: { thread_id: threadId, checkpoint_ns: '' } }, cp, { source: 'loop', step, parents: {} });
  // run-1: the latest checkpoint has collect scheduled (highest branch version).
  await put('run-1', checkpoint(1, { round: 1 }, { 'branch:to:decide': 1 }, '2026-03-02T10:00:31.000Z'), 1);
  const progress = Array.from({ length: 12 }, (_, i) => ({ round: 2, kind: 'integrated_change', detail: `a${i}` }));
  await put('run-1', checkpoint(2, {
    round: 2,
    budget: { source: 'worker' },
    openDecisions: [{ id: 'att-9', role: 'architect', assignmentId: 'run-1:r2:a4', request: { question: 'Keep the v1 API?', options: [] } }],
    progress,
    batch: {
      round: 2,
      parallel: true,
      items: [
        { assignmentId: 'run-1:r2:a0', role: 'engineer', state: 'finished', taskId: 'w-1', assignment: { objective: 'Fix the parser' },
          result: { status: NAME[DONE], artifacts: [{ text: REPORT('Parser fixed', ['src/parser.js', 'test/parser.test.js']) }] } },
        { assignmentId: 'run-1:r2:a1', role: 'auditor', state: 'finished', taskId: 'w-2', assignment: { objective: 'Audit the change' },
          result: { status: 'TASK_STATE_FAILED', text: '' } },
        { assignmentId: 'run-1:r2:a2', role: 'explorer', state: 'submitted', taskId: 'w-3', assignment: { objective: 'Map the docs' }, result: null },
        { assignmentId: 'run-1:r2:a3', role: 'verifier', state: 'pending', taskId: null, assignment: { objective: 'Verify it' }, result: null },
      ],
    },
  }, { 'branch:to:decide': 1, 'branch:to:dispatch': 2, 'branch:to:collect': 3 }, '2026-03-02T10:06:30.000Z'), 2);

  await put('done-1', checkpoint(1, {
    round: 3,
    status: 'completed',
    text: 'Everything is in.',
    batch: null,
    outcomes: [
      { assignmentId: 'done-1:r2:a0', taskId: 'wd-1', role: 'engineer', status: DONE_NAME, report: { summary: 'Old round', filesChanged: ['old.js'] } },
      { assignmentId: 'done-1:r3:a0', taskId: 'wd-2', role: 'auditor', status: 'TASK_STATE_FAILED', report: null },
      { assignmentId: 'done-1:r3:a1', taskId: 'wd-3', role: 'verifier', status: DONE_NAME, report: { summary: 'Verified', filesChanged: ['tests/x.py'] } },
      { assignmentId: 'done-1:r3:a2:c1', taskId: 'wd-4', role: 'engineer', status: DONE_NAME, report: { summary: 'Continued', filesChanged: ['c.py'] } },
      { kind: 'reconciliation', assignmentId: 'done-1:r3:a3', taskId: 'wd-5', role: 'engineer', status: DONE_NAME, report: null },
      { elided: true, assignmentId: 'done-1:r3:a4', taskId: 'wd-6', role: 'engineer', status: DONE_NAME },
    ],
    acceptance: { disposition: 'accepted', checks: [{ id: 'unit', result: 'PASS', durationMs: 5 }] },
    result: { status: 'completed', text: 'Shipped the parser.\n\nNext work: write the migration notes.' },
  }, { 'branch:to:finish': 9 }, '2026-03-03T10:30:00.000Z'), 1);

  await put('pause-1', checkpoint(1, { round: 1, budget: { source: 'lead' } }, { 'branch:to:budget_pause': 4 }, '2026-03-04T10:10:00.000Z'), 1);
  await put('park-gate', checkpoint(1, { round: 1 }, { 'branch:to:owner_pause': 6 }, '2026-03-07T10:10:00.000Z'), 1);
  await put('park-decide', checkpoint(1, { round: 2 }, { 'branch:to:decide': 7 }, '2026-03-08T10:10:00.000Z'), 1);
  await put('park-stopped', checkpoint(1, { round: 2, status: 'canceled' }, { 'branch:to:finish': 8 }, '2026-03-10T10:10:00.000Z'), 1);
  await put('park-restart', checkpoint(1, { round: 2 }, { 'branch:to:decide': 7 }, '2026-03-09T10:10:00.000Z'), 1);
  const systemRequest = {
    requestId: 'run-system:system:1', incidentId: 'control-plane-incident', status: 'pending', attempts: 0,
    lastResult: null,
  };
  await put('system-run', checkpoint(1, { round: 2, systemRequest }, { 'branch:to:system_repair': 8 }, '2026-03-11T10:10:00.000Z'), 1);
  await put('system-wait', checkpoint(1, {
    round: 2,
    systemRequest: { ...systemRequest, status: 'unavailable', attempts: 1, lastResult: { status: 'unavailable', reason: 'system_repair_service_unavailable' } },
    systemResults: [{ requestId: systemRequest.requestId, incidentId: systemRequest.incidentId, status: 'unavailable' }],
  }, { 'branch:to:system_pause': 9 }, '2026-03-12T10:10:00.000Z'), 1);
  await put('system-owner', checkpoint(1, { round: 2, systemRequest }, { 'branch:to:owner_pause': 10 }, '2026-03-13T10:10:00.000Z'), 1);
  await put('owner-1', checkpoint(1, { round: 1 }, { 'branch:to:human_input': 5 }, '2026-03-05T10:10:00.000Z'), 1);
  return state.db;
}

test('phaseOf maps terminal states, input pauses, and graph nodes; unknown combinations are null', () => {
  assert.equal(phaseOf('TASK_STATE_COMPLETED', 'finish'), 'done');
  assert.equal(phaseOf('TASK_STATE_FAILED', 'collect'), 'failed');
  assert.equal(phaseOf('TASK_STATE_REJECTED', null), 'failed');
  assert.equal(phaseOf('TASK_STATE_CANCELED', null), 'canceled');
  assert.equal(phaseOf('TASK_STATE_INPUT_REQUIRED', 'budget_pause'), 'budget_pause');
  assert.equal(phaseOf('TASK_STATE_WORKING', 'system_repair'), 'system_repair');
  assert.equal(phaseOf('TASK_STATE_INPUT_REQUIRED', 'system_pause'), 'system_wait');
  assert.equal(phaseOf('TASK_STATE_INPUT_REQUIRED', 'human_input'), 'waiting_owner');
  assert.equal(phaseOf('TASK_STATE_INPUT_REQUIRED', null), 'waiting_owner');
  assert.equal(phaseOf('TASK_STATE_WORKING', 'intake'), 'planning');
  assert.equal(phaseOf('TASK_STATE_WORKING', 'decide'), 'planning');
  assert.equal(phaseOf('TASK_STATE_WORKING', 'dispatch'), 'working');
  assert.equal(phaseOf('TASK_STATE_WORKING', 'collect'), 'working');
  assert.equal(phaseOf('TASK_STATE_WORKING', 'continue_limited'), 'working');
  for (const node of ['verify', 'review_check', 'reconcile', 'accept']) assert.equal(phaseOf('TASK_STATE_WORKING', node), 'verifying', node);
  assert.equal(phaseOf('TASK_STATE_WORKING', null), null);
  assert.equal(phaseOf('TASK_STATE_WORKING', 'unknown_node'), null);
});

test('nodeOf picks the highest branch version; nextStepsOf reads the next-work paragraph', () => {
  assert.equal(nodeOf({ 'branch:to:decide': 1, 'branch:to:dispatch': 7, 'branch:to:collect': 3, round: 9 }), 'dispatch');
  assert.equal(nodeOf({ round: 2 }), null);
  assert.equal(nextStepsOf('Done.\n\nNext work: ship it.\n\nThanks'), 'Next work: ship it.');
  assert.equal(nextStepsOf('Done. Remaining work: a and b.'), null);
  assert.equal(nextStepsOf('Intro\n\nRemaining work: a.'), 'Remaining work: a.');
  assert.equal(nextStepsOf(undefined), null);
  assert.equal(nextStepsOf('Follow-ups: x'), 'Follow-ups: x');
});

test('a running session projects the batch, decisions, progress and timestamps from its checkpoint', async (t) => {
  const db = await fixture(t);
  const s = await buildSituation(db, 'ctx-run');
  assert.deepEqual(Object.keys(s), ['contextId', 'leadTaskId', 'state', 'node', 'phase', 'pauseKind', 'systemRepair', 'round', 'budget', 'startedAt', 'updatedAt',
    'batch', 'openDecisions', 'progress', 'acceptance', 'nextSteps']);
  assert.equal(s.contextId, 'ctx-run');
  assert.equal(s.leadTaskId, 'run-1');
  assert.equal(s.state, NAME[WORKING]);
  assert.equal(s.node, 'collect');
  assert.equal(s.phase, 'working');
  assert.equal(s.round, 2);
  assert.deepEqual(s.budget, { source: 'worker' });
  assert.equal(s.startedAt, '2026-03-02T10:00:30.000Z');
  assert.equal(s.updatedAt, '2026-03-02T10:06:30.000Z');
  assert.deepEqual(s.batch, [
    // Engine-measured files (writer execution known) replace the self-reported filesChanged.
    { assignmentId: 'run-1:r2:a0', role: 'engineer', objective: 'Fix the parser', state: 'done', summary: 'Parser fixed',
      filesChanged: ['src/parser.js'], startedAt: '2026-03-02T10:01:00.000Z', finishedAt: '2026-03-02T10:05:00.000Z' },
    // A writer execution that is not known (known false) falls back to the report, here none.
    { assignmentId: 'run-1:r2:a1', role: 'auditor', objective: 'Audit the change', state: 'failed', summary: null,
      filesChanged: [], startedAt: '2026-03-02T10:02:00.000Z', finishedAt: '2026-03-02T10:03:00.000Z' },
    { assignmentId: 'run-1:r2:a2', role: 'explorer', objective: 'Map the docs', state: 'running', summary: null,
      filesChanged: [], startedAt: '2026-03-02T10:04:00.000Z', finishedAt: null },
    { assignmentId: 'run-1:r2:a3', role: 'verifier', objective: 'Verify it', state: 'pending', summary: null,
      filesChanged: [], startedAt: null, finishedAt: null },
  ]);
  assert.deepEqual(s.openDecisions, [{ id: 'att-9', summary: 'Keep the v1 API?' }]);
  assert.equal(s.progress.length, 10, 'only the last 10 progress entries');
  assert.deepEqual(s.progress[0], { at: null, text: 'Integrated change (round 2): a2' });
  assert.equal(s.progress[9].text, 'Integrated change (round 2): a11');
  assert.equal(s.acceptance, null);
  assert.equal(s.nextSteps, null, 'nextSteps only for a done session');
});

test('a finished session gives acceptance checks and nextSteps; the older turn is not the latest', async (t) => {
  const db = await fixture(t);
  const s = await buildSituation(db, 'ctx-done');
  assert.equal(s.phase, 'done');
  assert.equal(s.node, 'finish');
  assert.equal(s.round, 3);
  // The batch is closed: the last round's worker outcomes stand in for "done this turn".
  assert.deepEqual(s.batch, [
    { assignmentId: 'done-1:r3:a0', role: 'auditor', objective: null, state: 'failed', summary: null,
      filesChanged: [], startedAt: null, finishedAt: null },
    { assignmentId: 'done-1:r3:a1', role: 'verifier', objective: null, state: 'done', summary: 'Verified',
      filesChanged: ['tests/measured.py'], startedAt: '2026-03-03T10:20:00.000Z', finishedAt: '2026-03-03T10:25:00.000Z' },
    { assignmentId: 'done-1:r3:a2:c1', role: 'engineer', objective: null, state: 'done', summary: 'Continued',
      filesChanged: ['c.py'], startedAt: null, finishedAt: null },
  ]);
  assert.deepEqual(s.acceptance, { status: 'accepted', checks: [{ name: 'unit', status: 'PASS' }] });
  assert.equal(s.nextSteps, 'Next work: write the migration notes.');
  // No live row: startedAt falls back to the first checkpoint, updatedAt to the latest one (the only one here).
  assert.equal(s.startedAt, '2026-03-03T10:30:00.000Z');
  assert.equal(s.updatedAt, '2026-03-03T10:30:00.000Z');
  const older = await buildSituation(db, 'ctx-run');
  assert.equal(older.leadTaskId, 'run-1');
});

test('a closed batch without outcomes gives an empty batch', async (t) => {
  const db = await fixture(t);
  // pause-1 has no outcomes and no batch: nothing to show.
  assert.deepEqual((await buildSituation(db, 'ctx-pause')).batch, []);
});

test('a budget pause and a human request are waiting phases', async (t) => {
  const db = await fixture(t);
  const pause = await buildSituation(db, 'ctx-pause');
  assert.equal(pause.state, NAME[INPUT]);
  assert.equal(pause.node, 'budget_pause');
  assert.equal(pause.phase, 'budget_pause');
  assert.deepEqual(pause.budget, { source: 'lead' });
  const owner = await buildSituation(db, 'ctx-owner');
  assert.equal(owner.node, 'human_input');
  assert.equal(owner.phase, 'waiting_owner');
});

test('system repair execution and technical waits are distinct from owner decisions', async (t) => {
  const db = await fixture(t);
  const active = await buildSituation(db, 'ctx-system-run');
  assert.equal(active.node, 'system_repair');
  assert.equal(active.phase, 'system_repair');
  assert.deepEqual(active.systemRepair, {
    requestId: 'run-system:system:1', incidentId: 'control-plane-incident', status: 'pending', attempts: 0, reason: null,
  });

  const waiting = await buildSituation(db, 'ctx-system-wait');
  assert.equal(waiting.node, 'system_pause');
  assert.equal(waiting.phase, 'system_wait');
  assert.equal(waiting.pauseKind, null);
  assert.equal(waiting.systemRepair.status, 'unavailable');
  assert.equal(waiting.systemRepair.reason, 'system_repair_service_unavailable');
  assert.equal(ownerPausedLead(db, 'ctx-system-wait'), null);
});

test('an owner pause during system repair remains an owner pause and keeps its repair summary', async (t) => {
  const db = await fixture(t);
  const situation = await buildSituation(db, 'ctx-system-owner');
  assert.equal(situation.node, 'owner_pause');
  assert.equal(situation.phase, 'paused');
  assert.equal(situation.pauseKind, 'owner_pause');
  assert.equal(situation.systemRepair.incidentId, 'control-plane-incident');
  assert.deepEqual(ownerPausedLead(db, 'ctx-system-owner'), { taskId: 'system-owner', contextId: 'ctx-system-owner' });
});

test('system repair summary omits unsafe reason and identifier text', async (t) => {
  const db = await fixture(t);
  const saver = new SqliteSaver(db);
  await saver.put({ configurable: { thread_id: 'system-run', checkpoint_ns: '' } }, checkpoint(2, {
    systemRequest: { requestId: 'Bearer secret', incidentId: 'incident with spaces', status: 'pending', attempts: 0,
      lastResult: { status: 'blocked', reason: 'token=secret value' } },
  }, { 'branch:to:system_repair': 11 }, '2026-03-11T10:11:00.000Z'), { source: 'loop', step: 2, parents: {} });
  const situation = await buildSituation(db, 'ctx-system-run');
  assert.equal(situation.systemRepair.requestId, null);
  assert.equal(situation.systemRepair.incidentId, null);
  assert.equal(situation.systemRepair.reason, null);
});

test('phase is pausing while a pause is requested and the lead has not parked yet', async (t) => {
  const db = await fixture(t);
  const plain = await buildSituation(db, 'ctx-run');
  assert.equal(plain.phase, 'working');
  const pausing = await buildSituation(db, 'ctx-run', { pauseRequestedRuns: ['run-1'] });
  assert.equal(pausing.phase, 'pausing');
  // A request for another run, or for a run that is not working any more, changes nothing.
  assert.equal((await buildSituation(db, 'ctx-run', { pauseRequestedRuns: ['other'] })).phase, 'working');
  assert.equal((await buildSituation(db, 'ctx-done', { pauseRequestedRuns: ['done-1'] })).phase, 'done');
  assert.equal((await buildSituation(db, 'ctx-pause', { pauseRequestedRuns: ['pause-1'] })).phase, 'budget_pause');
});

test('an owner_pause park is paused at any node; a restart pause is not', async (t) => {
  const db = await fixture(t);
  assert.equal((await buildSituation(db, 'ctx-park-gate')).phase, 'paused');
  assert.equal((await buildSituation(db, 'ctx-park-decide')).phase, 'paused');
  assert.equal((await buildSituation(db, 'ctx-park-decide', { pauseRequestedRuns: ['park-decide'] })).phase, 'paused');
  assert.equal((await buildSituation(db, 'ctx-park-restart')).phase, 'waiting_owner');
  // STOP-01: a stopped run is resumable like an owner pause, so it shows as paused too.
  assert.equal((await buildSituation(db, 'ctx-park-stopped')).phase, 'paused');
});

test('pauseKind names why a paused lead is parked and is null otherwise', async (t) => {
  const db = await fixture(t);
  assert.equal((await buildSituation(db, 'ctx-park-gate')).pauseKind, 'owner_pause');
  assert.equal((await buildSituation(db, 'ctx-park-decide')).pauseKind, 'owner_pause');
  assert.equal((await buildSituation(db, 'ctx-park-stopped')).pauseKind, 'stopped');
  assert.equal((await buildSituation(db, 'ctx-park-restart')).pauseKind, null);
  assert.equal((await buildSituation(db, 'ctx-run', { pauseRequestedRuns: ['run-1'] })).pauseKind, null);
  assert.equal((await buildSituation(db, 'ctx-done')).pauseKind, null);
});

test('ownerPausedLead finds the latest lead turn only when it is parked on an owner pause', async (t) => {
  const db = await fixture(t);
  assert.deepEqual(ownerPausedLead(db, 'ctx-park-gate'), { taskId: 'park-gate', contextId: 'ctx-park-gate' });
  assert.deepEqual(ownerPausedLead(db, 'ctx-park-stopped'), { taskId: 'park-stopped', contextId: 'ctx-park-stopped' });
  assert.equal(ownerPausedLead(db, 'ctx-park-restart'), null);
  assert.equal(ownerPausedLead(db, 'ctx-run'), null);
  assert.equal(ownerPausedLead(db, 'ctx-nope'), null);
});

test('a lead without a checkpoint gives nulls, never invented values', async (t) => {
  const db = await fixture(t);
  const s = await buildSituation(db, 'ctx-bare');
  assert.equal(s.leadTaskId, 'bare-1');
  assert.equal(s.state, NAME[WORKING]);
  assert.equal(s.node, null);
  assert.equal(s.phase, null);
  assert.equal(s.round, null);
  assert.equal(s.budget, null);
  assert.equal(s.startedAt, null);
  assert.equal(s.updatedAt, null);
  assert.deepEqual(s.batch, []);
  assert.deepEqual(s.openDecisions, []);
  assert.deepEqual(s.progress, []);
  assert.equal(s.acceptance, null);
  assert.equal(s.nextSteps, null);
});

test('an unknown session projects to null', async (t) => {
  const db = await fixture(t);
  assert.equal(await buildSituation(db, 'ctx-nope'), null);
});

test('porcelain and shortstat parsers handle renames, untracked entries and empty output', () => {
  assert.deepEqual(parsePorcelain(' M a.txt\0?? b.txt\0R  new.txt\0old.txt\0A  c.txt\0'), [
    { path: 'a.txt', status: 'M' },
    { path: 'b.txt', status: '??' },
    { path: 'new.txt', status: 'R' },
    { path: 'c.txt', status: 'A' },
  ]);
  assert.deepEqual(parsePorcelain(''), []);
  assert.deepEqual(parseShortstat(' 2 files changed, 7 insertions(+), 1 deletion(-)\n'), { files: 2, insertions: 7, deletions: 1 });
  assert.deepEqual(parseShortstat('1 file changed, 1 insertion(+)'), { files: 1, insertions: 1, deletions: 0 });
  assert.deepEqual(parseShortstat(''), { files: 0, insertions: 0, deletions: 0 });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('gitStatus reports branch, head, files and diffstat of a repository', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'add a']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'x\ny\n');
  git(dir, ['add', 'c.txt']);
  const s = await gitStatus(dir);
  assert.equal(s.available, true);
  assert.equal(s.branch, 'main');
  assert.match(s.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(s.files.map((f) => [f.path, f.status]).sort(), [['a.txt', 'M'], ['b.txt', '??'], ['c.txt', 'A']]);
  assert.deepEqual(s.diffstat, { files: 2, insertions: 3, deletions: 0 }, 'tracked changes against HEAD only');
});

test('gitStatus of a repository without commits has no head and no diffstat', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  const s = await gitStatus(dir);
  assert.equal(s.available, true);
  assert.equal(s.head, null);
  assert.equal(s.diffstat, null);
});

test('gitStatus of a directory that is not a repository is unavailable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await gitStatus(dir), { available: false });
  assert.deepEqual(await gitStatus(path.join(dir, 'missing')), { available: false });
});
