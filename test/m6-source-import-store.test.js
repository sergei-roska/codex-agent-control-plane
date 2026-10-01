'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { SourceImportStore, SourceImportError } = require('../src/integrations/source-import-store');
const { collectSourceBundle } = require('../src/integrations/source-bundle');
const { createFixtureSourceProvider } = require('../src/integrations/fixture-source-provider');

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-source-history-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'source.sqlite');
  return { file, db: new Database(file) };
}

let tick = 0;
const makeStore = (db) => new SourceImportStore({
  db,
  now: () => new Date(Date.parse('2026-09-30T12:00:00.000Z') + tick++ * 1000),
});

function bundle({ fetchedAt = '2026-09-30T11:00:00.000Z', title = 'Bug: login', text = 'initial',
  displayKey = 'APP-1', availability = 'available', sourceRevision = 'rev-1' } = {}) {
  const ref = { sourceKind: 'jira', originId: 'site-a', externalId: '10001' };
  return {
    schemaVersion: 1,
    root: { ...ref },
    documents: [{
      ...ref, displayKey, url: 'https://example.atlassian.net/browse/APP-1',
      title, text, sourceRevision, availability, links: [],
    }],
    warnings: [], fetchedAt,
  };
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof SourceImportError && error.code === code);
}

test('snapshots survive reopening and deduplicate identical content across fetch timestamps', () => {
  const { file, db } = openDb();
  const store = makeStore(db);
  const first = store.recordSnapshot({ projectId: 'project-a', bundle: bundle() });
  assert.deepEqual({ changed: first.changed, replayed: first.replayed }, { changed: true, replayed: false });
  const replay = store.recordSnapshot({ projectId: 'project-a', bundle: bundle({ fetchedAt: '2026-09-30T11:02:00.000Z' }) });
  assert.deepEqual(replay, { ...first, changed: false, replayed: true });
  db.close();

  const reopened = new Database(file);
  const durable = makeStore(reopened);
  const identity = durable.getIdentity({ projectId: 'project-a', originId: 'site-a', externalId: '10001' });
  assert.equal(identity.latestSnapshotId, first.snapshotId);
  assert.equal(identity.latestAvailableSnapshotId, first.snapshotId);
  assert.equal(durable.listSnapshots(first.identityId).length, 1);
  assert.equal(durable.getSnapshot(first.snapshotId).bundle.documents[0].sourceRevision, 'rev-1');
  reopened.close();
});

test('project and origin partition identity; Jira issue key rename remains the same identity', () => {
  const { db } = openDb();
  const store = makeStore(db);
  const original = store.recordSnapshot({ projectId: 'project-a', bundle: bundle() });
  const renamed = store.recordSnapshot({ projectId: 'project-a', bundle: bundle({ displayKey: 'NEW-92', title: 'Bug: login' }) });
  assert.equal(renamed.identityId, original.identityId);
  assert.equal(renamed.changed, true);
  assert.equal(store.getIdentity({ projectId: 'project-a', originId: 'site-a', externalId: '10001' }).latestSnapshotId, renamed.snapshotId);

  const anotherProject = store.recordSnapshot({ projectId: 'project-b', bundle: bundle() });
  const anotherOrigin = store.recordSnapshot({ projectId: 'project-a', bundle: {
    ...bundle(), root: { ...bundle().root, originId: 'site-b' },
    documents: [{ ...bundle().documents[0], originId: 'site-b' }],
  } });
  assert.notEqual(anotherProject.identityId, original.identityId);
  assert.notEqual(anotherOrigin.identityId, original.identityId);
  db.close();
});

