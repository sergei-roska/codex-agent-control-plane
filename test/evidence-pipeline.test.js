'use strict';

// Evidence pipeline end to end (PIP-04): producer -> storage -> lead projection -> bounded retrieval.
// Fake worker/lead/A2A world, real SQLite and a real acceptance runner; no model calls.
// The world and session helpers below are copied from lead-graph.test.js on purpose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { runAcceptance } = require('../src/acceptance');
const { createEvidenceStore, main, MAX_READ_BYTES, MAX_STORED_BYTES } = require('../src/evidence-store');
const { boundedOutcomes } = require('../src/lead-graph');
const { DispatchJournal, openStateDatabase } = require('../src/durable-store');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pipeline-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let dbCounter = 0;
const newDbPath = () => path.join(tmpRoot, `state-${dbCounter += 1}.sqlite`);
const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_ID = 'run-1';

const brief = (role, allowedFiles = ['src/example.js']) => ({
  role,
  objective: 'Complete a bounded task',
  allowedFiles,
  inputs: ['User goal'],
  evidence: ['Existing project files'],
  acceptanceCriteria: ['The result meets the stated goal'],
  checks: ['Review the changed files'],
  stopConditions: ['Stop if another file is required'],
});

const decision = (fields) => JSON.stringify({
  action: 'finish', assignments: [], final: '', resolutions: [], humanInput: null, ...fields,
});
const dispatch = (...assignments) => decision({ action: 'dispatch', assignments });
const finish = (final = 'All done', resolutions = []) => decision({ action: 'finish', final, resolutions });

const report = (summary, overrides = {}) => JSON.stringify({
  outcome: 'completed', summary, filesChanged: [], filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null, ...overrides,
});

const role = (name, sandbox) => ({ name, description: `${name} agent`, model: 'gpt-test', effort: 'high', sandbox, instructions: 'Test agent' });
const roles = () => new Map([
  ['orch-builder', role('orch-builder', 'workspace-write')],
  ['orch-explorer', role('orch-explorer', 'read-only')],
  ['orch-architect', role('orch-architect', 'read-only')],
]);

const textParts = (value) => [{ content: { $case: 'text', value } }];

const releasedWriter = (changedPaths = []) => ({
  executionId: 'exec-released', state: 'released', delta: { known: true, headChanged: false, changedPaths }, reason: null,
});


function makeFakeAdmission() {
  const admission = {
    rows: new Map(),
    fences: [],
    reconciles: [],
    canProve: true,
    fenceRace: null,
    acquired: [],
    released: [],
    turnStarts: [],
    async acquire(args) { this.acquired.push(args); return { executionId: `${args.role}:${args.taskId}` }; },
    release(executionId) { this.released.push(executionId); },
    recordTurnStart(executionId, details) { this.turnStarts.push({ executionId, ...details }); },
    findByContextId(contextId) { return this.rows.get(contextId) || null; },
    get(executionId) { return [...this.rows.values()].find((row) => row.executionId === executionId) || null; },
    fence(contextId, reason) {
      this.fences.push({ contextId, reason });
      if (this.fenceRace && !this.rows.has(contextId)) this.rows.set(contextId, this.fenceRace(contextId));
      return { execution: this.rows.get(contextId) || null };
    },
    async reconcile(executionId) {
      this.reconciles.push(executionId);
      const row = this.get(executionId);
      if (row.state === 'unresolved' && this.canProve) {
        row.state = 'reconciled';
        row.delta = { known: true, headChanged: false, changedPaths: ['src/example.js'] };
        row.reason = null;
      }
      return row.state === 'unresolved' ? { state: 'unresolved', reason: 'quiescence_unproven' } : { state: row.state, delta: row.delta };
    },
  };
  return admission;
}

