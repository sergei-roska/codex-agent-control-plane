'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { migrateProductSchema } = require('../src/product-migrations');
const { ProductStore, ProductError, canonicalJson } = require('../src/product-store');
const { DispatchJournal } = require('../src/durable-store');
const { liveStages } = require('../src/dashboard-api');
const { WriterAdmission } = require('../src/writer-admission');

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

// ------------------------------------------------------------------ M3 runs

const SNAPSHOT = { provider: 'openai', rolePack: 'legacy-orch', promptVersions: { intake: 'pm-intake-v1', lead: 'pm-lead-v1' } };
const PLAN = {
  stages: [
    { stageId: 'build', roleId: 'orch-builder', objective: 'Build', dependencies: [], allowedFiles: ['a.js'], required: true },
    { stageId: 'audit', roleId: 'orch-auditor', objective: 'Audit', dependencies: ['build'], allowedFiles: [], required: true },
  ],
  checkIds: ['unit'],
};
const NEEDS_INPUT = {
  readiness: 'needs_input',
  classification: 'feature',
  requirements: { summary: 's', scope: [], outOfScope: [], unknowns: [], expectedOutcomes: [] },
  questions: [{ id: 'q1', question: 'Which?', why: 'Because' }],
  unsupportedReason: null,
  plan: null,
};

function submitNew(store, title = 'Work') {
  const created = store.createTicket(base({ title })).ticket;
  const out = store.submitTicket(created.ticketId, { commandId: cmd(), expectedVersion: created.version }, SNAPSHOT);
  return { ticketId: created.ticketId, runId: out.run.runId, out };
}

function toReview(store, runId) {
  assert.equal(store.acquireLease(runId).acquired, true);
  store.saveIntakePlan(runId, {
    turn: 1, output: { ...NEEDS_INPUT, readiness: 'ready', questions: [], plan: PLAN }, classification: 'feature', plan: PLAN,
    checks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 1000, description: '' }], requirements: NEEDS_INPUT.requirements,
    validatorVersion: 'm3-plan-v1',
  });
  store.recordBranch(runId, { branchName: 'feature/work-abcdef', baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, 'task-1', 'ctx-1');
  store.moveToCandidate(runId);
  return store.completeRun(runId, {
    candidate: {
      baseCommit: 'a'.repeat(40), head: 'a'.repeat(40), branch: 'feature/work-abcdef', headMoved: false,
      manifest: [{ path: 'a.js', status: 'M', sha256: 'f'.repeat(64), size: 3 }], truncated: false,
      acceptance: {
        disposition: 'accepted', reasons: [], checks: [{ id: 'unit', exitCode: 0, timedOut: false, durationMs: 5, outputTail: 'ok' }],
        stages: [{ stageId: 'build', status: 'succeeded', attemptIds: ['att-1'] }, { stageId: 'audit', status: 'failed', attemptIds: [] }],
      },
      integrityHash: 'h'.repeat(64),
    },
    diffArtifact: { artifactId: 'art_diff', displayName: 'candidate.diff', size: 10, sha256: 'd'.repeat(64), storageRef: 'ref/art_diff' },
    outcome: 'review',
  });
}

test('submit creates a queued run bound to the current revision and moves the ticket to pending', async () => {
  const { store } = await makeStore();
  const created = store.createTicket(base()).ticket;
  const revised = store.reviseTicket(created.ticketId, { commandId: cmd(), expectedVersion: 1, title: 'Fix login v2' });
  const command = { commandId: cmd(), expectedVersion: revised.ticket.version };
  const out = store.submitTicket(created.ticketId, command, SNAPSHOT);
  assert.equal(out.ticket.status, 'pending');
  assert.equal(out.ticket.version, revised.ticket.version + 1);
  assert.equal(out.run.status, 'queued');
  assert.equal(out.run.phase, 'queued');
  assert.equal(out.run.revisionId, revised.revision.revisionId);
  assert.deepEqual(Object.keys(out.run).sort(), [
    'baseCommit', 'branchName', 'candidateId', 'controlRequest', 'createdAt', 'finishedAt', 'parentRunId', 'phase', 'planRevisionId',
    'revisionId', 'runId', 'runKind', 'startedAt', 'status', 'ticketId', 'updatedAt', 'waitDetail', 'waitReason']);
  assert.deepEqual(store.getRun(out.run.runId).settings, SNAPSHOT);
  const replay = store.submitTicket(created.ticketId, command, SNAPSHOT);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.runId, out.run.runId);
  assert.equal(store.listRuns(created.ticketId).length, 1);
  expectError(() => store.submitTicket(created.ticketId, { commandId: cmd(), expectedVersion: out.ticket.version }, SNAPSHOT), 'invalid_state');
  expectError(() => store.submitTicket('tkt_missing', { commandId: cmd(), expectedVersion: 1 }, SNAPSHOT), 'not_found');
  assert.throws(() => store.submitTicket(created.ticketId, { commandId: cmd(), expectedVersion: 1 }), TypeError);
  const other = store.createTicket(base()).ticket;
  expectError(() => store.submitTicket(other.ticketId, { commandId: cmd(), expectedVersion: 9 }, SNAPSHOT), 'stale_version');
});

test('the repository lease is FIFO, per ticket, and reports the holder as a dependency wait', async () => {
  const { store } = await makeStore();
  const first = submitNew(store, 'first');
  const second = submitNew(store, 'second');
  // No lease yet, but an older queued run goes first.
  assert.equal(store.acquireLease(second.runId).acquired, false);
  assert.equal(store.getRun(second.runId).waitDetail.message, 'Waiting for earlier queued work');
  assert.equal(store.acquireLease(first.runId).acquired, true);
  assert.equal(store.getLease().ticketId, first.ticketId);
  assert.equal(store.acquireLease(second.runId).acquired, false);
  const waiting = store.getRun(second.runId);
  assert.equal(waiting.waitReason, 'dependency');
  assert.match(waiting.waitDetail.message, /repository is in use by another ticket/i);
  assert.equal(waiting.waitDetail.holderTicketId, first.ticketId);
  const before = store.getTicket(second.ticketId).version;
  store.acquireLease(second.runId);
  assert.equal(store.getTicket(second.ticketId).version, before);
  assert.equal(store.getTicket(first.ticketId).status, 'in_progress');
  assert.equal(store.getRun(first.runId).phase, 'intake');
});

