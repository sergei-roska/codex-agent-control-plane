'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { openStateDatabase } = require('../../../src/durable-store');
const filename = path.resolve('test/server-delivery-engine.test.js');
const helper = new Module(filename, module);
helper.filename = filename; helper.paths = Module._nodeModulePaths(path.dirname(filename));
const source = fs.readFileSync(filename, 'utf8').replace("const test = require('node:test');", 'const test = () => {};');
helper._compile(source + '\nmodule.exports = { idleConcurrentServer };', filename);
(async () => {
 const hooks = []; let release;
 const held = new Promise((resolve) => { release = resolve; });
 const fx = await helper.exports.idleConcurrentServer({ after(fn) { hooks.push(fn); } }, 'timeout-release-probe', { async close() { await held; } });
 try {
  await assert.rejects(fx.runtime.close(), { code: 'concurrent_shutdown_unsafe' });
  release();
  let phase;
  for (let i = 0; i < 100; i += 1) {
   phase = JSON.parse(fx.runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json);
   if (phase.phase === 'released') break;
   await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(phase.phase, 'released');
  await fx.runtime.close();
  const reopened = await openStateDatabase({ filePath: fx.options.stateFile });
  const finalPhase = JSON.parse(reopened.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json);
  console.log(JSON.stringify({ phaseBeforeRetry: phase.phase, phaseAfterSuccessfulRetry: finalPhase.phase }));
  await reopened.close();
  assert.equal(finalPhase.phase, 'released', 'successful retry must leave reopen admission released');
 } finally { release(); for (const fn of hooks.reverse()) { try { await fn(); } catch (_) {} } }
})().catch((error) => { console.error(error); process.exitCode = 1; });
