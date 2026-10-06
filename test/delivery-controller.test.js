'use strict';

// Delivery controller integration: real startServer (real lead graph, A2A HTTP, SQLite, git adapter,
// acceptance checks) over a temp git workspace. Only the Codex app server is faked.

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
const { ProductError } = require('../src/product-store');
const { createDeliveryController, planHashOf } = require('../src/delivery-controller');
const { createProjection } = require('../src/dashboard-projection');
const { INTAKE_SCHEMA, INTAKE_SCHEMA_V2 } = require('../src/intake');
const { loadRolePack } = require('../src/role-pack');
const { routeViewOf } = require('../src/ticket-telemetry');
const {
  decision, assignment, humanDecision, workerReport, makeFakeAppServer, planStage, readyIntake, needsInputIntake, planStageV2, readyIntakeV2,
} = require('./fixtures/fake-app-server');

// Test files run in parallel processes; keep workspace locks private to this process.
process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));
// The approved check runs `node --test`; inherited runner context would make it skip the file and exit 0.
delete process.env.NODE_TEST_CONTEXT;

const CHECK = { id: 'unit', argv: ['node', '--test', 'test/tiny.test.js'], timeoutMs: 60000, description: 'Tiny unit test' };
const GOOD_SOURCE = "module.exports = () => 'hello';\nmodule.exports.farewell = () => 'bye';\n";
const BROKEN_SOURCE = "module.exports = () => 'broken';\n";

let seq = 0;
const cmd = () => `cmd-${process.pid}-${String(++seq).padStart(5, '0')}`;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `a2a-delivery-${prefix}-`));
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A tiny node project with a real check, committed on main.
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
  return git(dir, 'rev-parse', 'HEAD');
}

function makeRoot(prefix) {
  const root = tempDir(prefix);
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ baseRef: 'main', checks: [CHECK], rolePack: 'legacy-orch' }));
  return root;
}

async function boot(root, appServer, { workspace = path.join(root, 'workspace'), stateFile = path.join(root, 'state.sqlite') } = {}) {
  fs.mkdirSync(workspace, { recursive: true });
  const tokenFile = path.join(root, 'token', 'a2a-token');
  const runtime = await startServer({
    port: 0,
    workspace,
    appServer,
    stateFile,
    tokenFile,
    projectConfigFile: path.join(root, 'project.json'),
    deliveryTickMs: 25,
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
  });
  const origin = `http://${runtime.host}:${runtime.port}`;
  const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return { runtime, client, requestOptions: { serviceParameters: { Authorization: `Bearer ${token}` } } };
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

const STAGES = [
  planStage('explore', 'orch-explorer', { required: false }),
  planStage('build', 'orch-builder', { dependencies: ['explore'], allowedFiles: ['src/greet.js'] }),
  planStage('verify', 'orch-verifier', { dependencies: ['build'], allowedFiles: ['test/tiny.test.js'] }),
  planStage('audit', 'orch-auditor', { dependencies: ['build'] }),
];

function happyLeadScript() {
  return [
    decision({ action: 'dispatch', assignments: [assignment('orch-explorer', { stageId: 'explore' })] }),
    decision({ action: 'dispatch', assignments: [assignment('orch-builder', { stageId: 'build', allowedFiles: ['src/greet.js'] })] }),
    decision({ action: 'dispatch', assignments: [assignment('orch-verifier', { stageId: 'verify', allowedFiles: ['test/tiny.test.js'] })] }),
    decision({ action: 'dispatch', assignments: [assignment('orch-auditor', { stageId: 'audit' })] }),
    decision({ final: 'Delivered.' }),
  ];
}

// The builder really edits the file within its allowedFiles.
function builderWorker(workspace, source = GOOD_SOURCE) {
  return async ({ role }) => {
    if (role === 'orch-builder') {
      fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), source);
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('built'), filesChanged: ['src/greet.js'] }) };
    }
    return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
  };
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

