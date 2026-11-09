'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { TaskExecutor } = require('../src/task-executor');
const { VERSION } = require('../src/delivery-contracts');

const projectId = 'executor-project';
const objectiveId = 'executor-objective';
const digest = (char) => `sha256:${char.repeat(64)}`;
let clock = 1000;

function task(taskId, role = 'engineer') {
  return {
    schemaVersion: VERSION, projectId, objectiveId, taskId, revision: 1, role,
    kind: 'implementation', objective: `Implement ${taskId}`, priority: 0, dependencies: [],
    productWritePaths: ['src/example.js'], readScope: { kind: 'unknown', paths: null, reason: 'Not established.' },
    scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued',
  };
}

function fixture({ count = 1, roleCapacity = count, secondRole = 'engineer', resultAdapter, requestAdapter, transport, recoveryProofAdapter, maxRecoveryRetries } = {}) {
  clock = 1000;
  const db = new Database(':memory:');
  const store = new BacklogStore(db, { now: () => clock, roleCapacities: { engineer: roleCapacity, verifier: roleCapacity }, maxActiveTurns: Math.max(3, count + 1), plannerReservedSlots: 1 });
  store.createObjective({
    projectId, objectiveId, sessionId: 'session', engineVersion: 'delivery-v1', goalRevision: 1,
    requirementDigest: digest('a'), checksDigest: digest('b'), authorityRevision: 1,
    controlRevision: 1, disposition: 'executing',
  });
  const delta = { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1, tasks: Array.from({ length: count }, (_, i) => ({ task: task(`task-${i}`, i ? secondRole : 'engineer') })), dependencies: [] };
  store.applyPlan(projectId, objectiveId, delta);
  const claims = store.claimReady(projectId, objectiveId, 0, { limit: count, controlRevision: 1 });
  const sends = [];
  const adapter = transport || {
    async sendMessage({ message }) {
      sends.push(message);
      return { id: `remote-${message.metadata.attemptId}`, contextId: message.contextId, metadata: { attemptId: message.metadata.attemptId } };
    },
    async findByContext() { return null; },
  };
  const executor = new TaskExecutor({
    backlogStore: store, db,
    transportFor: async () => adapter,
    settingsFor: async () => ({ model: 'model-pinned', effort: 'high', fast: true }),
    roleFor: (id) => ({ id, sandbox: 'writable' }),
    requestAdapter: requestAdapter || (({ task: value }) => ({ request: { objective: value.objective, allowedFiles: value.productWritePaths } })),
    resultAdapter: resultAdapter || (async () => ({ result: { state: 'succeeded', trusted: true, candidateId: 'candidate-injected', output: 'output-injected' }, evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true, evidenceRefs: ['injected:test'] } })),
    recoveryProofAdapter,
    ...(maxRecoveryRetries === undefined ? {} : { maxRecoveryRetries }),
    now: () => clock,
  });
  const identity = (claim) => ({ projectId, objectiveId, taskId: claim.task.taskId, attemptId: claim.attempt.attemptId, fencingToken: claim.claim.fencingToken });
  return { db, store, claims, executor, sends, transport: adapter, identity };
}

test('send intent and pinned write/scratch scopes are durable before fake transport runs', async (t) => {
  let fixtureRef;
  const transport = { async sendMessage({ message }) {
    const row = fixtureRef.db.prepare('SELECT * FROM task_executor_attempts WHERE attempt_id=?').get(message.metadata.attemptId);
    assert.equal(row.state, 'intent');
    assert.equal(row.context_id, message.contextId);
    assert.equal(row.request_digest, message.metadata.requestDigest);
    assert.equal(row.journal_id, message.metadata.attemptId);
    assert.deepEqual(JSON.parse(row.record_json).productWritePaths, ['src/example.js']);
    assert.deepEqual(message.metadata.productWritePaths, ['src/example.js']);
    assert.deepEqual(message.metadata.scratchWriteRoots, ['.scratch']);
    return { id: 'remote-1', contextId: message.contextId };
  }, async findByContext() { return null; } };
  fixtureRef = fixture({ transport });
  t.after(() => fixtureRef.db.close());
  assert.equal((await fixtureRef.executor.execute(fixtureRef.identity(fixtureRef.claims[0]))).state, 'submitted');
});

