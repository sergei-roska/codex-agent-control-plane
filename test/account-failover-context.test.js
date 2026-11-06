'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { createAccountProfiles } = require('../src/account-profiles');
const { createSwitchingAppServer } = require('../src/app-server-switch');
const { createBudgetWatcher } = require('../src/budget-watcher');
const { DispatchJournal, openStateDatabase } = require('../src/durable-store');
const { SessionThreads } = require('../src/session-threads');

const RUN_ID = 'failover-run-1';
const CONTEXT_ID = 'failover-context-1';
const reportText = JSON.stringify({
  outcome: 'completed', summary: 'Read-only investigation completed.', filesChanged: [],
  filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null,
});
const dispatch = JSON.stringify({
  action: 'dispatch', assignments: [{
    role: 'orch-explorer', objective: 'Inspect the fixture', allowedFiles: [], inputs: ['Initial objective'],
    evidence: ['Fixture state'], acceptanceCriteria: ['Report findings'], checks: ['Return a summary'],
    stopConditions: ['Stop after inspection'],
  }], final: '', resolutions: [], humanInput: null,
});
const finish = JSON.stringify({ action: 'finish', assignments: [], final: 'Finished after failover.', resolutions: [], humanInput: null });

function usageLimitError() {
  return Object.assign(new Error('Fake account A model limit'), { codexError: { codexErrorInfo: 'usageLimitExceeded' } });
}

function createClientFactory() {
  const tasks = new Map();
  let sequence = 0;
  return {
    async createFromUrl(url) {
      const role = decodeURIComponent(new URL(url).pathname.split('/').at(-2));
      return {
        async sendMessage({ message }) {
          const taskId = `fake-task-${++sequence}`;
          const task = { id: taskId, contextId: message.contextId, role };
          tasks.set(taskId, task);
          return { task: { id: taskId, contextId: message.contextId, status: { state: TaskState.TASK_STATE_WORKING } } };
        },
        async getTask({ id }) {
          const task = tasks.get(id);
          assert.ok(task, `unknown fake task ${id}`);
          const message = { parts: [{ content: { $case: 'text', value: reportText } }] };
          return {
            id: task.id,
            contextId: task.contextId,
            status: { state: TaskState.TASK_STATE_COMPLETED, message },
            artifacts: [{ name: 'report', parts: message.parts }],
            history: [],
          };
        },
        async cancelTask() { throw new Error('unexpected task cancellation'); },
        async listTasks() { return { tasks: [], nextPageToken: '', pageSize: 100, totalSize: 0 }; },
      };
    },
  };
}

