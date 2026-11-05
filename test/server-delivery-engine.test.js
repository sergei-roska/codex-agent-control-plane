'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { TaskState } = require('@a2a-js/sdk');
const { startServer, projectIdForWorkspace, inspectConcurrentStartupQuarantine } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { openStateDatabase, acquireWorkspaceLock, acquireStateLock } = require('../src/durable-store');
const { readProcessIdentity } = require('../src/process-quiescence');
const { scopedExecutionDetails } = require('../src/delivery-role-capabilities');
const { LeadPlanner } = require('../src/lead-planner');
const { VERSION, validatePlanDelta } = require('../src/delivery-contracts');
const { checkSpecialistRequest } = require('../src/contracts');

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-delivery-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function appServer(overrides = {}) {
  return {
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async run() {},
    async close() {},
    ...overrides,
  };
}

function message(text, extra = {}) {
  return { messageId: 'new-message', contextId: '', taskId: '', role: 1,
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: undefined, extensions: [], referenceTaskIds: [], ...extra };
}

function assertStrictOutputSchema(schema) {
  const allowed = new Set(['type', 'additionalProperties', 'required', 'properties', 'items', 'anyOf', 'enum', 'description', 'pattern', 'minItems']);
  const visit = (node, at = '$') => {
    assert.ok(node && typeof node === 'object' && !Array.isArray(node), `schema node must be an object at ${at}`);
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `unsupported schema keyword ${key} at ${at}`);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `object must be closed at ${at}`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `every property must be required at ${at}`);
      for (const [key, child] of Object.entries(node.properties)) visit(child, `${at}.${key}`);
    }
    if (node.minItems !== undefined) assert.equal(Number.isSafeInteger(node.minItems) && node.minItems >= 1, true, `minItems must be a positive integer at ${at}`);
    if (node.items) visit(node.items, `${at}[]`);
    for (const [index, child] of (node.anyOf || []).entries()) visit(child, `${at}.anyOf[${index}]`);
  };
  visit(schema);
}

function plannerTaskVariants(change) { return change?.properties?.task?.anyOf || []; }
function plannerTaskSchemaForRole(change, role) {
  return plannerTaskVariants(change).find((variant) => variant.properties.role.enum.includes(role));
}

const call = () => new ServerCallContext({ tenant: '' });

test('startup quarantine predicate classifies phase states without writes', (t) => {
  const root = tempDir(t);
  const db = new (require('better-sqlite3'))(':memory:');
  t.after(() => db.close());
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'none' });
  db.exec('CREATE TABLE concurrent_shutdown_phases(project_id TEXT, phase_json TEXT)');
  const badSchema=new (require('better-sqlite3'))(':memory:');
  t.after(()=>badSchema.close());
  badSchema.exec('CREATE TABLE concurrent_shutdown_phases(project_id TEXT)');
  assert.deepEqual(inspectConcurrentStartupQuarantine(badSchema,root,'project'),{state:'unsafe'});
  const snapshot = () => db.prepare('SELECT * FROM concurrent_shutdown_phases').all();
  const before = snapshot();
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'none' });
  assert.deepEqual(snapshot(), before);
  db.prepare('INSERT INTO concurrent_shutdown_phases VALUES (?,?)').run('project', JSON.stringify({ phase: 'released', attempts: [], identities: [] }));
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'released' });
  const absentPid=4000000+Math.floor(Math.random()*1000);
  assert.throws(()=>process.kill(-absentPid,0),{code:'ESRCH'});
  const absentIdentity={pid:absentPid,pgid:absentPid,startTime:'1'};
  db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=?').run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities: [absentIdentity] }));
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'provider_closing' });
  db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=?').run(JSON.stringify({ phase: 'provider_closing', attempts: [] }));
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'unsafe' });
  db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=?').run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities: [{pid:0,pgid:0,startTime:null}] }));
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'unsafe' });
  db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=?').run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities: [readProcessIdentity(process.pid)] }));
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'unsafe' });
  db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=?').run(JSON.stringify({ phase: 'released', attempts: [], identities: [], extra: true }));
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'unsafe' });
  db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=?').run(JSON.stringify({ phase: 'draining', attempts: ['unexpected'], identities: [] }));
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'unsafe' });
  db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=?').run('{');
  assert.deepEqual(inspectConcurrentStartupQuarantine(db, root, 'project'), { state: 'unsafe' });
  assert.equal(db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json, '{');
});

test('startup quarantine predicate accepts only an exactly bound dormant planner and rejects unsettled evidence', (t) => {
  const root = tempDir(t), project = '0123456789', session = 'session-1', runId = 'a2a-task-1', objectiveId = 'objective-1';
  const db = new (require('better-sqlite3'))(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE concurrent_shutdown_phases(project_id TEXT,phase_json TEXT);
    CREATE TABLE delivery_planner_turns(project_id TEXT,session_id TEXT,provider_scope TEXT,provider_thread_id TEXT,turn_id TEXT,status TEXT,pins_json TEXT,result_json TEXT,started_at INTEGER,updated_at INTEGER);
    CREATE TABLE concurrent_planner_execution_facts(project_id TEXT,session_id TEXT,turn_id TEXT,identity_json TEXT,start_json TEXT,terminal_json TEXT);
    CREATE TABLE delivery_run_engines(project_id TEXT,run_id TEXT,engine TEXT,objective_id TEXT,session_id TEXT,request_json TEXT);
    CREATE TABLE concurrent_delivery_runs(project_id TEXT,run_id TEXT,objective_id TEXT,session_id TEXT,status TEXT);
    CREATE TABLE backlog_objectives(project_id TEXT,objective_id TEXT,record_json TEXT,owner_generation INTEGER DEFAULT 4);
    CREATE TABLE backlog_attempts(project_id TEXT,objective_id TEXT,attempt_id TEXT,terminal_digest TEXT,record_json TEXT);
    CREATE TABLE backlog_claims(project_id TEXT,objective_id TEXT,record_json TEXT);
    CREATE TABLE delivery_role_executions(project_id TEXT,objective_id TEXT,attempt_id TEXT,state TEXT,record_json TEXT);
    CREATE TABLE candidate_intents(project_id TEXT,objective_id TEXT,intent_id TEXT,state TEXT);
    CREATE TABLE delivery_output_bindings(project_id TEXT,objective_id TEXT,artifact_id TEXT);
    CREATE TABLE delivery_output_publications(intent_id TEXT,artifact_id TEXT,state TEXT);
    CREATE TABLE concurrent_controller_fences(project_id TEXT,objective_id TEXT,projection_json TEXT);
    CREATE TABLE writer_executions(workspace TEXT,state TEXT);
    CREATE TABLE tasks(tenant TEXT,owner TEXT,id TEXT,status TEXT,status_state TEXT);
    CREATE TABLE dispatch_journal(run_id TEXT,state TEXT);
    CREATE TABLE task_executor_attempts(attempt_id TEXT,project_id TEXT,objective_id TEXT,task_id TEXT,state TEXT,record_json TEXT);
    CREATE TABLE task_executor_evidence(attempt_id TEXT);
    CREATE TABLE task_executor_thread_reservations(transport_key TEXT,thread_id TEXT,attempt_id TEXT);`);
  const pid = 2000000000 + Math.floor(Math.random() * 1000000);
  const identity = { projectId: project, sessionId: session, providerThreadId: 'thread-1', providerScope: 'scope-1', turnId: 'turn-1', ownerGeneration: 4 };
  const add = (table, values) => db.prepare(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values));
  add('concurrent_shutdown_phases',{project_id:project,phase_json:JSON.stringify({phase:'draining',attempts:[],identities:[]})});
  add('delivery_planner_turns',{project_id:project,session_id:session,provider_scope:'scope-1',provider_thread_id:'thread-1',turn_id:'turn-1',status:'active',pins_json:JSON.stringify({ownerGeneration:4}),result_json:null,started_at:1,updated_at:1});
  add('concurrent_planner_execution_facts',{project_id:project,session_id:session,turn_id:'turn-1',identity_json:JSON.stringify(identity),start_json:JSON.stringify({threadId:'thread-1',processIdentity:{pid,pgid:pid,startTime:'1'}}),terminal_json:null});
  add('delivery_run_engines',{project_id:project,run_id:runId,engine:'concurrent-v1',objective_id:objectiveId,session_id:session});
  add('concurrent_delivery_runs',{project_id:project,run_id:runId,objective_id:objectiveId,session_id:session,status:'canceled'});
  add('backlog_objectives',{project_id:project,objective_id:objectiveId,record_json:JSON.stringify({projectId:project,objectiveId,sessionId:session,disposition:'canceled',ownerGeneration:4})});
  add('backlog_attempts',{project_id:project,objective_id:objectiveId,attempt_id:'attempt-1',terminal_digest:'digest',record_json:'{"state":"succeeded"}'});
  add('backlog_claims',{project_id:project,objective_id:objectiveId,record_json:'{"state":"released"}'});
  add('delivery_role_executions',{project_id:project,objective_id:objectiveId,attempt_id:'attempt-1',state:'terminal',record_json:JSON.stringify({projectId:project,objectiveId,attemptId:'attempt-1',state:'terminal',effectsSettled:true})});
  add('candidate_intents',{project_id:project,objective_id:objectiveId,intent_id:'intent-1',state:'applied'});
  add('delivery_output_bindings',{project_id:project,objective_id:objectiveId,artifact_id:'artifact-1'});
  add('delivery_output_publications',{intent_id:'intent-1',artifact_id:'artifact-1',state:'applied'});
  add('concurrent_controller_fences',{project_id:project,objective_id:objectiveId,projection_json:'{"safeToRelease":true}'});
  add('tasks',{tenant:'',owner:'orchestrator',id:runId,status:JSON.stringify({state:'TASK_STATE_CANCELED'}),status_state:'TASK_STATE_CANCELED'});
  const expected={state:'quarantine',runId,objectiveId,sessionId:session};
  const snapshot=()=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));
  const before=snapshot();
  assert.deepEqual(inspectConcurrentStartupQuarantine(db,root,project),expected);
  assert.deepEqual(snapshot(),before);
  const cases=['missing fact','mismatched fact','live process','multiple planner turns','unknown planner turn','active claim','active attempt','unsettled execution','unsettled publication','unsettled task executor','unbound task executor evidence','reserved task thread','active task','bad task identity','bad task status','duplicate mapping','same run other session','publication intent mismatch','cross tenant active task','missing required table','missing required column'];
  for(const label of cases) {
    const clean=new (require('better-sqlite3'))(':memory:');
    t.after(()=>clean.close());
     clean.exec(`CREATE TABLE concurrent_shutdown_phases(project_id TEXT,phase_json TEXT); CREATE TABLE delivery_planner_turns(project_id TEXT,session_id TEXT,provider_scope TEXT,provider_thread_id TEXT,turn_id TEXT,status TEXT,pins_json TEXT,result_json TEXT,started_at INTEGER,updated_at INTEGER); CREATE TABLE concurrent_planner_execution_facts(project_id TEXT,session_id TEXT,turn_id TEXT,identity_json TEXT,start_json TEXT,terminal_json TEXT); CREATE TABLE delivery_run_engines(project_id TEXT,run_id TEXT,engine TEXT,objective_id TEXT,session_id TEXT,request_json TEXT); CREATE TABLE concurrent_delivery_runs(project_id TEXT,run_id TEXT,objective_id TEXT,session_id TEXT,status TEXT); CREATE TABLE backlog_objectives(project_id TEXT,objective_id TEXT,record_json TEXT,owner_generation INTEGER DEFAULT 4); CREATE TABLE backlog_attempts(project_id TEXT,objective_id TEXT,attempt_id TEXT,terminal_digest TEXT,record_json TEXT); CREATE TABLE backlog_claims(project_id TEXT,objective_id TEXT,record_json TEXT); CREATE TABLE delivery_role_executions(project_id TEXT,objective_id TEXT,attempt_id TEXT,state TEXT,record_json TEXT); CREATE TABLE candidate_intents(project_id TEXT,objective_id TEXT,intent_id TEXT,state TEXT); CREATE TABLE delivery_output_bindings(project_id TEXT,objective_id TEXT,artifact_id TEXT); CREATE TABLE delivery_output_publications(intent_id TEXT,artifact_id TEXT,state TEXT); CREATE TABLE concurrent_controller_fences(project_id TEXT,objective_id TEXT,projection_json TEXT); CREATE TABLE writer_executions(workspace TEXT,state TEXT); CREATE TABLE tasks(tenant TEXT,owner TEXT,id TEXT,status TEXT,status_state TEXT); CREATE TABLE dispatch_journal(run_id TEXT,state TEXT); CREATE TABLE task_executor_attempts(attempt_id TEXT,project_id TEXT,objective_id TEXT,task_id TEXT,state TEXT,record_json TEXT); CREATE TABLE task_executor_evidence(attempt_id TEXT); CREATE TABLE task_executor_thread_reservations(transport_key TEXT,thread_id TEXT,attempt_id TEXT);`);
    // Replicate the pristine seed via SQL statements below, then apply one hostile mutation.
    for (const [sql,args] of [
      ['INSERT INTO concurrent_shutdown_phases VALUES(?,?)',[project,JSON.stringify({phase:'draining',attempts:[],identities:[]})]],
      ['INSERT INTO delivery_planner_turns VALUES(?,?,?,?,?,?,?,?,?,?)',[project,session,'scope-1','thread-1','turn-1','active','{"ownerGeneration":4}',null,1,1]],
      ['INSERT INTO concurrent_planner_execution_facts VALUES(?,?,?,?,?,?)',[project,session,'turn-1',JSON.stringify(identity),JSON.stringify({threadId:'thread-1',processIdentity:{pid,pgid:pid,startTime:'1'}}),null]],
       ['INSERT INTO delivery_run_engines VALUES(?,?,?,?,?,?)',[project,runId,'concurrent-v1',objectiveId,session,'{}']],
      ['INSERT INTO concurrent_delivery_runs VALUES(?,?,?,?,?)',[project,runId,objectiveId,session,'canceled']],
      ['INSERT INTO backlog_objectives(project_id,objective_id,record_json) VALUES(?,?,?)',[project,objectiveId,JSON.stringify({projectId:project,objectiveId,sessionId:session,disposition:'canceled',ownerGeneration:4})]],
      ['INSERT INTO backlog_attempts VALUES(?,?,?,?,?)',[project,objectiveId,'attempt-1','digest','{"state":"succeeded"}']],
      ['INSERT INTO backlog_claims VALUES(?,?,?)',[project,objectiveId,'{"state":"released"}']],
      ['INSERT INTO delivery_role_executions VALUES(?,?,?,?,?)',[project,objectiveId,'attempt-1','terminal',JSON.stringify({projectId:project,objectiveId,attemptId:'attempt-1',state:'terminal',effectsSettled:true})]],
      ['INSERT INTO candidate_intents VALUES(?,?,?,?)',[project,objectiveId,'intent-1','applied']],
      ['INSERT INTO delivery_output_bindings VALUES(?,?,?)',[project,objectiveId,'artifact-1']],
      ['INSERT INTO delivery_output_publications VALUES(?,?,?)',['intent-1','artifact-1','applied']],
      ['INSERT INTO concurrent_controller_fences VALUES(?,?,?)',[project,objectiveId,'{"safeToRelease":true}']],
      ['INSERT INTO tasks VALUES(?,?,?,?,?)',['','orchestrator',runId,'{"state":"TASK_STATE_CANCELED"}','TASK_STATE_CANCELED']],
    ]) clean.prepare(sql).run(...args);
    const addClean=(table,values)=>clean.prepare(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(()=>'?').join(',')})`).run(...Object.values(values));
    // Mutations target the disposable case database.
    if(label==='missing fact') clean.prepare('DELETE FROM concurrent_planner_execution_facts').run();
    if(label==='mismatched fact') clean.prepare("UPDATE concurrent_planner_execution_facts SET identity_json='{}'").run();
    if(label==='live process') clean.prepare('UPDATE concurrent_planner_execution_facts SET start_json=?').run(JSON.stringify({threadId:'thread-1',processIdentity:readProcessIdentity(process.pid)}));
    if(label==='multiple planner turns') addClean('delivery_planner_turns',{project_id:project,session_id:session,provider_scope:'s2',provider_thread_id:'t2',turn_id:'turn-2',status:'active',pins_json:'{}',result_json:null,started_at:2,updated_at:2});
    if(label==='unknown planner turn') clean.prepare("UPDATE delivery_planner_turns SET status='unknown'").run();
    if(label==='active claim') addClean('backlog_claims',{project_id:project,objective_id:objectiveId,record_json:'{"state":"active"}'});
    if(label==='active attempt') addClean('backlog_attempts',{project_id:project,objective_id:objectiveId,attempt_id:'a',record_json:'{"state":"running"}',terminal_digest:null});
    if(label==='unsettled task executor') addClean('task_executor_attempts',{attempt_id:'executor-a',project_id:project,objective_id:objectiveId,task_id:'task-1',state:'uncertain',record_json:'{}'});
    if(label==='unbound task executor evidence') addClean('task_executor_evidence',{attempt_id:'missing-attempt'});
    if(label==='reserved task thread') addClean('task_executor_thread_reservations',{attempt_id:'executor-a',transport_key:'transport',thread_id:'thread'});
    if(label==='unsettled execution') addClean('delivery_role_executions',{project_id:project,objective_id:objectiveId,attempt_id:'a',state:'active',record_json:'{}'});
    if(label==='unsettled publication') { addClean('delivery_output_bindings',{project_id:project,objective_id:objectiveId,artifact_id:'artifact'}); addClean('delivery_output_publications',{intent_id:'i',artifact_id:'artifact',state:'not_applied'}); }
    if(label==='active task') clean.prepare("UPDATE tasks SET status_state='TASK_STATE_WORKING',status=?").run('{"state":"TASK_STATE_WORKING"}');
    if(label==='bad task identity') clean.prepare("UPDATE tasks SET id='other-task'").run();
    if(label==='bad task status') clean.prepare("UPDATE tasks SET status='{}'").run();
    if(label==='duplicate mapping') addClean('delivery_run_engines',{project_id:project,run_id:'other-run',engine:'concurrent-v1',objective_id:'other-objective',session_id:session});
    if(label==='same run other session') addClean('delivery_run_engines',{project_id:project,run_id:runId,engine:'concurrent-v1',objective_id:objectiveId,session_id:'other-session'});
    if(label==='publication intent mismatch') clean.prepare("UPDATE candidate_intents SET state='refused'").run();
    if(label==='cross tenant active task') addClean('tasks',{tenant:'other',owner:'orchestrator',id:'other-active',status:'{"state":"TASK_STATE_WORKING"}',status_state:'TASK_STATE_WORKING'});
    if(label==='missing required table') clean.exec('DROP TABLE writer_executions');
    if(label==='missing required column') clean.exec('ALTER TABLE tasks DROP COLUMN status_state');
    assert.deepEqual(inspectConcurrentStartupQuarantine(clean,root,project),{state:'unsafe'},label);
  }
});

