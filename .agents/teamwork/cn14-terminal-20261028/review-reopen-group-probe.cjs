'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const filename=path.resolve('test/concurrent-delivery-engine.test.js');
const helper=new Module(filename,module);helper.filename=filename;helper.paths=Module._nodeModulePaths(path.dirname(filename));
const source=fs.readFileSync(filename,'utf8');helper._compile(source.slice(0,source.indexOf('test('))+'\nmodule.exports={createHarness};',filename);
const {createHarness}=helper.exports;
const {readProcessIdentity,isProcessGroupGone}=require('../../../src/process-quiescence');
(async()=>{
 const hooks=[];const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j)});
 const current=readProcessIdentity(child.pid);
 try{
  const fx=await createHarness({after(fn){hooks.push(fn)}},{appServer:{processIdentity:()=>current,async run(){throw new Error('unexpected provider turn')}}});
  fx.db.prepare('INSERT INTO concurrent_shutdown_phases(project_id,phase_json) VALUES(?,?)').run('0123456789',JSON.stringify({phase:'provider_closing',attempts:[],identities:[]}));
  const prepared=await fx.engine.prepareShutdown();fx.engine.beginProviderShutdown();
  await assert.rejects(fx.engine.finishShutdown(),{code:'concurrent_shutdown_process_alive'});
  assert.deepEqual(prepared.identities,[current]);
  console.log(JSON.stringify({phase:prepared.phase,retainedIdentities:prepared.identities,currentGroupGone:isProcessGroupGone(current),result:'release refused'}));
 }finally{if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exit;}for(const fn of hooks.reverse())await fn();}
})().catch(e=>{console.error(e);process.exitCode=1});