test('intake needs_input waits for an answer; answers are validated and a stale decision is refused', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  store.acquireLease(runId);
  const decision = store.requestIntakeAnswer(runId, { turn: 1, output: NEEDS_INPUT });
  assert.equal(decision.kind, 'intake_clarification');
  assert.equal(store.getTicket(ticketId).status, 'waiting_human');
  const run = store.getRun(runId);
  assert.deepEqual([run.status, run.phase, run.waitReason, run.intakeTurns], ['paused', 'awaiting_answer', 'human_decision', 1]);

  const version = store.getTicket(ticketId).version;
  const answer = (extra) => ({ commandId: cmd(), expectedVersion: version, ...extra });
  expectError(() => store.answerDecision(ticketId, decision.decisionId, answer({ answers: [] })), 'invalid_request');
  expectError(() => store.answerDecision(ticketId, decision.decisionId, answer({ answers: [{ questionId: 'zz', answer: 'x' }] })), 'invalid_request');
  expectError(() => store.answerDecision(ticketId, decision.decisionId, answer({ answer: 'x' })), 'invalid_request');
  expectError(() => store.answerDecision(ticketId, 'dec_missing', answer({ answers: [] })), 'not_found');
  expectError(() => store.answerDecision(ticketId, decision.decisionId, { ...answer({ answers: [{ questionId: 'q1', answer: 'x' }] }), expectedVersion: version + 5 }), 'stale_version');

  const command = answer({ answers: [{ questionId: 'q1', answer: '  blue ' }] });
  const out = store.answerDecision(ticketId, decision.decisionId, command);
  assert.equal(out.ticket.status, 'in_progress');
  assert.equal(out.decision.state, 'answered');
  assert.deepEqual(out.decision.answer, { answers: [{ questionId: 'q1', answer: 'blue' }] });
  const resumed = store.getRun(runId);
  assert.deepEqual([resumed.status, resumed.phase, resumed.waitReason], ['running', 'intake', null]);
  assert.equal(store.answerDecision(ticketId, decision.decisionId, command).replayed, true);
  expectError(() => store.answerDecision(ticketId, decision.decisionId, { ...command, commandId: cmd(), expectedVersion: out.ticket.version }), 'stale_decision');
  assert.equal(expectError(() => store.answerDecision(ticketId, decision.decisionId, { ...command, commandId: cmd(), expectedVersion: out.ticket.version }), 'stale_decision').status, 409);
});

test('lead decisions carry the lead pause payload, validate the choice and resume the run on answer', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  store.acquireLease(runId);
  store.saveIntakePlan(runId, {
    turn: 1, output: { ...NEEDS_INPUT, readiness: 'ready', questions: [], plan: PLAN }, classification: 'feature', plan: PLAN,
    checks: [], requirements: NEEDS_INPUT.requirements, validatorVersion: 'm3-plan-v1',
  });
  const pause = { kind: 'human_decision', decisionId: 'lead-dec-1', question: 'Which?', reason: 'product_choice', options: [{ id: 'a', description: 'A' }], recommendation: 'a' };
  // Not in the engineering phase yet: nothing is recorded.
  assert.equal(store.requestLeadDecision(runId, pause), null);
  store.recordBranch(runId, { branchName: null, baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, 'task-1', 'ctx-1');
  const decision = store.requestLeadDecision(runId, pause);
  assert.equal(decision.kind, 'lead_decision');
  assert.equal(store.requestLeadDecision(runId, pause).decisionId, decision.decisionId);
  assert.equal(store.findLeadDecision(runId, 'lead-dec-1').decisionId, decision.decisionId);
  assert.equal(store.getTicket(ticketId).status, 'waiting_human');
  assert.deepEqual([store.getRun(runId).status, store.getRun(runId).waitReason], ['paused', 'human_decision']);
  const view = store.getRunView(runId).decisions[0];
  assert.deepEqual(Object.keys(view.request).sort(), ['options', 'question', 'reason', 'recommendation']);

  const version = store.getTicket(ticketId).version;
  expectError(() => store.answerDecision(ticketId, decision.decisionId, { commandId: cmd(), expectedVersion: version, answer: 'x', choice: 'zzz' }), 'invalid_request');
  expectError(() => store.answerDecision(ticketId, decision.decisionId, { commandId: cmd(), expectedVersion: version, answer: 'no choice given' }), 'invalid_request');
  expectError(() => store.answerDecision(ticketId, decision.decisionId, { commandId: cmd(), expectedVersion: version, answers: [] }), 'invalid_request');
  expectError(() => store.answerDecision(ticketId, decision.decisionId, { commandId: cmd(), expectedVersion: version, answer: '   ' }), 'invalid_request');
  const out = store.answerDecision(ticketId, decision.decisionId, { commandId: cmd(), expectedVersion: version, answer: 'Go with A', choice: 'a' });
  assert.deepEqual(out.decision.answer, { answer: 'Go with A', choice: 'a' });
  assert.equal(out.ticket.status, 'in_progress');
  const run = store.getRun(runId);
  assert.deepEqual([run.status, run.phase, run.waitReason], ['running', 'engineering', null]);
});

test('cancel: backlog as before, queued and settled work settle at once, a completed run is not overwritten', async () => {
  const { store, db } = await makeStore();
  const pending = submitNew(store, 'pending');
  const queued = store.cancelTicket(pending.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(pending.ticketId).version });
  assert.equal(queued.ticket.status, 'cancelled');
  assert.equal(store.getRun(pending.runId).status, 'cancelled');

  // A blocked ticket whose run failed releases the lease and keeps the failed run as it was.
  const failed = submitNew(store, 'failed');
  store.acquireLease(failed.runId);
  store.settleRun(failed.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', waitDetail: { code: 'x', message: 'y' } });
  const cancelled = store.cancelTicket(failed.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(failed.ticketId).version });
  assert.equal(cancelled.ticket.status, 'cancelled');
  assert.equal(store.getLease(), null);
  assert.equal(store.getRun(failed.runId).status, 'failed');

  const review = submitNew(store, 'review');
  toReview(store, review.runId);
  assert.equal(store.getTicket(review.ticketId).status, 'waiting_human');
  assert.equal(store.getLease().ticketId, review.ticketId);
  const out = store.cancelTicket(review.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(review.ticketId).version });
  assert.equal(out.ticket.status, 'cancelled');
  assert.equal(store.getRun(review.runId).status, 'completed');
  assert.equal(store.getLease(), null);
  expectError(() => store.cancelTicket(review.ticketId, { commandId: cmd(), expectedVersion: out.ticket.version }), 'invalid_state');
  assert.ok(db);
});

test('cancel journals run_stopped only when it stops an active run', async () => {
  const recorded = [];
  const { store } = await makeStore({ events: { record: (type, event) => recorded.push({ type, ...event }) } });

  const active = submitNew(store, 'active cancellation');
  store.cancelTicket(active.ticketId, cc(store, active.ticketId));
  assert.equal(store.getRun(active.runId).status, 'cancelled');
  assert.equal(recorded.filter((event) => event.type === 'run_stopped' && event.runId === active.runId).length, 1);

  const completed = submitNew(store, 'completed review cancellation');
  toReview(store, completed.runId);
  assert.equal(store.getRun(completed.runId).status, 'completed');
  const before = recorded.filter((event) => event.type === 'run_stopped' && event.runId === completed.runId).length;
  store.cancelTicket(completed.ticketId, cc(store, completed.ticketId));
  assert.equal(store.getRun(completed.runId).status, 'completed');
  assert.equal(recorded.filter((event) => event.type === 'run_stopped' && event.runId === completed.runId).length, before);
});

