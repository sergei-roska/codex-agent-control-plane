'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { CandidateStore, captureManifest } = require('../src/candidate-store');
const { validateCandidate } = require('../src/delivery-contracts');

const ENV_1 = 'a'.repeat(64);
const ENV_2 = 'b'.repeat(64);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-store-'));
  const workspace = path.join(root, 'repo');
  const storageDir = path.join(root, 'state', 'candidates');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Candidate Test');
  git('config', 'user.email', 'candidate@example.invalid');
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'base\n');
  fs.mkdirSync(path.join(workspace, 'bin'));
  fs.writeFileSync(path.join(workspace, 'bin', 'tool'), Buffer.from([0, 1, 2, 255]));
  fs.chmodSync(path.join(workspace, 'bin', 'tool'), 0o755);
  git('add', '.'); git('commit', '-qm', 'base');
  const dbPath = path.join(root, 'state.sqlite');
  const db = new Database(dbPath);
  const admission = {
    calls: 0, unresolved: new Set(),
    async acquire({ taskId }) { this.calls += 1; return { executionId: `exec-${this.calls}`, projectId: 'project-1', objectiveId: 'objective-1', attemptId: taskId, fencingToken: 2 }; },
    async release(id) { this.unresolved.delete(id); return { state: 'released' }; },
    markUnresolved(id) { this.unresolved.add(id); },
    async reconcile(id) { this.unresolved.delete(id); return { state: 'reconciled' }; },
    findByContextId(contextId) {
      const match = /^intent-(\d+)$/.exec(contextId);
      return match ? { executionId: `exec-${Number(match[1])}`, state: this.unresolved.has(`exec-${Number(match[1])}`) ? 'unresolved' : 'active' } : null;
    },
  };
  const config = { db, workspace, storageDir, admission, controls: ({ projectId, objectiveId, attemptId }) => ({ allowed: true, fenced: false, projectId, objectiveId, attemptId, controlRevision: 7, fencingToken: 2 }), quiescence: async () => true };
  return { root, workspace, storageDir, dbPath, db, git, admission, config };
}

function baseCandidate(store, extra = {}) {
  return store.createCandidate({ candidateId: 'candidate-1', projectId: 'project-1', objectiveId: 'objective-1',
    integrationGeneration: 1, sourceAttemptId: 'attempt-1', environmentDigest: ENV_1, checkIdentity: 'checks-1', ...extra });
}

function expectedAfter(fx) {
  const copy = path.join(fx.root, 'expected');
  fs.cpSync(fx.workspace, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'tracked.txt'), 'integrated\n');
  fs.writeFileSync(path.join(copy, 'new.bin'), Buffer.from([4, 0, 255]));
  fs.unlinkSync(path.join(copy, 'bin', 'tool'));
  const expected = captureManifest(copy);
  fs.rmSync(copy, { recursive: true, force: true });
  return expected;
}

function publishInput(expected, overrides = {}) {
  return { intentId: 'intent-1', candidateId: 'candidate-2', baseCandidateId: 'candidate-1',
    sourceAttemptId: 'attempt-2', integrationGeneration: 2, environmentDigest: ENV_2, checkIdentity: 'checks-2',
    expectedManifest: expected, deltaPaths: ['tracked.txt', 'new.bin', 'bin/tool'], ...overrides };
}

test('captures full source and keeps content-addressed review copy frozen', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(fx.workspace, 'untracked.dat'), Buffer.from([0, 255, 7]));
  const store = new CandidateStore(fx.config);
  const candidate = baseCandidate(store);
  const projected = store.projectDeliveryCandidate(candidate.candidateId);
  assert.doesNotThrow(() => validateCandidate(projected));
  assert.equal(projected.schemaVersion, 'delivery/v1');
  assert.equal(projected.contentManifestDigest, `sha256:${candidate.manifestDigest}`);
  assert.equal(Object.hasOwn(projected, 'checkIdentity'), false);
  const manifest = store.readManifest(candidate.manifestDigest);
  assert.deepEqual(manifest.entries.map((entry) => entry.path), ['bin/tool', 'tracked.txt', 'untracked.dat']);
  fs.writeFileSync(path.join(fx.workspace, 'tracked.txt'), 'later edit\n');
  const destination = path.join(fx.root, 'review-copy');
  store.materialize(candidate.candidateId, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'tracked.txt'), 'utf8'), 'base\n');
  assert.deepEqual(fs.readFileSync(path.join(destination, 'untracked.dat')), Buffer.from([0, 255, 7]));
  const executableMode = fs.statSync(path.join(destination, 'bin', 'tool')).mode;
  assert.equal(executableMode & 0o111 ? true : false, true);
  assert.equal(executableMode & 0o222 ? true : false, false);
});