test('startup quarantine predicate passes a populated production-schema fixture and rejects project-wide conflicts', { timeout: 30000 }, async (t) => {
  const fixture=await idleConcurrentServer(t,'quarantine-production-schema');
  const {runtime}=fixture, {db}=runtime.state, projectId=runtime.projectId;
  let auxiliaryMappings=[];
  const closeRuntime=runtime.close.bind(runtime);
  runtime.close=async()=>{
    if(db.open){
      for(const item of auxiliaryMappings){
        db.prepare('DELETE FROM concurrent_planner_execution_facts WHERE project_id=? AND session_id=?').run(projectId,item.sessionId);
        db.prepare('DELETE FROM delivery_planner_turns WHERE project_id=? AND session_id=?').run(projectId,item.sessionId);
        db.prepare('DELETE FROM dispatch_journal WHERE run_id=?').run(item.runId);
        db.prepare('DELETE FROM task_executor_attempts WHERE project_id=? AND objective_id=?').run(projectId,item.objectiveId);
        db.prepare('DELETE FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').run(projectId,item.runId);
        db.prepare('DELETE FROM backlog_objectives WHERE project_id=? AND objective_id=?').run(projectId,item.objectiveId);
        db.prepare('DELETE FROM delivery_run_engines WHERE project_id=? AND run_id=?').run(projectId,item.runId);
        db.prepare("DELETE FROM tasks WHERE owner='orchestrator' AND id=?").run(item.runId);
      }
      db.prepare('DELETE FROM concurrent_planner_execution_facts WHERE project_id=?').run(projectId);
      db.prepare("DELETE FROM delivery_planner_turns WHERE project_id=? AND status='active'").run(projectId);
      db.prepare('DELETE FROM concurrent_shutdown_phases WHERE project_id=?').run(projectId);
      db.prepare("DELETE FROM concurrent_delivery_runs WHERE run_id='stored-concurrent'").run();
      runtime.concurrentEngine.finishShutdown=async()=>({safeToRelease:true});
    }
    return closeRuntime();
  };
  const mapping=seedConcurrentFence(runtime);
  const objective=runtime.concurrentEngine.store.getObjective(projectId,mapping.objectiveId);
  const generation=objective.ownerGeneration;
  assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId,mapping.objectiveId).record_json),'ownerGeneration'),false);
  new LeadPlanner({store:{db,getObjective:()=>({ownerGeneration:generation})},inbox:{db,projectId,sessionId:mapping.sessionId},runTurn:async()=>{}});
  const taskStore=require('../src/durable-store').createTaskStore(runtime.state,'orchestrator');
  await taskStore.save({id:mapping.runId,contextId:`context-${mapping.runId}`,status:{state:'TASK_STATE_CANCELED'},history:[],artifacts:[],metadata:{}},call());
  db.prepare("UPDATE tasks SET status=?,status_state='TASK_STATE_CANCELED' WHERE tenant='' AND owner='orchestrator' AND id=?")
    .run('{"state":"TASK_STATE_CANCELED"}',mapping.runId);
  auxiliaryMappings=await seedPausedAndOrphanMappings(runtime,taskStore);
  db.prepare("INSERT INTO concurrent_shutdown_phases(project_id,phase_json) VALUES(?,?)")
    .run(projectId,JSON.stringify({phase:'draining',attempts:[],identities:[]}));
  const turn={projectId,sessionId:mapping.sessionId,turnId:'planner-turn',providerThreadId:'planner-thread',providerScope:'planner-scope',ownerGeneration:generation};
  db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,pins_json,result_json,started_at,updated_at)
    VALUES(?,?,?,?,?,'active',?,NULL,1,1)`).run(projectId,turn.sessionId,turn.providerScope,turn.providerThreadId,turn.turnId,JSON.stringify({ownerGeneration:generation}));
  const pid=4000000+Math.floor(Math.random()*1000);
  assert.throws(()=>process.kill(-pid,0),{code:'ESRCH'},'fixture PID/PGID must be definitely nonexistent');
  db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json,start_json,terminal_json)
    VALUES(?,?,?,?,?,NULL)`).run(projectId,turn.sessionId,turn.turnId,JSON.stringify(turn),JSON.stringify({threadId:turn.providerThreadId,processIdentity:{pid,pgid:pid,startTime:'1'}}));
  db.prepare(`INSERT INTO backlog_attempts(project_id,objective_id,attempt_id,task_id,attempt_no,record_json,contract_json,terminal_digest,release_facts_json)
    VALUES(?,?,?,'task-1',1,?,'{}','digest-1',NULL)`).run(projectId,mapping.objectiveId,'attempt-1','{"state":"succeeded"}');
  db.prepare(`INSERT INTO backlog_claims(project_id,objective_id,claim_id,task_id,attempt_id,role,fencing_token,record_json)
    VALUES(?,?,?,'task-1','attempt-1','engineer',1,?)`).run(projectId,mapping.objectiveId,'claim-1','{"state":"released"}');
  seedConcurrentEffects(db,projectId,mapping.objectiveId,{publicationStates:['applied']});
  seedAuthoritativeEffects(db,projectId,mapping,{intentState:'applied'});
  const roleRecord={projectId,objectiveId:mapping.objectiveId,attemptId:'role-attempt',state:'terminal',effectsSettled:true};
  db.prepare(`INSERT INTO delivery_role_executions(attempt_id,project_id,objective_id,task_id,fencing_token,provider_context_id,external_task_id,role_id,request_digest,settings_digest,state,record_json,created_at,updated_at)
    VALUES('role-attempt',?,?,'role-task',1,'context','external','engineer','request','settings','terminal',?,'now','now')`)
    .run(projectId,mapping.objectiveId,JSON.stringify(roleRecord));
  db.prepare(`INSERT INTO concurrent_controller_fences(project_id,objective_id,owner_generation,control_revision,status,projection_json,projection_digest,created_at)
    VALUES(?,?,?,1,'safe',?,?, 'now')`).run(projectId,mapping.objectiveId,generation,'{"safeToRelease":true}','digest');
  const copy=fs.mkdtempSync(path.join(os.tmpdir(),'quarantine-db-copy-'));
  t.after(()=>fs.rmSync(copy,{recursive:true,force:true}));
  const copiedFile=path.join(copy,'state.sqlite');
  await db.backup(copiedFile);
  const readonlyDb=new (require('better-sqlite3'))(copiedFile,{readonly:true});
  t.after(()=>readonlyDb.close());
  const rows=()=>Object.fromEntries(readonlyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({name})=>[name,readonlyDb.prepare(`SELECT * FROM ${name}`).all()]));
  const before=rows();
  assert.deepEqual(inspectConcurrentStartupQuarantine(readonlyDb,fixture.options.workspace,projectId),
    {state:'quarantine',runId:mapping.runId,objectiveId:mapping.objectiveId,sessionId:mapping.sessionId});
  assert.deepEqual(rows(),before);
  const hostileCases=[
    ['same run other session', (caseDb)=>assert.throws(()=>caseDb.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at) VALUES(?,?,'concurrent-v1','other','other-session','{}',1,1)`).run(projectId,mapping.runId),/UNIQUE|PRIMARY KEY/i)],
    ['foreign mapping',(caseDb)=>caseDb.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at) VALUES('foreign','foreign-run','legacy','o','s','{}',1,1)`).run()],
    ['unknown engine',(caseDb)=>caseDb.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at) VALUES(?,?,'mystery','o','s','{}',1,1)`).run(projectId,'unknown-run')],
    ['second objective unresolved claim',(caseDb)=>caseDb.prepare(`INSERT INTO backlog_claims(project_id,objective_id,claim_id,task_id,attempt_id,role,fencing_token,record_json) VALUES(?,?,'bad','task','attempt','engineer',5,'{"state":"active"}')`).run(projectId,'other-objective')],
    ['mismatched publication intent',(caseDb)=>caseDb.prepare("UPDATE candidate_intents SET state='refused' WHERE project_id=?").run(projectId)],
    ['objective JSON owner generation mismatch',(caseDb)=>{
      const row=caseDb.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId,mapping.objectiveId);
      const record=JSON.parse(row.record_json); record.ownerGeneration=generation+1;
      caseDb.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(JSON.stringify(record),projectId,mapping.objectiveId);
    }],
    ['planner pins owner generation mismatch',(caseDb)=>{
      const row=caseDb.prepare('SELECT pins_json FROM delivery_planner_turns WHERE project_id=? AND turn_id=?').get(projectId,'planner-turn');
      const pins=JSON.parse(row.pins_json); pins.ownerGeneration=generation+1;
      caseDb.prepare('UPDATE delivery_planner_turns SET pins_json=? WHERE project_id=? AND turn_id=?').run(JSON.stringify(pins),projectId,'planner-turn');
    }],
    ['cross tenant active task',(caseDb)=>caseDb.prepare("UPDATE tasks SET tenant='other',status_state='TASK_STATE_WORKING',status=? WHERE owner='orchestrator' AND id=?").run('{"state":"TASK_STATE_WORKING"}',mapping.runId)],
    ['mapped dispatch not finished',(caseDb)=>caseDb.prepare(`INSERT INTO dispatch_journal(attempt_id,run_id,assignment_id,role,sandbox,context_id,state,created_at,updated_at) VALUES('dispatch-1',?,'assignment','engineer','sandbox','context','active','now','now')`).run(mapping.runId)],
    ['unknown writer state',(caseDb)=>{caseDb.pragma('ignore_check_constraints = ON'); caseDb.prepare(`INSERT INTO writer_executions(execution_id,workspace,role,task_id,context_id,state,created_at,updated_at) VALUES('writer-1',?,'engineer','task','context','mystery','now','now')`).run(fs.realpathSync(fixture.options.workspace));}],
    ['missing required table',(caseDb)=>caseDb.exec('DROP TABLE writer_executions')],
    ['missing required column',(caseDb)=>caseDb.exec('ALTER TABLE backlog_attempts DROP COLUMN terminal_digest')],
    ['paused run not paused',(caseDb)=>caseDb.prepare("UPDATE concurrent_delivery_runs SET status='running' WHERE project_id=? AND run_id=?").run(projectId,auxiliaryMappings[0].runId)],
    ['paused planner unsettled',(caseDb)=>caseDb.prepare("UPDATE delivery_planner_turns SET status='active' WHERE project_id=? AND session_id=?").run(projectId,auxiliaryMappings[0].sessionId)],
    ['paused task active',(caseDb)=>caseDb.prepare("UPDATE tasks SET status_state='TASK_STATE_WORKING',status=? WHERE owner='orchestrator' AND id=?").run('{"state":"TASK_STATE_WORKING"}',auxiliaryMappings[0].runId)],
    ['paused unsettled claim',(caseDb)=>caseDb.prepare(`INSERT INTO backlog_claims(project_id,objective_id,claim_id,task_id,attempt_id,role,fencing_token,record_json)
      VALUES(?,?, 'paused-bad','task','attempt','engineer',7,'{"state":"active"}')`).run(projectId,auxiliaryMappings[0].objectiveId)],
    ['orphan deterministic objective mismatch',(caseDb)=>caseDb.prepare('UPDATE delivery_run_engines SET objective_id=? WHERE project_id=? AND run_id=?').run('wrong-objective',projectId,auxiliaryMappings[1].runId)],
    ['orphan terminal proof mismatch',(caseDb)=>{
      const row=caseDb.prepare('SELECT result_json FROM delivery_planner_turns WHERE project_id=? AND session_id=?').get(projectId,auxiliaryMappings[1].sessionId);
      const result=JSON.parse(row.result_json); result.terminalProof.turnId='wrong-terminal-turn';
      caseDb.prepare('UPDATE delivery_planner_turns SET result_json=? WHERE project_id=? AND session_id=?').run(JSON.stringify(result),projectId,auxiliaryMappings[1].sessionId);
    }],
    ['orphan dispatch row',(caseDb)=>caseDb.prepare(`INSERT INTO dispatch_journal(attempt_id,run_id,assignment_id,role,sandbox,context_id,state,created_at,updated_at)
      VALUES('orphan-dispatch',?,'assignment','engineer','sandbox','context','finished','now','now')`).run(auxiliaryMappings[1].runId)],
    ['orphan unsettled task executor attempt',(caseDb)=>caseDb.prepare(`INSERT INTO task_executor_attempts
      (attempt_id,project_id,objective_id,task_id,fencing_token,context_id,request_digest,journal_id,transport_key,state,external_task_id,record_json,created_at,updated_at)
      VALUES('orphan-attempt',?,?,?,1,'context','digest','journal','transport','uncertain',NULL,?,1,1)`)
      .run(projectId,auxiliaryMappings[1].objectiveId,auxiliaryMappings[1].runId,JSON.stringify({attemptId:'orphan-attempt',projectId,objectiveId:auxiliaryMappings[1].objectiveId,taskId:auxiliaryMappings[1].runId}))],
    ['active task from another owner',(caseDb)=>caseDb.prepare(`INSERT INTO tasks(tenant,owner,id,context_id,status_last_updated,status_state,status,artifacts,history,metadata,protocol_version)
      VALUES('','orch-explorer','other-owner-active','context',1,'TASK_STATE_WORKING','{"state":"TASK_STATE_WORKING"}','[]','[]','{}','1.0')`).run()],
  ];
  for(const [label,insert] of hostileCases) {
    const cloneFile=path.join(copy,`${label.replaceAll(' ','-')}.sqlite`); fs.copyFileSync(copiedFile,cloneFile);
    const caseDb=new (require('better-sqlite3'))(cloneFile);
    insert(caseDb);
    if(label!=='same run other session') assert.deepEqual(inspectConcurrentStartupQuarantine(caseDb,fixture.options.workspace,projectId),{state:'unsafe'},label);
    caseDb.close();
  }
  await fixture.runtime.close();
  let providerCalls=0, pinCalls=0, engineCalls=0, orchestrationCalls=0;
  const quarantineOptions={...fixture.options,stateFile:copiedFile,port:0,
    listenImpl:(application,port,host,callback)=>application.listen(port,host,callback),
    appServer:appServer({async start(){providerCalls++;},async getAccount(){providerCalls++;return {account:{type:'chatgpt'}};},async close(){providerCalls++;}}),
    providerIdentityPinFactory(){pinCalls++;throw new Error('must not pin');},
    concurrentEngineFactory(){engineCalls++;throw new Error('must not construct');},
    orchestratorFactory(){orchestrationCalls++;throw new Error('must not orchestrate');}};
  const quarantined=await startServer(quarantineOptions);
  assert.equal(quarantined.quarantined,true);
  assert.throws(()=>acquireStateLock(copiedFile),/in use/i);
  assert.throws(()=>acquireWorkspaceLock(fixture.options.workspace,{lockDir:fixture.options.workspaceLockDir}),/in use/i);
  const token=fs.readFileSync(fixture.options.tokenFile,'utf8');
  for(const route of ['/control/runtime','/control/quarantine']) {
    for(const method of ['GET','HEAD']) {
      const response=await fetch(`http://127.0.0.1:${quarantined.port}${route}`,{method,headers:{authorization:`Bearer ${token}`}});
      assert.equal(response.status,200);
    }
    assert.equal((await fetch(`http://127.0.0.1:${quarantined.port}${route}`)).status,401);
  }
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) {
    const response=await fetch(`http://127.0.0.1:${quarantined.port}/control/runtime`,{method});
    assert.equal(response.status,503); assert.deepEqual(await response.json(),{error:'concurrent_startup_quarantined'});
  }
  const missing=await fetch(`http://127.0.0.1:${quarantined.port}/not-an-app-route`,{headers:{authorization:`Bearer ${token}`}});
  assert.equal(missing.status,404);
  assert.deepEqual([providerCalls,pinCalls,engineCalls,orchestrationCalls],[0,0,0,0]);
  const snapAfterServing=()=>Object.fromEntries(readonlyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({name})=>[name,readonlyDb.prepare(`SELECT * FROM ${name}`).all()]));
  assert.deepEqual(snapAfterServing(),before);
  await quarantined.close();
  const stateRelease=acquireStateLock(copiedFile); stateRelease();
  const workspaceRelease=acquireWorkspaceLock(fixture.options.workspace,{lockDir:fixture.options.workspaceLockDir}); workspaceRelease();
  assert.deepEqual(snapAfterServing(),before);
  for(const [label, mutate, tokenFile] of [
    ['missing token',null,path.join(copy,'missing-token')],
    ['unsafe phase',(db)=>db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?').run('{"phase":"prepared","attempts":[],"identities":[]}',projectId),fixture.options.tokenFile],
    ['malformed provider-closing attempt',(db)=>db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?').run(JSON.stringify({phase:'provider_closing',attempts:[{attemptId:'bad'}],identities:[]}),projectId),fixture.options.tokenFile],
  ]) {
    const negativeFile=path.join(copy,`${label.replaceAll(' ','-')}.sqlite`); fs.copyFileSync(copiedFile,negativeFile);
    if(mutate){const writable=new (require('better-sqlite3'))(negativeFile);mutate(writable);writable.close();}
    let forbidden=0;
    await assert.rejects(startServer({...quarantineOptions,stateFile:negativeFile,tokenFile,
      appServer:appServer({async start(){forbidden++;},async getAccount(){forbidden++;}})}));
    assert.equal(forbidden,0,label);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function createGitWorkspace(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Server Delivery Test');
  git('config', 'user.email', 'server-delivery@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'stable input\n');
  fs.writeFileSync(path.join(workspace, 'verify-source.js'), "'use strict';\nconst fs = require('node:fs');\nif (fs.readFileSync('source.txt', 'utf8') !== 'stable input\\n') process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'base');
}

test('direct server starts derive the normalized launcher project identity', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const runtime = await startServer({ listen: false, workspace, stateFile: ':memory:',
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    appServer: appServer(), orchestratorFactory: () => ({ async run() { return { status: 'completed' }; } }) });
  try {
    assert.equal(runtime.projectId, projectIdForWorkspace(workspace));
    assert.match(runtime.projectId, /^[0-9a-f]{10}$/);
    assert.equal(runtime.deliveryEngine, 'legacy');
  } finally {
    try { await runtime.close(); }
    catch (_) {
      runtime.httpServer?.closeAllConnections?.();
      if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      await runtime.appServer.close?.();
      if (runtime.state.db.open) await runtime.state.close();
    }
  }
});

test('legacy default composes the persisted router and completes a new A2A task on legacy', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const legacyRuns = [];
  const runtime = await startServer({ listen: false, workspace, stateFile: ':memory:',
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    appServer: appServer(), orchestratorFactory: () => ({
      async run(input) { legacyRuns.push(input); return { status: 'completed', text: 'legacy result' }; },
      async resume() { return { status: 'completed', text: 'legacy resume' }; },
    }) });
  try {
    const result = await runtime.leadAgent.requestHandler.sendMessage({ message: message('Use legacy default.'), configuration: {} }, call());
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify({ result, legacyRuns }));
    assert.equal(legacyRuns.length, 1);
    assert.equal(runtime.orchestrator.mapping(result.id).engine, 'legacy');
    assert.equal(runtime.orchestrator.mapping(result.id).projectId, runtime.projectId);
  } finally { await runtime.close(); }
});

test('configured project identity must match the exact real workspace hash', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  let started = false;
  await assert.rejects(startServer({ workspace, projectId: '0000000000', listen: false,
    appServer: appServer({ async start() { started = true; } }) }), { code: 'delivery_project_identity_invalid' });
  assert.equal(started, false);
});

test('state database mappings from another normalized project fail closed', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  const stateFile = path.join(root, 'state.sqlite');
  fs.mkdirSync(workspace);
  const seed = await openStateDatabase({ filePath: stateFile });
  seed.db.exec(`CREATE TABLE delivery_run_engines (
    project_id TEXT NOT NULL, run_id TEXT NOT NULL, engine TEXT NOT NULL, objective_id TEXT, session_id TEXT,
    request_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,run_id));
    INSERT INTO delivery_run_engines(project_id,run_id,engine,request_json,created_at,updated_at)
    VALUES('ffffffffff','foreign-run','legacy','{}',1,1);`);
  await seed.close();
  await assert.rejects(startServer({ listen: false, workspace, stateFile,
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    appServer: appServer(), orchestratorFactory: () => ({ async run() {}, async resume() {} }) }),
  { code: 'delivery_project_identity_conflict' });
  const reopened = await openStateDatabase({ filePath: stateFile });
  assert.equal(reopened.db.prepare('SELECT run_id FROM delivery_run_engines').get().run_id, 'foreign-run');
  await reopened.close();
});