test('a blocked ticket can be submitted again after a settled run and takes over its own lease', async () => {
  const { store } = await makeStore();
  const first = submitNew(store);
  store.acquireLease(first.runId);
  store.settleRun(first.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', waitDetail: { code: 'intake_error', message: 'boom' } });
  const ticket = store.getTicket(first.ticketId);
  assert.equal(ticket.status, 'blocked');
  const again = store.submitTicket(first.ticketId, { commandId: cmd(), expectedVersion: ticket.version }, SNAPSHOT);
  assert.equal(again.ticket.status, 'pending');
  assert.notEqual(again.run.runId, first.runId);
  assert.equal(store.acquireLease(again.run.runId).acquired, true);
  assert.equal(store.getLease().runId, again.run.runId);
  assert.deepEqual(store.listRuns(first.ticketId).map((r) => r.runId), [again.run.runId, first.runId]);
  assert.equal(store.getActiveRun(first.ticketId).runId, again.run.runId);
});

test('getRunView returns the pinned shapes and every ticket status change bumps the version', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const versions = [store.getTicket(ticketId).version];
  toReview(store, runId);
  versions.push(store.getTicket(ticketId).version);
  assert.ok(versions[1] > versions[0]);
  const view = store.getRunView(runId);
  assert.deepEqual(Object.keys(view).sort(), ['candidate', 'decisions', 'intake', 'leadTaskCardId', 'plan', 'run', 'settings', 'stages']);
  assert.deepEqual([view.run.status, view.run.phase, view.run.waitReason], ['completed', 'settled', 'human_review']);
  assert.equal(view.run.branchName, 'feature/work-abcdef');
  assert.deepEqual(Object.keys(view.plan).sort(), ['checks', 'classification', 'createdAt', 'planRevisionId', 'requirements', 'stages', 'validatorVersion']);
  assert.deepEqual(view.plan.checks, [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 1000, description: '' }]);
  assert.deepEqual(Object.keys(view.intake[0]).sort(), ['classification', 'createdAt', 'errors', 'questions', 'readiness', 'requirements', 'turn', 'unsupportedReason', 'valid']);
  assert.equal(view.intake[0].readiness, 'ready');
  assert.deepEqual(Object.keys(view.candidate).sort(), [
    'acceptance', 'baseCommit', 'branch', 'candidateId', 'createdAt', 'diffArtifactId', 'head', 'headMoved', 'integrityHash', 'manifest', 'truncated']);
  assert.deepEqual(Object.keys(view.candidate.acceptance).sort(), ['checks', 'disposition', 'reasons', 'warnings']);
  assert.equal(view.candidate.diffArtifactId, 'art_diff');
  assert.equal(store.getArtifact('art_diff').kind, 'candidate_diff');
  assert.deepEqual(store.listTicketArtifacts(ticketId), []);
  assert.deepEqual(view.stages.map((s) => [s.stageId, s.roleId, s.required, s.status]), [['build', 'orch-builder', true, 'succeeded'], ['audit', 'orch-auditor', true, 'failed']]);
  assert.deepEqual(view.stages[0].attempts, [{ attemptId: 'att-1', role: null, journalState: null, outcome: null }]);
  assert.equal(view.leadTaskCardId, `lr_${Buffer.from('orchestrator\u0000\u0000task-1', 'utf8').toString('base64url')}`);
  assert.deepEqual(view.settings, SNAPSHOT);
  assert.equal(store.getRunView('run_missing'), null);
  assert.deepEqual(store.getRunView(runId, { stages: [] }).stages, []);
});

test('public dirty-worktree run summaries include safe manual recovery guidance', async () => {
  const { store } = await makeStore();
  const { runId } = submitNew(store);
  const baseMessage = 'Repository preflight failed: dirty_worktree';
  store.settleRun(runId, {
    status: 'failed', ticketStatus: 'blocked', waitReason: 'dependency',
    waitDetail: { code: 'preflight_failed', message: baseMessage, problems: [{ code: 'dirty_worktree', message: 'The checkout is not clean' }] },
  });
  const view = store.getRunView(runId);
  assert.match(view.run.waitDetail.message, /git status --short and git diff/i);
  assert.match(view.run.waitDetail.message, /No files were removed/);
  assert.equal(store.getRun(runId).waitDetail.message, baseMessage);
});

test('at most one active run per ticket is enforced by the database', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const insert = () => db.prepare(
    "INSERT INTO runs (run_id, ticket_id, revision_id, project_id, status, phase, settings_snapshot_json, command_id, created_at, updated_at) "
    + "VALUES (?, ?, 'r', 'proj', ?, 'queued', '{}', 'c', 'now', 'now')",
  );
  assert.throws(() => insert().run('run_dup', ticketId, 'running'), /UNIQUE/);
  store.acquireLease(runId);
  store.settleRun(runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', waitDetail: { code: 'x', message: 'y' } });
  insert().run('run_ok', ticketId, 'queued');
});

test('live stages map journal attempts by stageId, so two stages with one role stay separate', async () => {
  const { db } = await makeStore();
  const journal = new DispatchJournal(db);
  const plan = {
    stages: [
      { stageId: 'build-a', roleId: 'orch-builder', dependencies: [], required: true },
      { stageId: 'build-b', roleId: 'orch-builder', dependencies: ['build-a'], required: true },
    ],
  };
  const base = { runId: 'lead-1', sandbox: 'workspace-write', contextId: 'c' };
  journal.recordSubmitting({ ...base, attemptId: 'a1', assignmentId: 'a1', role: 'orch-builder', stageId: 'build-a' });
  journal.recordSubmitted('a1', 't1');
  journal.recordFinished('a1', {
    status: 'TASK_STATE_COMPLETED',
    text: JSON.stringify({
      outcome: 'completed', summary: 'ok', filesChanged: [], filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null,
    }),
  });
  journal.recordSubmitting({ ...base, attemptId: 'a2', assignmentId: 'a2', role: 'orch-builder', stageId: 'build-b' });
  journal.recordSubmitting({ ...base, attemptId: 'a3', assignmentId: 'a3', role: 'orch-builder' });
  assert.equal(journal.get('a1').stageId, 'build-a');
  assert.equal(journal.get('a3').stageId, null);
  const stages = liveStages(db, { leadTaskId: 'lead-1' }, plan);
  assert.deepEqual(stages.map((s) => [s.stageId, s.status, s.attempts.map((a) => a.attemptId)]), [
    ['build-a', 'succeeded', ['a1']],
    ['build-b', 'running', ['a2']],
  ]);
  // Legacy rows without a stage id are ignored for stage mapping.
  const legacy = liveStages(db, { leadTaskId: 'nobody' }, plan);
  assert.deepEqual(legacy.map((s) => [s.status, s.attempts.length]), [['eligible', 0], ['pending', 0]]);
});

// ------------------------------------------------------------------ M7 operator controls

const ver = (store, ticketId) => store.getTicket(ticketId).version;
const cc = (store, ticketId, extra = {}) => ({ commandId: cmd(), expectedVersion: ver(store, ticketId), ...extra });

// Runs a rework run (started at phase 'branch') through to a new candidate under review.
function reworkToReview(store, runId, hash) {
  store.recordBranch(runId, { branchName: 'feature/work-abcdef', baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, `task-${runId}`, 'ctx');
  store.moveToCandidate(runId);
  return store.completeRun(runId, {
    candidate: {
      baseCommit: 'a'.repeat(40), head: 'a'.repeat(40), branch: 'feature/work-abcdef', headMoved: false,
      manifest: [{ path: 'a.js', status: 'M', sha256: 'f'.repeat(64), size: 3 }], truncated: false,
      acceptance: { disposition: 'accepted', reasons: [], checks: [], stages: [] }, integrityHash: hash,
    },
    diffArtifact: null,
    outcome: 'review',
  });
}

const reviewBody = (store, ticketId, runId, candidate, extra = {}) => cc(store, ticketId, {
  runId, candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, verdict: 'accept', ...extra,
});

test('pause settles a queued run at once and Resume restores it; commands are idempotent and version checked', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const pauseCmd = cc(store, ticketId, { runId });
  expectError(() => store.requestPause(ticketId, { ...pauseCmd, expectedVersion: 99 }), 'stale_version');
  const out = store.requestPause(ticketId, pauseCmd);
  assert.equal(out.outcome, 'settled');
  assert.equal(out.ticket.status, 'paused');
  assert.deepEqual([out.run.status, out.run.waitReason, out.run.controlRequest], ['paused', 'operator_pause', null]);
  assert.equal(out.ticket.version, 3);
  const replay = store.requestPause(ticketId, pauseCmd);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ticket.version, 3);
  expectError(() => store.requestPause(ticketId, cc(store, ticketId, { runId })), 'invalid_state');
  expectError(() => store.requestPause(ticketId, cc(store, ticketId, { runId: 'run_nope' })), 'not_found');
  expectError(() => store.requestPause(ticketId, cc(store, ticketId, {})), 'invalid_request');

  const resumed = store.resume(ticketId, cc(store, ticketId, { runId }));
  assert.deepEqual([resumed.run.status, resumed.run.phase, resumed.ticket.status, resumed.resumeLead], ['queued', 'queued', 'pending', null]);
  expectError(() => store.resume(ticketId, cc(store, ticketId, { runId })), 'invalid_state');
  assert.equal(store.acquireLease(runId).acquired, true);
});

