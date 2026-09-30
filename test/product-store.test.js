'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { migrateProductSchema } = require('../src/product-migrations');
const { ProductStore, ProductError, canonicalJson } = require('../src/product-store');

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let clock = Date.parse('2026-09-30T10:00:00.000Z');
let cmdSeq = 0;
const cmd = () => `cmd-${String(++cmdSeq).padStart(6, '0')}`;

async function makeStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-store-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'state.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  await migrateProductSchema({ db, filePath: file });
  const store = new ProductStore({
    db, projectId: 'proj', now: () => new Date((clock += 1000)), ...options,
  });
  return { store, db };
}

function stage(store, id, size = 10, extra = {}) {
  return store.recordStagedArtifact({
    artifactId: id, displayName: `${id}.txt`, mediaType: 'text/plain', size,
    sha256: 'a'.repeat(64), storageRef: `ref/${id}`, extraction: 'extracted',
    extractedChars: 5, extractionTruncated: false, ...extra,
  });
}

function counts(db) {
  const n = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  return { tickets: n('tickets'), revisions: n('requirement_revisions'), commands: n('product_commands') };
}

function expectError(fn, code, check) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProductError, String(error));
    assert.equal(error.code, code, error.message);
    if (check) check(error);
    return error;
  }
  assert.fail(`expected ${code}`);
  return null;
}

const base = (extra = {}) => ({ commandId: cmd(), title: 'Fix login', ...extra });

