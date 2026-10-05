'use strict';

// SUP-03: App Server recovery cannot bypass writer reconciliation. A real CodexAppServer (fake
// child, fake supervisor clock) runs under the real specialist executor, writer admission and
// lead graph. Contracts: docs/supervisor-recovery-contract.md, docs/intent-recovery-contract.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskState } = require('@a2a-js/sdk');
const { createStack, bindable } = require('./helpers/supervisor-stack');

const metaOf = (task) => task.status?.message?.metadata || {};
const settle = (promise) => promise.then((task) => ({ task }), (error) => ({ error }));

// Two read-only turns and one writer turn in flight on the one shared process (generation 1).
async function startSharedLoad(stack) {
  const reads = [
    settle(stack.send('orch-explorer', 'read one')),
    settle(stack.send('orch-architect', 'read two')),
  ];
  await stack.untilTurnStarts(2);
  const writer = settle(stack.send('orch-builder', 'write one'));
  await stack.untilTurnStarts(3);
  return { reads, writer };
}

test('SUP-03 case 1: a shared process failure accounts for every turn and keeps the writer held', async (t) => {
  const stack = await createStack(t, { behavior: { 'orch-explorer': 'hang', 'orch-architect': 'hang', 'orch-builder': 'hang' } });
  const { reads, writer } = await startSharedLoad(stack);
  assert.equal(stack.children.length, 1);
  assert.equal(stack.world.turnStartsOf(1).length, 3);

  await stack.crash();
  const [readOne, readTwo] = await Promise.all(reads);
  const written = await writer;

  for (const { task, error } of [readOne, readTwo]) {
    assert.equal(error, undefined);
    assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    assert.equal(metaOf(task).failureKind, 'interrupted'); // sent turn/start, no terminal event
    assert.match(task.status.message.parts[0].content.value, /exited unexpectedly/);
    assert.equal(metaOf(task).writerExecution, undefined);
  }

  assert.equal(written.error, undefined);
  assert.equal(written.task.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(metaOf(written.task).failureKind, 'interrupted');
  const execution = metaOf(written.task).writerExecution;
  assert.equal(execution.state, 'unresolved');
  assert.equal(execution.reason, 'outcome_unknown');
  assert.equal(stack.admission.get(execution.executionId).state, 'unresolved');
  assert.equal(stack.admission.holder().executionId, execution.executionId);
  assert.equal(stack.appServer.supervisorState().chargedInWindow, 1);
  assert.deepEqual(stack.kinds().filter((kind) => kind === 'started' || kind === 'exited'), ['started', 'exited']);

  // Held: a second writer is refused, nothing is spawned, and no turn starts.
  const refused = await stack.send('orch-builder', 'write two');
  assert.equal(refused.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(metaOf(refused).failureKind, 'admission_blocked');
  assert.equal(metaOf(refused).effects, 'none');
  assert.equal(metaOf(refused).admission.holder.executionId, execution.executionId);
  assert.equal(stack.children.length, 1);
  assert.equal(stack.world.turnStarts.length, 3);
  assert.equal(stack.admission.holder().state, 'unresolved');

  // Only proven quiescence releases the workspace.
  stack.quiescence.gone = true;
  const outcome = await stack.admission.reconcile(execution.executionId);
  assert.equal(outcome.state, 'reconciled');
  assert.equal(stack.admission.holder(), null);
});

test('SUP-03 case 1b: a writer that never sent turn/start is released at once with its siblings failed', async (t) => {
  const stack = await createStack(t, {
    behavior: { 'orch-explorer': 'hang', 'orch-architect': 'hang' },
    stallThreadStart: ['orch-builder'],
  });
  const reads = [
    settle(stack.send('orch-explorer', 'read one')),
    settle(stack.send('orch-architect', 'read two')),
  ];
  await stack.untilTurnStarts(2);
  const writer = settle(stack.send('orch-builder', 'write one'));
  for (let i = 0; i < 40 && !stack.children[0].sent.some((m) => m.method === 'thread/start' && /instr:orch-builder/.test(m.params.developerInstructions)); i += 1) await stack.clock.flush();
  assert.ok(stack.admission.holder(), 'the writer holds admission while waiting for its thread');
  assert.equal(stack.world.turnStarts.length, 2);

  await stack.crash();
  const [readOne, readTwo] = await Promise.all(reads);
  for (const { task } of [readOne, readTwo]) assert.equal(metaOf(task).failureKind, 'interrupted');

  const { task, error } = await writer;
  assert.equal(error, undefined);
  assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
  assert.notEqual(metaOf(task).failureKind, 'interrupted');
  assert.equal(metaOf(task).writerExecution.state, 'released');
  assert.equal(stack.admission.holder(), null);
  assert.equal(stack.admission.get(metaOf(task).writerExecution.executionId).state, 'released');
  assert.equal(stack.world.turnStarts.length, 2);
});

test('SUP-03 case 2: the next call spawns generation 2 and nothing from generation 1 is re-sent', async (t) => {
  const stack = await createStack(t, { behavior: { 'orch-explorer': 'hang', 'orch-architect': 'hang', 'orch-builder': 'hang' } });
  const { reads, writer } = await startSharedLoad(stack);
  assert.equal(stack.appServer.supervisorState().generation, 1);
  await stack.crash();
  await Promise.all([...reads, writer]);
  assert.equal(stack.children.length, 1, 'replacement is lazy: no spawn without a caller');

  stack.world.behavior['orch-explorer'] = 'complete';
  const next = await stack.send('orch-explorer', 'read three');
  assert.equal(next.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(stack.children.length, 2);
  const state = stack.appServer.supervisorState();
  assert.equal(state.generation, 2);
  assert.equal(state.state, 'running');

  // Per-generation turn/start accounting: generation 1 kept its three, generation 2 only the new call.
  assert.equal(stack.world.turnStartsOf(1).length, 3);
  const second = stack.world.turnStartsOf(2);
  assert.equal(second.length, 1);
  assert.match(second[0].input, /read three/);
  assert.equal(stack.world.turnStarts.filter((entry) => /write one/.test(entry.input)).length, 1);
  assert.equal(stack.children[1].sent.filter((m) => m.method === 'turn/start').length, 1);

  // The run result of the new generation carries its generation.
  const probe = await stack.appServer.run({
    role: { name: 'orch-explorer', sandbox: 'read-only', instructions: 'instr:orch-explorer' }, cwd: stack.workspace, input: 'direct probe',
  });
  assert.equal(probe.execution.generation, 2);
  assert.equal(stack.world.turnStartsOf(2).length, 2);
  assert.equal(stack.world.turnStartsOf(1).length, 3);
  assert.equal(stack.admission.holder().state, 'unresolved', 'recovery did not release the writer');
});

test('SUP-03 case 3: a resumed lead flow pauses on the unresolved writer and never re-dispatches it', { timeout: 30_000 }, async (t) => {
  if (!(await bindable())) { t.skip('loopback binding is not permitted in this environment'); return; }
  const brief = (roleName, extra = {}) => ({
    role: roleName,
    objective: `Objective for ${roleName}`,
    allowedFiles: roleName === 'orch-builder' ? ['src/example.js'] : [],
    inputs: ['User goal'],
    evidence: ['Existing project files'],
    acceptanceCriteria: ['The result meets the stated goal'],
    checks: ['Review the changed files'],
    stopConditions: ['Stop if another file is required'],
    ...extra,
  });
  const decision = (fields) => ({ action: 'finish', assignments: [], final: '', resolutions: [], humanInput: null, ...fields });
  const stack = await createStack(t, {
    http: true,
    leadScript: [
      decision({ action: 'dispatch', assignments: [brief('orch-builder', { objective: 'Write the feature' })] }),
      decision({ action: 'dispatch', assignments: [brief('orch-explorer', { objective: 'Follow-up read' })] }),
      decision({ action: 'finish', final: 'All settled' }),
    ],
    behavior: { 'orch-builder': 'hang', 'orch-explorer': 'hang', 'orch-architect': 'hang' },
  });
  const running = stack.orchestrator.run({ goal: 'Build the feature', runId: 'run-1' });
  await stack.untilTurnStarts(2); // lead turn, then the lead's writer assignment
  const reads = [settle(stack.send('orch-explorer', 'read one')), settle(stack.send('orch-architect', 'read two'))];
  await stack.untilTurnStarts(4);
  assert.deepEqual(stack.world.turnStarts.map((entry) => entry.generation), [1, 1, 1, 1]);
  await stack.crash();
  for (const { task } of await Promise.all(reads)) assert.equal(metaOf(task).failureKind, 'interrupted');

  // The lead sees the writer as interrupted with unknown effects; the run pauses, nothing else is sent.
  const paused = await running;
  assert.equal(paused.status, 'input_required');
  assert.equal(paused.pause.kind, 'writer_unresolved');
  const { values } = await stack.orchestrator.graph.getState({ configurable: { thread_id: 'run-1' } });
  const writerOutcome = values.outcomes.find((outcome) => outcome.sandbox === 'workspace-write');
  assert.ok(writerOutcome, 'the writer outcome is recorded');
  assert.equal(writerOutcome.failureKind, 'interrupted');
  assert.equal(writerOutcome.writerExecution.state, 'unresolved');
  assert.equal(values.unresolvedWriters.length, 1);
  assert.equal(values.unresolvedWriters[0].cause, 'interrupted');
  assert.equal(stack.world.leadPrompts.length, 1, 'the lead is not asked again while the writer is unresolved');
  assert.equal(stack.children.length, 1);

  // Resuming while the workspace is not proven quiescent keeps the pause; no spawn, no dispatch.
  const still = await stack.orchestrator.resume({ runId: 'run-1', input: { answer: 'retry' } });
  assert.equal(still.pause.kind, 'writer_unresolved');
  assert.equal(stack.world.leadPrompts.length, 1);
  assert.equal(stack.children.length, 1);
  assert.equal(stack.world.turnStarts.length, 4);

  // Quiescence proven: reconciliation settles the writer; the lead then decides on generation 2.
  stack.quiescence.gone = true;
  stack.world.behavior['orch-explorer'] = 'complete';
  const result = await stack.orchestrator.resume({ runId: 'run-1', input: { answer: 'retry' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'All settled');
  assert.equal(stack.admission.holder(), null);
  assert.equal(stack.appServer.supervisorState().generation, 2);
  const reconciliation = result.assignments.find((outcome) => outcome.kind === 'reconciliation');
  assert.ok(reconciliation, 'a reconciliation outcome is recorded');
  assert.equal(reconciliation.state, 'reconciled');
  assert.match(stack.world.leadPrompts[1], /interrupted|outcome_unknown/);
  assert.match(stack.world.leadPrompts[1], /reconcil/i);

  // Only what the lead decided was dispatched: the writer assignment ran once, on generation 1.
  const writes = stack.world.turnStarts.filter((entry) => /Write the feature/.test(entry.input));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].generation, 1);
  const generationTwo = stack.world.turnStartsOf(2);
  assert.deepEqual(generationTwo.map((entry) => entry.kind), ['lead', 'worker', 'lead']);
  assert.match(generationTwo[1].input, /Follow-up read/);
  assert.equal(generationTwo[1].role, 'orch-explorer');
  assert.equal(generationTwo.some((entry) => /Write the feature/.test(entry.input)), false);
});

test('SUP-03 case 4: an exhausted supervisor fails specialists fast with effects none, then a probe recovers', async (t) => {
  const stack = await createStack(t, { behavior: { 'orch-explorer': 'complete', 'orch-builder': 'complete' } });
  const { clock, appServer } = stack;

  // Four charged endings inside the window: the 1st respawns at once, then 1000 ms, 4000 ms, then exhaustion.
  await appServer.start();
  for (let i = 0; i < 4; i += 1) {
    await stack.crash();
    if (i < 3) {
      const restarting = appServer.start();
      await clock.advance(4_000);
      await restarting;
    }
  }
  const exhausted = appServer.supervisorState();
  assert.equal(exhausted.state, 'exhausted');
  assert.equal(exhausted.chargedInWindow, 4);
  assert.equal(stack.children.length, 4);

  const read = await stack.send('orch-explorer', 'read while exhausted');
  assert.equal(read.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(metaOf(read).failureKind, 'supervisor_exhausted');
  assert.equal(metaOf(read).effects, 'none');

  // A writer is admitted first, then fails fast before any turn: its outcome is known and the workspace is freed.
  const write = await stack.send('orch-builder', 'write while exhausted');
  assert.equal(write.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(metaOf(write).failureKind, 'supervisor_exhausted');
  assert.equal(metaOf(write).effects, 'none');
  assert.equal(metaOf(write).writerExecution.state, 'released');
  assert.equal(stack.admission.holder(), null);

  assert.equal(stack.children.length, 4, 'no spawn while exhausted');
  assert.equal(stack.world.turnStarts.length, 0);
  const kinds = stack.kinds();
  for (const kind of ['exited', 'backoff', 'exhausted']) assert.ok(kinds.includes(kind), `events contain ${kind}`);
  assert.equal(kinds.includes('probe'), false);

  // After the cooldown the next request is a probe; reaching running resets the budget.
  await clock.advance(60_000);
  const recovered = await stack.send('orch-explorer', 'read after cooldown');
  assert.equal(recovered.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(stack.children.length, 5);
  assert.equal(stack.world.turnStartsOf(5).length, 1);
  const after = appServer.supervisorState();
  assert.equal(after.state, 'running');
  assert.equal(after.chargedInWindow, 0);
  for (const kind of ['probe', 'recovered']) assert.ok(stack.kinds().includes(kind), `events contain ${kind}`);
});

test('SUP-03 case 5: recovery time and charged endings match the restart policy', async (t) => {
  const stack = await createStack(t, { behavior: { 'orch-explorer': 'hang' } });
  const { clock, appServer } = stack;

  // Generation 1 fails with a turn in flight; later generations fail idle.
  const inFlight = settle(stack.send('orch-explorer', 'in flight'));
  await stack.untilTurnStarts(1);
  stack.world.behavior['orch-explorer'] = 'complete';

  const measurements = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const failedAt = clock.now();
    await stack.crash();
    if (attempt === 1) assert.equal((await inFlight).task.status.state, TaskState.TASK_STATE_FAILED);
    const call = settle(stack.send('orch-explorer', `retry ${attempt}`));
    let done = false;
    call.then(() => { done = true; });
    for (let guard = 0; guard < 6_000; guard += 1) {
      await clock.flush();
      if (done) break;
      await clock.advance(1);
    }
    assert.equal(done, true, `attempt ${attempt} recovered`);
    const { task } = await call;
    assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
    measurements.push({
      attempt,
      recoveryMs: clock.now() - failedAt,
      chargedEndings: appServer.supervisorState().chargedInWindow,
      generation: appServer.supervisorState().generation,
      turnGeneration: stack.world.turnStarts.at(-1).generation,
    });
  }
  t.diagnostic(`recovery: ${JSON.stringify(measurements)}`);

  assert.deepEqual(measurements.map((entry) => entry.recoveryMs), [0, 1_000, 4_000]);
  assert.deepEqual(measurements.map((entry) => entry.chargedEndings), [1, 2, 3]);
  assert.deepEqual(measurements.map((entry) => entry.generation), [2, 3, 4]);
  assert.deepEqual(measurements.map((entry) => entry.turnGeneration), [2, 3, 4]);
  assert.equal(stack.kinds().filter((kind) => kind === 'backoff').length, 2);
});