test('concurrent execute calls share one committed send intent and only one sends', async (t) => {
  let started;
  let release;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const transport = {
    async sendMessage({ message }) { sends += 1; started(); await gate; return { id: 'remote-one', contextId: message.contextId }; },
    async findByContext() { return null; },
  };
  const f = fixture({ transport });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const first = f.executor.execute(id);
  await startedPromise;
  const second = await f.executor.execute(id);
  assert.equal(second.state, 'unknown');
  assert.equal(second.reason, 'lookup_absent_no_resend');
  release();
  assert.equal((await first).state, 'submitted');
  assert.equal(sends, 1);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('first send rejects a caller task ID that differs from the durable attempt tuple', async (t) => {
  const f = fixture({ count: 2, roleCapacity: 2 });
  t.after(() => f.db.close());
  const wrong = f.identity(f.claims[0]);
  wrong.taskId = f.claims[1].task.taskId;
  await assert.rejects(f.executor.execute(wrong), { code: 'task_identity_mismatch' });
  assert.equal(f.sends.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_executor_attempts').get().n, 0);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 2);
});

test('same-attempt execute replay returns the linked task without repinning or resending', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const first = await f.executor.execute(id);
  const replay = await f.executor.execute(id);
  assert.equal(first.state, 'submitted');
  assert.equal(replay.state, 'submitted');
  assert.equal(replay.externalTaskId, first.externalTaskId);
  assert.equal(replay.replay, true);
  assert.equal(f.sends.length, 1);
});

test('existing intent replay and terminal handling reject a different caller task ID', async (t) => {
  const f = fixture({ count: 2, roleCapacity: 2 });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const submitted = await f.executor.execute(id);
  const wrong = { ...id, taskId: f.claims[1].task.taskId };
  await assert.rejects(f.executor.execute(wrong), { code: 'task_identity_mismatch' });
  await assert.rejects(f.executor.acceptTerminal(wrong, {
    id: submitted.externalTaskId, contextId: submitted.contextId, status: { state: 'COMPLETED' },
  }), { code: 'task_identity_mismatch' });
  assert.equal(f.sends.length, 1);
  assert.equal(f.executor.getAttempt(id.attemptId).taskId, id.taskId);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 2);
});

test('interrupted send reconciles one deterministic context and links the discovered identity', async (t) => {
  let context;
  const transport = {
    async sendMessage({ message }) { context = message.contextId; throw new Error('connection lost after acceptance'); },
    async findByContext(id) { assert.equal(id, context); return { id: 'remote-found', contextId: id }; },
  };
  const f = fixture({ transport });
  t.after(() => f.db.close());
  const result = await f.executor.execute(f.identity(f.claims[0]));
  assert.deepEqual(result, { state: 'submitted', externalTaskId: 'remote-found', contextId: context, recovered: true });
  assert.equal(f.store.listAttempts(projectId, objectiveId)[0].externalTaskId, 'remote-found');
});

test('absent and failed lookups never resend or release capacity', async (t) => {
  for (const lookup of [async () => null, async () => { throw new Error('lookup unavailable'); }, async (contextId) => [{ id: 'remote-a', contextId }, { id: 'remote-b', contextId }]]) {
    let sends = 0;
    const transport = { async sendMessage() { sends += 1; throw new Error('uncertain send'); }, findByContext: lookup };
    const f = fixture({ transport });
    const id = f.identity(f.claims[0]);
    assert.equal((await f.executor.execute(id)).state, 'unknown');
    assert.equal((await f.executor.reconcile(id)).state, 'unknown');
    assert.equal(sends, 1);
    assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
    assert.equal(f.store.listAttempts(projectId, objectiveId)[0].state, 'claimed');
    f.db.close();
  }
});

test('duplicate terminal event settles once with only injected candidate/output facts', async (t) => {
  let resultCalls = 0;
  const f = fixture({ resultAdapter: async () => {
    resultCalls += 1;
    return { result: { state: 'succeeded', trusted: true, candidateId: 'candidate-from-adapter', output: { ref: 'output-from-adapter' } }, evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true, evidenceRefs: ['candidate-adapter'] } };
  } });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  await f.executor.execute(id);
  const attempt = f.store.listAttempts(projectId, objectiveId)[0];
  const remote = { id: attempt.externalTaskId, contextId: attempt.providerContextId, status: { state: 'COMPLETED' } };
  assert.equal((await f.executor.acceptTerminal(id, remote)).duplicate, false);
  assert.equal((await f.executor.acceptTerminal(id, remote)).duplicate, true);
  assert.equal(resultCalls, 2);
  const settledAttempt = f.store.listAttempts(projectId, objectiveId)[0];
  assert.equal(settledAttempt.outcome.candidateId, 'candidate-from-adapter');
  assert.deepEqual(settledAttempt.outcome.output, { ref: 'output-from-adapter' });
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
});