test('changed revisions form immutable parent chain; unavailable root preserves last good pointer', () => {
  const { db } = openDb();
  const store = makeStore(db);
  const v1 = store.recordSnapshot({ projectId: 'p', bundle: bundle() });
  const v2 = store.recordSnapshot({ projectId: 'p', bundle: bundle({ text: 'edited context', sourceRevision: 'rev-2' }) });
  assert.equal(store.getSnapshot(v2.snapshotId).parentSnapshotId, v1.snapshotId);
  const outage = store.recordSnapshot({ projectId: 'p', bundle: bundle({
    availability: 'unavailable', text: '', title: '', fetchedAt: '2026-09-30T11:10:00.000Z',
  }) });
  assert.equal(store.getSnapshot(outage.snapshotId).rootAvailable, false);
  assert.equal(store.getSnapshot(outage.snapshotId).parentSnapshotId, v2.snapshotId);
  const identity = store.getIdentity({ projectId: 'p', originId: 'site-a', externalId: '10001' });
  assert.equal(identity.latestSnapshotId, outage.snapshotId);
  assert.equal(identity.latestAvailableSnapshotId, v2.snapshotId);
  assert.deepEqual(store.listSnapshots(v2.identityId).map((snapshot) => snapshot.parentSnapshotId), [null, v1.snapshotId, v2.snapshotId]);
  db.close();
});

test('A to B to A creates a new ordered revision and replay compares the latest snapshot only', () => {
  const { db } = openDb();
  const store = makeStore(db);
  const a1 = bundle();
  a1.documents[0].fetchedAt = '2026-09-30T10:00:00.000Z';
  const first = store.recordSnapshot({ projectId: 'p', bundle: a1 });
  const second = store.recordSnapshot({ projectId: 'p', bundle: bundle({ text: 'changed' }) });
  const a2 = bundle({ fetchedAt: '2026-09-30T11:05:00.000Z' });
  a2.documents[0].fetchedAt = '2026-09-30T11:04:00.000Z';
  const third = store.recordSnapshot({ projectId: 'p', bundle: a2 });
  assert.equal(third.changed, true);
  assert.equal(third.replayed, false);
  assert.equal(store.getSnapshot(third.snapshotId).parentSnapshotId, second.snapshotId);
  assert.deepEqual(store.listSnapshots(first.identityId).map((snapshot) => snapshot.ordinal), [1, 2, 3]);
  const repeated = store.recordSnapshot({ projectId: 'p', bundle: bundle({ fetchedAt: '2026-09-30T11:06:00.000Z' }) });
  assert.equal(repeated.snapshotId, third.snapshotId);
  assert.equal(repeated.replayed, true);
  db.close();
});

test('snapshot ordering remains deterministic when the injected clock returns equal times', () => {
  const { db } = openDb();
  const store = new SourceImportStore({ db, now: () => new Date('2026-09-30T12:00:00.000Z') });
  const first = store.recordSnapshot({ projectId: 'p', bundle: bundle() });
  const second = store.recordSnapshot({ projectId: 'p', bundle: bundle({ text: 'second revision' }) });
  const rows = store.listSnapshots(first.identityId);
  assert.equal(rows[0].recordedAt, rows[1].recordedAt);
  assert.deepEqual(rows.map((snapshot) => snapshot.ordinal), [1, 2]);
  assert.deepEqual(rows.map((snapshot) => snapshot.snapshotId), [first.snapshotId, second.snapshotId]);
  db.close();
});

test('accepts collected bundle metadata and unavailable documents with null URLs', () => {
  const { db } = openDb();
  const store = makeStore(db);
  const unavailable = bundle({ availability: 'unavailable', title: 'Source context unavailable', text: '' });
  unavailable.root = { ...unavailable.root, displayKey: 'APP-1', availability: 'unavailable' };
  unavailable.documents[0].url = null;
  unavailable.contentRevision = 'f'.repeat(64);
  unavailable.warnings = [{ code: 'root_unavailable', message: 'The root source is unavailable.' }];
  const recorded = store.recordSnapshot({ projectId: 'p', bundle: unavailable });
  const saved = store.getSnapshot(recorded.snapshotId).bundle;
  assert.equal(saved.root.availability, 'unavailable');
  assert.equal(saved.documents[0].url, null);
  assert.equal(saved.contentRevision, 'f'.repeat(64));
  db.close();
});