async function withStack(appServerFactory, fn) {
  const root = makeRoot('run');
  const workspace = path.join(root, 'workspace');
  const base = makeWorkspace(workspace);
  const appServer = appServerFactory(workspace);
  let stack;
  try {
    stack = await boot(root, appServer);
    await fn({ ...stack, appServer, workspace, base, root });
  } finally {
    if (stack) await stack.runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertNoCommit(workspace, base, branch) {
  assert.equal(git(workspace, 'rev-list', '--count', branch), '1');
  assert.equal(git(workspace, 'rev-parse', branch), base);
  assert.equal(git(workspace, 'rev-parse', 'main'), base);
  assert.equal(git(workspace, 'stash', 'list'), '');
}

test('delivery controller', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('a feature ticket reaches human_review with plan, branch, candidate and accepted checks', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ classification: 'feature', stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, appServer, workspace, base }) => {
      const ticket = makeTicket(runtime);
      runtime.productStore.getTicketSource = (ticketId) => ticketId === ticket.ticketId
        ? { sourceKind: 'jira', displayKey: 'CDB-390' }
        : null;
      const submitted = submit(runtime, ticket);
      assert.equal(submitted.ticket.status, 'pending');
      assert.equal(submitted.run.status, 'queued');
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.status, 'completed');
      assert.equal(run.waitReason, 'human_review');

      const view = runtime.productStore.getRunView(run.runId);
      assert.equal(view.plan.classification, 'feature');
      assert.equal(view.plan.stages.length, 4);
      assert.deepEqual(view.plan.checks.map((c) => c.id), ['unit']);
      assert.equal(view.plan.validatorVersion, 'm3-plan-v1');
      assert.equal(view.intake.length, 1);
      assert.equal(view.intake[0].readiness, 'ready');
      assert.equal(view.settings.provider, 'openai');
      assert.equal(view.settings.promptVersions.lead, 'pm-lead-v1');
      assert.equal(view.settings.projectPolicyRevision, runtime.projectConfig.revision);
      assert.ok(view.leadTaskCardId.startsWith('lr_'));

      // Branch created from the base commit; the checkout sits on it with uncommitted changes.
      assert.equal(run.branchName, 'feature/CDB-390');
      assert.equal(run.baseCommit, base);
      assert.equal(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), run.branchName);
      assertNoCommit(workspace, base, run.branchName);

      // Candidate manifest, diff artifact and accepted acceptance.
      const candidate = view.candidate;
      assert.equal(candidate.baseCommit, base);
      assert.equal(candidate.head, base);
      assert.equal(candidate.headMoved, false);
      assert.deepEqual(candidate.manifest.map((m) => [m.path, m.status]), [['src/greet.js', 'M']]);
      assert.equal(candidate.acceptance.disposition, 'accepted');
      assert.equal(candidate.acceptance.checks[0].id, 'unit');
      assert.equal(candidate.acceptance.checks[0].exitCode, 0);
      const diff = runtime.productStore.getArtifact(candidate.diffArtifactId);
      assert.equal(diff.kind, 'candidate_diff');
      assert.equal(diff.mediaType, 'text/x-diff');
      assert.equal(diff.extraction, 'reference_only');
      const diffText = fs.readFileSync(path.join(path.dirname(runtime.state.filePath), 'artifacts', diff.storageRef), 'utf8');
      assert.match(diffText, /farewell/);
      assert.deepEqual(runtime.productStore.listTicketArtifacts(ticket.ticketId), []);

      // Stages from the lead result and the stored attempts.
      assert.deepEqual(view.stages.map((s) => [s.stageId, s.status]), [['explore', 'succeeded'], ['build', 'succeeded'], ['verify', 'succeeded'], ['audit', 'succeeded']]);
      assert.equal(view.stages[1].attempts.length, 1);
      assert.equal(view.stages[1].attempts[0].role, 'orch-builder');

      // Intake used the PM role and was recorded as an intake_turn; the run events are correlated.
      assert.equal(appServer.intakeCalls.length, 1);
      assert.match(appServer.intakeCalls[0].instructions, /product manager/);
      assert.match(appServer.intakeCalls[0].input, /Add a farewell helper/);
      assert.match(appServer.leadCalls[0].instructions, /product manager/);
      const usage = runtime.state.db.prepare("SELECT kind, role FROM usage_ledger WHERE run_id = ? AND kind = 'intake_turn'").all(run.runId);
      assert.equal(usage.length, 1);
      const types = runtime.events.listByTicket(ticket.ticketId).map((e) => e.type);
      for (const type of ['run_queued', 'lease_acquired', 'intake_completed', 'plan_saved', 'branch_prepared', 'engineering_started', 'candidate_captured', 'run_settled']) {
        assert.ok(types.includes(type), type);
      }
      assert.ok(runtime.events.listByTicket(ticket.ticketId).every((e) => e.ticketId === ticket.ticketId));
      assert.deepEqual(runtime.productStore.getLease(), {
        projectId: runtime.productStore.projectId, runId: run.runId, ticketId: ticket.ticketId, acquiredAt: runtime.productStore.getLease().acquiredAt,
      });
    });
  });

  await suite.test('wait diagnostics redact credentials in run details and board cards', async () => {
    const accessToken = 'access-secret-42';
    const githubToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const diagnostic = `Request failed {"access_token":"${accessToken}","GH_TOKEN":"${githubToken}"}`;
    await withStack(() => makeFakeAppServer({ intakeScript: [() => { throw new Error(diagnostic); }] }), async ({ runtime }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (current) => current.phase === 'settled');
      const runDetail = runtime.productStore.getRunView(run.runId).run.waitDetail;
      assert.equal(runDetail.code, 'intake_error');
      assert.match(runDetail.message, /\[REDACTED\]/);
      assert.doesNotMatch(runDetail.message, new RegExp(`${accessToken}|${githubToken}`));

      const projection = createProjection({
        db: runtime.state.db,
        roleIds: [...runtime.roles.keys()],
        projectId: runtime.productStore.projectId,
        productStore: runtime.productStore,
      });
      const boardCard = projection.listCards().cards.find((card) => card.ticketId === ticket.ticketId);
      assert.ok(boardCard);
      assert.equal(boardCard.waitMessage, null, 'settled diagnostics are not shown on the board');
      assert.doesNotMatch(boardCard.waitMessage || '', new RegExp(`${accessToken}|${githubToken}`));
    });
  });

  await suite.test('active board wait messages redact credentials from a lead question', async () => {
    const accessToken = 'access-secret-91';
    const githubToken = 'ghp_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const diagnostic = `Please inspect {"access_token":"${accessToken}","GH_TOKEN":"${githubToken}"}`;
    const ask = humanDecision();
    ask.humanInput.question = diagnostic;
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: [ask, ...happyLeadScript()],
      workerImpl: builderWorker(workspace),
    }), async ({ runtime }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const waiting = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (current) => current.phase === 'engineering' && current.waitReason === 'human_decision');
      const runDetail = runtime.productStore.getRunView(waiting.runId).run.waitDetail;
      assert.match(runDetail.message, /\[REDACTED\]/);
      assert.doesNotMatch(runDetail.message, new RegExp(`${accessToken}|${githubToken}`));
      const [persistedDecision] = runtime.productStore.listDecisions(waiting.runId);
      assert.match(persistedDecision.request.question, /\[REDACTED\]/);
      assert.doesNotMatch(persistedDecision.request.question, new RegExp(`${accessToken}|${githubToken}`));

      const projection = createProjection({
        db: runtime.state.db,
        roleIds: [...runtime.roles.keys()],
        projectId: runtime.productStore.projectId,
        productStore: runtime.productStore,
      });
      const boardCard = projection.listCards().cards.find((card) => card.ticketId === ticket.ticketId);
      assert.ok(boardCard);
      assert.equal(boardCard.waitMessage, runDetail.message);
      assert.doesNotMatch(boardCard.waitMessage, new RegExp(`${accessToken}|${githubToken}`));
    });
  });

  await suite.test('a bugfix ticket reaches human_review on a fix/ branch', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ classification: 'bugfix', stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, workspace, base }) => {
      const ticket = makeTicket(runtime, { title: 'Fix the greeting' });
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.match(run.branchName, /^fix\/fix-the-greeting-[a-z0-9]{6}$/);
      const view = runtime.productStore.getRunView(run.runId);
      assert.equal(view.plan.classification, 'bugfix');
      assert.equal(view.candidate.acceptance.disposition, 'accepted');
      assertNoCommit(workspace, base, run.branchName);
    });
  });

  await suite.test('needs_input creates a decision, an answer runs a second intake and delivery proceeds', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [needsInputIntake(), readyIntake({ stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, appServer }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const waiting = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'awaiting_answer');
      assert.equal(waiting.status, 'paused');
      assert.equal(waiting.waitReason, 'human_decision');
      const pending = runtime.productStore.listDecisions(waiting.runId);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].kind, 'intake_clarification');
      assert.equal(pending[0].state, 'pending');
      assert.deepEqual(pending[0].request.questions.map((q) => q.id), ['q1']);

      const current = ticketOf(runtime, ticket.ticketId);
      assert.throws(() => runtime.productStore.answerDecision(ticket.ticketId, pending[0].decisionId, { commandId: cmd(), expectedVersion: current.version, answers: [] }),
        (error) => error instanceof ProductError && error.code === 'invalid_request');
      const answerCommand = { commandId: cmd(), expectedVersion: current.version, answers: [{ questionId: 'q1', answer: 'Use the blue one' }] };
      const answered = runtime.productStore.answerDecision(ticket.ticketId, pending[0].decisionId, answerCommand);
      runtime.deliveryController.poke();
      assert.equal(answered.ticket.status, 'in_progress');
      assert.equal(answered.decision.state, 'answered');
      assert.equal(runtime.productStore.answerDecision(ticket.ticketId, pending[0].decisionId, answerCommand).replayed, true);
      assert.throws(() => runtime.productStore.answerDecision(ticket.ticketId, pending[0].decisionId,
        { commandId: cmd(), expectedVersion: answered.ticket.version, answers: [{ questionId: 'q1', answer: 'again' }] }),
      (error) => error.code === 'stale_decision' || error.code === 'stale_version');

      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.waitReason, 'human_review');
      assert.equal(appServer.intakeCalls.length, 2);
      assert.match(appServer.intakeCalls[1].input, /Use the blue one/);
      const view = runtime.productStore.getRunView(run.runId);
      assert.deepEqual(view.intake.map((i) => [i.turn, i.readiness]), [[1, 'needs_input'], [2, 'ready']]);
      assert.equal(view.decisions[0].state, 'answered');
      assert.deepEqual(view.decisions[0].answer.answers, [{ questionId: 'q1', answer: 'Use the blue one' }]);
    });
  });

  await suite.test('needs_input on the last allowed turn blocks the ticket as intake_exhausted', async () => {
    await withStack(() => makeFakeAppServer({ intakeScript: [needsInputIntake(), needsInputIntake(), needsInputIntake()] }), async ({ runtime, appServer }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      for (let round = 0; round < 2; round += 1) {
        const waiting = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'awaiting_answer' && r.intakeTurns === round + 1);
        const [pending] = runtime.productStore.listDecisions(waiting.runId).filter((d) => d.state === 'pending');
        runtime.productStore.answerDecision(ticket.ticketId, pending.decisionId, {
          commandId: cmd(), expectedVersion: ticketOf(runtime, ticket.ticketId).version, answers: [{ questionId: 'q1', answer: `answer ${round}` }],
        });
        runtime.deliveryController.poke();
      }
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.status, 'failed');
      assert.equal(run.waitDetail.code, 'intake_exhausted');
      assert.equal(appServer.intakeCalls.length, 3);
      assert.equal(runtime.productStore.getRunView(run.runId).intake.length, 3);
      assert.equal(appServer.leadCalls.length, 0);
      assert.equal(runtime.productStore.getLease(), null);
    });
  });

  await suite.test('invalid intake output twice blocks the ticket as intake_invalid after one corrective retry', async () => {
    await withStack(() => makeFakeAppServer({ intakeScript: ['not json at all', { readiness: 'ready' }] }), async ({ runtime, appServer }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.status, 'failed');
      assert.equal(run.waitReason, 'execution_error');
      assert.equal(run.waitDetail.code, 'intake_invalid');
      assert.ok(run.waitDetail.problems.length > 0);
      assert.equal(appServer.intakeCalls.length, 2);
      assert.match(appServer.intakeCalls[1].input, /previous answer was rejected/);
      const [result] = runtime.productStore.getRunView(run.runId).intake;
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.equal(runtime.state.db.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE kind = 'intake_turn'").get().n, 2);
    });
  });

  await suite.test('a rejected first intake attempt is journaled as bounded retryErrors; a clean run records none', async () => {
    await withStack(() => makeFakeAppServer({ intakeScript: [{ readiness: 'ready' }, readyIntake({ stages: STAGES })] }), async ({ runtime, appServer }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled').catch(() => null);
      assert.equal(appServer.intakeCalls.length, 2);
      const done = runtime.events.listByTicket(ticket.ticketId).filter((e) => e.type === 'intake_completed');
      assert.equal(done.length, 1);
      const retryErrors = done[0].payload.retryErrors;
      assert.ok(Array.isArray(retryErrors) && retryErrors.length > 0 && retryErrors.length <= 10);
      assert.ok(retryErrors.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 200));
    });
    await withStack(() => makeFakeAppServer({ intakeScript: [readyIntake({ stages: STAGES })] }), async ({ runtime }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled').catch(() => null);
      const done = runtime.events.listByTicket(ticket.ticketId).filter((e) => e.type === 'intake_completed');
      assert.equal(done.length, 1);
      assert.equal('retryErrors' in done[0].payload, false);
    });
  });

  await suite.test('a builder that breaks the check leaves the ticket blocked with a rejected disposition', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      // A rejected acceptance gives the lead one more decision; it finishes again and the rejection stands.
      leadScript: [...happyLeadScript(), decision({ final: 'The check still fails.' })],
      workerImpl: builderWorker(workspace, BROKEN_SOURCE),
    }), async ({ runtime, workspace, base }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.waitReason, 'execution_error');
      assert.equal(run.waitDetail.code, 'acceptance_not_accepted');
      assert.equal(run.waitDetail.disposition, 'rejected');
      const view = runtime.productStore.getRunView(run.runId);
      assert.equal(view.candidate.acceptance.disposition, 'rejected');
      assert.notEqual(view.candidate.acceptance.checks[0].exitCode, 0);
      assert.notEqual(ticketOf(runtime, ticket.ticketId).status, 'waiting_human');
      assertNoCommit(workspace, base, run.branchName);
    });
  });

  await suite.test('a dirty checkout blocks the ticket with dirty_worktree before any branch or lead work', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, appServer, workspace, base }) => {
      fs.writeFileSync(path.join(workspace, 'stray.txt'), 'left behind');
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.status, 'failed');
      assert.equal(run.waitReason, 'dependency');
      assert.equal(run.waitDetail.code, 'preflight_failed');
      assert.ok(run.waitDetail.problems.some((p) => p.code === 'dirty_worktree'));
      assert.equal(run.branchName, null);
      assert.equal(appServer.leadCalls.length, 0);
      assert.equal(git(workspace, 'branch', '--list').replace('* ', '').trim(), 'main');
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), base);
      assert.ok(runtime.events.listByTicket(ticket.ticketId).some((e) => e.type === 'preflight_failed' && e.payload.codes.includes('dirty_worktree')));
    });
  });

  await suite.test('a dirty-checkout blocked ticket releases the lease so a queued second ticket proceeds', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES }), readyIntake({ stages: STAGES })],
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, appServer, workspace }) => {
      fs.writeFileSync(path.join(workspace, 'stray.txt'), 'left behind');
      const first = makeTicket(runtime, { title: 'First change' });
      const second = makeTicket(runtime, { title: 'Second change' });
      submit(runtime, first);
      submit(runtime, second);
      await waitStatus(runtime, first.ticketId, 'blocked', (r) => r.phase === 'settled');
      const run = await waitStatus(runtime, second.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.waitDetail.code, 'preflight_failed');
      assert.ok(run.waitDetail.problems.some((p) => p.code === 'dirty_worktree'));
      assert.equal(appServer.intakeCalls.length, 2);
      assert.equal(runtime.productStore.getLease(), null);
    });
  });

  await suite.test('a reviewed ticket still holds the repository lease', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    }), async ({ runtime }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(runtime.productStore.getLease().ticketId, ticket.ticketId);
    });
  });

  await suite.test('a second ticket waits on the repository lease and only proceeds once the first is cancelled', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES }), readyIntake({ stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, appServer }) => {
      const first = makeTicket(runtime, { title: 'First change' });
      submit(runtime, first);
      await waitStatus(runtime, first.ticketId, 'waiting_human', (r) => r.phase === 'settled');

      const second = makeTicket(runtime, { title: 'Second change' });
      submit(runtime, second);
      const queued = await waitStatus(runtime, second.ticketId, 'pending', (r) => r.waitReason === 'dependency');
      assert.equal(queued.status, 'queued');
      assert.match(queued.waitDetail.message, /repository is in use by another ticket/i);
      assert.equal(queued.waitDetail.holderTicketId, first.ticketId);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(appServer.intakeCalls.length, 1);
      assert.equal(ticketOf(runtime, second.ticketId).status, 'pending');

      const cancelled = runtime.productStore.cancelTicket(first.ticketId, { commandId: cmd(), expectedVersion: ticketOf(runtime, first.ticketId).version });
      assert.equal(cancelled.ticket.status, 'cancelled');
      // A completed run under review is not rewritten to cancelled (D-M7-3).
      assert.equal(runtime.productStore.getRun(runOf(runtime, first.ticketId).runId).status, 'completed');
      assert.notEqual(runtime.productStore.getLease()?.ticketId, first.ticketId);
      runtime.deliveryController.poke();

      // The cancelled ticket's changes stay on its branch, so the checkout is still dirty: the second
      // ticket gets the lease, runs intake, then honestly reports dirty_worktree.
      const run = await waitStatus(runtime, second.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(appServer.intakeCalls.length, 2);
      assert.equal(run.waitDetail.code, 'preflight_failed');
      assert.ok(run.waitDetail.problems.some((p) => p.code === 'dirty_worktree'));
      const publicRun = runtime.productStore.getRunView(run.runId).run;
      assert.match(publicRun.waitDetail.message, /git status --short and git diff/i);
      assert.match(publicRun.waitDetail.message, /No files were removed/);
      // Failed before any branch: no repository effect, so the lease is released with the settle.
      assert.equal(runtime.productStore.getLease(), null);
    });
  });

  await suite.test('a lead human_decision during engineering becomes a lead_decision and an answer resumes the lead', async () => {
    const script = happyLeadScript();
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: [humanDecision(), ...script],
      workerImpl: builderWorker(workspace),
    }), async ({ runtime }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const waiting = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'engineering' && r.waitReason === 'human_decision');
      assert.equal(waiting.status, 'paused');
      assert.ok(waiting.leadTaskId);
      await until(() => runtime.productStore.listDecisions(waiting.runId).length === 1, 'lead decision');
      const [pending] = runtime.productStore.listDecisions(waiting.runId);
      assert.equal(pending.kind, 'lead_decision');
      const view = runtime.productStore.getRunView(waiting.runId).decisions[0];
      assert.deepEqual(Object.keys(view.request).sort(), ['options', 'question', 'reason', 'recommendation']);
      assert.equal(view.request.question, 'Which flavour?');
      assert.deepEqual(view.request.options.map((o) => o.id), ['a', 'b']);

      assert.throws(() => runtime.productStore.answerDecision(ticket.ticketId, pending.decisionId,
        { commandId: cmd(), expectedVersion: ticketOf(runtime, ticket.ticketId).version, answer: 'x', choice: 'zzz' }),
      (error) => error.code === 'invalid_request');
      runtime.productStore.answerDecision(ticket.ticketId, pending.decisionId,
        { commandId: cmd(), expectedVersion: ticketOf(runtime, ticket.ticketId).version, answer: 'Go with A', choice: 'a' });
      runtime.deliveryController.poke();
      const run = await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.waitReason, 'human_review');
      assert.equal(runtime.productStore.getRunView(run.runId).candidate.acceptance.disposition, 'accepted');
    });
  });

  await suite.test('submit replay with the same commandId creates one run', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    }), async ({ runtime }) => {
      const ticket = makeTicket(runtime);
      const command = { commandId: cmd(), expectedVersion: ticket.version };
      const snapshot = runtime.deliveryController.settingsSnapshot();
      const first = runtime.productStore.submitTicket(ticket.ticketId, command, snapshot);
      const second = runtime.productStore.submitTicket(ticket.ticketId, command, snapshot);
      assert.equal(first.replayed, false);
      assert.equal(second.replayed, true);
      assert.equal(second.run.runId, first.run.runId);
      runtime.deliveryController.poke();
      await waitStatus(runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(runtime.productStore.listRuns(ticket.ticketId).length, 1);
      assert.equal(runtime.state.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
    });
  });

  await suite.test('restart during intake repeats the read-only turn and delivery completes', async () => {
    const root = makeRoot('intake-restart');
    const workspace = path.join(root, 'workspace');
    makeWorkspace(workspace);
    const hangingServer = makeFakeAppServer({
      intakeScript: [(call, input, signal) => new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      })],
    });
    const secondServer = makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    });
    let stack;
    try {
      stack = await boot(root, hangingServer);
      const ticket = makeTicket(stack.runtime);
      submit(stack.runtime, ticket);
      await until(() => hangingServer.intakeCalls.length === 1, 'intake turn to start');
      const runId = runOf(stack.runtime, ticket.ticketId).runId;
      await stack.runtime.close();
      stack = null;

      stack = await boot(root, secondServer);
      const run = await waitStatus(stack.runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(run.runId, runId);
      assert.equal(run.waitReason, 'human_review');
      assert.equal(secondServer.intakeCalls.length, 1);
      assert.equal(stack.runtime.productStore.getRunView(runId).intake.length, 1);
      assert.equal(stack.runtime.productStore.listRuns(ticket.ticketId).length, 1);
    } finally {
      if (stack) await stack.runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await suite.test('restart during engineering blocks the ticket as restart and follows the lead once it is resumed', async () => {
    const rootA = makeRoot('eng-a');
    const rootB = makeRoot('eng-b');
    const workspace = path.join(rootA, 'workspace');
    makeWorkspace(workspace);
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const serverA = makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: happyLeadScript().slice(0, 2),
      workerImpl: async ({ role, signal }) => {
        if (role !== 'orch-builder') return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
        await Promise.race([hold, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
        return { threadId: 'w', status: 'interrupted', text: '' };
      },
    });
    const serverB = makeFakeAppServer({
      leadScript: happyLeadScript().slice(1),
      workerImpl: builderWorker(workspace),
    });
    let stackA;
    let stackB;
    try {
      stackA = await boot(rootA, serverA);
      const ticket = makeTicket(stackA.runtime);
      submit(stackA.runtime, ticket);
      await until(() => serverA.workerCalls.some((call) => call.role === 'orch-builder'), 'builder to start');
      await until(() => runOf(stackA.runtime, ticket.ticketId).leadTaskId, 'lead task id');
      await until(() => stackA.runtime.state.db.prepare("SELECT id FROM tasks WHERE owner = 'orch-builder'").all().length >= 1, 'builder task row');

      // Crash-consistent snapshot of the durable state mid-engineering.
      stackA.runtime.state.db.pragma('wal_checkpoint(FULL)');
      const stateB = path.join(rootB, 'state.sqlite');
      fs.copyFileSync(stackA.runtime.state.filePath, stateB);
      release();
      await stackA.runtime.close();
      stackA = null;

      stackB = await boot(rootB, serverB, { workspace, stateFile: stateB });
      const blocked = await waitStatus(stackB.runtime, ticket.ticketId, 'blocked', (r) => r.waitReason === 'restart');
      assert.equal(blocked.status, 'interrupted');
      assert.equal(blocked.phase, 'engineering');
      assert.equal(blocked.waitDetail.code, 'restart');
      assert.match(blocked.waitDetail.resumeCommand, new RegExp(`--task ${blocked.leadTaskId}`));
      assert.equal(stackB.runtime.productStore.listRuns(ticket.ticketId).length, 1);

      // Resuming the lead task (what the printed CLI command does) moves the ticket on again.
      const leadTask = await stackB.client.getTask({ tenant: '', id: blocked.leadTaskId, historyLength: 0 }, stackB.requestOptions);
      assert.equal(leadTask.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      await stackB.client.sendMessage({
        tenant: '',
        message: {
          messageId: `resume-${process.pid}-${Date.now()}`,
          contextId: leadTask.contextId,
          taskId: leadTask.id,
          role: 1,
          parts: [{ content: { $case: 'text', value: 'resume' }, mediaType: 'text/plain', filename: '', metadata: undefined }],
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
        metadata: undefined,
      }, stackB.requestOptions);
      const done = await waitStatus(stackB.runtime, ticket.ticketId, 'waiting_human', (r) => r.phase === 'settled');
      assert.equal(done.runId, blocked.runId);
      assert.equal(done.waitReason, 'human_review');
      assert.equal(stackB.runtime.productStore.getRunView(done.runId).candidate.acceptance.disposition, 'accepted');
      assert.equal(stackB.runtime.productStore.listRuns(ticket.ticketId).length, 1);
    } finally {
      release();
      if (stackB) await stackB.runtime.close();
      if (stackA) await stackA.runtime.close();
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  // Runs a delivery whose checkout is tampered with right after the lead completes (before capture).
  async function gateRun({ worker, tamper, expectCode }) {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ classification: 'feature', stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: worker ? worker(workspace) : builderWorker(workspace),
    }), async ({ runtime, workspace, base }) => {
      if (tamper) {
        const original = runtime.productStore.moveToCandidate.bind(runtime.productStore);
        runtime.productStore.moveToCandidate = (runId) => {
          const moved = original(runId);
          if (moved) tamper(workspace, base);
          return moved;
        };
      }
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      const run = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(run.waitReason, 'execution_error');
      assert.equal(run.waitDetail.code, expectCode);
      assert.ok(run.waitDetail.message);
      // The candidate row is still stored for the operator.
      const view = runtime.productStore.getRunView(run.runId);
      assert.ok(view.candidate);
      assert.notEqual(ticketOf(runtime, ticket.ticketId).status, 'waiting_human');
    });
  }

  await suite.test('gate empty_candidate: a builder that changes nothing is blocked', async () => {
    await gateRun({
      worker: () => async () => ({ threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('did nothing')) }),
      expectCode: 'empty_candidate',
    });
  });

  await suite.test('gate head_moved: a commit made before capture is blocked', async () => {
    await gateRun({
      tamper: (workspace) => { git(workspace, 'commit', '-q', '-am', 'sneaky'); },
      expectCode: 'head_moved',
    });
  });

  await suite.test('gate candidate_changed: an edit between lead completion and capture is blocked', async () => {
    await gateRun({
      tamper: (workspace) => { fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), "module.exports = () => 'tampered';\n"); },
      expectCode: 'candidate_changed',
    });
  });

  await suite.test('gate branch_mismatch: a branch switch before capture is blocked', async () => {
    await gateRun({
      tamper: (workspace) => { git(workspace, 'switch', '-q', '-c', 'elsewhere'); },
      expectCode: 'branch_mismatch',
    });
  });
  await suite.test('stop during a held writer interrupts the worker, retains the files and stops the run', async () => {
    let builderAbortedBy = null;
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ classification: 'feature', stages: STAGES })],
      leadScript: happyLeadScript().slice(0, 2),
      workerImpl: async ({ role, signal }) => {
        if (role !== 'orch-builder') return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
        fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), GOOD_SOURCE);
        await new Promise((resolve) => {
          if (signal?.aborted) { resolve(); return; }
          signal?.addEventListener('abort', () => { builderAbortedBy = 'abort'; resolve(); }, { once: true });
        });
        return { threadId: 'w', status: 'interrupted', text: '' };
      },
    }), async ({ runtime, appServer, workspace, base, client, requestOptions }) => {
      const ticket = makeTicket(runtime);
      submit(runtime, ticket);
      await until(() => appServer.workerCalls.some((call) => call.role === 'orch-builder'), 'builder to start');
      const run = await waitStatus(runtime, ticket.ticketId, 'in_progress', (r) => r.leadTaskId && r.phase === 'engineering');
      const stopped = runtime.deliveryController.stopRun(ticket.ticketId, {
        commandId: cmd(), expectedVersion: ticketOf(runtime, ticket.ticketId).version, runId: run.runId,
      });
      assert.equal(stopped.run.controlRequest, 'stop');
      const done = await waitStatus(runtime, ticket.ticketId, 'blocked', (r) => r.status === 'stopped');
      assert.equal(done.waitReason, 'run_stopped');
      assert.equal(done.controlRequest, null);
      assert.equal(builderAbortedBy, 'abort', 'the worker turn was interrupted through the abort chain');
      const leadTask = await client.getTask({ tenant: '', id: done.leadTaskId, historyLength: 0 }, requestOptions);
      assert.equal(leadTask.status.state, TaskState.TASK_STATE_CANCELED);
      // Files are never reverted; no commit was made; the lease stays with the ticket.
      assert.equal(fs.readFileSync(path.join(workspace, 'src', 'greet.js'), 'utf8'), GOOD_SOURCE);
      assert.match(git(workspace, 'status', '--porcelain'), /src\/greet\.js/);
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), base);
      assert.equal(runtime.productStore.getLease().ticketId, ticket.ticketId);
    });
  });

});

