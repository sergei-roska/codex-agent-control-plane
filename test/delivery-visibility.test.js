'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { DeliveryInbox } = require('../src/delivery-inbox');
const { projectDeliveryVisibility } = require('../src/delivery-visibility');
const { VERSION } = require('../src/delivery-contracts');

const projectId = 'project-alpha';
const objectiveId = 'objective-main';
const digest = `sha256:${'a'.repeat(64)}`;
function task(taskId, extra = {}) {
  return { schemaVersion: VERSION, projectId, objectiveId, taskId, revision: 1, role: 'engineer', kind: 'implementation', objective: `Implement ${taskId}`, priority: 0, dependencies: [], productWritePaths: ['src/example.js'], readScope: { kind: 'unknown', paths: null, reason: 'Not established.' }, scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued', ...extra };
}
function setup({ checkpoints = [] } = {}) {
  const db = new Database(':memory:');
  const store = new BacklogStore(db, { roleCapacities: { engineer: 2 }, maxActiveTurns: 3, plannerReservedSlots: 1 });
  store.createObjective({ projectId, objectiveId, sessionId: 'session-main', engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: digest, checksDigest: digest, authorityRevision: 1, controlRevision: 1, disposition: 'executing' }, { checkpoints });
  return { db, store };
}

test('projects scoped pages, dependency explanations, capacity and planner/inbox facts read-only', () => {
  const { db, store } = setup();
  try {
    store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: task('task-a') }, { task: task('task-b') }, { task: task('task-c', { state: 'blocked', dependencies: [{ projectId, objectiveId, predecessorType: 'task', predecessorId: 'task-a', successorTaskId: 'task-c', kind: 'requires_output' }] }) }], dependencies: [] });
    new DeliveryInbox(db, { projectId, objectiveId, sessionId: 'session-main' });
    const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const page = projectDeliveryVisibility(db, { projectId, objectiveId, sessionId: 'session-main', limit: 2 });
    assert.equal(page.available, true);
    assert.deepEqual(page.tasks.map(item => item.taskId), ['task-a', 'task-b']);
    assert.ok(page.nextCursor);
    assert.notEqual(page.nextCursor, 'task-b');
    assert.equal(page.counts.ready, 2);
    assert.equal(page.counts.blocked, 1);
    assert.deepEqual(page.capacity, { projectActive: 0, objectiveActive: 0, configuredWorkerLimit: 2, maxActiveTurns: 3, plannerReservedSlots: 1, byRole: { engineer: { active: 0, configuredLimit: 2 } }, source: 'configured_project', effectiveRuntimeLimit: null });
    assert.equal(page.inbox.available, true);
    assert.equal(page.planner.available, false);
    const second = projectDeliveryVisibility(db, { projectId, objectiveId, sessionId: 'session-main', afterCursor: page.nextCursor, limit: 2 });
    assert.equal(second.tasks[0].taskId, 'task-c');
    assert.equal(second.tasks[0].dependencyReasons[0].state, 'not_satisfied');
    assert.equal(second.tasks[0].dependencyReasons[0].satisfied, false);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), before);
  } finally { db.close(); }
});