test('late successful provider result after objective cancellation settles and reports canceled', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const submitted = await f.executor.execute(id);
  f.store.requestControl(projectId, objectiveId, 'cancel', 1);
  const result = await f.executor.acceptTerminal(id, {
    id: submitted.externalTaskId, contextId: submitted.contextId, status: { state: 'COMPLETED' },
  });
  assert.equal(result.state, 'canceled');
  assert.deepEqual(result.result, { state: 'canceled', failureKind: 'objective_canceled' });
  const attempt = f.store.listAttempts(projectId, objectiveId)[0];
  assert.equal(attempt.state, 'canceled');
  assert.deepEqual(attempt.outcome, result.result);
  assert.equal(f.store.getObjective(projectId, objectiveId).tasks[0].state, 'canceled');
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
  const journal = f.executor.dispatchJournal.get(id.attemptId);
  assert.equal(journal.state, 'finished');
  assert.equal(journal.result.state, 'canceled');
});

test('wrong context, task, thread, and late fence outcomes are evidence and cannot settle', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const contextId = f.claims[0].attempt.providerContextId;
  await f.executor.execute(id);
  const linkedId = f.store.listAttempts(projectId, objectiveId)[0].externalTaskId;
  await assert.rejects(f.executor.acceptTerminal(id, { id: linkedId, contextId: 'wrong-context', status: { state: 'COMPLETED' } }), { code: 'context_identity_mismatch' });
  await assert.rejects(f.executor.acceptTerminal(id, { id: 'wrong-remote-task', contextId, status: { state: 'COMPLETED' } }), { code: 'external_task_conflict' });
  f.db.prepare("UPDATE backlog_attempts SET record_json=json_set(record_json, '$.threadId', ?) WHERE attempt_id=?").run('thread-pinned', id.attemptId);
  await assert.rejects(f.executor.acceptTerminal(id, { id: linkedId, contextId, threadId: 'wrong-thread', status: { state: 'COMPLETED' } }), { code: 'thread_identity_mismatch' });
  assert.equal(f.executor.listEvidence(id.attemptId).length, 3);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
  await assert.rejects(f.executor.acceptTerminal({ ...id, fencingToken: id.fencingToken + 1 }, { id: linkedId, contextId, status: { state: 'COMPLETED' } }), { code: 'fence_stale' });
});

test('first observed remote thread is pinned and rejects later terminal thread drift', async (t) => {
  const transport = {
    async sendMessage({ message }) { return { id: 'remote-threaded', contextId: message.contextId, threadId: 'thread-A' }; },
    async findByContext() { return null; },
  };
  const f = fixture({ transport });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const sent = await f.executor.execute(id);
  assert.equal(f.executor.getAttempt(id.attemptId).observedThreadId, 'thread-A');
  await assert.rejects(f.executor.acceptTerminal(id, {
    id: sent.externalTaskId, contextId: sent.contextId, threadId: 'thread-B', status: { state: 'COMPLETED' },
  }), { code: 'thread_identity_mismatch' });
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
  assert.equal(f.store.listAttempts(projectId, objectiveId)[0].state, 'running');
});

test('known continuation thread is reserved before send across active attempts', async (t) => {
  let sends = 0;
  const transport = {
    async sendMessage({ message }) {
      sends += 1;
      assert.equal(message.metadata.threadId, 'shared-thread');
      return { id: `remote-${sends}`, contextId: message.contextId, threadId: 'shared-thread' };
    },
    async findByContext() { return null; },
  };
  const f = fixture({ count: 2, roleCapacity: 2, transport, requestAdapter: ({ task: value }) => ({
    request: { objective: value.objective, allowedFiles: value.productWritePaths }, threadId: 'shared-thread',
  }) });
  t.after(() => f.db.close());
  await f.executor.execute(f.identity(f.claims[0]));
  await assert.rejects(f.executor.execute(f.identity(f.claims[1])), { code: 'provider_thread_busy' });
  assert.equal(sends, 1);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 2);
});