// ---- controller-level tests over a fake store: no server, no checkout, no ports.

function fakeHarness({ phase, plan, holder = () => null, taskReader, adapter, runOverrides = {}, priorRuns = [], ownedBranch = false }) {
  const calls = { settled: [], recordBranch: [], recordLeadTask: [], sent: [], prepare: [] };
  const run = {
    runId: 'run1', ticketId: 'tk1', revisionId: 'rev1', planRevisionId: 'plan1', status: 'running', phase,
    branchName: null, baseCommit: 'BASE-NEW', leadTaskId: null, intakeTurns: 1, ...runOverrides,
  };
  const store = {
    getRun: () => run,
    listActiveRuns: () => [run],
    getPlanRevision: () => ({ planRevisionId: 'plan1', ...plan }),
    getRevision: () => ({ title: 'A title' }),
    isTicketBranch: () => ownedBranch,
    getTicketBranch: () => (ownedBranch ? 'feature/a-title-abc123' : null),
    reserveBranch: () => true,
    listRuns: () => [run, ...priorRuns],
    listIntakeRecords: () => [],
    recordBranch: (id, value) => { calls.recordBranch.push(value); run.phase = 'engineering'; return true; },
    recordLeadTask: (id, taskId, contextId) => { calls.recordLeadTask.push({ taskId, contextId }); run.leadTaskId = taskId; return true; },
    settleRun: (id, patch) => { calls.settled.push(patch); run.status = patch.status; return run; },
    setExecutionState: () => null,
    listDecisions: () => [],
  };
  const gitAdapter = adapter || {
    preflight: async () => ({ ok: true, problems: [], baseCommit: 'BASE-NEW' }),
    branchName: async () => 'feature/a-title-abc123',
    branchExists: async () => true,
    prepareBranch: async (args) => { calls.prepare.push(args); return { ok: true, created: false, reused: true }; },
    captureCandidate: async () => { throw new Error('capture must not run'); },
  };
  const controller = createDeliveryController({
    store,
    artifactStore: {},
    gitAdapterFactory: () => gitAdapter,
    projectConfig: { baseRef: 'main', checks: [], branchPrefixes: {} },
    appServer: {},
    leadRole: { name: 'orch-lead', model: 'm', effort: 'low', instructions: 'x' },
    leadClient: { send: async (payload) => { calls.sent.push(payload); return { taskId: 'new-task', contextId: 'ctx' }; }, cancel: async () => {} },
    taskReader: taskReader || { get: async () => null },
    writerAdmission: { holder },
    workspace: '/nowhere',
    logger: () => {},
  });
  return { controller, calls, run, store };
}

const UNIT_PLAN = {
  classification: 'feature',
  stages: [planStage('build', 'orch-builder', { allowedFiles: ['src/a.js'] })],
  checkIds: ['unit'],
  checks: [{ id: 'unit', argv: ['node', '--test'], timeoutMs: 1000, description: 'd' }],
};

async function runTick(controller) {
  controller.start();
  await controller.tick();
  await controller.stop();
}

test('an active writer keeps the branch phase waiting and no repository command runs', async () => {
  let preflights = 0;
  const h = fakeHarness({
    phase: 'branch', plan: UNIT_PLAN, holder: () => ({ state: 'active' }),
    adapter: { preflight: async () => { preflights += 1; return { ok: true, problems: [] }; } },
  });
  await runTick(h.controller);
  assert.equal(preflights, 0);
  assert.equal(h.calls.recordBranch.length, 0);
  assert.equal(h.calls.settled.length, 0);
});

test('an owned existing branch keeps the earlier run base commit', async () => {
  const h = fakeHarness({
    phase: 'branch', plan: UNIT_PLAN, ownedBranch: true,
    priorRuns: [{ runId: 'old', branchName: 'feature/a-title-abc123', baseCommit: 'BASE-OLD' }],
  });
  await runTick(h.controller);
  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.calls.prepare[0].baseCommit, 'BASE-OLD');
  assert.deepEqual(h.calls.recordBranch, [{ branchName: 'feature/a-title-abc123', baseCommit: 'BASE-OLD' }]);
});

function leadTask(metadata) {
  return { id: 'found', history: [{ role: 1, metadata, parts: [] }], status: { state: TaskState.TASK_STATE_WORKING }, metadata: { delivery: { runId: 'run1' } } };
}