test('concurrent setting fails closed when startup selects unsupported shared isolation', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  const settings = path.join(root, 'project-settings.json');
  fs.mkdirSync(workspace);
  execFileSync('git', ['-C', workspace, 'init', '-q']);
  fs.writeFileSync(settings, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  let engineFactoryCalls = 0;
  let identityFactoryCalls = 0;
  await assert.rejects(startServer({ listen: false, workspace, stateFile: ':memory:',
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    projectSettingsFile: settings, appServer: appServer({
      async execCommand() { return { exitCode: 0, stdout: '', stderr: '' }; },
      getVersion() { return 'workspace-write-fixture'; },
      async resolveExecutionPermissions() { return { mode: 'inherit', profileApi: false, writerProfile: ':read-only', sandboxMode: 'read-only' }; },
    }),
    providerIdentityPinFactory() { identityFactoryCalls += 1; throw new Error('identity must not be read'); },
    concurrentEngineFactory() { engineFactoryCalls += 1; throw new Error('engine must not construct'); },
    orchestratorFactory: () => ({ async run() {}, async resume() {} }) }),
  (error) => error.code === 'concurrent_lane_isolation_required'
    && error.message === 'Concurrent delivery requires a supported lane isolation mode (native_permissions_use_shared_workspace)');
  assert.equal(identityFactoryCalls, 0);
  assert.equal(engineFactoryCalls, 0);
});

test('default server composition routes an authenticated steer into a held real concurrent lead turn', { timeout: 20000 }, async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  const stateFile = path.join(root, 'state.sqlite');
  const storageRoot = path.join(root, 'delivery-storage');
  const settingsFile = path.join(root, 'project-settings.json');
  const roleOverridesFile = path.join(root, 'role-overrides.json');
  createGitWorkspace(workspace);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fake-account-id', access_token: 'fake-token' } }));
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: { coordinator: { model: 'test-model', effort: 'low', fastMode: 'off' }, verifier: { model: 'test-model', effort: 'low', fastMode: 'off' } } }));

  const leadEntered = deferred();
  const releaseLead = deferred();
  const workerEntered = deferred();
  const releaseWorker = deferred();
  let leadTurns = 0;
  let ignoreWorkerAbort = false;
  const calls = [];
  const fakeAppServer = appServer({
    getCodexHome: () => codexHome,
    getVersion: () => 'server-delivery-test/1',
    async execCommand({ command, cwd }) {
      try {
        const stdout = execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { exitCode: 0, stdout, stderr: '' };
      } catch (error) {
        return { exitCode: Number.isInteger(error.status) ? error.status : 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || error.message || '') };
      }
    },
    resolveExecutionPermissions: async () => ({ mode: 'inherit', profileApi: false, writerProfile: null, sandboxMode: 'workspace-write',
      sandboxWorkspaceWrite: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
      approvalPolicy: 'on-request', approvalsReviewer: 'user' }),
    async prepareThread({ role }) { return { threadId: `${role.id || role.name}-thread`, codexHome }; },
    async run(options) {
      const roleId = options.role.id || options.role.name;
      calls.push(roleId);
      const turnId = `turn-${roleId}-${calls.length}`;
      const threadId = options.threadId || `${roleId}-thread`;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      if (roleId === 'coordinator') {
        leadTurns += 1;
        if (leadTurns === 1) {
          leadEntered.resolve();
          await releaseLead.promise;
        }
        const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
        const runId = runtime.concurrentEngine.activeRuns()[0].runId;
        const mapping = runtime.orchestrator.mapping(runId);
        const task = { schemaVersion: 'delivery/v1', projectId: runtime.projectId, objectiveId: mapping.objectiveId,
          taskId: 'integration-engineer', revision: 1, role: 'engineer', kind: 'implementation',
          objective: 'Hold the worker while owner steering is accepted.', priority: 1, dependencies: [],
          productWritePaths: ['worker-output.txt'], readScope: { kind: 'known', paths: ['source.txt'] },
          scratchWriteRoots: ['.scratch/integration-engineer'], resourceClaims: [],
          publicationAuthority: { state: 'unknown' }, state: 'queued' };
        const delta = { schemaVersion: 'delivery/v1', expectedPlanRevision: prompt.pins.planRevision,
          expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
          expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
          tasks: [{ task }], dependencies: [] };
        return { threadId, turnId, status: 'completed', text: JSON.stringify({ expected: prompt.pins, delta,
          dialogue: 'Start the scoped engineer task.', recovery: null, ownerDecision: null }), usage: {}, permissionEvents: [],
          execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
      }
      if (roleId === 'engineer') {
        workerEntered.resolve();
        if (ignoreWorkerAbort) await releaseWorker.promise;
        else await Promise.race([releaseWorker.promise, new Promise((resolve) => options.signal?.addEventListener('abort', resolve, { once: true }))]);
        return { threadId, turnId, status: 'completed', text: JSON.stringify({ outcome: 'completed', summary: 'Worker turn settled after cancel.',
          filesChanged: [], filesInspected: ['source.txt'], checks: [{ command: 'inspect source.txt', result: 'passed', detail: 'Inspected the frozen input.' }],
          risks: [], scopeExpansion: [], decisionRequest: null }), usage: {}, permissionEvents: [],
          execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
      }
      const turnText = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.', filesChanged: [],
        filesInspected: ['source.txt'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against the frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null });
      return { threadId, turnId, status: 'completed', text: turnText, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
    },
  });

  let runtime;
  try {
    runtime = await startServer({ port: 0, workspace, stateFile, deliveryStorageRoot: storageRoot,
      tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
      projectSettingsFile: settingsFile, roleOverridesFile, appServer: fakeAppServer,
      orchestratorFactory: (options) => new LeadOrchestrator(options),
    });
    assert.equal(runtime.deliveryEngine, 'concurrent-v1');
    assert.equal(runtime.concurrentEngine, runtime.orchestrator.concurrentEngine);
    assert.equal(runtime.writerIsolation.mode, 'cooperative');
    assert.equal(runtime.writerIsolation.reason, 'trusted_native_workspace_write_cooperative');
    assert.equal(runtime.writerIsolation.confinement, 'none');
    assert.equal(runtime.writerIsolation.inherited, true);
    const request = runtime.leadAgent.requestHandler.sendMessage({ message: message('Inspect the current candidate.'), configuration: {} }, call());
    let guard;
    const taskEnded = request.then((result) => {
      throw new Error(`Lead task ended before the fake provider turn was held: ${result.status?.state || 'unknown'}`);
    });
    const diagnosticTimeout = new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(JSON.stringify({
      tasks: runtime.state.db.prepare('SELECT id,status_state FROM tasks WHERE owner=?').all('orchestrator'),
      mappings: runtime.orchestrator.mappings(), active: runtime.concurrentEngine.activeRuns(),
      plannerTurns: runtime.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').all(),
      roles: runtime.concurrentEngine.roleService.projection(), calls,
      objective: runtime.concurrentEngine.store.getObjective(runtime.projectId, runtime.orchestrator.mappings()[0]?.objectiveId),
    }))), 3000); });
    try { await Promise.race([leadEntered.promise, taskEnded, diagnosticTimeout]); }
    finally { clearTimeout(guard); }
    const runId = runtime.concurrentEngine.activeRuns()[0]?.runId;
    assert.ok(runId);
    releaseLead.resolve();
    await workerEntered.promise;
    const status = runtime.concurrentEngine.controlStatus(runId);
    const token = fs.readFileSync(path.join(root, 'token'), 'utf8').trim();
    const baseUrl = `http://127.0.0.1:${runtime.port}`;
    const getResponse = await fetch(`${baseUrl}/control/delivery/${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(getResponse.status, 200);
    const receivedStatus = await getResponse.json();
    assert.equal(receivedStatus.projectId, runtime.projectId);
    assert.equal(receivedStatus.objectiveId, status.objectiveId);
    const body = { runId, projectId: runtime.projectId, sessionId: status.sessionId, objectiveId: status.objectiveId,
      messageId: 'integration-steer-1', text: 'Continue with the candidate review.',
      expectedPlanRevision: status.revisions.planRevision, expectedGoalRevision: status.revisions.goalRevision,
      expectedControlRevision: status.revisions.controlRevision };
    const steerResponse = await fetch(`${baseUrl}/control/delivery/${encodeURIComponent(runId)}/steer`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(steerResponse.status, 200);
    const acknowledgement = await steerResponse.json();
    assert.equal(acknowledgement.acknowledged, true);
    assert.equal(acknowledgement.state, 'received');
    assert.equal(acknowledgement.messageId, body.messageId);
    assert.ok(calls.includes('engineer'));
    assert.equal(calls.includes('verifier'), false);
    ignoreWorkerAbort = true;
    await assert.rejects(runtime.close(), (error) => ['server_shutdown_drain_unsafe', 'concurrent_shutdown_unsafe'].includes(error.code));
    assert.equal(runtime.state.db.open, true);
    assert.throws(() => acquireWorkspaceLock(workspace, { lockDir: path.join(root, 'workspace-locks') }), /workspace .* is in use/i);
    releaseWorker.resolve();
    ignoreWorkerAbort = false;
    await assert.rejects(runtime.close(), { code: 'concurrent_shutdown_unsafe' });
    assert.equal(runtime.state.db.open, true);
    assert.throws(() => acquireWorkspaceLock(workspace, { lockDir: path.join(root, 'workspace-locks') }), /workspace .* is in use/i);
    assert.equal(runtime.orchestrator.mapping(runId).engine, 'concurrent-v1');
    assert.ok(runtime.concurrentEngine.controlStatus(runId).messages.some((item) => item.messageId === body.messageId));
  } finally {
    releaseLead.resolve();
    if (runtime) {
      try { await runtime.close(); }
      catch (_) {
        runtime.httpServer?.closeAllConnections?.();
        if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
        await runtime.appServer.close?.();
        if (runtime.state.db.open) await runtime.state.close();
      }
    }
  }
});

async function idleConcurrentServer(t, name = 'project', provider = {}, {
  executionPermissions = 'inherit', legacyRows = [], concurrentEngineFactory,
  deliveryEngine = 'concurrent-v1', seedLegacyCandidates = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-delivery-engine-'));
  const workspace = path.join(root, name);
  const settingsFile = path.join(root, 'settings.json');
  const roleOverridesFile = path.join(root, 'roles.json');
  createGitWorkspace(workspace);
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: { coordinator: { model: 'test-model', effort: 'low', fastMode: 'off' }, verifier: { model: 'test-model', effort: 'low', fastMode: 'off' } } }));
  const calls = [];
  const permissionCalls = [];
  fs.mkdirSync(path.join(root, 'fake-home'));
  const identity = { accountId: 'fake-account', codexHome: path.join(root, 'fake-home') };
  const options = { listen: true, port: 0, workspace, stateFile: path.join(root, 'state.sqlite'),
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    deliveryStorageRoot: path.join(root, 'delivery-storage'), projectSettingsFile: settingsFile, roleOverridesFile,
    autoResume: false, appServer: appServer({
      getVersion: () => 'server-delivery-test/1',
      async execCommand(request) {
        permissionCalls.push(request);
        const { command, cwd } = request;
        try {
          return { exitCode: 0, stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
        } catch (error) {
          return { exitCode: error.status || 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
        }
      },
      resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
      getCodexHome: () => identity.codexHome,
      async prepareThread({ role }) { return { threadId: `${role.id || role.name}-thread`, codexHome: identity.codexHome }; },
      async run() { throw new Error('Unexpected provider work'); },
      ...provider,
    }),
    providerIdentityPinFactory: () => ({ providerIdentity: identity, providerIdentityFor: () => identity }),
    ...(concurrentEngineFactory ? { concurrentEngineFactory } : {}),
    orchestratorFactory: () => ({
      async run(input) { calls.push(input.runId); return { status: 'completed', text: 'legacy result' }; },
      async resume() { return { status: 'completed' }; },
    }),
  };
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions, deliveryEngine }));
  if (legacyRows.length || seedLegacyCandidates) {
    const seeded = await openStateDatabase({ filePath: options.stateFile });
    if (seedLegacyCandidates) {
      seeded.db.exec(`CREATE TABLE candidates (
        candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL,
        base_commit TEXT NOT NULL, head TEXT NOT NULL, branch TEXT NOT NULL, head_moved INTEGER NOT NULL,
        manifest_json TEXT NOT NULL, diff_artifact_id TEXT, truncated INTEGER NOT NULL,
        acceptance_json TEXT, integrity_hash TEXT NOT NULL, created_at TEXT NOT NULL
      )`);
      seeded.db.prepare(`INSERT INTO candidates(candidate_id,run_id,plan_revision_id,base_commit,head,branch,
        head_moved,manifest_json,diff_artifact_id,truncated,acceptance_json,integrity_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-candidate', 'legacy-run', 'legacy-plan', 'base', 'head',
        'legacy-branch', 0, '{}', null, 0, null, 'legacy-integrity', 'legacy-created');
    }
    const insertTask = seeded.db.prepare(`INSERT INTO tasks(tenant,owner,id,context_id,status_last_updated,status_state,status,artifacts,history,metadata,protocol_version)
      VALUES('','orchestrator',?,?,?,?,'{}','[]','[]','{}','1.0')`);
    for (const row of legacyRows) {
      insertTask.run(row.id, `context-${row.id}`, Date.now(), row.state);
      if (row.mapped) {
        seeded.db.exec(`CREATE TABLE IF NOT EXISTS delivery_run_engines (
          project_id TEXT NOT NULL, run_id TEXT NOT NULL, engine TEXT NOT NULL,
          objective_id TEXT, session_id TEXT, request_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,run_id))`);
        seeded.db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
          VALUES(?,?,'legacy',?,?, '{}',1,1)`)
          .run(projectIdForWorkspace(workspace), row.id, `objective-${row.id}`, `session-${row.id}`);
      }
    }
    await seeded.close();
  }
  const runtime = await startServer(options);
  t.after(async () => {
    try { await runtime.close(); }
    finally {
      // Failed assertions must not leave disposable HTTP/state handles alive.
      runtime.httpServer.closeAllConnections();
      if (runtime.httpServer.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      if (runtime.state.db.open) await runtime.state.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { runtime, root, options, calls, permissionCalls, settingsFile };
}

test('Legacy startup keeps the legacy candidates schema and routes new runs to Legacy', async (t) => {
  const fx = await idleConcurrentServer(t, 'legacy-candidates', {}, { deliveryEngine: 'legacy', seedLegacyCandidates: true });
  const { db } = fx.runtime.state;
  assert.equal(fx.runtime.deliveryEngine, 'legacy');
  assert.equal(fx.runtime.concurrentEngine, null);
  const columns = db.prepare('PRAGMA table_info(candidates)').all().map((row) => row.name);
  assert.ok(columns.includes('run_id'));
  assert.equal(columns.includes('project_id'), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE candidate_id='legacy-candidate'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='concurrent_candidates'").get().count, 0);
  assert.deepEqual(await fx.runtime.orchestrator.run({ runId: 'legacy-new-run', goal: 'Use the Legacy engine.' }),
    { status: 'completed', text: 'legacy result' });
  assert.equal(fx.runtime.orchestrator.mapping('legacy-new-run').engine, 'legacy');
});

test('Concurrent startup uses concurrent_candidates beside the legacy candidates table', async (t) => {
  const fx = await idleConcurrentServer(t, 'concurrent-candidates', {}, { seedLegacyCandidates: true });
  const { db } = fx.runtime.state;
  assert.equal(fx.runtime.deliveryEngine, 'concurrent-v1');
  assert.ok(fx.runtime.concurrentEngine);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE candidate_id='legacy-candidate'").get().count, 1);
  const legacyColumns = db.prepare('PRAGMA table_info(candidates)').all().map((row) => row.name);
  assert.ok(legacyColumns.includes('run_id'));
  assert.equal(legacyColumns.includes('project_id'), false);
  const concurrentColumns = db.prepare('PRAGMA table_info(concurrent_candidates)').all().map((row) => row.name);
  assert.ok(concurrentColumns.includes('project_id'));
  assert.ok(concurrentColumns.includes('integration_generation'));
  const candidate = fx.runtime.concurrentEngine.candidateStore.createCandidate({ candidateId: 'candidate-concurrent-test',
    projectId: fx.runtime.projectId, objectiveId: 'objective-prefix-test', integrationGeneration: 1,
    sourceAttemptId: 'attempt-prefix-test', environmentDigest: `sha256:${'a'.repeat(64)}`, checkIdentity: 'checks-prefix-test' });
  assert.equal(candidate.candidateId, 'candidate-concurrent-test');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM concurrent_candidates').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE candidate_id='legacy-candidate'").get().count, 1);
});

test('concurrent engine admission recognizes persisted terminal legacy task states', { timeout: 60000 }, async (t) => {
  const terminalStates = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'];
  const cases = [
    ...terminalStates.map((state) => ({ state, mapped: false })),
    ...terminalStates.map((state) => ({ state, mapped: true })),
    ...['TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_UNKNOWN'].map((state) => ({ state, mapped: false, blocked: true })),
  ];
  for (const [index, fixture] of cases.entries()) {
    await t.test(`${fixture.state} ${fixture.mapped ? 'mapped' : 'startup task'}${fixture.blocked ? ' remains blocked' : ' admits concurrent engine'}`, async (subtest) => {
      let engineCalls = 0;
      let modelCalls = 0;
      const concurrentEngineFactory = () => ({
        register() {},
        async recoverStoredRuns() { return []; },
        async run() { engineCalls += 1; return { status: 'completed' }; },
        async resume() { engineCalls += 1; return { status: 'completed' }; },
        fenceShutdown() {},
        async prepareShutdown() {},
        beginProviderShutdown() {},
        async finishShutdown() { return { safeToRelease: true }; },
        async shutdown() { return { safeToRelease: true }; },
      });
      const fx = await idleConcurrentServer(subtest, `terminal-fence-${index}`, {
        async run() { modelCalls += 1; throw new Error('Model calls are not part of this admission test'); },
      }, { legacyRows: [{ id: `legacy-${index}`, state: fixture.state, mapped: fixture.mapped }], concurrentEngineFactory });
      const run = { runId: `new-${index}`, goal: 'Admit only when prior legacy work is terminal.' };
      if (fixture.blocked) {
        await assert.rejects(fx.runtime.orchestrator.run(run), { code: 'delivery_engine_busy' });
        assert.equal(engineCalls, 0);
      } else {
        assert.deepEqual(await fx.runtime.orchestrator.run(run), { status: 'completed' });
        assert.equal(engineCalls, 1);
        assert.equal(fx.runtime.orchestrator.mapping(run.runId).engine, 'concurrent-v1');
      }
      assert.equal(modelCalls, 0);
    });
  }
});

test('restart excludes a persisted concurrent task from the startup legacy fence on first HTTP intake', { timeout: 20000 }, async (t) => {
  const fixture = await idleConcurrentServer(t, 'restart-concurrent-task');
  const stored = seedConcurrentFence(fixture.runtime);
  const taskStore = require('../src/durable-store').createTaskStore(fixture.runtime.state, 'orchestrator');
  await taskStore.save({ id: stored.runId, contextId: `context-${stored.runId}`,
    status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, history: [], artifacts: [],
    metadata: { pause: { kind: 'stopped' } } }, call());
  await fixture.runtime.close();
  const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
  try {
    seeded.db.exec(`CREATE TABLE delivery_planner_turns (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
      pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id))`);
    seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,
      status,pins_json,result_json,started_at,updated_at) VALUES(?,?,?,?,?,'unknown','{}',NULL,1,1)`)
      .run(fixture.runtime.projectId, stored.sessionId, 'fake-scope', 'fake-thread', 'unknown-prestart-turn');
  } finally { await seeded.close(); }

  let engineCalls = 0;
  fixture.options.concurrentEngineFactory = () => ({
    register() {},
    async recoverStoredRuns() { return []; },
    async run() { engineCalls += 1; return { status: 'completed', text: 'admitted' }; },
    async resume() { throw new Error('resume is not expected'); },
    fenceShutdown() {},
    async prepareShutdown() {},
    beginProviderShutdown() {},
    async finishShutdown() { return { safeToRelease: true }; },
    async shutdown() { return { safeToRelease: true }; },
  });
  const restarted = await startServer(fixture.options);
  t.after(async () => { await restarted.close(); });
  const token = fs.readFileSync(fixture.options.tokenFile, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${restarted.port}/orchestrator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'http-intake', contextId: '', taskId: '', role: 'ROLE_USER',
        parts: [{ text: 'Start a new concurrent task.' }], metadata: {} }, configuration: {} } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(engineCalls, 1, JSON.stringify(result));
  assert.equal(result.error, undefined, JSON.stringify(result));
  const newMapping = restarted.orchestrator.mappings({ engine: 'concurrent-v1' }).find((mapping) => mapping.runId !== stored.runId);
  assert.ok(newMapping);
  assert.equal(restarted.orchestrator.mappings({ engine: 'concurrent-v1' }).length, 2);
  assert.equal(restarted.state.db.prepare('SELECT status_state FROM tasks WHERE owner=? AND id=?')
    .get('orchestrator', stored.runId).status_state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(restarted.state.db.prepare('SELECT status FROM delivery_planner_turns WHERE turn_id=?')
    .get('unknown-prestart-turn').status, 'unknown');
});