test('pause on a running run is a request; the controller-side settle makes it paused and Resume continues the same plan', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  store.acquireLease(runId);
  store.saveIntakePlan(runId, {
    turn: 1, output: { ...NEEDS_INPUT, readiness: 'ready', questions: [], plan: PLAN }, classification: 'feature', plan: PLAN,
    checks: [], requirements: NEEDS_INPUT.requirements, validatorVersion: 'm3-plan-v1',
  });
  const planId = store.getRun(runId).planRevisionId;
  store.recordBranch(runId, { branchName: 'feature/x', baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, 'task-9', 'ctx-9');
  const requested = store.requestPause(ticketId, cc(store, ticketId, { runId }));
  assert.equal(requested.outcome, 'requested');
  assert.equal(requested.run.controlRequest, 'pause');
  assert.equal(requested.ticket.status, 'in_progress');
  assert.equal(store.controlForLeadTask('task-9'), 'pause');
  expectError(() => store.requestPause(ticketId, cc(store, ticketId, { runId })), 'invalid_state');

  const settled = store.settleControlRequest(runId);
  assert.deepEqual([settled.status, settled.waitReason, settled.controlRequest], ['paused', 'operator_pause', null]);
  assert.equal(store.getTicket(ticketId).status, 'paused');
  assert.equal(store.controlForLeadTask('task-9'), null);
  assert.equal(store.settleControlRequest(runId), null);

  const resumed = store.resume(ticketId, cc(store, ticketId, { runId }));
  assert.deepEqual(resumed.resumeLead, { taskId: 'task-9', contextId: 'ctx-9' });
  assert.deepEqual([resumed.run.status, resumed.run.phase, resumed.ticket.status], ['running', 'engineering', 'in_progress']);
  assert.equal(store.getRun(runId).planRevisionId, planId);
  assert.equal(store.listRuns(ticketId).length, 1);
});

test('stop, cancel and return-to-backlog: queued and awaiting_answer settle at once, others store a request', async () => {
  const { store } = await makeStore();
  // awaiting_answer: pending decision goes stale, no repository effect releases the lease.
  const waiting = submitNew(store, 'waiting');
  store.acquireLease(waiting.runId);
  const decision = store.requestIntakeAnswer(waiting.runId, { turn: 1, output: NEEDS_INPUT });
  const stopped = store.requestStop(waiting.ticketId, cc(store, waiting.ticketId, { runId: waiting.runId }));
  assert.equal(stopped.outcome, 'settled');
  assert.deepEqual([stopped.run.status, stopped.run.waitReason, stopped.ticket.status], ['stopped', 'run_stopped', 'blocked']);
  assert.equal(store.getDecision(decision.decisionId).state, 'stale');
  assert.equal(store.getLease(), null);

  // A stopped ticket can be submitted again (new run, resubmit kind).
  const again = store.submitTicket(waiting.ticketId, cc(store, waiting.ticketId), SNAPSHOT);
  assert.equal(again.run.runKind, 'resubmit');

  // Running run: a request, stop < return < cancel precedence, no duplicate of an equal or weaker request.
  const busy = submitNew(store, 'busy');
  store.settleRun(again.run.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', releaseLease: true });
  store.acquireLease(busy.runId);
  const stopCmd = cc(store, busy.ticketId, { runId: busy.runId });
  const req = store.requestStop(busy.ticketId, stopCmd);
  assert.equal(req.outcome, 'requested');
  assert.equal(req.run.controlRequest, 'stop');
  assert.equal(store.getRun(busy.runId).controlCommandId, stopCmd.commandId);
  expectError(() => store.requestStop(busy.ticketId, cc(store, busy.ticketId, { runId: busy.runId })), 'invalid_state');
  expectError(() => store.requestPause(busy.ticketId, cc(store, busy.ticketId, { runId: busy.runId })), 'invalid_state');
  const cancel = store.cancelTicket(busy.ticketId, cc(store, busy.ticketId));
  assert.equal(cancel.outcome, 'requested');
  assert.equal(cancel.run.controlRequest, 'cancel');
  expectError(() => store.returnToBacklog(busy.ticketId, cc(store, busy.ticketId)), 'invalid_state');
  assert.equal(store.controlForLeadTask('none'), null);
  const settled = store.settleControlRequest(busy.runId);
  assert.deepEqual([settled.status, settled.phase, settled.controlRequest], ['cancelled', 'settled', null]);
  assert.equal(store.getTicket(busy.ticketId).status, 'cancelled');
  assert.equal(store.getLease(), null);
});

test('a stop with repository effect keeps the lease; return to backlog promotes the staged revision', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store, 'effect');
  store.acquireLease(runId);
  store.saveIntakePlan(runId, {
    turn: 1, output: { ...NEEDS_INPUT, readiness: 'ready', questions: [], plan: PLAN }, classification: 'feature', plan: PLAN,
    checks: [], requirements: NEEDS_INPUT.requirements, validatorVersion: 'm3-plan-v1',
  });
  store.recordBranch(runId, { branchName: 'feature/effect', baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, 'task-e', 'ctx-e');

  // Non-backlog edit is staged: the ticket keeps its revision and title.
  const original = store.getTicket(ticketId);
  const staged = store.reviseTicket(ticketId, cc(store, ticketId, { title: 'Edited while running', description: 'new' }));
  assert.equal(staged.staged, true);
  assert.equal(staged.ticket.currentRevisionId, original.currentRevisionId);
  assert.equal(staged.ticket.title, 'effect');
  assert.equal(store.getStagedRevision(ticketId).title, 'Edited while running');
  assert.equal(store.getStagedRevision(ticketId).parentRevisionId, original.currentRevisionId);
  assert.equal(store.getRun(runId).revisionId, original.currentRevisionId);

  const out = store.returnToBacklog(ticketId, cc(store, ticketId));
  assert.equal(out.outcome, 'requested');
  assert.equal(out.run.controlRequest, 'return_to_backlog');
  assert.equal(store.controlForLeadTask('task-e'), 'stop');
  const settled = store.settleControlRequest(runId);
  assert.deepEqual([settled.status, settled.waitReason], ['stopped', 'run_stopped']);
  const ticket = store.getTicket(ticketId);
  assert.deepEqual([ticket.status, ticket.title, ticket.currentRevisionId], ['backlog', 'Edited while running', staged.revision.revisionId]);
  assert.equal(store.getStagedRevision(ticketId), null);
  assert.equal(store.getLease().ticketId, ticketId);

  // Backlog keeps the M2 behavior: no staging.
  const direct = store.reviseTicket(ticketId, cc(store, ticketId, { title: 'Backlog edit' }));
  assert.equal(direct.staged, undefined);
  assert.equal(direct.ticket.title, 'Backlog edit');
  assert.equal(store.getStagedRevision(ticketId), null);
});