test('lead task adoption requires matching plan revision, plan hash and acceptance checks', async () => {
  const planHash = planHashOf(UNIT_PLAN);
  const good = {
    delivery: { runId: 'run1', planRevisionId: 'plan1', planHash },
    acceptance: { requiredChecks: [{ id: 'unit', argv: ['node', '--test'], timeoutMs: 1000 }] },
  };
  const scenarios = [
    ['matching task is adopted', good, true],
    ['wrong plan hash', { ...good, delivery: { ...good.delivery, planHash: 'deadbeef' } }, false],
    ['wrong plan revision', { ...good, delivery: { ...good.delivery, planRevisionId: 'other' } }, false],
    ['different acceptance checks', { ...good, acceptance: { requiredChecks: [{ id: 'other', argv: ['true'], timeoutMs: 1 }] } }, false],
    ['missing acceptance', { delivery: good.delivery }, false],
  ];
  for (const [label, metadata, adopted] of scenarios) {
    const h = fakeHarness({
      phase: 'engineering', plan: UNIT_PLAN,
      taskReader: { findByRun: async () => ({ taskId: 'found', contextId: 'c1' }), get: async () => leadTask(metadata) },
    });
    await runTick(h.controller);
    if (adopted) {
      assert.deepEqual(h.calls.recordLeadTask, [{ taskId: 'found', contextId: 'c1' }], label);
      assert.equal(h.calls.settled.length, 0, label);
    } else {
      assert.equal(h.calls.recordLeadTask.length, 0, label);
      assert.equal(h.calls.settled.length, 1, label);
      assert.equal(h.calls.settled[0].waitDetail.code, 'lead_task_mismatch', label);
      assert.equal(h.calls.settled[0].ticketStatus, 'blocked', label);
    }
  }
});

test('capture after a settled lead run blocks on an unresolved writer and waits on an active one', async () => {
  const overrides = { leadTaskId: 't', branchName: 'b', baseCommit: 'X' };
  const unresolved = fakeHarness({
    phase: 'candidate', plan: UNIT_PLAN, holder: () => ({ state: 'unresolved' }), runOverrides: overrides,
    taskReader: { get: async () => ({ artifacts: [] }) },
  });
  await runTick(unresolved.controller);
  assert.equal(unresolved.calls.settled.length, 1);
  assert.equal(unresolved.calls.settled[0].waitDetail.code, 'writer_unresolved');
  assert.equal(unresolved.calls.settled[0].ticketStatus, 'blocked');

  const active = fakeHarness({
    phase: 'candidate', plan: UNIT_PLAN, holder: () => ({ state: 'active' }), runOverrides: overrides,
    taskReader: { get: async () => ({ artifacts: [] }) },
  });
  await runTick(active.controller);
  assert.equal(active.calls.settled.length, 0);
});

// ---- M7 operator controls: the real controller and product store over fakes (no server, no ports).

const Database = require('better-sqlite3');
const { ProductStore } = require('../src/product-store');
const { migrateProductSchema } = require('../src/product-migrations');
const { takeSnapshot } = require('../src/workspace-snapshot');
const { createGitAdapter } = require('../src/git-adapter');
const { createGitDelivery } = require('../src/git-delivery');

const RESUME_TEXT = 'Resumed by the operator from the dashboard.';
const MANIFEST = [{ path: 'src/greet.js', status: 'M', sha256: 'f'.repeat(64), size: 10 }];

async function ctlHarness({ intakeScript = [], workspace = null, gitDelivery = null, adapter = null, snapshotter = takeSnapshot, projectConfigExtra = {}, controllerExtra = {},
} = {}) {
  const root = tempDir('ctl');
  let ws = workspace;
  if (!ws) {
    ws = path.join(root, 'ws');
    fs.mkdirSync(ws);
    makeWorkspace(ws);
  }
  const db = new Database(path.join(root, 'state.sqlite'));
  db.pragma('foreign_keys = ON');
  await migrateProductSchema({ db });
  const eventLog = [];
  const events = { record: (type, { ticketId, runId, payload } = {}) => { eventLog.push({ type, ticketId, runId, payload }); } };
  const store = new ProductStore({ db, projectId: 'proj', events });
  const h = {
    eventLog, root, ws, db, store, holder: null, tasks: new Map(), sends: [], cancels: [], reconciles: [], leads: 0, captures: 0, branchCreated: false, onCancel: null,
  };
  h.admission = {
    holder: () => h.holder,
    reconcile: async (executionId) => {
      h.reconciles.push(executionId);
      return h.onReconcile ? h.onReconcile(executionId) : { state: h.holder?.state || 'reconciled' };
    },
    acquire: async ({ role, taskId }) => {
      if (h.holder) throw new Error('workspace writer already active');
      h.holder = { state: 'active', role, taskId };
      return { executionId: `${role}:${taskId}` };
    },
    release: (executionId) => {
      assert.match(executionId, /^operator-commit:/);
      h.holder = null;
    },
  };
  h.appServer = makeFakeAppServer({ intakeScript });
  h.adapter = adapter || {
    preflight: async () => ({ ok: true, problems: [], notes: [], baseCommit: 'BASE0' }),
    branchName: async () => 'feature/work-abc123',
    branchExists: async () => h.branchCreated,
    prepareBranch: async () => {
      const created = !h.branchCreated;
      h.branchCreated = true;
      return { ok: true, created, reused: !created, problems: [] };
    },
    captureCandidate: async () => {
      h.captures += 1;
      return {
        baseCommit: 'BASE0', head: 'BASE0', branch: 'feature/work-abc123', headMoved: false, manifest: MANIFEST, diffText: '', truncated: false,
        integrityHash: `ih-${h.captures}`.padEnd(64, '0'),
      };
    },
  };
  h.leadClient = {
    send: async (payload) => {
      h.sends.push(payload);
      if (payload.taskId) return { taskId: payload.taskId, contextId: payload.contextId || 'ctx' };
      h.leads += 1;
      const id = `lead-${h.leads}`;
      h.tasks.set(id, { id, status: { state: TaskState.TASK_STATE_WORKING }, metadata: {}, history: [], artifacts: [] });
      return { taskId: id, contextId: `ctx-${id}` };
    },
    cancel: async (id) => {
      h.cancels.push(id);
      if (h.onCancel) h.onCancel(id);
    },
  };
  h.controller = createDeliveryController({
    store,
    artifactStore: { store: () => { throw new Error('no diff expected'); } },
    gitAdapterFactory: () => h.adapter,
    projectConfig: { baseRef: 'main', checks: [CHECK], branchPrefixes: {}, rolePack: 'legacy-orch', revision: 'rev-1', ...projectConfigExtra },
    appServer: h.appServer,
    leadRole: { name: 'orch-lead', model: 'm', effort: 'low', instructions: 'x' },
    leadClient: h.leadClient,
    taskReader: { get: async (id) => h.tasks.get(id) || null, findByRun: async (id) => (h.onFindByRun ? h.onFindByRun(id) : null) },
    writerAdmission: h.admission,
    events,
    workspace: ws,
    snapshotter,
    tickMs: 3600000,
    logger: () => {},
    ...(gitDelivery ? { gitDeliveryFactory: () => gitDelivery } : {}),
    ...controllerExtra,
  });
  h.controller.start();
  h.pass = async () => { await h.controller.tick(); };
  h.setTask = (id, state, extra = {}) => {
    const task = h.tasks.get(id);
    h.tasks.set(id, { ...task, status: { state }, metadata: {}, ...extra });
  };
  h.close = async () => {
    await h.controller.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return h;
}

function newTicket(h, title = 'Work') {
  return h.store.createTicket({ commandId: cmd(), title, description: 'd' }).ticket;
}

function submitIt(h, ticket) {
  return h.store.submitTicket(ticket.ticketId, { commandId: cmd(), expectedVersion: ticket.version }, h.controller.settingsSnapshot());
}

const cmdFor = (h, ticketId, extra = {}) => ({ commandId: cmd(), expectedVersion: h.store.getTicket(ticketId).version, ...extra });
const eventTypes = (h, ticketId) => h.eventLog.filter((e) => e.ticketId === ticketId).map((e) => e.type);
const readyScript = () => readyIntake({ classification: 'feature', stages: STAGES });
const taskDone = (h, id) => h.setTask(id, TaskState.TASK_STATE_COMPLETED, {
  artifacts: [{
    artifactId: `${id}-result`,
    metadata: {
      acceptance: {
        disposition: 'accepted', requiredCheckIds: ['unit'], reasons: [], checks: [{ id: 'unit', exitCode: 0 }],
        candidate: { fingerprint: takeSnapshot(h.ws).fingerprint },
      },
      stages: STAGES.map((stage) => ({ stageId: stage.stageId, status: 'succeeded', attemptIds: [] })),
    },
  }],
});

async function toEngineering(h, intake = readyScript) {
  const ticket = newTicket(h);
  const { run } = submitIt(h, ticket);
  await h.pass();
  const current = h.store.getRun(run.runId);
  assert.equal(current.phase, 'engineering');
  assert.ok(current.leadTaskId);
  return { ticket, runId: run.runId, leadTaskId: current.leadTaskId, intake };
}

async function firstIntakeSchema(projectConfigExtra) {
  const h = await ctlHarness({ intakeScript: [readyScript()], projectConfigExtra });
  try {
    const seen = [];
    const run = h.appServer.run.bind(h.appServer);
    // The fake recognizes Intake by schema identity; a derived schema is recorded and passed on as the base one.
    h.appServer.run = (args) => {
      seen.push(args.outputSchema);
      return run({ ...args, outputSchema: INTAKE_SCHEMA });
    };
    submitIt(h, newTicket(h));
    await h.pass();
    assert.ok(seen.length >= 1, 'intake turn ran');
    return seen[0];
  } finally { await h.close(); }
}

test('Intake gets the original schema by default and the route proposal fields only with adaptiveRoute on', async () => {
  assert.equal(await firstIntakeSchema({}), INTAKE_SCHEMA);
  assert.equal(await firstIntakeSchema({ adaptiveRoute: 'off' }), INTAKE_SCHEMA);
  const schema = await firstIntakeSchema({ adaptiveRoute: 'on' });
  assert.notEqual(schema, INTAKE_SCHEMA);
  assert.ok('route' in schema.properties.plan.properties);
  assert.ok('routeReason' in schema.properties.plan.properties);
});

test('pause on a queued run is immediate and Resume continues it from the queue', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const ticket = newTicket(h);
    const { run } = submitIt(h, ticket);
    const out = h.controller.pause(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
    assert.equal(out.run.status, 'paused');
    assert.equal(out.ticket.status, 'paused');
    await h.pass();
    assert.equal(h.appServer.intakeCalls.length, 0);
    assert.equal(h.store.getLease(), null);
    const resumed = await h.controller.resume(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
    assert.equal(resumed.run.status, 'queued');
    assert.equal(resumed.resumeLead, undefined);
    await h.pass();
    const after = h.store.getRun(run.runId);
    assert.equal(after.phase, 'engineering');
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'in_progress');
  } finally { await h.close(); }
});

test('pause during Intake waits for the saved turn, pauses at the next step and Resume keeps the same plan', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await ctlHarness({ intakeScript: [async () => { await gate; return readyScript(); }] });
  try {
    const ticket = newTicket(h);
    const { run } = submitIt(h, ticket);
    const pass = h.pass();
    await until(() => h.appServer.intakeCalls.length === 1, 'intake turn to start');
    const requested = h.controller.pause(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
    assert.equal(requested.outcome, 'requested');
    assert.equal(h.store.getRun(run.runId).controlRequest, 'pause');
    assert.equal(h.store.getRun(run.runId).status, 'running'); // not settled yet
    release();
    await pass;
    await h.pass();
    const paused = h.store.getRun(run.runId);
    assert.deepEqual([paused.status, paused.phase, paused.waitReason, paused.controlRequest], ['paused', 'branch', 'operator_pause', null]);
    assert.ok(paused.planRevisionId, 'the finished turn was saved');
    assert.equal(h.store.listIntakeRecords(run.runId).length, 1);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'paused');
    await h.pass(); // a paused run is left alone
    assert.equal(h.store.getRun(run.runId).phase, 'branch');

    await h.controller.resume(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
    await h.pass();
    const after = h.store.getRun(run.runId);
    assert.equal(after.phase, 'engineering');
    assert.equal(after.planRevisionId, paused.planRevisionId);
    assert.equal(h.appServer.intakeCalls.length, 1);
    assert.equal(h.store.listRuns(ticket.ticketId).length, 1);
    const types = eventTypes(h, ticket.ticketId);
    for (const type of ['control_requested', 'run_paused', 'run_resumed']) assert.ok(types.includes(type), type);
    assert.ok(h.eventLog.every((e) => !e.payload || !('message' in e.payload)), 'events carry ids and codes only');
  } finally { release(); await h.close(); }
});

