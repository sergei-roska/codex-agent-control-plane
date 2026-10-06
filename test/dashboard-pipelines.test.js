'use strict';

// M4 read API for roles, presets and pipelines over a real startServer on a temp workspace; only the Codex app server is faked.

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
const { INTAKE_SCHEMA_V2 } = require('../src/intake');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const {
  decision, assignment, humanDecision, workerReport, makeFakeAppServer, planStage, readyIntake, needsInputIntake, planStageV2, readyIntakeV2,
} = require('./fixtures/fake-app-server');

process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));
// The approved check runs `node --test`; inherited runner context would make it skip the file and exit 0.
delete process.env.NODE_TEST_CONTEXT;

const CHECK = { id: 'unit', argv: ['node', '--test', 'test/tiny.test.js'], timeoutMs: 60000, description: 'Tiny unit test' };
const GOOD_SOURCE = "module.exports = () => 'hello';\nmodule.exports.farewell = () => 'bye';\n";

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
async function withStack(appServerFactory, fn, { rolePack, projectExtra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-dash-delivery-'));
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ baseRef: 'main', checks: [CHECK], ...(rolePack ? { rolePack } : {}), ...projectExtra }));
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


test('dashboard pipelines api', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('roles, presets and pipelines shapes on an empty project', async () => {
    await withStack(() => makeFakeAppServer(), async ({ api }) => {
      const roles = await api.json('/roles');
      assert.equal(roles.activePack.packId, 'delivery');
      assert.match(roles.activePack.version, /^\d+\.\d+\.\d+$/);
      const shape = [
        'activeAttempts', 'displayName', 'effort', 'kind', 'model', 'pack', 'publicId', 'runtimeId', 'sandbox', 'serviceTier', 'settingsSource',
      ];
      for (const role of roles.roles) assert.deepEqual(Object.keys(role).sort(), shape);
      const delivery = roles.roles.filter((role) => role.pack === 'delivery');
      assert.equal(delivery[0].kind, 'coordinator');
      assert.equal(delivery[0].publicId, 'project-manager');
      assert.equal(delivery[0].runtimeId, 'dlv-project-manager');
      assert.deepEqual(delivery.filter((role) => role.publicId).map((role) => role.publicId), [
        'project-manager', 'architect', 'developer', 'qa', 'reviewer', 'security', 'performance', 'devops', 'tech-writer',
      ]);
      const developer = delivery.find((role) => role.publicId === 'developer');
      assert.deepEqual(
        { kind: developer.kind, sandbox: developer.sandbox, model: developer.model, effort: developer.effort, serviceTier: developer.serviceTier, source: developer.settingsSource },
        { kind: 'specialist', sandbox: 'workspace-write', model: 'gpt-6-luna', effort: 'high', serviceTier: null, source: 'profile' },
      );
      assert.deepEqual(delivery.filter((role) => role.kind === 'repair').map((role) => [role.publicId, role.runtimeId]), [
        [null, 'dlv-developer-xhigh'], [null, 'dlv-developer-sol'],
      ]);
      assert.ok(roles.roles.every((role) => role.activeAttempts === 0));
      const legacy = roles.roles.filter((role) => role.pack === 'legacy-orch');
      assert.ok(legacy.length >= 5);
      assert.ok(legacy.every((role) => role.kind === 'legacy' && role.publicId === null));
      assert.ok(legacy.some((role) => role.runtimeId === 'orch-lead'));
      assert.ok(legacy.some((role) => role.runtimeId === 'orch-builder'));

      const presets = await api.json('/presets');
      assert.deepEqual(presets.presets.map((preset) => preset.presetId), ['feature', 'bugfix', 'docs', 'audit']);
      for (const preset of presets.presets) {
        assert.equal(preset.available, true);
        assert.match(preset.version, /^\d+\.\d+\.\d+$/);
        assert.ok(Array.isArray(preset.stages) && preset.stages.length > 0);
        assert.ok(Array.isArray(preset.optionalRoles));
        assert.equal(typeof preset.minChecks, 'number');
      }
      assert.deepEqual(presets.unavailable.map((entry) => entry.presetId), ['security', 'performance', 'environment', 'debt']);
      assert.ok(presets.unavailable.every((entry) => typeof entry.reason === 'string' && entry.reason));

      assert.deepEqual(await api.json('/pipelines'), { runs: [] });
      for (const bad of ['limit=0', 'limit=101', 'limit=abc']) {
        const res = await api.get(`/pipelines?${bad}`);
        assert.equal(res.status, 400, bad);
      }
    });
  });

  await suite.test('a run with a saved plan lists its stages and live attempts', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await withStack((workspace) => makeFakeAppServer({
      intakeScript: [readyIntake({ classification: 'feature', stages: STAGES })],
      leadScript: happyLeadScript(),
      workerImpl: async (call) => {
        if (call.role === 'orch-builder') await gate;
        return builderWorker(workspace)(call);
      },
    }), async ({ api }) => {
      const ticket = await api.create();
      await api.submit(ticket);
      let live;
      await until(async () => {
        const { runs } = await api.json('/pipelines');
        live = runs.find((run) => run.ticketId === ticket.ticketId);
        return live && live.stages.some((stage) => stage.roleId === 'orch-builder' && stage.status === 'running');
      }, 'builder stage running');
      assert.deepEqual(Object.keys(live).sort(), [
        'phase', 'planRevisionId', 'presetId', 'presetVersion', 'rolePack', 'runId', 'stages', 'status', 'ticketId', 'title',
      ]);
      assert.equal(live.title, 'Add a farewell helper');
      assert.equal(live.status, 'running');
      assert.match(live.planRevisionId, /^plan_/);
      assert.deepEqual(live.stages.map((stage) => stage.stageId), ['explore', 'build', 'verify', 'audit']);
      const build = live.stages.find((stage) => stage.stageId === 'build');
      assert.deepEqual(Object.keys(build).sort(), ['attempts', 'publicRoleId', 'required', 'roleId', 'stageId', 'status']);
      assert.equal(build.required, true);
      assert.equal(live.stages.find((stage) => stage.stageId === 'explore').required, false);
      assert.equal(build.attempts.length, 1);
      assert.equal(build.attempts[0].repair, false);
      const roles = await api.json('/roles');
      assert.ok(roles.roles.find((role) => role.runtimeId === 'orch-builder').activeAttempts >= 1);

      release();
      await api.waitTicket(ticket.ticketId, 'waiting_human', (d) => d.runs[0].phase === 'settled');
      const { runs } = await api.json('/pipelines');
      const settled = runs.find((run) => run.ticketId === ticket.ticketId);
      assert.equal(settled.stages.length, 4);
      assert.ok(settled.stages.every((stage) => typeof stage.status === 'string'));
      assert.equal((await api.json('/roles')).roles.find((role) => role.runtimeId === 'orch-builder').activeAttempts, 0);
      assert.equal((await api.json('/pipelines?limit=1')).runs.length, 1);
    }, { rolePack: 'legacy-orch' });
  });

  await suite.test('run and ticket detail carry route; a lean run lists its skipped stage as skipped', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const intake = readyIntakeV2({
      classification: 'bugfix',
      stages: [
        planStageV2('repro', 'qa', 'reproduce', { allowedFiles: ['test/tiny.test.js'] }),
        planStageV2('impl', 'developer', 'implement', { dependencies: ['repro'], allowedFiles: ['src/greet.js'] }),
        planStageV2('rev', 'reviewer', 'review', { dependencies: ['impl'] }),
        planStageV2('ver', 'qa', 'verify', { dependencies: ['impl'], allowedFiles: ['test/tiny.test.js'] }),
      ],
    });
    intake.plan.route = 'lean';
    await withStack((workspace) => {
      const server = makeFakeAppServer({
        intakeScript: [intake],
        leadScript: [decision({ final: 'Delivered.' })],
        workerImpl: async (call) => {
          if (call.role.includes('developer')) await gate;
          return builderWorker(workspace)({ role: 'orch-builder', ...call });
        },
      });
      const run = server.run.bind(server);
      server.run = (args) => run(args.outputSchema && args.outputSchema.properties && args.outputSchema.properties.plan && args.outputSchema.properties.plan.properties
        && args.outputSchema.properties.plan.properties.presetId ? { ...args, outputSchema: INTAKE_SCHEMA_V2 } : args);
      return server;
    }, async ({ api }) => {
      const ticket = await api.create();
      await api.submit(ticket);
      let live;
      await until(async () => {
        const { runs } = await api.json('/pipelines');
        live = runs.find((entry) => entry.ticketId === ticket.ticketId);
        return live && live.stages.some((stage) => stage.stageId === 'impl' && stage.status === 'running');
      }, 'impl stage running');
      assert.equal(live.stages.find((stage) => stage.stageId === 'repro').status, 'skipped');
      const detail = await api.json(`/runs/${live.runId}`);
      assert.equal(detail.stages.find((stage) => stage.stageId === 'repro').status, 'skipped');
      assert.equal(detail.route.mode, 'on');
      assert.equal(detail.route.effective, 'lean');
      assert.equal(detail.route.promoted, false);
      assert.deepEqual((await api.ticket(ticket.ticketId)).route, detail.route);
      release();
    }, { rolePack: 'delivery', projectExtra: { adaptiveRoute: 'on' } });
  });
});
