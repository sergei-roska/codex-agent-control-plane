'use strict';

// Plan pinning and enforcement in the lead graph (M3 D-M3-4). Fake lead decisions, fake A2A workers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { decision, assignment, workerReport: baseReport, humanDecision, makeFakeAppServer } = require('./fixtures/fake-app-server');

const workerReport = (summary, overrides = {}) => ({ ...baseReport(summary), ...overrides });

const FILES = ['src/feature.js'];

const stage = (stageId, roleId, extra = {}) => ({
  stageId,
  roleId,
  objective: `Stage ${stageId}`,
  dependencies: [],
  allowedFiles: roleId === 'orch-builder' || roleId === 'orch-verifier' ? FILES : [],
  required: true,
  ...extra,
});

const PLAN = {
  planRevisionId: 'plan-1',
  classification: 'feature',
  stages: [
    stage('explore', 'orch-explorer'),
    stage('build', 'orch-builder', { dependencies: ['explore'] }),
    stage('verify', 'orch-verifier', { dependencies: ['build'] }),
  ],
  checkIds: [],
};

const role = (name, sandbox) => ({ name, description: `${name} agent`, model: 'gpt-test', effort: 'high', sandbox, instructions: 'Test agent' });

// Stage-bound assignment; writable roles get the stage files unless overridden.
const step = (stageId, roleName, overrides = {}) => assignment(roleName, {
  stageId,
  allowedFiles: roleName === 'orch-builder' || roleName === 'orch-verifier' || roleName.startsWith('orch-repair') ? FILES : [],
  ...overrides,
});
const dispatch = (...assignments) => decision({ action: 'dispatch', assignments });
const finish = () => decision({ final: 'Done.' });

function taskFor(roleName, report) {
  return {
    id: `${roleName}-task`,
    contextId: `${roleName}-context`,
    status: { state: TaskState.TASK_STATE_COMPLETED },
    artifacts: [{
      name: 'result',
      parts: [{ content: { $case: 'text', value: JSON.stringify(report) } }],
      metadata: { writerExecution: { executionId: `${roleName}-exec`, state: 'released', delta: { known: true, headChanged: false, changedPaths: [] }, reason: null } },
    }],
    history: [],
  };
}

// reportFor(role, callIndex) -> worker report; defaults to success.
function harness({ leadScript, reportFor = () => workerReport('ok'), maxRounds, workspace = '/tmp/a2a-plan', orchestratorOptions = {} }) {
  const appServer = makeFakeAppServer({ leadScript });
  let n = 0;
  const clients = new Map();
  const clientFactory = {
    async createFromUrl(url) {
      const roleName = decodeURIComponent(new URL(url).pathname.split('/').at(-2));
      if (!clients.has(roleName)) {
        clients.set(roleName, {
          async sendMessage() { n += 1; return { task: taskFor(roleName, reportFor(roleName, n)) }; },
          async getTask() { return taskFor(roleName, reportFor(roleName, n)); },
          async cancelTask(params) { return { ...taskFor(roleName, workerReport('c')), id: params.id, status: { state: TaskState.TASK_STATE_CANCELED } }; },
          async listTasks() { return { tasks: [], nextPageToken: '', pageSize: 100, totalSize: 0 }; },
        });
      }
      return clients.get(roleName);
    },
  };
  const roles = new Map([
    ['orch-explorer', role('orch-explorer', 'read-only')],
    ['orch-builder', role('orch-builder', 'workspace-write')],
    ['orch-verifier', role('orch-verifier', 'workspace-write')],
    ['orch-repair-xhigh', role('orch-repair-xhigh', 'workspace-write')],
  ]);
  const orchestrator = new LeadOrchestrator({
    appServer, roles, workspace, baseUrl: 'http://127.0.0.1:4040/', clientFactory, pollIntervalMs: 0, authToken: 't',
    ...(maxRounds ? { maxRounds } : {}),
    ...orchestratorOptions,
  });
  return { appServer, orchestrator };
}

