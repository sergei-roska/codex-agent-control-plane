'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findExecutable, preflightVerification, routeIdentity } = require('../src/verification-preflight');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('owner executable lookup handles cwd-relative and PATH commands without executing workspace code', async (t) => {
  const cwd = tempDir(t);
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(cwd, 'executed');
  const command = path.join(cwd, 'check');
  fs.writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  assert.deepEqual(findExecutable('./check', cwd, { PATH: '' }), { status: 'available' });
  assert.deepEqual(findExecutable('tool', cwd, { PATH: bin }), { status: 'available' });
  assert.deepEqual(findExecutable('missing-tool', cwd, { PATH: bin }), { status: 'unavailable', reason: 'executable_not_found' });
  const result = await preflightVerification({
    workspace: cwd,
    contract: { requiredChecks: [{ id: 'local', argv: ['./check'] }] },
    env: { PATH: '' },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.scope, 'local_route_capability_only');
  assert.equal(result.routeType, 'fingerprint');
  assert.equal(result.routeCallable, false);
  assert.equal(result.checks[0].dependencies, 'unverified');
  assert.equal(fs.existsSync(marker), false);
});

test('owner executable availability refreshes after local environment repair', async (t) => {
  const cwd = tempDir(t);
  const contract = { requiredChecks: [{ id: 'unit', argv: ['repairable-check'] }] };
  const env = { PATH: cwd };
  const before = await preflightVerification({ workspace: cwd, contract, env });
  assert.equal(before.status, 'unavailable');
  fs.writeFileSync(path.join(cwd, 'repairable-check'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const after = await preflightVerification({ workspace: cwd, contract, env });
  assert.equal(after.status, 'available');
  assert.equal(after.route, before.route);
});

test('agent checks require execCommand and inherited resolved policy and never report test success', async (t) => {
  const workspace = tempDir(t);
  const contract = { source: 'agent', requiredChecks: [{ id: 'unit', argv: ['node', 'test.js'] }] };
  const missingApi = await preflightVerification({ appServer: { execCommand: async () => ({}) }, workspace, contract });
  assert.equal(missingApi.status, 'unknown');
  assert.equal(missingApi.policy.mode, 'unknown');

  const noExec = await preflightVerification({
    appServer: { resolveExecutionPermissions: async () => ({ mode: 'inherit' }) }, workspace, contract,
  });
  assert.equal(noExec.status, 'unavailable');
  assert.equal(noExec.checks[0].reason, 'exec_command_unavailable');

  const strict = await preflightVerification({
    appServer: { execCommand: async () => ({}), resolveExecutionPermissions: async () => ({ mode: 'strict', reason: 'native_policy_unavailable' }) },
    workspace, contract,
  });
  assert.equal(strict.status, 'available');
  assert.equal(strict.policy.mode, 'strict');
  assert.equal(strict.checks[0].reason, 'native_policy_unavailable');

  const available = await preflightVerification({
    appServer: { execCommand: async () => ({}), resolveExecutionPermissions: async () => ({ mode: 'inherit', profileApi: false, sandboxMode: 'workspace-write' }) },
    workspace, contract,
  });
  assert.equal(available.status, 'available');
  assert.equal(available.routeType, 'fingerprint');
  assert.equal(available.routeCallable, false);
  assert.equal(available.policy.verifierIpcNetworkAccess, true);
  assert.equal(available.checks[0].dependencies, 'unverified');
  assert.match(available.evidence, /test results.*unverified/);
});

test('preflight hashes verifier IPC network capability and reports managed profiles honestly', async (t) => {
  const workspace = tempDir(t);
  const contract = { source: 'agent', requiredChecks: [{ id: 'unit', argv: ['node', 'test.js'] }] };
  const execCommand = async () => ({});
  const legacy = await preflightVerification({
    appServer: { execCommand, resolveExecutionPermissions: async () => ({ mode: 'inherit', profileApi: false, sandboxMode: 'workspace-write' }) },
    workspace, contract,
  });
  const managed = await preflightVerification({
    appServer: { execCommand, resolveExecutionPermissions: async () => ({ mode: 'inherit', profileApi: true, writerProfile: ':workspace' }) },
    workspace, contract,
  });
  const fullAccess = await preflightVerification({
    appServer: { execCommand, resolveExecutionPermissions: async () => ({ mode: 'full-access', profileApi: true,
      writerProfile: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' }) },
    workspace, contract,
  });

  assert.notEqual(legacy.route, managed.route);
  assert.equal(legacy.policy.verifierIpcNetworkAccess, true);
  assert.equal(managed.status, 'unknown');
  assert.equal(managed.checks[0].reason, 'managed_profile_network_unverified');
  assert.equal(managed.policy.verifierIpcNetworkAccess, false);
  assert.equal(fullAccess.status, 'available');
  assert.equal(fullAccess.policy.verifierIpcNetworkAccess, true);
  assert.deepEqual(fullAccess.policy, { mode: 'full-access', reason: null, verifierIpcNetworkAccess: true,
    ownerFullAccess: true, profile: ':danger-full-access', approvalPolicy: 'never' });
});

test('verification route identity changes when the verifier IPC network grant changes', () => {
  const input = {
    project: '/workspace/project',
    contract: { source: 'agent', requiredChecks: [{ id: 'unit', argv: ['npm', 'test'] }] },
    policy: { mode: 'inherit', profileApi: false, sandboxMode: 'workspace-write', verifierIpcNetworkAccess: false },
    policySetting: 'inherit',
  };
  const withoutGrant = routeIdentity(input);
  const withGrant = routeIdentity({ ...input, policy: { ...input.policy, verifierIpcNetworkAccess: true } });
  assert.notEqual(withGrant, withoutGrant);
});

test('native policy resolution is cached for an unchanged project setting', async (t) => {
  const workspace = tempDir(t);
  const contract = { source: 'agent', requiredChecks: [{ id: 'unit', argv: ['node', 'test.js'] }] };
  let calls = 0;
  const appServer = {
    generation: 1,
    execCommand: async () => ({}),
    async resolveExecutionPermissions() { calls += 1; return { mode: 'inherit', profileApi: true, writerProfile: `profile-${calls}` }; },
  };
  const first = await preflightVerification({ appServer, workspace, contract });
  const second = await preflightVerification({ appServer, workspace, contract });
  assert.equal(calls, 1);
  assert.equal(second.route, first.route);
  appServer.generation = 2;
  const afterRestart = await preflightVerification({ appServer, workspace, contract });
  assert.equal(calls, 2);
  assert.notEqual(afterRestart.route, first.route);
});

test('an aborted native policy lookup returns unknown without allowing lead planning to continue', async (t) => {
  const workspace = tempDir(t);
  const controller = new AbortController();
  const appServer = {
    execCommand: async () => ({}),
    resolveExecutionPermissions: () => new Promise(() => {}),
  };
  const pending = preflightVerification({
    appServer, workspace, signal: controller.signal,
    contract: { source: 'agent', requiredChecks: [{ id: 'unit', argv: ['node', 'test.js'] }] },
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.equal(result.policy.reason, 'inspection_aborted');
});