test('restart settles a proven terminal schema failure before first HTTP intake', { timeout: 20000 }, async (t) => {
  const providerCalls = [];
  const fixture = await idleConcurrentServer(t, 'restart-interrupted-shutdown', {
    async _request(method, params) {
      assert.equal(method, 'thread/read');
      assert.equal(params.threadId, 'coordinator-thread');
      return { thread: { id: params.threadId, turns: [{ id: 'failed-schema-turn', status: 'failed',
        error: { message: JSON.stringify({ type: 'error', status: 400, error: {
          message: "Invalid schema for response_format 'codex_output_schema': 'schema.properties.expected.properties' is required for object schemas.",
          type: 'invalid_request_error', param: 'text.format.schema', code: 'invalid_json_schema',
        } }) },
        items: [{ type: 'userMessage', id: 'user-message' }] }] } };
    },
    async run(options) {
      const roleId = options.role.id || options.role.name;
      providerCalls.push(roleId);
      if (roleId === 'coordinator') {
        const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
        return turnResult(options, JSON.stringify({ expected: pins, delta: null,
          dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }));
      }
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.verifyCandidate(), true);
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.',
        filesChanged: [], filesInspected: ['source.txt'],
        checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null }));
    },
  });
  const stored = seedConcurrentFence(fixture.runtime);
  const identity = fixture.options.providerIdentityPinFactory().providerIdentity;
  const providerScope = `lead:${fixture.runtime.projectId}:${stored.sessionId}:${identity.accountId}:${identity.codexHome}`;
  const turnId = 'lead-known-terminal-schema-failure';
  const threadId = 'coordinator-thread';
  const settings = { threadId, codexHome: identity.codexHome, accountId: identity.accountId,
    transportKey: providerScope, settings: {}, settingsDigest: 'test-settings' };
  fixture.runtime.state.db.prepare("UPDATE concurrent_delivery_runs SET status='running' WHERE project_id=? AND run_id=?")
    .run(fixture.runtime.projectId, stored.runId);
  fixture.runtime.state.db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
    VALUES(?,?,'concurrent-v1','dangling-objective','dangling-session','{}',1,1)`)
    .run(fixture.runtime.projectId, 'failed-first-request');
  fixture.runtime.state.db.prepare(`UPDATE concurrent_delivery_runs SET lead_thread_id=?,lead_codex_home=?,lead_settings_json=?
    WHERE project_id=? AND run_id=?`).run(threadId, identity.codexHome, JSON.stringify(settings), fixture.runtime.projectId, stored.runId);
  const taskStore = require('../src/durable-store').createTaskStore(fixture.runtime.state, 'orchestrator');
  await taskStore.save({ id: stored.runId, contextId: `context-${stored.runId}`,
    status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, history: [], artifacts: [],
    metadata: { pause: { kind: 'stopped' } } }, call());
  await fixture.runtime.close();

  const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
  try {
    seeded.db.exec(`CREATE TABLE delivery_planner_turns (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
      pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id))`);
    seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,
    pins_json,result_json,started_at,updated_at) VALUES(?,?,?,?,?,'unknown',?,?,1,1)`)
      .run(fixture.runtime.projectId, stored.sessionId, providerScope, threadId, turnId,
        JSON.stringify({ ownerGeneration: 0 }), JSON.stringify({ errorCode: 'turn_error', preDispatchSource: null,
          providerFailure: { failureClass: 'domain_failure', status: 'failed' } }));
    const oldProcessIdentity = { pid: 99999999, pgid: 99999999, startTime: '1' };
    seeded.db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json,start_json,terminal_json)
      VALUES(?,?,?,?,?,NULL)`).run(fixture.runtime.projectId, stored.sessionId, turnId, JSON.stringify({
      projectId: fixture.runtime.projectId, sessionId: stored.sessionId, turnId, providerThreadId: threadId,
      providerScope, ownerGeneration: 0,
    }), JSON.stringify({ threadId, processIdentity: oldProcessIdentity }));
    seeded.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?')
      .run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities: [oldProcessIdentity] }), fixture.runtime.projectId);
  } finally { await seeded.close(); }

  const restarted = await startServer(fixture.options);
  t.after(async () => { await restarted.close(); });
  const token = fs.readFileSync(fixture.options.tokenFile, 'utf8').trim();
  const request = fetch(`http://127.0.0.1:${restarted.port}/orchestrator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'after-shutdown-recovery', contextId: '', taskId: '', role: 'ROLE_USER',
        parts: [{ text: 'Confirm the current source is acceptable.' }], metadata: {} }, configuration: {} } }),
  });
  let responseTimer;
  const response = await Promise.race([request, new Promise((_, reject) => {
    responseTimer = setTimeout(() => reject(new Error(JSON.stringify({ providerCalls, active: restarted.concurrentEngine.activeRuns(),
      controllers: [...restarted.concurrentEngine.controllers.entries()].map(([id, controller]) => ({ id, status: controller.status() })),
      planner: restarted.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').all(),
      mappings: restarted.orchestrator.mappings() }))), 5000);
  })]).finally(() => clearTimeout(responseTimer));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.result?.task?.status?.state, 'TASK_STATE_COMPLETED', JSON.stringify(result));
  assert.equal(restarted.concurrentEngine.getRunDigest(result.result.task.id)?.disposition, 'accepted');
  assert.ok(providerCalls.includes('coordinator'));
  assert.ok(providerCalls.includes('verifier'));
  assert.equal(restarted.state.db.prepare('SELECT status FROM delivery_planner_turns WHERE turn_id=?').get(turnId).status, 'reconciled_no_effect');
  assert.equal(JSON.parse(restarted.state.db.prepare('SELECT result_json FROM delivery_planner_turns WHERE turn_id=?').get(turnId).result_json)
    .originalResult.errorCode, 'turn_error');
  assert.equal(JSON.parse(restarted.state.db.prepare('SELECT result_json FROM delivery_planner_turns WHERE turn_id=?').get(turnId).result_json)
    .source, 'codex_app_server.thread_read');
  assert.equal(JSON.parse(restarted.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?')
    .get(restarted.projectId).phase_json).phase, 'released');
  assert.equal(restarted.state.db.prepare('SELECT status_state FROM tasks WHERE owner=? AND id=?')
    .get('orchestrator', stored.runId).status_state, 'TASK_STATE_INPUT_REQUIRED');
});

