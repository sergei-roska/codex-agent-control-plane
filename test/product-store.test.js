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
    'baseCommit', 'branchName', 'candidateId', 'createdAt', 'finishedAt', 'phase', 'planRevisionId', 'revisionId', 'runId',
    'startedAt', 'status', 'ticketId', 'updatedAt', 'waitDetail', 'waitReason']);
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
  assert.equal(waiting.waitDetail.message, `Repository in use by ${first.ticketId}`);
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

test('cancel: backlog as before, settled waiting_human/blocked tickets release the lease, active work is refused', async () => {
  const { store, db } = await makeStore();
  const pending = submitNew(store, 'pending');
  const refusal = expectError(() => store.cancelTicket(pending.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(pending.ticketId).version }), 'invalid_state');
  assert.equal(refusal.message, 'Stopping active work arrives in M7');
  store.acquireLease(pending.runId);
  assert.equal(expectError(() => store.cancelTicket(pending.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(pending.ticketId).version }), 'invalid_state').message, 'Stopping active work arrives in M7');

  // A blocked ticket whose run is still marked running counts as active execution.
  db.prepare("UPDATE tickets SET status = 'blocked' WHERE ticket_id = ?").run(pending.ticketId);
  assert.equal(expectError(() => store.cancelTicket(pending.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(pending.ticketId).version }), 'invalid_state').message, 'Stopping active work arrives in M7');
  store.settleRun(pending.runId, { status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error', waitDetail: { code: 'x', message: 'y' } });
  const cancelled = store.cancelTicket(pending.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(pending.ticketId).version });
  assert.equal(cancelled.ticket.status, 'cancelled');
  assert.equal(store.getLease(), null);
  assert.equal(store.getRun(pending.runId).status, 'failed');

  const review = submitNew(store, 'review');
  toReview(store, review.runId);
  assert.equal(store.getTicket(review.ticketId).status, 'waiting_human');
  assert.equal(store.getLease().ticketId, review.ticketId);
  const out = store.cancelTicket(review.ticketId, { commandId: cmd(), expectedVersion: store.getTicket(review.ticketId).version });
  assert.equal(out.ticket.status, 'cancelled');
  assert.equal(store.getRun(review.runId).status, 'cancelled');
  assert.equal(store.getLease(), null);
  expectError(() => store.cancelTicket(review.ticketId, { commandId: cmd(), expectedVersion: out.ticket.version }), 'invalid_state');
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
  assert.deepEqual(Object.keys(view.candidate.acceptance).sort(), ['checks', 'disposition', 'reasons']);
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
