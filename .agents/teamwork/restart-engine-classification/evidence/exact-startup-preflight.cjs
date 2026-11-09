'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.cwd();
const db = new (require(path.join(root, 'node_modules/better-sqlite3')))(path.join(root, '.runtime/projects/3d9c2e759c/state.sqlite'), { readonly: true });
const projectId = '3d9c2e759c';
const taskRows = db.prepare('SELECT * FROM tasks ORDER BY id').all();
const digest = () => crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all())).digest('hex');
const before = digest();
const results = [];
for (const [label, file] of [['before', '.agents/teamwork/restart-engine-classification/evidence/baseline/server.js'], ['fixed', 'src/server.js']]) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const helpers = source.slice(source.indexOf('function storedDeliveryMappings('), source.indexOf('/** CODEX_A2A_AUTO_RESUME'));
  const legacyStart = source.indexOf('    const legacyTaskIds = new Set(', source.indexOf('async function startServer('));
  const newStart = source.indexOf('    const mappedConcurrentTaskIds = new Set(', source.indexOf('async function startServer('));
  const classification = source.slice(newStart >= 0 ? newStart : legacyStart, source.indexOf('    const canRunEngine =', legacyStart));
  const context = { db, fs, projectId, workspace: '/home/sr/Projects/Workspace/agent-harness', startupLeadTaskIds: new Set(taskRows.filter((row) => row.owner === 'orchestrator').map((row) => row.id)), TERMINAL_STORED_TASK_STATES: new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']) };
  vm.createContext(context);
  vm.runInContext(`${helpers}\nconst storedMappings = storedDeliveryMappings(db, projectId);\n${classification}\nresult = deliveryEngineFence({ db, workspace, projectId, engine: 'concurrent-v1', runId: 'read-only-no-task', legacyTaskIds });`, context);
  results.push({ label, sourceHash: crypto.createHash('sha256').update(source).digest('hex'), admission: context.result });
}
const evidence = { readOnly: true, exactProductionStartupClassification: true, results, taskRowsUnchanged: before === digest(), liveTasksSubmitted: 0, liveServicesStarted: 0 };
console.log(JSON.stringify(evidence, null, 2));
if (results[0].admission !== 'busy' || results[1].admission !== true || !evidence.taskRowsUnchanged) process.exitCode = 1;
db.close();