for (const rejectedPlanCode of ['planner_output_invalid', 'path_unsafe']) test(`restart settles a completed rejected plan for a paused objective before first HTTP intake: ${rejectedPlanCode}`, { timeout: 20000 }, async (t) => {
  const providerCalls = [];
  const fixture = await idleConcurrentServer(t, 'restart-rejected-completed-plan', {
    async _request(method, params) {
      assert.equal(method, 'thread/read');
      assert.equal(params.threadId, 'coordinator-thread');
      return { thread: { id: params.threadId, turns: [{ id: 'completed-rejected-plan-turn', status: 'completed', items: [
        { type: 'userMessage', id: 'user-message' }, { type: 'reasoning', id: 'reasoning' }, { type: 'agentMessage', id: 'agent-message' },
      ] }] } };
    },
    async run(options) {
      const roleId = options.role.id || options.role.name;
      providerCalls.push(roleId);
      if (roleId === 'coordinator') {
        const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
        return turnResult(options, JSON.stringify({ expected: pins, delta: null,
          dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }));
      }
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.verifyCandidate(), true);
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.',
        filesChanged: [], filesInspected: ['source.txt'],
        checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null }));
    },
  });
  const stored = seedConcurrentFence(fixture.runtime, { disposition: 'paused_owner' });
  const identity = fixture.options.providerIdentityPinFactory().providerIdentity;
  const providerScope = `lead:${fixture.runtime.projectId}:${stored.sessionId}:${identity.accountId}:${identity.codexHome}`;
  const turnId = 'lead-completed-rejected-plan';
  const threadId = 'coordinator-thread';
  const processIdentity = { pid: 99999999, pgid: 99999999, startTime: '1' };
  const settings = { threadId, codexHome: identity.codexHome, accountId: identity.accountId,
    transportKey: providerScope, settings: {}, settingsDigest: 'test-settings' };
  fixture.runtime.state.db.prepare("UPDATE concurrent_delivery_runs SET status='paused',lead_thread_id=?,lead_codex_home=?,lead_settings_json=? WHERE project_id=? AND run_id=?")
    .run(threadId, identity.codexHome, JSON.stringify(settings), fixture.runtime.projectId, stored.runId);
  const taskStore = require('../src/durable-store').createTaskStore(fixture.runtime.state, 'orchestrator');
  await taskStore.save({ id: stored.runId, contextId: `context-${stored.runId}`,
    status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, history: [], artifacts: [],
    metadata: { pause: { kind: 'owner_pause' } } }, call());
  await fixture.runtime.close();

  const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
  try {
    seeded.db.exec(`CREATE TABLE delivery_planner_turns (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
      pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id))`);
    seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,
      pins_json,result_json,started_at,updated_at) VALUES(?,?,?,?,?,'unknown',?,?,1,1)`)
      .run(fixture.runtime.projectId, stored.sessionId, providerScope, threadId, turnId,
        JSON.stringify({ ownerGeneration: 0 }), JSON.stringify({ errorCode: rejectedPlanCode, preDispatchSource: null,
          providerFailure: { execution: null, terminalTurn: null } }));
    seeded.db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json,start_json,terminal_json)
      VALUES(?,?,?,?,?,?)`).run(fixture.runtime.projectId, stored.sessionId, turnId, JSON.stringify({
      projectId: fixture.runtime.projectId, sessionId: stored.sessionId, turnId, providerThreadId: threadId,
      providerScope, ownerGeneration: 0,
    }), JSON.stringify({ threadId, processIdentity }), JSON.stringify({ threadId, turnId: 'completed-rejected-plan-turn', status: 'completed',
      execution: { processIdentity, generation: 1, threadId, turnId: 'completed-rejected-plan-turn', turnStartSent: true,
        turnStartRejected: false, turnTerminal: true, cleanupReceipt: { version: 1, method: 'thread/backgroundTerminals/clean',
          scope: 'provider-managed-background-terminals', completion: 'confirmed', generation: 1, processIdentity,
          threadId, turnId: 'completed-rejected-plan-turn' } } }));
    seeded.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?')
      .run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities: [processIdentity] }), fixture.runtime.projectId);
  } finally { await seeded.close(); }

  const restarted = await startServer(fixture.options);
  t.after(async () => { await restarted.close(); });
  const token = fs.readFileSync(fixture.options.tokenFile, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${restarted.port}/orchestrator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'after-paused-plan-recovery', contextId: '', taskId: '', role: 'ROLE_USER',
        parts: [{ text: 'Start a fresh diagnostic task.' }], metadata: {} }, configuration: {} } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.result?.task?.status?.state, 'TASK_STATE_COMPLETED', JSON.stringify(result));
  assert.ok(providerCalls.includes('coordinator'));
  assert.ok(providerCalls.includes('verifier'));
  const reconciled = JSON.parse(restarted.state.db.prepare('SELECT result_json FROM delivery_planner_turns WHERE turn_id=?').get(turnId).result_json);
  assert.equal(reconciled.originalResult.errorCode, rejectedPlanCode);
  assert.equal(reconciled.source, 'codex_app_server.thread_read');
  assert.equal(reconciled.terminalProof.status, 'completed');
  assert.equal(restarted.concurrentEngine.getRunDigest(stored.runId)?.disposition, 'paused_owner');
});

test('planner sends a strict usable schema and exposes a failed terminal provider turn', { timeout: 15000 }, async (t) => {
  let seenSchema = null;
  let seenInput = null;
  const fixture = await idleConcurrentServer(t, 'planner-schema-terminal-failure', {
    async run(options) {
      seenSchema = options.outputSchema;
      seenInput = options.input;
      assert.match(options.input, /host automatically creates and runs the mandatory verifier/i);
      assert.match(options.input, /never copy absolute check-script paths into task scopes/i);
      assert.match(options.input, /Add an ordinary new task with revision 1, supersedesTaskId null, and no expectedRevision/i);
      assert.match(options.input, /update an existing task, use only its exact task ID, current expectedRevision, and next revision allowed by the schema; preserve its exact supersedesTaskId lineage/i);
      assert.match(options.input, /For a distinct repair, add a new task with revision 1, set supersedesTaskId to the exact eligible task ID, and set expectedRevision to that task's current revision/i);
      assert.match(options.input, /Supersession retains the failed task and its attempt as history; never alter the failed attempt/i);
      assert.match(options.input, /do not update tasks outside the allowed list/i);
      assert.match(options.input, /Never set expectedRevision to 0 or null/i);
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId: options.threadId, processIdentity });
      const providerError = { code: 'invalid_json_schema', type: 'invalid_request_error', param: 'text.format.schema',
        message: "Invalid schema for response_format 'codex_output_schema': 'schema.properties.expected.properties' is required for object schemas." };
      const terminalTurn = { id: 'terminal-schema-failure', status: 'failed', error: { ...providerError,
        message: JSON.stringify({ type: 'error', error: providerError, status: 400 }) }, itemTypes: ['userMessage'] };
      throw Object.assign(new Error('Codex turn failed'), { failureClass: 'domain_failure', status: 'failed', codexError: terminalTurn.error,
        terminalTurn, execution: { processIdentity, generation: 1, threadId: options.threadId, turnId: terminalTurn.id,
          turnStartSent: true, turnStartRejected: false, turnTerminal: true } });
    },
  });
  const token = fs.readFileSync(fixture.options.tokenFile, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${fixture.runtime.port}/orchestrator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'schema-terminal-failure', contextId: '', taskId: '', role: 'ROLE_USER',
        parts: [{ text: 'Create a simple plan.' }], metadata: {} }, configuration: {} } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  const task = payload.result?.task;
  assert.ok(seenSchema);
  assertStrictOutputSchema(seenSchema);
  const deltaSchema = seenSchema.properties.delta.anyOf.find((entry) => entry.type === 'object');
  assert.ok(deltaSchema);
  assert.ok(Object.hasOwn(deltaSchema.properties, 'tasks') && Object.hasOwn(deltaSchema.properties, 'dependencies'));
  const emptyBranches = deltaSchema.properties.tasks.items.anyOf;
  assert.equal(emptyBranches.length, 1, 'an empty snapshot exposes only the add-task branch');
  const taskOnlyChange = emptyBranches[0];
  const taskVariants = taskOnlyChange.properties.task.anyOf;
  assert.ok(Array.isArray(taskVariants), 'task branches must separate writable and read-only role groups');
  const plannerRoles = fixture.runtime.concurrentEngine.roleIds.filter((role) => !['review', 'verifier', 'auditor', 'coordinator'].includes(role));
  const readOnlyRoles = plannerRoles.filter((role) => fixture.runtime.concurrentEngine.roleFor(role)?.sandbox === 'read-only').sort();
  const writableRoles = plannerRoles.filter((role) => fixture.runtime.concurrentEngine.roleFor(role)?.sandbox !== 'read-only').sort();
  assert.deepEqual(taskVariants.map((variant) => [...variant.properties.role.enum].sort()).sort(),
    [readOnlyRoles, writableRoles].filter((group) => group.length > 0).sort());
  const writableRole = writableRoles.find((role) => role === 'engineer');
  const readOnlyRole = readOnlyRoles[0];
  assert.ok(writableRole && readOnlyRole, 'configured roles must include writable and read-only planner roles');
  const taskSchema = plannerTaskSchemaForRole(taskOnlyChange, writableRole);
  const readOnlyTaskSchema = plannerTaskSchemaForRole(taskOnlyChange, readOnlyRole);
  assert.equal(taskSchema.properties.productWritePaths.minItems, 1, 'writable roles require a nonempty write scope');
  assert.equal(Object.hasOwn(readOnlyTaskSchema.properties.productWritePaths, 'minItems'), false,
    'read-only diagnostics may have an empty write scope');
  assert.match(seenInput, /policy\.writableRoles only for tasks with at least one bounded productWritePaths entry.*policy\.readOnlyRoles for no-write diagnostics, where productWritePaths may be empty/i);
  assert.throws(() => checkSpecialistRequest({ objective: 'Implement one bounded change.', allowedFiles: [] },
    { ...fixture.runtime.concurrentEngine.roleFor(writableRole), id: writableRole }),
  (error) => error.violations?.some((entry) => entry.code === 'writer_scope_missing') === true);
  assert.deepEqual(checkSpecialistRequest({ objective: 'Implement one bounded change.', allowedFiles: ['source.txt'] },
    { ...fixture.runtime.concurrentEngine.roleFor(writableRole), id: writableRole }).allowedFiles, ['source.txt']);
  assert.deepEqual(checkSpecialistRequest({ objective: 'Inspect the failure without writing.', allowedFiles: [] },
    { ...fixture.runtime.concurrentEngine.roleFor(readOnlyRole), id: readOnlyRole }).allowedFiles, []);
  assert.equal(Object.hasOwn(taskOnlyChange.properties, 'expectedRevision'), false);
  assert.deepEqual(taskSchema.properties.revision.enum, [1]);
  assert.deepEqual(taskOnlyChange.required, ['task']);
  assert.match(deltaSchema.properties.tasks.items.description, /ordinary new task with revision 1, supersedesTaskId null, and no expectedRevision.*update an eligible existing task.*distinct new revision-1 task/i);
  assert.deepEqual(taskSchema.properties.supersedesTaskId, { type: 'null', enum: [null] });
  for (const key of ['role', 'objective', 'productWritePaths', 'readScope', 'state']) assert.ok(Object.hasOwn(taskSchema.properties, key));
  assert.ok(taskSchema.properties.role.enum.includes('engineer'));
  for (const paths of [taskSchema.properties.productWritePaths, taskSchema.properties.scratchWriteRoots,
    taskSchema.properties.readScope.anyOf[0].properties.paths]) {
    const pattern = new RegExp(paths.items.pattern);
    assert.equal(pattern.test('docs/RUNTIME_DIAGNOSTIC.md'), true);
    assert.equal(pattern.test('/home/owner/check-diagnostic.cjs'), false);
    assert.equal(pattern.test('docs\\file.md'), false);
  }
  assert.equal(taskSchema.properties.role.enum.some((role) => ['verifier', 'auditor', 'review', 'coordinator'].includes(role)), false);
  const dependencySchema = deltaSchema.properties.dependencies.items;
  for (const key of ['predecessorType', 'predecessorId', 'successorTaskId', 'kind']) assert.ok(Object.hasOwn(dependencySchema.properties, key));
  assert.match(dependencySchema.properties.expectedOutput.description, /exact known candidate ID.*or null/i);
  const currentProjection = { projectId: 'revision-guidance-project', objectiveId: 'revision-guidance-objective',
    planRevision: 0, goalRevision: 1, authorityRevision: 1, controlRevision: 1, tasks: [], checkpoints: [] };
  const newTask = { schemaVersion: VERSION, projectId: currentProjection.projectId, objectiveId: currentProjection.objectiveId,
    taskId: 'new-task', revision: 1, role: 'engineer', kind: 'implementation', objective: 'Create one file', priority: 0,
    dependencies: [], productWritePaths: ['output.txt'], readScope: { kind: 'known', paths: [], reason: null },
    scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'denied' }, state: 'queued', supersedesTaskId: null };
  const planDelta = { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1, dependencies: [] };
  assert.equal(validatePlanDelta(currentProjection, { ...planDelta, tasks: [{ task: newTask }] }).tasks[0].taskId, 'new-task');
  const readOnlyDiagnostic = { ...newTask, taskId: 'read-only-diagnostic', role: readOnlyRole,
    kind: 'diagnostic', objective: 'Inspect the current source without writing.', productWritePaths: [] };
  assert.equal(validatePlanDelta(currentProjection, { ...planDelta, tasks: [{ task: readOnlyDiagnostic }] }).tasks[0].role, readOnlyRole);
  assert.throws(() => validatePlanDelta(currentProjection, {
    ...planDelta, tasks: [{ expectedRevision: 0, task: newTask }],
  }), { code: 'unexpected_expected_revision' });
  assert.throws(() => validatePlanDelta(currentProjection, {
    ...planDelta, tasks: [{ expectedRevision: 1, task: newTask }],
  }), { code: 'unexpected_expected_revision' });

  const existingA = { ...newTask, taskId: 'existing-a', revision: 4, state: 'failed' };
  const existingB = { ...newTask, taskId: 'existing-b', revision: 8, state: 'blocked' };
  const immutable = { ...newTask, taskId: 'immutable-running', revision: 3, state: 'running' };
  const immutableClaimed = { ...newTask, taskId: 'immutable-claimed', state: 'claimed' };
  const immutableSettling = { ...newTask, taskId: 'immutable-settling', state: 'settling' };
  const terminalSucceeded = { ...newTask, taskId: 'terminal-succeeded', state: 'succeeded' };
  const terminalCanceled = { ...newTask, taskId: 'terminal-canceled', state: 'canceled' };
  const terminalSuperseded = { ...newTask, taskId: 'terminal-superseded', state: 'superseded' };
  const hostReview = { ...newTask, taskId: 'host-review', revision: 2, role: 'verifier', kind: 'review' };
  const existingProjection = { ...currentProjection, planRevision: 4,
    tasks: [existingA, existingB, immutable, immutableClaimed, immutableSettling,
      terminalSucceeded, terminalCanceled, terminalSuperseded, hostReview] };
  const laterSchema = fixture.runtime.concurrentEngine.plannerOutputSchema({ objective: { tasks: existingProjection.tasks } });
  assertStrictOutputSchema(laterSchema);
  const laterDeltaSchema = laterSchema.properties.delta.anyOf.find((entry) => entry.type === 'object');
  const laterBranches = laterDeltaSchema.properties.tasks.items.anyOf;
  assert.equal(laterBranches.length, 5, 'two mutable planner tasks expose update and supersede branches plus ordinary create');
  for (const branch of laterBranches) {
    assert.deepEqual(plannerTaskVariants(branch).map((variant) => [...variant.properties.role.enum].sort()).sort(),
      [readOnlyRoles, writableRoles].filter((group) => group.length > 0).sort());
    assert.equal(plannerTaskSchemaForRole(branch, writableRole).properties.productWritePaths.minItems, 1);
    assert.equal(Object.hasOwn(plannerTaskSchemaForRole(branch, readOnlyRole).properties.productWritePaths, 'minItems'), false);
  }
  const addBranch = laterBranches.find((branch) => !Object.hasOwn(branch.properties, 'expectedRevision'));
  assert.deepEqual(plannerTaskSchemaForRole(addBranch, writableRole).properties.revision.enum, [1]);
  assert.deepEqual(plannerTaskSchemaForRole(addBranch, writableRole).properties.supersedesTaskId, { type: 'null', enum: [null] });
  const updateA = laterBranches.find((branch) => plannerTaskVariants(branch).some((variant) => variant.properties.taskId.enum?.[0] === 'existing-a'));
  const updateB = laterBranches.find((branch) => plannerTaskVariants(branch).some((variant) => variant.properties.taskId.enum?.[0] === 'existing-b'));
  const supersedeA = laterBranches.find((branch) => plannerTaskVariants(branch).some((variant) => variant.properties.supersedesTaskId.enum?.[0] === 'existing-a'));
  assert.ok(updateA && updateB);
  assert.ok(supersedeA);
  const updateATask = plannerTaskSchemaForRole(updateA, writableRole);
  const updateBTask = plannerTaskSchemaForRole(updateB, writableRole);
  const supersedeATask = plannerTaskSchemaForRole(supersedeA, writableRole);
  assert.deepEqual(updateA.properties.expectedRevision.enum, [4]);
  assert.deepEqual(updateATask.properties.revision.enum, [5]);
  assert.deepEqual(updateATask.properties.state.enum, ['queued', 'blocked']);
  assert.deepEqual(updateATask.properties.supersedesTaskId, { type: 'null', enum: [null] });
  assert.deepEqual(updateB.properties.expectedRevision.enum, [8]);
  assert.deepEqual(updateBTask.properties.revision.enum, [9]);
  assert.deepEqual(supersedeA.properties.expectedRevision.enum, [4]);
  assert.deepEqual(supersedeATask.properties.revision.enum, [1]);
  assert.deepEqual(supersedeATask.properties.supersedesTaskId.enum, ['existing-a']);
  assert.equal(supersedeATask.properties.taskId.type, 'string');
  assert.equal(supersedeATask.properties.taskId.enum, undefined);
  assert.equal(laterBranches.some((branch) => plannerTaskVariants(branch).some((variant) => variant.properties.taskId.enum?.[0] === 'immutable-running')), false);
  assert.equal(laterBranches.some((branch) => plannerTaskVariants(branch).some((variant) => variant.properties.taskId.enum?.[0] === 'host-review')), false);
  for (const taskId of ['immutable-running', 'immutable-claimed', 'immutable-settling', 'terminal-succeeded', 'terminal-canceled', 'terminal-superseded', 'host-review']) {
    assert.equal(laterBranches.some((branch) => plannerTaskVariants(branch).some((variant) => variant.properties.supersedesTaskId.enum?.[0] === taskId)), false,
      `ineligible task ${taskId} must not be a supersession target`);
  }

  const laterPlanDelta = { ...planDelta, expectedPlanRevision: 4, nextPlanRevision: 5 };
  const updateTaskA = { ...existingA, revision: 5, state: 'queued', supersedesTaskId: null };
  assert.equal(validatePlanDelta(existingProjection, { ...laterPlanDelta, tasks: [
    { task: updateTaskA, expectedRevision: 4 },
  ] }).tasks[0].taskId, 'existing-a');
  assert.throws(() => validatePlanDelta(existingProjection, { ...laterPlanDelta, tasks: [
    { task: { ...updateTaskA, revision: 6 }, expectedRevision: 8 },
  ] }), { code: 'task_revision_stale' });
  assert.throws(() => validatePlanDelta(existingProjection, { ...laterPlanDelta, tasks: [
    { task: { ...newTask, taskId: 'new-id-with-zero', revision: 1 }, expectedRevision: 0 },
  ] }), { code: 'unexpected_expected_revision' });
  assert.equal(task?.status?.state, 'TASK_STATE_INPUT_REQUIRED', JSON.stringify(payload));
  assert.equal(task?.metadata?.pause?.kind, 'error');
  assert.match(task?.status?.message?.parts?.[0]?.text || '', /invalid_json_schema/);
  const ledger = fixture.runtime.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').get();
  assert.equal(ledger.status, 'reconciled_no_effect');
  assert.equal(JSON.parse(ledger.result_json).providerFailure.terminalTurn.error.code, 'invalid_json_schema');
  assert.equal(JSON.parse(ledger.result_json).terminalProof.source, 'codex_app_server.terminal_schema_failure');
  const fact = fixture.runtime.state.db.prepare('SELECT terminal_json FROM concurrent_planner_execution_facts').get();
  assert.equal(JSON.parse(fact.terminal_json).terminalTurn.status, 'failed');
});