test('submit from blocked promotes the staged revision first; done and cancelled tickets cannot be edited', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  store.acquireLease(runId);
  store.settleRun(runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', waitDetail: { code: 'x', message: 'y' } });
  const staged = store.reviseTicket(ticketId, cc(store, ticketId, { title: 'Staged title' }));
  assert.equal(staged.staged, true);
  const second = store.reviseTicket(ticketId, cc(store, ticketId, { title: 'Staged twice' }));
  assert.equal(second.revision.parentRevisionId, staged.revision.revisionId);
  const out = store.submitTicket(ticketId, cc(store, ticketId), SNAPSHOT);
  assert.equal(out.run.revisionId, second.revision.revisionId);
  assert.equal(out.ticket.title, 'Staged twice');
  assert.equal(out.run.runKind, 'resubmit');
  assert.equal(store.getStagedRevision(ticketId), null);

  const fresh = (await makeStore()).store;
  const done = submitNew(fresh, 'done');
  toReview(fresh, done.runId);
  const candidate = fresh.getCandidate(fresh.getRun(done.runId).candidateId);
  fresh.recordReview(done.ticketId, reviewBody(fresh, done.ticketId, done.runId, candidate));
  expectError(() => fresh.reviseTicket(done.ticketId, cc(fresh, done.ticketId, { title: 'x' })), 'invalid_state');
  expectError(() => fresh.cancelTicket(done.ticketId, cc(fresh, done.ticketId)), 'invalid_state');
  expectError(() => fresh.returnToBacklog(done.ticketId, cc(fresh, done.ticketId)), 'invalid_state');
});

test('review: stale binding has no effect, accept makes the ticket done, replay is idempotent', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const candidate = toReview(store, runId);
  const before = db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c;
  const bad = reviewBody(store, ticketId, runId, candidate, { integrityHash: 'x'.repeat(64) });
  expectError(() => store.recordReview(ticketId, bad), 'candidate_changed', (e) => assert.equal(e.status, 409));
  expectError(() => store.recordReview(ticketId, reviewBody(store, ticketId, runId, { ...candidate, candidateId: 'cand_other' })), 'candidate_changed');
  expectError(() => store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate, { verdict: 'maybe' })), 'invalid_request');
  expectError(() => store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate, { verdict: 'corrections' })), 'invalid_request');
  expectError(() => store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate, { findings: 'x' })), 'invalid_request');
  expectError(() => store.recordReview(ticketId, { ...reviewBody(store, ticketId, runId, candidate), expectedVersion: 1 }), 'stale_version');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c, before);
  assert.equal(store.getTicket(ticketId).status, 'waiting_human');

  const body = reviewBody(store, ticketId, runId, candidate);
  const out = store.recordReview(ticketId, body);
  assert.equal(out.ticket.status, 'done');
  assert.equal(out.review.verdict, 'accepted');
  assert.equal(out.review.candidateId, candidate.candidateId);
  assert.equal(store.getLatestReview(ticketId).reviewId, out.review.reviewId);
  assert.equal(store.getAcceptedReview(ticketId).reviewId, out.review.reviewId);
  assert.equal(store.recordReview(ticketId, body).replayed, true);
  assert.equal(store.getLease().ticketId, ticketId, 'a changed candidate keeps the lease until committed or released');
  expectError(() => store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate)), 'invalid_state');
});

test('an accepted read-only run with an empty manifest releases the lease', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  store.acquireLease(runId);
  store.saveIntakePlan(runId, {
    turn: 1, output: { ...NEEDS_INPUT, readiness: 'ready', questions: [], plan: PLAN }, classification: 'feature', plan: PLAN,
    checks: [], requirements: NEEDS_INPUT.requirements, validatorVersion: 'm3-plan-v1',
  });
  store.recordBranch(runId, { branchName: null, baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, 'task-ro', 'ctx');
  store.moveToCandidate(runId);
  const candidate = store.completeRun(runId, {
    candidate: { baseCommit: 'a'.repeat(40), head: 'a'.repeat(40), branch: 'main', headMoved: false, manifest: [], truncated: false, acceptance: null, integrityHash: 'e'.repeat(64) },
    diffArtifact: null, outcome: 'review',
  });
  store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate));
  assert.equal(store.getTicket(ticketId).status, 'done');
  assert.equal(store.getLease(), null);
});

test('an accepted read-only candidate with changes cannot be committed from main', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  store.acquireLease(runId);
  store.saveIntakePlan(runId, {
    turn: 1, output: { ...NEEDS_INPUT, readiness: 'ready', questions: [], plan: PLAN }, classification: 'feature', plan: PLAN,
    checks: [], requirements: NEEDS_INPUT.requirements, validatorVersion: 'm3-plan-v1',
  });
  store.recordBranch(runId, { branchName: null, baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(runId, 'task-read-only', 'ctx-read-only');
  store.moveToCandidate(runId);
  const candidate = store.completeRun(runId, {
    candidate: {
      baseCommit: 'a'.repeat(40), head: 'a'.repeat(40), branch: 'main', headMoved: false,
      manifest: [{ path: 'a.js', status: 'M', sha256: 'f'.repeat(64), size: 3 }], truncated: false,
      acceptance: null, integrityHash: 'e'.repeat(64),
    },
    diffArtifact: null, outcome: 'review',
  });
  store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate));

  const version = store.getTicket(ticketId).version;
  assert.equal(store.getLease().ticketId, ticketId);
  expectError(() => store.beginCommit(ticketId, cc(store, ticketId, {
    candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Commit read-only changes',
  })), 'invalid_state');
  assert.deepEqual(store.listDeliveries(ticketId), []);
  assert.equal(store.getTicket(ticketId).version, version);
});

test('corrections create a rework run on the same revision, transfer the lease, copy the plan and cap at three', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  let candidate = toReview(store, runId);
  const firstPlan = store.getRun(runId).planRevisionId;
  const leaseSince = store.getLease().acquiredAt;
  let parent = runId;
  const reworks = [];
  for (let n = 1; n <= 3; n += 1) {
    const out = store.recordReview(ticketId, reviewBody(store, ticketId, parent, candidate, { verdict: 'corrections', findings: `  fix round ${n} ` }));
    assert.equal(out.ticket.status, 'in_progress');
    assert.equal(out.review.verdict, 'corrections');
    assert.equal(out.review.findings, `fix round ${n}`);
    const rework = store.getRun(out.run.runId);
    const superseded = store.getRun(parent);
    assert.equal(superseded.status, 'completed');
    assert.equal(superseded.waitReason, null);
    assert.deepEqual(superseded.waitDetail, { code: 'corrections_requested', message: `Corrections requested; superseded by rework run ${rework.runId}` });
    assert.deepEqual([rework.runKind, rework.parentRunId, rework.reworkReviewId, rework.status, rework.phase],
      ['rework', parent, out.review.reviewId, 'running', 'branch']);
    assert.equal(rework.revisionId, store.getRun(runId).revisionId);
    assert.equal(rework.branchName, 'feature/work-abcdef');
    const plan = store.getPlanRevision(rework.planRevisionId);
    assert.equal(plan.parentPlanRevisionId, parent === runId ? firstPlan : store.getRun(parent).planRevisionId);
    assert.equal(plan.reason, `rework: ${out.review.reviewId}`);
    assert.deepEqual(plan.stages, PLAN.stages);
    assert.deepEqual(store.getLease(), { projectId: 'proj', runId: rework.runId, ticketId, acquiredAt: leaseSince });
    // The old review is spent and cannot be reused.
    expectError(() => store.recordReview(ticketId, reviewBody(store, ticketId, parent, candidate)), 'invalid_state');
    reworks.push(rework.runId);
    candidate = reworkToReview(store, rework.runId, `h${n}`.padEnd(64, '0'));
    parent = rework.runId;
    assert.equal(store.getTicket(ticketId).status, 'waiting_human');
  }
  const refused = expectError(() => store.recordReview(ticketId, reviewBody(store, ticketId, parent, candidate, { verdict: 'corrections', findings: 'again' })), 'rework_exhausted');
  assert.equal(refused.status, 409);
  assert.equal(store.getTicket(ticketId).status, 'waiting_human');
  assert.equal(store.getReviewForRun(parent), null);
  // Accepting the last candidate is still possible.
  assert.equal(store.recordReview(ticketId, reviewBody(store, ticketId, parent, candidate)).ticket.status, 'done');
  assert.equal(store.listRuns(ticketId).filter((r) => r.runKind === 'rework').length, 3);
});

