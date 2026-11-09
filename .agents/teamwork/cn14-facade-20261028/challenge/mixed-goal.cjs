'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../../..');
const filename = path.join(root, 'test/backlog-store.test.js');
const prefix = fs.readFileSync(filename, 'utf8').split("test('")[0];
const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(prefix + `
test('mixed goal recovery batch', () => {
 const {db,store}=fixture(':memory:', {ownerCorrectionAuthorized:()=>true, roleCapacities:{engineer:2}, maxActiveTurns:4});
 try {
  db.exec('CREATE TABLE task_executor_attempts (attempt_id TEXT, state TEXT, external_task_id TEXT, context_id TEXT, project_id TEXT, objective_id TEXT, task_id TEXT, fencing_token INTEGER)');
  apply(store,[{task:task('old')}]);
  const [old]=store.claimReady(projectId,objectiveId,0,{controlRevision:1});
  store.applyOwnerCorrection(projectId,objectiveId,ownerCorrection('c'));
  let current=store.getObjective(projectId,objectiveId);
  store.applyPlan(projectId,objectiveId,revisionedPlan(current,[{task:task('fresh')}]));
  const [fresh]=store.claimReady(projectId,objectiveId,0,{controlRevision:current.controlRevision});
  assert.equal(fresh.attempt.capturedControls.goalRevision,2);
  store.requestControl(projectId,objectiveId,'pause',current.controlRevision);
  store.markExpired(projectId,objectiveId,Number.MAX_SAFE_INTEGER);
  function settle(x) { return store.settleRecoveredNoEffect(projectId,objectiveId,x.attempt.attemptId,x.claim.fencingToken,{projectId,objectiveId,taskId:x.task.taskId,attemptId:x.attempt.attemptId,fencingToken:x.claim.fencingToken,claimOwnerGeneration:0,recoveryGeneration:0,providerContextId:x.attempt.providerContextId,intentState:null,noEffect:true,remoteQuiescent:true,processQuiescent:true,effectsSettled:true,evidenceRefs:['private:report']},2); }
  const a=settle(old), b=settle(fresh);
  assert.equal(a.task.blockedReason,'owner_correction_replan_required'); assert.equal(b.state,'no_effect_requeued');
  assert.equal(store.getObjective(projectId,objectiveId).disposition,'paused_owner');
  current=store.getObjective(projectId,objectiveId); store.requestControl(projectId,objectiveId,'resume',current.controlRevision);
  current=store.getObjective(projectId,objectiveId); const next=store.claimReady(projectId,objectiveId,0,{controlRevision:current.controlRevision});
  assert.deepEqual(next.map(x=>x.task.taskId),['fresh']);
 } finally {db.close();}
});`, filename);
