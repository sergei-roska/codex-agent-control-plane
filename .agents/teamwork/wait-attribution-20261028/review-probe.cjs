'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { BacklogStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/backlog-store');
const { DeliveryInbox } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-inbox');
const { projectDeliveryVisibility } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-visibility');
const { VERSION } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-contracts');

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


test('review probe binds backlog to original creation and leaves revised or ambiguous observations unknown', () => {
  const { db, store } = setup();
  try {
    const plan = (tasks) => {
      const o=store.getObjective(projectId,objectiveId);
      return store.applyPlan(projectId,objectiveId,{schemaVersion:VERSION,expectedPlanRevision:o.planRevision,expectedGoalRevision:o.goalRevision,expectedAuthorityRevision:o.authorityRevision,expectedControlRevision:o.controlRevision,nextPlanRevision:o.planRevision+1,tasks,dependencies:[]});
    };
    plan([{task:task('first')}]);
    plan([{task:task('later')}]);
    const events=db.prepare("SELECT event_id,event_json FROM delivery_events WHERE json_extract(event_json,'$.eventType')='plan.applied'").all();
    for(const row of events){const event=JSON.parse(row.event_json); event.createdAt=event.objectRevision*1000;db.prepare('UPDATE delivery_events SET event_json=? WHERE event_id=?').run(JSON.stringify(event),row.event_id);}
    const claimed=store.claimReady(projectId,objectiveId,0,{controlRevision:1,limit:2});
    for(const item of claimed)db.prepare('UPDATE backlog_attempts SET record_json=? WHERE attempt_id=?').run(JSON.stringify({...item.attempt,startedAt:3000}),item.attempt.attemptId);
    let page=projectDeliveryVisibility(db,{projectId,objectiveId});
    assert.equal(page.tasks.find(t=>t.taskId==='first').attempts[0].waits.backlogMs,2000);
    assert.equal(page.tasks.find(t=>t.taskId==='later').attempts[0].waits.backlogMs,1000);
    const id=claimed[0].attempt.attemptId;
    db.exec('CREATE TABLE candidate_intents(intent_id TEXT,attempt_id TEXT,project_id TEXT,objective_id TEXT); CREATE TABLE candidate_admission_timing(intent_id TEXT,started_at TEXT,acquired_at TEXT)');
    for(const intent of ['x','y','z']){db.prepare('INSERT INTO candidate_intents VALUES(?,?,?,?)').run(intent,id,projectId,objectiveId);db.prepare('INSERT INTO candidate_admission_timing VALUES(?,?,?)').run(intent,'2026-01-01T00:00:00Z','2026-01-01T00:00:01Z');}
    page=projectDeliveryVisibility(db,{projectId,objectiveId});
    const attempt=page.tasks.flatMap(t=>t.attempts).find(a=>a.attemptId===id);
    assert.equal(attempt.waits.writerMs,null);
    const row=db.prepare('SELECT record_json FROM backlog_attempts WHERE attempt_id=?').get(id);const revised={...JSON.parse(row.record_json),taskRevision:2};db.prepare('UPDATE backlog_attempts SET record_json=? WHERE attempt_id=?').run(JSON.stringify(revised),id);
    page=projectDeliveryVisibility(db,{projectId,objectiveId});
    assert.equal(page.tasks.flatMap(t=>t.attempts).find(a=>a.attemptId===id).waits.backlogMs,null);
    assert.equal(attempt.tokenUsage,null);
  } finally { db.close(); }
});