test('legacy budget failover resumes the same checkpoint on B with a fresh provider thread', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad02-account-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkScript = path.join(root, 'verify.js');
  fs.writeFileSync(checkScript, 'process.exit(0);\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'verify.js'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture baseline'], { cwd: root });
  const check = { id: 'pinned-check-1', argv: [process.execPath, checkScript] };
  const accountsDir = path.join(root, 'accounts');
  const profiles = createAccountProfiles({ accountsDir, codexDefaultHome: path.join(root, 'default-home') });
  const accountA = profiles.addProfile({ name: 'account-a' });
  const accountB = profiles.addProfile({ name: 'account-b' });
  const rawIds = { a: 'fake-account-a', b: 'fake-account-b' };
  for (const [home, accountId] of [[accountA.home, rawIds.a], [accountB.home, rawIds.b]]) {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: accountId } }), { mode: 0o600 });
  }
  profiles.setActive('account-a');
  profiles.setAutoSwitch(true);

  const state = await openStateDatabase({ filePath: path.join(root, 'state.sqlite') });
  t.after(() => state.close());
  const journal = new DispatchJournal(state);
  const sessions = new SessionThreads({ db: state.db });
  const calls = [];
  let aTurns = 0;
  const switching = createSwitchingAppServer({
    profiles,
    onCallBound: (record) => journal.recordCallBound(record),
    create: (home) => {
      const account = home === accountA.home ? 'a' : 'b';
      return {
        async run(args) {
          calls.push({ account, threadId: args.threadId ?? null, input: args.input, cwd: args.cwd });
          if (account === 'a') {
            aTurns += 1;
            if (aTurns === 1) return { threadId: 'thread-account-a', status: 'completed', text: dispatch };
            throw usageLimitError();
          }
          return { threadId: 'thread-account-b', status: 'completed', text: finish };
        },
        async readRateLimits() {
          return account === 'a'
            ? { ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }
            : { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } };
        },
        async close() {},
      };
    },
  });
  t.after(async () => switching.close());
  await switching.readRateLimits();
  const roles = new Map([
    ['orch-explorer', { name: 'orch-explorer', description: 'Read-only fixture worker', model: 'gpt-test', effort: 'high', sandbox: 'read-only', instructions: 'Inspect and report.' }],
  ]);
  const orchestrator = new LeadOrchestrator({
    appServer: switching,
    roles,
    workspace: root,
    baseUrl: 'http://127.0.0.1:4040',
    clientFactory: createClientFactory(),
    checkpointer: state.checkpointer,
    journal,
    sessionThreads: sessions,
    pollIntervalMs: 0,
    runCheckImpl: async (check) => ({
      id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false,
      error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed',
    }),
  });

  const first = await orchestrator.run({
    goal: 'Inspect the fixture and finish', runId: RUN_ID, contextId: CONTEXT_ID,
    contract: { requiredChecks: [check] },
  });
  assert.equal(first.status, 'waiting_for_budget');
  assert.equal(first.runId, RUN_ID);
  assert.equal(first.pause.kind, 'waiting_for_budget');
  const before = await orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
  const settledOutcome = before.values.outcomes.find((outcome) => outcome.report?.outcome === 'completed');
  assert.ok(settledOutcome, 'the first worker outcome is checkpointed before failover');
  assert.equal(before.values.contract.requiredChecks[0].id, check.id);
  const checkpointBefore = before.config.configurable.checkpoint_id;
  const sessionBefore = sessions.get(CONTEXT_ID);
  assert.equal(sessionBefore.threadId, 'thread-account-a');
  assert.equal(sessionBefore.codexHome, accountA.home);

  let resumedResult = null;
  let scheduledCheck = null;
  const watcher = createBudgetWatcher({
    models: ['gpt-test'],
    intervalMs: 1000,
    switchDelayMs: 0,
    clock: {
      now: () => Date.now(),
      setTimeout: (callback) => { scheduledCheck = callback; return { unref() {} }; },
      clearTimeout: () => {},
    },
    listPausedRuns: async () => [{ runId: RUN_ID, pause: first.pause }],
    readRateLimits: async () => ({ ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }),
    resumeRun: async (runId) => {
      resumedResult = await orchestrator.resume({ runId, contextId: CONTEXT_ID, resumeOrigin: 'automatic' });
      return true;
    },
    accounts: {
      profiles,
      readProfileLimits: async (home) => home === accountA.home
        ? { ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }
        : { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } },
      switchTo: (...args) => switching.switchTo(...args),
    },
  });
  await watcher.start();
  assert.equal(typeof scheduledCheck, 'function');
  scheduledCheck();
  for (let attempt = 0; attempt < 100 && !resumedResult; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  watcher.stop();

  assert.equal(profiles.read().active, 'account-b');
  assert.ok(resumedResult, 'the watcher resumes automatically without an owner message');
  assert.equal(resumedResult.runId, RUN_ID);
  assert.equal(resumedResult.status, 'completed');
  assert.equal(resumedResult.acceptance.disposition, 'accepted', JSON.stringify(resumedResult.acceptance));
  assert.deepEqual(calls.map((call) => call.account), ['a', 'a', 'b']);
  assert.equal(calls[1].threadId, 'thread-account-a');
  assert.equal(calls[2].threadId, null, 'account B must start a fresh provider thread');
  assert.notEqual(calls[2].threadId, 'thread-account-a');
  assert.equal(calls[2].cwd, root);
  assert.match(calls[2].input, /Read-only investigation completed/);

  const after = await orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
  const sessionAfter = sessions.get(CONTEXT_ID);
  assert.equal(after.values.runId, RUN_ID);
  assert.equal(after.values.contextId, CONTEXT_ID);
  assert.equal(after.values.contract.requiredChecks[0].id, check.id);
  assert.ok(after.config.configurable.checkpoint_id !== checkpointBefore);
  assert.equal(after.values.outcomes.filter((outcome) => outcome.assignmentId === settledOutcome.assignmentId).length, 1);
  assert.equal(sessionAfter.threadId, 'thread-account-b');
  assert.equal(sessionAfter.codexHome, accountB.home);
  assert.ok(sessionAfter.runIds.includes(RUN_ID));
  assert.equal(sessionAfter.rollovers, 1);

  const bindings = journal.listByRun(RUN_ID)
    .flatMap((attempt) => journal.listCallBindingsByAttempt(attempt.attemptId));
  const expectedHashes = [rawIds.a, rawIds.b].map((id) => crypto.createHash('sha256').update(id).digest('hex'));
  assert.deepEqual([...new Set(bindings.map((binding) => binding.accountId))].sort(), expectedHashes.sort());
  assert.equal(bindings.some((binding) => Object.values(binding).some((value) => value === rawIds.a || value === rawIds.b)), false);
  assert.equal(await orchestrator.getPause(RUN_ID), null);
});

