'use strict';

// Intake authentication failure: a dedicated wait reason instead of intake_error. Real startServer over a
// temp git workspace; only the Codex app server is faked (same shape as test/delivery-controller.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { createAccountHealth } = require('../src/account-health');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-auth-'));
delete process.env.NODE_TEST_CONTEXT;

const CHECK = { id: 'unit', argv: ['node', '--test', 'test/tiny.test.js'], timeoutMs: 60000, description: 'Tiny unit test' };
let seq = 0;
const cmd = () => `auth-${process.pid}-${String(++seq).padStart(5, '0')}`;

const runGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"tiny","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, 'src', 'greet.js'), "module.exports = () => 'hello';\n");
  fs.writeFileSync(path.join(dir, 'test', 'tiny.test.js'), "require('node:test')('x', () => {});\n");
  runGit(dir, 'init', '-q', '-b', 'main');
  runGit(dir, 'config', 'user.email', 'test@example.com');
  runGit(dir, 'config', 'user.name', 'Test');
  runGit(dir, 'add', '-A');
  runGit(dir, 'commit', '-q', '-m', 'base');
}

async function withStack(appServer, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-auth-'));
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ baseRef: 'main', checks: [CHECK], rolePack: 'legacy-orch' }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  makeWorkspace(workspace);
  let runtime;
  try {
    runtime = await startServer({
      port: 0,
      workspace,
      appServer,
      stateFile: path.join(root, 'state.sqlite'),
      tokenFile: path.join(root, 'token', 'a2a-token'),
      projectConfigFile: path.join(root, 'project.json'),
      deliveryTickMs: 25,
      orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
    });
    await fn(runtime);
  } finally {
    if (runtime) await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function settledRun(runtime) {
  const ticket = runtime.productStore.createTicket({
    commandId: cmd(), title: 'Add a helper', description: 'Add farewell()', criteria: ['farewell() returns bye'],
  }).ticket;
  runtime.productStore.submitTicket(ticket.ticketId, { commandId: cmd(), expectedVersion: ticket.version }, runtime.deliveryController.settingsSnapshot());
  runtime.deliveryController.poke();
  const deadline = Date.now() + 20000;
  for (;;) {
    const run = runtime.productStore.latestRunOf(ticket.ticketId);
    if (runtime.productStore.getTicket(ticket.ticketId).status === 'blocked' && run && run.phase === 'settled') return run;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the settled run');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test('an Intake auth failure settles as auth_required, blocks the ticket and releases the lease', async () => {
  const error = Object.assign(
    new Error('Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.'),
    { codexError: { codexErrorInfo: 'unauthorized' } },
  );
  await withStack(makeFakeAppServer({ intakeScript: [error] }), async (runtime) => {
    const run = await settledRun(runtime);
    assert.equal(run.status, 'failed');
    assert.equal(run.waitReason, 'auth_required');
    assert.equal(run.waitDetail.code, 'auth_required');
    assert.match(run.waitDetail.message, /sign in again/i);
    assert.equal(runtime.productStore.getLease(), null);
  });
});

test('an Intake auth failure without a typed variant is recognised by its message; other errors stay intake_error', async () => {
  await withStack(makeFakeAppServer({ intakeScript: [new Error('Please log in again')] }), async (runtime) => {
    const run = await settledRun(runtime);
    assert.equal(run.waitReason, 'auth_required');
  });
  await withStack(makeFakeAppServer({ intakeScript: [new Error('boom')] }), async (runtime) => {
    const run = await settledRun(runtime);
    assert.equal(run.waitReason, 'execution_error');
    assert.equal(run.waitDetail.code, 'intake_error');
  });
});

test('account health invalidate drops the cache so the next read asks the app server again', async () => {
  let reads = 0;
  const health = createAccountHealth({ appServer: { async getAccount() { reads += 1; return { account: null }; } }, now: () => 1_000 });
  await health.get();
  await health.get({ force: true });
  assert.equal(reads, 1);
  health.invalidate();
  await health.get({ force: true });
  assert.equal(reads, 2);
});
