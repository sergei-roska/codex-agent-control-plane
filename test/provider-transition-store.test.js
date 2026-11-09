'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ProviderTransitionStore, createProviderTransitionStore } = require('../src/provider-transition-store');

const record = Object.freeze({ projectId: 'project-1', transitionId: 'transition-1', runId: 'run-1', objectiveId: 'objective-1',
  sessionId: 'session-1', waitId: 'wait-1', sourceAccountHash: 'a'.repeat(64), targetAccountHash: 'b'.repeat(64),
  ownerGeneration: 4, controlRevision: 7, phase: 'intent' });
const pins = (value) => ({ transitionId: value.transitionId, phase: value.phase,
  ownerGeneration: value.ownerGeneration, controlRevision: value.controlRevision });

function memoryStore(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  return { db, store: createProviderTransitionStore(db) };
}

test('persists intent and its pins across database reopen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-transition-'));
  const file = path.join(directory, 'state.sqlite');
  let db = new Database(file);
  let store = new ProviderTransitionStore(db);
  assert.deepEqual(store.create(record), record);
  db.close();
  db = new Database(file);
  t.after(() => { if (db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  store = new ProviderTransitionStore(db);
  assert.deepEqual(store.get(record.projectId), record);
  assert.equal(store.get(record.projectId).sourceAccountHash, record.sourceAccountHash);
  assert.equal(store.get(record.projectId).targetAccountHash, record.targetAccountHash);
  assert.equal(store.get(record.projectId).ownerGeneration, record.ownerGeneration);
  assert.equal(store.get(record.projectId).controlRevision, record.controlRevision);
});

test('allows exact idempotent create and fences a distinct intent per project', (t) => {
  const { store } = memoryStore(t);
  assert.deepEqual(store.create(record), record);
  assert.deepEqual(store.create({ ...record }), record);
  assert.throws(() => store.create({ ...record, transitionId: 'transition-2' }), { code: 'transition_exists' });
  assert.deepEqual(store.get(record.projectId), record);
});

test('advances phases sequentially with a compare-and-swap phase and pins', (t) => {
  const { store } = memoryStore(t);
  store.create(record);
  assert.throws(() => store.advance(record.projectId, record, 'thread_prepared'), { code: 'transition_phase_invalid' });
  assert.throws(() => store.advance(record.projectId, { ...record, targetAccountHash: 'c'.repeat(64) }, 'profile_switched'), { code: 'transition_stale' });
  const switched = store.advance(record.projectId, record, 'profile_switched');
  assert.deepEqual(switched, { ...record, phase: 'profile_switched' });
  assert.throws(() => store.advance(record.projectId, record, 'profile_switched'), { code: 'transition_stale' });
  const prepared = store.advance(record.projectId, switched, 'thread_prepared');
  assert.equal(prepared.phase, 'thread_prepared');
  assert.throws(() => store.advance(record.projectId, prepared, 'thread_prepared'), { code: 'transition_phase_invalid' });
});

test('a stale concurrent phase update and stale clear fail closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-transition-cas-'));
  const file = path.join(directory, 'state.sqlite');
  const firstDb = new Database(file);
  const secondDb = new Database(file);
  const first = new ProviderTransitionStore(firstDb);
  const second = new ProviderTransitionStore(secondDb);
  t.after(() => { firstDb.close(); secondDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  first.create(record);
  const stale = second.get(record.projectId);
  const switched = first.advance(record.projectId, record, 'profile_switched');
  assert.throws(() => second.advance(record.projectId, stale, 'profile_switched'), { code: 'transition_stale' });
  assert.throws(() => second.clear(record.projectId, pins(stale)), { code: 'transition_stale' });
  assert.deepEqual(first.get(record.projectId), switched);
  assert.throws(() => first.clear(record.projectId, { ...pins(switched), controlRevision: 8 }), { code: 'transition_stale' });
  assert.equal(first.clear(record.projectId, pins(switched)), true);
  assert.equal(first.get(record.projectId), null);
});

test('rejects malformed identities, hashes, raw sensitive fields, and phase pins before mutation', (t) => {
  const { store } = memoryStore(t);
  for (const invalid of [
    { ...record, projectId: 'project with spaces' },
    { ...record, sourceAccountHash: 'raw-account-id' },
    { ...record, targetAccountHash: 'A'.repeat(64) },
    { ...record, accountId: 'raw-account-id' },
    { ...record, home: '/private/home' },
    { ...record, credentials: 'secret' },
    { ...record, profileName: 'personal' },
    { ...record, ownerGeneration: -1 },
    { ...record, phase: 'profile_switched' },
  ]) assert.throws(() => store.create(invalid));
  assert.equal(store.get(record.projectId), null);
  assert.throws(() => store.create({ ...record, sourceAccountHash: record.targetAccountHash }));
  assert.equal(store.get(record.projectId), null);
});
