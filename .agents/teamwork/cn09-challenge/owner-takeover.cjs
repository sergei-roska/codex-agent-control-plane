'use strict';
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../../../src/backlog-store');
const { DeliveryInbox } = require('../../../src/delivery-inbox');
const { LeadPlanner } = require('../../../src/lead-planner');
const { VERSION } = require('../../../src/delivery-contracts');

const db = new Database(':memory:');
const store = new BacklogStore(db, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4 });
store.createObjective({ projectId: 'p', objectiveId: 'o', sessionId: 's', engineVersion: VERSION,
  goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`,
  checksDigest: `sha256:${'b'.repeat(64)}`, authorityRevision: 1, controlRevision: 1,
  disposition: 'planning' });
const inbox = new DeliveryInbox(db, { projectId: 'p', objectiveId: 'o', sessionId: 's' });
let entered;
let release;
const started = new Promise((resolve) => { entered = resolve; });
const barrier = new Promise((resolve) => { release = resolve; });
let modelCalls = 0;
const planner = new LeadPlanner({ store, inbox, providerThreadId: 'thread-a', runTurn: async ({ prompt }) => {
  modelCalls += 1;
  entered();
  await barrier;
  const p = prompt.pins;
  return { expected: { planRevision: p.planRevision, goalRevision: p.goalRevision,
    authorityRevision: p.authorityRevision, controlRevision: p.controlRevision, inboxVersion: p.inboxVersion },
    delta: { schemaVersion: VERSION, expectedPlanRevision: p.planRevision,
      expectedGoalRevision: p.goalRevision, expectedAuthorityRevision: p.authorityRevision,
      expectedControlRevision: p.controlRevision, nextPlanRevision: p.planRevision + 1,
      tasks: [{ task: { schemaVersion: VERSION, projectId: 'p', objectiveId: 'o', taskId: 'stale-task',
        revision: 1, role: 'engineer', kind: 'implementation', objective: 'Stale owner work',
        priority: 1, dependencies: [], productWritePaths: ['src/stale.js'],
        readScope: { kind: 'known', paths: [] }, scratchWriteRoots: ['.scratch'],
        resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' } }],
      dependencies: [] }, dialogue: 'old owner output', recovery: null, ownerDecision: null };
} });

(async () => {
  inbox.receive({ messageId: 'm1', kind: 'steering', payload: { instruction: 'Plan work' } });
  const pending = planner.run();
  await started;
  const before = store.getObjective('p', 'o');
  store.advanceOwnerGeneration('p', 'o', before.ownerGeneration);
  const takeover = store.getObjective('p', 'o');
  assert.equal(takeover.ownerGeneration, before.ownerGeneration + 1);
  assert.equal(takeover.goalRevision, before.goalRevision);
  assert.equal(takeover.controlRevision, before.controlRevision);
  release();
  const result = await pending;
  const after = store.getObjective('p', 'o');
  const message = inbox.get('m1');
  console.log(JSON.stringify({ result, ownerGeneration: after.ownerGeneration, tasks: after.tasks.map((t) => t.taskId), messageState: message.state }));
  assert.equal(result.state, 'stale', 'old owner output must not commit after takeover');
  assert.deepEqual(after.tasks, []);
  assert.equal(message.state, 'received');
  const later = await planner.run();
  console.log(JSON.stringify({ later, modelCalls, messageState: inbox.get('m1').state }));
  assert.equal(later.state, 'stale', 'old planner object must remain fenced after takeover');
  assert.equal(later.reason, 'owner_generation_changed');
  assert.equal(modelCalls, 1, 'old planner object must not call model again');
  assert.equal(inbox.get('m1').state, 'received');
  db.close();
})().catch((error) => { console.error(error); db.close(); process.exitCode = 1; });