function makeWorld({ script, workerFinal, pollsNeeded = 0, getTaskFault }) {
  const world = {
    script,
    leadTurns: 0,
    prompts: [],
    dispatchInputs: [],
    sends: [],
    polls: new Map(),
    tasks: new Map(),
    pollsNeeded,
    getTaskFault,
    workerFinal: workerFinal || ((roleName) => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report(`${roleName} done`)), metadata: { writerExecution: releasedWriter() } }],
    })),
    admission: makeFakeAdmission(),
  };
  const view = (task, done) => {
    const final = done ? world.workerFinal(task.role, task.contextId) : { state: TaskState.TASK_STATE_WORKING };
    return {
      id: task.id,
      contextId: task.contextId,
      status: { state: final.state, ...(final.message ? { message: final.message } : {}) },
      artifacts: done ? final.artifacts || [] : [],
      history: [],
    };
  };
  world.appServer = {
    async run(args) {
      world.prompts.push(args.input);
      const next = world.script[world.leadTurns];
      world.leadTurns += 1;
      if (next === undefined) throw new Error('lead script exhausted');
      const extras = world.leadExtras ? world.leadExtras(world.leadTurns) : {};
      if (typeof next === 'function') return { threadId: 'lead-thread', status: 'completed', text: await next(args), ...extras };
      if (next instanceof Error) throw next;
      return { threadId: 'lead-thread', status: 'completed', text: next, ...extras };
    },
  };
  world.clientFactory = {
    async createFromUrl(url) {
      const roleName = decodeURIComponent(new URL(url).pathname.split('/').at(-2));
      return {
        async sendMessage(params) {
          const contextId = params.message.contextId;
          world.sends.push(contextId);
          world.dispatchInputs.push(JSON.parse(params.message.parts[0].content.value));
          const task = { id: `task-${contextId}`, contextId, role: roleName };
          world.tasks.set(contextId, task);
          return { task: view(task, false) };
        },
        async getTask({ id }) {
          const task = [...world.tasks.values()].find((entry) => entry.id === id);
          if (!task) throw Object.assign(new Error('Task not found'), { name: 'TaskNotFoundError' });
          const count = (world.polls.get(id) || 0) + 1;
          world.polls.set(id, count);
          world.getTaskFault?.(id, count);
          return view(task, count > world.pollsNeeded);
        },
        async cancelTask({ id }) {
          const task = [...world.tasks.values()].find((entry) => entry.id === id);
          return { ...view(task, false), status: { state: TaskState.TASK_STATE_CANCELED } };
        },
        async listTasks({ contextId }) {
          const task = world.tasks.get(contextId);
          return { tasks: task ? [view(task, false)] : [], nextPageToken: '', pageSize: 100, totalSize: 0 };
        },
      };
    },
  };
  return world;
}

// Owns the file database; restart() closes it, reopens it, and builds a fresh orchestrator.
class Session {
  constructor(world, filePath = newDbPath(), options = {}) {
    this.world = world;
    this.filePath = filePath;
    this.options = options;
  }

  async open() {
    this.state = await openStateDatabase({ filePath: this.filePath });
    this.journal = new DispatchJournal(this.state);
    this.orchestrator = new LeadOrchestrator({
      appServer: this.world.appServer,
      roles: roles(),
      workspace: this.options.workspace || path.join(tmpRoot, 'workspace'),
      baseUrl: 'http://127.0.0.1:4040',
      clientFactory: this.world.clientFactory,
      pollIntervalMs: 0,
      checkpointer: this.state.checkpointer,
      journal: this.journal,
      admission: this.world.admission,
      reconcileWaitMs: 20,
      evidenceStore: this.evidenceStore = this.options.makeStore ? this.options.makeStore(this.state.db) : createEvidenceStore(this.state.db),
      ...(this.options.orchestrator || {}),
    });
    return this;
  }

  async restart() {
    await this.state.close();
    return this.open();
  }

  async close() {
    await this.state.close();
  }
}