test('old databases without optional delivery tables report unknown planner and inbox facts', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE backlog_objectives(project_id TEXT, objective_id TEXT, record_json TEXT, plan_revision INTEGER, capacities_json TEXT, max_active_turns INTEGER, planner_reserved_slots INTEGER);
      CREATE TABLE backlog_tasks(project_id TEXT, objective_id TEXT, task_id TEXT, contract_json TEXT);
      INSERT INTO backlog_objectives VALUES ('${projectId}','${objectiveId}','{"sessionId":"session-main","disposition":"executing"}',4,'{"engineer":2}',3,1);
      INSERT INTO backlog_tasks VALUES ('${projectId}','${objectiveId}','task-a','{"taskId":"task-a","state":"ready","role":"engineer","dependencies":[]}');`);
    const result = projectDeliveryVisibility(db, { projectId, objectiveId, sessionId: 'session-main' });
    assert.equal(result.available, true);
    assert.equal(result.planner.state, 'unknown');
    assert.equal(result.inbox.state, 'unknown');
    assert.equal(result.capacity.configuredWorkerLimit, 2);
  } finally { db.close(); }
});

test('rejects malformed scope and unbounded requests, and does not construct schema on empty database', () => {
  const db = new Database(':memory:');
  try {
    assert.throws(() => projectDeliveryVisibility(db, { projectId, objectiveId, limit: 101 }), /limit/);
    assert.throws(() => projectDeliveryVisibility(db, { projectId, objectiveId, afterCursor: 'not-a-cursor' }), /cursor/);
    const result = projectDeliveryVisibility(db, { projectId, objectiveId });
    assert.equal(result.available, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  } finally { db.close(); }
});

test('retains real attempt identity and leaves unpinned provider context and token usage unknown', () => {
  const { db, store } = setup();
  try {
    store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: task('task-provenance') }], dependencies: [] });
    const [claimed] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    const result = projectDeliveryVisibility(db, { projectId, objectiveId });
    const attempt = result.tasks[0].attempts[0];
    assert.equal(attempt.attemptId, claimed.attempt.attemptId);
    assert.equal(attempt.contextId, claimed.attempt.providerContextId);
    assert.equal(attempt.selectedSettingsKnown, false);
    assert.equal(attempt.tokenUsage, null);
    assert.equal(result.counts.active, 1);
  } finally { db.close(); }
});

test('checkpoint dependency acceptance stays unknown and a trusted output edge is ready only with exact persisted proof', () => {
  const { db, store } = setup({ checkpoints: [{ projectId, objectiveId, checkpointId: 'checkpoint-a' }] });
  try {
    const trusted = task('task-output', { outputContract: 'output:v1' });
    const dependent = task('task-dependent', { dependencies: [{ projectId, objectiveId, predecessorType: 'task', predecessorId: trusted.taskId, successorTaskId: 'task-dependent', kind: 'requires_output', expectedOutput: 'output:v1' }] });
    const checkpointDependent = task('task-checkpoint', { dependencies: [{ projectId, objectiveId, predecessorType: 'checkpoint', predecessorId: 'checkpoint-a', successorTaskId: 'task-checkpoint', kind: 'requires_acceptance' }] });
    store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: trusted }, { task: dependent }, { task: checkpointDependent }], dependencies: [] });
    let view = projectDeliveryVisibility(db, { projectId, objectiveId });
    assert.equal(view.counts.ready, 1);
    assert.equal(view.counts.unknown, 1);
    assert.equal(view.tasks.find(item => item.taskId === 'task-checkpoint').readiness, 'unknown');
    const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    store.pinSelectedSettings(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, { model: 'model-pinned' });
    store.settleAttempt(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken,
      { state: 'succeeded', trusted: true, outputContract: 'output:v1' },
      { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true });
    view = projectDeliveryVisibility(db, { projectId, objectiveId });
    assert.equal(view.counts.ready, 1);
    assert.equal(view.counts.unknown, 1);
    assert.equal(view.tasks.find(item => item.taskId === 'task-dependent').readiness, 'ready');
    assert.equal(view.tasks.find(item => item.taskId === 'task-checkpoint').readiness, 'unknown');
  } finally { db.close(); }
});

test('project-wide claims consume shared capacity and planner activity is explicitly session-scoped', () => {
  const { db, store } = setup();
  try {
    const objectiveB = 'objective-secondary';
    store.createObjective({ projectId, objectiveId: objectiveB, sessionId: 'session-main', engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: digest, checksDigest: digest, authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
    store.applyPlan(projectId, objectiveB, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: task('task-other-a', { objectiveId: objectiveB }) }, { task: task('task-other-b', { objectiveId: objectiveB }) }], dependencies: [] });
    store.claimReady(projectId, objectiveB, 0, { controlRevision: 1, limit: 2 });
    db.exec(`CREATE TABLE delivery_planner_turns(project_id TEXT, session_id TEXT, provider_scope TEXT, provider_thread_id TEXT, turn_id TEXT, status TEXT, pins_json TEXT, result_json TEXT, started_at INTEGER, updated_at INTEGER);
      INSERT INTO delivery_planner_turns VALUES ('${projectId}','session-main','scope','thread','turn-a','active','{}',NULL,10,10);`);
    const view = projectDeliveryVisibility(db, { projectId, objectiveId });
    assert.equal(view.counts.active, 0);
    assert.equal(view.capacity.objectiveActive, 0);
    assert.equal(view.capacity.projectActive, 2);
    assert.equal(view.capacity.byRole.engineer.active, 2);
    assert.equal(view.planner.scope, 'session');
    assert.equal(view.planner.attribution, 'not_attributed_to_objective');
    assert.equal(view.planner.inFlight, true);
    assert.ok(view.idleReasons.known.some(item => item.reason === 'role_capacity_full'));
  } finally { db.close(); }
});

test('opaque cursors cannot be reused across objectives, projects or sessions', () => {
  const { db, store } = setup();
  try {
    store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: task('task-a') }, { task: task('task-b') }], dependencies: [] });
    const cursor = projectDeliveryVisibility(db, { projectId, objectiveId, sessionId: 'session-main', limit: 1 }).nextCursor;
    assert.throws(() => projectDeliveryVisibility(db, { projectId, objectiveId: 'objective-other', sessionId: 'session-main', afterCursor: cursor }), /scope/);
    assert.throws(() => projectDeliveryVisibility(db, { projectId: 'project-other', objectiveId, sessionId: 'session-main', afterCursor: cursor }), /scope/);
    assert.throws(() => projectDeliveryVisibility(db, { projectId, objectiveId, sessionId: 'session-other', afterCursor: cursor }), /scope/);
  } finally { db.close(); }
});

test('a succeeded predecessor without trusted output evidence is unknown and never counted ready', () => {
  const { db, store } = setup();
  try {
    const predecessor = task('task-untrusted', { outputContract: 'output:v1' });
    const successor = task('task-successor', { dependencies: [{ projectId, objectiveId, predecessorType: 'task', predecessorId: predecessor.taskId, successorTaskId: 'task-successor', kind: 'requires_output', expectedOutput: 'output:v1' }] });
    store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: predecessor }, { task: successor }], dependencies: [] });
    const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    const record = { ...claim.attempt, state: 'succeeded', outcome: { state: 'succeeded', trusted: false, outputContract: 'output:v1' }, effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } };
    db.prepare('UPDATE backlog_attempts SET record_json=? WHERE project_id=? AND objective_id=? AND attempt_id=?').run(JSON.stringify(record), projectId, objectiveId, record.attemptId);
    const succeeded = { ...predecessor, state: 'succeeded' };
    db.prepare('UPDATE backlog_tasks SET state=?,contract_json=? WHERE project_id=? AND objective_id=? AND task_id=?').run('succeeded', JSON.stringify(succeeded), projectId, objectiveId, predecessor.taskId);
    const view = projectDeliveryVisibility(db, { projectId, objectiveId });
    assert.equal(view.counts.ready, 0);
    assert.equal(view.counts.blocked, 1);
    const dependency = view.tasks.find(item => item.taskId === 'task-successor').dependencyReasons[0];
    assert.equal(dependency.satisfied, false);
    assert.match(dependency.reason, /untrusted/);
  } finally { db.close(); }
});

test('uses a bounded readable objective summary while retaining the stable task ID', () => {
  const { db, store } = setup();
  try {
    const longObjective = `  Implement the durable delivery objective with   readable task labels. ${'Continue useful implementation work safely. '.repeat(8)}`;
    const readable = task('task-stable-readable-id', { objective: longObjective });
    store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: readable }], dependencies: [] });
    const item = projectDeliveryVisibility(db, { projectId, objectiveId }).tasks[0];
    assert.equal(item.taskId, 'task-stable-readable-id');
    assert.match(item.title, /^Implement the durable delivery objective with readable task labels\./);
    assert.ok(item.title.length <= 160);
    assert.ok(item.title.endsWith('...'));
    assert.notEqual(item.title, item.taskId);
  } finally { db.close(); }
});

test('attributes distinct persisted timing intervals and preserves unknowns', () => {
  const { db, store } = setup();
  try {
    store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
      tasks: [{ task: task('timed') }], dependencies: [] });
    const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    const id = claim.attempt.attemptId;
    const event = JSON.parse(db.prepare("SELECT event_json FROM delivery_events WHERE json_extract(event_json,'$.eventType')='plan.applied'").get().event_json);
    event.createdAt = 1000;
    db.prepare('UPDATE delivery_events SET event_json=? WHERE event_id=?').run(JSON.stringify(event), event.eventId);
    const attempt = { ...claim.attempt, startedAt: 1100, settledAt: 1900 };
    db.prepare('UPDATE backlog_attempts SET record_json=? WHERE attempt_id=?').run(JSON.stringify(attempt), id);
    db.exec('CREATE TABLE delivery_role_executions(attempt_id TEXT,project_id TEXT,objective_id TEXT,record_json TEXT); CREATE TABLE candidate_intents(intent_id TEXT,attempt_id TEXT,project_id TEXT,objective_id TEXT); CREATE TABLE candidate_admission_timing(intent_id TEXT,started_at TEXT,acquired_at TEXT)');
    db.prepare('INSERT INTO delivery_role_executions VALUES(?,?,?,?)').run(id, projectId, objectiveId, JSON.stringify({ providerInvocationStartedAt: 1200, turnStartObservedAt: 1250, terminalObservedAt: 1500 }));
    db.prepare('INSERT INTO candidate_intents VALUES(?,?,?,?)').run('intent', id, projectId, objectiveId);
    db.prepare('INSERT INTO candidate_admission_timing VALUES(?,?,?)').run('intent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.025Z');
    let result = projectDeliveryVisibility(db, { projectId, objectiveId }).tasks[0].attempts[0];
    assert.deepEqual(result.waits, { backlogMs: 100, writerMs: 25, providerMs: 50, settlementMs: 400 });
    assert.equal(result.tokenUsage, null);
    db.prepare('INSERT INTO candidate_intents VALUES(?,?,?,?)').run('missing-timing', id, projectId, objectiveId);
    assert.equal(projectDeliveryVisibility(db, { projectId, objectiveId }).tasks[0].attempts[0].waits.writerMs, null);
    db.prepare('DELETE FROM candidate_intents WHERE intent_id=?').run('missing-timing');
    event.createdAt = -1000;
    db.prepare('UPDATE delivery_events SET event_json=? WHERE event_id=?').run(JSON.stringify(event), event.eventId);
    assert.equal(projectDeliveryVisibility(db, { projectId, objectiveId }).tasks[0].attempts[0].waits.backlogMs, null);
    event.createdAt = 1000;
    db.prepare('UPDATE delivery_events SET event_json=? WHERE event_id=?').run(JSON.stringify(event), event.eventId);
    for (const [start, end, expected] of [
      ['2024-02-29T00:00:00Z', '2024-03-01T00:00:00Z', 86400000],
      ['2026-02-29T00:00:00Z', '2026-03-01T00:00:00Z', null],
      ['2026-02-30T00:00:00Z', '2026-03-03T00:00:00Z', null],
      ['2026-01-01T24:00:00Z', '2026-01-02T01:00:00Z', null],
      ['2026-01-01T00:00:00+24:00', '2026-01-02T00:00:00Z', null],
      ['2026-01-01T00:00:00+02:30', '2025-12-31T22:00:00Z', 1800000],
    ]) {
      db.prepare('UPDATE candidate_admission_timing SET started_at=?,acquired_at=?').run(start, end);
      assert.equal(projectDeliveryVisibility(db, { projectId, objectiveId }).tasks[0].attempts[0].waits.writerMs, expected);
    }
    db.prepare('UPDATE candidate_admission_timing SET acquired_at=NULL').run();
    db.prepare('UPDATE delivery_role_executions SET record_json=?').run(JSON.stringify({ providerInvocationStartedAt: 1200, turnStartObservedAt: 1100 }));
    result = projectDeliveryVisibility(db, { projectId, objectiveId }).tasks[0].attempts[0];
    assert.deepEqual(result.waits, { backlogMs: 100, writerMs: null, providerMs: null, settlementMs: null });
  } finally { db.close(); }
});
