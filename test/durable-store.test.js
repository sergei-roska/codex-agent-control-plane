'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
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

test('state lock is exclusive for a live pid, replaces a stale one, and is released', (t) => {
  const file = tempDb(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const release = acquireStateLock(file);
  assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
  assert.throws(() => acquireStateLock(file), new RegExp(`in use by pid ${process.pid}`));
  release();
  assert.equal(fs.existsSync(lockPath), false);

  const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadPid = Number(child.stdout.toString());
  fs.writeFileSync(lockPath, `${deadPid}\n`);
  const second = acquireStateLock(file);
  assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
  second();
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(typeof acquireStateLock(':memory:'), 'function');
});