test('planner schema represents a distinct repair superseding a failed task without rewriting its attempt', async (t) => {
  const fixture = await idleConcurrentServer(t, 'planner-supersession-schema');
  const { runtime } = fixture;
  const store = runtime.concurrentEngine.store;
  const projectId = runtime.projectId;
  const objectiveId = 'planner-schema-supersession';
  store.createObjective({ projectId, objectiveId, sessionId: 'planner-schema-session', engineVersion: VERSION,
    goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const makeTask = (taskId, extra = {}) => ({ schemaVersion: VERSION, projectId, objectiveId, taskId, revision: 1,
    role: 'engineer', kind: 'implementation', objective: `Implement ${taskId}`, priority: 1, dependencies: [],
    productWritePaths: ['source.txt'], readScope: { kind: 'known', paths: ['source.txt'], reason: null },
    scratchWriteRoots: ['.scratch/repair'], resourceClaims: [], publicationAuthority: { state: 'unknown' },
    state: 'queued', ...extra });
  const seed = store.getObjective(projectId, objectiveId);
  store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: seed.planRevision,
    expectedGoalRevision: seed.goalRevision, expectedAuthorityRevision: seed.authorityRevision,
    expectedControlRevision: seed.controlRevision, nextPlanRevision: seed.planRevision + 1,
    tasks: [{ task: makeTask('failed-task', { supersedesTaskId: null }) }], dependencies: [] });
  const claims = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, limit: 1 });
  assert.equal(claims.length, 1);
  const { attempt, claim } = claims[0];
  store.recordSubmitted(projectId, objectiveId, attempt.attemptId, claim.fencingToken, 'failed-task-external');
  store.settleAttempt(projectId, objectiveId, attempt.attemptId, claim.fencingToken,
    { state: 'failed', failureKind: 'known_product_check_failure' },
    { remoteQuiescent: true, processQuiescent: true, effectsSettled: true });

  const current = store.getObjective(projectId, objectiveId);
  const failedTask = current.tasks.find((task) => task.taskId === 'failed-task');
  assert.equal(failedTask.state, 'failed');
  const failedAttemptBefore = store.listAttempts(projectId, objectiveId);
  const schema = runtime.concurrentEngine.plannerOutputSchema({ objective: current });
  assertStrictOutputSchema(schema);
  const deltaSchema = schema.properties.delta.anyOf.find((entry) => entry.type === 'object');
  const taskBranches = deltaSchema.properties.tasks.items.anyOf;
  const supersedeBranch = taskBranches.find((branch) => plannerTaskVariants(branch)
    .some((variant) => variant.properties.supersedesTaskId?.enum?.includes('failed-task')));
  assert.ok(supersedeBranch, 'schema must expose the failed task exact supersession target');
  const supersedeTask = plannerTaskSchemaForRole(supersedeBranch, 'engineer');
  assert.equal(supersedeTask.properties.productWritePaths.minItems, 1);
  assert.equal(supersedeTask.properties.taskId.type, 'string', 'repair task gets a distinct new ID');
  assert.deepEqual(supersedeTask.properties.revision.enum, [1]);
  assert.deepEqual(supersedeTask.properties.supersedesTaskId.enum, ['failed-task']);
  assert.deepEqual(supersedeBranch.properties.expectedRevision.enum, [failedTask.revision]);

  const repairTask = makeTask('repair-task', { objective: 'Repair after the failed attempt.', supersedesTaskId: 'failed-task' });
  const delta = { schemaVersion: VERSION, expectedPlanRevision: current.planRevision,
    expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1,
    tasks: [{ task: repairTask, expectedRevision: failedTask.revision }], dependencies: [] };
  assert.equal(validatePlanDelta(current, delta).tasks[0].supersedesTaskId, 'failed-task');
  assert.throws(() => validatePlanDelta(current, { ...delta,
    tasks: [{ task: repairTask, expectedRevision: failedTask.revision + 1 }] }), { code: 'task_revision_stale' });
  for (const [state, code] of [['running', 'active_task_contract_immutable'], ['succeeded', 'terminal_task_immutable']]) {
    const ineligible = { ...current, tasks: current.tasks.map((task) => task.taskId === 'failed-task' ? { ...task, state } : task) };
    assert.throws(() => validatePlanDelta(ineligible, delta), { code });
  }
  for (const missingTarget of ['missing-task', 'foreign-project-task']) {
    const invalidRepair = { ...repairTask, supersedesTaskId: missingTarget };
    assert.throws(() => validatePlanDelta(current, { ...delta,
      tasks: [{ task: invalidRepair, expectedRevision: failedTask.revision }] }), { code: 'superseded_task_missing' });
  }
  const sameIdRetry = { ...repairTask, taskId: 'failed-task' };
  assert.throws(() => validatePlanDelta(current, { ...delta,
    tasks: [{ task: sameIdRetry, expectedRevision: failedTask.revision }] }), { code: 'task_revision_step_invalid' });
  const alteredLineage = { ...repairTask, taskId: 'failed-task', revision: failedTask.revision + 1,
    state: 'queued', supersedesTaskId: 'other-lineage' };
  assert.throws(() => validatePlanDelta(current, { ...delta,
    tasks: [{ task: alteredLineage, expectedRevision: failedTask.revision }] }), { code: 'supersession_lineage_immutable' });
  const applied = store.applyPlan(projectId, objectiveId, delta);
  assert.equal(applied.tasks.find((task) => task.taskId === 'failed-task').state, 'superseded');
  assert.deepEqual(store.listAttempts(projectId, objectiveId), failedAttemptBefore);
});

test('startup refuses unsafe interrupted shutdowns and releases new server resources', { timeout: 20000 }, async (t) => {
  for (const scenario of ['live old provider group', 'started unknown planner']) {
    await t.test(scenario, async (subtest) => {
      let closeCalls = 0;
      let startCalls = 0;
      let accountCalls = 0;
      let providerCalls = 0;
      const fixture = await idleConcurrentServer(subtest, `unsafe-recovery-${scenario.replaceAll(' ', '-')}`, {
        async run() { providerCalls += 1; throw new Error('No provider work is allowed during unsafe recovery.'); },
        async start() { startCalls += 1; },
        async getAccount() { accountCalls += 1; return { account: { type: 'chatgpt' } }; },
        async close() { closeCalls += 1; },
      });
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      closeCalls = 0;
      startCalls = 0;
      accountCalls = 0;
      providerCalls = 0;
      let startupListener = null;
      fixture.options.listenImpl = (application, port, host, callback) => {
        startupListener = application.listen(port, host, callback);
        return startupListener;
      };
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        let identities = [{ pid: 99999999, pgid: 99999999, startTime: '1' }];
        if (scenario === 'live old provider group') identities = [readProcessIdentity(process.pid)];
        seeded.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?')
          .run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities }), fixture.runtime.projectId);
        if (scenario === 'started unknown planner') {
          seeded.db.exec(`CREATE TABLE delivery_planner_turns (
            project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
            provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
            pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id))`);
          seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,
            pins_json,result_json,started_at,updated_at) VALUES(?,?,?,?,?,'unknown','{}','{"errorCode":"provider_outcome_unknown"}',1,1)`)
            .run(fixture.runtime.projectId, stored.sessionId, 'unknown-scope', 'unknown-thread', 'started-unknown-turn');
          seeded.db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json,start_json,terminal_json)
            VALUES(?,?,?,?,?,NULL)`).run(fixture.runtime.projectId, stored.sessionId, 'started-unknown-turn', JSON.stringify({
            projectId: fixture.runtime.projectId, sessionId: stored.sessionId, turnId: 'started-unknown-turn',
          }), JSON.stringify({ threadId: 'unknown-thread', processIdentity: readProcessIdentity(process.pid) }));
        }
      } finally { await seeded.close(); }
      await assert.rejects(startServer(fixture.options), { code: 'concurrent_startup_recovery_unsafe' });
      if (scenario === 'live old provider group') {
        assert.equal(closeCalls, 0);
        assert.equal(startCalls, 0);
        assert.equal(accountCalls, 0);
        assert.equal(startupListener, null);
      } else {
        assert.equal(closeCalls, 1);
        assert.ok(startupListener);
        assert.equal(startupListener.listening, false);
      }
      assert.equal(providerCalls, 0);
      const reopened = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        assert.equal(JSON.parse(reopened.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?')
          .get(fixture.runtime.projectId).phase_json).phase, 'provider_closing');
        if (scenario === 'started unknown planner') {
          assert.equal(reopened.db.prepare('SELECT status FROM delivery_planner_turns WHERE turn_id=?')
            .get('started-unknown-turn').status, 'unknown');
        }
      } finally { await reopened.close(); }
    });
  }
});


function seedConcurrentFence(runtime, { disposition = 'canceled', claimStates = [], publicationStates = [] } = {}) {
  const { db } = runtime.state;
  const projectId = runtime.projectId;
  const runId = 'stored-concurrent';
  const objectiveId = runtime.orchestrator.objectiveIdFor(runId);
  const sessionId = runtime.orchestrator.sessionIdFor(runId);
  db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
    VALUES(?,?,'concurrent-v1',?,?,'{}',1,1)`).run(projectId, runId, objectiveId, sessionId);
  db.prepare(`INSERT INTO concurrent_delivery_runs(project_id,run_id,objective_id,session_id,goal,contract_json,contract_digest,
    requirement_digest,checks_digest,environment_digest,check_identity,checkpoint_ids_json,status,created_at,updated_at)
    VALUES(?,?,?,?,'Stored goal','{}','contract','requirements','checks','environment','identity','[]','canceled',1,1)`)
    .run(projectId, runId, objectiveId, sessionId);
  runtime.concurrentEngine.store.createObjective({ projectId, objectiveId, sessionId, legacyRunId: runId,
    engineVersion: 'delivery/v1', goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition });
  const candidates = runtime.concurrentEngine.candidateStore;
  candidates.createCandidate({ candidateId: 'candidate-base', projectId, objectiveId, integrationGeneration: 1,
    sourceAttemptId: 'base-attempt', environmentDigest: `sha256:${'a'.repeat(64)}`, checkIdentity: 'checks' });
  for (let index = 0; index < 3; index += 1) {
    candidates.createCandidate({ candidateId: `candidate-next-${index}`, parentCandidateId: 'candidate-base', projectId, objectiveId,
      integrationGeneration: index + 2, sourceAttemptId: `attempt-${index}`,
      environmentDigest: `sha256:${'a'.repeat(64)}`, checkIdentity: 'checks' });
  }
  seedConcurrentEffects(db, projectId, objectiveId, { claimStates, publicationStates });
  return { runId, objectiveId, sessionId };
}

async function seedPausedAndOrphanMappings(runtime, taskStore) {
  const { db } = runtime.state;
  const projectId = runtime.projectId;
  const pausedRunId = 'paused-quarantine-run';
  const pausedContextId = 'paused-quarantine-context';
  const pausedObjectiveId = runtime.orchestrator.objectiveIdFor(pausedRunId);
  const pausedSessionId = runtime.orchestrator.sessionIdFor(pausedRunId, pausedContextId);
  db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
    VALUES(?,?,'concurrent-v1',?,?,?,1,1)`)
    .run(projectId, pausedRunId, pausedObjectiveId, pausedSessionId, JSON.stringify({ contextId: pausedContextId }));
  db.prepare(`INSERT INTO concurrent_delivery_runs(project_id,run_id,objective_id,session_id,goal,contract_json,contract_digest,
    requirement_digest,checks_digest,environment_digest,check_identity,checkpoint_ids_json,status,created_at,updated_at)
    VALUES(?,?,?,?,'Paused goal','{}','contract','requirements','checks','environment','identity','[]','paused',1,1)`)
    .run(projectId, pausedRunId, pausedObjectiveId, pausedSessionId);
  runtime.concurrentEngine.store.createObjective({ projectId, objectiveId: pausedObjectiveId, sessionId: pausedSessionId,
    legacyRunId: pausedRunId, engineVersion: 'delivery/v1', goalRevision: 1,
    requirementDigest: `sha256:${'c'.repeat(64)}`, checksDigest: `sha256:${'d'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'paused_owner' });
  await taskStore.save({ id: pausedRunId, contextId: pausedContextId,
    status: { state: 'TASK_STATE_INPUT_REQUIRED' }, history: [], artifacts: [], metadata: {} }, call());
  db.prepare("UPDATE tasks SET status=?,status_state='TASK_STATE_INPUT_REQUIRED' WHERE owner='orchestrator' AND id=?")
    .run('{"state":"TASK_STATE_INPUT_REQUIRED"}', pausedRunId);
  db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,pins_json,result_json,started_at,updated_at)
    VALUES(?,?,? ,?,'paused-terminal-turn','complete','{}','{}',1,1)`)
    .run(projectId, pausedSessionId, 'paused-scope', 'paused-thread');

  const orphanRunId = 'orphan-quarantine-run';
  const orphanContextId = 'orphan-quarantine-context';
  const orphanObjectiveId = runtime.orchestrator.objectiveIdFor(orphanRunId);
  const orphanSessionId = runtime.orchestrator.sessionIdFor(orphanRunId, orphanContextId);
  db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
    VALUES(?,?,'concurrent-v1',?,?,?,1,1)`)
    .run(projectId, orphanRunId, orphanObjectiveId, orphanSessionId, JSON.stringify({ contextId: orphanContextId }));
  await taskStore.save({ id: orphanRunId, contextId: orphanContextId,
    status: { state: 'TASK_STATE_FAILED' }, history: [], artifacts: [], metadata: {} }, call());
  db.prepare("UPDATE tasks SET status=?,status_state='TASK_STATE_FAILED' WHERE owner='orchestrator' AND id=?")
    .run('{"state":"TASK_STATE_FAILED"}', orphanRunId);
  const pid = 4000000 + Math.floor(Math.random() * 1000000);
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' }, 'orphan proof process group must be absent');
  const identity = { projectId, sessionId: orphanSessionId, turnId: 'orphan-planner-turn',
    providerThreadId: 'orphan-provider-thread', providerScope: 'orphan-provider-scope', ownerGeneration: 0 };
  const terminalProof = { threadId: identity.providerThreadId, turnId: 'failed-provider-turn', status: 'failed',
    error: { code: 'invalid_json_schema', type: 'invalid_request_error', param: 'text.format.schema',
      message: "Invalid schema for response_format 'codex_output_schema': 'schema.properties.expected.properties' is required for object schemas." },
    items: [{ type: 'userMessage', id: 'orphan-user-message' }], source: 'thread/read' };
  const result = { state: 'reconciled_no_effect', source: 'codex_app_server.thread_read',
    originalResult: { errorCode: 'turn_error', preDispatchSource: null }, projectId,
    sessionId: orphanSessionId, turnId: identity.turnId, providerScope: identity.providerScope,
    providerThreadId: identity.providerThreadId, ownerGeneration: identity.ownerGeneration,
    oldProviderGroupsGone: true, providerDispatchStarted: true, terminalProof };
  db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,pins_json,result_json,started_at,updated_at)
    VALUES(?,?,?,?,?,'reconciled_no_effect',?,?,1,1)`)
    .run(projectId, orphanSessionId, identity.providerScope, identity.providerThreadId, identity.turnId,
      JSON.stringify({ ownerGeneration: 0 }), JSON.stringify(result));
  db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json,start_json,terminal_json)
    VALUES(?,?,?,?,?,?)`).run(projectId, orphanSessionId, identity.turnId, JSON.stringify(identity),
      JSON.stringify({ threadId: identity.providerThreadId, processIdentity: { pid, pgid: pid, startTime: '1' } }),
      JSON.stringify(terminalProof));
  return [
    { runId: pausedRunId, objectiveId: pausedObjectiveId, sessionId: pausedSessionId },
    { runId: orphanRunId, objectiveId: orphanObjectiveId, sessionId: orphanSessionId },
  ];
}

function seedConcurrentEffects(db, projectId, objectiveId, { claimStates = [], publicationStates = [] } = {}) {
  for (const [index, state] of claimStates.entries()) {
    db.prepare(`INSERT INTO backlog_claims(project_id,objective_id,claim_id,task_id,attempt_id,role,fencing_token,record_json)
      VALUES(?,?,?,?,?,'engineer',?,?)`).run(projectId, objectiveId, `claim-${index}`, `task-${index}`, `attempt-${index}`,
      index + 1, JSON.stringify({ state }));
  }
  for (const [index, state] of publicationStates.entries()) {
    const artifactId = `artifact-${index}`;
    db.prepare(`INSERT INTO delivery_output_bindings(artifact_id,project_id,objective_id,task_id,attempt_id,lane_id,context_id,identity_json,state,record_json,created_at)
      VALUES(?,?,?,?,?,'lane','context','{}','bound','{}','now')`).run(artifactId, projectId, objectiveId, `task-${index}`, `attempt-${index}`);
    db.prepare(`INSERT INTO delivery_output_publications(intent_id,artifact_id,request_json,state,created_at,updated_at)
      VALUES(?,?,'{}',?,'now','now')`).run(`intent-${index}`, artifactId, state);
    if (['applied', 'not_applied'].includes(state)) {
      seedAuthoritativeEffects(db, projectId, { objectiveId }, { intentState: state, intentIndex: index });
    }
  }
}

async function cleanupSeededRecoveryFixture(runtime) {
  // Remove fabricated recovery faults only after admission assertions. This is fixture
  // teardown, not evidence that unknown production effects can drain safely.
  const db = runtime.state.db;
  db.prepare("DELETE FROM concurrent_delivery_runs WHERE run_id='stored-concurrent'").run();
  await runtime.close();
}

test('restart with legacy default fences persisted concurrent objectives, mixed claims, and publications', async (t) => {
  for (const scenario of [
    { name: 'active objective', disposition: 'executing', code: 'delivery_engine_busy' },
    { name: 'paused owner remains busy in normal routing', disposition: 'paused_owner', runStatus: 'paused', code: 'delivery_engine_busy' },
    { name: 'unknown claim', claimStates: ['released', 'unknown'], code: 'delivery_engine_unsafe' },
    { name: 'active claim', claimStates: ['released', 'active'], code: 'delivery_engine_unsafe' },
    { name: 'unknown publication', publicationStates: ['applied', 'unknown'], code: 'delivery_engine_unsafe' },
    { name: 'pending publication', publicationStates: ['refused', 'pending'], code: 'delivery_engine_unsafe' },
    { name: 'settled effects', claimStates: ['released'], publicationStates: ['applied', 'refused', 'not_applied'] },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        const row = seeded.db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(fixture.runtime.projectId, stored.objectiveId);
        const objective = { ...JSON.parse(row.record_json), disposition: scenario.disposition || 'canceled' };
        seeded.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?')
          .run(JSON.stringify(objective), fixture.runtime.projectId, stored.objectiveId);
        if (scenario.runStatus) seeded.db.prepare('UPDATE concurrent_delivery_runs SET status=? WHERE project_id=? AND run_id=?')
          .run(scenario.runStatus, fixture.runtime.projectId, stored.runId);
        seedConcurrentEffects(seeded.db, fixture.runtime.projectId, stored.objectiveId, scenario);
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        assert.equal(restarted.deliveryEngine, 'legacy');
        assert.ok(restarted.concurrentEngine, 'persisted concurrent mappings still compose the real engine');
        assert.equal(restarted.orchestrator.mapping(stored.runId).engine, 'concurrent-v1');
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'new-legacy', goal: 'New legacy intake' });
        if (scenario.code) {
          await assert.rejects(intake, { code: scenario.code });
          assert.equal(restarted.orchestrator.mapping('new-legacy'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['new-legacy']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

test('durable legacy mappings block concurrent intake while independent projects remain usable', async (t) => {
  const first = await idleConcurrentServer(t, 'first');
  const second = await idleConcurrentServer(t, 'second');
  try {
    const taskStore = require('../src/durable-store').createTaskStore(first.runtime.state, 'orchestrator');
    await taskStore.save({ id: 'old-legacy', contextId: 'old-context', status: { state: TaskState.TASK_STATE_WORKING }, history: [], artifacts: [], metadata: {} }, call());
    first.runtime.state.db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,request_json,created_at,updated_at)
      VALUES(?,'old-legacy','legacy','{}',1,1)`).run(first.runtime.projectId);
    await assert.rejects(first.runtime.orchestrator.run({ runId: 'blocked-concurrent', goal: 'Must wait' }), { code: 'delivery_engine_busy' });
    assert.equal(first.runtime.orchestrator.mapping('blocked-concurrent'), null);
    const result = await second.runtime.orchestrator.runLegacy({ runId: 'independent-legacy', goal: 'Independent workspace' });
    assert.equal(result.status, 'completed');
    assert.notEqual(first.runtime.projectId, second.runtime.projectId);
    assert.deepEqual(second.calls, ['independent-legacy']);
    assert.equal(first.runtime.orchestrator.mapping('independent-legacy'), null);
  } finally { await Promise.all([first.runtime.close(), second.runtime.close()]); }
});