test('rejects escapes, symlinks, special submodule modes and tampered content', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  assert.throws(() => require('../src/candidate-store').validateManifest({ format: 'candidate-manifest-v1', head: null, entries: [{ path: '../escape', mode: '100644', size: 0, digest: '0'.repeat(64) }], digest: '0'.repeat(64) }), { code: 'path_unsafe' });
  fs.symlinkSync(path.join(fx.root, 'outside'), path.join(fx.workspace, 'link'));
  assert.throws(() => captureManifest(fx.workspace), { code: 'symlink_unsupported' });
  fs.unlinkSync(path.join(fx.workspace, 'link'));
  const head = execFileSync('git', ['-C', fx.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fx.git('update-index', '--add', '--cacheinfo', `160000,${head},submodule`);
  assert.throws(() => captureManifest(fx.workspace), { code: 'submodule_unsupported' });
  fx.git('update-index', '--force-remove', 'submodule');
  const store = new CandidateStore(fx.config);
  const candidate = baseCandidate(store);
  fs.writeFileSync(path.join(fx.storageDir, 'blobs', store.readManifest(candidate.manifestDigest).entries[0].digest), 'tampered');
  assert.throws(() => store.materialize(candidate.candidateId, path.join(fx.root, 'copy')), { code: 'stored_content_corrupt' });
});

test('retains parent lineage and references through garbage collection', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const store = new CandidateStore(fx.config);
  const parent = baseCandidate(store);
  store.addReference(parent.candidateId, 'receipt', 'receipt-1');
  fs.writeFileSync(path.join(fx.workspace, 'tracked.txt'), 'child\n');
  const child = store.createCandidate({ candidateId: 'candidate-2', projectId: 'project-1', objectiveId: 'objective-1',
    parentCandidateId: parent.candidateId, integrationGeneration: 2, sourceAttemptId: 'attempt-2', environmentDigest: ENV_1, checkIdentity: 'checks-1' });
  store.addReference(child.candidateId, 'receipt', 'receipt-child');
  assert.equal(store.collectGarbage().length, 0);
  assert.equal(store.get(parent.candidateId).candidateId, parent.candidateId);
  assert.equal(store.get(child.candidateId).parentCandidateId, parent.candidateId);
  store.removeReference(child.candidateId, 'receipt', 'receipt-child');
  assert.equal(store.collectGarbage().length, 1);
  assert.equal(store.get(child.candidateId), null);
  assert.equal(store.get(parent.candidateId).candidateId, parent.candidateId);
  store.removeReference(parent.candidateId, 'receipt', 'receipt-1');
  assert.equal(store.collectGarbage().length, 1);
  assert.equal(store.get(parent.candidateId), null);
  assert.throws(() => store.createCandidate({ candidateId: 'candidate-3', projectId: 'project-1', objectiveId: 'objective-1',
    integrationGeneration: 2, sourceAttemptId: 'attempt-3', environmentDigest: ENV_1, checkIdentity: 'checks-1' }), { code: 'generation_not_monotonic' });
});

test('candidate row and synchronous event hook commit atomically', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const store = new CandidateStore({ ...fx.config, eventHook: () => {
    fx.db.prepare('INSERT INTO missing_event_table(value) VALUES(?)').run('candidate event');
  } });
  assert.throws(() => baseCandidate(store));
  assert.equal(store.get('candidate-1'), null);
});

