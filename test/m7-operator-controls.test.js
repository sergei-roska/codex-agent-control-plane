'use strict';

// M7 operator controls over the real HTTP surface: a real startServer (lead graph, A2A, SQLite, delivery controller,
// Git delivery service) on a temp git workspace with a local bare remote named origin; only the Codex app server is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const {
  decision, assignment, workerReport, makeFakeAppServer, planStage, readyIntake,
} = require('./fixtures/fake-app-server');

process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));
// The approved check runs `node --test`; inherited runner context would make it skip the file and exit 0.
delete process.env.NODE_TEST_CONTEXT;

const CHECK = { id: 'unit', argv: ['node', '--test', 'test/tiny.test.js'], timeoutMs: 60000, description: 'Tiny unit test' };
const SOURCE = (tag) => `module.exports = () => 'hello';\nmodule.exports.farewell = () => 'bye';\n// ${tag}\n`;

let seq = 0;
const cmd = () => `m7-${process.pid}-${String(++seq).padStart(5, '0')}`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeWorkspace(dir, remote) {
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
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git(dir, 'remote', 'add', 'origin', remote);
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

function leadRound() {
  return [
    decision({ action: 'dispatch', assignments: [assignment('orch-explorer', { stageId: 'explore' })] }),
    decision({ action: 'dispatch', assignments: [assignment('orch-builder', { stageId: 'build', allowedFiles: ['src/greet.js'] })] }),
    decision({ action: 'dispatch', assignments: [assignment('orch-verifier', { stageId: 'verify', allowedFiles: ['test/tiny.test.js'] })] }),
    decision({ action: 'dispatch', assignments: [assignment('orch-auditor', { stageId: 'audit' })] }),
    decision({ final: 'Delivered.' }),
  ];
}

// The builder writes a new source per call. With `gate`, it blocks after writing until released or aborted.
function makeWorker(workspace, gate = null) {
  let builds = 0;
  return async ({ role, signal }) => {
    if (role === 'orch-builder') {
      builds += 1;
      fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), SOURCE(`build ${builds}`));
      if (gate) {
        await new Promise((resolve) => {
          gate.reached = true;
          gate.release = resolve;
          if (signal) signal.addEventListener('abort', resolve, { once: true });
        });
      }
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('built'), filesChanged: ['src/greet.js'] }) };
    }
    return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
  };
}