test('restart refuses unknown stored engine selections without rewriting the durable mapping', async (t) => {
  const fixture = await idleConcurrentServer(t);
  seedConcurrentFence(fixture.runtime);
  fixture.runtime.state.db.prepare("UPDATE delivery_run_engines SET engine='unknown-engine'").run();
  await fixture.runtime.close();
  await assert.rejects(startServer(fixture.options), { code: 'delivery_engine_selection_unsafe' });
  const reopened = await openStateDatabase({ filePath: fixture.options.stateFile });
  try {
    assert.equal(reopened.db.prepare('SELECT engine FROM delivery_run_engines').get().engine, 'unknown-engine');
  } finally { await reopened.close(); }
});

function turnResult(options, text) {
  const roleId = options.role.id || options.role.name;
  const threadId = options.threadId || `${roleId}-thread`;
  const turnId = `turn-${roleId}`;
  const processIdentity = readProcessIdentity(process.pid);
  options.onTurnStart({ threadId, processIdentity });
  return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
    execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
}

test('default real server accepts a base candidate with empty owner checks', { timeout: 15000 }, async (t) => {
  const providerCalls = [];
  const fixture = await idleConcurrentServer(t, 'accepted', { async run(options) {
    const roleId = options.role.id || options.role.name;
    providerCalls.push(roleId);
    if (roleId === 'coordinator') {
      const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
      return turnResult(options, JSON.stringify({ expected: pins, delta: null, dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }));
    }
    const details = scopedExecutionDetails(options.deliveryCapability);
    assert.equal(details.verifyCandidate(), true);
    execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
    return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.', filesChanged: [], filesInspected: ['source.txt'],
      checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }], risks: [], scopeExpansion: [], decisionRequest: null }));
  } });
  const { runtime } = fixture;
  try {
    const result = await runtime.leadAgent.requestHandler.sendMessage({ message: message('Confirm the current source is acceptable.'), configuration: {} }, call());
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    const mapping = runtime.orchestrator.mapping(result.id);
    assert.equal(mapping.engine, 'concurrent-v1');
    assert.equal(runtime.concurrentEngine.getRunDigest(result.id).disposition, 'accepted');
    assert.ok(providerCalls.includes('coordinator'));
    assert.ok(providerCalls.includes('verifier'));
  } finally { await runtime.close(); }
});

