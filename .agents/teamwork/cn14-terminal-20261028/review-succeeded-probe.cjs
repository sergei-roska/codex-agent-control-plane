'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const filename = path.resolve('test/delivery-role-service.test.js');
const helper = new Module(filename, module);
helper.filename = filename;
helper.paths = Module._nodeModulePaths(path.dirname(filename));
const prefix = fs.readFileSync(filename, 'utf8').split("test('registered delivery")[0];
// Load only the fixture definitions before the first test.
const definition = fs.readFileSync(filename, 'utf8').slice(0, fs.readFileSync(filename, 'utf8').indexOf("test("));
helper._compile(definition + '\nmodule.exports={fixture,identity,report};', filename);
const { fixture, identity, report } = helper.exports;
const { CodexAppServer } = require('../../../src/codex-app-server');
const { readProcessIdentity } = require('../../../src/process-quiescence');
(async () => {
 const hooks=[];
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j)});
 const processIdentity=readProcessIdentity(child.pid);
 const cleanup=Object.create(CodexAppServer.prototype);
 cleanup.generation=1;cleanup.child=child;cleanup.childExited=false;
 cleanup.currentChildState={child,identity:processIdentity,generation:1,failed:false,exited:false};
 cleanup.readProcessIdentityImpl=readProcessIdentity;cleanup._request=async()=>({});
 try {
  const fx=await fixture({after(fn){hooks.push(fn)}},{role:'explorer',appServer:{async run(options){
    const threadId='readonly-thread',turnId='readonly-turn';options.onTurnStart({threadId,processIdentity});
    const ctx={generation:1,childState:cleanup.currentChildState,processIdentity};
    await cleanup._cleanupTerminal({terminal:true,ctx,threadId,turnId});
    return {status:'completed',text:report([]),threadId,turnId,execution:{generation:1,processIdentity,threadId,turnId,turnStartSent:true,turnStartRejected:false,turnTerminal:true,cleanupReceipt:ctx.cleanupReceipt}};
  }}});
  await fx.executor.execute(identity(fx));
  const succeeded=await fx.executor.poll(identity(fx));assert.equal(succeeded.state,'succeeded');
  const recovery={...identity(fx),recoveryGeneration:0};
  assert.throws(()=>fx.service.prepareTerminalShutdown(recovery),{code:'delivery_role_shutdown_replay_unavailable'});
  assert.equal(fx.store.listAttempts(recovery.projectId,recovery.objectiveId)[0].state,'succeeded');
  console.log('PASS: successful readonly attempt with production cleanup receipt is excluded from terminal failure selection');
 } finally {
  if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exit;}
  for(const fn of hooks.reverse()) await fn();
 }
})().catch(e=>{console.error(e);process.exitCode=1});