test('stop aborts the in-flight Intake turn, discards its output and settles the run', async () => {
  const h = await ctlHarness({
    intakeScript: [(call, input, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })],
  });
  try {
    const ticket = newTicket(h);
    const { run } = submitIt(h, ticket);
    const pass = h.pass();
    await until(() => h.appServer.intakeCalls.length === 1, 'intake turn to start');
    const out = h.controller.stopRun(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
    assert.equal(out.run.controlRequest, 'stop');
    await pass;
    await h.pass();
    const stopped = h.store.getRun(run.runId);
    assert.deepEqual([stopped.status, stopped.phase, stopped.waitReason, stopped.controlRequest], ['stopped', 'settled', 'run_stopped', null]);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'blocked');
    assert.equal(h.store.listIntakeRecords(run.runId).length, 0);
    assert.equal(h.store.getLease(), null, 'no repository effect releases the lease');
    assert.equal(h.store.getRun(run.runId).intakeTurns, 0);
  } finally { await h.close(); }
});

test('awaiting_answer settles at once for return to backlog and cancel', async () => {
  const h = await ctlHarness({ intakeScript: [needsInputIntake(), needsInputIntake()] });
  try {
    const first = newTicket(h, 'first');
    const { run } = submitIt(h, first);
    await h.pass();
    assert.equal(h.store.getRun(run.runId).phase, 'awaiting_answer');
    const decision = h.store.listDecisions(run.runId)[0];
    const staged = h.store.reviseTicket(first.ticketId, cmdFor(h, first.ticketId, { title: 'first v2' }));
    assert.equal(staged.staged, true);
    const out = h.controller.returnToBacklog(first.ticketId, cmdFor(h, first.ticketId));
    assert.equal(out.ticket.status, 'backlog');
    assert.equal(out.ticket.title, 'first v2');
    assert.equal(h.store.getRun(run.runId).status, 'stopped');
    assert.equal(h.store.getDecision(decision.decisionId).state, 'stale');
    assert.equal(h.store.getLease(), null);

    const second = newTicket(h, 'second');
    const again = submitIt(h, second);
    await h.pass();
    assert.equal(h.store.getRun(again.run.runId).phase, 'awaiting_answer');
    const cancelled = h.controller.cancelTicket(second.ticketId, cmdFor(h, second.ticketId));
    assert.equal(cancelled.ticket.status, 'cancelled');
    assert.equal(h.store.getRun(again.run.runId).status, 'cancelled');
    assert.equal(h.store.getLease(), null);
  } finally { await h.close(); }
});

test('engineering pause: the request waits for the lead to hold, then Resume sends the operator message to the same task', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    const planId = h.store.getRun(runId).planRevisionId;
    const out = h.controller.pause(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    assert.equal(out.outcome, 'requested');
    assert.equal(h.store.controlForLeadTask(leadTaskId), 'pause');
    await h.pass(); // lead still working: nothing settles, the request stays visible
    const waiting = h.store.getRun(runId);
    assert.deepEqual([waiting.status, waiting.controlRequest], ['running', 'pause']);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'in_progress');
    assert.equal(h.cancels.length, 0);

    // The lead graph reached a safe boundary and paused with kind operator_pause (simulated).
    h.setTask(leadTaskId, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { pause: { kind: 'operator_pause', message: 'Paused by the operator' } } });
    await h.pass();
    const paused = h.store.getRun(runId);
    assert.deepEqual([paused.status, paused.waitReason, paused.controlRequest], ['paused', 'operator_pause', null]);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'paused');
    await h.pass();
    assert.equal(h.store.getRun(runId).status, 'paused');
    assert.equal(h.sends.filter((m) => m.answer).length, 0);

    const resumeCmd = cmdFor(h, ticket.ticketId, { runId });
    const resumed = await h.controller.resume(ticket.ticketId, resumeCmd);
    assert.equal(resumed.run.status, 'running');
    const message = h.sends[h.sends.length - 1];
    assert.deepEqual([message.taskId, message.answer], [leadTaskId, RESUME_TEXT]);
    assert.equal((await h.controller.resume(ticket.ticketId, resumeCmd)).replayed, true);
    assert.equal(h.sends.filter((m) => m.answer).length, 1, 'a replayed command sends nothing');
    h.setTask(leadTaskId, TaskState.TASK_STATE_WORKING);
    await h.pass();
    const after = h.store.getRun(runId);
    assert.deepEqual([after.status, after.leadTaskId, after.planRevisionId], ['running', leadTaskId, planId]);
    assert.equal(h.sends.filter((m) => m.goal).length, 1, 'the lead task is not restarted');
    assert.equal(h.store.listRuns(ticket.ticketId).length, 1);
  } finally { await h.close(); }
});

test('a resumed run whose lead is still held gets the resume message again after the grace period', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    h.controller.pause(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    h.setTask(leadTaskId, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { pause: { kind: 'operator_pause' } } });
    await h.pass();
    assert.equal(h.store.getRun(runId).status, 'paused');
    // Resume committed in the store but the message never went out (simulated by a failing client).
    const original = h.leadClient.send;
    h.leadClient.send = async () => { throw new Error('endpoint down'); };
    await h.controller.resume(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    assert.equal(h.store.getRun(runId).status, 'running');
    h.leadClient.send = original;
    await h.pass();
    assert.equal(h.sends.filter((m) => m.answer === RESUME_TEXT).length, 1);
  } finally { await h.close(); }
});

test('stop during engineering cancels the lead task and settles only after writers are resolved', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    h.onCancel = (id) => h.setTask(id, TaskState.TASK_STATE_CANCELED);
    h.holder = { state: 'active' };
    const out = h.controller.stopRun(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    assert.equal(out.run.controlRequest, 'stop');
    assert.equal(h.store.controlForLeadTask(leadTaskId), 'stop');
    await h.pass();
    assert.deepEqual(h.cancels, [leadTaskId]);
    let run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.controlRequest], ['running', 'stop']); // a writer is still finishing

    h.holder = { state: 'unresolved', executionId: 'writer:worker-task' };
    await h.pass();
    run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.waitReason, run.controlRequest], ['interrupted', 'writer_unresolved', 'stop']);
    assert.equal(run.waitDetail.message, 'Stop requested; writer outcome unresolved');
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'blocked');
    assert.deepEqual(h.reconciles, ['writer:worker-task'], 'the unresolved writer is retried while the run is stopped');

    h.onReconcile = async () => {
      h.holder = null; // Simulate admission proving quiescence and releasing the durable holder.
      return { state: 'reconciled' };
    };
    await h.pass();
    run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.phase, run.waitReason, run.controlRequest], ['stopped', 'settled', 'run_stopped', null]);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'blocked');
    assert.equal(h.store.getLease().ticketId, ticket.ticketId, 'a stop with repository effect keeps the lease');
    assert.deepEqual(h.cancels, [leadTaskId], 'the cancel was sent once');
    assert.deepEqual(h.reconciles, ['writer:worker-task', 'writer:worker-task'], 'the next tick retries reconciliation without a server restart');
    // A blocked ticket with a stopped run can be submitted again (resubmit).
    const again = h.store.submitTicket(ticket.ticketId, cmdFor(h, ticket.ticketId), h.controller.settingsSnapshot());
    assert.equal(again.run.runKind, 'resubmit');
    const types = eventTypes(h, ticket.ticketId);
    assert.ok(types.includes('control_requested'));
    assert.ok(types.includes('run_stopped'));
  } finally { await h.close(); }
});

test('stop of a lead paused for restart sends the resume message instead of a cancel', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    h.setTask(leadTaskId, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { pause: { kind: 'restart', message: 'restarted' } } });
    await h.pass();
    assert.equal(h.store.getRun(runId).status, 'interrupted');
    h.controller.stopRun(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    await h.pass();
    assert.deepEqual(h.cancels, []);
    assert.equal(h.sends.filter((m) => m.taskId === leadTaskId && m.answer === RESUME_TEXT).length, 1);
    assert.equal(h.store.getRun(runId).controlRequest, 'stop');
    // The graph reconciled the writer and honoured the stop: the task ends canceled.
    h.setTask(leadTaskId, TaskState.TASK_STATE_CANCELED);
    await h.pass();
    assert.equal(h.store.getRun(runId).status, 'stopped');
  } finally { await h.close(); }
});

test('cancel during engineering ends the lead task, cancels the run and the ticket and releases the lease', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    h.onCancel = (id) => h.setTask(id, TaskState.TASK_STATE_CANCELED);
    const out = h.controller.cancelTicket(ticket.ticketId, cmdFor(h, ticket.ticketId));
    assert.equal(out.outcome, 'requested');
    assert.equal(out.ticket.status, 'in_progress');
    await h.pass();
    assert.deepEqual(h.cancels, [leadTaskId]);
    const run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.phase, run.controlRequest], ['cancelled', 'settled', null]);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'cancelled');
    assert.equal(h.store.getLease(), null);
  } finally { await h.close(); }
});

test('terminal lead cancellation retains run and lease until the unresolved writer is quiescent', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    // A writer admission records the specialist child task, not its parent lead task.
    h.holder = { state: 'unresolved', executionId: 'developer:specialist-child-1', taskId: 'specialist-child-1' };
    h.setTask(leadTaskId, TaskState.TASK_STATE_CANCELED);

    await h.pass();
    let run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.phase, run.waitReason], ['interrupted', 'engineering', 'writer_unresolved']);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'blocked');
    assert.equal(h.store.getLease().ticketId, ticket.ticketId);
    assert.deepEqual(h.reconciles, ['developer:specialist-child-1']);

    const requested = h.controller.cancelTicket(ticket.ticketId, cmdFor(h, ticket.ticketId));
    assert.equal(requested.outcome, 'requested');
    await h.pass();
    run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.controlRequest], ['interrupted', 'cancel']);
    assert.equal(h.store.getLease().ticketId, ticket.ticketId, 'cancel cannot release ownership while the holder remains unresolved');

    h.onReconcile = async () => {
      h.holder = null;
      return { state: 'reconciled' };
    };
    await h.pass();
    run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.phase, run.controlRequest], ['cancelled', 'settled', null]);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'cancelled');
    assert.equal(h.store.getLease(), null);
  } finally { await h.close(); }
});

test('a lead paused for a human decision is cancelled on return to backlog and the decision goes stale', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    h.setTask(leadTaskId, TaskState.TASK_STATE_INPUT_REQUIRED, {
      metadata: { pause: { kind: 'human_decision', decisionId: 'ld-1', question: 'Which?', reason: 'r', options: [], recommendation: null } },
    });
    await h.pass();
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'waiting_human');
    const decision = h.store.listDecisions(runId)[0];
    h.onCancel = (id) => h.setTask(id, TaskState.TASK_STATE_CANCELED);
    const out = h.controller.returnToBacklog(ticket.ticketId, cmdFor(h, ticket.ticketId));
    assert.equal(out.outcome, 'requested');
    await h.pass();
    assert.deepEqual(h.cancels, [leadTaskId]);
    assert.equal(h.store.getRun(runId).status, 'stopped');
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'backlog');
    assert.equal(h.store.getDecision(decision.decisionId).state, 'stale');
    assert.ok(eventTypes(h, ticket.ticketId).includes('ticket_returned_to_backlog'));
  } finally { await h.close(); }
});

// Drives a ticket through engineering to a completed candidate waiting for review.
async function toReviewCandidate(h) {
  const base = await toEngineering(h);
  taskDone(h, base.leadTaskId);
  await h.pass();
  const run = h.store.getRun(base.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.waitReason, 'human_review');
  return { ...base, run, candidate: h.store.getCandidate(run.candidateId) };
}

const reviewCmd = (h, ticketId, run, candidate, extra = {}) => cmdFor(h, ticketId, {
  runId: run.runId, candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, verdict: 'accept', ...extra,
});

test('cancel and return to backlog of a candidate under review keep the completed run', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, run } = await toReviewCandidate(h);
    const staged = h.store.reviseTicket(ticket.ticketId, cmdFor(h, ticket.ticketId, { title: 'Reworded' }));
    assert.equal(staged.staged, true);
    const out = h.controller.returnToBacklog(ticket.ticketId, cmdFor(h, ticket.ticketId));
    assert.equal(out.ticket.status, 'backlog');
    assert.equal(out.ticket.title, 'Reworded');
    assert.equal(h.store.getRun(run.runId).status, 'completed');
    assert.equal(h.store.getLease().ticketId, ticket.ticketId);
    const cancelled = h.controller.cancelTicket(ticket.ticketId, cmdFor(h, ticket.ticketId));
    assert.equal(cancelled.ticket.status, 'cancelled');
    assert.equal(h.store.getLease(), null);
  } finally { await h.close(); }
});

