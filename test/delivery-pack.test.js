'use strict';

// M4/M5 integration: delivery pack presets, pinned per-run settings, settings validation at Submit.
// Real startServer (lead graph, A2A, SQLite, git adapter, acceptance) over a temp git workspace; only the
// Codex app server is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { validateDecision } = require('../src/contracts');
const { loadRolePack } = require('../src/role-pack');
const {
  decision, assignment, humanDecision, workerReport, makeFakeAppServer, planStage, readyIntake, intakeOutput,
} = require('./fixtures/fake-app-server');

// Test files run in parallel processes; keep workspace locks private to this process.
process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));
// The approved check runs `node --test`; inherited runner context would make it skip the file and exit 0.
delete process.env.NODE_TEST_CONTEXT;

const CHECK = { id: 'unit', argv: ['node', '--test', 'test/tiny.test.js'], timeoutMs: 60000, description: 'Tiny unit test' };
const GOOD_SOURCE = "module.exports = () => 'hello';\nmodule.exports.farewell = () => 'bye';\n";

let seq = 0;
const cmd = () => `dp-${process.pid}-${String(++seq).padStart(5, '0')}`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"tiny","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, 'src', 'greet.js'), "module.exports = () => 'hello';\n");
  fs.writeFileSync(path.join(dir, 'test', 'tiny.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst greet = require('../src/greet');\ntest('greet', () => assert.equal(greet(), 'hello'));\n");
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
}

async function canBind() {
  const net = require('node:net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function until(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function withStack(appServerFactory, fn, { projectConfig = {}, serverOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-dpack-'));
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ baseRef: 'main', checks: [CHECK], ...projectConfig }));
  const workspace = path.join(root, 'workspace');
  makeWorkspace(workspace);
  const appServer = appServerFactory(workspace);
  const tokenFile = path.join(root, 'token', 'a2a-token');
  let runtime;
  const launch = () => startServer({
    port: 0,
    workspace,
    appServer,
    stateFile: path.join(root, 'state.sqlite'),
    tokenFile,
    projectConfigFile: path.join(root, 'project.json'),
    deliveryTickMs: 25,
    ...serverOptions,
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
  });
  // Closes the server, rewrites project.json with a patch and starts a new server over the same state.
  const restart = async (patch) => {
    await runtime.close();
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ baseRef: 'main', checks: [CHECK], ...projectConfig, ...patch }));
    runtime = await launch();
    return runtime;
  };
  try {
    runtime = await launch();
    const origin = `http://${runtime.host}:${runtime.port}`;
    const base = `${origin}/api/dashboard/v1`;
    const bearer = `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}`;
    const codeRes = await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } });
    const { code } = await codeRes.json();
    const exchange = await fetch(`${base}/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }),
    });
    assert.equal(exchange.status, 204);
    const cookie = exchange.headers.get('set-cookie').split(';')[0];
    const api = {
      get: (p) => fetch(`${base}${p}`, { headers: { Cookie: cookie, Origin: origin } }),
      post: (p, body) => fetch(`${base}${p}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: JSON.stringify(body),
      }),
    };
    await fn({
      runtime, appServer, workspace, api, origin, requestOptions: { serviceParameters: { Authorization: bearer } }, restart,
    });
  } finally {
    if (runtime) await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const ticketOf = (runtime, id) => runtime.productStore.getTicket(id);
const runOf = (runtime, id) => runtime.productStore.latestRunOf(id);

async function waitStatus(runtime, ticketId, status, extra = () => true) {
  try {
    await until(() => ticketOf(runtime, ticketId).status === status && extra(runOf(runtime, ticketId)), `ticket ${ticketId} to be ${status}`);
  } catch (error) {
    error.message += ` (ticket ${ticketOf(runtime, ticketId).status}, run ${JSON.stringify(runOf(runtime, ticketId))})`;
    throw error;
  }
  return runOf(runtime, ticketId);
}

function makeTicket(runtime, overrides = {}) {
  return runtime.productStore.createTicket({
    commandId: cmd(), title: 'Add a farewell helper', description: 'Add farewell() next to greet()', criteria: ['farewell() returns bye'], ...overrides,
  }).ticket;
}

function submit(runtime, ticket) {
  const out = runtime.productStore.submitTicket(ticket.ticketId, { commandId: cmd(), expectedVersion: ticket.version }, runtime.deliveryController.settingsSnapshot());
  runtime.deliveryController.poke();
  return out;
}

async function saveDefault(runtime, roleRuntimeId, { model, effort, serviceTier = null, packId = 'delivery' }) {
  const current = runtime.settingsStore.currentFor(packId, roleRuntimeId);
  return runtime.settingsStore.saveRoleDefault({
    commandId: cmd(), packId, roleRuntimeId, model, effort, serviceTier, expectedRevisionId: current ? current.settingsRevisionId : null,
  });
}

// ---- plans with public role ids and preset stage keys (Intake schema v2)

function stage(stageId, roleId, presetStageKey, overrides = {}) {
  return { ...planStage(stageId, roleId, overrides), presetStageKey };
}

function v2Intake({ classification, stages, checkIds = ['unit'] }) {
  return intakeOutput({ readiness: 'ready', classification, plan: { presetId: classification, stages, checkIds } });
}

const FEATURE_STAGES = [
  stage('design', 'architect', 'design'),
  stage('implement', 'developer', 'implement', { dependencies: ['design'], allowedFiles: ['src/greet.js'] }),
  stage('review', 'reviewer', 'review', { dependencies: ['implement'] }),
  stage('qa', 'qa', 'qa', { dependencies: ['implement'], allowedFiles: ['test/tiny.test.js'] }),
];
const BUGFIX_STAGES = [
  stage('reproduce', 'qa', 'reproduce', { allowedFiles: ['test/tiny.test.js'] }),
  stage('implement', 'developer', 'implement', { dependencies: ['reproduce'], allowedFiles: ['src/greet.js'] }),
  stage('review', 'reviewer', 'review', { dependencies: ['implement'] }),
  stage('verify', 'qa', 'verify', { dependencies: ['implement'], allowedFiles: ['test/tiny.test.js'] }),
];
const DOCS_STAGES = [
  stage('write', 'tech-writer', 'write', { allowedFiles: ['docs/guide.md'] }),
  stage('review', 'reviewer', 'review', { dependencies: ['write'] }),
];
const AUDIT_STAGES = [
  stage('look', 'architect', 'investigate'),
  stage('synthesis', 'reviewer', 'synthesis', { dependencies: ['look'] }),
];

const dispatch = (role, stageId, allowedFiles = []) => decision({ action: 'dispatch', assignments: [assignment(role, { stageId, allowedFiles })] });

function featureLead() {
  return [
    dispatch('dlv-architect', 'design'),
    dispatch('dlv-developer', 'implement', ['src/greet.js']),
    dispatch('dlv-qa', 'qa', ['test/tiny.test.js']),
    dispatch('dlv-reviewer', 'review'),
    decision({ final: 'Delivered.' }),
  ];
}

// Developer roles (base and repair executors) really edit the file within allowedFiles; the first
// `failures` developer attempts report outcome failed instead.
function devWorker(workspace, { failures = 0 } = {}) {
  let developerAttempts = 0;
  return async ({ role }) => {
    if (role === 'dlv-tech-writer') {
      fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Guide\n');
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('documented'), filesChanged: ['docs/guide.md'] }) };
    }
    if (role.startsWith('dlv-developer')) {
      developerAttempts += 1;
      if (developerAttempts <= failures) {
        return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('could not finish'), outcome: 'failed' }) };
      }
      fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), GOOD_SOURCE);
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('built'), filesChanged: ['src/greet.js'] }) };
    }
    return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
  };
}