test('commit and push records: intended, succeeded, failed, unknown; the lease follows the commit', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const candidate = toReview(store, runId);
  assert.equal(store.reserveBranch(candidate.branch, ticketId), true);
  const commitBody = (extra = {}) => cc(store, ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Add feature', ...extra });
  expectError(() => store.beginCommit(ticketId, commitBody()), 'invalid_state'); // not done yet
  store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate));
  expectError(() => store.beginCommit(ticketId, commitBody({ integrityHash: 'z'.repeat(64) })), 'candidate_changed');
  expectError(() => store.beginCommit(ticketId, commitBody({ message: '' })), 'invalid_request');
  expectError(() => store.beginCommit(ticketId, commitBody({ message: 'a\u0000b' })), 'invalid_request');
  expectError(() => store.beginCommit(ticketId, commitBody({ message: 'x'.repeat(2001) })), 'invalid_request');

  const body = commitBody();
  const begun = store.beginCommit(ticketId, body);
  assert.equal(begun.delivery.state, 'intended');
  assert.deepEqual([begun.delivery.kind, begun.delivery.branch, begun.delivery.baseHead], ['commit', 'feature/work-abcdef', 'a'.repeat(40)]);
  assert.equal(store.beginCommit(ticketId, body).replayed, true);
  expectError(() => store.beginCommit(ticketId, commitBody()), 'invalid_state'); // one intended commit per candidate
  expectError(() => store.releaseRepository(ticketId, cc(store, ticketId)), 'invalid_state');
  assert.deepEqual(store.listIntendedDeliveries().map((d) => d.deliveryId), [begun.delivery.deliveryId]);

  // A failed commit keeps the lease and allows a new commit command.
  const failed = store.finishDelivery(begun.delivery.deliveryId, { state: 'failed', error: { code: 'git_identity_missing', message: 'no identity' } });
  assert.deepEqual([failed.state, failed.error.code], ['failed', 'git_identity_missing']);
  assert.equal(store.finishDelivery(begun.delivery.deliveryId, { state: 'succeeded' }), null);
  assert.equal(store.getLease().ticketId, ticketId);
  const second = store.beginCommit(ticketId, commitBody());
  const sha = 'c'.repeat(40);
  const ok = store.finishDelivery(second.delivery.deliveryId, { state: 'succeeded', commitSha: sha });
  assert.equal(ok.commitSha, sha);
  assert.equal(store.getLease(), null);
  expectError(() => store.beginCommit(ticketId, commitBody()), 'invalid_state');

  const pushBody = (extra = {}) => cc(store, ticketId, { deliveryId: ok.deliveryId, commitSha: sha, remote: 'origin', ...extra });
  expectError(() => store.beginPush(ticketId, pushBody({ commitSha: 'd'.repeat(40) })), 'conflict');
  expectError(() => store.beginPush(ticketId, pushBody({ deliveryId: failed.deliveryId, commitSha: undefined })), 'invalid_request');
  expectError(() => store.beginPush(ticketId, pushBody({ deliveryId: failed.deliveryId })), 'conflict');
  expectError(() => store.beginPush(ticketId, pushBody({ deliveryId: 'dlv_none' })), 'not_found');
  expectError(() => store.beginPush(ticketId, pushBody({ remote: '-evil' })), 'invalid_request');
  const push = store.beginPush(ticketId, pushBody());
  assert.deepEqual([push.delivery.kind, push.delivery.parentDeliveryId, push.delivery.remoteRef, push.delivery.commitSha],
    ['push', ok.deliveryId, 'refs/heads/feature/work-abcdef', sha]);
  expectError(() => store.beginPush(ticketId, pushBody()), 'invalid_state'); // already in progress
  assert.equal(store.finishDelivery(push.delivery.deliveryId, { state: 'unknown', error: { code: 'git_failed', message: 'timeout' } }).state, 'unknown');
  const retry = store.beginPush(ticketId, pushBody());
  assert.notEqual(retry.delivery.deliveryId, push.delivery.deliveryId);
  assert.equal(store.finishDelivery(retry.delivery.deliveryId, { state: 'succeeded' }).state, 'succeeded');
  assert.deepEqual(store.listDeliveries(ticketId).map((d) => [d.kind, d.state]),
    [['commit', 'failed'], ['commit', 'succeeded'], ['push', 'unknown'], ['push', 'succeeded']]);
});

function committedTicket(store) {
  const { ticketId, runId } = submitNew(store);
  const candidate = toReview(store, runId);
  assert.equal(store.reserveBranch(candidate.branch, ticketId), true);
  store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate));
  const begun = store.beginCommit(ticketId, cc(store, ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'Add feature' }));
  const sha = 'c'.repeat(40);
  const commit = store.finishDelivery(begun.delivery.deliveryId, { state: 'succeeded', commitSha: sha });
  const pushBody = (extra = {}) => cc(store, ticketId, { deliveryId: commit.deliveryId, commitSha: sha, remote: 'origin', ...extra });
  return { ticketId, runId, candidate, commit, sha, pushBody };
}

test('push is once per commit and remote: succeeded blocks a repeat, failed allows a retry, replay returns the original', async () => {
  const { store, db } = await makeStore();
  const { ticketId, pushBody } = committedTicket(store);
  const pushRows = () => db.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE kind = 'push'").get().c;

  const failedPush = store.beginPush(ticketId, pushBody());
  store.finishDelivery(failedPush.delivery.deliveryId, { state: 'failed', error: { code: 'git_failed', message: 'rejected' } });
  const body = pushBody();
  const first = store.beginPush(ticketId, body);
  assert.notEqual(first.delivery.deliveryId, failedPush.delivery.deliveryId);
  store.finishDelivery(first.delivery.deliveryId, { state: 'succeeded' });
  assert.equal(pushRows(), 2);

  const replay = store.beginPush(ticketId, body);
  assert.equal(replay.replayed, true);
  assert.equal(replay.delivery.deliveryId, first.delivery.deliveryId);
  assert.equal(pushRows(), 2);

  const before = counts(db);
  const repeat = expectError(() => store.beginPush(ticketId, pushBody()), 'invalid_state');
  assert.match(repeat.message, /already pushed/);
  assert.equal(pushRows(), 2);
  assert.deepEqual(counts(db), before);
  // Another remote is a different effect and stays possible.
  assert.equal(store.beginPush(ticketId, pushBody({ remote: 'upstream' })).delivery.remote, 'upstream');
});

