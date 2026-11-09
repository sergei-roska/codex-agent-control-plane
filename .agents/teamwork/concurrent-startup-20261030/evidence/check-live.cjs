'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.cwd();
const Database = require(path.join(root, 'node_modules/better-sqlite3'));
const { readAuthToken } = require(path.join(root, 'src/local-auth'));
const directory = path.join(root, '.agents/teamwork/concurrent-startup-20261030/evidence');
const before = JSON.parse(fs.readFileSync(path.join(directory, 'live-before.json'), 'utf8'));
const projectId = '3d9c2e759c';
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function json(url, auth = false) {
  const response = await fetch(url, { headers: auth ? { Authorization: `Bearer ${readAuthToken()}` } : {}, signal: AbortSignal.timeout(10000) });
  assert.equal(response.ok, true, `HTTP ${response.status}: ${url}`);
  return response.json();
}

(async () => {
  const status = await json(`http://127.0.0.1:8081/api/projects/${projectId}/status`);
  assert.equal(status.status, 'running');
  const base = `http://127.0.0.1:${status.project.port}`;
  const runtime = await json(`${base}/control/runtime`, true);
  const engine = await json(`http://127.0.0.1:8081/api/projects/${projectId}/delivery-engine`);
  assert.equal(engine.deliveryEngine, 'concurrent-v1');
  const sourceHashes = {};
  for (const file of ['src/delivery-role-service.js', 'src/concurrent-delivery-engine.js']) {
    sourceHashes[file] = hash(fs.readFileSync(path.join(root, file)));
    assert.equal(runtime.sourceHashes[file], sourceHashes[file], `Loaded source differs: ${file}`);
  }
  const db = new Database(path.join(root, '.runtime/projects', projectId, 'state.sqlite'), { readonly: true });
  let evidence;
  try {
    const preserved = {};
    for (const [table, expected] of Object.entries(before.tables)) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      preserved[table] = { rows: rows.length, digest: hash(JSON.stringify(rows)) };
      assert.deepEqual(preserved[table], expected, `Historical ${table} changed`);
    }
    const objectives = db.prepare('SELECT record_json,owner_generation FROM backlog_objectives').all().map((row) => {
      const record = JSON.parse(row.record_json);
      return { objectiveId: record.objectiveId, disposition: record.disposition, ownerGeneration: row.owner_generation, controlRevision: record.controlRevision };
    });
    assert.deepEqual(JSON.parse(JSON.stringify(objectives)), before.objectives, 'Owner dispositions changed');
    const phase = JSON.parse(db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(projectId).phase_json);
    assert.equal(phase.phase, 'released');
    const latest = db.prepare('SELECT run_id FROM concurrent_delivery_runs WHERE objective_id=?').get('delivery-e0f037f14a11df53bb4fd0da6f873b6c');
    const control = await json(`${base}/control/delivery/${latest.run_id}`, true);
    evidence = { capturedAt: new Date().toISOString(), projectId, pid: runtime.pid, port: status.project.port, engine, sourceHashes, preserved, objectives, phase: phase.phase, control, liveTasksSubmitted: 0, manualDatabaseEdits: false };
  } finally {
    db.close();
  }
  fs.writeFileSync(path.join(directory, 'live-after.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ready: true, pid: evidence.pid, port: evidence.port, engine: evidence.engine.deliveryEngine, phase: evidence.phase, historyPreserved: true, ownerPausesPreserved: true, liveTasksSubmitted: 0 }));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