test('owner full-access carries lossless owner context into the scoped verifier without changing its gates', { timeout: 20000 }, async (t) => {
  const permissionResolutions = [];
  const providerCalls = [];
  const ownerGoal = `${'x'.repeat(2799)}🙂${'z'.repeat(47199)}`;
  assert.equal(ownerGoal.length, 50000);
  const requiredCheckIds = ['upstream-kernel', 'composer-relock', 'composer-project-validate'];
  const requiredChecks = requiredCheckIds.map((id) => ({ id, argv: ['node', 'verify-source.js'], timeoutMs: 5000 }));
  let dispatchedRequest = null;
  let dispatchedCapability = null;
  const fixture = await idleConcurrentServer(t, 'full-access-accepted', {
    async resolveExecutionPermissions(workspace, requested, options) {
      permissionResolutions.push({ workspace, requested, options });
      if (requested !== 'full-access') return { mode: 'strict', profileApi: false, reason: 'unexpected_mode' };
      return { mode: 'full-access', profileApi: true, writerProfile: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
    },
    async run(options) {
      const roleId = options.role.id || options.role.name;
      providerCalls.push(roleId);
      assert.equal(options.executionPermissions, 'full-access');
      assert.equal(options.permissionWorkspace, fixture.options.workspace);
      if (roleId === 'coordinator') {
        const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
        return turnResult(options, JSON.stringify({ expected: pins, delta: null,
          dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }));
      }
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.executionPermissions, 'full-access');
      assert.equal(details.verifyCandidate(), true);
      const request = JSON.parse(options.input);
      const objective = runtime.concurrentEngine.store.getObjective(runtime.projectId,
        runtime.orchestrator.mapping(runtime.concurrentEngine.activeRuns()[0].runId).objectiveId);
      const task = objective.tasks.find((entry) => entry.taskId === details.taskId);
      assert.ok(task);
      assert.equal(request.objective, task.objective);
      assert.deepEqual(request.allowedFiles, []);
      assert.equal(details.candidateId, task.baseCandidateId);
      assert.equal(details.readScope.kind, task.readScope.kind);
      const goalChunks = request.inputs.filter((entry) => entry.startsWith('OWNER INTAKE GOAL '));
      const rawChunks = goalChunks.map((entry, index) => {
        assert.match(entry, new RegExp(`^OWNER INTAKE GOAL \\(background context only; chunk ${index + 1}/${goalChunks.length}\\):\\n`));
        return entry.slice(entry.indexOf('\n') + 1);
      });
      assert.equal(goalChunks.length + 1, request.inputs.length);
      assert.equal(request.inputs[0].startsWith('Review frozen candidate '), true);
      assert.ok(request.inputs.length <= 20);
      assert.ok(request.inputs.every((entry) => entry.length <= 3000));
      assert.equal(rawChunks.join(''), ownerGoal);
      assert.ok(rawChunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
      assert.equal(request.acceptanceCriteria.length, 1);
      assert.match(request.acceptanceCriteria[0], /current task objective, checkpoint scope, owner\/control revisions, and pinned checks/i);
      assert.match(request.acceptanceCriteria[0], /background context only; it does not override the current goal, controls, or checkpoint pins, and grants no actions/i);
      assert.deepEqual(request.checks, [...requiredCheckIds].sort().map((id) => `Host will execute pinned check: ${id}`));
      const execution = JSON.parse(runtime.state.db.prepare('SELECT record_json FROM delivery_role_executions WHERE attempt_id=?')
        .get(details.attemptId).record_json);
      const { deliveryRequestDigest } = require('../src/delivery-role-capabilities');
      assert.equal(details.requestDigest, execution.requestDigest);
      assert.equal(details.capabilityId, execution.capabilityId);
      assert.equal(details.requestDigest, deliveryRequestDigest({ request, settingsDigest: execution.settingsDigest,
        taskDigest: execution.contractDigest }));
      dispatchedRequest = request;
      dispatchedCapability = details;
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.',
        filesChanged: [], filesInspected: ['source.txt'],
        checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null }));
    },
  }, { executionPermissions: 'full-access' });
  const { runtime } = fixture;
  try {
    const finalizationAuthorized = runtime.concurrentEngine.store.finalizationAuthorized;
    let commitAuthorization = null;
    runtime.concurrentEngine.store.finalizationAuthorized = (facts) => {
      if (facts.action === 'commit') commitAuthorization = structuredClone(facts);
      return finalizationAuthorized(facts);
    };
    const request = runtime.leadAgent.requestHandler.sendMessage({ message: message(ownerGoal, {
      metadata: { acceptance: { source: 'agent', requiredChecks } },
    }), configuration: {} }, call());
    let timer;
    const result = await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(JSON.stringify({ providerCalls, permissionResolutions,
        runs: runtime.concurrentEngine.activeRuns(), mappings: runtime.orchestrator.mappings(),
        executions: runtime.concurrentEngine.roleService.projection(),
        objectives: runtime.concurrentEngine.store.listObjectives?.(runtime.projectId) || null,
        planner: runtime.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').all() }))), 10000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    assert.equal(runtime.concurrentEngine.getRunDigest(result.id).disposition, 'accepted');
    assert.ok(providerCalls.includes('coordinator'));
    assert.ok(providerCalls.includes('verifier'));
    assert.ok(dispatchedRequest);
    assert.equal(dispatchedCapability.verifyCandidate(), true);
    assert.ok(commitAuthorization);
    const objectiveId = runtime.orchestrator.mapping(result.id).objectiveId;
    const checkpointHistory = runtime.concurrentEngine.reviewStore.checkpointHistory.bind(runtime.concurrentEngine.reviewStore);
    const checkpoint = checkpointHistory({ projectId: runtime.projectId, objectiveId })[0].checkpoint;
    assert.deepEqual(checkpoint.checkPins, [...requiredCheckIds].sort());
    assert.deepEqual(commitAuthorization.record.request.requiredCheckIds, requiredCheckIds);
    assert.equal(finalizationAuthorized(commitAuthorization), true);
    for (const checkPins of [
      [...requiredCheckIds].sort().slice(1),
      [...requiredCheckIds].sort().concat('unexpected-check'),
      [...requiredCheckIds].sort().concat(requiredCheckIds[0]),
    ]) {
      runtime.concurrentEngine.reviewStore.checkpointHistory = (scope) => checkpointHistory(scope).map((entry) =>
        entry.checkpoint.checkpointId === checkpoint.checkpointId
          ? { ...entry, checkpoint: { ...entry.checkpoint, checkPins } }
          : entry);
      assert.equal(finalizationAuthorized(commitAuthorization), false, `checkpoint pins ${JSON.stringify(checkPins)} must be exact`);
    }
    runtime.concurrentEngine.reviewStore.checkpointHistory = checkpointHistory;
    assert.ok(permissionResolutions.length >= 3);
    assert.ok(permissionResolutions.every(({ workspace, requested, options }) => workspace === fixture.options.workspace
      && requested === 'full-access' && options?.fresh === true));
    assert.ok(fixture.permissionCalls.length >= 1);
    assert.ok(fixture.permissionCalls.every((request) => request.permissionProfile === ':danger-full-access'));
    assert.ok(fixture.permissionCalls.every((request) => !Object.hasOwn(request, 'sandboxPolicy')));
  } finally {
    try { await runtime.close(); }
    catch (_) {
      runtime.httpServer?.closeAllConnections?.();
      if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      await runtime.appServer.close?.();
      if (runtime.state.db.open) await runtime.state.close();
    }
  }
});

test('legacy downgrade checks the exact durable planner session even without a controller fence', async (t) => {
  for (const scenario of [
    { name: 'unknown planner turn', status: 'unknown', unsafe: true },
    { name: 'active planner turn', status: 'active', unsafe: true },
    { name: 'unrecognized planner state', status: 'unrecognized', unsafe: true },
    { name: 'complete planner turn', status: 'complete' },
    { name: 'stale planner turn', status: 'stale' },
    { name: 'reconciled planner turn', status: 'reconciled_no_effect' },
    { name: 'unrelated session', status: 'unknown', unrelated: true },
    { name: 'foreign project same session', status: 'unknown', foreignProject: true },
    { name: 'missing mapping session', status: 'unknown', mappingSession: null, unsafe: true },
    { name: 'empty mapping session', status: 'unknown', mappingSession: '', unsafe: true },
    { name: 'missing mapping objective', status: 'unknown', missingObjective: true, unsafe: true },
    { name: 'corrupt run session', status: 'unknown', corruptRun: true, unsafe: true },
    { name: 'corrupt mapping session', status: 'unknown', mappingSession: 'wrong-session', unsafe: true },
    { name: 'corrupt objective session', status: 'unknown', corruptObjective: true, unsafe: true },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        seeded.db.exec(`CREATE TABLE delivery_planner_turns (
          project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
          provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
          pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id));`);
        seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,pins_json,started_at,updated_at)
          VALUES(?,?,'fake-scope','fake-thread','fake-turn',?,'{}',1,1)`)
          .run(scenario.foreignProject ? 'ffffffffff' : fixture.runtime.projectId, scenario.unrelated ? 'other-session' : stored.sessionId, scenario.status);
        if (Object.hasOwn(scenario, 'mappingSession')) {
          seeded.db.prepare('UPDATE delivery_run_engines SET session_id=? WHERE run_id=?').run(scenario.mappingSession, stored.runId);
        }
        if (scenario.missingObjective) seeded.db.prepare('UPDATE delivery_run_engines SET objective_id=NULL WHERE run_id=?').run(stored.runId);
        if (scenario.corruptRun) seeded.db.prepare("UPDATE concurrent_delivery_runs SET session_id='wrong-session' WHERE run_id=?").run(stored.runId);
        if (scenario.corruptObjective) {
          const row = seeded.db.prepare('SELECT record_json FROM backlog_objectives WHERE objective_id=?').get(stored.objectiveId);
          seeded.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE objective_id=?')
            .run(JSON.stringify({ ...JSON.parse(row.record_json), sessionId: 'wrong-session' }), stored.objectiveId);
        }
        assert.equal(seeded.db.prepare('SELECT COUNT(*) AS n FROM concurrent_controller_fences').get().n, 0);
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'legacy-after-planner', goal: 'Use the changed default' });
        if (scenario.unsafe) {
          await assert.rejects(intake, { code: 'delivery_engine_unsafe' });
          assert.equal(restarted.orchestrator.mapping('legacy-after-planner'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['legacy-after-planner']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
        const ledger = restarted.state.db.prepare('SELECT session_id,status FROM delivery_planner_turns').get();
        assert.equal(ledger.session_id, scenario.unrelated ? 'other-session' : stored.sessionId);
        assert.equal(ledger.status, scenario.status);
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

function seedAuthoritativeEffects(db, projectId, stored, scenario) {
  if (scenario.intentState) {
    const index = scenario.intentIndex || 0;
    const intentId = `intent-${index}`;
    const existing = db.prepare('SELECT intent_id FROM candidate_intents WHERE intent_id=?').get(intentId);
    if (existing) {
      db.prepare('UPDATE candidate_intents SET state=? WHERE intent_id=?').run(scenario.intentState, intentId);
    } else {
      // Use real CandidateStore candidates and frozen manifests for terminal intent fixtures.
      const candidate = db.prepare('SELECT * FROM concurrent_candidates WHERE candidate_id=?').get(`candidate-next-${index}`);
      const base = db.prepare("SELECT * FROM concurrent_candidates WHERE candidate_id='candidate-base'").get();
      const before = db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(base.manifest_digest);
      const expected = db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(candidate.manifest_digest);
      db.prepare(`INSERT INTO candidate_intents(intent_id,project_id,objective_id,candidate_id,base_candidate_id,attempt_id,
        parent_candidate_id,integration_generation,environment_digest,check_identity,content_manifest_digest,
        before_manifest_json,expected_manifest_json,delta_paths_json,controls_json,admission_json,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'[]','{}','{}',?,'now','now')`)
        .run(intentId, projectId, stored.objectiveId, candidate.candidate_id, base.candidate_id, candidate.source_attempt_id,
          candidate.parent_candidate_id, candidate.integration_generation, candidate.environment_digest, candidate.check_identity,
          candidate.manifest_digest, before.manifest_json, expected.manifest_json, scenario.intentState);
    }
  }
  if (scenario.roleState) {
    const record = { projectId, objectiveId: stored.objectiveId, attemptId: 'role-attempt', taskId: 'role-task',
      state: scenario.roleState, effectsSettled: scenario.effectsSettled };
    db.prepare(`INSERT INTO delivery_role_executions(attempt_id,project_id,objective_id,task_id,fencing_token,provider_context_id,
      external_task_id,role_id,request_digest,settings_digest,state,record_json,created_at,updated_at)
      VALUES('role-attempt',?,?,'role-task',1,'role-context','role-external','engineer','request','settings',?,?,'now','now')`)
      .run(projectId, stored.objectiveId, scenario.roleState, JSON.stringify(record));
  }
}

test('legacy downgrade fences authoritative effect records independently of settled publication caches', async (t) => {
  for (const scenario of [
    { name: 'unknown candidate intent', intentState: 'unknown', unsafe: true },
    { name: 'prepared candidate intent', intentState: 'prepared', unsafe: true },
    { name: 'applying candidate intent', intentState: 'applying', unsafe: true },
    { name: 'settling candidate intent', intentState: 'settling', unsafe: true },
    { name: 'refused candidate intent', intentState: 'refused' },
    { name: 'not-applied candidate intent', intentState: 'not_applied' },
    { name: 'unknown role execution', roleState: 'unknown', effectsSettled: false, unsafe: true },
    { name: 'terminal role effects unknown', roleState: 'terminal', effectsSettled: false, unsafe: true },
    { name: 'terminal role effects missing', roleState: 'terminal', unsafe: true },
    { name: 'settled role effects', roleState: 'settled', effectsSettled: true },
    { name: 'terminal role effects', roleState: 'terminal', effectsSettled: true },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        seedConcurrentEffects(seeded.db, fixture.runtime.projectId, stored.objectiveId, { publicationStates: ['applied'] });
        seedAuthoritativeEffects(seeded.db, fixture.runtime.projectId, stored, scenario);
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'legacy-after-effects', goal: 'Use the changed default' });
        if (scenario.unsafe) {
          await assert.rejects(intake, { code: 'delivery_engine_unsafe' });
          assert.equal(restarted.orchestrator.mapping('legacy-after-effects'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['legacy-after-effects']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
        assert.equal(restarted.state.db.prepare('SELECT state FROM delivery_output_publications').get().state, 'applied');
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

test('settled publication observations require matching authoritative intent identity', async (t) => {
  for (const scenario of [
    { name: 'applied cache missing intent', cacheState: 'applied', missing: true, unsafe: true },
    { name: 'not-applied cache missing intent', cacheState: 'not_applied', missing: true, unsafe: true },
    { name: 'applied intent wrong project', cacheState: 'applied', wrongProject: true, unsafe: true },
    { name: 'applied intent wrong objective', cacheState: 'applied', wrongObjective: true, unsafe: true },
    { name: 'applied intent wrong ID', cacheState: 'applied', wrongId: true, unsafe: true },
    { name: 'matching applied intent', cacheState: 'applied' },
    { name: 'matching not-applied intent', cacheState: 'not_applied' },
    { name: 'refused cache without intent', cacheState: 'refused' },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        seedConcurrentEffects(seeded.db, fixture.runtime.projectId, stored.objectiveId, { publicationStates: [scenario.cacheState] });
        if (scenario.missing) seeded.db.prepare("DELETE FROM candidate_intents WHERE intent_id='intent-0'").run();
        if (scenario.wrongProject) seeded.db.prepare("UPDATE candidate_intents SET project_id='ffffffffff' WHERE intent_id='intent-0'").run();
        if (scenario.wrongObjective) seeded.db.prepare("UPDATE candidate_intents SET objective_id='other-objective' WHERE intent_id='intent-0'").run();
        if (scenario.wrongId) seeded.db.prepare("UPDATE candidate_intents SET intent_id='other-intent' WHERE intent_id='intent-0'").run();
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'legacy-after-publication', goal: 'Use the changed default' });
        if (scenario.unsafe) {
          await assert.rejects(intake, { code: 'delivery_engine_unsafe' });
          assert.equal(restarted.orchestrator.mapping('legacy-after-publication'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['legacy-after-publication']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

for (const closeMode of ['immediate', 'late', 'restart']) test(`cooperative held lost acknowledgement retries staged close after original provider group death with ${closeMode} provider close`, { timeout: 30000 }, async (t) => {
  const delayedClose = closeMode === 'late';
  const { spawn } = require('node:child_process');
  const { CodexAppServer } = require('../src/codex-app-server');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const producingIdentity = readProcessIdentity(child.pid);
  const cleanup = Object.create(CodexAppServer.prototype);
  cleanup.generation = 1; cleanup.child = child; cleanup.childExited = false;
  cleanup.currentChildState = { child, identity: producingIdentity, generation: 1, failed: false, exited: false };
  cleanup.readProcessIdentityImpl = readProcessIdentity;
  cleanup._request = async () => ({});
  const entered = deferred(); const release = deferred(); const providerClosed = deferred(); const abort = new AbortController();
  let workerCalls = 0; let closeCalls = 0; let fx;
  t.after(async () => { release.resolve(); providerClosed.resolve(); if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
  } });
  fx = await idleConcurrentServer(t, 'terminal-retry', {
    processIdentity: () => producingIdentity,
    async close() { closeCalls += 1; if (delayedClose) await providerClosed.promise; },
    async run(options) {
      const threadId = options.threadId || 'terminal-worker'; const turnId = `turn-${options.role.id}`;
      options.onTurnStart({ threadId, processIdentity: producingIdentity });
      let text;
      if ((options.role.id || options.role.name) === 'coordinator') {
        const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
        const task = { schemaVersion: 'delivery/v1', projectId: fx.runtime.projectId,
          objectiveId: fx.runtime.orchestrator.objectiveIdFor('terminal-retry'), taskId: 'terminal-worker', revision: 1,
          role: 'engineer', kind: 'implementation', objective: 'Retain terminal evidence.', priority: 0, dependencies: [],
          productWritePaths: ['worker.txt'], readScope: { kind: 'unknown', paths: null, reason: 'Test scope.' },
          scratchWriteRoots: [], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' };
        text = JSON.stringify({ expected: prompt.pins, delta: prompt.pins.planRevision === 0 ? { schemaVersion: 'delivery/v1',
          expectedPlanRevision: prompt.pins.planRevision, expectedGoalRevision: prompt.pins.goalRevision,
          expectedAuthorityRevision: prompt.pins.authorityRevision, expectedControlRevision: prompt.pins.controlRevision,
          nextPlanRevision: prompt.pins.planRevision + 1, tasks: [{ task }], dependencies: [] } : null,
          dialogue: 'Execute the worker.', recovery: null, ownerDecision: null });
      } else {
        workerCalls += 1;
        fs.writeFileSync(path.join(options.cwd, 'worker.txt'), 'private output\n');
        fs.writeFileSync(path.join(fx.options.workspace, 'source.txt'), 'shared drift\n');
        entered.resolve(); await release.promise;
        text = JSON.stringify({ outcome: 'completed', summary: 'Original terminal report.', filesChanged: ['worker.txt'],
          filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
      }
      const ctx = { generation: 1, childState: cleanup.currentChildState, processIdentity: producingIdentity };
      await cleanup._cleanupTerminal({ terminal: true, ctx, threadId, turnId });
      return { status: 'completed', text, threadId, turnId, execution: { generation: 1, processIdentity: producingIdentity,
        threadId, turnId, turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupReceipt: ctx.cleanupReceipt } };
    },
  });
  const { runtime } = fx;
  t.after(async () => {
    release.resolve();
    try { await runtime.close(); } catch (_) {
      runtime.httpServer.closeAllConnections();
      if (runtime.httpServer.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      if (runtime.state.db.open) await runtime.state.close();
    }
  });
  const running = runtime.orchestrator.run({ runId: 'terminal-retry', goal: 'Retain private failure evidence.',
    contract: { requiredChecks: [] }, signal: abort.signal });
  await entered.promise; abort.abort(); await running;
  await assert.rejects(runtime.close(), { code: 'concurrent_shutdown_unsafe' });
  assert.equal(closeCalls, 0, 'provider close must wait for held invocation');
  assert.equal(runtime.state.db.open, true);
  assert.throws(() => acquireWorkspaceLock(fx.options.workspace, { lockDir: fx.options.workspaceLockDir }), /in use/i);
  await assert.rejects(runtime.concurrentEngine.resume({ runId: 'terminal-retry' }), { code: 'concurrent_shutdown_admission_closed' });
  // The caller's bound can expire just before the held drain rejects internally.
  const retainedPreparation = runtime.concurrentEngine.shutdownPreparation;
  if (retainedPreparation) await assert.rejects(retainedPreparation, { code: 'concurrent_shutdown_unsafe' });
  release.resolve();
  await waitFor(() => !runtime.concurrentEngine.roleService.active.size, 'held invocation did not finish');
  const pending = runtime.close();
  const overlapping = runtime.close();
  const outcomes = Promise.allSettled([pending, overlapping]);
  await waitFor(() => closeCalls > 0, 'provider close not called');
  assert.equal(runtime.state.db.open, true, 'close acknowledgement alone must retain ownership');
  const phase = JSON.parse(runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json);
  assert.deepEqual(phase.identities, [producingIdentity]);
  const interruptedState = `${fx.options.stateFile}.interrupted`;
  if (closeMode === 'restart') await runtime.state.db.backup(interruptedState);
  const timedOut = await outcomes;
  assert.ok(timedOut.every((result) => result.status === 'rejected'));
  assert.equal(runtime.state.db.open, true, 'caller timeout must retain state ownership');
  assert.equal(closeCalls, 1, 'overlapping timed-out callers must share provider close');
  if (delayedClose) {
    providerClosed.resolve();
    const exit = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
    await waitFor(() => JSON.parse(runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase === 'released',
      'late internal shutdown did not finish after caller timeout');
    assert.equal(runtime.state.db.open, true, 'internal completion awaits caller retry before releasing host ownership');
    assert.equal(closeCalls, 1);
  } else {
    const exit = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
  }
  // The internal bounded group observer may finish just after its caller timeout.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await runtime.close();
  await runtime.close();
  if (closeMode === 'restart') {
    // Reopen the durable state captured before provider exit, as after a host crash.
    const restarted = await startServer({ ...fx.options, stateFile: interruptedState }).catch((error) => { throw error.cause || error; });
    try {
      assert.equal(JSON.parse(restarted.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase, 'released');
      const recovered = JSON.parse(restarted.state.db.prepare('SELECT record_json FROM backlog_attempts').get().record_json);
      assert.ok(['failed', 'canceled'].includes(recovered.state));
      assert.equal(workerCalls, 1, 'startup must not rerun the producer');
      assert.equal(restarted.state.db.prepare('SELECT COUNT(*) AS n FROM delivery_output_publications').get().n, 0);
    } finally { await restarted.close(); }
  }
  assert.equal(workerCalls, 1); assert.equal(closeCalls, closeMode === 'restart' ? 2 : 1);
  const reopened = await openStateDatabase({ filePath: fx.options.stateFile });
  assert.equal(JSON.parse(reopened.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase, 'released');
  const attempt = JSON.parse(reopened.db.prepare('SELECT record_json FROM backlog_attempts').get().record_json);
  const record = JSON.parse(reopened.db.prepare('SELECT record_json FROM delivery_role_executions').get().record_json);
  assert.ok(['failed', 'canceled'].includes(attempt.state));
  assert.equal(record.result.output.state, 'not_published');
  assert.equal(record.report.summary, 'Original terminal report.');
  assert.equal(record.terminalShutdown.drift.changed, true);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM delivery_output_publications').get().n, 0);
  assert.equal(fs.readFileSync(path.join(fx.options.workspace, 'source.txt'), 'utf8'), 'shared drift\n');
  await reopened.close();
  const unlock = acquireWorkspaceLock(fx.options.workspace, { lockDir: fx.options.workspaceLockDir }); unlock();
  fs.writeFileSync(fx.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
  const legacy = await startServer(fx.options);
  try {
    assert.equal(legacy.orchestrator.mapping('terminal-retry').engine, 'concurrent-v1');
    assert.equal((await legacy.orchestrator.run({ runId: 'fresh-after-terminal', goal: 'Use the selected legacy engine.' })).status, 'completed');
    assert.equal(legacy.orchestrator.mapping('fresh-after-terminal').engine, 'legacy');
    assert.deepEqual(JSON.parse(legacy.state.db.prepare('SELECT record_json FROM backlog_attempts').get().record_json), attempt);
    assert.deepEqual(JSON.parse(legacy.state.db.prepare('SELECT record_json FROM delivery_role_executions').get().record_json), record);
    assert.equal(workerCalls, 1);
  } finally { await legacy.close(); }
});

test('released shutdown phase permits fresh host intake on the same workspace and database', { timeout: 15000 }, async (t) => {
  const fx = await idleConcurrentServer(t, 'released-reopen', { async run(options) {
    if ((options.role.id || options.role.name) === 'coordinator') {
      const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
      return turnResult(options, JSON.stringify({ expected: pins, delta: null, dialogue: 'Review the candidate.', recovery: null, ownerDecision: null }));
    }
    const details = scopedExecutionDetails(options.deliveryCapability);
    execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
    return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate accepted.', filesChanged: [],
      filesInspected: ['source.txt'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }],
      risks: [], scopeExpansion: [], decisionRequest: null }));
  } });
  await fx.runtime.close();
  const reopened = await startServer(fx.options);
  try {
    assert.equal(reopened.concurrentEngine.shutdownRequested, false);
    const result = await reopened.leadAgent.requestHandler.sendMessage({ message: message('Accept the unchanged candidate.'), configuration: {} }, call());
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    assert.equal(reopened.concurrentEngine.getRunDigest(result.id).disposition, 'accepted');
  } finally { await reopened.close(); }
});