test('stale expectedVersion on stop, commit and push is refused with no effect', async () => {
  const { store, db } = await makeStore();
  const done = committedTicket(store);
  const running = submitNew(store, 'running');
  store.acquireLease(running.runId);
  const stale = (fn) => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM product_commands').get().c;
    expectError(fn, 'stale_version');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM product_commands').get().c, before);
  };
  const version = store.getTicket(running.ticketId).version;
  stale(() => store.requestStop(running.ticketId, { commandId: cmd(), expectedVersion: version - 1, runId: running.runId }));
  assert.equal(store.getRun(running.runId).controlRequest, null);

  const deliveries = store.listDeliveries(done.ticketId).length;
  const at = store.getTicket(done.ticketId).version - 1;
  stale(() => store.beginCommit(done.ticketId, { ...cc(store, done.ticketId, { candidateId: done.candidate.candidateId, integrityHash: done.candidate.integrityHash, message: 'again' }), expectedVersion: at }));
  stale(() => store.beginPush(done.ticketId, { ...done.pushBody(), expectedVersion: at }));
  assert.equal(store.listDeliveries(done.ticketId).length, deliveries);
});

test('a decision made stale by Stop or a new intake cannot be answered and has no effect', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  store.acquireLease(runId);
  const decision = store.requestIntakeAnswer(runId, { turn: 1, output: NEEDS_INPUT });
  store.requestStop(ticketId, cc(store, ticketId, { runId }));
  assert.equal(store.getDecision(decision.decisionId).state, 'stale');
  const answer = () => cc(store, ticketId, { answers: [{ questionId: 'q1', answer: 'late' }] });
  const commandsBefore = db.prepare('SELECT COUNT(*) AS c FROM product_commands').get().c;
  const refused = expectError(() => store.answerDecision(ticketId, decision.decisionId, answer()), 'stale_decision');
  assert.equal(refused.status, 409);
  assert.equal(store.getDecision(decision.decisionId).state, 'stale');
  assert.equal(store.getDecision(decision.decisionId).answer || null, null);
  assert.equal(store.getRun(runId).status, 'stopped');
  assert.equal(store.getTicket(ticketId).status, 'blocked');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM product_commands').get().c, commandsBefore);

  // A resubmit starts a new run; the old decision stays unanswerable.
  const again = store.submitTicket(ticketId, cc(store, ticketId), SNAPSHOT);
  expectError(() => store.answerDecision(ticketId, decision.decisionId, answer()), 'stale_decision');
  assert.equal(store.getRun(again.run.runId).status, 'queued');
  assert.equal(store.getDecision(decision.decisionId).state, 'stale');
});

test('release repository frees the lease of a done ticket without a commit', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const candidate = toReview(store, runId);
  expectError(() => store.releaseRepository(ticketId, cc(store, ticketId)), 'invalid_state'); // not done
  store.recordReview(ticketId, reviewBody(store, ticketId, runId, candidate));
  const body = cc(store, ticketId);
  const out = store.releaseRepository(ticketId, body);
  assert.equal(store.getLease(), null);
  assert.equal(out.ticket.status, 'done');
  assert.equal(store.releaseRepository(ticketId, body).replayed, true);
  expectError(() => store.releaseRepository(ticketId, cc(store, ticketId)), 'invalid_state'); // nothing held
  expectError(() => store.beginCommit(ticketId, cc(store, ticketId, { candidateId: candidate.candidateId, integrityHash: candidate.integrityHash, message: 'm' })), 'invalid_state');
});

test('release repository from a backlog draft preserves the stopped run and its branch', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  toReview(store, runId);
  store.returnToBacklog(ticketId, cc(store, ticketId));
  const beforeRun = store.getRun(runId);
  assert.equal(store.getTicket(ticketId).status, 'backlog');
  assert.equal(store.getLease().ticketId, ticketId);

  const released = store.releaseRepository(ticketId, cc(store, ticketId));
  assert.equal(released.ticket.status, 'backlog');
  assert.equal(store.getLease(), null);
  assert.deepEqual(store.getRun(runId), beforeRun);
  assert.equal(store.getRun(runId).branchName, 'feature/work-abcdef');
  assert.ok(store.listRuns(ticketId).some((run) => run.runId === runId));
});

// ---- natural settle never drops a pending control request (D-M7-3)

function toEngineeringRun(store, title) {
  const made = submitNew(store, title);
  store.acquireLease(made.runId);
  store.saveIntakePlan(made.runId, {
    turn: 1, output: { ...NEEDS_INPUT, readiness: 'ready', questions: [], plan: PLAN }, classification: 'feature', plan: PLAN,
    checks: [], requirements: NEEDS_INPUT.requirements, validatorVersion: 'm3-plan-v1',
  });
  store.recordBranch(made.runId, { branchName: `feature/${title}`, baseCommit: 'a'.repeat(40) });
  store.recordLeadTask(made.runId, `task-${title}`, `ctx-${title}`);
  return made;
}

const CANDIDATE = {
  baseCommit: 'a'.repeat(40), head: 'a'.repeat(40), branch: 'feature/x', headMoved: false,
  manifest: [{ path: 'a.js', status: 'M', sha256: 'f'.repeat(64), size: 3 }], truncated: false,
  acceptance: { disposition: 'accepted', reasons: [], checks: [], stages: [] }, integrityHash: 'h'.repeat(64),
};

