'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const filename = path.resolve('test/server-delivery-engine.test.js');
const helper = new Module(filename, module);
helper.filename = filename; helper.paths = Module._nodeModulePaths(path.dirname(filename));
helper._compile(fs.readFileSync(filename, 'utf8').replace("const test = require('node:test');", 'const test = () => {};') + '\nmodule.exports = { idleConcurrentServer, startServer };', filename);
const phase = (runtime) => JSON.parse(runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase;
(async () => {
 const hooks = []; let release; let closes = 0;
 const held = new Promise((resolve) => { release = resolve; });
 const fx = await helper.exports.idleConcurrentServer({ after(fn) { hooks.push(fn); } }, 'overlap-probe', { async close() { closes++; await held; } });
 try {
  const first = fx.runtime.close(); const second = fx.runtime.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closes, 1); assert.equal(phase(fx.runtime), 'provider_closing');
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(r => r.reason?.code), ['concurrent_shutdown_unsafe', 'concurrent_shutdown_unsafe']);
  assert.equal(closes, 1); assert.equal(phase(fx.runtime), 'provider_closing');
  const third = fx.runtime.close(); const fourth = fx.runtime.close();
  await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(closes, 1);
  release(); await Promise.all([third, fourth]); assert.equal(closes, 1);
  const reopened = await helper.exports.startServer(fx.options);
  try {
   assert.equal(phase(reopened), 'released');
   reopened.concurrentEngine.fenceShutdown(); assert.equal(phase(reopened), 'draining');
  } finally { await reopened.close(); }
  console.log('PASS overlapping timeout/retry, single provider close, fresh lifecycle fence');
 } finally { release(); for (const fn of hooks.reverse()) { try { await fn(); } catch (_) {} } }
})().catch(e => { console.error(e); process.exitCode = 1; });