test('create happy path returns camelCase ticket and revision', async () => {
  const { store } = await makeStore();
  const out = store.createTicket(base({
    description: 'desc', criteria: ['a', 'b'], priority: 'high', requestedSpecialty: 'qa',
    references: { links: ['https://example.com'] },
  }));
  assert.equal(out.replayed, false);
  assert.match(out.ticket.ticketId, /^tkt_[A-Za-z0-9_-]{22}$/);
  assert.match(out.revision.revisionId, /^rev_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(Object.keys(out.ticket).sort(), [
    'createdAt', 'createdBy', 'currentRevisionId', 'priority', 'projectId', 'source', 'status',
    'ticketId', 'title', 'trackingMode', 'updatedAt', 'version']);
  assert.equal(out.ticket.status, 'backlog');
  assert.equal(out.ticket.version, 1);
  assert.equal(out.ticket.source, 'direct');
  assert.equal(out.ticket.createdBy, 'operator');
  assert.equal(out.ticket.trackingMode, 'internal');
  assert.equal(out.ticket.projectId, 'proj');
  assert.equal(out.ticket.currentRevisionId, out.revision.revisionId);
  assert.equal(out.revision.ordinal, 1);
  assert.equal(out.revision.parentRevisionId, null);
  assert.equal(out.revision.requestedSpecialty, 'qa');
  assert.equal(out.revision.actor, 'operator');
  assert.deepEqual(out.revision.criteria, ['a', 'b']);
  assert.deepEqual(out.revision.references.links, [{ value: 'https://example.com', availability: 'not_retrieved' }]);
  assert.deepEqual(out.revision.references.figma, []);
  assert.deepEqual(store.getTicket(out.ticket.ticketId), out.ticket);
  assert.equal(store.getTicket('nope'), null);
});

test('defaults: priority normal, no specialty, title trimmed', async () => {
  const { store } = await makeStore();
  const out = store.createTicket(base({ title: '  padded  ' }));
  assert.equal(out.ticket.title, 'padded');
  assert.equal(out.ticket.priority, 'normal');
  assert.equal(out.revision.requestedSpecialty, null);
  assert.equal(out.revision.description, '');
});

test('revise creates an immutable chain and mirrors the current revision', async () => {
  const { store } = await makeStore();
  const c = store.createTicket(base({ title: 'v1', priority: 'low' }));
  const id = c.ticket.ticketId;
  const r2 = store.reviseTicket(id, { commandId: cmd(), expectedVersion: 1, title: 'v2', priority: 'high', description: 'd2' });
  const r3 = store.reviseTicket(id, { commandId: cmd(), expectedVersion: 2, title: 'v3' });
  assert.equal(r2.ticket.version, 2);
  assert.equal(r3.ticket.version, 3);
  assert.equal(r3.ticket.title, 'v3');
  assert.equal(r3.ticket.priority, 'normal');
  assert.deepEqual([r2.revision.ordinal, r3.revision.ordinal], [2, 3]);
  assert.equal(r2.revision.parentRevisionId, c.revision.revisionId);
  assert.equal(r3.revision.parentRevisionId, r2.revision.revisionId);
  const all = store.listRevisions(id);
  assert.deepEqual(all.map((r) => r.ordinal), [1, 2, 3]);
  assert.deepEqual(store.getRevision(id, c.revision.revisionId), c.revision);
  assert.deepEqual(store.getRevision(id, r2.revision.revisionId), r2.revision);
  assert.equal(store.getRevision(id, c.revision.revisionId).title, 'v1');
  assert.equal(store.getRevision('other', c.revision.revisionId), null);
  assert.equal(store.getTicket(id).currentRevisionId, r3.revision.revisionId);
});

test('cancel returns the current revision and retains history', async () => {
  const { store } = await makeStore();
  const c = store.createTicket(base());
  const id = c.ticket.ticketId;
  const out = store.cancelTicket(id, { commandId: cmd(), expectedVersion: 1 });
  assert.equal(out.ticket.status, 'cancelled');
  assert.equal(out.ticket.version, 2);
  assert.deepEqual(out.revision, c.revision);
  assert.equal(store.listRevisions(id).length, 1);
});

test('cancelled tickets reject revise and cancel with invalid_state', async () => {
  const { store, db } = await makeStore();
  const id = store.createTicket(base()).ticket.ticketId;
  store.cancelTicket(id, { commandId: cmd(), expectedVersion: 1 });
  const before = counts(db);
  expectError(() => store.reviseTicket(id, { commandId: cmd(), expectedVersion: 2, title: 'x' }), 'invalid_state',
    (e) => assert.equal(e.status, 409));
  expectError(() => store.cancelTicket(id, { commandId: cmd(), expectedVersion: 2 }), 'invalid_state');
  assert.deepEqual(counts(db), before);
});

test('unknown ticket -> not_found (404)', async () => {
  const { store } = await makeStore();
  expectError(() => store.cancelTicket('tkt_x', { commandId: cmd(), expectedVersion: 1 }), 'not_found',
    (e) => assert.equal(e.status, 404));
  expectError(() => store.reviseTicket('tkt_x', { commandId: cmd(), expectedVersion: 1, title: 't' }), 'not_found');
});

test('stale version reports currentVersion and writes nothing', async () => {
  const { store, db } = await makeStore();
  const id = store.createTicket(base()).ticket.ticketId;
  store.reviseTicket(id, { commandId: cmd(), expectedVersion: 1, title: 'v2' });
  const before = counts(db);
  const staleCmd = cmd();
  expectError(() => store.reviseTicket(id, { commandId: staleCmd, expectedVersion: 1, title: 'v3' }), 'stale_version', (e) => {
    assert.equal(e.status, 409);
    assert.deepEqual(e.details, { currentVersion: 2 });
  });
  expectError(() => store.cancelTicket(id, { commandId: cmd(), expectedVersion: 7 }), 'stale_version');
  assert.deepEqual(counts(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM product_commands WHERE command_id = ?').get(staleCmd).c, 0);
});

test('replay returns the stored result without duplicates', async () => {
  const { store, db } = await makeStore();
  const body = base({ description: 'same' });
  const first = store.createTicket(body);
  const second = store.createTicket({ ...body });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.ticket, first.ticket);
  assert.deepEqual(second.revision, first.revision);
  assert.deepEqual(counts(db), { tickets: 1, revisions: 1, commands: 1 });

  const rev = { commandId: cmd(), expectedVersion: 1, title: 'again' };
  const r1 = store.reviseTicket(first.ticket.ticketId, rev);
  const r2 = store.reviseTicket(first.ticket.ticketId, { title: 'again', expectedVersion: 1, commandId: rev.commandId });
  assert.equal(r2.replayed, true);
  assert.deepEqual(r2.revision, r1.revision);
  assert.equal(store.listRevisions(first.ticket.ticketId).length, 2);

  const can = { commandId: cmd(), expectedVersion: 2 };
  const c1 = store.cancelTicket(first.ticket.ticketId, can);
  const c2 = store.cancelTicket(first.ticket.ticketId, can);
  assert.equal(c2.replayed, true);
  assert.deepEqual(c2.ticket, c1.ticket);
});

test('same commandId with a different payload or target -> conflict', async () => {
  const { store, db } = await makeStore();
  const body = base({ description: 'one' });
  store.createTicket(body);
  expectError(() => store.createTicket({ ...body, description: 'two' }), 'conflict', (e) => assert.equal(e.status, 409));
  const a = store.createTicket(base());
  const b = store.createTicket(base());
  const can = { commandId: cmd(), expectedVersion: 1 };
  store.cancelTicket(a.ticket.ticketId, can);
  expectError(() => store.cancelTicket(b.ticket.ticketId, can), 'conflict');
  expectError(() => store.reviseTicket(a.ticket.ticketId, { ...can, title: 'x' }), 'conflict');
  assert.equal(counts(db).tickets, 3);
});

test('canonicalJson sorts keys recursively', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
});

function fieldsOf(error) {
  return error.details.map((d) => d.field);
}

test('title boundaries 200/201 and empty', async () => {
  const { store } = await makeStore();
  assert.equal(store.createTicket(base({ title: 'x'.repeat(200) })).ticket.title.length, 200);
  expectError(() => store.createTicket(base({ title: 'x'.repeat(201) })), 'invalid_request',
    (e) => { assert.equal(e.status, 400); assert.deepEqual(fieldsOf(e), ['title']); });
  expectError(() => store.createTicket(base({ title: '   ' })), 'invalid_request');
  expectError(() => store.createTicket({ commandId: cmd() }), 'invalid_request', (e) => assert.deepEqual(fieldsOf(e), ['title']));
});

test('description boundaries 32000/32001', async () => {
  const { store } = await makeStore();
  store.createTicket(base({ description: 'd'.repeat(32000) }));
  expectError(() => store.createTicket(base({ description: 'd'.repeat(32001) })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['description']));
});

test('references boundaries 20/21 per kind and item length', async () => {
  const { store } = await makeStore();
  const list = (n) => Array.from({ length: n }, (_, i) => `https://e.com/${i}`);
  store.createTicket(base({ references: { links: list(20), figma: list(20) } }));
  expectError(() => store.createTicket(base({ references: { links: list(21) } })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['references.links']));
  store.createTicket(base({ references: { links: ['x'.repeat(2000)] } }));
  expectError(() => store.createTicket(base({ references: { links: ['x'.repeat(2001)] } })), 'invalid_request');
  expectError(() => store.createTicket(base({ references: { links: [''] } })), 'invalid_request');
  expectError(() => store.createTicket(base({ references: { links: [5] } })), 'invalid_request');
  expectError(() => store.createTicket(base({ references: { bogus: [] } })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['references.bogus']));
});

test('criteria limits: 100 items, joined 16000, non-empty', async () => {
  const { store } = await makeStore();
  store.createTicket(base({ criteria: Array.from({ length: 100 }, () => 'c') }));
  expectError(() => store.createTicket(base({ criteria: Array.from({ length: 101 }, () => 'c') })), 'invalid_request');
  store.createTicket(base({ criteria: ['x'.repeat(16000)] }));
  expectError(() => store.createTicket(base({ criteria: ['x'.repeat(16001)] })), 'invalid_request');
  expectError(() => store.createTicket(base({ criteria: [' '] })), 'invalid_request');
  expectError(() => store.createTicket(base({ criteria: 'nope' })), 'invalid_request');
});

test('unknown fields, control characters, bad specialty and priority', async () => {
  const { store, db } = await makeStore();
  expectError(() => store.createTicket(base({ surprise: 1 })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['surprise']));
  expectError(() => store.createTicket(base({ status: 'done' })), 'invalid_request');
  expectError(() => store.createTicket(base({ title: 'a\u0000b' })), 'invalid_request');
  expectError(() => store.createTicket(base({ description: 'a\u001bb' })), 'invalid_request');
  store.createTicket(base({ description: 'tab\tnewline\nok' }));
  expectError(() => store.createTicket(base({ requestedSpecialty: 'wizard' })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['requestedSpecialty']));
  expectError(() => store.createTicket(base({ priority: 'urgent' })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['priority']));
  expectError(() => store.createTicket(base({ commandId: 'short' })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['commandId']));
  expectError(() => store.createTicket(base({ commandId: 'has space in it' })), 'invalid_request');
  expectError(() => store.createTicket(null), 'invalid_request');
  expectError(() => store.cancelTicket('t', { commandId: cmd() }), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['expectedVersion']));
  assert.equal(counts(db).tickets, 1);
});