test('records fixture collector output and reopens it with immutable Jira identity', async () => {
  const { file, db } = openDb();
  const ref = { sourceKind: 'jira', originId: 'site-a', externalId: '10001' };
  const provider = createFixtureSourceProvider({ documents: [{
    ...ref, displayKey: 'APP-1', url: 'https://example.atlassian.net/browse/APP-1',
    sourceRevision: 'jira-updated-9', title: 'Fix login', text: 'Root fixture\r\nbody.\u0000', links: [], availability: 'available',
  }] });
  const collected = await collectSourceBundle({
    provider, root: ref, origins: [{ ...ref, baseUrl: 'https://example.atlassian.net' }],
    now: () => new Date('2026-09-30T11:00:00.000Z'),
  });
  const recorded = makeStore(db).recordSnapshot({ projectId: 'p', bundle: collected });
  db.close();
  const reopened = new Database(file);
  const snapshot = makeStore(reopened).getSnapshot(recorded.snapshotId);
  assert.equal(snapshot.bundle.root.externalId, '10001');
  assert.equal(snapshot.bundle.root.displayKey, 'APP-1');
  assert.equal(snapshot.bundle.documents[0].sourceRevision, 'jira-updated-9');
  assert.equal(snapshot.bundle.documents[0].text, 'Root fixture\r\nbody.\u0000');
  assert.equal(snapshot.rootAvailable, true);
  reopened.close();
});

test('returned snapshots are detached and ticket binding is idempotent but exclusive', () => {
  const { db } = openDb();
  const store = makeStore(db);
  const recorded = store.recordSnapshot({ projectId: 'p', bundle: bundle() });
  const returned = store.getSnapshot(recorded.snapshotId);
  returned.bundle.documents[0].text = 'mutated by caller';
  assert.equal(store.getSnapshot(recorded.snapshotId).bundle.documents[0].text, 'initial');

  assert.deepEqual(store.bindTicket({ identityId: recorded.identityId, ticketId: 'ticket-1' }), {
    identityId: recorded.identityId, ticketId: 'ticket-1', replayed: false,
  });
  assert.deepEqual(store.bindTicket({ identityId: recorded.identityId, ticketId: 'ticket-1' }), {
    identityId: recorded.identityId, ticketId: 'ticket-1', replayed: true,
  });
  errorCode(() => store.bindTicket({ identityId: recorded.identityId, ticketId: 'ticket-2' }), 'ticket_binding_conflict');
  errorCode(() => store.bindTicket({ identityId: 'missing', ticketId: 'ticket-1' }), 'not_found');
  db.close();
});

test('rejects malformed, oversized, and deeply nested bundles before persistence', () => {
  const { db } = openDb();
  const store = makeStore(db);
  errorCode(() => store.recordSnapshot({ projectId: 'p', bundle: { ...bundle(), schemaVersion: 2 } }), 'invalid_bundle');
  errorCode(() => store.recordSnapshot({ projectId: 'p', bundle: { ...bundle(), documents: [] } }), 'invalid_bundle');
  errorCode(() => store.recordSnapshot({ projectId: 'p', bundle: bundle({ text: 'x'.repeat(1024 * 1024 + 1) }) }), 'invalid_bundle');
  let deeplyNested = {};
  let cursor = deeplyNested;
  for (let i = 0; i < 30; i += 1) { cursor.child = {}; cursor = cursor.child; }
  errorCode(() => store.recordSnapshot({ projectId: 'p', bundle: deeplyNested }), 'invalid_bundle');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM m6_source_identities').get().count, 0);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  assert.deepEqual(tables.sort(), ['m6_source_identities', 'm6_source_snapshots']);
  db.close();
});
