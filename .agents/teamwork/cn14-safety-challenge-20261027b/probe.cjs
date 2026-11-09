'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../..');
const Database=require(path.join(root,'node_modules/better-sqlite3'));
const {ConcurrentDeliveryEngine}=require(path.join(root,'src/concurrent-delivery-engine'));
const {WriterAdmission}=require(path.join(root,'src/writer-admission'));
const {LaneManager}=require(path.join(root,'src/writer-lanes'));
const {DeliveryInbox}=require(path.join(root,'src/delivery-inbox'));
const dir=path.join(__dirname,'fixture'), workspace=path.join(dir,'work'), storage=path.join(dir,'state'), file=path.join(storage,'db.sqlite');
fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(workspace,{recursive:true}); fs.mkdirSync(storage,{recursive:true});
const projectId='0123456789', identity={accountId:'fake',codexHome:'/tmp/fake-codex'};
function engine(db) { const admission=new WriterAdmission({db,workspace}); const lanes=new LaneManager({db,workspace,admission,mode:'worktree',lanesRoot:path.join(storage,'lanes'),links:[]}); return new ConcurrentDeliveryEngine({db,workspace,projectId,storageRoot:storage,baseUrl:'http://127.0.0.1:1',authMiddleware:(a,b,n)=>n(),authToken:'fake',appServer:{prepareThread:async()=>{},run:async()=>{}},providerIdentity:identity,providerIdentityFor:()=>identity,roles:new Map([['verifier',{id:'verifier',name:'Verifier',model:'fake'}]]),leadRole:{id:'lead',name:'Lead',model:'fake'},admission,lanes,writerIsolation:{mode:'worktree'}}); }
function seed(db,e,id) {const digest='sha256:'+ 'a'.repeat(64); e.store.createObjective({projectId,objectiveId:`obj-${id}`,sessionId:`sess-${id}`,legacyRunId:`run-${id}`,engineVersion:'delivery/v1',goalRevision:1,requirementDigest:digest,checksDigest:digest,authorityRevision:1,controlRevision:1,disposition:'canceled'}); db.prepare(`INSERT INTO concurrent_delivery_runs(project_id,run_id,objective_id,session_id,goal,contract_json,contract_digest,requirement_digest,checks_digest,environment_digest,check_identity,checkpoint_ids_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId,`run-${id}`,`obj-${id}`,`sess-${id}`,'goal','{}',digest,digest,digest,digest,'check','[]','canceled',1,1); }
(async()=>{let db=new Database(file), e=engine(db); seed(db,e,'a'); seed(db,e,'z');
// Ledger schema is created by the real planner constructor during normal startup.
const {LeadPlanner}=require(path.join(root,'src/lead-planner'));
new LeadPlanner({store:e.store,inbox:new DeliveryInbox(db,{projectId,objectiveId:'obj-z',sessionId:'sess-z'}),runTurn:async()=>{}});
db.prepare('INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,pins_json,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(projectId,'sess-z','scope','thread','turn','unknown','{}',1,1);
db.close(); db=new Database(file); e=engine(db);
await assert.rejects(e.shutdown(), err=>{console.log('unknown ledger',JSON.stringify(err.projections)); assert.equal(err.code,'concurrent_shutdown_unsafe'); assert.deepEqual(err.projections.map(x=>x.runId),['run-a','run-z']); assert.ok(err.projections[1].reasons.includes('live_or_unknown_planner_turn')); return true;});
db.prepare('UPDATE delivery_planner_turns SET status=?').run('completed');
const inbox=new DeliveryInbox(db,{projectId,objectiveId:'obj-z',sessionId:'sess-z'});
inbox.receive({messageId:'pending',kind:'steering',payload:{text:'hold'}}); db.close(); db=new Database(file); e=engine(db);
await assert.rejects(e.shutdown(), err=>{console.log('pending inbox',JSON.stringify(err.projections)); assert.equal(err.code,'concurrent_shutdown_unsafe'); assert.deepEqual(err.projections.map(x=>x.runId),['run-a','run-z']); assert.ok(err.projections[1].reasons.includes('pending_inbox_messages')); return true;});
// Simulate a persisted terminal execution with absent or explicitly false settlement attestation.
new DeliveryInbox(db,{projectId,objectiveId:'obj-z',sessionId:'sess-z'}).markApplied('pending');
const stmt=db.prepare(`INSERT INTO delivery_role_executions(attempt_id,project_id,objective_id,task_id,fencing_token,provider_context_id,external_task_id,role_id,request_digest,settings_digest,state,record_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
stmt.run('attempt',projectId,'obj-z','task',1,'context','external','verifier','request','settings','terminal',JSON.stringify({state:'terminal',effectsSettled:false}),'1','1');
db.close(); db=new Database(file); e=engine(db);
await assert.rejects(e.shutdown(), err=>{console.log('false settlement',err.projections[1].reasons); return err.code==='concurrent_shutdown_unsafe' && err.projections[1].reasons.includes('publication_effect_settlement_unproven');});
const record={schemaVersion:'delivery-role-execution/v1',attemptId:'attempt',projectId,objectiveId:'obj-z',taskId:'task',fencingToken:1,providerContextId:'context',contextId:'context',externalTaskId:'external',roleId:'verifier',requestDigest:'request',settingsDigest:'settings',state:'terminal'};
for (const [label,value] of [['missing',undefined],['null',null],['true',true]]) {
  const next={...record}; if (value !== undefined) next.effectsSettled=value;
  db.prepare('UPDATE delivery_role_executions SET record_json=?').run(JSON.stringify(next));
  db.close(); db=new Database(file); e=engine(db);
  if (value===true) { const result=await e.shutdown(); console.log(label,'settlement',JSON.stringify(result)); assert.equal(result.safeToRelease,true); }
  else await assert.rejects(e.shutdown(), err=>{console.log(label,'settlement',err.projections[1].reasons); return err.code==='concurrent_shutdown_unsafe' && err.projections[1].reasons.includes('publication_effect_settlement_unproven');});
}
db.close(); })().catch(e=>{console.error(e);process.exitCode=1});