test('auth wait rejects unauthenticated and unknown-limit profiles, then resumes the same checkpoint once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad02-auth-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkScript = path.join(root, 'verify.js');
  fs.writeFileSync(checkScript, 'process.exit(0);\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'verify.js'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture baseline'], { cwd: root });
  const check = { id: 'auth-pinned-check', argv: [process.execPath, checkScript] };
  const availableLimits = { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } };
  const profiles = createAccountProfiles({ accountsDir: path.join(root, 'accounts'), codexDefaultHome: path.join(root, 'default-home') });
  const accountA = profiles.addProfile({ name: 'account-a' });
  const accountB = profiles.addProfile({ name: 'account-b' });
  for (const [home, accountId] of [[accountA.home, 'auth-account-a'], [accountB.home, 'auth-account-b']]) {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: accountId } }), { mode: 0o600 });
  }
  profiles.setActive('account-a');
  profiles.setAutoSwitch(true);

  const state = await openStateDatabase({ filePath: path.join(root, 'state.sqlite') });
  t.after(() => state.close());
  const journal = new DispatchJournal(state);
  const sessions = new SessionThreads({ db: state.db });
  const calls = [];
  let aTurns = 0;
  let authB = true;
  let limitsB = true;
  const authError = Object.assign(new Error('Account sign-in required'), { statusCode: 401 });
  const switching = createSwitchingAppServer({
    profiles,
    onCallBound: (record) => journal.recordCallBound(record),
    create: (home) => {
      const account = home === accountA.home ? 'a' : 'b';
      return {
        async getAccount() { return { requiresOpenaiAuth: account === 'a' ? true : account === 'b' ? authB : undefined }; },
        async run(args) {
          calls.push({ account, threadId: args.threadId ?? null, input: args.input, cwd: args.cwd });
          if (account === 'a') {
            aTurns += 1;
            if (aTurns === 1) return { threadId: 'auth-thread-a', status: 'completed', text: dispatch };
            throw authError;
          }
          return { threadId: 'auth-thread-b', status: 'completed', text: finish };
        },
        async readRateLimits() { return account === 'a' ? null : availableLimits; },
        async close() {},
      };
    },
  });
  t.after(async () => switching.close());
  await switching.readRateLimits();
  const roles = new Map([
    ['orch-explorer', { name: 'orch-explorer', description: 'Read-only fixture worker', model: 'gpt-test', effort: 'high', sandbox: 'read-only', instructions: 'Inspect and report.' }],
  ]);
  const orchestrator = new LeadOrchestrator({
    appServer: switching, roles, workspace: root, baseUrl: 'http://127.0.0.1:4040',
    clientFactory: createClientFactory(), checkpointer: state.checkpointer, journal, sessionThreads: sessions, pollIntervalMs: 0,
    runCheckImpl: async (required) => ({
      id: required.id, argv: required.argv, exitCode: 0, signal: null, timedOut: false,
      error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed',
    }),
  });
  const first = await orchestrator.run({
    goal: 'Inspect the fixture after local sign-in', runId: RUN_ID, contextId: CONTEXT_ID,
    contract: { requiredChecks: [check] },
  });
  assert.equal(first.status, 'input_required');
  assert.equal(first.pause.kind, 'waiting_for_auth');
  assert.match(first.pause.action, /local Accounts panel/);
  const before = await orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
  const settled = before.values.outcomes.find((outcome) => outcome.report?.outcome === 'completed');
  assert.ok(settled, JSON.stringify(before.values.outcomes));
  assert.equal(before.values.contract.requiredChecks[0].id, check.id);
  const checkpointBefore = before.config.configurable.checkpoint_id;

  let scheduled;
  let resumedResult = null;
  const readStates = [];
  const watcher = createBudgetWatcher({
    models: ['gpt-test'], intervalMs: 1000, switchDelayMs: 0,
    clock: {
      now: () => 1_900_000_000_000,
      setTimeout: (callback) => { scheduled = callback; return { unref() {} }; },
      clearTimeout: () => {},
    },
    listPausedRuns: async () => [{ runId: RUN_ID, pause: first.pause }],
    readRateLimits: async () => null,
    resumeRun: async (runId, reason) => {
      assert.equal(reason, 'auth');
      resumedResult = await orchestrator.resume({ runId, contextId: CONTEXT_ID, resumeOrigin: 'automatic' });
      return true;
    },
    accounts: {
      profiles,
      switchTo: (...args) => switching.switchTo(...args),
      canSwitch: async () => (await orchestrator.getPause(RUN_ID))?.kind === 'waiting_for_auth',
      readProfileState: async (home) => {
        const account = home === accountA.home ? 'a' : home === accountB.home ? 'b' : 'system';
        const state = {
          requiresOpenaiAuth: account === 'a' ? true : account === 'b' ? authB : null,
          limits: account === 'a' ? null : account === 'b' ? (limitsB ? availableLimits : null) : null,
        };
        const profileState = profiles.read();
        readStates.push({ account, active: profileState.active, autoSwitch: profileState.autoSwitch, names: profileState.profiles.map((profile) => profile.name), ...state });
        probeVisits += 1;
        if (probeVisits === 3 || (state.requiresOpenaiAuth === false && state.limits !== null)) onProfileProbeComplete?.();
        return state;
      },
    },
  });
  watcher.notePause(RUN_ID, first.pause);
  assert.equal(typeof scheduled, 'function');
  const checkOnce = async () => {
    const callback = scheduled;
    const readsBefore = readStates.length;
    probeVisits = 0;
    let resolveProbe;
    const probe = new Promise((resolve) => { resolveProbe = resolve; });
    const timer = setTimeout(() => resolveProbe(false), 1000);
    const previousCompletion = onProfileProbeComplete;
    onProfileProbeComplete = () => resolveProbe(true);
    callback();
    const completed = await probe;
    clearTimeout(timer);
    onProfileProbeComplete = previousCompletion;
    assert.equal(completed, true, `profile probe did not finish: ${JSON.stringify(readStates.slice(readsBefore))}`);
    for (let i = 0; i < 100 && scheduled === callback && !resumedResult; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  let onProfileProbeComplete = null;
  let probeVisits = 0;
  await checkOnce();
  assert.equal(resumedResult, null, 'a profile still requiring authentication cannot be selected');
  authB = false;
  limitsB = false;
  await checkOnce();
  assert.equal(resumedResult, null, 'explicit auth false with null model limits remains unknown');
  limitsB = true;
  await checkOnce();
  watcher.stop();

  assert.ok(resumedResult, JSON.stringify({ readStates, active: profiles.read().active, scheduled: Boolean(scheduled), authB, limitsB }));
  assert.equal(resumedResult.status, 'completed');
  assert.equal(resumedResult.runId, RUN_ID);
  assert.equal(profiles.read().active, 'account-b');
  assert.deepEqual(calls.map((call) => call.account), ['a', 'a', 'b']);
  assert.equal(calls[2].threadId, null);
  assert.equal(calls[2].cwd, root);
  const after = await orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
  assert.equal(after.values.contextId, CONTEXT_ID);
  assert.equal(after.values.contract.requiredChecks[0].id, check.id);
  assert.equal(after.values.outcomes.filter((outcome) => outcome.assignmentId === settled.assignmentId).length, 1);
  assert.notEqual(after.config.configurable.checkpoint_id, checkpointBefore);
  assert.equal(sessions.get(CONTEXT_ID).codexHome, accountB.home);
  assert.equal(await orchestrator.getPause(RUN_ID), null);
  assert.ok(readStates.every((entry) => entry.account !== 'system' || entry.requiresOpenaiAuth !== false), 'an unconfigured system account is never inferred as authenticated');
});

