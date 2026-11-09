'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const dir = '.agents/teamwork/concurrent-resume-20261030/evidence';
const taskId = '275f8476-4379-49b4-bb06-2b8bcbff6179';
const objectiveId = 'delivery-e0f037f14a11df53bb4fd0da6f873b6c';
const db = new Database('.runtime/projects/3d9c2e759c/state.sqlite', { readonly: true });
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digests = (table, key, where = '') => Object.fromEntries(db.prepare(`SELECT * FROM ${table} ${where}`).all().map((row) => [row[key], hash(row)]));
try {
  const request = db.prepare('SELECT request_json FROM delivery_run_engines WHERE run_id=?').get(taskId);
  const target = db.prepare('SELECT record_json,owner_generation FROM backlog_objectives WHERE objective_id=?').get(objectiveId);
  const current = { capturedAt: new Date().toISOString(), otherTasks: digests('tasks', 'id', `WHERE id<>'${taskId}'`),
    otherObjectives: digests('backlog_objectives', 'objective_id', `WHERE objective_id<>'${objectiveId}'`),
    candidates: digests('candidates', 'candidate_id'), attempts: digests('backlog_attempts', 'attempt_id'),
    plannerTurns: digests('delivery_planner_turns', 'turn_id'), pinnedIntakeDigest: hash(request.request_json),
    target: { disposition: JSON.parse(target.record_json).disposition, ownerGeneration: target.owner_generation } };
  if (process.argv[2] === 'before') {
    fs.writeFileSync(`${dir}/state-before.json`, JSON.stringify(current, null, 2) + '\n');
    console.log(JSON.stringify({ saved: true, target: current.target }));
  } else {
    const before = JSON.parse(fs.readFileSync(`${dir}/state-before.json`));
    for (const key of ['otherTasks', 'otherObjectives', 'candidates', 'attempts', 'plannerTurns']) {
      for (const [id, digest] of Object.entries(before[key])) assert.equal(current[key][id], digest, `Historical ${key} ${id} changed`);
    }
    assert.equal(current.pinnedIntakeDigest, before.pinnedIntakeDigest, 'Immutable intake changed');
    assert.equal(current.target.ownerGeneration, before.target.ownerGeneration);
    assert.equal(current.target.disposition, 'accepted');
    fs.writeFileSync(`${dir}/state-after.json`, JSON.stringify(current, null, 2) + '\n');
    console.log(JSON.stringify({ historyPreserved: true, otherOwnerStatesPreserved: true, candidatePreserved: true, acceptanceContractPreserved: true, target: current.target }));
  }
} finally { db.close(); }