const statuses = (result) => Object.fromEntries(result.stages.map((entry) => [entry.stageId, entry.status]));

test('legacy run without a plan has no stages and no plan prompt', async () => {
  const h = harness({ leadScript: [dispatch(assignment('orch-explorer')), finish()] });
  const result = await h.orchestrator.run({ goal: 'Legacy' });
  assert.equal(result.status, 'completed');
  assert.equal(result.stages, undefined);
  assert.doesNotMatch(h.appServer.leadCalls[0].input, /Approved delivery plan/);
  assert.match(h.appServer.leadCalls[0].input, /use null/);
});

test('planned run dispatches stages in dependency order and finishes', async () => {
  const h = harness({ leadScript: [
    dispatch(step('explore', 'orch-explorer')),
    dispatch(step('build', 'orch-builder')),
    dispatch(step('verify', 'orch-verifier')),
    finish(),
  ] });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: PLAN });
  assert.equal(result.status, 'completed');
  assert.deepEqual(statuses(result), { explore: 'succeeded', build: 'succeeded', verify: 'succeeded' });
  assert.equal(result.stages[1].attemptIds.length, 1);
  assert.equal(result.rounds, 3);
  const first = h.appServer.leadCalls[0].input;
  assert.match(first, /Approved delivery plan/);
  assert.match(first, /Next eligible stages: explore\./);
  assert.match(h.appServer.leadCalls[1].input, /Next eligible stages: build\./);
});

test('ineligible stage, wrong role, widened files and early finish are discarded with a note and retried', async () => {
  const cases = [
    ['ineligible stage', dispatch(step('build', 'orch-builder')), /not eligible: dependencies not succeeded \(explore\)/],
    ['wrong role', dispatch(step('explore', 'orch-builder')), /requires role orch-explorer, not orch-builder/],
    ['unknown stage', dispatch(assignment('orch-explorer')), /names no plan stage/],
    ['early finish', finish(), /every required stage has succeeded/],
  ];
  for (const [label, bad, pattern] of cases) {
    const h = harness({ leadScript: [bad, dispatch(step('explore', 'orch-explorer')), dispatch(step('build', 'orch-builder')), dispatch(step('verify', 'orch-verifier')), finish()] });
    const result = await h.orchestrator.run({ goal: 'Planned', plan: PLAN });
    assert.equal(result.status, 'completed', label);
    assert.match(h.appServer.leadCalls[1].input, pattern, label);
    assert.match(h.appServer.leadCalls[1].input, /Plan violation/, label);
    assert.equal(result.rounds, 4, `${label}: the violation counts as a round`);
  }
  const widened = harness({ leadScript: [
    dispatch(step('explore', 'orch-explorer')),
    dispatch(step('build', 'orch-builder', { allowedFiles: ['src/feature.js', 'src/other.js'] })),
    dispatch(step('build', 'orch-builder')), dispatch(step('verify', 'orch-verifier')), finish(),
  ] });
  const result = await widened.orchestrator.run({ goal: 'Planned', plan: PLAN });
  assert.equal(result.status, 'completed');
  assert.match(widened.appServer.leadCalls[2].input, /widens allowedFiles beyond the stage \(src\/other\.js\)/);
});

test('two consecutive violations end the run as plan_violation', async () => {
  const h = harness({ leadScript: [finish(), finish(), finish()] });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: PLAN });
  assert.equal(result.status, 'plan_violation');
  assert.equal(h.appServer.leadCalls.length, 2);
  assert.equal(result.rounds, 2);
  assert.deepEqual(statuses(result), { explore: 'pending', build: 'pending', verify: 'pending' });
});

test('a valid decision between violations resets the consecutive count', async () => {
  const h = harness({ leadScript: [
    finish(), dispatch(step('explore', 'orch-explorer')), finish(),
    dispatch(step('build', 'orch-builder')), dispatch(step('verify', 'orch-verifier')), finish(),
  ] });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: PLAN });
  assert.equal(result.status, 'completed');
});

