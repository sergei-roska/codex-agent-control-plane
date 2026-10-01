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
const {
  decision, assignment, humanDecision, workerReport, makeFakeAppServer, planStage, readyIntake, needsInputIntake,
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
      assert.match(run.branchName, /^feature\/add-a-farewell-helper-[a-z0-9]{6}$/);
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
      assert.match(queued.waitDetail.message, new RegExp(`Repository in use by ${first.ticketId}`));
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(appServer.intakeCalls.length, 1);
      assert.equal(ticketOf(runtime, second.ticketId).status, 'pending');

      const cancelled = runtime.productStore.cancelTicket(first.ticketId, { commandId: cmd(), expectedVersion: ticketOf(runtime, first.ticketId).version });
      assert.equal(cancelled.ticket.status, 'cancelled');
      assert.equal(runtime.productStore.getRun(runOf(runtime, first.ticketId).runId).status, 'cancelled');
      assert.notEqual(runtime.productStore.getLease()?.ticketId, first.ticketId);
      runtime.deliveryController.poke();

      // The cancelled ticket's changes stay on its branch, so the checkout is still dirty: the second
      // ticket gets the lease, runs intake, then honestly reports dirty_worktree.
      const run = await waitStatus(runtime, second.ticketId, 'blocked', (r) => r.phase === 'settled');
      assert.equal(appServer.intakeCalls.length, 2);
      assert.equal(run.waitDetail.code, 'preflight_failed');
      assert.ok(run.waitDetail.problems.some((p) => p.code === 'dirty_worktree'));
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

      // A restart pause is an unresolved writer outcome: cancel is refused until the CLI resumes it.
      await assert.rejects(
        () => stackB.runtime.deliveryController.cancelTicket(ticket.ticketId, { commandId: cmd(), expectedVersion: ticketOf(stackB.runtime, ticket.ticketId).version }),
        (error) => error instanceof ProductError && error.code === 'invalid_state' && /resume from the CLI first/.test(error.message),
      );
      const stillPaused = await stackB.client.getTask({ tenant: '', id: blocked.leadTaskId, historyLength: 0 }, stackB.requestOptions);
      assert.equal(stillPaused.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      assert.equal(ticketOf(stackB.runtime, ticket.ticketId).status, 'blocked');

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