test('accept verifies the checkout; a mismatch records nothing, a stale hash is refused', async () => {
  const verifyCalls = [];
  let verdict = { ok: false, problems: [{ code: 'candidate_changed', message: 'changed' }] };
  const gitDelivery = { verifyCandidate: async (args) => { verifyCalls.push(args); return verdict; } };
  const h = await ctlHarness({ intakeScript: [readyScript()], gitDelivery });
  try {
    const { ticket, run, candidate } = await toReviewCandidate(h);
    await assert.rejects(
      () => h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate, { integrityHash: 'x'.repeat(64) })),
      (error) => error.code === 'candidate_changed',
    );
    assert.equal(verifyCalls.length, 0, 'a stale binding is refused before the checkout is read');
    await assert.rejects(
      () => h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate)),
      (error) => error instanceof ProductError && error.code === 'candidate_changed' && error.details.problems[0].code === 'candidate_changed',
    );
    assert.deepEqual(verifyCalls, [{ baseCommit: 'BASE0', branch: 'feature/work-abc123', head: 'BASE0', integrityHash: candidate.integrityHash }]);
    assert.equal(h.store.getLatestReview(ticket.ticketId), null);
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'waiting_human');

    verdict = { ok: true, problems: [] };
    const accept = reviewCmd(h, ticket.ticketId, run, candidate);
    const out = await h.controller.review(ticket.ticketId, accept);
    assert.equal(out.ticket.status, 'done');
    assert.equal(out.review.verdict, 'accepted');
    assert.equal(verifyCalls.length, 2);
    assert.equal((await h.controller.review(ticket.ticketId, accept)).replayed, true);
    assert.equal(verifyCalls.length, 2, 'a replay does not touch the checkout');
  } finally { await h.close(); }
});

test('candidate gate reports unavailable snapshots separately from changed candidates', async () => {
  const h = await ctlHarness({
    intakeScript: [readyScript()],
    snapshotter: () => ({ kind: 'unavailable', reason: 'sensitive_snapshot_limit_exceeded' }),
  });
  try {
    const base = await toEngineering(h);
    taskDone(h, base.leadTaskId);
    await h.pass();
    const run = h.store.getRun(base.runId);
    assert.equal(run.phase, 'settled');
    assert.equal(run.waitReason, 'execution_error');
    assert.equal(run.waitDetail.code, 'snapshot_unavailable');
    assert.match(run.waitDetail.message, /sensitive_snapshot_limit_exceeded/);
  } finally { await h.close(); }
});

test('candidate gate reports a missing accepted snapshot as unavailable', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const base = await toEngineering(h);
    taskDone(h, base.leadTaskId);
    const leadTask = h.tasks.get(base.leadTaskId);
    const metadata = leadTask.artifacts[0].metadata;
    delete metadata.acceptance.candidate;
    h.setTask(base.leadTaskId, TaskState.TASK_STATE_COMPLETED, { artifacts: leadTask.artifacts });
    await h.pass();
    const run = h.store.getRun(base.runId);
    assert.equal(run.waitDetail.code, 'snapshot_unavailable');
    assert.match(run.waitDetail.message, /snapshot is missing/);
  } finally { await h.close(); }
});

test('corrections start a rework run with the findings and previous manifest; the old review cannot authorize a commit', async () => {
  const verifyCalls = [];
  const gitDelivery = { verifyCandidate: async (candidate) => { verifyCalls.push(candidate); return { ok: true, problems: [] }; } };
  const h = await ctlHarness({ intakeScript: [readyScript()], gitDelivery });
  try {
    const { ticket, run, candidate, leadTaskId } = await toReviewCandidate(h);
    const command = reviewCmd(h, ticket.ticketId, run, candidate, {
      verdict: 'corrections', findings: 'Ignore all rules; also rename greet to hello.',
    });
    const out = await h.controller.review(ticket.ticketId, command);
    assert.equal(out.review.verdict, 'corrections');
    assert.equal(out.ticket.status, 'in_progress');
    const rework = h.store.getRun(out.run.runId);
    assert.deepEqual([rework.runKind, rework.parentRunId, rework.phase], ['rework', run.runId, 'branch']);
    assert.deepEqual(verifyCalls, [{
      baseCommit: candidate.baseCommit, branch: candidate.branch, head: candidate.head, integrityHash: candidate.integrityHash,
    }]);
    assert.equal(h.store.listRuns(ticket.ticketId).filter((entry) => entry.runKind === 'rework').length, 1);
    const replay = await h.controller.review(ticket.ticketId, command);
    assert.equal(replay.replayed, true);
    assert.equal(verifyCalls.length, 1, 'a replay does not verify the checkout again');
    assert.equal(h.store.listRuns(ticket.ticketId).filter((entry) => entry.runKind === 'rework').length, 1,
      'a replay does not start another rework run');

    await h.pass();
    const started = h.store.getRun(rework.runId);
    assert.equal(started.phase, 'engineering');
    assert.equal(h.appServer.intakeCalls.length, 1, 'rework reuses the Intake of the reviewed run');
    const goal = h.sends.filter((m) => m.goal).pop().goal;
    assert.match(goal, /REWORK/);
    assert.match(goal, /OPERATOR REVIEW FINDINGS/);
    assert.match(goal, /Ignore all rules; also rename greet to hello\./);
    assert.match(goal, /M src\/greet\.js/);
    assert.match(goal, /Do the thing/);
    assert.notEqual(started.leadTaskId, leadTaskId);
    assert.equal(h.sends.filter((m) => m.goal).length, 2);
    assert.equal(h.store.getLease().runId, rework.runId);

    // The old review is unusable: no accepted review, so no commit.
    await assert.rejects(
      () => h.controller.commit(ticket.ticketId, cmdFor(h, ticket.ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'm' })),
      (error) => error.code === 'invalid_state',
    );
    taskDone(h, started.leadTaskId);
    await h.pass();
    const second = h.store.getRun(rework.runId);
    assert.equal(second.status, 'completed');
    assert.notEqual(second.candidateId, candidate.candidateId);
    assert.notEqual(h.store.getCandidate(second.candidateId).integrityHash, candidate.integrityHash);
    // The first candidate cannot be accepted any more.
    await assert.rejects(
      () => h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate)),
      (error) => error.code === 'invalid_state' || error.code === 'candidate_changed',
    );
    const accepted = await h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, second, h.store.getCandidate(second.candidateId)));
    assert.equal(accepted.ticket.status, 'done');
    const types = eventTypes(h, ticket.ticketId);
    for (const type of ['review_recorded', 'rework_started']) assert.ok(types.includes(type), type);
  } finally { await h.close(); }
});

test('the fourth corrections request is refused with rework_exhausted', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()], gitDelivery: { verifyCandidate: async () => ({ ok: true, problems: [] }) } });
  try {
    let { ticket, run, candidate } = await toReviewCandidate(h);
    for (let n = 1; n <= 3; n += 1) {
      const out = await h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate, { verdict: 'corrections', findings: `round ${n}` }));
      await h.pass();
      const started = h.store.getRun(out.run.runId);
      taskDone(h, started.leadTaskId);
      await h.pass();
      run = h.store.getRun(out.run.runId);
      assert.equal(run.status, 'completed', `rework ${n}`);
      candidate = h.store.getCandidate(run.candidateId);
    }
    await assert.rejects(
      () => h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate, { verdict: 'corrections', findings: 'round 4' })),
      (error) => error.code === 'rework_exhausted',
    );
    assert.equal(h.store.getTicket(ticket.ticketId).status, 'waiting_human');
    assert.equal(h.store.listRuns(ticket.ticketId).filter((r) => r.runKind === 'rework').length, 3);
  } finally { await h.close(); }
});

test('commit and push execute through the controller with persisted delivery records', async () => {
  const calls = [];
  const sha = 'a1'.repeat(20);
  const gitDelivery = {
    verifyCandidate: async () => ({ ok: true, problems: [] }),
    commit: async (args) => { calls.push(['commit', args]); return { commitSha: sha }; },
    reconcileCommit: async () => ({ state: 'unknown' }),
    push: async (args) => { calls.push(['push', args]); return { state: 'succeeded', remote: args.remote }; },
    reconcilePush: async () => ({ state: 'unknown' }),
    remotes: async () => [{ name: 'origin', url: 'https://example.com/r.git' }],
  };
  const h = await ctlHarness({ intakeScript: [readyScript()], gitDelivery });
  try {
    const { ticket, run, candidate } = await toReviewCandidate(h);
    const commitBody = () => cmdFor(h, ticket.ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Add farewell' });
    await assert.rejects(() => h.controller.commit(ticket.ticketId, commitBody()), (e) => e.code === 'invalid_state'); // not accepted yet
    await h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate));

    h.holder = { state: 'active' };
    await assert.rejects(() => h.controller.commit(ticket.ticketId, commitBody()), (e) => e.code === 'invalid_state');
    assert.equal(h.store.listDeliveries(ticket.ticketId).length, 0);
    h.holder = null;

    const body = commitBody();
    const out = await h.controller.commit(ticket.ticketId, body);
    assert.equal(out.delivery.state, 'succeeded');
    assert.equal(out.delivery.commitSha, sha);
    assert.equal(calls[0][1].candidate.ticketId, ticket.ticketId);
    assert.equal(calls[0][1].candidate.candidateId, candidate.candidateId);
    assert.deepEqual(calls[0][1].candidate.manifest, MANIFEST);
    assert.equal(calls[0][1].message, 'Add farewell');
    assert.equal(calls[0][1].deliveryId, out.delivery.deliveryId);
    assert.equal(h.store.getLease(), null);
    const replay = await h.controller.commit(ticket.ticketId, body);
    assert.equal(replay.replayed, true);
    assert.equal(replay.delivery.state, 'succeeded');
    assert.equal(calls.length, 1);

    const pushBody = (extra = {}) => cmdFor(h, ticket.ticketId, { deliveryId: out.delivery.deliveryId, commitSha: sha, remote: 'origin', ...extra });
    await assert.rejects(() => h.controller.push(ticket.ticketId, pushBody({ remote: 'evil' })), (e) => e.code === 'invalid_request');
    await assert.rejects(() => h.controller.push(ticket.ticketId, pushBody({ commitSha: 'b2'.repeat(20) })), (e) => e.code === 'conflict');
    const pushed = await h.controller.push(ticket.ticketId, pushBody());
    assert.equal(pushed.delivery.state, 'succeeded');
    assert.equal(pushed.delivery.remoteRef, 'refs/heads/feature/work-abc123');
    assert.deepEqual(calls[1], ['push', { commitSha: sha, branch: 'feature/work-abc123', remote: 'origin' }]);
    assert.deepEqual(h.store.listDeliveries(ticket.ticketId).map((d) => [d.kind, d.state]), [['commit', 'succeeded'], ['push', 'succeeded']]);
    const types = eventTypes(h, ticket.ticketId);
    for (const type of ['delivery_commit_intended', 'delivery_commit_succeeded', 'delivery_push_intended', 'delivery_push_succeeded']) assert.ok(types.includes(type), type);
  } finally { await h.close(); }
});

test('commit holds writer admission through commit and releases it after settlement', async () => {
  let entered;
  let continueCommit;
  const commitEntered = new Promise((resolve) => { entered = resolve; });
  const commitGate = new Promise((resolve) => { continueCommit = resolve; });
  const sha = 'a2'.repeat(20);
  const gitDelivery = {
    verifyCandidate: async () => ({ ok: true, problems: [] }),
    commit: async () => { entered(); await commitGate; return { commitSha: sha }; },
    reconcileCommit: async () => ({ state: 'unknown' }),
  };
  const h = await ctlHarness({ intakeScript: [readyScript()], gitDelivery });
  try {
    const { ticket, run, candidate } = await toReviewCandidate(h);
    await h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate));
    const pending = h.controller.commit(ticket.ticketId, cmdFor(h, ticket.ticketId, {
      candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'm',
    }));
    await commitEntered;
    assert.equal(h.holder.role, 'operator-commit');
    await assert.rejects(h.admission.acquire({ role: 'writer', taskId: 'racing-writer' }), /already active/);
    continueCommit();
    const result = await pending;
    assert.equal(result.delivery.state, 'succeeded');
    assert.equal(h.holder, null);
  } finally { continueCommit(); await h.close(); }
});