test('default transport group fans shared failure across roles in one project', async (t) => {
  const f = fixture({ count: 2, roleCapacity: 2, secondRole: 'verifier' });
  t.after(() => f.db.close());
  await f.executor.execute(f.identity(f.claims[0]));
  await f.executor.execute(f.identity(f.claims[1]));
  assert.deepEqual(f.executor.transportFailed(`project:${projectId}`, new Error('shared service stopped')).sort(), f.claims.map((claim) => claim.attempt.attemptId).sort());
  assert.deepEqual(f.claims.map((claim) => f.executor.getAttempt(claim.attempt.attemptId).state), ['uncertain', 'uncertain']);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 2);
});

test('request adapter cannot expand the task product write scope', async (t) => {
  const f = fixture({ requestAdapter: ({ task: value }) => ({ request: { objective: value.objective, allowedFiles: ['src/other.js'] } }) });
  t.after(() => f.db.close());
  await assert.rejects(f.executor.execute(f.identity(f.claims[0])), { code: 'product_write_scope_mismatch' });
  assert.equal(f.sends.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_executor_attempts').get().n, 0);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('request adapter cannot replace or truncate the pinned task objective', async (t) => {
  const f = fixture({ requestAdapter: ({ task: value }) => ({ request: { objective: `${value.objective.slice(0, 8)}...`, allowedFiles: value.productWritePaths } }) });
  t.after(() => f.db.close());
  await assert.rejects(f.executor.execute(f.identity(f.claims[0])), { code: 'task_objective_mismatch' });
  assert.equal(f.sends.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_executor_attempts').get().n, 0);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('terminal status alone cannot settle without owned process quiescence evidence', async (t) => {
  const f = fixture({ resultAdapter: async () => ({
    result: { state: 'succeeded', trusted: true, candidateId: 'candidate-injected' },
    evidence: { remoteQuiescent: true, processQuiescent: false, effectsSettled: true, controllerValidated: true },
  }) });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const submitted = await f.executor.execute(id);
  await assert.rejects(f.executor.acceptTerminal(id, { id: submitted.externalTaskId, contextId: submitted.contextId }), { code: 'remote_task_not_terminal' });
  await assert.rejects(f.executor.acceptTerminal(id, { id: submitted.externalTaskId, contextId: submitted.contextId, status: { state: 'COMPLETED' } }), { code: 'quiescence_evidence_required' });
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
  assert.equal(f.store.listAttempts(projectId, objectiveId)[0].state, 'running');
});

test('owner pause allows cancellation request for an existing submitted attempt', async (t) => {
  let cancels = 0;
  const f = fixture({ transport: {
    async sendMessage({ message }) { return { id: 'remote-pause-abort', contextId: message.contextId }; },
    async cancel() { cancels += 1; },
    async findByContext() { return null; },
  } });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  await f.executor.execute(id);
  f.store.requestControl(projectId, objectiveId, 'pause', 1);
  assert.deepEqual(await f.executor.abort(id), { state: 'unknown', reason: 'remote_and_process_quiescence_unconfirmed' });
  assert.equal(cancels, 1);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('owner pause allows polling and truthful settlement with current control passed to adapter', async (t) => {
  let observedControl;
  const f = fixture({ transport: {
    async sendMessage({ message }) { return { id: 'remote-pause-poll', contextId: message.contextId }; },
    async getTask({ id, contextId }) { return { id, contextId, status: { state: 'COMPLETED' } }; },
    async findByContext() { return null; },
  }, resultAdapter: async ({ currentControl }) => {
    observedControl = currentControl;
    return { result: { state: 'succeeded', trusted: true, candidateId: 'candidate-injected' }, evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true } };
  } });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  await f.executor.execute(id);
  f.store.requestControl(projectId, objectiveId, 'pause', 1);
  assert.equal((await f.executor.poll(id)).state, 'succeeded');
  assert.deepEqual(observedControl, { controlRevision: 2, authorityRevision: 1, disposition: 'paused_owner', ownerGeneration: 0 });
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
});

test('owner pause permits direct terminal evidence for an existing submitted attempt', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const submitted = await f.executor.execute(id);
  f.store.requestControl(projectId, objectiveId, 'pause', 1);
  const result = await f.executor.acceptTerminal(id, {
    id: submitted.externalTaskId, contextId: submitted.contextId, status: { state: 'COMPLETED' },
  });
  assert.equal(result.state, 'succeeded');
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
});

test('control drift after settings pin prevents intent and network send', async (t) => {
  let f;
  f = fixture({ requestAdapter: ({ task: value }) => {
    f.store.requestControl(projectId, objectiveId, 'pause', 1);
    return { request: { objective: value.objective, allowedFiles: value.productWritePaths } };
  } });
  t.after(() => f.db.close());
  await assert.rejects(f.executor.execute(f.identity(f.claims[0])), { code: 'control_revision_stale' });
  assert.equal(f.sends.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_executor_attempts').get().n, 0);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('generation drift while transport resolution is pending prevents send and retains the intent claim', async (t) => {
  let resolveTransport;
  let transportReady;
  const entered = new Promise((resolve) => { transportReady = resolve; });
  const waiting = new Promise((resolve) => { resolveTransport = resolve; });
  let sends = 0;
  const f = fixture();
  const executor = new TaskExecutor({
    backlogStore: f.store, db: f.db,
    transportFor: async () => { transportReady(); return waiting; },
    settingsFor: async () => ({ model: 'model-pinned', effort: 'high', fast: true }),
    roleFor: (id) => ({ id, sandbox: 'writable' }),
    requestAdapter: ({ task: value }) => ({ request: { objective: value.objective, allowedFiles: value.productWritePaths } }),
    resultAdapter: async () => ({}), now: () => clock,
  });
  t.after(() => f.db.close());
  const pending = executor.execute(f.identity(f.claims[0]));
  await entered;
  f.store.advanceOwnerGeneration(projectId, objectiveId, 0);
  resolveTransport({ async sendMessage() { sends += 1; return null; }, async findByContext() { return null; } });
  await assert.rejects(pending, { code: 'owner_generation_stale' });
  assert.equal(sends, 0);
  assert.equal(executor.getAttempt(f.claims[0].attempt.attemptId).state, 'intent');
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('settings drift is rejected by the durable settings pin before any intent', async (t) => {
  let calls = 0;
  let requestCalls = 0;
  const f = fixture();
  const executor = new TaskExecutor({
    backlogStore: f.store, db: f.db, transportFor: async () => f.transport,
    settingsFor: async () => ({ model: ++calls === 1 ? 'model-a' : 'model-b', effort: 'high', fast: false }),
    roleFor: (id) => ({ id, sandbox: 'writable' }),
    requestAdapter: ({ task: value }) => {
      requestCalls += 1;
      if (requestCalls === 1) throw Object.assign(new Error('stop after pin'), { code: 'adapter_stop' });
      return { request: { objective: value.objective, allowedFiles: value.productWritePaths } };
    },
    resultAdapter: async () => ({}), now: () => clock,
  });
  t.after(() => f.db.close());
  await assert.rejects(executor.execute(f.identity(f.claims[0])), { code: 'adapter_stop' });
  await assert.rejects(executor.execute(f.identity(f.claims[0])), { code: 'selected_settings_conflict' });
  assert.equal(f.sends.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_executor_attempts').get().n, 0);
});

test('shared transport failure marks every associated attempt uncertain and retains claims', async (t) => {
  const f = fixture({ count: 2, roleCapacity: 2, transport: { async sendMessage() { throw new Error('shared process exited'); }, async findByContext() { throw new Error('not available'); } } });
  t.after(() => f.db.close());
  for (const claim of f.claims) await f.executor.execute(f.identity(claim));
  const attempts = f.db.prepare('SELECT attempt_id FROM task_executor_attempts ORDER BY attempt_id').all();
  assert.equal(attempts.length, 2);
  assert.equal(f.executor.transportFailed(`project:${projectId}`, new Error('transport died')).length, 2);
  assert.deepEqual(f.db.prepare('SELECT DISTINCT state FROM task_executor_attempts').all().map((row) => row.state), ['uncertain']);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 2);
  for (const row of attempts) assert.ok(f.executor.listEvidence(row.attempt_id).some((item) => item.kind === 'shared_transport_failed'));
});

test('shared resolver failures in poll, reconcile, and abort fan out to sibling attempts', async (t) => {
  for (const method of ['poll', 'reconcile', 'abort']) {
    const transport = method === 'reconcile'
      ? { async sendMessage() { throw new Error('send uncertain'); }, async findByContext() { throw new Error('lookup unavailable'); } }
      : undefined;
    const f = fixture({ count: 2, roleCapacity: 2, transport });
    for (const claim of f.claims) await f.executor.execute(f.identity(claim));
    f.executor.transportFor = async () => { throw Object.assign(new Error('resolver shared death'), { sharedTransportFailure: true }); };
    assert.equal((await f.executor[method](f.identity(f.claims[0]))).state, 'unknown', method);
    assert.deepEqual(f.db.prepare('SELECT DISTINCT state FROM task_executor_attempts').all().map((row) => row.state), ['uncertain'], method);
    assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 2, method);
    for (const claim of f.claims) assert.ok(f.executor.listEvidence(claim.attempt.attemptId).some((item) => item.kind === 'shared_transport_failed'), method);
    f.db.close();
  }
});

test('a shared transport death automatically fences siblings and blocks later sends', async (t) => {
  let sends = 0;
  const f = fixture({ count: 2, roleCapacity: 2, transport: {
    async sendMessage() {
      sends += 1;
      throw Object.assign(new Error('shared process exited'), { sharedTransportFailure: true });
    },
    async findByContext() { throw new Error('transport unavailable'); },
  } });
  t.after(() => f.db.close());
  assert.equal((await f.executor.execute(f.identity(f.claims[0]))).state, 'unknown');
  assert.equal((await f.executor.execute(f.identity(f.claims[1]))).reason, 'shared_transport_failed');
  assert.equal(sends, 1);
  assert.deepEqual(f.db.prepare('SELECT DISTINCT state FROM task_executor_attempts').all().map((row) => row.state), ['uncertain']);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 2);
  for (const claim of f.claims) assert.ok(f.executor.listEvidence(claim.attempt.attemptId).some((item) => item.kind === 'shared_transport_failed'));
});

test('abort only requests cancellation and cannot claim quiescence', async (t) => {
  let cancels = 0;
  const f = fixture({ transport: { async sendMessage({ message }) { return { id: 'remote-abort', contextId: message.contextId }; }, async cancel() { cancels += 1; } } });
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  await f.executor.execute(id);
  assert.deepEqual(await f.executor.abort(id), { state: 'unknown', reason: 'remote_and_process_quiescence_unconfirmed' });
  assert.equal(cancels, 1);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('expired and generation-taken-over attempts settle only through explicit trusted reconciliation', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const id = f.identity(f.claims[0]);
  const submitted = await f.executor.execute(id);
  assert.equal(submitted.state, 'submitted');
  f.store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
  f.store.advanceOwnerGeneration(projectId, objectiveId, 0);
  await assert.rejects(f.executor.acceptTerminal(id, {
    id: submitted.externalTaskId,
    contextId: submitted.contextId,
    status: { state: 'COMPLETED' },
  }), { code: 'owner_generation_stale' });
  const recovered = await f.executor.acceptTerminal({ ...id, recoveryGeneration: 1 }, {
    id: submitted.externalTaskId,
    contextId: submitted.contextId,
    status: { state: 'COMPLETED' },
  });
  assert.equal(recovered.state, 'succeeded');
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
});

test('restart recovery releases and requeues only with exact synchronous no-effect proof', (t) => {
  let proofs = 0;
  const f = fixture({ recoveryProofAdapter: ({ identity: value, attempt, claim, intent }) => {
    proofs += 1;
    assert.equal(intent, null);
    return { projectId, objectiveId, taskId: value.taskId, attemptId: value.attemptId,
      fencingToken: value.fencingToken, claimOwnerGeneration: claim.ownerGeneration,
      recoveryGeneration: value.recoveryGeneration, providerContextId: attempt.providerContextId,
      intentState: null, noEffect: true, remoteQuiescent: true, processQuiescent: true,
      effectsSettled: true, evidenceRefs: ['test:no-effect'] };
  } });
  t.after(() => f.db.close());
  const prior = f.identity(f.claims[0]);
  f.store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
  f.store.advanceOwnerGeneration(projectId, objectiveId, 0);
  const result = f.executor.recover({ ...prior, recoveryGeneration: 1 });
  assert.equal(result.state, 'no_effect_requeued');
  assert.equal(proofs, 1);
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
  assert.equal(f.store.getObjective(projectId, objectiveId).tasks[0].state, 'queued');
  const [next] = f.store.claimReady(projectId, objectiveId, 1, { controlRevision: 1, limit: 1 });
  assert.ok(next);
  assert.notEqual(next.attempt.attemptId, prior.attemptId);
  assert.equal(next.claim.fencingToken > prior.fencingToken, true);
});

test('missing, asynchronous, or mismatched recovery proof keeps claim and fence held', (t) => {
  const f = fixture({ recoveryProofAdapter: () => Promise.resolve(true) });
  t.after(() => f.db.close());
  const prior = f.identity(f.claims[0]);
  f.store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
  f.store.advanceOwnerGeneration(projectId, objectiveId, 0);
  const result = f.executor.recover({ ...prior, recoveryGeneration: 1 });
  assert.deepEqual(result, { state: 'unknown', reason: 'recovery_proof_must_be_synchronous' });
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
  assert.equal(f.store.listClaims(projectId, objectiveId)[0].state, 'expired');
  assert.equal(f.sends.length, 0);

  f.executor.recoveryProofAdapter = ({ identity: value, attempt, claim, intent }) => ({
    projectId, objectiveId, taskId: value.taskId, attemptId: value.attemptId, fencingToken: value.fencingToken + 1,
    claimOwnerGeneration: claim.ownerGeneration, recoveryGeneration: value.recoveryGeneration,
    providerContextId: attempt.providerContextId, intentState: intent?.state || null,
    noEffect: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: ['test:wrong-fence'],
  });
  const rejected = f.executor.recover({ ...prior, recoveryGeneration: 1 });
  assert.equal(rejected.state, 'unknown');
  assert.equal(rejected.reason, 'recovery_proof_rejected');
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('repeated exact no-effect recovery ends in durable blocked_technical', (t) => {
  const f = fixture({ maxRecoveryRetries: 1, recoveryProofAdapter: ({ identity: value, attempt, claim, intent }) => ({
    projectId, objectiveId, taskId: value.taskId, attemptId: value.attemptId, fencingToken: value.fencingToken,
    claimOwnerGeneration: claim.ownerGeneration, recoveryGeneration: value.recoveryGeneration,
    providerContextId: attempt.providerContextId, intentState: intent?.state || null,
    noEffect: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: ['test:no-effect'],
  }) });
  t.after(() => f.db.close());
  const prior = f.identity(f.claims[0]);
  f.store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
  f.store.advanceOwnerGeneration(projectId, objectiveId, 0);
  const result = f.executor.recover({ ...prior, recoveryGeneration: 1 });
  assert.equal(result.state, 'blocked_technical');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'blocked_technical');
  assert.equal(f.store.getObjective(projectId, objectiveId).tasks[0].state, 'blocked');
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
});

test('exhausted recovery blocks only its task while a ready sibling remains claimable', (t) => {
  const f = fixture({ maxRecoveryRetries: 1, recoveryProofAdapter: ({ identity: value, attempt, claim, intent }) => ({
    projectId, objectiveId, taskId: value.taskId, attemptId: value.attemptId, fencingToken: value.fencingToken,
    claimOwnerGeneration: claim.ownerGeneration, recoveryGeneration: value.recoveryGeneration,
    providerContextId: attempt.providerContextId, intentState: intent?.state || null,
    noEffect: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: ['test:no-effect'],
  }) });
  t.after(() => f.db.close());
  const current = f.store.getObjective(projectId, objectiveId);
  f.store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: current.planRevision,
    expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1,
    tasks: [{ task: task('task-sibling') }], dependencies: [] });
  const prior = f.identity(f.claims[0]);
  f.store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
  f.store.advanceOwnerGeneration(projectId, objectiveId, 0);
  const result = f.executor.recover({ ...prior, recoveryGeneration: 1 });
  assert.equal(result.state, 'task_blocked');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'executing');
  assert.equal(f.store.getObjective(projectId, objectiveId).tasks.find((entry) => entry.taskId === prior.taskId).state, 'blocked');
  assert.equal(f.store.projectCapacity(projectId, objectiveId).active, 0);
  const [sibling] = f.store.claimReady(projectId, objectiveId, 1, { controlRevision: 1, limit: 1 });
  assert.equal(sibling.task.taskId, 'task-sibling');
  const recoveryEvent = f.store.events.replay(projectId).find((event) => event.eventType === 'attempt.recovery_task_blocked');
  assert.equal(recoveryEvent.payload.taskBlocked, true);
  assert.equal(recoveryEvent.payload.objectiveBlocked, false);
});
