'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../../../src/backlog-store');
const { TaskExecutor } = require('../../../src/task-executor');
const { VERSION } = require('../../../src/delivery-contracts');
const root = __dirname;
const projectId = 'challenge-project', objectiveId = 'challenge-objective';
const digest = (x) => `sha256:${x.repeat(64)}`;
function task(id) { return { schemaVersion: VERSION, projectId, objectiveId, taskId: id, revision: 1, role: 'engineer', kind: 'implementation', objective: `Implement ${id}`, priority: 0, dependencies: [], productWritePaths: [`src/${id}.js`], readScope: {kind:'known',paths:[]}, scratchWriteRoots:['.scratch'],resourceClaims:[],publicationAuthority:{state:'unknown'},state:'queued' }; }
function setup(name, { gateSettings = false, maxRecoveryRetries = 2 } = {}) {
 const file = path.join(root, `${name}.sqlite`); try { fs.unlinkSync(file); } catch(e) { if(e.code !== 'ENOENT') throw e; }
 let now=1000, enter, release; const entered=new Promise(r=>enter=r), held=new Promise(r=>release=r);
 const db=new Database(file), peerDb=new Database(file);
 const store=new BacklogStore(db,{now:()=>now,roleCapacities:{engineer:2},maxActiveTurns:3,plannerReservedSlots:1});
 const peer=new BacklogStore(peerDb,{now:()=>now,roleCapacities:{engineer:2},maxActiveTurns:3,plannerReservedSlots:1});
 store.createObjective({projectId,objectiveId,sessionId:'s',engineVersion:VERSION,goalRevision:1,requirementDigest:digest('a'),checksDigest:digest('b'),authorityRevision:1,controlRevision:1,disposition:'executing'});
 store.applyPlan(projectId,objectiveId,{schemaVersion:VERSION,expectedPlanRevision:0,expectedGoalRevision:1,expectedAuthorityRevision:1,expectedControlRevision:1,nextPlanRevision:1,tasks:[{task:task('a')},{task:task('b')}],dependencies:[]});
 const [claim]=store.claimReady(projectId,objectiveId,0,{controlRevision:1,limit:1});
 let sends=0;
 const executor=new TaskExecutor({backlogStore:store,db,transportFor:async()=>({async sendMessage({message}){sends++;return{id:'remote',contextId:message.contextId};},async findByContext(){return null;}}),settingsFor:async()=>{if(gateSettings){enter();await held;}return {model:'test'};},roleFor:id=>({id,sandbox:'writable'}),requestAdapter:({task:t})=>({request:{objective:t.objective,allowedFiles:t.productWritePaths}}),resultAdapter:async()=>({result:{state:'succeeded',trusted:true},evidence:{remoteQuiescent:true,processQuiescent:true,effectsSettled:true,controllerValidated:true,evidenceRefs:['probe']}}),maxRecoveryRetries,now:()=>now});
 const id={projectId,objectiveId,taskId:claim.task.taskId,attemptId:claim.attempt.attemptId,fencingToken:claim.claim.fencingToken};
 const proof=({identity,attempt,claim,intent})=>({projectId,objectiveId,taskId:identity.taskId,attemptId:identity.attemptId,fencingToken:identity.fencingToken,claimOwnerGeneration:claim.ownerGeneration,recoveryGeneration:identity.recoveryGeneration,providerContextId:attempt.providerContextId,intentState:intent?.state||null,noEffect:true,remoteQuiescent:true,processQuiescent:true,effectsSettled:true,evidenceRefs:['probe:no-effect']});
 return {db,peerDb,store,peer,executor,id,entered,release,proof,get sends(){return sends;},close(){db.close();peerDb.close();}};
}
(async()=>{
 {const f=setup('pending-settings',{gateSettings:true});try{
  const pending=f.executor.execute(f.id);await f.entered;
  f.peer.markExpired(projectId,objectiveId,Number.MAX_SAFE_INTEGER);f.peer.advanceOwnerGeneration(projectId,objectiveId,0);
  assert.equal(f.store.projectCapacity(projectId,objectiveId).active,1);
  assert.equal(f.executor.recover({...f.id,recoveryGeneration:1}).state,'unknown');
  f.executor.recoveryProofAdapter=f.proof;
  assert.equal(f.executor.recover({...f.id,recoveryGeneration:1}).state,'no_effect_requeued');
  f.release();await assert.rejects(pending,{code:'owner_generation_stale'});
  assert.equal(f.sends,0);assert.equal(f.store.projectCapacity(projectId,objectiveId).active,0);
  const [sibling]=f.peer.claimReady(projectId,objectiveId,1,{controlRevision:1,limit:1});assert.equal(sibling.task.taskId,'a');
  console.log('PASS pending settings: exact no-effect proof settles; old callback cannot send');
 }finally{f.close();}}
 {const f=setup('proof-interleave');try{
  f.peer.markExpired(projectId,objectiveId,Number.MAX_SAFE_INTEGER);f.peer.advanceOwnerGeneration(projectId,objectiveId,0);
  f.executor.recoveryProofAdapter=(arg)=>{const p=f.proof(arg);f.peer.advanceOwnerGeneration(projectId,objectiveId,1);return p;};
  const result=f.executor.recover({...f.id,recoveryGeneration:1});
  assert.equal(result.state,'unknown');assert.equal(f.store.projectCapacity(projectId,objectiveId).active,1);
  assert.equal(f.store.listClaims(projectId,objectiveId)[0].state,'expired');
  assert.equal(f.sends,0);
  console.log('PASS second connection owner takeover inside proof: settlement cannot release stale claim');
 }finally{f.close();}}
 {const f=setup('exhaust-sibling',{maxRecoveryRetries:1});try{
  f.peer.markExpired(projectId,objectiveId,Number.MAX_SAFE_INTEGER);f.peer.advanceOwnerGeneration(projectId,objectiveId,0);
  f.executor.recoveryProofAdapter=f.proof;
  const result=f.executor.recover({...f.id,recoveryGeneration:1});assert.equal(result.state,'task_blocked');
  const [sibling]=f.peer.claimReady(projectId,objectiveId,1,{controlRevision:1,limit:1});assert.equal(sibling.task.taskId,'b');
  const siblingId={projectId,objectiveId,taskId:sibling.task.taskId,attemptId:sibling.attempt.attemptId,fencingToken:sibling.claim.fencingToken};
  assert.equal((await f.executor.execute(siblingId)).state,'submitted');assert.equal(f.sends,1);
  assert.equal(f.store.getObjective(projectId,objectiveId).disposition,'executing');
  console.log('PASS task exhaustion: sibling is claimed and sent on reopened connection');
 }finally{f.close();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