test('artifacts: 10/11 ids, 25 MiB combined, staged-only on create', async () => {
  const { store, db } = await makeStore();
  const ids = Array.from({ length: 11 }, (_, i) => stage(store, `art_${i}`, 1).artifactId);
  const ok = store.createTicket(base({ artifactIds: ids.slice(0, 10) }));
  assert.equal(ok.revision.artifactIds.length, 10);
  assert.ok(store.listTicketArtifacts(ok.ticket.ticketId).every((a) => a.state === 'attached'));
  const extra = stage(store, 'art_extra', 1).artifactId;
  const many = Array.from({ length: 11 }, (_, i) => stage(store, `art_m${i}`, 1).artifactId);
  expectError(() => store.createTicket(base({ artifactIds: many })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['artifactIds']));
  // attached artifact cannot be reused on create
  expectError(() => store.createTicket(base({ artifactIds: [ids[0], extra] })), 'invalid_request');
  assert.equal(store.getArtifact(extra).state, 'staged');

  const MiB = 1024 * 1024;
  const a = stage(store, 'art_big1', 20 * MiB).artifactId;
  const b = stage(store, 'art_big2', 5 * MiB).artifactId;
  const c = stage(store, 'art_big3', 1).artifactId;
  const before = counts(db);
  expectError(() => store.createTicket(base({ artifactIds: [a, b, c] })), 'invalid_request',
    (e) => assert.deepEqual(fieldsOf(e), ['artifactIds']));
  assert.deepEqual(counts(db), before);
  const fit = store.createTicket(base({ artifactIds: [a, b] }));
  assert.equal(fit.revision.artifactIds.length, 2);
  expectError(() => store.createTicket(base({ artifactIds: ['art_missing'] })), 'invalid_request');
  expectError(() => store.createTicket(base({ artifactIds: [c, c] })), 'invalid_request');
});

