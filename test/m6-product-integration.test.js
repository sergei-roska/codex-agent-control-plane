'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { migrateProductSchema } = require('../src/product-migrations');
const { ProductStore } = require('../src/product-store');
const { ArtifactStore } = require('../src/artifact-store');
const { bundleToIntakeInput } = require('../src/integrations/source-bundle');
const { buildIntakePrompt } = require('../src/intake');

const dirs = [];
process.on('exit', () => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

let sequence = 0;
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-product-'));
  dirs.push(dir);
  return dir;
}

function bundle(text, { fetchedAt = '2026-10-01T10:00:00.000Z', key = 'OPS-42', availability = 'available' } = {}) {
  const root = { sourceKind: 'jira', originId: 'jira-main', externalId: '90142', displayKey: key };
  return {
    schemaVersion: 1,
    root: { ...root, availability },
    documents: [
      { ...root, url: availability === 'available' ? 'https://example.atlassian.net/browse/OPS-42' : null,
        title: 'Issue title', text: availability === 'available' ? text : '', links: [], availability },
    ],
    warnings: [], fetchedAt, contentRevision: `fixture-${text}-${availability}`,
  };
}

async function makeStores() {
  const dir = tempDir();
  const file = path.join(dir, 'state.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  await migrateProductSchema({ db });
  const artifactStore = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  const makeStore = (connection = db) => new ProductStore({ db: connection, projectId: 'project-main', now: () => new Date('2026-10-01T10:00:00.000Z') });
  return { dir, file, db, store: makeStore(), makeStore, artifactStore };
}

function evidenceArtifact(artifactStore, sourceBundle) {
  const input = bundleToIntakeInput(sourceBundle);
  const text = input.extractedTexts.get(input.artifacts[0].artifactId);
  return artifactStore.store(Buffer.from(text, 'utf8'), 'jira-source.txt');
}

function importArgs(artifactStore, sourceBundle, commandId = 'source-import-001') {
  return {
    commandId,
    request: { originId: 'jira-main', issueIdOrKey: sourceBundle.root.displayKey },
    bundle: sourceBundle,
    artifact: evidenceArtifact(artifactStore, sourceBundle),
  };
}

test('Jira fixture import persists source evidence and links it to the requirement revision', async () => {
  const { store, artifactStore } = await makeStores();
  const sourceBundle = bundle('Imported acceptance details');
  const created = store.importSourceBundle(importArgs(artifactStore, sourceBundle));
  assert.equal(created.replayed, false);
  assert.equal(created.duplicate, false);
  assert.equal(created.ticket.source, 'jira');
  assert.equal(created.ticket.status, 'backlog');
  assert.equal(created.revision.description, 'Imported acceptance details');
  assert.equal(created.revision.artifactIds.length, 1);
  const artifact = store.getArtifact(created.revision.artifactIds[0]);
  assert.equal(artifact.state, 'attached');
  assert.equal(artifact.origin, 'jira_import');
  assert.equal(store.getRevisionSource(created.ticket.ticketId, created.revision.revisionId).snapshotId, created.source.appliedSnapshotId);
  const bytes = artifactStore.read(artifact.storageRef).toString('utf8');
  assert.match(bytes, /UNTRUSTED IMPORTED SOURCE DATA/);
  assert.match(bytes, /Imported acceptance details/);
  const prompt = buildIntakePrompt({ revision: created.revision, artifacts: [artifact],
    extractedTexts: new Map([[artifact.artifactId, bytes]]), projectConfig: { baseRef: 'main', checks: [] } });
  assert.match(prompt, /ATTACHMENT jira-source\.txt/);
  assert.match(prompt, /Imported acceptance details/);
  const snapshot = store.getTicketSourceSnapshot(created.ticket.ticketId, created.source.appliedSnapshotId);
  assert.equal(snapshot.bundle.documents[0].text, 'Imported acceptance details');
  assert.equal(store.getTicketSourceSnapshot('other-ticket', created.source.appliedSnapshotId), null);
});

test('command replay, renamed-key dedupe after reopen and conflicting command IDs are deterministic', async () => {
  const { store, db, makeStore, artifactStore } = await makeStores();
  const original = bundle('first text');
  const args = importArgs(artifactStore, original);
  const first = store.importSourceBundle(args);
  assert.equal(store.getSourceCommandResult({ commandId: args.commandId, kind: 'source_import', request: args.request }).replayed, true);
  const second = makeStore(new Database(db.name));
  const renamed = bundle('changed after alias rename', { key: 'OPS-900' });
  const duplicate = second.importSourceBundle(importArgs(artifactStore, renamed, 'source-import-002'));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ticket.ticketId, first.ticket.ticketId);
  assert.equal(duplicate.revision.revisionId, first.revision.revisionId);
  assert.equal(duplicate.artifactAttached, false);
  assert.equal(second.getTicketSourceHistory(first.ticket.ticketId).snapshots.length, 1);
  assert.throws(() => second.getSourceCommandResult({ commandId: args.commandId, kind: 'source_refresh', request: { ticketId: first.ticket.ticketId, expectedVersion: 1 } }),
    (error) => error.code === 'command_conflict');
});