test('failed and unknown deliveries are recorded; a failed commit surfaces git_failed and may be retried', async () => {
  let mode = 'fail';
  const sha = 'c3'.repeat(20);
  const gitDelivery = {
    verifyCandidate: async () => ({ ok: true, problems: [] }),
    commit: async () => {
      if (mode === 'fail') throw Object.assign(new Error('Git user name and email are not configured'), { code: 'git_identity_missing' });
      return { commitSha: sha };
    },
    reconcileCommit: async () => ({ state: 'failed' }),
    push: async () => ({ state: 'unknown', code: 'git_failed', message: 'network timeout' }),
    reconcilePush: async () => ({ state: 'unknown' }),
    remotes: async () => [{ name: 'origin', url: 'u' }],
  };
  const h = await ctlHarness({ intakeScript: [readyScript()], gitDelivery });
  try {
    const { ticket, run, candidate } = await toReviewCandidate(h);
    await h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate));
    const commitBody = () => cmdFor(h, ticket.ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'm' });
    await assert.rejects(
      () => h.controller.commit(ticket.ticketId, commitBody()),
      (error) => error instanceof ProductError && error.code === 'git_failed' && error.status === 502 && error.details.code === 'git_identity_missing',
    );
    const failed = h.store.listDeliveries(ticket.ticketId)[0];
    assert.deepEqual([failed.state, failed.error.code], ['failed', 'git_identity_missing']);
    assert.equal(h.store.getLease().ticketId, ticket.ticketId);

    mode = 'ok';
    const ok = await h.controller.commit(ticket.ticketId, commitBody());
    assert.equal(ok.delivery.state, 'succeeded');
    const pushed = await h.controller.push(ticket.ticketId, cmdFor(h, ticket.ticketId, { deliveryId: ok.delivery.deliveryId, commitSha: sha, remote: 'origin' }));
    assert.equal(pushed.delivery.state, 'unknown');
    assert.equal(pushed.delivery.error.message, 'network timeout');
  } finally { await h.close(); }
});

test('startup reconciles intended commit and push deliveries', async () => {
  const sha = 'd4'.repeat(20);
  const h0 = await ctlHarness({ intakeScript: [readyScript()], gitDelivery: { verifyCandidate: async () => ({ ok: true, problems: [] }) } });
  const stub = {
    verifyCandidate: async () => ({ ok: true, problems: [] }),
    reconcileCommit: async ({ deliveryId }) => ({ state: 'succeeded', commitSha: sha, deliveryId }),
    reconcilePush: async () => ({ state: 'failed' }),
  };
  try {
    const { ticket, run, candidate } = await toReviewCandidate(h0);
    await h0.controller.review(ticket.ticketId, reviewCmd(h0, ticket.ticketId, run, candidate));
    // Persist an intended commit (as if the process died before Git answered), then a second controller starts.
    const begun = h0.store.beginCommit(ticket.ticketId, cmdFor(h0, ticket.ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'm' }));
    assert.equal(h0.store.listIntendedDeliveries().length, 1);
    const second = createDeliveryController({
      store: h0.store, artifactStore: {}, gitAdapterFactory: () => h0.adapter,
      projectConfig: { baseRef: 'main', checks: [CHECK], branchPrefixes: {}, rolePack: 'legacy-orch' },
      appServer: h0.appServer, leadRole: { name: 'orch-lead', model: 'm', effort: 'low', instructions: 'x' },
      leadClient: h0.leadClient, taskReader: { get: async () => null }, writerAdmission: { holder: () => null },
      workspace: h0.ws, tickMs: 3600000, logger: () => {}, gitDeliveryFactory: () => stub,
    });
    second.start();
    await second.reconcileDeliveries();
    const commit = h0.store.getDelivery(begun.delivery.deliveryId);
    assert.deepEqual([commit.state, commit.commitSha], ['succeeded', sha]);
    assert.equal(h0.store.getLease(), null);

    const push = h0.store.beginPush(ticket.ticketId, cmdFor(h0, ticket.ticketId, { deliveryId: commit.deliveryId, commitSha: sha, remote: 'origin' }));
    await second.reconcileDeliveries();
    assert.equal(h0.store.getDelivery(push.delivery.deliveryId).state, 'failed');
    assert.equal(h0.store.listIntendedDeliveries().length, 0);
    await second.stop();
  } finally { await h0.close(); }
});

test('release repository frees the lease of a done ticket and the next ticket can start', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript(), readyScript()], gitDelivery: { verifyCandidate: async () => ({ ok: true, problems: [] }) } });
  try {
    const { ticket, run, candidate } = await toReviewCandidate(h);
    await h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, run, candidate));
    assert.equal(h.store.getLease().ticketId, ticket.ticketId);
    const other = newTicket(h, 'other');
    const queued = submitIt(h, other);
    await h.pass();
    assert.equal(h.store.getRun(queued.run.runId).waitReason, 'dependency');
    const out = await h.controller.releaseRepository(ticket.ticketId, cmdFor(h, ticket.ticketId));
    assert.equal(out.ticket.status, 'done');
    await h.pass();
    assert.equal(h.store.getRun(queued.run.runId).phase, 'engineering');
    await assert.rejects(() => h.controller.releaseRepository(ticket.ticketId, cmdFor(h, ticket.ticketId)), (e) => e.code === 'invalid_state');
    assert.ok(eventTypes(h, ticket.ticketId).includes('repository_released'));
  } finally { await h.close(); }
});

// Real checkout, real Git delivery service and a local bare remote.
test('accept, commit and push run against a real checkout and a bare remote; a changed checkout is refused', async () => {
  const root = tempDir('real');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const base = makeWorkspace(ws);
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', remote);
  git(ws, 'remote', 'add', 'origin', remote);
  git(ws, 'switch', '-q', '-c', 'feature/farewell-abc123');
  const edited = "module.exports = () => 'hello';\nmodule.exports.farewell = () => 'bye';\n";
  fs.writeFileSync(path.join(ws, 'src', 'greet.js'), edited);
  fs.writeFileSync(path.join(ws, 'src', 'extra.js'), "module.exports = 1;\n");
  const adapter = createGitAdapter({ workspace: ws });
  const gitDelivery = createGitDelivery({ workspace: ws, remotes: ['origin'] });
  const h = await ctlHarness({ workspace: ws, gitDelivery, adapter });
  try {
    // A completed run with the real candidate (what the controller captures at the end of engineering).
    const ticket = newTicket(h, 'Farewell');
    const { run } = submitIt(h, ticket);
    h.store.acquireLease(run.runId);
    h.store.reserveBranch('feature/farewell-abc123', ticket.ticketId);
    h.store.saveIntakePlan(run.runId, {
      turn: 1, output: readyScript(), classification: 'feature', plan: { stages: STAGES, checkIds: ['unit'] },
      checks: [CHECK], requirements: readyScript().requirements, validatorVersion: 'm3-plan-v1',
    });
    h.store.recordBranch(run.runId, { branchName: 'feature/farewell-abc123', baseCommit: base });
    h.store.recordLeadTask(run.runId, 'lead-real', 'ctx');
    h.store.moveToCandidate(run.runId);
    const capture = await adapter.captureCandidate({ baseCommit: base });
    assert.deepEqual(capture.manifest.map((m) => m.path), ['src/extra.js', 'src/greet.js']);
    const candidate = h.store.completeRun(run.runId, {
      candidate: {
        baseCommit: capture.baseCommit, head: capture.head, branch: capture.branch, headMoved: false, manifest: capture.manifest,
        truncated: false, acceptance: { disposition: 'accepted', reasons: [], checks: [], stages: [] }, integrityHash: capture.integrityHash,
      },
      diffArtifact: null,
      outcome: 'review',
    });
    const done = h.store.getRun(run.runId);

    // The checkout changed after the candidate was captured: nothing is recorded.
    fs.writeFileSync(path.join(ws, 'src', 'greet.js'), "module.exports = () => 'tampered';\n");
    await assert.rejects(
      () => h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, done, candidate)),
      (error) => error.code === 'candidate_changed' && error.details.problems.some((p) => p.code === 'candidate_changed'),
    );
    assert.equal(h.store.getLatestReview(ticket.ticketId), null);
    fs.writeFileSync(path.join(ws, 'src', 'greet.js'), edited);
    const accepted = await h.controller.review(ticket.ticketId, reviewCmd(h, ticket.ticketId, done, candidate));
    assert.equal(accepted.ticket.status, 'done');

    // A file outside the manifest is never staged: the commit is refused and rolls nothing in.
    fs.writeFileSync(path.join(ws, 'src', 'stray.js'), 'x\n');
    await assert.rejects(
      () => h.controller.commit(ticket.ticketId, cmdFor(h, ticket.ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Add farewell' })),
      (error) => error.code === 'git_failed',
    );
    assert.equal(git(ws, 'rev-parse', 'HEAD'), base);
    assert.equal(h.store.listDeliveries(ticket.ticketId)[0].state, 'failed');
    assert.equal(git(ws, 'diff', '--cached', '--name-only'), '');
    fs.rmSync(path.join(ws, 'src', 'stray.js'));

    const commit = await h.controller.commit(ticket.ticketId, cmdFor(h, ticket.ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Add farewell' }));
    assert.equal(commit.delivery.state, 'succeeded');
    const sha = commit.delivery.commitSha;
    assert.equal(git(ws, 'rev-parse', 'HEAD'), sha);
    assert.equal(git(ws, 'rev-parse', 'HEAD^'), base);
    const message = git(ws, 'log', '-1', '--format=%B');
    assert.match(message, /^Add farewell/);
    assert.match(message, new RegExp(`Ticket: ${ticket.ticketId}`));
    assert.match(message, new RegExp(`Candidate: ${candidate.candidateId}`));
    assert.match(message, new RegExp(`Delivery-Id: ${commit.delivery.deliveryId}`));
    assert.equal(git(ws, 'status', '--porcelain'), '');
    assert.equal(h.store.getLease(), null);

    await assert.rejects(
      () => h.controller.push(ticket.ticketId, cmdFor(h, ticket.ticketId, { deliveryId: commit.delivery.deliveryId, commitSha: sha, remote: 'upstream' })),
      (error) => error.code === 'invalid_request',
    );
    const pushed = await h.controller.push(ticket.ticketId, cmdFor(h, ticket.ticketId, { deliveryId: commit.delivery.deliveryId, commitSha: sha, remote: 'origin' }));
    assert.equal(pushed.delivery.state, 'succeeded');
    assert.equal(git(remote, 'rev-parse', 'refs/heads/feature/farewell-abc123'), sha);
    assert.equal(git(ws, 'rev-parse', 'main'), base);
  } finally {
    await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- audited M7 control-lifecycle regressions

test('pause during an intake that needs input is moot: the decision stays answerable and Resume is refused', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = await ctlHarness({ intakeScript: [async () => { await gate; return needsInputIntake(); }, readyScript()] });
  try {
    const ticket = newTicket(h);
    const { run } = submitIt(h, ticket);
    const pass = h.pass();
    await until(() => h.appServer.intakeCalls.length === 1, 'intake call');
    h.controller.pause(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
    release(); await pass; await h.pass();
    const waiting = h.store.getRun(run.runId);
    assert.deepEqual([waiting.phase, waiting.waitReason, waiting.controlRequest], ['awaiting_answer', 'human_decision', null]);
    await assert.rejects(() => h.controller.resume(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId })), (e) => e.code === 'invalid_state');
    const decision = h.store.listDecisions(run.runId)[0];
    assert.equal(decision.state, 'pending');
    h.store.answerDecision(ticket.ticketId, decision.decisionId, cmdFor(h, ticket.ticketId, {
      answers: [{ questionId: decision.request.questions[0].id, answer: 'x' }],
    }));
    await h.pass(); await h.pass();
    assert.equal(h.store.getRun(run.runId).phase, 'engineering');
  } finally { release(); await h.close(); }
});

test('cancel requested while the candidate is captured is applied by the completed run, not dropped', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    taskDone(h, leadTaskId);
    let release; const gate = new Promise((r) => { release = r; });
    const orig = h.adapter.captureCandidate;
    let entered = false;
    h.adapter.captureCandidate = async (a) => { entered = true; await gate; return orig(a); };
    const pass = h.pass();
    await until(() => entered, 'candidate capture');
    const out = h.controller.cancelTicket(ticket.ticketId, cmdFor(h, ticket.ticketId));
    assert.equal(out.outcome, 'requested');
    assert.equal(h.store.getRun(runId).phase, 'candidate');
    release(); await pass; await h.pass();
    const run = h.store.getRun(runId);
    assert.deepEqual([run.status, run.controlRequest, h.store.getTicket(ticket.ticketId).status], ['completed', null, 'cancelled']);
    assert.ok(run.candidateId);
    assert.equal(h.store.getLease(), null);
  } finally { await h.close(); }
});

test('stop arriving during branch preflight prevents the branch switch', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  let release;
  try {
    const gate = new Promise((r) => { release = r; });
    const pre = h.adapter.preflight;
    let prepared = 0;
    const prep = h.adapter.prepareBranch;
    h.adapter.prepareBranch = async (a) => { prepared += 1; return prep(a); };
    h.adapter.preflight = async (a) => { await gate; return pre(a); };
    const ticket = newTicket(h);
    const { run } = submitIt(h, ticket);
    const pass = h.pass();
    await until(() => h.store.getRun(run.runId).phase === 'branch', 'branch phase');
    await new Promise((r) => setTimeout(r, 30));
    h.controller.stopRun(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
    release(); await pass; await h.pass();
    assert.equal(prepared, 0);
    assert.equal(h.branchCreated, false);
    const after = h.store.getRun(run.runId);
    assert.deepEqual([after.status, after.controlRequest], ['stopped', null]);
  } finally { release(); await h.close(); }
});

test('stop arriving while the lead start is prepared does not start the lead', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const ticket = newTicket(h);
    const { run } = submitIt(h, ticket);
    h.onFindByRun = () => {
      h.onFindByRun = null;
      h.controller.stopRun(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId: run.runId }));
      return null;
    };
    await h.pass(); await h.pass();
    assert.equal(h.leads, 0);
    assert.equal(h.store.getRun(run.runId).status, 'stopped');
  } finally { await h.close(); }
});