test('legacy failover waits for stable writer reconciliation before B continues', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad02-unsettled-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountsDir = path.join(root, 'accounts');
  const profiles = createAccountProfiles({ accountsDir, codexDefaultHome: path.join(root, 'default-home') });
  const accountA = profiles.addProfile({ name: 'account-a' });
  const accountB = profiles.addProfile({ name: 'account-b' });
  for (const [home, accountId] of [[accountA.home, 'unsettled-account-a'], [accountB.home, 'unsettled-account-b']]) {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: accountId } }), { mode: 0o600 });
  }
  profiles.setActive('account-a');
  profiles.setAutoSwitch(true);

  const state = await openStateDatabase({ filePath: path.join(root, 'state.sqlite') });
  t.after(() => state.close());
  const journal = new DispatchJournal(state);
  const calls = [];
  let aTurns = 0;
  const writerDispatch = JSON.stringify({
    action: 'dispatch', assignments: [{
      role: 'orch-builder', objective: 'Update tracked fixture', allowedFiles: ['tracked.txt'], inputs: ['Initial objective'],
      evidence: ['Fixture state'], acceptanceCriteria: ['Retain the update'], checks: ['Return a summary'],
      stopConditions: ['Stop after the update'],
    }], final: '', resolutions: [], humanInput: null,
  });
  const switching = createSwitchingAppServer({
    profiles,
    onCallBound: (record) => journal.recordCallBound(record),
    create: (home) => {
      const account = home === accountA.home ? 'a' : 'b';
      return {
        async run(args) {
          calls.push({ account, threadId: args.threadId ?? null, cwd: args.cwd });
          if (account === 'a') {
            aTurns += 1;
            if (aTurns === 1) return { threadId: 'thread-account-a', status: 'completed', text: writerDispatch };
            throw usageLimitError();
          }
          return { threadId: 'thread-account-b', status: 'completed', text: finish };
        },
        async readRateLimits() {
          return account === 'a'
            ? { ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }
            : { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } };
        },
        async close() {},
      };
    },
  });
  t.after(async () => switching.close());
  await switching.readRateLimits();

  const workerAttempts = [];
  const clientFactory = {
    async createFromUrl() {
      return {
        async sendMessage(args) {
          workerAttempts.push(args.message.metadata.attemptId);
          throw new Error('fixture lost the worker submission response');
        },
        async listTasks() { return { tasks: [], nextPageToken: '', pageSize: 100, totalSize: 0 }; },
        async getTask() { throw new Error('unexpected task lookup'); },
        async cancelTask() { throw new Error('unexpected task cancellation'); },
      };
    },
  };
  const contextToExecution = new Map();
  const executionRows = new Map();
  const admission = {
    canProve: false,
    findByContextId(contextId) { return contextToExecution.has(contextId) ? executionRows.get(contextToExecution.get(contextId)) : null; },
    findAnyByContextId(contextId) { return this.findByContextId(contextId); },
    fence(contextId) {
      if (!contextToExecution.has(contextId)) {
        const executionId = `execution-${contextToExecution.size + 1}`;
        contextToExecution.set(contextId, executionId);
        executionRows.set(executionId, { executionId, contextId, state: 'unresolved', delta: null, reason: null });
      }
      return { execution: this.findByContextId(contextId), inserted: false };
    },
    get(executionId) { return executionRows.get(executionId) || null; },
    async reconcile(executionId) {
      const row = this.get(executionId);
      if (this.canProve) {
        row.state = 'reconciled';
        row.delta = { known: true, changedPaths: ['tracked.txt'] };
        row.reason = null;
        return { state: 'reconciled', delta: row.delta };
      }
      return { state: 'unresolved', reason: 'quiescence_unproven' };
    },
  };
  const roles = new Map([
    ['orch-builder', { name: 'orch-builder', description: 'Writer fixture', model: 'gpt-test', effort: 'high', sandbox: 'workspace-write', instructions: 'Write the fixture.' }],
  ]);
  const orchestrator = new LeadOrchestrator({
    appServer: switching,
    roles,
    workspace: root,
    baseUrl: 'http://127.0.0.1:4040',
    clientFactory,
    checkpointer: state.checkpointer,
    journal,
    admission,
    reconcileWaitMs: 0,
    pollIntervalMs: 0,
    runCheckImpl: async (check) => ({
      id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false,
      error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed',
    }),
  });

  const runId = 'unsettled-failover-run';
  const contextId = 'unsettled-failover-context';
  const check = { id: 'unsettled-pinned-check', argv: ['node', '--version'] };
  const first = await orchestrator.run({ goal: 'Update tracked fixture', runId, contextId, contract: { requiredChecks: [check] } });
  assert.equal(first.pause.kind, 'writer_unresolved');
  assert.equal(calls.length, 1, 'the provider has only made the A planning call');
  assert.equal(workerAttempts.length, 1);
  const unresolved = (await orchestrator.graph.getState({ configurable: { thread_id: runId } })).values.unresolvedWriters[0];
  assert.equal(unresolved.attemptId, workerAttempts[0]);
  assert.equal(journal.get(unresolved.attemptId).attemptId, unresolved.attemptId);
  assert.equal((await orchestrator.graph.getState({ configurable: { thread_id: runId } })).values.contract.requiredChecks[0].id, check.id);

  let failoverTimer;
  const heldWatcher = createBudgetWatcher({
    intervalMs: 1000,
    switchDelayMs: 0,
    clock: {
      now: () => Date.now(),
      setTimeout: (callback) => { failoverTimer = callback; return { unref() {} }; },
      clearTimeout: () => {},
    },
    readRateLimits: async () => ({ ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }),
    resumeRun: async () => { throw new Error('unsettled run must not resume automatically'); },
    accounts: {
      profiles,
      readProfileLimits: async (home) => home === accountB.home
        ? { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } }
        : { ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } },
      canSwitch: async () => (await orchestrator.getPause(runId))?.kind === 'waiting_for_budget',
      switchTo: (...args) => switching.switchTo(...args),
    },
  });
  heldWatcher.notePause(runId, { kind: 'waiting_for_budget' });
  assert.equal(typeof failoverTimer, 'function');
  failoverTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(profiles.read().active, 'account-a', 'an unsettled writer prevents account transfer');
  assert.equal(calls.length, 1, 'B receives no provider call while the writer is unresolved');
  heldWatcher.stop();

  admission.canProve = true;
  const waiting = await orchestrator.resume({ runId, contextId, input: { answer: 'retry' } });
  assert.equal(waiting.status, 'waiting_for_budget');
  assert.equal(waiting.pause.kind, 'waiting_for_budget');
  const reconciledState = (await orchestrator.graph.getState({ configurable: { thread_id: runId } })).values;
  assert.equal(reconciledState.unresolvedWriters.length, 0);
  assert.equal(reconciledState.goal, 'Update tracked fixture');
  assert.equal(reconciledState.contract.requiredChecks[0].id, check.id);
  assert.equal(reconciledState.outcomes.filter((outcome) => outcome.attemptId === unresolved.attemptId && outcome.kind !== 'reconciliation').length, 1);
  assert.deepEqual(reconciledState.outcomes.find((outcome) => outcome.kind === 'reconciliation').changedPaths, ['tracked.txt']);
  assert.deepEqual(calls.map((call) => call.account), ['a', 'a']);
  assert.equal(workerAttempts.length, 1, 'the uncertain writer submission is never duplicated');

  let scheduledCheck;
  let resumedResult = null;
  const watcher = createBudgetWatcher({
    intervalMs: 1000,
    switchDelayMs: 0,
    clock: {
      now: () => Date.now(),
      setTimeout: (callback) => { scheduledCheck = callback; return { unref() {} }; },
      clearTimeout: () => {},
    },
    listPausedRuns: async () => [{ runId, pause: waiting.pause }],
    readRateLimits: async () => ({ ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }),
    resumeRun: async (id) => {
      resumedResult = await orchestrator.resume({ runId: id, contextId, resumeOrigin: 'automatic' });
      return true;
    },
    accounts: {
      profiles,
      readProfileLimits: async (home) => home === accountB.home
        ? { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } }
        : { ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } },
      switchTo: (...args) => switching.switchTo(...args),
    },
  });
  await watcher.start();
  scheduledCheck();
  for (let attempt = 0; attempt < 100 && !resumedResult; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  watcher.stop();

  assert.equal(profiles.read().active, 'account-b');
  assert.equal(resumedResult.status, 'completed');
  assert.deepEqual(calls.map((call) => call.account), ['a', 'a', 'b']);
  assert.ok(calls.every((call) => call.cwd === root));
  assert.equal(workerAttempts.length, 1, 'no B writer dispatch is created after the settled outcome');
  const completed = (await orchestrator.graph.getState({ configurable: { thread_id: runId } })).values;
  assert.equal(completed.outcomes.filter((outcome) => outcome.attemptId === unresolved.attemptId && outcome.kind !== 'reconciliation').length, 1);
  assert.equal(completed.outcomes.filter((outcome) => outcome.kind === 'reconciliation').length, 1);
});
