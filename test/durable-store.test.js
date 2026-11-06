'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { Annotation, Command, END, START, StateGraph, interrupt } = require('@langchain/langgraph');
const {
  acquireStateLock,
  DispatchJournal,
  InMemoryDispatchJournal,
  assignmentId,
  attemptId,
  createTaskStore,
  deterministicContextId,
  openStateDatabase,
  reconcileInterruptedTasks,
} = require('../src/durable-store');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'state.sqlite');
}

function makeTask(id, state, contextId = 'ctx-' + id) {
  return {
    id,
    contextId,
    status: { state, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: { note: 'kept' },
  };
}

const ctx = () => new ServerCallContext();

test('ids are stable and well formed', () => {
  const assignment = assignmentId('run-1', 2, 0);
  assert.equal(assignment, 'run-1:r2:a0');
  assert.equal(attemptId(assignment), 'run-1:r2:a0:t1');
  const a = deterministicContextId('run-1:r2:a0:t1');
  assert.equal(a, deterministicContextId('run-1:r2:a0:t1'));
  assert.notEqual(a, deterministicContextId('run-1:r2:a1:t1'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('state file is created with private modes', async (t) => {
  const file = tempDb(t);
  const state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('tasks persist across reopen and are isolated by namespace', async (t) => {
  const file = tempDb(t);
  let state = await openStateDatabase({ filePath: file });
  const task = makeTask('task-1', TaskState.TASK_STATE_COMPLETED, 'ctx-shared');
  await createTaskStore(state, 'orch-builder').save(task, ctx());
  await state.close();

  state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  const builder = createTaskStore(state, 'orch-builder');
  const loaded = await builder.load('task-1', ctx());
  assert.equal(loaded.id, 'task-1');
  assert.equal(loaded.contextId, 'ctx-shared');
  assert.equal(loaded.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(loaded.metadata, { note: 'kept' });

  const listed = await builder.list({ contextId: 'ctx-shared', pageSize: 10 }, ctx());
  assert.deepEqual(listed.tasks.map((item) => item.id), ['task-1']);

  const other = createTaskStore(state, 'orch-reviewer');
  assert.equal(await other.load('task-1', ctx()), undefined);
  const otherList = await other.list({ contextId: 'ctx-shared', pageSize: 10 }, ctx());
  assert.deepEqual(otherList.tasks, []);
});

test('journal is idempotent and persists across reopen', async (t) => {
  const file = tempDb(t);
  let state = await openStateDatabase({ filePath: file });
  let journal = new DispatchJournal(state);
  const row = {
    attemptId: 'run-1:r1:a0:t1',
    runId: 'run-1',
    assignmentId: 'run-1:r1:a0',
    role: 'orch-builder',
    sandbox: 'workspace-write',
    contextId: deterministicContextId('run-1:r1:a0:t1'),
  };
  const first = journal.recordSubmitting(row);
  assert.equal(first.state, 'submitting');
  assert.equal(first.taskId, null);
  assert.equal(first.result, null);
  journal.recordSubmitted(row.attemptId, 'task-9');
  const again = journal.recordSubmitting(row);
  assert.equal(again.state, 'submitted');
  assert.equal(again.taskId, 'task-9');
  journal.recordFinished(row.attemptId, { status: 'completed', text: 'ok' });
  assert.throws(() => journal.recordSubmitted('nope', 't'), /Unknown dispatch attempt/);
  assert.throws(() => journal.recordFinished('nope', {}), /Unknown dispatch attempt/);
  await state.close();

  state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  journal = new DispatchJournal(state);
  const stored = journal.get(row.attemptId);
  assert.equal(stored.state, 'finished');
  assert.equal(stored.taskId, 'task-9');
  assert.deepEqual(stored.result, { status: 'completed', text: 'ok' });
  assert.equal(stored.role, 'orch-builder');
  assert.equal(stored.sandbox, 'workspace-write');
  assert.ok(stored.createdAt && stored.updatedAt);
  assert.deepEqual(journal.listByRun('run-1').map((item) => item.attemptId), [row.attemptId]);
  assert.deepEqual(journal.listByRun('other'), []);
  assert.equal(journal.get('missing'), null);
});

test('in-memory journal matches the SQLite API', () => {
  const journal = new InMemoryDispatchJournal();
  const row = {
    attemptId: 'r:r1:a0:t1', runId: 'r', assignmentId: 'r:r1:a0', role: 'orch-x', sandbox: 'read-only', contextId: 'c',
  };
  assert.equal(journal.recordSubmitting(row).state, 'submitting');
  journal.recordSubmitted(row.attemptId, 't1');
  assert.equal(journal.recordSubmitting(row).state, 'submitted');
  journal.recordFinished(row.attemptId, { a: 1 });
  assert.deepEqual(journal.get(row.attemptId).result, { a: 1 });
  assert.equal(journal.listByRun('r').length, 1);
  assert.throws(() => journal.recordSubmitted('x', 't'), /Unknown dispatch attempt/);
  assert.throws(() => journal.recordFinished('x', {}), /Unknown dispatch attempt/);
  assert.equal(journal.get('x'), null);
});

test('reconciliation rewrites stale specialist and lead tasks only', async (t) => {
  const file = tempDb(t);
  let state = await openStateDatabase({ filePath: file });
  const builder = createTaskStore(state, 'orch-builder');
  const lead = createTaskStore(state, 'orchestrator');
  await builder.save(makeTask('b-working', TaskState.TASK_STATE_WORKING), ctx());
  await builder.save(makeTask('b-submitted', TaskState.TASK_STATE_SUBMITTED), ctx());
  await builder.save(makeTask('b-done', TaskState.TASK_STATE_COMPLETED), ctx());
  await lead.save(makeTask('l-working', TaskState.TASK_STATE_WORKING), ctx());
  await lead.save(makeTask('l-waiting', TaskState.TASK_STATE_INPUT_REQUIRED), ctx());
  await state.close();

  state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  const result = await reconcileInterruptedTasks(state);
  assert.deepEqual(result.specialists.sort(), ['b-submitted', 'b-working']);
  assert.deepEqual(result.lead, ['l-working']);

  const builderStore = createTaskStore(state, 'orch-builder');
  for (const id of ['b-working', 'b-submitted']) {
    const task = await builderStore.load(id, ctx());
    assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    const message = task.status.message;
    assert.equal(message.role, 2);
    assert.equal(message.taskId, id);
    assert.equal(message.contextId, 'ctx-' + id);
    assert.equal(message.parts[0].content.value,
      'Interrupted by server restart before completion; workspace effects are unknown.');
    assert.deepEqual(message.metadata, { failureKind: 'interrupted' });
    assert.deepEqual(task.metadata, { note: 'kept' });
  }
  assert.equal((await builderStore.load('b-done', ctx())).status.state, TaskState.TASK_STATE_COMPLETED);

  const leadStore = createTaskStore(state, 'orchestrator');
  const leadTask = await leadStore.load('l-working', ctx());
  assert.equal(leadTask.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.deepEqual(leadTask.metadata, { note: 'kept', pause: { kind: 'restart' } });
  assert.equal(leadTask.status.message.parts[0].content.value,
    'Run interrupted by server restart. Send a message to this task to resume.');
  const waiting = await leadStore.load('l-waiting', ctx());
  assert.equal(waiting.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.deepEqual(waiting.metadata, { note: 'kept' });

  const second = await reconcileInterruptedTasks(state);
  assert.deepEqual(second, { specialists: [], lead: [] });
});

function buildGraph(checkpointer) {
  const State = Annotation.Root({
    log: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  });
  return new StateGraph(State)
    .addNode('first', async () => ({ log: ['first'] }))
    .addNode('ask', async () => ({ log: [`answer:${interrupt({ question: 'go?' })}`] }))
    .addEdge(START, 'first')
    .addEdge('first', 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer });
}

test('graph checkpoints persist across reopen and resume in a new instance', async (t) => {
  const file = tempDb(t);
  const config = { configurable: { thread_id: 'run-1' } };
  let state = await openStateDatabase({ filePath: file });
  const paused = await buildGraph(state.checkpointer).invoke({ log: [] }, config);
  assert.equal(paused.__interrupt__[0].value.question, 'go?');
  await state.close();

  state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  const graph = buildGraph(state.checkpointer);
  const snapshot = await graph.getState(config);
  assert.deepEqual(snapshot.next, ['ask']);
  assert.equal(snapshot.tasks[0].interrupts[0].value.question, 'go?');
  const done = await graph.invoke(new Command({ resume: 'yes' }), config);
  assert.deepEqual(done.log, ['first', 'answer:yes']);
});

test('state lock is exclusive, released on release, and ignores an old text lock', (t) => {
  const file = tempDb(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, '999999\n');
  const release = acquireStateLock(file);
  assert.throws(() => acquireStateLock(file), /is in use \(lock held: .*\.lockdb\)/);
  release();
  release();
  const second = acquireStateLock(file);
  second();
  assert.equal(typeof acquireStateLock(':memory:'), 'function');
});

const notRoot = typeof process.getuid === 'function' && process.getuid() === 0 ? 'root ignores file modes' : false;

test('a read-only lock file is refused, in this process and in another', { skip: notRoot }, (t) => {
  const { execFileSync } = require('node:child_process');
  const file = tempDb(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  acquireStateLock(file)();
  const lockPath = `${file}.lockdb`;
  fs.chmodSync(lockPath, 0o444);
  assert.throws(() => acquireStateLock(file), (error) => error.message.includes(lockPath) && /lock file is not writable/.test(error.message));
  const script = `try { require(${JSON.stringify(path.resolve(__dirname, '../src/durable-store'))}).acquireStateLock(${JSON.stringify(file)}); console.log('held'); } catch (e) { console.log('refused:' + e.message); }`;
  assert.match(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), /^refused:.*not writable/);
});

test('a read-only lock directory reports the lock path', { skip: notRoot }, (t) => {
  const file = tempDb(t);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  t.after(() => { try { fs.chmodSync(dir, 0o755); } catch (_) { /* already removed */ } });
  assert.throws(() => acquireStateLock(file), (error) => error.message.startsWith(`Cannot open lock ${file}.lockdb: `) && Boolean(error.cause));
});

test('journal stores objective_sha256 and migrates an existing table without the column', async (t) => {
  const Database = require('better-sqlite3');
  const file = tempDb(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new Database(file);
  old.exec(`CREATE TABLE dispatch_journal (
    attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, assignment_id TEXT NOT NULL, role TEXT NOT NULL,
    sandbox TEXT NOT NULL, context_id TEXT NOT NULL, task_id TEXT, state TEXT NOT NULL, result_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.prepare(`INSERT INTO dispatch_journal VALUES ('old:t1', 'r', 'old', 'orch-builder', 'workspace-write', 'c', NULL, 'submitting', NULL, 'n', 'n')`).run();
  old.close();

  const state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  const columns = state.db.prepare("PRAGMA table_info('dispatch_journal')").all().map((column) => column.name);
  assert.ok(columns.includes('objective_sha256'));
  const journal = new DispatchJournal(state);
  assert.equal(journal.get('old:t1').objectiveSha256, null);
  const row = {
    attemptId: 'new:t1', runId: 'r', assignmentId: 'new', role: 'orch-builder', sandbox: 'workspace-write', contextId: 'c2', objectiveSha256: 'abc',
  };
  assert.equal(journal.recordSubmitting(row).objectiveSha256, 'abc');
  assert.equal(new InMemoryDispatchJournal().recordSubmitting(row).objectiveSha256, 'abc');
});

function lockRepo(t) {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wslock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']);
  return { root, repo };
}

test('workspace lock is shared by nested workspaces in one repository, with and without a lock dir', (t) => {
  const { acquireWorkspaceLock } = require('../src/durable-store');
  const { root, repo } = lockRepo(t);
  const sub = path.join(repo, 'sub');
  const release = acquireWorkspaceLock(repo, { lockDir: null });
  assert.ok(fs.existsSync(path.join(fs.realpathSync(repo), '.git', 'codex-a2a-writer.lockdb')));
  assert.throws(() => acquireWorkspaceLock(sub, { lockDir: null }), /is in use \(lock held: /);
  release();
  const inner = acquireWorkspaceLock(sub, { lockDir: null });
  assert.throws(() => acquireWorkspaceLock(repo, { lockDir: null }), /is in use/);
  inner();

  const lockDir = path.join(root, 'locks');
  const outer = acquireWorkspaceLock(repo, { lockDir });
  assert.throws(() => acquireWorkspaceLock(sub, { lockDir }), /is in use/);
  const lockFiles = fs.readdirSync(lockDir).filter((name) => !name.endsWith('-journal'));
  assert.equal(lockFiles.length, 1);
  assert.match(lockFiles[0], /^codex-a2a-writer-[0-9a-f]{16}\.lockdb$/);
  outer();
  acquireWorkspaceLock(sub, { lockDir })();
});

test('workspace lock falls back for non-repository dirs and simultaneous acquisition has one winner', async (t) => {
  const { acquireWorkspaceLock } = require('../src/durable-store');
  const { root, repo } = lockRepo(t);
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  const lockDir = path.join(root, 'plocks');
  const plainRelease = acquireWorkspaceLock(plain, { lockDir });
  assert.throws(() => acquireWorkspaceLock(plain, { lockDir }), /is in use/);
  plainRelease();
  acquireWorkspaceLock(plain, { lockDir })();

  const attempts = await Promise.all([1, 2].map(async () => {
    try { return acquireWorkspaceLock(repo, { lockDir: null }); } catch (error) { return error; }
  }));
  const winners = attempts.filter((entry) => typeof entry === 'function');
  assert.equal(winners.length, 1);
  assert.equal(attempts.filter((entry) => entry instanceof Error).length, 1);
  winners[0]();
});

test('a lock held by a child process blocks the parent and is dropped when the child is killed', async (t) => {
  const { spawn } = require('node:child_process');
  const { acquireWorkspaceLock } = require('../src/durable-store');
  const { repo } = lockRepo(t);
  const script = `const d = require(${JSON.stringify(require.resolve('../src/durable-store'))});
d.acquireWorkspaceLock(${JSON.stringify(repo)}, { lockDir: null }); process.stdout.write('held\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('child exited early')));
    child.stdout.once('data', resolve);
  });
  assert.throws(() => acquireWorkspaceLock(repo, { lockDir: null }), /is in use/);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  acquireWorkspaceLock(repo, { lockDir: null })();
});

test('state database uses synchronous = FULL', async (t) => {
  const state = await openStateDatabase({ filePath: tempDb(t) });
  t.after(() => state.close());
  assert.equal(state.db.pragma('synchronous', { simple: true }), 2);
});

test('provider call bindings are append-only, replay-safe, correlated, and survive SQLite reopen', async (t) => {
  const file = tempDb(t);
  let state = await openStateDatabase({ filePath: file });
  const journal = new DispatchJournal(state);
  const attempt = { attemptId: 'run:r1:a0:t1', runId: 'run', assignmentId: 'run:r1:a0', role: 'orch-builder', sandbox: 'workspace-write', contextId: 'ctx' };
  journal.recordSubmitting(attempt);
  const binding = {
    invocationId: 'invocation-1', attemptId: attempt.attemptId, runId: attempt.runId,
    assignmentId: attempt.assignmentId, taskId: 'worker-task', accountId: 'a'.repeat(64),
    boundAt: '2026-11-06T13:00:00.000Z',
  };
  const secondBinding = { ...binding, invocationId: 'invocation-2', accountId: 'b'.repeat(64) };
  assert.deepEqual(journal.recordCallBound(binding), binding);
  assert.deepEqual(journal.recordCallBound(binding), binding);
  assert.equal(journal.get(attempt.attemptId).taskId, 'worker-task');
  assert.throws(() => journal.recordCallBound({ ...binding, invocationId: 'invocation-other-task', taskId: 'different-worker-task' }), /does not match an active dispatch attempt/);
  assert.equal(journal.get(attempt.attemptId).taskId, 'worker-task');
  assert.throws(() => journal.recordCallBound({ ...binding, accountId: 'b'.repeat(64) }), { code: 'call_binding_conflict' });
  assert.deepEqual(journal.recordCallBound(secondBinding), secondBinding);
  assert.throws(() => journal.recordCallBound({ ...binding, invocationId: 'invocation-3', assignmentId: 'other' }), /does not match an active dispatch attempt/);
  assert.deepEqual(journal.listCallBindingsByAttempt(attempt.attemptId), [binding, secondBinding]);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM dispatch_call_bindings').get().count, 2);
  journal.recordSubmitted(attempt.attemptId, 'worker-task');
  journal.recordFinished(attempt.attemptId, { outcome: 'completed' });
  await state.close();

  state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  const reopened = new DispatchJournal(state);
  assert.deepEqual(reopened.listCallBindingsByAttempt(attempt.attemptId), [binding, secondBinding]);
  assert.deepEqual(reopened.recordCallBound(binding), binding);
  assert.throws(() => reopened.recordCallBound({ ...binding, invocationId: 'invocation-3' }), /does not match an active dispatch attempt/);
  const columns = state.db.prepare("PRAGMA table_info('dispatch_call_bindings')").all().map((column) => column.name);
  assert.deepEqual(columns.sort(), ['account_id_sha256', 'attempt_id', 'assignment_id', 'bound_at', 'invocation_id', 'run_id', 'task_id'].sort());
});

test('lead planning call bindings retain a null A2A task across SQLite reopen', async (t) => {
  const file = tempDb(t);
  let state = await openStateDatabase({ filePath: file });
  let journal = new DispatchJournal(state);
  const runId = 'lead-run';
  const attemptId = `${runId}:lead:attempt-1`;
  const assignmentId = `${runId}:lead-planning`;
  journal.recordSubmitting({ attemptId, runId, assignmentId, role: 'coordinator', sandbox: 'read-only', contextId: runId });
  const binding = {
    invocationId: 'lead-invocation-1', attemptId, runId, assignmentId, taskId: null,
    accountId: 'c'.repeat(64), boundAt: '2026-11-06T13:00:00.000Z',
  };
  assert.deepEqual(journal.recordCallBound(binding), binding);
  assert.equal(journal.get(attemptId).taskId, null);
  assert.equal(journal.get(attemptId).state, 'submitting');
  assert.throws(() => journal.recordCallBound({ ...binding, invocationId: 'lead-invocation-2', taskId: 'invented-task' }), /does not match an active dispatch attempt/);
  await state.close();

  state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  journal = new DispatchJournal(state);
  assert.deepEqual(journal.listCallBindingsByAttempt(attemptId), [binding]);
  assert.equal(journal.get(attemptId).taskId, null);
});

test('provider call binding schema migration preserves worker rows and allows null lead task IDs', async (t) => {
  const file = tempDb(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacyDb = new Database(file);
  legacyDb.exec(`
    CREATE TABLE dispatch_call_bindings (
      invocation_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      account_id_sha256 TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      UNIQUE (attempt_id, invocation_id)
    );
    CREATE INDEX dispatch_call_bindings_attempt_idx ON dispatch_call_bindings (attempt_id, bound_at, invocation_id);
    INSERT INTO dispatch_call_bindings VALUES ('legacy-invocation', 'legacy-attempt', 'legacy-run', 'legacy-assignment', 'worker-task', printf('%064d', 0), '2026-11-06T13:00:00.000Z');
  `);
  legacyDb.close();

  const state = await openStateDatabase({ filePath: file });
  t.after(() => state.close());
  const journal = new DispatchJournal(state);
  assert.deepEqual(journal.getCallBinding('legacy-invocation'), {
    invocationId: 'legacy-invocation', attemptId: 'legacy-attempt', runId: 'legacy-run',
    assignmentId: 'legacy-assignment', taskId: 'worker-task', accountId: '0'.repeat(64),
    boundAt: '2026-11-06T13:00:00.000Z',
  });
  const taskColumn = state.db.prepare("PRAGMA table_info('dispatch_call_bindings')").all().find((column) => column.name === 'task_id');
  assert.equal(taskColumn.notnull, 0);
});

for (const [name, make] of [
  ['sqlite', async (t) => { const state = await openStateDatabase({ filePath: tempDb(t) }); t.after(() => state.close()); return new DispatchJournal(state); }],
  ['in-memory', async () => new InMemoryDispatchJournal()],
]) {
  test(`journal transitions are monotonic (${name})`, async (t) => {
    const journal = await make(t);
    const row = { attemptId: 'r:r1:a0:t1', runId: 'r', assignmentId: 'r:r1:a0', role: 'orch-x', sandbox: 'read-only', contextId: 'c' };
    const refused = (fn, from, to) => assert.throws(fn, (error) => error.code === 'journal_transition_refused' && error.from === from && error.to === to);
    journal.recordSubmitting(row);
    journal.recordSubmitted(row.attemptId, 't1');
    journal.recordSubmitted(row.attemptId, 't1'); // same task id: no-op
    refused(() => journal.recordSubmitted(row.attemptId, 't2'), 'submitted', 'submitted');
    assert.equal(journal.get(row.attemptId).taskId, 't1');
    journal.recordFinished(row.attemptId, { a: 1 });
    journal.recordFinished(row.attemptId, { a: 1 }); // identical: no-op
    refused(() => journal.recordFinished(row.attemptId, { a: 2 }), 'finished', 'finished');
    refused(() => journal.recordSubmitted(row.attemptId, 't1'), 'finished', 'submitted');
    assert.deepEqual(journal.get(row.attemptId).result, { a: 1 });
    assert.equal(journal.get(row.attemptId).state, 'finished');
    assert.equal(journal.recordSubmitting(row).state, 'finished');

    // submitting -> finished is allowed (outcome_unknown for a writer that was never sent).
    journal.recordSubmitting({ ...row, attemptId: 'r:r1:a1:t1' });
    journal.recordFinished('r:r1:a1:t1', { b: 1 });
    assert.equal(journal.get('r:r1:a1:t1').state, 'finished');
  });
}
