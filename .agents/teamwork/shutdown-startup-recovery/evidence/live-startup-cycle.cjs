'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.cwd();
const { createProjectManager } = require(path.join(root, 'src/launcher-projects'));
const { readAuthToken } = require(path.join(root, 'src/local-auth'));
const Database = require(path.join(root, 'node_modules/better-sqlite3'));
const projectId = '3d9c2e759c';
const stateFile = path.join(root, '.runtime/projects', projectId, 'state.sqlite');
const evidenceFile = path.join(root, '.agents/teamwork/shutdown-startup-recovery/evidence/live-startup-cycle.json');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function state() {
  const db = new Database(stateFile, { readonly: true });
  try {
    return {
      taskDigest: hash(JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY tenant,owner,id').all())),
      plannerTurns: db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns ORDER BY turn_id').all(),
      phase: JSON.parse(db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(projectId).phase_json),
    };
  } finally { db.close(); }
}
(async () => {
  const manager = createProjectManager();
  await manager.init();
  if (manager.get(projectId).status !== 'stopped') throw new Error('Project is already running; refusing to take ownership');
  const before = state();
  const proof = { liveTaskSubmitted: false, autoResume: process.env.CODEX_A2A_AUTO_RESUME, before, sourceHashes: {} };
  let owned = false;
  try {
    owned = true;
    await manager.start(projectId);
    const deadline = Date.now() + 30000;
    while (manager.get(projectId).status !== 'running') {
      await manager.refresh();
      const status = manager.status(projectId);
      if (status.status === 'stopped' || Date.now() >= deadline) throw new Error(`Startup failed: ${JSON.stringify(status.startupDiagnostic)}`);
      if (status.status !== 'running') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const response = await fetch(`${manager.baseUrl(projectId)}/control/runtime`, { headers: { Authorization: `Bearer ${readAuthToken()}` } });
    if (!response.ok) throw new Error(`Runtime identity HTTP ${response.status}`);
    const runtime = await response.json();
    proof.pid = runtime.pid;
    for (const file of ['src/server.js', 'src/concurrent-delivery-engine.js', 'src/lead-planner.js', 'src/project-delivery-controller.js', 'src/app-server-switch.js']) {
      const expected = hash(fs.readFileSync(path.join(root, file)));
      proof.sourceHashes[file] = { expected, loaded: runtime.sourceHashes[file] };
      if (runtime.sourceHashes[file] !== expected) throw new Error(`Loaded source mismatch: ${file}`);
    }
    proof.running = state();
    if (proof.running.phase.phase !== 'released') throw new Error('Old shutdown phase was not released');
    if (proof.running.taskDigest !== before.taskDigest) throw new Error('Historical tasks unexpectedly changed');
    if (proof.running.plannerTurns.length !== before.plannerTurns.length) throw new Error('Unexpected model planner turn');
    if (proof.running.plannerTurns.some((turn) => turn.status !== 'reconciled_no_effect')) throw new Error('Historical planner was not reconciled');
    proof.startupRecovered = true;
  } catch (error) {
    proof.error = error.message;
    process.exitCode = 1;
  } finally {
    if (owned) await manager.stop(projectId);
    proof.afterStop = state();
    proof.statusAfterStop = manager.get(projectId).status;
    proof.cleanStop = proof.statusAfterStop === 'stopped' && proof.afterStop.phase.phase === 'released';
    if (!proof.cleanStop) process.exitCode = 1;
    fs.writeFileSync(evidenceFile, JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify({ startupRecovered: proof.startupRecovered || false, cleanStop: proof.cleanStop, historicalTasksUnchanged: proof.afterStop.taskDigest === before.taskDigest, liveTaskSubmitted: false, error: proof.error || null }));
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