test('rejects invalid environment digests and candidate identity conflicts before apply', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  let calls = 0;
  const store = new CandidateStore({ ...fx.config, apply: async () => { calls += 1; } });
  baseCandidate(store);
  const input = publishInput(expectedAfter(fx));
  await assert.rejects(() => store.publish({ ...input, environmentDigest: 'env-invalid' }), { code: 'digest_invalid' });
  await assert.rejects(() => store.publish({ ...input, candidateId: 'candidate-1' }), { code: 'candidate_identity_collision' });
  assert.equal(calls, 0);
  assert.throws(() => store.createCandidate({ candidateId: 'candidate-invalid-env', projectId: 'project-1', objectiveId: 'objective-1',
    integrationGeneration: 2, parentCandidateId: 'candidate-1', sourceAttemptId: 'attempt-2', environmentDigest: 'env-invalid', checkIdentity: 'checks-2' }), { code: 'digest_invalid' });
});

test('rejects malformed control revision and fencing pins before admission', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  let pins = { controlRevision: 1, fencingToken: 2 };
  const store = new CandidateStore({ ...fx.config,
    controls: (identity) => ({ allowed: true, fenced: false, ...identity, ...pins }),
    apply: async () => { assert.fail('apply must not run'); },
  });
  baseCandidate(store);
  const input = publishInput(expectedAfter(fx));
  for (const invalid of [
    { controlRevision: '1', fencingToken: 2 },
    { controlRevision: -1, fencingToken: 2 },
    { controlRevision: 1, fencingToken: '2' },
    { controlRevision: 1, fencingToken: 0 },
  ]) {
    pins = invalid;
    await assert.rejects(() => store.publish(input), { code: 'publication_controls_denied_or_unknown' });
  }
  assert.equal(fx.admission.calls, 0);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM candidate_intents').get().count, 0);
});

test('refuses stale base and control changes without attributing owner edits', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  let control = null;
  const store = new CandidateStore({ ...fx.config, controls: (identity) => control ?? { allowed: true, fenced: false, ...identity, controlRevision: 1, fencingToken: 2 }, apply: async () => { assert.fail('apply must not run'); } });
  baseCandidate(store);
  const expected = expectedAfter(fx);
  fs.writeFileSync(path.join(fx.workspace, 'owner.txt'), 'owner edit\n');
  const result = await store.publish(publishInput(expected));
  assert.equal(result.state, 'refused');
  assert.equal(store.get('candidate-2'), null);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'owner.txt'), 'utf8'), 'owner edit\n');
  assert.equal(store.getIntent('intent-1').state, 'refused');
});

test('journals before apply, reconciles after restart, and applies once', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  let calls = 0;
  const store = new CandidateStore({ ...fx.config, apply: async ({ onSpawn }) => {
    calls += 1; onSpawn({ pid: 41, pgid: 41 });
    fs.writeFileSync(path.join(fx.workspace, 'tracked.txt'), 'integrated\n');
    fs.writeFileSync(path.join(fx.workspace, 'new.bin'), Buffer.from([4, 0, 255]));
    fs.unlinkSync(path.join(fx.workspace, 'bin', 'tool'));
    throw new Error('simulated crash after effect');
  } });
  baseCandidate(store);
  const expected = expectedAfter(fx);
  const input = publishInput(expected);
  const result = await store.publish(input);
  assert.equal(result.state, 'unknown');
  assert.equal(store.getIntent('intent-1').state, 'unknown');
  const pinned = fx.db.prepare(`SELECT project_id,objective_id,candidate_id,parent_candidate_id,attempt_id,integration_generation,
    environment_digest,check_identity,content_manifest_digest FROM candidate_intents WHERE intent_id=?`).get('intent-1');
  assert.deepEqual(pinned, { project_id: 'project-1', objective_id: 'objective-1', candidate_id: 'candidate-2',
    parent_candidate_id: 'candidate-1', attempt_id: 'attempt-2', integration_generation: 2,
    environment_digest: ENV_2, check_identity: 'checks-2', content_manifest_digest: expected.digest });
  assert.equal(fx.admission.unresolved.has('exec-1'), true);
  let quiet = true;
  const restarted = new CandidateStore({ ...fx.config, quiescence: async () => quiet, apply: async () => { calls += 100; } });
  await assert.rejects(() => restarted.reconcile('intent-1', { candidate: { ...input, integrationGeneration: 9, environmentDigest: 'c'.repeat(64), checkIdentity: 'check-forged' }, integrationGeneration: 9 }), { code: 'candidate_intent_identity_mismatch' });
  assert.deepEqual(fx.db.prepare(`SELECT project_id,objective_id,candidate_id,parent_candidate_id,attempt_id,integration_generation,
    environment_digest,check_identity,content_manifest_digest FROM candidate_intents WHERE intent_id=?`).get('intent-1'), pinned);
  quiet = { gone: true };
  assert.deepEqual(await restarted.reconcile('intent-1', { candidate: input, integrationGeneration: 2 }), { state: 'unknown', reason: 'quiescence_unproven' });
  quiet = true;
  for (const unsettled of [undefined, { state: 'unknown' }, { ok: true }]) {
    fx.admission.reconcile = async () => unsettled;
    assert.equal((await restarted.reconcile('intent-1', { candidate: input, integrationGeneration: 2 })).state, 'unknown');
  }
  fx.admission.reconcile = async (id) => { fx.admission.unresolved.delete(id); return { state: 'reconciled' }; };
  const recovered = await restarted.reconcile('intent-1', { candidate: input, integrationGeneration: 2 });
  assert.equal(recovered.state, 'applied');
  assert.equal(recovered.candidate.manifestDigest, expected.digest);
  assert.equal(recovered.candidate.parentCandidateId, 'candidate-1');
  assert.equal(recovered.candidate.environmentDigest, ENV_2);
  assert.equal(recovered.candidate.checkIdentity, 'checks-2');
  assert.deepEqual(await restarted.reconcile('intent-1', { candidate: input, integrationGeneration: 2 }), { state: 'applied' });
  assert.equal(fx.admission.unresolved.has('exec-1'), false);
  await assert.rejects(() => restarted.publish(input));
  assert.equal(calls, 1);
});