test('settleRun keeps the natural status and applies a pending cancel or return to backlog', async () => {
  const events = [];
  const { store } = await makeStore({ events: { record: (type, e) => events.push({ type, ...e }) } });
  const a = toEngineeringRun(store, 'cancelme');
  store.cancelTicket(a.ticketId, cc(store, a.ticketId));
  const settledA = store.settleRun(a.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', releaseLease: false });
  assert.deepEqual([settledA.status, settledA.controlRequest], ['failed', null]);
  assert.equal(store.getTicket(a.ticketId).status, 'cancelled');
  assert.equal(store.getLease(), null);
  assert.ok(events.some((e) => e.type === 'control_requested' && e.runId === a.runId && e.payload.control === 'cancel' && e.payload.outcome === 'settled'));

  const b = toEngineeringRun(store, 'backlogme');
  const staged = store.reviseTicket(b.ticketId, cc(store, b.ticketId, { title: 'Edited', description: 'n' }));
  store.returnToBacklog(b.ticketId, cc(store, b.ticketId));
  const settledB = store.settleRun(b.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error' });
  assert.equal(settledB.status, 'failed');
  const ticket = store.getTicket(b.ticketId);
  assert.deepEqual([ticket.status, ticket.currentRevisionId], ['backlog', staged.revision.revisionId]);
  assert.equal(store.getLease().ticketId, b.ticketId); // repository effect keeps the lease
});

test('settleRun with a pending stop keeps the natural wait; a pending pause is moot; both are recorded', async () => {
  const events = [];
  const { store } = await makeStore({ events: { record: (type, e) => events.push({ type, ...e }) } });
  const a = toEngineeringRun(store, 'stopme');
  store.requestStop(a.ticketId, cc(store, a.ticketId, { runId: a.runId }));
  const settled = store.settleRun(a.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error' });
  assert.deepEqual([settled.status, settled.waitReason, settled.controlRequest], ['failed', 'execution_error', null]);
  assert.equal(store.getTicket(a.ticketId).status, 'blocked');
  assert.ok(events.some((e) => e.type === 'control_requested' && e.runId === a.runId && e.payload.control === 'stop' && e.payload.outcome === 'settled'));

  store.cancelTicket(a.ticketId, cc(store, a.ticketId)); // frees the lease the stopped run kept
  const b = submitNew(store, 'pauseme');
  assert.equal(store.acquireLease(b.runId).acquired, true);
  store.requestPause(b.ticketId, cc(store, b.ticketId, { runId: b.runId }));
  assert.equal(store.getRun(b.runId).controlRequest, 'pause');
  store.settleRun(b.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', releaseLease: true });
  assert.equal(store.getRun(b.runId).controlRequest, null);
  assert.ok(events.some((e) => e.type === 'control_requested' && e.runId === b.runId && e.payload.control === 'pause' && e.payload.outcome === 'moot'));
});

test('settleRun releases the lease only when the ticket had no repository effect', async () => {
  const { store } = await makeStore();
  const a = toEngineeringRun(store, 'effect2');
  store.settleRun(a.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', releaseLease: true });
  assert.equal(store.getLease().ticketId, a.ticketId);
});

test('settle and cancel retain repository ownership while the ticket lead writer is active or unresolved', async () => {
  const { store, db } = await makeStore();
  const made = toEngineeringRun(store, 'writer-held-cancel');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'product-writer-held-'));
  tempDirs.push(workspace);
  const admission = new WriterAdmission({ db, workspace, snapshot: () => ({ files: [] }) });
  const leadTaskId = store.getRun(made.runId).leadTaskId;
  const childTaskId = 'specialist-child-task';
  assert.notEqual(childTaskId, leadTaskId);
  const executionId = `developer:${childTaskId}`;
  admission.tryAdmit({ executionId, role: 'developer', taskId: childTaskId, contextId: 'child-ctx' }, { files: [] });

  expectError(() => store.settleRun(made.runId, {
    status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', releaseLease: true,
  }), 'invalid_state');
  assert.equal(store.getRun(made.runId).status, 'running');
  assert.equal(store.getLease().ticketId, made.ticketId);

  // A previously settled run must also refuse direct cancellation if durable writer
  // evidence still says its process may be writing.
  db.prepare("UPDATE runs SET status = 'failed', phase = 'settled', finished_at = ? WHERE run_id = ?")
    .run(new Date().toISOString(), made.runId);
  expectError(() => store.cancelTicket(made.ticketId, cc(store, made.ticketId)), 'invalid_state');
  assert.equal(store.getLease().ticketId, made.ticketId);
  assert.equal(store.getTicket(made.ticketId).status, 'in_progress');

  admission.release(executionId);
  const cancelled = store.cancelTicket(made.ticketId, cc(store, made.ticketId));
  assert.equal(cancelled.ticket.status, 'cancelled');
  assert.equal(store.getLease(), null);
});

test('completeRun with a pending control: cancel and return to backlog apply, stop and pause are moot', async () => {
  const events = [];
  const { store } = await makeStore({ events: { record: (type, e) => events.push({ type, ...e }) } });
  const finish = (made) => {
    store.moveToCandidate(made.runId);
    return store.completeRun(made.runId, { candidate: CANDIDATE, outcome: 'review' });
  };
  const a = toEngineeringRun(store, 'c1');
  store.cancelTicket(a.ticketId, cc(store, a.ticketId));
  assert.ok(finish(a));
  const runA = store.getRun(a.runId);
  assert.deepEqual([runA.status, runA.controlRequest, store.getTicket(a.ticketId).status], ['completed', null, 'cancelled']);
  assert.ok(runA.candidateId);
  assert.equal(store.getLease(), null);

  const b = toEngineeringRun(store, 'c2');
  store.returnToBacklog(b.ticketId, cc(store, b.ticketId));
  assert.ok(finish(b));
  assert.deepEqual([store.getRun(b.runId).status, store.getTicket(b.ticketId).status], ['completed', 'backlog']);
  assert.equal(store.getLease().ticketId, b.ticketId);
  store.cancelTicket(b.ticketId, cc(store, b.ticketId)); // free the lease for the next run

  const c = toEngineeringRun(store, 'c3');
  store.requestStop(c.ticketId, cc(store, c.ticketId, { runId: c.runId }));
  assert.ok(finish(c));
  assert.deepEqual([store.getRun(c.runId).controlRequest, store.getTicket(c.ticketId).status], [null, 'waiting_human']);
  assert.ok(events.some((e) => e.type === 'control_requested' && e.runId === c.runId && e.payload.control === 'stop' && e.payload.outcome === 'moot'));
  store.cancelTicket(c.ticketId, cc(store, c.ticketId));

  const d = toEngineeringRun(store, 'c4');
  store.requestPause(d.ticketId, cc(store, d.ticketId, { runId: d.runId }));
  assert.ok(finish(d));
  assert.deepEqual([store.getRun(d.runId).controlRequest, store.getTicket(d.ticketId).status], [null, 'waiting_human']);
});

test('a pending pause is moot once the run waits for a human answer, and Resume never applies to such a run', async () => {
  const { store } = await makeStore();
  const a = submitNew(store, 'intake-wait');
  store.acquireLease(a.runId);
  store.requestPause(a.ticketId, cc(store, a.ticketId, { runId: a.runId }));
  const decision = store.requestIntakeAnswer(a.runId, { turn: 1, output: NEEDS_INPUT });
  const run = store.getRun(a.runId);
  assert.deepEqual([run.status, run.phase, run.waitReason, run.controlRequest], ['paused', 'awaiting_answer', 'human_decision', null]);
  assert.equal(store.getDecision(decision.decisionId).state, 'pending');
  expectError(() => store.resume(a.ticketId, cc(store, a.ticketId, { runId: a.runId })), 'invalid_state');
  assert.equal(store.settleControlRequest(a.runId, 'pause'), null);
  store.answerDecision(a.ticketId, decision.decisionId, cc(store, a.ticketId, { answers: [{ questionId: 'q1', answer: 'x' }] }));

  store.cancelTicket(a.ticketId, cc(store, a.ticketId));
  store.settleControlRequest(a.runId, 'cancel');
  const b = toEngineeringRun(store, 'lead-wait');
  store.requestPause(b.ticketId, cc(store, b.ticketId, { runId: b.runId }));
  const pause = { kind: 'human_decision', decisionId: 'lead-dec-9', question: 'Which?', reason: 'product_choice', options: [{ id: 'a', description: 'A' }], recommendation: 'a' };
  const lead = store.requestLeadDecision(b.runId, pause);
  const runB = store.getRun(b.runId);
  assert.deepEqual([runB.waitReason, runB.controlRequest], ['human_decision', null]);
  expectError(() => store.resume(b.ticketId, cc(store, b.ticketId, { runId: b.runId })), 'invalid_state');
  assert.equal(store.getDecision(lead.decisionId).state, 'pending');
});

test('settleControlRequest settles only the request the caller evaluated', async () => {
  const { store } = await makeStore();
  const a = toEngineeringRun(store, 'cas');
  store.requestPause(a.ticketId, cc(store, a.ticketId, { runId: a.runId }));
  assert.equal(store.settleControlRequest(a.runId, 'stop'), null);
  assert.equal(store.getRun(a.runId).controlRequest, 'pause');
  assert.equal(store.settleControlRequest(a.runId, 'pause').status, 'paused');
});