test('revise accepts staged or own attached artifacts, rejects another ticket', async () => {
  const { store } = await makeStore();
  const a1 = stage(store, 'art_a1').artifactId;
  const a2 = stage(store, 'art_a2').artifactId;
  const t1 = store.createTicket(base({ artifactIds: [a1] }));
  const t2 = store.createTicket(base());
  const r = store.reviseTicket(t1.ticket.ticketId, { commandId: cmd(), expectedVersion: 1, title: 'x', artifactIds: [a1, a2] });
  assert.deepEqual(r.revision.artifactIds, [a1, a2]);
  assert.equal(store.getArtifact(a2).state, 'attached');
  assert.equal(store.getArtifact(a2).ticketId, t1.ticket.ticketId);
  expectError(() => store.reviseTicket(t2.ticket.ticketId, {
    commandId: cmd(), expectedVersion: 1, title: 'x', artifactIds: [a1],
  }), 'invalid_request', (e) => assert.match(e.details[0].message, /another ticket/));
  // dropping an artifact retains it
  store.reviseTicket(t1.ticket.ticketId, { commandId: cmd(), expectedVersion: 2, title: 'y' });
  assert.equal(store.getArtifact(a1).state, 'attached');
  assert.equal(store.listTicketArtifacts(t1.ticket.ticketId).length, 2);
});

