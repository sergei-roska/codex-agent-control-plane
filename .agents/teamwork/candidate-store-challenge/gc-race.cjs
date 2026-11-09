'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { CandidateStore } = require('../../../src/candidate-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-gc-race-'));
const workspace = path.join(root, 'repo');
const storageDir = path.join(root, 'storage');
const dbPath = path.join(root, 'state.sqlite');
fs.mkdirSync(workspace);
const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
git('init', '-q'); git('config', 'user.name', 'Probe'); git('config', 'user.email', 'probe@example.invalid');
fs.writeFileSync(path.join(workspace, 'file'), 'content\n');
git('add', '.'); git('commit', '-qm', 'base');
const db1 = new Database(dbPath); const db2 = new Database(dbPath);
const first = new CandidateStore({ db: db1, workspace, storageDir });
const second = new CandidateStore({ db: db2, workspace, storageDir });
const input = (id, generation) => ({ candidateId: id, projectId: 'p', objectiveId: 'o', integrationGeneration: generation, sourceAttemptId: `attempt-${generation}`, environmentDigest: 'a'.repeat(64), checkIdentity: 'checks' });
const original = first.createCandidate(input('first', 1));
const manifestFile = path.join(storageDir, 'manifests', original.manifestDigest);
const originalRm = fs.rmSync;
let inserted = false;
fs.rmSync = function(target, options) {
  if (target === manifestFile && !inserted) {
    inserted = true;
    const recreated = second.createCandidate(input('second', 2));
    assert.equal(recreated.manifestDigest, original.manifestDigest);
    second.addReference('second', 'receipt', 'r1');
  }
  return originalRm.call(this, target, options);
};
try {
  first.collectGarbage();
} finally { fs.rmSync = originalRm; }
assert.equal(inserted, true);
const survivor = second.get('second');
assert.equal(survivor.manifestDigest, original.manifestDigest);
let outcome;
try { second.readManifest(survivor.manifestDigest); outcome = 'readable'; }
catch (error) { outcome = `${error.code || error.name}: ${error.message}`; }
console.log(JSON.stringify({ root, survivor: survivor.candidateId, manifestExists: fs.existsSync(manifestFile), outcome }));
assert.equal(outcome, 'readable', 'retained candidate snapshot must remain readable');
const snapshotFile = path.join(storageDir, 'manifests', survivor.manifestDigest);
fs.rmSync(snapshotFile, { force: true });
db1.close(); db2.close();
const reopenedDb = new Database(dbPath);
const reopened = new CandidateStore({ db: reopenedDb, workspace, storageDir });
assert.equal(reopened.readManifest(survivor.manifestDigest).digest, survivor.manifestDigest);
assert.equal(fs.existsSync(snapshotFile), true);
fs.writeFileSync(snapshotFile, '{}');
assert.throws(() => reopened.readManifest(survivor.manifestDigest), { code: 'stored_manifest_corrupt' });
console.log(JSON.stringify({ reopened: true, missingCacheRepaired: true, corruptCacheRejected: true }));
reopenedDb.close();