test('delivery pack', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('the server exposes both packs, the catalog, account health and the settings store', async () => {
    await withStack(() => makeFakeAppServer({}), async ({ runtime }) => {
      assert.equal(runtime.activePack.packId, 'delivery');
      assert.equal(runtime.legacyPack.packId, 'legacy-orch');
      assert.ok(runtime.modelCatalog.find('gpt-6-sol'));
      assert.equal(typeof runtime.accountHealth.get, 'function');
      assert.equal(typeof runtime.settingsStore.saveRoleDefault, 'function');
      // Specialists and repair executors are A2A endpoints next to the legacy ones; the coordinator is not.
      for (const id of ['dlv-architect', 'dlv-developer', 'dlv-developer-xhigh', 'dlv-developer-sol', 'orch-builder']) {
        assert.ok(runtime.specialistAgents.has(id), id);
      }
      assert.equal(runtime.specialistAgents.has('dlv-project-manager'), false);
    });
  });

  const CASES = [
    {
      name: 'feature', stages: FEATURE_STAGES, lead: featureLead(), branch: /^feature\//, workers: ['dlv-architect', 'dlv-developer', 'dlv-qa', 'dlv-reviewer'],
    },
    {
      name: 'bugfix',
      stages: BUGFIX_STAGES,
      lead: [
        dispatch('dlv-qa', 'reproduce', ['test/tiny.test.js']),
        dispatch('dlv-developer', 'implement', ['src/greet.js']),
        dispatch('dlv-reviewer', 'review'),
        dispatch('dlv-qa', 'verify', ['test/tiny.test.js']),
        decision({ final: 'Fixed.' }),
      ],
      branch: /^fix\//,
      workers: ['dlv-qa', 'dlv-developer', 'dlv-reviewer', 'dlv-qa'],
    },
    {
      name: 'docs',
      stages: DOCS_STAGES,
      lead: [dispatch('dlv-tech-writer', 'write', ['docs/guide.md']), dispatch('dlv-reviewer', 'review'), decision({ final: 'Documented.' })],
      branch: /^docs\//,
      workers: ['dlv-tech-writer', 'dlv-reviewer'],
    },
    {
      name: 'audit',
      stages: AUDIT_STAGES,
      checkIds: [],
      lead: [dispatch('dlv-architect', 'look'), dispatch('dlv-reviewer', 'synthesis'), decision({ final: 'Audited.' })],
      branch: null,
      workers: ['dlv-architect', 'dlv-reviewer'],
    },
  ];

  for (const spec of CASES) {
    await suite.test(`a ${spec.name} ticket reaches review through the delivery pack with a preset-bound saved plan`, async () => {
      await withStack((workspace) => makeFakeAppServer({
        intakeScript: [v2Intake({ classification: spec.name, stages: spec.stages, checkIds: spec.checkIds })],
        leadScript: spec.lead,
        workerImpl: devWorker(workspace),
      }), async ({ runtime, appServer }) => {
        const ticket = makeTicket(runtime);
        submit(runtime, ticket);
        const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
        assert.equal(run.status, 'completed');
        assert.equal(run.waitReason, 'human_review');
        if (spec.branch) assert.match(run.branchName, spec.branch);
        else assert.equal(run.branchName, null);

        const view = runtime.productStore.getRunView(run.runId);
        assert.equal(view.plan.classification, spec.name);
        assert.equal(view.plan.presetId, spec.name);
        assert.equal(view.plan.presetVersion, spec.name === 'bugfix' ? '1.1.0' : '1.0.0');
        assert.equal(view.plan.rolePack, 'delivery');
        assert.equal(view.plan.rolePackVersion, runtime.activePack.version);
        assert.equal(view.plan.validatorVersion, 'm4-plan-v1');
        assert.equal(view.plan.requirements.planMeta, undefined);
        const stored = runtime.productStore.getPlanRevision(view.plan.planRevisionId);
        assert.equal(stored.presetId, spec.name);
        assert.equal(stored.rolePack, 'delivery');
        // Saved stages keep the public role and the runtime role.
        for (const saved of view.plan.stages) {
          assert.equal(saved.roleId, runtime.activePack.publicToRuntime(saved.publicRoleId));
          assert.ok(saved.presetStageKey);
        }
        assert.deepEqual(view.stages.map((s) => s.status), spec.stages.map(() => 'succeeded'));
        assert.equal(view.candidate.acceptance.disposition, spec.name === 'audit' ? 'not_required' : 'accepted');

        // The coordinator is the Intake role and the lead role; workers ran as the runtime roles.
        assert.equal(appServer.intakeCalls[0].role, 'dlv-project-manager');
        assert.match(appServer.intakeCalls[0].input, /Available presets/);
        assert.ok(appServer.leadCalls.every((call) => call.role === 'dlv-project-manager'));
        assert.match(appServer.leadCalls[0].input, /"roleId":"dlv-/);
        assert.deepEqual(appServer.workerCalls.map((call) => call.role), spec.workers);
        assert.equal(view.settings.rolePack, 'delivery');
        assert.equal(view.settings.rolePackHash, runtime.activePack.hash);
        assert.equal(view.settings.roles['dlv-project-manager'].source, 'profile');
      });
    });
  }

  await suite.test('a plan that violates its preset is rejected at intake validation', async () => {
    const noQa = FEATURE_STAGES.filter((entry) => entry.stageId !== 'qa');
    const developerReview = FEATURE_STAGES.map((entry) => (entry.stageId === 'review' ? { ...entry, roleId: 'developer', allowedFiles: ['src/greet.js'] } : entry));
    await withStack(() => makeFakeAppServer({
      intakeScript: [v2Intake({ classification: 'feature', stages: noQa }), v2Intake({ classification: 'feature', stages: developerReview })],
    }), async ({ runtime, appServer }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.status, 'failed');
      assert.equal(run.waitDetail.code, 'intake_invalid');
      assert.equal(appServer.intakeCalls.length, 2);
      assert.match(appServer.intakeCalls[1].input, /missing required preset stage "qa"/);
      assert.match(run.waitDetail.problems.map((p) => p.message).join('\n'), /preset stage "review" needs one of reviewer/);
      assert.equal(appServer.leadCalls.length, 0);
      assert.equal(run.planRevisionId, null);
    });
  });

  await suite.test('QA and Reviewer stages cannot be satisfied by the Developer role', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [v2Intake({ classification: 'feature', stages: FEATURE_STAGES })],
      leadScript: [
        dispatch('dlv-architect', 'design'),
        dispatch('dlv-developer', 'implement', ['src/greet.js']),
        dispatch('dlv-developer', 'qa', ['src/greet.js']),
        dispatch('dlv-qa', 'qa', ['test/tiny.test.js']),
        dispatch('dlv-developer', 'review', ['src/greet.js']),
        dispatch('dlv-reviewer', 'review'),
        decision({ final: 'Delivered.' }),
      ],
      workerImpl: devWorker(workspace),
    }), async ({ runtime, appServer }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.status, 'completed');
      assert.match(appServer.leadCalls[3].input, /stage qa requires role dlv-qa, not dlv-developer/);
      assert.match(appServer.leadCalls[5].input, /stage review requires role dlv-reviewer, not dlv-developer/);
      assert.deepEqual(appServer.workerCalls.map((call) => call.role), ['dlv-architect', 'dlv-developer', 'dlv-qa', 'dlv-reviewer']);
    });
  });

  await suite.test('failed Developer attempts are repaired by the chain executors in order', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [v2Intake({ classification: 'feature', stages: FEATURE_STAGES })],
      leadScript: [
        dispatch('dlv-architect', 'design'),
        dispatch('dlv-developer', 'implement', ['src/greet.js']),
        dispatch('dlv-developer-xhigh', 'implement', ['src/greet.js']),
        dispatch('dlv-developer-sol', 'implement', ['src/greet.js']),
        dispatch('dlv-qa', 'qa', ['test/tiny.test.js']),
        dispatch('dlv-reviewer', 'review'),
        decision({ final: 'Delivered.' }),
      ],
      workerImpl: devWorker(workspace, { failures: 2 }),
    }), async ({ runtime, appServer }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.status, 'completed');
      assert.deepEqual(appServer.workerCalls.map((call) => call.role),
        ['dlv-architect', 'dlv-developer', 'dlv-developer-xhigh', 'dlv-developer-sol', 'dlv-qa', 'dlv-reviewer']);
      const view = runtime.productStore.getRunView(run.runId);
      assert.equal(view.stages.find((entry) => entry.stageId === 'implement').attempts.length, 3);
      // Repair executors run with their own pinned settings.
      assert.deepEqual([appServer.workerCalls[2].model, appServer.workerCalls[2].effort], ['gpt-6-luna', 'high']);
      assert.deepEqual([appServer.workerCalls[3].model, appServer.workerCalls[3].effort], ['gpt-6-luna', 'high']);
    });
  });

  await suite.test('repair chain order is enforced by decision validation (delivery and legacy chains)', () => {
    const pack = loadRolePack();
    const ctx = (attempted) => ({
      roles: pack.runtimeRoles, attemptedRoles: new Set(attempted), outcomeCount: 1, openDecisionIds: new Set(), repairChains: pack.repairChains,
    });
    const one = (role) => decision({ action: 'dispatch', assignments: [assignment(role, { stageId: 'implement', allowedFiles: ['src/greet.js'] })] });
    assert.throws(() => validateDecision(one('dlv-developer-xhigh'), ctx([])), /dlv-developer-xhigh can only be dispatched after an dlv-developer attempt/);
    assert.doesNotThrow(() => validateDecision(one('dlv-developer-xhigh'), ctx(['dlv-developer'])));
    assert.throws(() => validateDecision(one('dlv-developer-sol'), ctx(['dlv-developer'])), /dlv-developer-sol can only be dispatched after an dlv-developer-xhigh attempt/);
    assert.doesNotThrow(() => validateDecision(one('dlv-developer-sol'), ctx(['dlv-developer', 'dlv-developer-xhigh'])));
    // The legacy chain is built in and unaffected by the delivery chains.
    const legacyRoles = new Map([['orch-repair-sol', { name: 'orch-repair-sol', sandbox: 'workspace-write' }]]);
    assert.throws(() => validateDecision(one('orch-repair-sol'), {
      roles: legacyRoles, attemptedRoles: new Set(['orch-builder']), outcomeCount: 1, openDecisionIds: new Set(),
    }), /orch-repair-sol can only be dispatched after an orch-repair-xhigh attempt/);
  });

  await suite.test('a run pins its settings; a new default applies to new runs only and resume keeps the pinned values', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [v2Intake({ classification: 'feature', stages: FEATURE_STAGES }), v2Intake({ classification: 'feature', stages: FEATURE_STAGES })],
      leadScript: [humanDecision(), ...featureLead(), ...featureLead()],
      workerImpl: devWorker(workspace),
    }), async ({ runtime, appServer, workspace }) => {
      const ticketA = makeTicket(runtime);
      submit(runtime, ticketA);
      const waiting = await waitStatus(runtime, ticketA.ticketId, 'waiting_human', (r) => r.phase === 'engineering' && r.waitReason === 'human_decision');
      await until(() => runtime.productStore.listDecisions(waiting.runId).length === 1, 'lead decision');
      const pinnedA = runOf(runtime, ticketA.ticketId).settings;
      assert.equal(pinnedA.roles['dlv-developer'].model, 'gpt-6-luna');
      assert.equal(pinnedA.roles['dlv-developer'].effort, 'high');
      assert.equal(pinnedA.roles['dlv-developer'].source, 'profile');

      // New defaults are saved while A is paused.
      await saveDefault(runtime, 'dlv-developer', { model: 'gpt-6.1-sol', effort: 'low' });
      await saveDefault(runtime, 'dlv-project-manager', { model: 'gpt-6.1-sol', effort: 'medium' });
      const fresh = runtime.deliveryController.settingsSnapshot();
      assert.equal(fresh.roles['dlv-developer'].model, 'gpt-6.1-sol');
      assert.equal(fresh.roles['dlv-developer'].source, 'saved');
      assert.match(fresh.roles['dlv-developer'].settingsRevisionId, /^rs_/);
      assert.equal(fresh.roles['dlv-project-manager'].effort, 'medium');
      assert.equal(fresh.leadModel, 'gpt-6.1-sol');

      // Resume after the lead human decision: A keeps its pinned settings.
      const [pending] = runtime.productStore.listDecisions(waiting.runId);
      runtime.productStore.answerDecision(ticketA.ticketId, pending.decisionId,
        { commandId: cmd(), expectedVersion: ticketOf(runtime, ticketA.ticketId).version, answer: 'Go with A', choice: 'a' });
      runtime.deliveryController.poke();
      const runA = await waitStatus(runtime, ticketA.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(runA.waitReason, 'human_review');
      assert.deepEqual(runA.settings, pinnedA);
      assert.equal(appServer.leadCalls.length, 6);
      for (const call of appServer.leadCalls) {
        assert.deepEqual([call.model, call.effort], ['gpt-6-luna', 'xhigh']);
      }
      assert.deepEqual([appServer.intakeCalls[0].model, appServer.intakeCalls[0].effort], ['gpt-6-luna', 'xhigh']);
      const workersA = appServer.workerCalls.slice();
      assert.equal(workersA.length, 4);
      const developerA = workersA.find((call) => call.role === 'dlv-developer');
      assert.deepEqual([developerA.model, developerA.effort, developerA.serviceTier], ['gpt-6-luna', 'high', null]);
      const workerRows = runtime.state.db.prepare("SELECT requested_json FROM usage_ledger WHERE kind = 'worker_turn' AND role = 'dlv-developer'").all();
      assert.deepEqual(workerRows.map((row) => JSON.parse(row.requested_json)), [{ model: 'gpt-6-luna', effort: 'high', serviceTier: null }]);
      const leadRows = runtime.state.db.prepare("SELECT requested_json, reported_json FROM usage_ledger WHERE kind = 'lead_turn' AND run_id = ?").all(runA.leadTaskId);
      assert.equal(leadRows.length, 6);
      assert.deepEqual(JSON.parse(leadRows[0].requested_json), { model: 'gpt-6-luna', effort: 'xhigh', serviceTier: null });
      assert.equal(JSON.parse(leadRows[0].reported_json).model, 'gpt-6-luna');

      // A new run B on a clean checkout uses the new defaults.
      const cancelled = runtime.productStore.cancelTicket(ticketA.ticketId, { commandId: cmd(), expectedVersion: ticketOf(runtime, ticketA.ticketId).version });
      assert.equal(cancelled.ticket.status, 'cancelled');
      git(workspace, 'checkout', '-q', '--', '.');
      git(workspace, 'checkout', '-q', 'main');
      const ticketB = makeTicket(runtime, { title: 'Second helper' });
      submit(runtime, ticketB);
      const runB = await waitStatus(runtime, ticketB.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(runB.waitReason, 'human_review');
      assert.equal(runB.settings.roles['dlv-developer'].model, 'gpt-6.1-sol');
      assert.equal(runB.settings.roles['dlv-developer'].source, 'saved');
      assert.deepEqual([appServer.intakeCalls[1].model, appServer.intakeCalls[1].effort], ['gpt-6.1-sol', 'medium']);
      const developerB = appServer.workerCalls.slice(workersA.length).find((call) => call.role === 'dlv-developer');
      assert.deepEqual([developerB.model, developerB.effort], ['gpt-6.1-sol', 'low']);
      assert.deepEqual([appServer.leadCalls[6].model, appServer.leadCalls[6].effort], ['gpt-6.1-sol', 'medium']);
    });
  });

  await suite.test('a saved service tier reaches the App Server run role', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [v2Intake({ classification: 'feature', stages: FEATURE_STAGES })],
      leadScript: featureLead(),
      workerImpl: devWorker(workspace),
    }), async ({ runtime, appServer }) => {
      await saveDefault(runtime, 'dlv-developer', { model: 'gpt-6-luna', effort: 'high', serviceTier: 'fast' });
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.status, 'completed');
      assert.equal(run.settings.roles['dlv-developer'].serviceTier, 'fast');
      assert.equal(run.settings.roles['dlv-architect'].serviceTier, null);
      const developer = appServer.workerCalls.find((call) => call.role === 'dlv-developer');
      assert.equal(developer.serviceTier, 'fast');
      assert.equal(appServer.workerCalls.find((call) => call.role === 'dlv-architect').serviceTier, null);
      const row = runtime.state.db.prepare("SELECT requested_json FROM usage_ledger WHERE kind = 'worker_turn' AND role = 'dlv-developer'").get();
      assert.equal(JSON.parse(row.requested_json).serviceTier, 'fast');
    });
  });

  await suite.test('a role endpoint applies effective settings only for its own role and valid format', async () => {
    await withStack(() => makeFakeAppServer({}), async ({ runtime, appServer, origin, requestOptions }) => {
      const client = await new ClientFactory().createFromUrl(`${origin}/agents/dlv-reviewer/agent-card.json`, '');
      let n = 0;
      const ask = async (effectiveSettings) => {
        n += 1;
        await client.sendMessage({
          tenant: '',
          message: {
            messageId: `dp-direct-${process.pid}-${n}`,
            contextId: `dp-ctx-${process.pid}-${n}`,
            taskId: '',
            role: 1,
            parts: [{ content: { $case: 'text', value: 'review it' }, mediaType: 'text/plain' }],
            metadata: { effectiveSettings },
            extensions: [],
            referenceTaskIds: [],
          },
          configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] },
          metadata: {},
        }, requestOptions);
        await until(() => appServer.workerCalls.length === n, `worker call ${n}`);
        return appServer.workerCalls[n - 1];
      };
      const applied = await ask({ roleRuntimeId: 'dlv-reviewer', model: 'gpt-6.1-sol', effort: 'low', serviceTier: null });
      assert.deepEqual([applied.role, applied.model, applied.effort], ['dlv-reviewer', 'gpt-6.1-sol', 'low']);
      const otherRole = await ask({ roleRuntimeId: 'dlv-developer', model: 'gpt-6.1-sol', effort: 'low', serviceTier: null });
      assert.deepEqual([otherRole.model, otherRole.effort], ['gpt-6-luna', 'high']);
      // Malformed or catalog-absent entries naming this role fail the turn; the worker never runs with profile values.
      const refuse = async (effectiveSettings) => {
        n += 1;
        const task = await client.sendMessage({
          tenant: '',
          message: {
            messageId: `dp-direct-${process.pid}-${n}`,
            contextId: `dp-ctx-${process.pid}-${n}`,
            taskId: '',
            role: 1,
            parts: [{ content: { $case: 'text', value: 'review it' }, mediaType: 'text/plain' }],
            metadata: { effectiveSettings },
            extensions: [],
            referenceTaskIds: [],
          },
          configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] },
          metadata: {},
        }, requestOptions);
        const taskId = task.id || (task.task && task.task.id);
        await until(async () => {
          const got = await client.getTask({ id: taskId, historyLength: 0 }, requestOptions);
          return got.status.state === TaskState.TASK_STATE_FAILED;
        }, `refused task ${n} to fail`);
      };
      const before = appServer.workerCalls.length;
      await refuse({ roleRuntimeId: 'dlv-reviewer', model: 'Bad Model!', effort: 'low', serviceTier: null });
      await refuse({ roleRuntimeId: 'dlv-reviewer', model: 'gpt-6-luna', effort: 'low', serviceTier: 'Not A Tier' });
      await refuse({ roleRuntimeId: 'dlv-reviewer', model: 'gpt-ghost-9', effort: 'low', serviceTier: null });
      assert.equal(appServer.workerCalls.length, before);
      assert.equal(runtime.deliveryController.settingsSnapshot().roles['dlv-reviewer'].model, 'gpt-6-luna');
    });
  });

  await suite.test('an invalid saved default refuses Submit with 409 settings_invalid and queues nothing', async () => {
    await withStack(() => makeFakeAppServer({}), async ({ runtime, api }) => {
      runtime.state.db.prepare(
        'INSERT INTO role_settings_revisions (settings_revision_id, pack_id, role_runtime_id, model, effort, service_tier, supersedes_id, actor, command_id, created_at) '
        + "VALUES ('rs_bad', 'delivery', 'dlv-qa', 'gpt-9-ghost', 'high', NULL, NULL, 'test', 'c-bad', '2026-09-30T00:00:00.000Z')").run();
      runtime.state.db.prepare("INSERT INTO role_settings_current (pack_id, role_runtime_id, settings_revision_id) VALUES ('delivery', 'dlv-qa', 'rs_bad')").run();
      const ticket = makeTicket(runtime);
      const res = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId: cmd(), expectedVersion: ticket.version });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error.code, 'settings_invalid');
      assert.equal(body.error.details.length, 1);
      assert.equal(body.error.details[0].roleRuntimeId, 'dlv-qa');
      assert.equal(body.error.details[0].field, 'model');
      assert.match(body.error.details[0].message, /not in the catalog/);
      assert.equal(runtime.productStore.listRuns(ticket.ticketId).length, 0);
      assert.equal(ticketOf(runtime, ticket.ticketId).status, 'backlog');
    });
  });

  await suite.test('Submit revalidates against the catalog once the cache is stale and replays without revalidating', async () => {
    let clock = Date.parse('2026-10-01T00:00:00.000Z');
    await withStack(() => makeFakeAppServer({}), async ({ runtime, appServer, api }) => {
      const first = makeTicket(runtime);
      const firstBody = { commandId: cmd(), expectedVersion: first.version };
      const accepted = await api.post(`/tickets/${first.ticketId}/submit`, firstBody);
      assert.equal(accepted.status, 201);
      const acceptedRun = (await accepted.json()).run.runId;
      // The model disappears upstream; a fresh cache still answers, a stale one refreshes and rejects.
      const { defaultModels } = require('./fixtures/fake-app-server');
      appServer.listModels = async () => defaultModels().filter((entry) => entry.model !== 'gpt-6-luna');
      clock += 10 * 60 * 1000;
      const replay = await api.post(`/tickets/${first.ticketId}/submit`, firstBody);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).run.runId, acceptedRun);
      const second = makeTicket(runtime);
      const res = await api.post(`/tickets/${second.ticketId}/submit`, { commandId: cmd(), expectedVersion: second.version });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error.code, 'settings_invalid');
      assert.match(body.error.details[0].message, /not in the catalog/);
      assert.equal(runtime.productStore.listRuns(second.ticketId).length, 0);
    }, { serverOptions: { catalogNow: () => clock } });
  });

  await suite.test('an unavailable catalog refuses Submit with 503 catalog_unavailable and queues nothing', async () => {
    await withStack(() => makeFakeAppServer({ models: new Error('model/list down') }), async ({ runtime, api }) => {
      assert.equal(runtime.modelCatalog.status().state, 'unavailable');
      const ticket = makeTicket(runtime);
      const res = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId: cmd(), expectedVersion: ticket.version });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'catalog_unavailable');
      assert.equal(runtime.productStore.listRuns(ticket.ticketId).length, 0);
      assert.equal(ticketOf(runtime, ticket.ticketId).status, 'backlog');
    });
  });

  await suite.test('the legacy pack is selectable through project.json and keeps M3 behavior', async () => {
    const legacyStages = [
      planStage('build', 'orch-builder', { allowedFiles: ['src/greet.js'] }),
      planStage('verify', 'orch-verifier', { dependencies: ['build'], allowedFiles: ['test/tiny.test.js'] }),
      planStage('audit', 'orch-auditor', { dependencies: ['build'] }),
    ];
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ classification: 'feature', stages: legacyStages })],
      leadScript: [
        decision({ action: 'dispatch', assignments: [assignment('orch-builder', { stageId: 'build', allowedFiles: ['src/greet.js'] })] }),
        decision({ action: 'dispatch', assignments: [assignment('orch-verifier', { stageId: 'verify', allowedFiles: ['test/tiny.test.js'] })] }),
        decision({ action: 'dispatch', assignments: [assignment('orch-auditor', { stageId: 'audit' })] }),
        decision({ final: 'Delivered.' }),
      ],
      workerImpl: async ({ role }) => {
        if (role === 'orch-builder') fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), GOOD_SOURCE);
        return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('ok'), filesChanged: role === 'orch-builder' ? ['src/greet.js'] : [] }) };
      },
    }), async ({ runtime, appServer }) => {
      assert.equal(runtime.activePack.packId, 'legacy-orch');
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.waitReason, 'human_review');
      const view = runtime.productStore.getRunView(run.runId);
      assert.equal(view.plan.validatorVersion, 'm3-plan-v1');
      assert.equal(view.plan.presetId, undefined);
      assert.equal(view.settings.rolePack, 'legacy-orch');
      assert.deepEqual(Object.keys(view.settings.roles['orch-builder']).sort(), ['effort', 'model', 'sandbox', 'serviceTier', 'settingsRevisionId', 'source']);
      assert.equal(appServer.intakeCalls[0].role, 'orch-lead');
      assert.ok(appServer.leadCalls.every((call) => call.role === 'orch-lead'));
    }, { projectConfig: { rolePack: 'legacy-orch' } });
  });

  const legacyRun = (workspace) => {
    const legacyStages = [
      planStage('build', 'orch-builder', { allowedFiles: ['src/greet.js'] }),
      planStage('verify', 'orch-verifier', { dependencies: ['build'], allowedFiles: ['test/tiny.test.js'] }),
      planStage('audit', 'orch-auditor', { dependencies: ['build'] }),
    ];
    return makeFakeAppServer({
      intakeScript: [readyIntake({ classification: 'feature', stages: legacyStages })],
      leadScript: [
        decision({ action: 'dispatch', assignments: [assignment('orch-builder', { stageId: 'build', allowedFiles: ['src/greet.js'] })] }),
        decision({ action: 'dispatch', assignments: [assignment('orch-verifier', { stageId: 'verify', allowedFiles: ['test/tiny.test.js'] })] }),
        decision({ action: 'dispatch', assignments: [assignment('orch-auditor', { stageId: 'audit' })] }),
        decision({ final: 'Delivered.' }),
      ],
      workerImpl: async ({ role }) => {
        if (role === 'orch-builder') fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), GOOD_SOURCE);
        return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('ok'), filesChanged: role === 'orch-builder' ? ['src/greet.js'] : [] }) };
      },
    });
  };

  await suite.test('a legacy-orch delivery run pins and applies saved orch defaults (lead and worker)', async () => {
    await withStack(legacyRun, async ({ runtime, appServer }) => {
      await saveDefault(runtime, 'orch-builder', { model: 'gpt-6.1-sol', effort: 'low', packId: 'legacy-orch' });
      await saveDefault(runtime, 'orch-lead', { model: 'gpt-6-luna', effort: 'medium', packId: 'legacy-orch' });
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.waitReason, 'human_review');
      assert.equal(run.settings.rolePack, 'legacy-orch');
      assert.equal(run.settings.roles['orch-builder'].source, 'saved');
      assert.equal(run.settings.roles['orch-builder'].model, 'gpt-6.1-sol');
      assert.equal(run.settings.roles['orch-lead'].model, 'gpt-6-luna');
      assert.equal(run.settings.roles['orch-verifier'].source, 'profile');
      const builder = appServer.workerCalls.find((call) => call.role === 'orch-builder');
      assert.deepEqual([builder.model, builder.effort], ['gpt-6.1-sol', 'low']);
      assert.deepEqual([appServer.intakeCalls[0].model, appServer.intakeCalls[0].effort], ['gpt-6-luna', 'medium']);
      assert.ok(appServer.leadCalls.every((call) => call.model === 'gpt-6-luna' && call.effort === 'medium'));
    }, { projectConfig: { rolePack: 'legacy-orch' } });
  });

  await suite.test('a legacy-orch delivery run refuses Submit when a saved orch default is invalid', async () => {
    await withStack(legacyRun, async ({ runtime, api }) => {
      runtime.state.db.prepare(
        'INSERT INTO role_settings_revisions (settings_revision_id, pack_id, role_runtime_id, model, effort, service_tier, supersedes_id, actor, command_id, created_at) '
        + "VALUES ('rs_badl', 'legacy-orch', 'orch-builder', 'gpt-9-ghost', 'high', NULL, NULL, 'test', 'c-badl', '2026-09-30T00:00:00.000Z')").run();
      runtime.state.db.prepare("INSERT INTO role_settings_current (pack_id, role_runtime_id, settings_revision_id) VALUES ('legacy-orch', 'orch-builder', 'rs_badl')").run();
      const ticket = makeTicket(runtime);
      const res = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId: cmd(), expectedVersion: ticket.version });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error.code, 'settings_invalid');
      assert.equal(body.error.details[0].roleRuntimeId, 'orch-builder');
      assert.equal(runtime.productStore.listRuns(ticket.ticketId).length, 0);
    }, { projectConfig: { rolePack: 'legacy-orch' } });
  });

  await suite.test('flipping the project role pack keeps the pack pinned on a queued run', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [v2Intake({ classification: 'feature', stages: FEATURE_STAGES })],
      leadScript: featureLead(),
      workerImpl: devWorker(workspace),
    }), async ({ runtime, appServer, restart }) => {
      await runtime.deliveryController.stop();
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      assert.equal(runOf(runtime, ticket.ticketId).status, 'queued');
      assert.equal(runOf(runtime, ticket.ticketId).settings.rolePack, 'delivery');
      const next = await restart({ rolePack: 'legacy-orch' });
      assert.equal(next.activePack.packId, 'legacy-orch');
      const run = await waitStatus(next, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.waitReason, 'human_review');
      assert.equal(appServer.intakeCalls[0].role, 'dlv-project-manager');
      assert.ok(appServer.leadCalls.every((call) => call.role === 'dlv-project-manager'));
      assert.ok(appServer.workerCalls.some((call) => call.role === 'dlv-developer'));
    });
  });

  await suite.test('a run pinned to an unknown role pack fails with role_pack_unavailable', async () => {
    await withStack(() => makeFakeAppServer({}), async ({ runtime, appServer }) => {
      await runtime.deliveryController.stop();
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const runId = runOf(runtime, ticket.ticketId).runId;
      const pinned = { ...runOf(runtime, ticket.ticketId).settings, rolePack: 'ghost-pack' };
      runtime.state.db.prepare('UPDATE runs SET settings_snapshot_json = ? WHERE run_id = ?').run(JSON.stringify(pinned), runId);
      runtime.deliveryController.start();
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.status, 'failed');
      assert.equal(run.waitDetail.code, 'role_pack_unavailable');
      assert.equal(appServer.intakeCalls.length, 0);
    });
  });

  await suite.test('a pinned entry corrupted in the database fails the run instead of falling back', async () => {
    await withStack(() => makeFakeAppServer({}), async ({ runtime, appServer }) => {
      await runtime.deliveryController.stop();
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const runId = runOf(runtime, ticket.ticketId).runId;
      const pinned = runOf(runtime, ticket.ticketId).settings;
      pinned.roles['dlv-project-manager'] = { ...pinned.roles['dlv-project-manager'], model: 'BAD MODEL' };
      runtime.state.db.prepare('UPDATE runs SET settings_snapshot_json = ? WHERE run_id = ?').run(JSON.stringify(pinned), runId);
      runtime.deliveryController.start();
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.status, 'failed');
      assert.equal(run.waitDetail.code, 'pinned_settings_invalid');
      assert.equal(appServer.intakeCalls.length, 0);
    });
  });

  await suite.test('finished stages show succeeded in the live run view while the run is still working', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await withStack((workspace) => {
      const inner = devWorker(workspace);
      return makeFakeAppServer({
        intakeScript: [v2Intake({ classification: 'feature', stages: FEATURE_STAGES })],
        leadScript: featureLead(),
        workerImpl: async (call) => {
          if (call.role === 'dlv-qa') await gate;
          return inner(call);
        },
      });
    }, async ({ runtime, api }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      try {
        let view;
        await until(async () => {
          const run = runOf(runtime, ticket.ticketId);
          if (!run || !run.leadTaskId) return false;
          view = await (await api.get(`/runs/${run.runId}`)).json();
          const byId = Object.fromEntries((view.stages || []).map((entry) => [entry.stageId, entry.status]));
          return byId.design === 'succeeded' && byId.implement === 'succeeded' && byId.qa === 'running';
        }, 'finished stages to show succeeded mid-run');
        assert.ok(view.stages.find((entry) => entry.stageId === 'design').attempts.length >= 1);
      } finally {
        release();
      }
      await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
    });
  });

  await suite.test('pinned settings are validated when handed to the orchestrator', () => {
    assert.throws(() => LeadOrchestrator._settingsState({ 'dlv-qa': { model: 'BAD MODEL', effort: 'high', serviceTier: null } }), /valid model, effort/);
    assert.deepEqual(LeadOrchestrator._settingsState({ 'dlv-qa': { model: 'gpt-6-luna', effort: 'high', serviceTier: 'fast', sandbox: 'x' } }),
      { 'dlv-qa': { model: 'gpt-6-luna', effort: 'high', serviceTier: 'fast' } });
  });
});
