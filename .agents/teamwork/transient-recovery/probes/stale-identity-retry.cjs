'use strict';
const assert = require('node:assert/strict');
const Database = require('../../../../node_modules/better-sqlite3');
const { TaskState } = require('../../../../node_modules/@a2a-js/sdk');
const { createTransientRecoveryStore, createTransientRecovery } = require('../../../../src/transient-recovery');
const { makeLeadExecutor } = require('../../../../src/server');

(async () => {
  const db = new Database(':memory:');
  const store = createTransientRecoveryStore(db);
  const recovery = createTransientRecovery({ store, canResume: async () => true, resumeRun: async () => true });
  recovery.failure('task', { category: 'capacity', cause: 'capacity', checkpointId: 'cp-current' });
  recovery.markRunning('task');
  let resumes = 0;
  const executor = makeLeadExecutor({
    transientRecovery: recovery, autoResume: true,
    orchestrator: {
      async getPause() { return null; },
      async resume() { resumes += 1; return { status: 'completed', text: 'done', rounds: 1, assignments: [] }; },
    },
  });
  const task = { id: 'task', contextId: 'ctx', status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, history: [], metadata: { pause: { kind: 'restart' } } };
  const events = [];
  await executor.execute({
    taskId: 'task', contextId: 'ctx', task,
    userMessage: { parts: [{ text: 'Continue after transient failure.' }], metadata: { autoResume: { reason: 'transient_recovery', attempt: 0, checkpointId: 'cp-stale' } } },
  }, { publish(event) { events.push(event); } });
  console.log(JSON.stringify({ currentAttempt: 1, currentCheckpoint: 'cp-current', staleAttempt: 0, staleCheckpoint: 'cp-stale', resumes, finalState: events.at(-1)?.data?.status?.state }));
  assert.equal(resumes, 0, 'stale automatic retry identity must not execute');
  recovery.stop(); db.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