async function withStack({ leadScript, intakeCount = 1, gate = null }, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-m7-'));
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ baseRef: 'main', checks: [CHECK], rolePack: 'legacy-orch' }));
  const workspace = path.join(root, 'workspace');
  const remote = path.join(root, 'remote.git');
  makeWorkspace(workspace, remote);
  const appServer = makeFakeAppServer({
    intakeScript: Array.from({ length: intakeCount }, () => readyIntake({ stages: STAGES })),
    leadScript,
    workerImpl: makeWorker(workspace, gate),
  });
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
    const bearer = `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}`;
    const { code } = await (await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } })).json();
    const exchange = await fetch(`${base}/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }),
    });
    assert.equal(exchange.status, 204);
    const api = { origin, base, cookie: exchange.headers.get('set-cookie').split(';')[0] };
    api.get = (p, { cookie = api.cookie } = {}) => fetch(`${base}${p}`, { headers: cookie ? { Cookie: cookie } : {} });
    api.json = async (p) => {
      const res = await api.get(p);
      assert.equal(res.status, 200, p);
      return res.json();
    };
    api.post = async (p, body, { cookie = api.cookie, withOrigin = true } = {}) => {
      const res = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(withOrigin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    api.ticket = (id) => api.json(`/tickets/${id}`);
    // Posts a ticket command with the ticket's current version.
    api.command = async (ticketId, segment, extra = {}) => {
      const { ticket } = await api.ticket(ticketId);
      return api.post(`/tickets/${ticketId}/${segment}`, { commandId: cmd(), expectedVersion: ticket.version, ...extra });
    };
    api.create = async () => {
      const res = await api.post('/tickets', {
        commandId: cmd(), title: 'Add a farewell helper', description: 'Add farewell() next to greet()', criteria: ['farewell() returns bye'],
      });
      assert.equal(res.status, 201);
      return res.body.ticket;
    };
    api.submit = async (ticket) => {
      const res = await api.post(`/tickets/${ticket.ticketId}/submit`, { commandId: cmd(), expectedVersion: ticket.version });
      assert.equal(res.status, 201);
      return res.body;
    };
    api.card = async (ticketId) => (await api.json('/cards?limit=100')).cards.find((c) => c.cardId === ticketId);
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
    // Create, submit and wait until the candidate waits for review; returns the evidence the review binds to.
    api.toReview = async () => {
      const ticket = await api.create();
      await api.submit(ticket);
      const detail = await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.runs[0].phase === 'settled' && d.runs[0].status === 'completed');
      const run = detail.runs[0];
      const { candidate } = await api.json(`/runs/${run.runId}`);
      return { ticketId: ticket.ticketId, run, candidate };
    };
    api.review = (ticketId, run, candidate, extra = {}) => api.command(ticketId, 'review', {
      runId: run.runId, candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, verdict: 'accept', ...extra,
    });
    api.eventTypes = async (ticketId) => (await api.json(`/tickets/${ticketId}/events?limit=500`)).events.map((e) => e.type);
    await fn({ runtime, api, workspace, remote, gate });
  } finally {
    if (runtime) await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('m7 operator controls over HTTP', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('availableActions follow the ticket state', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api }) => {
      const ticket = await api.create();
      const backlog = await api.ticket(ticket.ticketId);
      assert.deepEqual(backlog.availableActions, ['revise', 'submit', 'cancel']);
      const names = backlog.unavailableActions.map((a) => a.action);
      assert.deepEqual(names, ['pause', 'resume', 'stop', 'return_to_backlog', 'accept', 'corrections', 'commit', 'push', 'release_repository']);
      assert.ok(backlog.unavailableActions.every((a) => typeof a.reason === 'string' && a.reason.length > 0 && !('milestone' in a)));
      assert.equal(backlog.stagedRevision, null);
      assert.equal(backlog.review, null);
      const card = await api.card(ticket.ticketId);
      assert.deepEqual(card.dragActions, ['submit']);
      assert.equal(card.controlRequest, null);

      await api.submit(ticket);
      const review = await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.runs[0].phase === 'settled');
      assert.deepEqual(review.availableActions, ['revise', 'cancel', 'return_to_backlog', 'accept', 'corrections']);
      const commit = review.unavailableActions.find((a) => a.action === 'commit');
      assert.match(commit.reason, /waiting_human/);
      assert.deepEqual((await api.card(ticket.ticketId)).dragActions, ['return_to_backlog']);
    });
  });

  await suite.test('pause requests, settles at a safe boundary, and resume continues the same run', async () => {
    const gate = {};
    await withStack({ leadScript: leadRound(), gate }, async ({ api, runtime }) => {
      const ticket = await api.create();
      const { run } = await api.submit(ticket);
      await until(() => gate.reached, 'builder to hold');
      const running = await api.ticket(ticket.ticketId);
      for (const name of ['pause', 'stop', 'cancel', 'return_to_backlog']) assert.ok(running.availableActions.includes(name), name);
      assert.ok(!running.availableActions.includes('resume'));

      const paused = await api.command(ticket.ticketId, 'pause', { runId: run.runId });
      assert.equal(paused.status, 201);
      assert.equal(paused.body.outcome, 'requested');
      assert.equal(paused.body.run.controlRequest, 'pause');
      const requested = await api.ticket(ticket.ticketId);
      assert.equal(requested.activeRun.controlRequest, 'pause');
      assert.ok(!requested.availableActions.includes('pause'));
      assert.equal((await api.card(ticket.ticketId)).controlRequest, 'pause');
      assert.equal(runtime.productStore.getRun(run.runId).status, 'running');

      // The held writer finishes; the lead then honours the request instead of dispatching more work.
      gate.release();
      const settled = await api.waitTicket(ticket.ticketId, 'paused', (d) => d.runs[0].status === 'paused');
      assert.equal(settled.runs[0].waitReason, 'operator_pause');
      assert.equal(settled.runs[0].controlRequest, null);
      assert.ok(settled.availableActions.includes('resume'));
      assert.ok(!settled.availableActions.includes('pause'));
      assert.equal((await api.card(ticket.ticketId)).boardColumn, 'needs_attention');

      const resumed = await api.command(ticket.ticketId, 'resume', { runId: run.runId });
      assert.equal(resumed.status, 201);
      const done = await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.runs[0].phase === 'settled');
      assert.equal(done.runs.length, 1);
      assert.equal(done.runs[0].runId, run.runId);
      assert.equal(done.runs[0].status, 'completed');
      const types = await api.eventTypes(ticket.ticketId);
      for (const type of ['control_requested', 'run_paused', 'run_resumed']) assert.ok(types.includes(type), type);
    });
  });

  await suite.test('stop settles the run as stopped and keeps the files', async () => {
    const gate = {};
    await withStack({ leadScript: leadRound(), gate }, async ({ api, workspace }) => {
      const ticket = await api.create();
      const { run } = await api.submit(ticket);
      await until(() => gate.reached, 'builder to hold');
      const live = (await api.ticket(ticket.ticketId)).ticket;
      const staleStop = await api.post(`/tickets/${ticket.ticketId}/stop`, { commandId: cmd(), expectedVersion: live.version - 1, runId: run.runId });
      assert.equal(staleStop.status, 409);
      assert.equal(staleStop.body.error.code, 'stale_version');
      assert.equal((await api.ticket(ticket.ticketId)).activeRun.controlRequest, null);
      const stopped = await api.command(ticket.ticketId, 'stop', { runId: run.runId });
      assert.equal(stopped.status, 201);
      assert.equal(stopped.body.outcome, 'requested');
      const settled = await api.waitTicket(ticket.ticketId, 'blocked', (d) => d.runs[0].status === 'stopped');
      assert.equal(settled.runs[0].waitReason, 'run_stopped');
      assert.equal(settled.runs[0].controlRequest, null);
      assert.equal((await api.card(ticket.ticketId)).displayStatus, 'Stopped');
      assert.equal(fs.readFileSync(path.join(workspace, 'src', 'greet.js'), 'utf8'), SOURCE('build 1'));
      assert.ok(settled.availableActions.includes('submit'));
      assert.ok((await api.eventTypes(ticket.ticketId)).includes('run_stopped'));
    });
  });

  await suite.test('return to backlog promotes a staged revision and the ticket can be submitted again', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api, runtime, workspace }) => {
      const first = await api.toReview();
      const staged = await api.command(first.ticketId, 'revisions', { title: 'Better title', description: 'Updated requirement' });
      assert.equal(staged.status, 201);
      assert.equal(staged.body.staged, true);
      const withStaged = await api.ticket(first.ticketId);
      assert.equal(withStaged.stagedRevision.title, 'Better title');
      assert.equal(withStaged.revision.ordinal, 1);
      assert.equal(withStaged.ticket.title, 'Add a farewell helper');

      const back = await api.command(first.ticketId, 'return-to-backlog');
      assert.equal(back.status, 201);
      const detail = await api.ticket(first.ticketId);
      assert.equal(detail.ticket.status, 'backlog');
      assert.equal(detail.stagedRevision, null);
      assert.equal(detail.revision.ordinal, 2);
      assert.equal(detail.ticket.title, 'Better title');
      assert.deepEqual(detail.availableActions, ['revise', 'submit', 'cancel']);
      assert.equal(runtime.productStore.getLease(), null);
      assert.equal(detail.runs[0].status, 'completed');
      assert.ok((await api.eventTypes(first.ticketId)).includes('ticket_returned_to_backlog'));
    });
  });

  await suite.test('accept is bound to the candidate; a wrong hash changes nothing', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api }) => {
      const { ticketId, run, candidate } = await api.toReview();
      const wrong = await api.review(ticketId, run, { ...candidate, integrityHash: 'f'.repeat(64) });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.error.code, 'candidate_changed');
      const unchanged = await api.ticket(ticketId);
      assert.equal(unchanged.ticket.status, 'waiting_human');
      assert.equal(unchanged.review, null);

      const accepted = await api.review(ticketId, run, candidate);
      assert.equal(accepted.status, 201);
      assert.equal(accepted.body.ticket.status, 'done');
      assert.deepEqual(Object.keys(accepted.body.review).sort(),
        ['candidateId', 'createdAt', 'findings', 'integrityHash', 'reviewId', 'runId', 'verdict']);
      assert.equal(accepted.body.review.verdict, 'accepted');
      const done = await api.ticket(ticketId);
      assert.equal(done.review.candidateId, candidate.candidateId);
      assert.deepEqual(done.availableActions, ['commit', 'release_repository']);
      assert.ok((await api.eventTypes(ticketId)).includes('review_recorded'));
    });
  });

  await suite.test('corrections start a rework run on the same revision', async () => {
    await withStack({ leadScript: [...leadRound(), ...leadRound()] }, async ({ api }) => {
      const { ticketId, run, candidate } = await api.toReview();
      const empty = await api.review(ticketId, run, candidate, { verdict: 'corrections' });
      assert.equal(empty.status, 400);
      const res = await api.review(ticketId, run, candidate, { verdict: 'corrections', findings: 'Please also add a docblock.' });
      assert.equal(res.status, 201);
      assert.equal(res.body.review.verdict, 'corrections');
      assert.equal(res.body.review.findings, 'Please also add a docblock.');
      assert.equal(res.body.run.runKind, 'rework');
      assert.equal(res.body.run.parentRunId, run.runId);
      assert.equal(res.body.run.revisionId, run.revisionId);
      const second = await api.waitTicket(ticketId, 'waiting_human', (d) => d.runs.length === 2 && d.runs[0].phase === 'settled');
      assert.equal(second.runs[0].runKind, 'rework');
      assert.equal(second.runs[0].status, 'completed');
      assert.notEqual(second.runs[0].candidateId, candidate.candidateId);
      assert.equal(second.review.verdict, 'corrections');
      const types = await api.eventTypes(ticketId);
      for (const type of ['review_recorded', 'rework_started']) assert.ok(types.includes(type), type);
    });
  });

  await suite.test('corrections refuse a checkout changed after candidate capture', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api, runtime, workspace }) => {
      const { ticketId, run, candidate } = await api.toReview();
      const file = path.join(workspace, 'src', 'greet.js');
      fs.appendFileSync(file, '// changed after candidate capture\n');
      const changed = fs.readFileSync(file, 'utf8');
      const before = await api.ticket(ticketId);
      const leaseBefore = runtime.productStore.getLease();

      const res = await api.review(ticketId, run, candidate, {
        verdict: 'corrections', findings: 'Please also add a docblock.',
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'candidate_changed');
      const after = await api.ticket(ticketId);
      assert.equal(after.ticket.status, 'waiting_human');
      assert.equal(after.ticket.version, before.ticket.version);
      assert.equal(after.review, null);
      assert.equal(after.runs.length, 1);
      assert.equal(after.runs[0].runId, run.runId);
      assert.deepEqual(runtime.productStore.getLease(), leaseBefore);
      assert.equal(fs.readFileSync(file, 'utf8'), changed, 'the changed checkout is retained');
    });
  });

  await suite.test('commit, replay and push deliver to the local bare remote', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api, workspace, remote }) => {
      const { ticketId, run, candidate } = await api.toReview();
      const body = { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Add farewell helper' };

      // Commit without an accepted review is refused.
      const early = await api.command(ticketId, 'commit', body);
      assert.equal(early.status, 409);
      assert.equal((await api.ticket(ticketId)).ticket.status, 'waiting_human');
      assert.equal(git(workspace, 'log', '--oneline', 'main').split('\n').length, 1);

      const delivery0 = await api.json(`/tickets/${ticketId}/delivery`);
      assert.equal(delivery0.candidate.candidateId, candidate.candidateId);
      assert.equal(delivery0.review, null);
      assert.equal(delivery0.commitPlan, null);
      assert.deepEqual(delivery0.deliveries, []);
      assert.deepEqual(delivery0.remotes.map((r) => r.name), ['origin']);

      assert.equal((await api.review(ticketId, run, candidate)).status, 201);
      const plan = (await api.json(`/tickets/${ticketId}/delivery`)).commitPlan;
      assert.deepEqual(Object.keys(plan).sort(), ['baseCommit', 'branch', 'files', 'head', 'manifestTruncated', 'remoteRef']);
      assert.equal(plan.files, 1);
      assert.equal(plan.manifestTruncated, false);
      assert.equal(plan.remoteRef, `refs/heads/${plan.branch}`);

      const wrongHash = await api.command(ticketId, 'commit', { ...body, integrityHash: 'e'.repeat(64) });
      assert.equal(wrongHash.status, 409);
      assert.equal(wrongHash.body.error.code, 'candidate_changed');

      const commandId = cmd();
      const { ticket } = await api.ticket(ticketId);
      const staleCommit = await api.post(`/tickets/${ticketId}/commit`, { commandId: cmd(), expectedVersion: ticket.version - 1, ...body });
      assert.equal(staleCommit.status, 409);
      assert.equal(staleCommit.body.error.code, 'stale_version');
      assert.deepEqual((await api.json(`/tickets/${ticketId}/delivery`)).deliveries, []);
      const commit = await api.post(`/tickets/${ticketId}/commit`, { commandId, expectedVersion: ticket.version, ...body });
      assert.equal(commit.status, 201);
      assert.equal(commit.body.delivery.kind, 'commit');
      assert.equal(commit.body.delivery.state, 'succeeded');
      const sha = commit.body.delivery.commitSha;
      assert.match(sha, /^[0-9a-f]{40}$/);
      assert.equal(git(workspace, 'rev-parse', plan.branch), sha);
      assert.equal(git(workspace, 'rev-parse', `${sha}^`), plan.baseCommit);
      assert.match(git(workspace, 'log', '-1', '--format=%B', sha), new RegExp(`Delivery-Id: ${commit.body.delivery.deliveryId}`));
      const commitsBefore = git(workspace, 'rev-list', '--count', plan.branch);

      // The same command again returns the stored delivery and creates no second commit.
      const replay = await api.post(`/tickets/${ticketId}/commit`, { commandId, expectedVersion: ticket.version, ...body });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.delivery.deliveryId, commit.body.delivery.deliveryId);
      assert.equal(git(workspace, 'rev-list', '--count', plan.branch), commitsBefore);

      const committed = await api.ticket(ticketId);
      assert.ok(committed.availableActions.includes('push'));
      assert.ok(!committed.availableActions.includes('commit'));
      assert.ok(!committed.availableActions.includes('release_repository'));

      // A different sha or an unlisted remote is refused with no effect.
      const wrongSha = await api.command(ticketId, 'push', { deliveryId: commit.body.delivery.deliveryId, commitSha: 'a'.repeat(40), remote: 'origin' });
      assert.equal(wrongSha.status, 409);
      const badRemote = await api.command(ticketId, 'push', { deliveryId: commit.body.delivery.deliveryId, commitSha: sha, remote: 'elsewhere' });
      assert.equal(badRemote.status, 400);
      assert.equal(git(remote, 'for-each-ref', 'refs/heads'), '');

      const pushedTicket = (await api.ticket(ticketId)).ticket;
      const stalePush = await api.post(`/tickets/${ticketId}/push`, {
        commandId: cmd(), expectedVersion: pushedTicket.version - 1, deliveryId: commit.body.delivery.deliveryId, commitSha: sha, remote: 'origin',
      });
      assert.equal(stalePush.status, 409);
      assert.equal(stalePush.body.error.code, 'stale_version');
      assert.equal(git(remote, 'for-each-ref', 'refs/heads'), '');

      const push = await api.command(ticketId, 'push', { deliveryId: commit.body.delivery.deliveryId, commitSha: sha, remote: 'origin' });
      assert.equal(push.status, 201);
      assert.equal(push.body.delivery.kind, 'push');
      assert.equal(push.body.delivery.state, 'succeeded');
      assert.equal(push.body.delivery.parentDeliveryId, commit.body.delivery.deliveryId);
      assert.equal(push.body.delivery.remoteRef, `refs/heads/${plan.branch}`);
      assert.equal(git(remote, 'rev-parse', `refs/heads/${plan.branch}`), sha);

      // A second push of the same commit to the same remote is refused, not offered, and reaches no remote.
      const pushedDetail = await api.ticket(ticketId);
      assert.ok(!pushedDetail.availableActions.includes('push'));
      assert.deepEqual(pushedDetail.unavailableActions.find((x) => x.action === 'push'), { action: 'push', reason: 'This commit was already pushed' });
      const refsAfterPush = git(remote, 'for-each-ref', 'refs/heads');
      const second = await api.command(ticketId, 'push', { deliveryId: commit.body.delivery.deliveryId, commitSha: sha, remote: 'origin' });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, 'invalid_state');
      assert.equal(git(remote, 'for-each-ref', 'refs/heads'), refsAfterPush);

      const state = await api.json(`/tickets/${ticketId}/delivery`);
      assert.deepEqual(state.deliveries.map((d) => [d.kind, d.state]), [['commit', 'succeeded'], ['push', 'succeeded']]);
      assert.deepEqual(Object.keys(state.deliveries[0]).sort(), [
        'branch', 'commitSha', 'createdAt', 'deliveryId', 'error', 'kind', 'parentDeliveryId', 'remote', 'remoteRef', 'state', 'updatedAt',
      ]);
      const types = await api.eventTypes(ticketId);
      for (const type of ['review_recorded', 'delivery_commit_intended', 'delivery_commit_succeeded', 'delivery_push_intended', 'delivery_push_succeeded']) {
        assert.ok(types.includes(type), type);
      }
      assert.ok(!JSON.stringify(await api.json(`/tickets/${ticketId}/events?limit=500`)).includes(remote));
    });
  });

  await suite.test('a file changed after accept blocks the commit', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api, workspace }) => {
      const { ticketId, run, candidate } = await api.toReview();
      assert.equal((await api.review(ticketId, run, candidate)).status, 201);
      const head = git(workspace, 'rev-parse', 'HEAD');
      fs.appendFileSync(path.join(workspace, 'src', 'greet.js'), '// edited after accept\n');
      const res = await api.command(ticketId, 'commit', {
        candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Add farewell helper',
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'candidate_changed');
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), head);
      assert.equal(git(workspace, 'diff', '--cached', '--name-only'), '');
      const state = await api.json(`/tickets/${ticketId}/delivery`);
      assert.deepEqual(state.deliveries.map((d) => [d.kind, d.state]), [['commit', 'failed']]);
      assert.equal(state.deliveries[0].error.code, 'candidate_changed');
    });
  });

  await suite.test('release repository frees the lease and keeps the changes', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api, runtime, workspace }) => {
      const { ticketId, run, candidate } = await api.toReview();
      assert.equal((await api.review(ticketId, run, candidate)).status, 201);
      assert.equal(runtime.productStore.getLease().ticketId, ticketId);
      const released = await api.command(ticketId, 'release-repository');
      assert.equal(released.status, 201);
      assert.equal(runtime.productStore.getLease(), null);
      assert.equal(fs.readFileSync(path.join(workspace, 'src', 'greet.js'), 'utf8'), SOURCE('build 1'));
      const detail = await api.ticket(ticketId);
      assert.ok(!detail.availableActions.includes('commit'));
      assert.ok((await api.eventTypes(ticketId)).includes('repository_released'));
    });
  });

  await suite.test('operator commands need a session and an Origin', async () => {
    await withStack({ leadScript: leadRound() }, async ({ api }) => {
      const ticket = await api.create();
      const body = { commandId: cmd(), expectedVersion: ticket.version, runId: 'run_x' };
      for (const segment of ['pause', 'resume', 'stop', 'cancel', 'return-to-backlog', 'review', 'commit', 'push', 'release-repository']) {
        const noOrigin = await api.post(`/tickets/${ticket.ticketId}/${segment}`, body, { withOrigin: false });
        assert.equal(noOrigin.status, 403, segment);
        const noSession = await api.post(`/tickets/${ticket.ticketId}/${segment}`, body, { cookie: null });
        assert.equal(noSession.status, 401, segment);
      }
      const delivery = await api.get(`/tickets/${ticket.ticketId}/delivery`, { cookie: null });
      assert.equal(delivery.status, 401);
      assert.equal((await api.ticket(ticket.ticketId)).ticket.status, 'backlog');
    });
  });
});
