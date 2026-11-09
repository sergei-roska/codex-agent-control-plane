'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { startServer } = require('../src/server');
const { createLauncherApp } = require('../src/launcher-app');
const { createAccountProfiles } = require('../src/account-profiles');

const RATE_LIMITS_OK = { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null }, rateLimitsByLimitId: null };
const FINISH = JSON.stringify({ action: 'finish', assignments: [], final: 'Completed after account re-authentication.', resolutions: [], humanInput: null });

function userMessage(text) {
  return {
    messageId: 'auth-recovery-intake', contextId: '', taskId: '', role: 1,
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  };
}

function callContext() {
  return new ServerCallContext({ tenant: '' });
}

function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        if (await predicate()) return resolve();
        if (Date.now() >= deadline) return reject(new Error(typeof message === 'function' ? await message() : message));
        setTimeout(poll, 10);
      } catch (cause) {
        reject(cause);
      }
    };
    poll();
  });
}

test('AD-08 existing-profile sign-in automatically resumes the same auth-waiting run and check', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-delivery-auth-recovery-'));
  const workspace = path.join(root, 'workspace');
  const accountsDir = path.join(root, 'accounts');
  const stateFile = path.join(root, 'state.sqlite');
  const settingsFile = path.join(root, 'settings.json');
  const roleOverridesFile = path.join(root, 'roles.json');
  const tokenFile = path.join(root, 'token');
  const previousCodexHome = process.env.CODEX_HOME;
  let authenticated = false;
  let providerCalls = 0;
  let loginCompletion;
  let loginApp;
  let loginServer;
  let runtime;

  fs.mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Auth Recovery Fixture');
  git('config', 'user.email', 'auth-recovery@example.invalid');
  fs.writeFileSync(path.join(workspace, 'verify-auth.js'), "'use strict';\nprocess.exit(0);\n");
  git('add', '.');
  git('commit', '-qm', 'fixture');

  const profiles = createAccountProfiles({ accountsDir, codexDefaultHome: path.join(root, 'default-home') });
  const profile = profiles.addProfile({ name: 'existing-profile' });
  profiles.setActive('existing-profile');
  fs.writeFileSync(path.join(profile.home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-auth-recovery-account' } }));
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit' }));
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: {
    coordinator: { model: 'auth-recovery-model', effort: 'low', fastMode: 'off' },
  } }));

  const appServerFactory = (home) => {
    const codexHome = home || profile.home;
    return {
      async start() {},
      async close() {},
      getCodexHome: () => codexHome,
      getVersion: () => 'auth-recovery-offline/1',
      processIdentity: () => null,
      async getAccount() { return { account: { type: 'chatgpt' }, requiresOpenaiAuth: !authenticated }; },
      async readRateLimits() { return authenticated ? RATE_LIMITS_OK : null; },
      resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
      async run() {
        providerCalls += 1;
        if (!authenticated) throw Object.assign(new Error('Fixture account requires sign-in'), { statusCode: 401 });
        return { threadId: 'auth-recovery-thread', status: 'completed', text: FINISH, usage: {}, permissionEvents: [] };
      },
    };
  };

  const launcherProfiles = createAccountProfiles({ accountsDir, codexDefaultHome: path.join(root, 'default-home') });
  loginApp = createLauncherApp({
    projects: { list: () => [], get: () => null },
    readAuthToken: () => 'fixture-local-token',
    accountProfiles: launcherProfiles,
    createAppServer: ({ codexHome }) => ({
      onNotification(method, handler) {
        assert.equal(method, 'account/login/completed');
        loginCompletion = handler;
        return () => { loginCompletion = null; };
      },
      async loginStart(params) {
        assert.deepEqual(params, { type: 'chatgpt' });
        return { loginId: 'auth-recovery-login', authUrl: 'https://example.invalid/login' };
      },
      async getAccount() {
        assert.equal(codexHome, profile.home);
        return { account: { email: 'existing@example.invalid' }, requiresOpenaiAuth: !authenticated };
      },
      async close() {},
    }),
  });

  t.after(async () => {
    if (loginApp) await loginApp.closeAccountLogins();
    if (loginServer?.listening) await new Promise((resolve) => loginServer.close(resolve));
    if (runtime) await runtime.close();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  process.env.CODEX_HOME = profile.home;
  runtime = await startServer({
    listen: true, port: 0, workspace, accountsDir, stateFile, tokenFile,
    workspaceLockDir: path.join(root, 'workspace-locks'),
    projectSettingsFile: settingsFile, roleOverridesFile, autoResume: true,
    appServerFactory,
    readProfileState: async (home) => ({ requiresOpenaiAuth: home === profile.home ? !authenticated : null,
      limits: home === profile.home && authenticated ? RATE_LIMITS_OK : null }),
    budgetWatcherOptions: { intervalMs: 25, switchDelayMs: 0, marginMs: 0 },
  });
  loginServer = await new Promise((resolve) => {
    const server = loginApp.listen(0, '127.0.0.1', () => resolve(server));
  });

  const requiredChecks = [{ id: 'auth-recovery-check', argv: [process.execPath, 'verify-auth.js'], timeoutMs: 5000 }];
  const handler = runtime.leadAgent.requestHandler;
  const first = await handler.sendMessage({
    message: { ...userMessage('Complete the verified release after the existing profile is re-authenticated.'),
      metadata: { acceptance: { requiredChecks } } },
    configuration: {},
  }, callContext());
  assert.equal(first.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(runtime.orchestrator.getRunEngine(first.id), 'legacy');
  assert.equal((await runtime.orchestrator.getPause(first.id)).kind, 'waiting_for_auth');
  assert.equal(providerCalls, 1, 'the coordinator receives one typed unauthenticated response');
  const graph = runtime.orchestrator.getLegacyRecoveryGraph(first.id);
  const before = await graph.getState({ configurable: { thread_id: first.id } });
  assert.ok(before.config.configurable.checkpoint_id);
  assert.equal(before.values.contract.requiredChecks[0].id, requiredChecks[0].id);
  assert.deepEqual(before.values.contract.requiredChecks[0].argv, requiredChecks[0].argv);
  assert.equal(before.values.outcomes.length, 0, 'the unauthenticated run dispatched no worker assignment');

  const profilesBeforeLogin = launcherProfiles.read();
  const loginResponse = await fetch(`http://127.0.0.1:${loginServer.address().port}/api/accounts/existing-profile/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'browser' }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  assert.equal(login.authUrl, 'https://example.invalid/login');
  assert.equal(launcherProfiles.read().profiles.find((entry) => entry.name === 'existing-profile').home, profile.home);
  assert.deepEqual(launcherProfiles.read(), profilesBeforeLogin);
  assert.equal(typeof loginCompletion, 'function');
  authenticated = true;
  loginCompletion({ loginId: login.loginId, success: true });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${loginServer.address().port}/api/accounts/login/${login.loginId}`);
    const status = await response.json();
    return status.status === 'completed';
  }, 'existing-profile login did not complete');

  await waitFor(() => providerCalls === 2,
    async () => `the budget watcher did not resume the auth-paused run: ${JSON.stringify({ watcher: runtime.budgetWatcher.status(first.id), task: await handler.getTask({ id: first.id }, callContext()), pause: await runtime.orchestrator.getPause(first.id), authenticated })}`);
  await waitFor(async () => (await handler.getTask({ id: first.id }, callContext())).status.state === TaskState.TASK_STATE_COMPLETED,
    'automatically resumed run did not complete');
  assert.equal(providerCalls, 2, 'the auth wait resumes once without owner continuation');
  assert.equal(runtime.budgetWatcher.status(first.id), null);
  assert.equal((await runtime.orchestrator.getPause(first.id)), null);

  const after = await graph.getState({ configurable: { thread_id: first.id } });
  assert.equal(after.values.runId, first.id);
  assert.equal(after.values.contract.requiredChecks[0].id, requiredChecks[0].id);
  assert.deepEqual(after.values.contract.requiredChecks[0].argv, requiredChecks[0].argv);
  assert.notEqual(after.config.configurable.checkpoint_id, before.config.configurable.checkpoint_id);
  assert.equal(after.values.status, 'completed');
  assert.equal(after.values.outcomes.length, 0);
  assert.equal(after.values.acceptance?.disposition, 'accepted');
});
