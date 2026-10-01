'use strict';

// M3 dashboard HTTP surface over the real delivery stack: a real startServer (lead graph, A2A, SQLite, git adapter,
// acceptance checks) on a temp git workspace with project.json; only the Codex app server is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const {
  decision, assignment, humanDecision, workerReport, makeFakeAppServer, planStage, readyIntake, needsInputIntake,
} = require('./fixtures/fake-app-server');

process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));
// The approved check runs `node --test`; inherited runner context would make it skip the file and exit 0.
delete process.env.NODE_TEST_CONTEXT;

const CHECK = { id: 'unit', argv: ['node', '--test', 'test/tiny.test.js'], timeoutMs: 60000, description: 'Tiny unit test' };
const GOOD_SOURCE = "module.exports = () => 'hello';\nmodule.exports.farewell = () => 'bye';\n";
const BROKEN_SOURCE = "module.exports = () => 'broken';\n";

let seq = 0;
const cmd = () => `dd-${process.pid}-${String(++seq).padStart(5, '0')}`;

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

function builderWorker(workspace, source = GOOD_SOURCE) {
  return async ({ role }) => {
    if (role === 'orch-builder') {
      fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), source);
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('built'), filesChanged: ['src/greet.js'] }) };
    }
    return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
  };
}

// Boots the stack, pairs a dashboard session and runs fn({ runtime, api, client, requestOptions, workspace, appServer }).
async function withStack(appServerFactory, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-dash-delivery-'));
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ baseRef: 'main', checks: [CHECK], rolePack: 'legacy-orch' }));
  const workspace = path.join(root, 'workspace');
  makeWorkspace(workspace);
  const appServer = appServerFactory(workspace);
  const tokenFile = path.join(root, 'token', 'a2a-token');
  let runtime;
  try {
    runtime = await startServer({
      port: 0,
      workspace,
      appServer,
      stateFile: path.join(root, 'state.sqlite'),
      tokenFile,
      projectConfigFile: path.join(root, 'project.json'),
      deliveryTickMs: 25,
      orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
    });
    const origin = `http://${runtime.host}:${runtime.port}`;
    const base = `${origin}/api/dashboard/v1`;
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const bearer = `Bearer ${token}`;
    const api = { origin, base };
    const codeRes = await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } });
    const { code } = await codeRes.json();
    const exchange = await fetch(`${base}/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }),
    });
    assert.equal(exchange.status, 204);
    api.cookie = exchange.headers.get('set-cookie').split(';')[0];
    api.get = (p, { cookie = api.cookie } = {}) => fetch(`${base}${p}`, { headers: cookie ? { Cookie: cookie } : {} });
    api.json = async (p) => {
      const res = await api.get(p);
      assert.equal(res.status, 200, p);
      return res.json();
    };
    api.post = (p, body, { cookie = api.cookie, withOrigin = true } = {}) => fetch(`${base}${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(withOrigin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    });
    api.create = async (extra = {}) => {
      const res = await api.post('/tickets', {
        commandId: cmd(), title: 'Add a farewell helper', description: 'Add farewell() next to greet()', criteria: ['farewell() returns bye'], ...extra,
      });
      assert.equal(res.status, 201);
      return (await res.json()).ticket;
    };
    api.submit = async (ticket) => {
      const res = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId: cmd(), expectedVersion: ticket.version });
      assert.equal(res.status, 201);
      return res.json();
    };
    api.ticket = (id) => api.json(`/tickets/${id}`);
    api.card = async (ticketId) => {
      const { cards } = await api.json('/cards?limit=100');
      return cards.find((c) => c.cardId === ticketId);
    };
    api.waitTicket = async (ticketId, status, extra = () => true) => {
      let last;
      try {
        await until(async () => {
          last = await api.ticket(ticketId);
          return last.ticket.status === status && extra(last);
        }, `ticket ${ticketId} to be ${status}`);
      } catch (error) {
        error.message += ` (last ${JSON.stringify(last && { ticket: last.ticket.status, run: last.runs[0] })})`;
        throw error;
      }
      return last;
    };
    const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
    await fn({
      runtime, api, client, requestOptions: { serviceParameters: { Authorization: bearer } }, workspace, appServer,
    });
  } finally {
    if (runtime) await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('dashboard delivery api', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('submit, intake answer, lead decision answer and the pinned run read shapes', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [needsInputIntake(), readyIntake({ classification: 'feature', stages: STAGES })],
      leadScript: [humanDecision(), ...happyLeadScript()],
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, api, appServer }) => {
      const ticket = await api.create();
      const before = await api.ticket(ticket.ticketId);
      assert.deepEqual(before.availableActions, ['revise', 'submit', 'cancel']);
      assert.deepEqual(before.runs, []);
      assert.equal(before.activeRun, null);
      assert.equal((await api.card(ticket.ticketId)).ticketStatus, 'backlog');

      // Submit: 201 new, 200 replay with the same commandId, one run.
      const commandId = cmd();
      const first = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId, expectedVersion: ticket.version });
      assert.equal(first.status, 201);
      const submitted = await first.json();
      assert.equal(submitted.ticket.status, 'pending');
      assert.equal(submitted.run.status, 'queued');
      assert.deepEqual(Object.keys(submitted.run).sort(), [
        'baseCommit', 'branchName', 'candidateId', 'controlRequest', 'createdAt', 'finishedAt', 'parentRunId', 'phase', 'planRevisionId',
        'revisionId', 'runId', 'runKind', 'startedAt', 'status', 'ticketId', 'updatedAt', 'waitDetail', 'waitReason',
      ]);
      const replay = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId, expectedVersion: ticket.version });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).run.runId, submitted.run.runId);
      const again = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId: cmd(), expectedVersion: submitted.ticket.version });
      assert.equal(again.status, 409);
      assert.equal((await again.json()).error.code, 'invalid_state');
      assert.equal((await api.ticket(ticket.ticketId)).runs.length, 1);

      // Intake asks a question: waiting_human / needs_attention with an answer action.
      const waiting = await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.activeRun && d.activeRun.phase === 'awaiting_answer');
      assert.ok(waiting.availableActions.includes('answer'));
      assert.ok(!waiting.availableActions.includes('submit'));
      assert.equal(waiting.activeRun.runId, submitted.run.runId);
      const card = await api.card(ticket.ticketId);
      assert.equal(card.boardColumn, 'needs_attention');
      assert.equal(card.ticketStatus, 'waiting_human');
      assert.equal(card.phase, 'awaiting_answer');
      assert.equal(card.waitReason, 'human_decision');
      const runView = await api.json(`/runs/${submitted.run.runId}`);
      assert.deepEqual(Object.keys(runView).sort(), ['candidate', 'decisions', 'intake', 'leadTaskCardId', 'plan', 'run', 'settings', 'stages']);
      assert.equal(runView.intake[0].readiness, 'needs_input');
      assert.deepEqual(Object.keys(runView.intake[0]).sort(), [
        'classification', 'createdAt', 'errors', 'questions', 'readiness', 'requirements', 'turn', 'unsupportedReason', 'valid',
      ]);
      const [intakeDecision] = runView.decisions;
      assert.deepEqual(Object.keys(intakeDecision).sort(), ['answer', 'answeredAt', 'createdAt', 'decisionId', 'kind', 'request', 'state']);
      assert.equal(intakeDecision.kind, 'intake_clarification');
      assert.equal(intakeDecision.state, 'pending');
      const answerPath = `/tickets/${ticket.ticketId}/decisions/${intakeDecision.decisionId}/answer`;

      // Bodies are validated: every pending question, 1..4000 chars.
      const bad = [
        { answers: [] },
        { answers: [{ questionId: 'q1', answer: '' }] },
        { answers: [{ questionId: 'q1', answer: 'x'.repeat(4001) }] },
        { answers: [{ questionId: 'nope', answer: 'x' }] },
        { answer: 'x', choice: 'a' },
      ];
      for (const extra of bad) {
        const res = await api.post(answerPath, { commandId: cmd(), expectedVersion: waiting.ticket.version, ...extra });
        assert.equal(res.status, 400, JSON.stringify(extra).slice(0, 60));
        assert.equal((await res.json()).error.code, 'invalid_request');
      }
      const answerBody = { commandId: cmd(), expectedVersion: waiting.ticket.version, answers: [{ questionId: 'q1', answer: 'Use the blue one' }] };
      const answered = await api.post(answerPath, answerBody);
      assert.equal(answered.status, 201);
      const answeredBody = await answered.json();
      assert.equal(answeredBody.decision.state, 'answered');
      assert.equal(answeredBody.ticket.status, 'in_progress');
      assert.equal((await api.post(answerPath, answerBody)).status, 200);
      const stale = await api.post(answerPath, {
        commandId: cmd(), expectedVersion: answeredBody.ticket.version, answers: [{ questionId: 'q1', answer: 'again' }],
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error.code, 'stale_decision');

      // The lead pauses for a human decision.
      const leadWait = await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.activeRun && d.activeRun.phase === 'engineering'
        && d.availableActions.includes('answer'));
      assert.equal(appServer.intakeCalls.length, 2);
      assert.match(appServer.intakeCalls[1].input, /Use the blue one/);
      const leadView = await api.json(`/runs/${submitted.run.runId}`);
      const pending = leadView.decisions.find((d) => d.kind === 'lead_decision' && d.state === 'pending');
      assert.deepEqual(Object.keys(pending.request).sort(), ['options', 'question', 'reason', 'recommendation']);
      assert.equal(leadView.plan.classification, 'feature');
      assert.deepEqual(Object.keys(leadView.plan).sort(), [
        'checks', 'classification', 'createdAt', 'planRevisionId', 'requirements', 'stages', 'validatorVersion',
      ]);
      assert.deepEqual(Object.keys(leadView.plan.stages[0]).sort(), ['allowedFiles', 'dependencies', 'objective', 'required', 'roleId', 'stageId']);
      assert.deepEqual(Object.keys(leadView.plan.checks[0]).sort(), ['argv', 'description', 'id', 'timeoutMs']);
      assert.deepEqual(leadView.stages.map((s) => s.stageId), ['explore', 'build', 'verify', 'audit']);
      for (const stage of leadView.stages) assert.deepEqual(Object.keys(stage).sort(), ['attempts', 'required', 'roleId', 'stageId', 'status']);
      assert.equal(leadView.candidate, null);
      assert.ok(leadView.leadTaskCardId.startsWith('lr_'));
      const leadPath = `/tickets/${ticket.ticketId}/decisions/${pending.decisionId}/answer`;
      for (const extra of [{ choice: 'zzz', answer: 'x' }, { choice: 'a', answer: '' }, { choice: 'a' }]) {
        const res = await api.post(leadPath, { commandId: cmd(), expectedVersion: leadWait.ticket.version, ...extra });
        assert.equal(res.status, 400, JSON.stringify(extra));
      }
      const leadAnswered = await api.post(leadPath, { commandId: cmd(), expectedVersion: leadWait.ticket.version, choice: 'a', answer: 'Go with A' });
      assert.equal(leadAnswered.status, 201);

      // Delivery completes: waiting for human review with an accepted candidate.
      const done = await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.runs[0].phase === 'settled');
      assert.equal(done.runs[0].status, 'completed');
      assert.equal(done.activeRun, null);
      assert.deepEqual(done.availableActions, ['revise', 'cancel', 'return_to_backlog', 'accept', 'corrections']);
      const finalCard = await api.card(ticket.ticketId);
      assert.equal(finalCard.boardColumn, 'needs_attention');
      assert.equal(finalCard.ticketStatus, 'waiting_human');
      assert.equal(finalCard.waitReason, 'human_review');
      assert.equal(finalCard.phase, null);
      assert.equal(finalCard.classification, 'feature');
      assert.equal(finalCard.disposition, 'accepted');

      const view = await api.json(`/runs/${submitted.run.runId}`);
      assert.deepEqual(view.stages.map((s) => [s.stageId, s.status]), [['explore', 'succeeded'], ['build', 'succeeded'], ['verify', 'succeeded'], ['audit', 'succeeded']]);
      assert.deepEqual(Object.keys(view.stages[1].attempts[0]).sort(), ['attemptId', 'journalState', 'outcome', 'role']);
      assert.deepEqual(Object.keys(view.candidate).sort(), [
        'acceptance', 'baseCommit', 'branch', 'candidateId', 'createdAt', 'diffArtifactId', 'head', 'headMoved', 'integrityHash', 'manifest', 'truncated',
      ]);
      assert.deepEqual(Object.keys(view.candidate.acceptance).sort(), ['checks', 'disposition', 'reasons']);
      assert.deepEqual(Object.keys(view.candidate.acceptance.checks[0]).sort(), ['durationMs', 'exitCode', 'id', 'outputTail', 'timedOut']);
      assert.deepEqual(view.candidate.manifest.map((m) => [m.path, m.status]), [['src/greet.js', 'M']]);
      assert.equal(view.run.waitReason, 'human_review');
      assert.equal(view.settings.provider, 'openai');
      assert.equal((await api.get('/runs/run_nope')).status, 404);

      // Candidate diff: text only, sandboxed, nosniff.
      const diff = await api.get(`/runs/${submitted.run.runId}/candidate/diff`);
      assert.equal(diff.status, 200);
      assert.equal(diff.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(diff.headers.get('x-content-type-options'), 'nosniff');
      assert.match(diff.headers.get('content-security-policy'), /sandbox/);
      assert.equal(diff.headers.get('content-disposition'), 'inline');
      const diffText = await diff.text();
      assert.match(diffText, /src\/greet\.js/);
      assert.match(diffText, /farewell/);
      assert.equal((await api.get('/runs/run_nope/candidate/diff')).status, 404);

      // The linked lead task is not its own card but still resolves by id.
      const all = await api.json('/cards?limit=100');
      assert.ok(!all.cards.some((c) => c.cardKind === 'legacy_run'));
      assert.ok(all.cards.some((c) => c.cardId === ticket.ticketId));
      const leadCard = await api.json(`/cards/${view.leadTaskCardId}`);
      assert.equal(leadCard.card.cardKind, 'legacy_run');
      assert.equal(runtime.productStore.getRun(submitted.run.runId).leadTaskId !== null, true);
    });
  });

  await suite.test('a rejected candidate shows its disposition on a blocked card and the ticket can be submitted again', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: [...happyLeadScript(), decision({ final: 'The check still fails.' })],
      workerImpl: builderWorker(workspace, BROKEN_SOURCE),
    }), async ({ api }) => {
      const ticket = await api.create();
      await api.submit(ticket);
      const blocked = await api.waitTicket(ticket.ticketId, 'blocked', (d) => d.runs[0].phase === 'settled');
      assert.equal(blocked.runs[0].waitDetail.disposition, 'rejected');
      assert.deepEqual(blocked.availableActions, ['revise', 'submit', 'cancel', 'return_to_backlog']);
      const card = await api.card(ticket.ticketId);
      assert.equal(card.boardColumn, 'needs_attention');
      assert.equal(card.ticketStatus, 'blocked');
      assert.equal(card.disposition, 'rejected');
      assert.equal(card.waitReason, 'execution_error');
      assert.equal(card.phase, null);
      const view = await api.json(`/runs/${blocked.runs[0].runId}`);
      assert.equal(view.candidate.acceptance.disposition, 'rejected');
    });
  });

  await suite.test('cancelling a waiting_human ticket releases the lease and the next pending ticket proceeds', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES }), readyIntake({ stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, api, appServer }) => {
      const first = await api.create({ title: 'First change' });
      await api.submit(first);
      const reviewing = await api.waitTicket(first.ticketId, 'waiting_human', (d) => d.runs[0].phase === 'settled');
      const second = await api.create({ title: 'Second change' });
      await api.submit(second);
      await until(async () => {
        const card = await api.card(second.ticketId);
        return card.ticketStatus === 'pending' && card.waitReason === 'dependency';
      }, 'second ticket to wait on the lease');
      assert.match((await api.card(second.ticketId)).waitMessage, new RegExp(`Repository in use by ${first.ticketId}`));
      assert.equal(runtime.productStore.getLease().ticketId, first.ticketId);
      assert.equal(appServer.intakeCalls.length, 1);

      const res = await api.post(`/tickets/${first.ticketId}/cancel`, { commandId: cmd(), expectedVersion: reviewing.ticket.version });
      assert.equal(res.status, 201);
      assert.equal((await res.json()).ticket.status, 'cancelled');
      const cancelledCard = await api.card(first.ticketId);
      assert.equal(cancelledCard.boardColumn, 'closed');
      assert.equal(cancelledCard.ticketStatus, 'cancelled');
      assert.equal(cancelledCard.waitReason, null);

      await api.waitTicket(second.ticketId, 'blocked', (d) => d.runs[0].phase === 'settled');
      assert.equal(appServer.intakeCalls.length, 2);
      // The second run failed preflight before any branch, so it holds no lease.
      assert.equal(runtime.productStore.getLease(), null);
    });
  });

  await suite.test('cancelling a ticket whose lead is paused ends the lead task so a CLI resume runs nothing', async () => {
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ stages: STAGES })],
      leadScript: [humanDecision(), ...happyLeadScript()],
      workerImpl: builderWorker(workspace),
    }), async ({ runtime, api, appServer, client, requestOptions }) => {
      const ticket = await api.create();
      await api.submit(ticket);
      const waiting = await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.availableActions.includes('answer'));
      const run = runtime.productStore.getRun(waiting.activeRun.runId);
      assert.ok(run.leadTaskId);
      const leadCallsBefore = appServer.leadCalls.length;

      const res = await api.post(`/tickets/${ticket.ticketId}/cancel`, { commandId: cmd(), expectedVersion: waiting.ticket.version });
      assert.equal(res.status, 201);
      // Active work: the cancel is a request that the delivery controller settles on a tick.
      assert.equal((await res.json()).outcome, 'requested');
      await api.waitTicket(ticket.ticketId, 'cancelled');
      await until(() => runtime.productStore.getRun(run.runId).status === 'cancelled', 'run to be cancelled');
      assert.equal(runtime.productStore.getRun(run.runId).status, 'cancelled');
      assert.equal(runtime.productStore.getLease(), null);
      const task = await client.getTask({ tenant: '', id: run.leadTaskId }, requestOptions);
      assert.equal(task.status.state, TaskState.TASK_STATE_CANCELED);

      // CLI-style resume message to the canceled lead task: nothing runs and the task stays canceled.
      await client.sendMessage({
        tenant: '',
        message: {
          messageId: `cli-${Date.now()}`,
          contextId: task.contextId,
          taskId: run.leadTaskId,
          role: 1,
          parts: [{ content: { $case: 'text', value: 'resume anyway' }, mediaType: 'text/plain', filename: '', metadata: undefined }],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
        metadata: undefined,
      }, requestOptions).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await client.getTask({ tenant: '', id: run.leadTaskId }, requestOptions);
      assert.equal(after.status.state, TaskState.TASK_STATE_CANCELED);
      assert.equal(appServer.leadCalls.length, leadCallsBefore);
      assert.equal((await api.ticket(ticket.ticketId)).ticket.status, 'cancelled');
    });
  });

  await suite.test('commands need an Origin and a session', async () => {
    await withStack(() => makeFakeAppServer({ intakeScript: [readyIntake({ stages: STAGES })] }), async ({ api }) => {
      const ticket = await api.create();
      const body = { commandId: cmd(), expectedVersion: ticket.version };
      const noOrigin = await api.post(`/tickets/${ticket.ticketId}/submit`, body, { withOrigin: false });
      assert.equal(noOrigin.status, 403);
      const noSession = await api.post(`/tickets/${ticket.ticketId}/submit`, body, { cookie: null });
      assert.equal(noSession.status, 401);
      const noOriginCancel = await api.post(`/tickets/${ticket.ticketId}/cancel`, body, { withOrigin: false });
      assert.equal(noOriginCancel.status, 403);
      const noOriginAnswer = await api.post(`/tickets/${ticket.ticketId}/decisions/dec_x/answer`, { ...body, answer: 'x' }, { withOrigin: false });
      assert.equal(noOriginAnswer.status, 403);
      assert.equal((await api.get('/runs/run_x', { cookie: null })).status, 401);
      assert.equal((await api.get('/runs/run_x/candidate/diff', { cookie: null })).status, 401);
      assert.equal((await api.ticket(ticket.ticketId)).ticket.status, 'backlog');
    });
  });
});
