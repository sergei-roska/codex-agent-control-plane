'use strict';

// End-to-end for parallel writers: real startServer (worktree mode), real LeadOrchestrator and
// specialists, real lanes and integration over a real repository. Only the Codex App Server is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { DECISION_SCHEMA } = require('../src/contracts');
const { sh, write, probeExec } = require('./helpers/lane-fixtures');

process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));

const decision = (fields) => ({ action: 'finish', assignments: [], final: '', resolutions: [], humanInput: null, ...fields });
const parallelReview = {
  kind: 'routine',
  checkpointId: 'parallel-writers-e2e',
  reason: 'Verify both integrated source updates',
  paths: ['src/a.txt', 'src/b.txt'],
  evidenceIds: ['src/a.txt', 'src/b.txt'],
};
const assignment = (role, allowedFiles, wave) => ({
  role,
  objective: `Do the ${role} work`,
  allowedFiles,
  inputs: ['goal text'],
  evidence: ['none yet'],
  acceptanceCriteria: ['done'],
  checks: ['none'],
  stopConditions: ['blocked'],
  wave,
  review: parallelReview,
});
const report = (summary, filesChanged, evidence = {}) => JSON.stringify({
  outcome: 'completed', summary, filesChanged, filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null, ...evidence,
});
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