test('repair role is accepted for an attempted builder stage and rejected for a verifier stage', async () => {
  const h = harness({
    leadScript: [
      dispatch(step('explore', 'orch-explorer')),
      dispatch(step('build', 'orch-builder')),
      dispatch(step('build', 'orch-repair-xhigh')),
      dispatch(step('verify', 'orch-repair-xhigh')),
      dispatch(step('verify', 'orch-verifier')),
      finish(),
    ],
    reportFor: (roleName, n) => (n === 2 ? workerReport('failed', { outcome: 'failed' }) : workerReport('ok')),
  });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: PLAN });
  assert.equal(result.status, 'completed');
  assert.deepEqual(statuses(result), { explore: 'succeeded', build: 'succeeded', verify: 'succeeded' });
  assert.equal(result.stages[1].attemptIds.length, 2);
  // Call 3 is the failed-build follow-up; the repair for the verifier stage was discarded (call index 4 prompt).
  assert.match(h.appServer.leadCalls[4].input, /stage verify requires role orch-verifier, not orch-repair-xhigh/);
});

test('a repair role before any builder attempt is refused by the decision contract', async () => {
  const h = harness({ leadScript: [dispatch(step('explore', 'orch-explorer')), dispatch(step('build', 'orch-repair-xhigh'))] });
  await assert.rejects(() => h.orchestrator.run({ goal: 'Planned', plan: PLAN }), /only be dispatched after an orch-builder attempt/);
});

test('a failed stage keeps its dependents ineligible', async () => {
  const h = harness({
    leadScript: [
      dispatch(step('explore', 'orch-explorer')),
      dispatch(step('build', 'orch-builder')),
      dispatch(step('verify', 'orch-verifier')),
      finish(),
    ],
    reportFor: (roleName) => (roleName === 'orch-builder' ? workerReport('blocked', { outcome: 'blocked' }) : workerReport('ok')),
  });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: PLAN });
  assert.equal(result.status, 'plan_violation');
  assert.deepEqual(statuses(result), { explore: 'succeeded', build: 'failed', verify: 'pending' });
  assert.match(h.appServer.leadCalls[3].input, /Next eligible stages: build\./);
});

test('a reported scope violation is not a stage success', async () => {
  const h = harness({
    leadScript: [
      dispatch(step('explore', 'orch-explorer')),
      dispatch(step('build', 'orch-builder')),
      finish(), finish(),
    ],
    reportFor: (roleName) => (roleName === 'orch-builder' ? workerReport('wide', { filesChanged: ['src/other.js'] }) : workerReport('ok')),
  });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: PLAN });
  assert.equal(statuses(result).build, 'failed');
});

test('optional stages need not succeed before finish', async () => {
  const plan = { ...PLAN, stages: [stage('explore', 'orch-explorer'), stage('extra', 'orch-explorer', { required: false })] };
  const h = harness({ leadScript: [dispatch(step('explore', 'orch-explorer')), finish()] });
  const result = await h.orchestrator.run({ goal: 'Planned', plan });
  assert.equal(result.status, 'completed');
  assert.equal(statuses(result).extra, 'pending');
});

test('planned maxRounds is min(16, max(6, 2 x stages))', async () => {
  const many = { ...PLAN, stages: Array.from({ length: 12 }, (_, i) => stage(`s${i}`, 'orch-explorer', { required: false })) };
  // Blocked attempts leave the stage retryable, so the lead keeps dispatching until the round limit.
  const h = harness({ leadScript: Array.from({ length: 20 }, () => dispatch(step('s0', 'orch-explorer'))), reportFor: () => workerReport('nope', { outcome: 'blocked' }) });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: many });
  assert.equal(result.status, 'max_rounds');
  assert.equal(result.rounds, 16);
  assert.equal(result.stages[0].attemptIds.length, 16);
});

