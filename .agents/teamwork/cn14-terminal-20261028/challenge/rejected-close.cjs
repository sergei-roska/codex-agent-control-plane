'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const filename = path.resolve('test/server-delivery-engine.test.js');
const helper = new Module(filename, module);
helper.filename = filename; helper.paths = Module._nodeModulePaths(path.dirname(filename));
helper._compile(fs.readFileSync(filename, 'utf8').replace("const test = require('node:test');", 'const test = () => {};') + '\nmodule.exports = { idleConcurrentServer };', filename);
(async () => {
 const hooks = []; let calls = 0;
 const fx = await helper.exports.idleConcurrentServer({ after(fn) { hooks.push(fn); } }, 'rejection-probe', { async close() { calls++; throw new Error('provider close failed'); } });
 await assert.rejects(fx.runtime.close(), /provider close failed/);
 await assert.rejects(fx.runtime.close(), /provider close failed/);
 assert.equal(calls, 1);
 assert.equal(JSON.parse(fx.runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase, 'provider_closing');
 fx.runtime.concurrentEngine.fenceShutdown();
 assert.equal(JSON.parse(fx.runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase, 'provider_closing');
 for (const fn of hooks.reverse()) { try { await fn(); } catch (_) {} }
 console.log('PASS rejected provider close retains phase and does not resend');
 process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
