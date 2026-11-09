'use strict';
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const test = require('node:test'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..'), filename = path.join(root, 'test/concurrent-delivery-engine.test.js');
const helper = new Module(filename, module); helper.filename = filename; helper.paths = Module._nodeModulePaths(path.dirname(filename));
helper._compile(fs.readFileSync(filename, 'utf8').split("test('cooperative writer mode")[0] + '\nmodule.exports = { createHarness, waitFor, deferred, projectId, readProcessIdentity };', filename);
const { createHarness, waitFor, deferred, projectId, readProcessIdentity } = helper.exports;
const intake = signal => ({ runId:'race-run', goal:'Race fixture', contract:{requiredChecks:[]}, signal, engineMapping:{engine:'concurrent-v1',projectId,objectiveId:'engine-objective-1',sessionId:'race-session'} });
function result(o) { const processIdentity = readProcessIdentity(process.pid); o.onTurnStart({threadId:o.threadId,processIdentity}); return {threadId:o.threadId,turnId:'race-turn',status:'completed',text:JSON.stringify({expected:JSON.parse(o.input.slice(o.input.indexOf('\n')+1)).pins,delta:null,dialogue:null,recovery:null,ownerDecision:null}),execution:{threadId:o.threadId,turnId:'race-turn',processIdentity,turnStartSent:true,turnStartRejected:false,turnTerminal:true}}; }
for (const scenario of ['cancel-duplicate', 'shutdown-resume']) test(scenario,{timeout:15000},async t => {
 const entered=deferred(), release=deferred(); let calls=0, active=0, max=0;
 t.after(() => release.resolve());
 const {engine,db}=await createHarness(t,{appServer:{async run(o){calls++; active++; max=Math.max(max,active); const r=result(o); if(calls===1){entered.resolve(); await release.promise;} active--; return r;}}});
 const original=engine.run(intake()); await entered.promise; assert.equal(engine.requestPause('race-run'),true); assert.equal((await original).pause.kind,'owner_pause');
 const abort=new AbortController();
 if(scenario==='cancel-duplicate') {
  const a=engine.resume({runId:'race-run',signal:abort.signal}); const b=engine.resume({runId:'race-run'}); abort.abort();
  assert.equal((await a).status,'canceled'); assert.equal((await b).status,'canceled');
  release.resolve(); await waitFor(()=>active===0,'held planner did not drain');
  assert.equal(engine.controlStatus('race-run').disposition,'canceled'); assert.equal(calls,1); assert.equal(max,1);
 } else {
  const closing=engine.shutdown(); const resumed=engine.resume({runId:'race-run',signal:abort.signal});
  await new Promise(r=>setTimeout(r,150)); assert.equal(calls,1); assert.equal(max,1);
  release.resolve(); await assert.rejects(closing, {code:'concurrent_shutdown_unsafe'});
  await new Promise(r=>setTimeout(r,150)); assert.equal(max,1);
  abort.abort(); await resumed;
 }
 t.diagnostic(JSON.stringify({calls,max,disposition:engine.controlStatus('race-run').disposition,turns:db.prepare('SELECT status FROM delivery_planner_turns').all()}));
});
test('generation-change before resume fences old controller',{timeout:15000},async t => {
 const entered=deferred(),release=deferred(); let calls=0;
 t.after(()=>release.resolve());
 const {engine}=await createHarness(t,{appServer:{async run(o){calls++; const r=result(o); entered.resolve(); await release.promise; return r;}}});
 const pending=engine.run(intake()); await entered.promise;
 assert.equal(engine.requestPause('race-run'),true); assert.equal((await pending).pause.kind,'owner_pause');
 const before=engine.controlStatus('race-run').revisions;
 engine.store.advanceOwnerGeneration(projectId,'engine-objective-1',before.ownerGeneration);
 await assert.rejects(engine.resume({runId:'race-run'}), /owner_generation_stale/);
 assert.equal(engine.controlStatus('race-run').disposition,'paused_owner'); assert.equal(calls,1);
 release.resolve(); await waitFor(()=>!engine.controllers.get('race-run').cycle,'old planner did not drain');
 t.diagnostic(JSON.stringify(engine.controlStatus('race-run').revisions));
});