test('backlog refresh applies A-B-A revisions while an active ticket keeps its pinned revision', async () => {
  const { store, artifactStore } = await makeStores();
  const first = store.importSourceBundle(importArgs(artifactStore, bundle('A')));
  const ticketId = first.ticket.ticketId;
  const refresh = (commandId, sourceBundle, expectedVersion) => store.refreshSourceBundle(ticketId, {
    commandId, request: { ticketId, expectedVersion }, bundle: sourceBundle,
    artifact: evidenceArtifact(artifactStore, sourceBundle),
  });
  const b = refresh('source-refresh-001', bundle('B', { fetchedAt: '2026-10-01T11:00:00.000Z' }), 1);
  assert.equal(b.applied, true);
  assert.equal(b.ticket.version, 2);
  assert.equal(b.revision.description, 'B');
  const replay = store.getSourceCommandResult({ commandId: 'source-refresh-001', kind: 'source_refresh',
    request: { ticketId, expectedVersion: 1 } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.artifactAttached, true);
  assert.throws(() => store.getSourceCommandResult({ commandId: 'source-refresh-001', kind: 'source_refresh',
    request: { ticketId, expectedVersion: 2 } }), (error) => error.code === 'command_conflict');
  const aAgain = refresh('source-refresh-002', bundle('A', { fetchedAt: '2026-10-01T12:00:00.000Z' }), 2);
  assert.equal(aAgain.applied, true);
  assert.notEqual(aAgain.source.appliedSnapshotId, first.source.appliedSnapshotId);
  assert.equal(aAgain.revision.description, 'A');
  assert.equal(store.getTicketSourceHistory(ticketId).snapshots.length, 3);

  const submitted = store.submitTicket(ticketId, { commandId: 'submit-source-01', expectedVersion: 3 }, {});
  const activeRefresh = refresh('source-refresh-003', bundle('C'), submitted.ticket.version);
  assert.equal(activeRefresh.applied, false);
  assert.equal(activeRefresh.artifactAttached, false);
  assert.equal(activeRefresh.ticket.currentRevisionId, submitted.ticket.currentRevisionId);
  assert.equal(activeRefresh.source.pending, true);
  assert.equal(activeRefresh.source.appliedSnapshotId, aAgain.source.appliedSnapshotId);
});

test('source reads and refresh are scoped to the configured project', async () => {
  const { store, db, artifactStore } = await makeStores();
  const imported = store.importSourceBundle(importArgs(artifactStore, bundle('private to project one')));
  const otherProject = new ProductStore({ db, projectId: 'project-two' });
  assert.equal(otherProject.getTicketSource(imported.ticket.ticketId), null);
  assert.equal(otherProject.getTicketSourceHistory(imported.ticket.ticketId), null);
  assert.equal(otherProject.getTicketSourceSnapshot(imported.ticket.ticketId, imported.source.appliedSnapshotId), null);
  assert.equal(otherProject.getRevisionSource(imported.ticket.ticketId, imported.revision.revisionId), null);
  assert.throws(() => otherProject.getSourceCommandResult({ commandId: 'source-import-001', kind: 'source_import',
    request: { originId: 'jira-main', issueIdOrKey: 'OPS-42' } }), (error) => error.code === 'command_conflict');
  assert.throws(() => otherProject.refreshSourceBundle(imported.ticket.ticketId, {
    commandId: 'cross-project-refresh', request: { ticketId: imported.ticket.ticketId, expectedVersion: imported.ticket.version },
    bundle: bundle('cannot cross projects'),
  }), (error) => error.code === 'not_found');
});

test('unavailable root is retained as pending history without replacing prior applied evidence', async () => {
  const { store, artifactStore } = await makeStores();
  const first = store.importSourceBundle(importArgs(artifactStore, bundle('usable')));
  const missing = bundle('', { key: 'OPS-42', availability: 'missing', fetchedAt: '2026-10-01T11:00:00.000Z' });
  const result = store.refreshSourceBundle(first.ticket.ticketId, {
    commandId: 'source-refresh-missing',
    request: { ticketId: first.ticket.ticketId, expectedVersion: first.ticket.version },
    bundle: missing,
  });
  assert.equal(result.applied, false);
  assert.equal(result.source.rootAvailable, false);
  assert.equal(result.source.latestAvailableSnapshotId, first.source.appliedSnapshotId);
  assert.equal(result.source.appliedSnapshotId, first.source.appliedSnapshotId);
  assert.equal(result.source.pending, true);
  assert.equal(result.ticket.currentRevisionId, first.revision.revisionId);
  assert.equal(store.getTicketSourceHistory(first.ticket.ticketId).snapshots.length, 2);
  const page = store.getTicketSourceHistory(first.ticket.ticketId, { limit: 1 });
  assert.equal(page.snapshots.length, 1);
  assert.equal(page.snapshots[0].ordinal, 2);
  assert.equal(page.nextBeforeOrdinal, 2);
  assert.equal(store.getTicketSourceHistory(first.ticket.ticketId, { beforeOrdinal: 2, limit: 1 }).snapshots[0].ordinal, 1);
});

test('failed import rolls back command, ticket, artifact row, identity and snapshot together', async () => {
  const { store, db, artifactStore } = await makeStores();
  const sourceBundle = bundle('valid');
  const args = importArgs(artifactStore, sourceBundle);
  args.artifact.sha256 = 'not-a-digest';
  assert.throws(() => store.importSourceBundle(args), (error) => error.code === 'invalid_request');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM product_commands').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM m6_source_identities').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM m6_source_snapshots').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0);
});
