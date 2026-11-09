'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VERSION } = require('../../../src/delivery-contracts');
const { BacklogStore } = require('../../../src/backlog-store');
const { TaskScheduler } = require('../../../src/task-scheduler');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-capacity-race-'));
const dbPath = path.join(root, 'state.sqlite');
const db1 = new Database(dbPath); const db2 = new Database(dbPath);
const options = { roleCapacities: { explorer: 10 }, maxActiveTurns: 8, plannerReservedSlots: 1 };
const first = new BacklogStore(db1, options);
const second = new BacklogStore(db2, options);
const projectId = 'p'; const objectiveId = 'o';
first.createObjective({ projectId, objectiveId, sessionId: 's', engineVersion: VERSION, goalRevision: 1,
  requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`, authorityRevision: 1,
  controlRevision: 1, disposition: 'executing' });
const tasks = Array.from({ length: 6 }, (_, i) => ({ schemaVersion: VERSION, projectId, objectiveId,
  taskId: `task-${i}`, revision: 1, role: 'explorer', kind: 'inspection', objective: `Inspect ${i}`,
  priority: 0, dependencies: [], productWritePaths: [], readScope: { kind: 'known', paths: [] },
  scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' }));
const obj = first.getObjective(projectId, objectiveId);
first.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: obj.planRevision,
  expectedGoalRevision: obj.goalRevision, expectedAuthorityRevision: obj.authorityRevision,
  expectedControlRevision: obj.controlRevision, nextPlanRevision: obj.planRevision + 1,
  tasks: tasks.map((task) => ({ task })), dependencies: [] });
const sends = [];
const executor = { getAttempt: () => null, execute: async (id) => { sends.push(id.taskId); return { state: 'submitted' }; },
  poll: async () => ({ state: 'submitted' }), reconcile: async () => ({ state: 'unknown' }) };
const mkScheduler = (store) => new TaskScheduler({ store, executor, projectId, objectiveId,
  controllerIdentity: { ownerGeneration: 0, controlRevision: 1 }, roles: ['explorer'], roleLimits: { explorer: 10 },
  writerMode: 'shared', maxActiveTurns: 4, plannerReservedSlots: 1, pollIntervalMs: 100000 });
const runner1 = mkScheduler(first); const runner2 = mkScheduler(second);
const original = first.projectCapacity.bind(first);
let triggered = false; let nested;
first.projectCapacity = (...args) => {
  const stale = original(...args);
  if (!triggered) { triggered = true; nested = runner2.runOnce(); }
  return stale;
};
(async () => {
  await runner1.runOnce();
  await nested;
  await Promise.all([...runner1.inFlight.values(), ...runner2.inFlight.values()]);
  const active = first.projectCapacity(projectId, objectiveId).active;
  console.log(JSON.stringify({ root, active, expectedCeiling: 3, sends }));
  assert.ok(active <= 3, `runtime project ceiling exceeded: ${active} > 3`);
  runner1.stop(); runner2.stop(); db1.close(); db2.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