async function canBind() {
  const net = require('node:net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// writers[roleId]({ cwd, barrier }) returns the report text. `barrier()` resolves once two writers started.
function makeFakeAppServer({ leadScript, writers }) {
  const queue = [...leadScript];
  const probe = probeExec();
  let startedCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = {
    leadInputs: [],
    calls: [],
    maxConcurrent: 0,
    running: 0,
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async close() {},
    async readRateLimits() { return null; },
    getVersion: () => 'v-e2e',
    execCommand: probe.execCommand,
    async run({ role, cwd, input, outputSchema, sandboxPolicy, threadId }) {
      if (role?.name === 'orch-lead' || outputSchema === DECISION_SCHEMA) {
        fake.leadInputs.push(input);
        const next = queue.shift();
        if (!next) throw new Error('lead script exhausted');
        return { threadId: threadId || 'lead-thread', status: 'completed', text: JSON.stringify(next) };
      }
      fake.calls.push({ role: role.id, cwd, sandboxPolicy, input });
      fake.running += 1;
      fake.maxConcurrent = Math.max(fake.maxConcurrent, fake.running);
      try {
        const barrier = async () => {
          startedCount += 1;
          if (startedCount >= 2) release();
          await Promise.race([gate, new Promise((_, reject) => setTimeout(() => reject(new Error('barrier timeout')), 5000))]);
        };
        const text = await writers[role.id]({ cwd, barrier });
        return { threadId: `w-${fake.calls.length}`, turnId: 'u', status: 'completed', text };
      } finally {
        fake.running -= 1;
      }
    },
  };
  return fake;
}

function makeWorkspace(root) {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  sh(workspace, 'init', '-q');
  write(workspace, 'README.md', 'readme\n');
  write(workspace, 'src/a.txt', 'a0\n');
  write(workspace, 'src/b.txt', 'b0\n');
  write(workspace, 'tests/check.txt', 'c0\n');
  sh(workspace, 'add', '.');
  sh(workspace, 'commit', '-q', '-m', 'init');
  write(workspace, 'README.md', 'readme\nuncommitted\n'); // lanes must start from the working tree, not HEAD
  return workspace;
}

function repoState(workspace) {
  return {
    head: sh(workspace, 'rev-parse', 'HEAD'),
    refs: sh(workspace, 'for-each-ref'),
    index: fs.readFileSync(path.join(workspace, '.git', 'index')),
  };
}

let seq = 0;
async function withRun({ leadScript, writers }, fn) {
  // Under the home directory, not /tmp: the lane sandbox treats /tmp as writable.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), 'pw-e2e-')));
  const prior = process.env.CODEX_A2A_WRITER_ISOLATION;
  process.env.CODEX_A2A_WRITER_ISOLATION = 'worktree';
  let runtime = null;
  try {
    const workspace = makeWorkspace(root);
    const before = repoState(workspace);
    const appServer = makeFakeAppServer({ leadScript, writers });
    const tokenFile = path.join(root, 'token', 'a2a-token');
    runtime = await startServer({
      port: 0,
      workspace,
      appServer,
      stateFile: path.join(root, 'state.sqlite'),
      tokenFile,
      orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
    });
    assert.equal(runtime.writerIsolation.mode, 'worktree');
    const client = await new ClientFactory().createFromUrl(`http://${runtime.host}:${runtime.port}`, '/orchestrator/agent-card.json');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    seq += 1;
    const task = await client.sendMessage({
      tenant: '',
      message: {
        messageId: `pw-e2e-${process.pid}-${seq}`, contextId: '', taskId: '', role: 1, metadata: undefined, extensions: [], referenceTaskIds: [],
        parts: [{ content: { $case: 'text', value: 'Build a, b and check' }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
      metadata: undefined,
    }, { serviceParameters: { Authorization: `Bearer ${token}` } });
    await fn({ task, workspace, before, appServer, db: runtime.state.db });
  } finally {
    if (runtime) await runtime.close();
    if (prior === undefined) delete process.env.CODEX_A2A_WRITER_ISOLATION;
    else process.env.CODEX_A2A_WRITER_ISOLATION = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const script = () => [
  decision({
    action: 'dispatch',
    assignments: [
      assignment('orch-builder', ['src/a.txt'], 1),
      assignment('orch-builder', ['src/b.txt'], 1),
      assignment('orch-verifier', ['tests/check.txt'], null),
    ],
  }),
  decision({ final: 'All integrated.' }),
];

test('parallel writers e2e', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('two engineers run concurrently in lanes, integrate, and the verifier sees both', async () => {
    let n = 0;
    let verifierView = null;
    const writers = {
      // Both engineers share one role id; the barrier needs both of them to have started.
      engineer: async ({ cwd, barrier }) => {
        n += 1;
        const [file, content] = n === 1 ? ['src/a.txt', 'a1\n'] : ['src/b.txt', 'b1\n'];
        assert.equal(read(cwd, 'README.md'), 'readme\nuncommitted\n');
        await barrier();
        fs.writeFileSync(path.join(cwd, file), content);
        return report(`wrote ${file}`, [file]);
      },
      verifier: async ({ cwd }) => {
        verifierView = { a: read(cwd, 'src/a.txt'), b: read(cwd, 'src/b.txt'), readme: read(cwd, 'README.md') };
        fs.writeFileSync(path.join(cwd, 'tests/check.txt'), 'c1\n');
        return report('checked', ['tests/check.txt'], {
          filesInspected: ['src/a.txt', 'src/b.txt'],
          checks: [{ command: 'verify integrated source contents', result: 'passed', detail: 'Read both declared source paths after integration.' }],
        });
      },
    };
    await withRun({ leadScript: script(), writers }, async ({ task, workspace, before, appServer, db }) => {
      assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
      const builders = appServer.calls.filter((c) => c.role === 'engineer');
      assert.equal(builders.length, 2);
      assert.equal(appServer.maxConcurrent, 2);
      assert.notEqual(builders[0].cwd, builders[1].cwd);
      for (const call of builders) {
        assert.notEqual(call.cwd, workspace);
        assert.ok(!call.cwd.startsWith(`${workspace}${path.sep}`));
        assert.deepEqual(call.sandboxPolicy.writableRoots, [call.cwd]);
      }
      assert.deepEqual(verifierView, { a: 'a1\n', b: 'b1\n', readme: 'readme\nuncommitted\n' });
      assert.equal(read(workspace, 'src/a.txt'), 'a1\n');
      assert.equal(read(workspace, 'src/b.txt'), 'b1\n');
      assert.equal(read(workspace, 'tests/check.txt'), 'c1\n');
      assert.equal(read(workspace, 'README.md'), 'readme\nuncommitted\n');
      const after = repoState(workspace);
      assert.equal(after.head, before.head);
      assert.equal(after.refs, before.refs);
      const indexMatches = after.index.equals(before.index);
      assert.ok(indexMatches, indexMatches ? undefined : `Git index changed: status=${sh(workspace, 'status', '--short').trim() || '(clean)'}; staged=${sh(workspace, 'diff', '--cached', '--name-status').trim() || '(none)'}`);
      assert.deepEqual(db.prepare('SELECT state FROM writer_executions').all().map((row) => row.state), ['released', 'released', 'released']);
      const lanes = db.prepare('SELECT state, path FROM writer_lanes').all();
      assert.equal(lanes.length, 3);
      for (const lane of lanes) {
        assert.equal(lane.state, 'integrated');
        assert.equal(fs.existsSync(lane.path), false);
      }
    });
  });

  await suite.test('an engineer writing outside allowedFiles is refused; the others integrate and the verifier still runs', async () => {
    let n = 0;
    const writers = {
      engineer: async ({ cwd, barrier }) => {
        n += 1;
        const mine = n;
        await barrier();
        if (mine === 1) {
          fs.writeFileSync(path.join(cwd, 'src/a.txt'), 'a1\n');
          return report('wrote a', ['src/a.txt']);
        }
        fs.writeFileSync(path.join(cwd, 'src/b.txt'), 'b1\n');
        fs.writeFileSync(path.join(cwd, 'src/outside.txt'), 'x\n');
        return report('wrote b', ['src/b.txt']);
      },
      verifier: async ({ cwd }) => {
        const inspected = { a: read(cwd, 'src/a.txt'), b: read(cwd, 'src/b.txt') };
        assert.equal(inspected.a, 'a1\n');
        assert.equal(inspected.b, 'b0\n');
        fs.writeFileSync(path.join(cwd, 'tests/check.txt'), 'c1\n');
        return report('checked', ['tests/check.txt'], {
          filesInspected: ['src/a.txt', 'src/b.txt'],
          checks: [{ command: 'verify integrated source contents', result: 'passed', detail: 'Read both declared source paths after integration.' }],
        });
      },
    };
    await withRun({ leadScript: script(), writers }, async ({ task, workspace, appServer, db }) => {
      assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(appServer.calls.filter((c) => c.role === 'verifier').length, 1);
      assert.equal(read(workspace, 'src/a.txt'), 'a1\n');
      assert.equal(read(workspace, 'src/b.txt'), 'b0\n');
      assert.equal(fs.existsSync(path.join(workspace, 'src/outside.txt')), false);
      assert.equal(read(workspace, 'tests/check.txt'), 'c1\n');
      const lanes = db.prepare('SELECT state, reason FROM writer_lanes').all();
      assert.deepEqual(lanes.map((row) => row.state).sort(), ['integrated', 'integrated', 'not_integrated']);
      assert.ok(lanes.some((row) => row.reason === 'lane_scope_refused'));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writer_executions WHERE state = 'released'").get().n, 2);
      assert.equal(appServer.leadInputs.length, 2);
      assert.match(appServer.leadInputs[1], /lane_scope_refused/);
      assert.match(appServer.leadInputs[1], /src\/outside\.txt/);
    });
  });
});