test('owner edit during release window is not attributed to the frozen candidate', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const store = new CandidateStore({ ...fx.config, apply: async () => {
    fs.writeFileSync(path.join(fx.workspace, 'tracked.txt'), 'integrated\n');
    fs.writeFileSync(path.join(fx.workspace, 'new.bin'), Buffer.from([4, 0, 255]));
    fs.unlinkSync(path.join(fx.workspace, 'bin', 'tool'));
    throw new Error('simulated lost acknowledgement');
  } });
  baseCandidate(store);
  const expected = expectedAfter(fx);
  const input = publishInput(expected);
  assert.equal((await store.publish(input)).state, 'unknown');
  const originalReconcile = fx.admission.reconcile.bind(fx.admission);
  fx.admission.reconcile = async (id) => {
    fs.writeFileSync(path.join(fx.workspace, 'owner.txt'), 'owner edit after frozen boundary\n');
    return originalReconcile(id);
  };
  const recovered = await store.reconcile('intent-1', { candidate: input, integrationGeneration: 2 });
  assert.equal(recovered.state, 'applied');
  assert.equal(recovered.candidate.manifestDigest, expected.digest);
  assert.equal(store.readManifest(recovered.candidate.manifestDigest).entries.some((entry) => entry.path === 'owner.txt'), false);
});

test('crash before effect reconciles exact before manifest as not applied', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const store = new CandidateStore({ ...fx.config, apply: async () => { throw new Error('failed before effect'); } });
  baseCandidate(store);
  const expected = expectedAfter(fx);
  const result = await store.publish(publishInput(expected));
  assert.equal(result.state, 'unknown');
  const recovered = await store.reconcile('intent-1');
  assert.deepEqual(recovered, { state: 'not_applied' });
  assert.equal(store.get('candidate-2'), null);
});

test('partial apply stays unknown and keeps the admission fence', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const store = new CandidateStore({ ...fx.config, apply: async () => {
    fs.writeFileSync(path.join(fx.workspace, 'tracked.txt'), 'partial\\n');
    throw new Error('simulated mid-apply crash');
  } });
  baseCandidate(store);
  const expected = expectedAfter(fx);
  assert.equal((await store.publish(publishInput(expected))).state, 'unknown');
  const recovery = await store.reconcile('intent-1', { candidate: publishInput(expected), integrationGeneration: 2 });
  assert.equal(recovery.state, 'unknown');
  assert.equal(recovery.reason, 'manifest_not_exactly_reconciled');
  assert.equal(fx.admission.unresolved.has('exec-1'), true);
  assert.equal(store.get('candidate-2'), null);
});