async function withSession(world, fn, options) {
  const session = await new Session(world, newDbPath(), options).open();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

// ------------------------------------------------------------ fixtures

const vcs = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
let repoCounter = 0;
function gitRepo() {
  const dir = path.join(tmpRoot, `repo-${repoCounter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  vcs(dir, 'init', '-q');
  vcs(dir, 'config', 'user.email', 't@example.com');
  vcs(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  vcs(dir, 'add', '.');
  vcs(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const sha256Of = (value) => crypto.createHash('sha256').update(value).digest('hex');
const writerFinalWith = (text) => () => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts(text), metadata: { writerExecution: releasedWriter() } }],
});
const promptOutcomes = (prompt) => prompt.split('Prior worker outcomes (including failures):\n')[1].split('\n\n')[0];
const codeOf = (fn) => {
  try { fn(); } catch (error) { return error.code; }
  return assert.fail('expected a throw');
};

// Reassembles the stored payload with reads of at most MAX_READ_BYTES.
function readChunked(store, ref, runId) {
  const parts = [];
  for (let offset = 0; offset < ref.storedBytes; offset += MAX_READ_BYTES) {
    const chunk = store.read(ref.id, { runId, offset, length: MAX_READ_BYTES });
    assert.ok(chunk.bytes.length <= MAX_READ_BYTES);
    parts.push(chunk.bytes);
  }
  return Buffer.concat(parts);
}

// The same retrieval as `npm run evidence`, through main() against the state database file.
function cliRead(filePath, runId, id, offset, length) {
  const chunks = [];
  let err = '';
  const code = main(['--run', runId, '--id', id, '--offset', String(offset), '--length', String(length), '--state', filePath], {},
    { stdout: { write: (data) => chunks.push(Buffer.from(data)) }, stderr: { write: (data) => { err += data; } } });
  assert.equal(code, 0, err);
  return Buffer.concat(chunks);
}

const bigReportText = () => {
  const files = Array.from({ length: 500 }, (_, i) => `lib/gen/${'d'.repeat(16)}/f-${i}.js`);
  const text = report('Big report', {
    filesChanged: files, filesInspected: files.slice(0, 300), risks: Array.from({ length: 130 }, () => 'r'.repeat(8000)),
  });
  assert.ok(text.length >= MiB, `fixture is ${text.length} chars`);
  return text;
};
const runBig = (world, session) => session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
const bigWorld = (text) => makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')], workerFinal: writerFinalWith(text) });

// ------------------------------------------------------------ cases

test('1 MiB report: projected, evidence attached, retrieval via the CLI path reproduces the original bytes', async () => {
  const text = bigReportText();
  const world = bigWorld(text);
  await withSession(world, async (session) => {
    const outcome = (await runBig(world, session)).assignments[0];
    assert.equal(outcome.report.outcome, 'completed');
    assert.ok(outcome.projection.omitted.length > 0);
    assert.equal(outcome.evidence.length, 1);
    const ref = outcome.evidence[0];
    assert.equal(ref.kind, 'worker_result_text');
    assert.equal(ref.originalSha256, sha256Of(text));
    assert.equal(ref.originalBytes, Buffer.byteLength(text));
    assert.equal(ref.truncated, false);
    // Store API: chunked reads of MAX_READ_BYTES reassemble the original.
    const viaStore = readChunked(session.evidenceStore, ref, RUN_ID);
    assert.equal(sha256Of(viaStore), ref.originalSha256);
    assert.equal(viaStore.toString('utf8'), text);
    // CLI path (main) against the state database file.
    const parts = [];
    for (let offset = 0; offset < ref.storedBytes; offset += MAX_READ_BYTES) parts.push(cliRead(session.filePath, RUN_ID, ref.id, offset, MAX_READ_BYTES));
    const viaCli = Buffer.concat(parts);
    assert.equal(sha256Of(viaCli), ref.originalSha256);
    assert.ok(viaCli.equals(viaStore));
    assert.ok(parts.length >= 2, 'the report needs more than one read');
  }, { workspace: gitRepo() });
});

test('payload sizes before and after projection for the large-output fixture', async (t) => {
  const text = bigReportText();
  const world = bigWorld(text);
  await withSession(world, async (session) => {
    const outcome = (await runBig(world, session)).assignments[0];
    const raw = text.length;
    const projected = JSON.stringify(outcome).length;
    const promptSection = promptOutcomes(world.prompts[1]).length;
    t.diagnostic(`raw report: ${raw} chars; projected outcome JSON: ${projected} chars; lead prompt outcome section: ${promptSection} chars`);
    assert.ok(projected < 20_000, `projected outcome is ${projected} chars`);
    assert.ok(promptSection < 20_000, `prompt outcome section is ${promptSection} chars`);
    assert.ok(projected * 20 < raw);
  }, { workspace: gitRepo() });
});

test('a required check printing 10 MiB is stored head+tail, named by the failure issue, and its tail is retrievable', async () => {
  const dir = gitRepo();
  const db = new Database(':memory:');
  const store = createEvidenceStore(db);
  const code = "const b=Buffer.alloc(1024*1024,'a');for(let i=0;i<10;i++){process.stdout.write(b)}"
    + "process.stdout.write('\\nlast line printed\\n');process.stderr.write('err-line');process.exitCode=2";
  const result = await runAcceptance({
    workspace: dir, runId: 'run-ev', attempt: 1, evidenceStore: store,
    contract: { requiredChecks: [{ id: 'big', argv: [process.execPath, '-e', code] }] },
  });
  const check = result.checks[0];
  const out = check.stdoutEvidence;
  const original = 10 * MiB + '\nlast line printed\n'.length;
  assert.equal(out.kind, 'check_stdout');
  assert.equal(out.truncated, true);
  assert.equal(out.originalBytes, original);
  assert.deepEqual(out.omitted, { offset: 2 * MiB, bytes: original - 8 * MiB });
  const marker = `\n[evidence: ${original - 8 * MiB} bytes omitted]\n`;
  assert.equal(out.storedBytes, MAX_STORED_BYTES + Buffer.byteLength(marker));
  const issue = result.issues.find((entry) => entry.code === 'check_failed');
  assert.ok(issue.detail.includes(out.id) && issue.detail.includes(check.stderrEvidence.id), issue.detail);
  const tail = store.read(out.id, { runId: 'run-ev', offset: out.storedBytes - 100, length: 100 });
  assert.equal(tail.eof, true);
  assert.ok(tail.bytes.toString('utf8').endsWith('\nlast line printed\n'));
  // The omitted range is marked in place between head and tail.
  const mid = store.read(out.id, { runId: 'run-ev', offset: 2 * MiB, length: marker.length });
  assert.equal(mid.bytes.toString('utf8'), marker);
  db.close();
});

test('restart: refs from a checkpointed outcome resolve on a new connection and a replayed put adds no row', async () => {
  const text = bigReportText();
  const world = bigWorld(text);
  await withSession(world, async (session) => {
    const result = await runBig(world, session);
    const ref = result.assignments[0].evidence[0];
    const before = session.evidenceStore.listByRun(RUN_ID).map((entry) => entry.id);
    assert.deepEqual(before, [ref.id]);
    await session.restart(); // closes the database and reopens it with a new store
    const store = session.evidenceStore;
    const again = store.getRef(ref.id, { runId: RUN_ID });
    assert.equal(again.sha256, ref.sha256);
    assert.equal(again.originalSha256, ref.originalSha256);
    assert.equal(sha256Of(readChunked(store, again, RUN_ID)), ref.originalSha256);
    // The graph re-running the same attempt re-puts the same producer output.
    const replay = store.put({
      runId: RUN_ID, attemptId: ref.attemptId, taskId: ref.taskId, kind: ref.kind, mediaType: ref.mediaType,
      content: Buffer.from(text, 'utf8'), summary: ref.summary, source: ref.source,
    });
    assert.equal(replay.id, ref.id);
    assert.deepEqual(store.listByRun(RUN_ID).map((entry) => entry.id), [ref.id]);
  }, { workspace: gitRepo() });
});

test('expired evidence: getRef and read say evidence_expired, the lead still sees diagnostics and no pass', async () => {
  const text = `${'x'.repeat(40_000)}`; // not valid JSON: reportError, text projection, evidence
  const clock = { t: 1_800_000_000_000 };
  const world = makeWorld({ script: [dispatch(brief('orch-explorer')), finish('Done')], workerFinal: writerFinalWith(text) });
  await withSession(world, async (session) => {
    const outcome = (await runBig(world, session)).assignments[0];
    const ref = outcome.evidence[0];
    assert.equal(session.evidenceStore.getRef(ref.id, { runId: RUN_ID }).id, ref.id);
    clock.t += 31 * DAY_MS;
    assert.equal(codeOf(() => session.evidenceStore.getRef(ref.id, { runId: RUN_ID })), 'evidence_expired');
    assert.equal(codeOf(() => session.evidenceStore.read(ref.id, { runId: RUN_ID })), 'evidence_expired');
    // The outcome the lead holds keeps its error and summary; the digest form does too.
    assert.equal(outcome.report, null);
    assert.match(outcome.reportError, /not valid JSON/);
    const newer = { ...outcome, assignmentId: 'newer', attemptId: 'run:r1:newer:t1', filler: 'f'.repeat(30_000) };
    const bounded = boundedOutcomes([outcome, newer], 40_000);
    const digest = bounded.find((entry) => entry.digest && entry.assignmentId === outcome.assignmentId);
    assert.ok(digest, 'the older outcome becomes a digest');
    assert.match(digest.diagnostics.reportError, /not valid JSON/);
    assert.notEqual(digest.outcome, 'completed');
    assert.deepEqual(digest.evidence, [ref.id]);
    assert.ok(digest.summary.startsWith('x'));
  }, { workspace: gitRepo(), makeStore: (db) => createEvidenceStore(db, { now: () => clock.t, retentionDays: 30 }) });
});

test('errors stay visible: cross-run read, path-like id, and quota exceeded on a large report', async () => {
  const text = bigReportText();
  const world = bigWorld(text);
  await withSession(world, async (session) => {
    const store = session.evidenceStore;
    // Fill the run quota (8 x 8 MiB) so the worker report cannot be stored.
    for (let i = 0; i < 8; i += 1) {
      const block = Buffer.alloc(MAX_STORED_BYTES, i + 1);
      const filled = store.put({
        runId: RUN_ID, checkId: `fill-${i}`, kind: 'check_stdout', mediaType: 'text/plain; charset=utf-8',
        content: block, summary: 'quota filler', source: { producer: 'test' },
      });
      assert.equal(filled.stored, true);
    }
    const outcome = (await runBig(world, session)).assignments[0];
    assert.equal(outcome.report.outcome, 'completed');
    assert.ok(outcome.projection.omitted.length > 0);
    const ref = outcome.evidence[0];
    assert.equal(ref.stored, false);
    assert.equal(ref.error, 'evidence_quota_exceeded');
    assert.equal(ref.storedBytes, 0);
    assert.equal(ref.originalSha256, sha256Of(text));
    assert.equal(codeOf(() => store.read(ref.id, { runId: RUN_ID })), 'evidence_not_stored');
    // Cross-run and malformed ids.
    const filler = store.listByRun(RUN_ID).find((entry) => entry.stored);
    assert.equal(codeOf(() => store.read(filler.id, { runId: 'other-run' })), 'evidence_forbidden');
    assert.equal(codeOf(() => store.getRef(filler.id, { runId: 'other-run' })), 'evidence_forbidden');
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'ev_../x', `${filler.id}/..`]) {
      assert.equal(codeOf(() => store.read(bad, { runId: RUN_ID })), 'evidence_invalid_id', bad);
    }
  }, { workspace: gitRepo() });
});