test('failure after the ticket insert leaves no partial rows', async () => {
  const { store, db } = await makeStore();
  const good = stage(store, 'art_good').artifactId;
  const before = counts(db);
  expectError(() => store.createTicket(base({ artifactIds: [good, 'art_bad'] })), 'invalid_request');
  assert.deepEqual(counts(db), before);
  assert.equal(store.getArtifact(good).state, 'staged');
  assert.equal(store.getArtifact(good).ticketId, null);

  db.exec("CREATE TRIGGER boom BEFORE INSERT ON product_commands BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => store.createTicket(base({ artifactIds: [good] })), /boom/);
  assert.deepEqual(counts(db), before);
  assert.equal(store.getArtifact(good).state, 'staged');
});

test('staged artifact bookkeeping: record, list stale, delete only while staged', async () => {
  const { store } = await makeStore();
  const a = stage(store, 'art_old', 42, { extractionTruncated: true, extractedChars: 7 });
  assert.equal(a.state, 'staged');
  assert.equal(a.ticketId, null);
  assert.equal(a.extractionTruncated, true);
  assert.equal(a.extractedChars, 7);
  assert.equal(a.size, 42);
  assert.equal(a.storageRef, 'ref/art_old');
  stage(store, 'art_new');
  const cutoff = store.getArtifact('art_old').createdAt;
  assert.deepEqual(store.listStaleStagedArtifacts(new Date(Date.parse(cutoff) + 1).toISOString()).map((x) => x.artifactId), ['art_old']);
  assert.deepEqual(store.listStaleStagedArtifacts(cutoff), []);
  const t = store.createTicket(base({ artifactIds: ['art_old'] }));
  assert.equal(store.deleteStagedArtifact('art_old'), false);
  assert.equal(store.getArtifact('art_old').state, 'attached');
  assert.deepEqual(store.listStaleStagedArtifacts('9999'), [store.getArtifact('art_new')]);
  assert.equal(store.deleteStagedArtifact('art_new'), true);
  assert.equal(store.getArtifact('art_new'), null);
  assert.equal(store.deleteStagedArtifact('art_new'), false);
  assert.equal(store.listTicketArtifacts(t.ticket.ticketId).length, 1);
  expectError(() => store.recordStagedArtifact({ artifactId: 'x' }), 'invalid_request');
});

test('listTickets orders by updated_at desc then id desc with revision info', async () => {
  const fixed = Date.parse('2026-09-30T11:00:00.000Z');
  const ids = ['tkt_a', 'tkt_b', 'tkt_c'];
  const revs = ['rev_1', 'rev_2', 'rev_3', 'rev_4'];
  let i = 0;
  let j = 0;
  const { store } = await makeStore({
    now: () => new Date(fixed),
    randomId: (prefix) => (prefix === 'tkt_' ? ids[i++] : revs[j++]),
  });
  const art = stage(store, 'art_l').artifactId;
  store.createTicket(base({ requestedSpecialty: 'devops', artifactIds: [art] }));
  store.createTicket(base());
  store.createTicket(base());
  const listed = store.listTickets();
  assert.deepEqual(listed.map((t) => t.ticketId), ['tkt_c', 'tkt_b', 'tkt_a']);
  const a = listed[2];
  assert.equal(a.requestedSpecialty, 'devops');
  assert.equal(a.revisionOrdinal, 1);
  assert.equal(a.attachmentCount, 1);
  assert.equal(listed[0].requestedSpecialty, null);
  assert.equal(listed[0].attachmentCount, 0);
});

test('listTickets puts the most recently updated first', async () => {
  const { store } = await makeStore();
  const a = store.createTicket(base({ title: 'a' })).ticket.ticketId;
  const b = store.createTicket(base({ title: 'b' })).ticket.ticketId;
  assert.deepEqual(store.listTickets().map((t) => t.ticketId), [b, a]);
  store.reviseTicket(a, { commandId: cmd(), expectedVersion: 1, title: 'a2' });
  const listed = store.listTickets();
  assert.deepEqual(listed.map((t) => t.ticketId), [a, b]);
  assert.equal(listed[0].revisionOrdinal, 2);
  assert.equal(listed[0].title, 'a2');
});