test('garbage collection retains snapshots named by unresolved intents', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  let failEvents = false;
  const store = new CandidateStore({ ...fx.config, eventHook: () => { if (failEvents) throw new Error('event sink unavailable'); }, apply: async () => {
    fs.writeFileSync(path.join(fx.workspace, 'tracked.txt'), 'integrated\n');
    fs.writeFileSync(path.join(fx.workspace, 'new.bin'), Buffer.from([4, 0, 255]));
    fs.unlinkSync(path.join(fx.workspace, 'bin', 'tool'));
    throw new Error('lost apply acknowledgement');
  } });
  baseCandidate(store);
  const expected = expectedAfter(fx);
  const input = publishInput(expected);
  assert.equal((await store.publish(input)).state, 'unknown');
  failEvents = true;
  await assert.rejects(() => store.reconcile('intent-1', { candidate: input, integrationGeneration: 2 }));
  store.collectGarbage();
  assert.equal(store.readManifest(expected.digest).digest, expected.digest);
  assert.equal(store.get('candidate-2'), null);
});

test('cross-connection reuse survives GC unlink and restart repairs a missing manifest cache', (t) => {
  const fx = fixture();
  const db2 = new Database(fx.dbPath);
  let closed = false;
  t.after(() => { if (!closed) { fx.db.close(); db2.close(); } fs.rmSync(fx.root, { recursive: true, force: true }); });
  const first = new CandidateStore(fx.config);
  const second = new CandidateStore({ ...fx.config, db: db2 });
  const original = baseCandidate(first);
  const manifestFile = path.join(fx.storageDir, 'manifests', original.manifestDigest);
  const originalRm = fs.rmSync;
  let inserted = false;
  fs.rmSync = function(target, options) {
    if (target === manifestFile && !inserted) {
      inserted = true;
      const recreated = second.createCandidate({ candidateId: 'candidate-second', projectId: 'project-1', objectiveId: 'objective-1',
        integrationGeneration: 2, sourceAttemptId: 'attempt-2', environmentDigest: ENV_2, checkIdentity: 'checks-2' });
      assert.equal(recreated.manifestDigest, original.manifestDigest);
      second.addReference('candidate-second', 'receipt', 'receipt-second');
    }
    return originalRm.call(this, target, options);
  };
  try { first.collectGarbage(); }
  finally { fs.rmSync = originalRm; }
  assert.equal(inserted, true);
  assert.equal(second.readManifest(original.manifestDigest).digest, original.manifestDigest);
  assert.equal(fs.existsSync(manifestFile), true);
  assert.equal(fs.existsSync(path.join(fx.storageDir, 'blobs', second.readManifest(original.manifestDigest).entries[0].digest)), true);

  const originalRead = fs.readFileSync;
  let removedBetweenStatAndRead = false;
  fs.readFileSync = function(target, options) {
    if (target === manifestFile && !removedBetweenStatAndRead) {
      removedBetweenStatAndRead = true;
      originalRm.call(this, target, { force: true });
    }
    return originalRead.call(this, target, options);
  };
  try { assert.equal(second.readManifest(original.manifestDigest).digest, original.manifestDigest); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(removedBetweenStatAndRead, true);
  assert.equal(fs.existsSync(manifestFile), true);

  fs.rmSync(manifestFile, { force: true });
  fx.db.close(); db2.close();
  closed = true;
  const reopenedDb = new Database(fx.dbPath);
  const reopened = new CandidateStore({ ...fx.config, db: reopenedDb });
  assert.equal(fs.existsSync(manifestFile), true);
  assert.equal(reopened.readManifest(original.manifestDigest).digest, original.manifestDigest);
  reopenedDb.close();
});

test('blob file and directory sync precede snapshot metadata publication', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const synced = [];
  const manifests = new Map();
  const store = new CandidateStore({ ...fx.config, durability: {
    syncFile(file) { synced.push(['file', path.basename(file)]); },
    syncDirectory(directory) { synced.push(['directory', path.basename(directory)]); },
  } });
  const assertBlobEvents = (manifest, afterIndex = -1) => {
    for (const entry of manifest.entries) {
      const fileIndex = synced.findIndex(([kind, name], index) => index > afterIndex && kind === 'file' && (name === entry.digest || name.startsWith(`${entry.digest}.`)));
      const directoryIndex = synced.findIndex(([kind, name], index) => index > fileIndex && kind === 'directory' && name === 'blobs');
      assert.ok(fileIndex > afterIndex, `blob file ${entry.digest} was not synced first`);
      assert.ok(directoryIndex > fileIndex, 'blob directory was not synced after blob file');
    }
  };
  fx.db.function('assert_blob_durable', (body) => {
    const manifest = JSON.parse(body);
    assertBlobEvents(manifest);
    manifests.set(manifest.digest, manifest);
    synced.push(['metadata', manifest.digest]);
    return 1;
  });
  fx.db.function('assert_candidate_blob_durable', (digest) => {
    const metadataIndex = synced.findIndex(([kind, value]) => kind === 'metadata' && value === digest);
    assert.ok(metadataIndex >= 0, 'snapshot metadata must precede candidate metadata');
    assertBlobEvents(manifests.get(digest), metadataIndex);
    return 1;
  });
  fx.db.exec(`CREATE TEMP TRIGGER snapshot_requires_durable_blobs BEFORE INSERT ON candidate_snapshots
    BEGIN SELECT assert_blob_durable(NEW.manifest_json); END;
    CREATE TEMP TRIGGER candidate_requires_durable_blobs BEFORE INSERT ON candidates
    BEGIN SELECT assert_candidate_blob_durable(NEW.manifest_digest); END;`);
  const candidate = baseCandidate(store);
  assert.equal(candidate.status, 'known');
  assert.ok(synced.some(([kind]) => kind === 'metadata'));
});

