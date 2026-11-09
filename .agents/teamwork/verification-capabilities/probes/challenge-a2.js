'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflightVerification, findExecutable } = require('../../../../src/verification-preflight');

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-challenge-'));
  try {
    const marker = path.join(workspace, 'executed');
    const executable = path.join(workspace, 'check');
    fs.writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const owner = { source: 'owner', requiredChecks: [{ id: 'unit', argv: ['./check'] }] };
    const first = await preflightVerification({ workspace, contract: owner, env: { PATH: '' } });
    assert.equal(first.status, 'available');
    assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(path.join(workspace, 'candidate'), 'changed');
    const second = await preflightVerification({ workspace, contract: owner, env: { PATH: '' } });
    assert.equal(second.route, first.route);
    assert.equal(fs.existsSync(marker), false);
    fs.unlinkSync(executable);
    assert.equal((await preflightVerification({ workspace, contract: owner, env: { PATH: '' } })).status, 'unavailable');
    assert.equal(findExecutable('check', workspace, { PATH: workspace }).status, 'unavailable');

    let calls = 0;
    let late;
    const appServer = {
      generation: 1,
      execCommand() { throw new Error('preflight executed a command'); },
      resolveExecutionPermissions() { calls += 1; return new Promise((resolve) => { late = resolve; }); },
    };
    const agent = { source: 'agent', requiredChecks: [{ id: 'unit', argv: ['node', 'test.js'] }] };
    const controller = new AbortController();
    const pending = preflightVerification({ appServer, workspace, contract: agent, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.status, 'unknown');
    assert.equal(aborted.policy.reason, 'inspection_aborted');
    assert.equal(calls, 1);
    late({ mode: 'inherit' });
    await new Promise((resolve) => setImmediate(resolve));
    const recovered = await preflightVerification({ appServer, workspace, contract: agent });
    assert.equal(recovered.status, 'available');
    assert.equal(calls, 1);

    const failingServer = {
      generation: 1,
      execCommand() { throw new Error('preflight executed a command'); },
      resolveExecutionPermissions() { throw new Error('offline'); },
    };
    const failed = await preflightVerification({ appServer: failingServer, workspace, contract: agent });
    assert.equal(failed.status, 'unknown');
    assert.equal(failed.policy.reason, 'policy_resolution_unverified');
    assert.equal(fs.existsSync(marker), false);

    const hangingServer = {
      generation: 1,
      execCommand() { throw new Error('preflight executed a command'); },
      resolveExecutionPermissions() { return new Promise(() => {}); },
    };
    const started = Date.now();
    const timedOut = await preflightVerification({ appServer: hangingServer, workspace, contract: agent });
    assert.equal(timedOut.status, 'unknown');
    assert.equal(timedOut.policy.reason, 'policy_lookup_timeout');
    assert.ok(Date.now() - started >= 1900 && Date.now() - started < 3000);
    assert.equal(fs.existsSync(marker), false);
    process.stdout.write('PASS: command-free lookup, candidate route stability, repaired lookup, abort, late read, policy failure and timeout\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