test('few stages still get at least 6 rounds', async () => {
  const one = { ...PLAN, stages: [stage('a', 'orch-explorer', { required: false })] };
  const h = harness({ leadScript: Array.from({ length: 10 }, () => dispatch(step('a', 'orch-explorer'))), reportFor: () => workerReport('nope', { outcome: 'blocked' }) });
  const result = await h.orchestrator.run({ goal: 'Planned', plan: one });
  assert.equal(result.status, 'max_rounds');
  assert.equal(result.rounds, 6);
});

test('resume after a human pause keeps the pinned plan', async () => {
  const h = harness({ leadScript: [
    dispatch(step('explore', 'orch-explorer')),
    humanDecision(),
    finish(),
    dispatch(step('build', 'orch-builder')),
    dispatch(step('verify', 'orch-verifier')),
    finish(),
  ] });
  const paused = await h.orchestrator.run({ goal: 'Planned', runId: 'plan-resume', plan: PLAN });
  assert.equal(paused.status, 'input_required');
  const resumed = await h.orchestrator.resume({ runId: 'plan-resume', input: { answer: 'Go with a' } });
  assert.match(h.appServer.leadCalls[2].input, /Approved delivery plan/);
  // The resumed lead tried to finish early; the pinned plan still gates it.
  assert.match(h.appServer.leadCalls[3].input, /every required stage has succeeded/);
  assert.equal(resumed.status, 'completed');
  assert.equal(statuses(resumed).explore, 'succeeded');
});

test('run validates the plan shape', async () => {
  const h = harness({ leadScript: [] });
  await assert.rejects(() => h.orchestrator.run({ goal: 'x', plan: { stages: [] } }), TypeError);
});

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-plan-repo-'));
  const vcs = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  vcs('init', '-q');
  vcs('config', 'user.email', 't@example.com');
  vcs('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  vcs('add', '.');
  vcs('commit', '-q', '-m', 'init');
  return dir;
}

const REPAIR_PLAN = {
  ...PLAN,
  stages: [
    stage('build', 'orch-builder'),
    stage('verify', 'orch-verifier', { dependencies: ['build'] }),
    stage('look', 'orch-explorer', { dependencies: ['verify'] }),
  ],
};

test('after a rejected acceptance a succeeded builder stage is re-dispatched and its dependents rerun', async () => {
  const workspace = tempRepo();
  let checks = 0;
  const runCheckImpl = async (check) => {
    checks += 1;
    const passed = checks > 1;
    return { id: check.id, argv: check.argv, exitCode: passed ? 0 : 1, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: passed ? 'passed' : 'failed' };
  };
  const h = harness({
    workspace,
    orchestratorOptions: { runCheckImpl },
    leadScript: [
      dispatch(step('build', 'orch-builder')),
      dispatch(step('verify', 'orch-verifier')),
      dispatch(step('look', 'orch-explorer')),
      finish(),
      dispatch(step('build', 'orch-repair-xhigh')),
      dispatch(step('verify', 'orch-verifier')),
      dispatch(step('look', 'orch-explorer')),
      finish(),
    ],
  });
  const result = await h.orchestrator.run({
    goal: 'Repair',
    plan: REPAIR_PLAN,
    contract: { requiredChecks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'] }] },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.acceptance.disposition, 'accepted');
  assert.deepEqual(statuses(result), { build: 'succeeded', verify: 'succeeded', look: 'succeeded' });
  assert.equal(result.stages[0].attemptIds.length, 2);
  assert.equal(result.stages[1].attemptIds.length, 2);
  assert.match(h.appServer.leadCalls[5].input, /Next eligible stages: verify\./);
});

test('without a rejection a succeeded builder stage cannot be dispatched again', async () => {
  const h = harness({ leadScript: [
    dispatch(step('explore', 'orch-explorer')),
    dispatch(step('build', 'orch-builder')),
    dispatch(step('build', 'orch-builder')),
    dispatch(step('verify', 'orch-verifier')),
    finish(),
  ] });
  const result = await h.orchestrator.run({ goal: 'No reopen', plan: PLAN });
  assert.equal(result.status, 'completed');
  assert.match(h.appServer.leadCalls[3].input, /stage build has already succeeded/);
});