test('blob sync failures fail closed before snapshot, known candidate, or publication intent', async (t) => {
  for (const failure of ['file', 'directory']) {
    await t.test(`${failure} sync`, async (st) => {
      const fx = fixture(); st.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
      let armed = false;
      let applyCalls = 0;
      let syncFailures = 0;
      const store = new CandidateStore({ ...fx.config, durability: {
        syncFile(file) { if (armed && file.includes(`${path.sep}blobs${path.sep}`)) { syncFailures += 1; throw new Error('injected file sync failure'); } },
        syncDirectory(directory) { if (armed && failure === 'directory' && path.basename(directory) === 'blobs') { syncFailures += 1; throw new Error('injected directory sync failure'); } },
      }, apply: async () => {
        applyCalls += 1;
        fs.writeFileSync(path.join(fx.workspace, 'tracked.txt'), 'integrated\n');
        fs.writeFileSync(path.join(fx.workspace, 'new.bin'), Buffer.from([4, 0, 255]));
        fs.unlinkSync(path.join(fx.workspace, 'bin', 'tool'));
      } });
      const base = baseCandidate(store);
      const expected = expectedAfter(fx);
      const input = publishInput(expected);
      armed = true;
      assert.equal((await store.publish(input)).state, 'unknown');
      assert.equal(syncFailures, 1);
      assert.equal(store.get('candidate-2'), null);
      assert.equal(store.getIntent('intent-1').state, 'unknown');
      assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM candidate_snapshots WHERE digest=?').get(expected.digest).count, 0);
      assert.equal(store.getIntent('intent-1').state === 'applied', false);
      assert.equal(applyCalls, 1);
      assert.equal(store.get('candidate-1').status, 'known');
    });
  }
});

test('records writer admission acquisition timing for publication', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const acquire = fx.admission.acquire.bind(fx.admission);
  fx.admission.acquire = async (input) => { time += 25; return acquire(input); };
  const store = new CandidateStore({ ...fx.config, clock: () => new Date(time), apply: async () => { throw new Error('effect unavailable'); } });
  baseCandidate(store);
  assert.equal((await store.publish(publishInput(expectedAfter(fx)))).state, 'unknown');
  assert.deepEqual(fx.db.prepare('SELECT started_at,acquired_at FROM candidate_admission_timing WHERE intent_id=?').get('intent-1'),
    { started_at: '2026-01-01T00:00:00.000Z', acquired_at: '2026-01-01T00:00:00.025Z' });
});