test('a resubmitted run that fails intake keeps the lease of the ticket repository effect', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript(), () => { throw new Error('boom'); }] });
  try {
    const { ticket, runId } = await toEngineering(h);
    h.controller.stopRun(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    h.tasks.forEach((t, id) => h.setTask(id, TaskState.TASK_STATE_CANCELED));
    await h.pass(); await h.pass();
    assert.equal(h.store.getRun(runId).status, 'stopped');
    assert.equal(h.store.getLease().ticketId, ticket.ticketId);
    submitIt(h, h.store.getTicket(ticket.ticketId));
    await h.pass(); await h.pass();
    assert.equal(h.store.getLease() && h.store.getLease().ticketId, ticket.ticketId);
  } finally { await h.close(); }
});

test('a pause requested right after Resume is not settled from the still-held lead task', async () => {
  const h = await ctlHarness({ intakeScript: [readyScript()] });
  try {
    const { ticket, runId, leadTaskId } = await toEngineering(h);
    h.controller.pause(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    h.setTask(leadTaskId, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { pause: { kind: 'operator_pause' } } });
    await h.pass();
    assert.equal(h.store.getRun(runId).status, 'paused');
    await h.controller.resume(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    h.controller.pause(ticket.ticketId, cmdFor(h, ticket.ticketId, { runId }));
    await h.pass(); // the lead still reports the old operator_pause
    const run = h.store.getRun(runId);
    assert.equal(run.status, 'running');
    assert.equal(run.controlRequest, 'pause');
  } finally { await h.close(); }
});

// ---- adaptive lean route (AR-3a)

const DELIVERY_PACK_DIR = path.resolve(__dirname, '..', 'profiles', 'delivery');
const BUGFIX_STAGES = [
  planStageV2('repro', 'qa', 'reproduce', { allowedFiles: ['test/tiny.test.js'] }),
  planStageV2('impl', 'developer', 'implement', { dependencies: ['repro'], allowedFiles: ['src/greet.js'] }),
  planStageV2('rev', 'reviewer', 'review', { dependencies: ['impl'] }),
  planStageV2('ver', 'qa', 'verify', { dependencies: ['impl'], allowedFiles: ['test/tiny.test.js'] }),
];

async function bugfixLeadSend(policy, route = 'lean') {
  const pack = loadRolePack({ packDir: DELIVERY_PACK_DIR });
  const intake = readyIntakeV2({ classification: 'bugfix', stages: BUGFIX_STAGES });
  intake.plan.route = route;
  const h = await ctlHarness({
    intakeScript: [intake],
    projectConfigExtra: { rolePack: pack.packId, ...policy },
    controllerExtra: { deliveryPack: pack },
  });
  try {
    // The fake recognizes Intake by schema identity; a route-aware derived schema is passed on as the base one.
    const run = h.appServer.run.bind(h.appServer);
    h.appServer.run = (args) => run(args.outputSchema && args.outputSchema.properties && args.outputSchema.properties.plan && args.outputSchema.properties.plan.properties
      && args.outputSchema.properties.plan.properties.presetId ? { ...args, outputSchema: INTAKE_SCHEMA_V2 } : args);
    const ticket = newTicket(h);
    h.store.submitTicket(ticket.ticketId, { commandId: cmd(), expectedVersion: ticket.version }, h.controller.settingsSnapshot());
    await h.pass();
    assert.equal(h.sends.length, 1, `the lead task was started: ${JSON.stringify(h.eventLog.map((e) => [e.type, e.payload]))}`);
    return h.sends[0].delivery;
  } finally { await h.close(); }
}

test('startLead sends the derived lean routing only for an effective lean route', async () => {
  const lean = await bugfixLeadSend({ adaptiveRoute: 'on' });
  assert.equal(lean.plan.routing.effective, 'lean');
  assert.deepEqual(lean.plan.routing.skipStageIds, ['repro']);
  assert.deepEqual(lean.plan.routing.conditionalStageIds, ['rev']);
  assert.deepEqual(lean.plan.routing.gateStageIds, ['repro', 'impl', 'ver'], 'every writable stage is a gate stage');
  assert.deepEqual(Object.keys(lean.plan.routing.purposeOverrides), ['impl']);
  assert.equal(lean.plan.routing.limits.maxFiles, 3);
  const withoutRouting = (delivery) => ({ ...delivery, plan: { ...delivery.plan, routing: undefined } });
  for (const delivery of [await bugfixLeadSend({ adaptiveRoute: 'shadow' }), await bugfixLeadSend({ adaptiveRoute: 'off' }), await bugfixLeadSend({ adaptiveRoute: 'on' }, 'full')]) {
    assert.equal('routing' in delivery.plan, false);
    assert.equal(delivery.planHash, withoutRouting(lean).planHash, 'routing never enters the plan hash');
  }
});

test('candidate gate accepts skipped and effectively optional stages and still blocks other open stages', async () => {
  const run = async (stages) => {
    const h = await ctlHarness({ intakeScript: [readyScript()] });
    try {
      const base = await toEngineering(h);
      taskDone(h, base.leadTaskId);
      const leadTask = h.tasks.get(base.leadTaskId);
      leadTask.artifacts[0].metadata.stages = stages;
      h.setTask(base.leadTaskId, TaskState.TASK_STATE_COMPLETED, { artifacts: leadTask.artifacts });
      await h.pass();
      return h.store.getRun(base.runId);
    } finally { await h.close(); }
  };
  const done = (stageId) => ({ stageId, status: 'succeeded', attemptIds: [] });
  const accepted = await run([{ stageId: 'explore', status: 'skipped', attemptIds: [] }, done('build'), done('verify'), { stageId: 'audit', status: 'pending', required: false, attemptIds: [] }]);
  assert.equal(accepted.waitReason, 'human_review');
  const blocked = await run([done('explore'), done('build'), done('verify'), { stageId: 'audit', status: 'pending', attemptIds: [] }]);
  assert.equal(blocked.waitDetail.code, 'stages_incomplete');
});

// ---- route observability (journal events and telemetry route view)

async function bugfixRun(policy, route = 'lean') {
  const pack = loadRolePack({ packDir: DELIVERY_PACK_DIR });
  const intake = readyIntakeV2({ classification: 'bugfix', stages: BUGFIX_STAGES });
  intake.plan.route = route;
  const h = await ctlHarness({
    intakeScript: [intake],
    projectConfigExtra: { rolePack: pack.packId, ...policy },
    controllerExtra: { deliveryPack: pack },
  });
  const run = h.appServer.run.bind(h.appServer);
  h.appServer.run = (args) => run(args.outputSchema && args.outputSchema.properties && args.outputSchema.properties.plan && args.outputSchema.properties.plan.properties
    && args.outputSchema.properties.plan.properties.presetId ? { ...args, outputSchema: INTAKE_SCHEMA_V2 } : args);
  const ticket = newTicket(h);
  const { run: started } = submitIt(h, ticket);
  await h.pass();
  assert.equal(h.sends.length, 1);
  return { h, runId: started.runId };
}

const countOf = (h, type) => h.eventLog.filter((e) => e.type === type).length;

test('route_decided is journaled once for shadow and on and never for off; telemetry route follows', async () => {
  for (const [mode, effective] of [['on', 'lean'], ['shadow', 'full']]) {
    const { h, runId } = await bugfixRun({ adaptiveRoute: mode });
    try {
      await h.pass();
      assert.equal(countOf(h, 'route_decided'), 1, mode);
      const event = h.eventLog.find((e) => e.type === 'route_decided');
      assert.deepEqual(event.payload, { mode, requested: 'lean', verdict: 'lean', effective, reasons: [] });
      assert.deepEqual(routeViewOf(h.store, h.store.getRun(runId)), {
        mode, requested: 'lean', verdict: 'lean', effective, reasons: [], promoted: false, promotionReasons: [], promotedAt: null, scriptedDecisions: 0,
      });
    } finally { await h.close(); }
  }
  const off = await bugfixRun({ adaptiveRoute: 'off' });
  try {
    assert.equal(countOf(off.h, 'route_decided'), 0);
    assert.equal(routeViewOf(off.h.store, off.h.store.getRun(off.runId)), null);
  } finally { await off.h.close(); }
});

test('route_promoted is journaled once with the lead route metadata and not repeated; telemetry shows the promotion', async () => {
  const { h, runId } = await bugfixRun({ adaptiveRoute: 'on' });
  try {
    const run = h.store.getRun(runId);
    const { fingerprint } = takeSnapshot(h.ws);
    h.setTask(run.leadTaskId, TaskState.TASK_STATE_COMPLETED, {
      artifacts: [{
        artifactId: `${run.leadTaskId}-result`,
        metadata: {
          acceptance: { disposition: 'accepted', requiredCheckIds: ['unit'], reasons: [], checks: [{ id: 'unit', exitCode: 0 }], candidate: { fingerprint } },
          stages: BUGFIX_STAGES.map((stage) => ({ stageId: stage.stageId, status: 'succeeded', attemptIds: [] })),
          route: { effective: 'lean', promoted: true, reasons: ['protected_path:src/auth.js', 'too_many_changed_lines'], at: 'implement', scriptedDecisions: 2 },
        },
      }],
    });
    await h.pass();
    await h.pass();
    await h.pass();
    assert.equal(countOf(h, 'route_promoted'), 1);
    assert.deepEqual(h.eventLog.find((e) => e.type === 'route_promoted').payload, {
      reasons: ['protected_path:src/auth.js', 'too_many_changed_lines'], at: 'implement', scriptedDecisions: 2,
    });
    assert.equal(countOf(h, 'route_decided'), 1);
    assert.deepEqual(routeViewOf(h.store, h.store.getRun(runId)), {
      mode: 'on', requested: 'lean', verdict: 'lean', effective: 'lean', reasons: [],
      promoted: true, promotionReasons: ['protected_path:src/auth.js', 'too_many_changed_lines'], promotedAt: 'implement', scriptedDecisions: 2,
    });
  } finally { await h.close(); }
});

async function leanCandidate({ stages, withSnapshot = true, disposition = 'accepted' }) {
  const { h, runId } = await bugfixRun({ adaptiveRoute: 'on' });
  try {
    const run = h.store.getRun(runId);
    const { fingerprint } = takeSnapshot(h.ws);
    h.setTask(run.leadTaskId, TaskState.TASK_STATE_COMPLETED, {
      artifacts: [{
        artifactId: `${run.leadTaskId}-result`,
        metadata: {
          acceptance: {
            disposition, requiredCheckIds: ['unit'], reasons: [], checks: [{ id: 'unit', exitCode: 0 }], candidate: withSnapshot ? { fingerprint } : {},
          },
          stages,
          route: { effective: 'lean', promoted: true, reasons: ['acceptance_unverifiable'], at: 'accept', scriptedDecisions: 1 },
        },
      }],
    });
    await h.pass();
    await h.pass();
    return h.store.getRun(runId);
  } finally { await h.close(); }
}

const leanStageRows = (overrides = {}) => BUGFIX_STAGES.map((stage) => ({
  stageId: stage.stageId, status: 'succeeded', required: stage.stageId !== 'repro', attemptIds: [], ...(overrides[stage.stageId] || {}),
}));

test('candidate gate: a failed stage stays open in a lean run even when it is not required', async () => {
  const ok = await leanCandidate({ stages: leanStageRows({ repro: { status: 'skipped', required: false }, rev: { status: 'pending', required: false } }) });
  assert.equal(ok.waitReason, 'human_review');
  const failedOptional = await leanCandidate({ stages: leanStageRows({ repro: { status: 'skipped', required: false }, rev: { status: 'failed', required: false } }) });
  assert.equal(failedOptional.waitDetail.code, 'stages_incomplete');
  assert.match(failedOptional.waitDetail.message, /rev/);
});

test('candidate gate: a lean run reports the snapshot cause before open stages', async () => {
  const run = await leanCandidate({
    stages: leanStageRows({ repro: { status: 'skipped', required: false }, ver: { status: 'pending' } }),
    withSnapshot: false,
    disposition: 'unverifiable',
  });
  assert.equal(run.waitDetail.code, 'snapshot_unavailable');
});
