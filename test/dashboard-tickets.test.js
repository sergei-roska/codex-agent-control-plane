'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 1)]);
const newId = () => crypto.randomUUID();

test('dashboard tickets', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-dash-tickets-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const tokenFile = path.join(root, 'token', 'a2a-token');
  const stateFile = path.join(root, 'state.sqlite');
  let runtime = null;

  async function boot() {
    runtime = await startServer({
      port: 0,
      workspace,
      appServer: makeFakeAppServer({ leadScript: [] }),
      stateFile,
      tokenFile,
      orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
    });
    const origin = `http://127.0.0.1:${runtime.port}`;
    const base = `${origin}/api/dashboard/v1`;
    const bearer = `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}`;
    const api = { origin, base };
    api.pair = async () => {
      const codeRes = await fetch(`${base}/pairing-codes`, { method: 'POST', headers: { Authorization: bearer } });
      const { code } = await codeRes.json();
      const exchange = await fetch(`${base}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ code }),
      });
      assert.equal(exchange.status, 204);
      api.cookie = exchange.headers.get('set-cookie').split(';')[0];
    };
    api.get = (p) => fetch(`${base}${p}`, { headers: { Cookie: api.cookie } });
    api.json = async (p) => {
      const res = await api.get(p);
      assert.equal(res.status, 200, p);
      return res.json();
    };
    api.post = (p, body, { cookie = api.cookie, withOrigin = true } = {}) => fetch(`${base}${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(withOrigin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    });
    api.upload = (name, bytes, { cookie = api.cookie } = {}) => fetch(`${base}/artifacts`, {
      method: 'POST',
      headers: {
        Cookie: cookie, Origin: origin, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name),
      },
      body: bytes,
    });
    api.stage = async (name, bytes) => {
      const res = await api.upload(name, bytes);
      assert.equal(res.status, 201, name);
      return res.json();
    };
    api.create = async (extra = {}) => {
      const res = await api.post('/tickets', { commandId: newId(), title: 'Draft ticket', ...extra });
      assert.equal(res.status, 201);
      return res.json();
    };
    await api.pair();
    return api;
  }

  const count = (table) => runtime.state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const backups = () => fs.readdirSync(root).filter((name) => name.startsWith('state.sqlite.bak-'));

  let api = await boot();
  suite.after(async () => {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tasksBefore = count('tasks');
  const dispatchBefore = count('dispatch_journal');

  await suite.test('context advertises ticket commands and the pinned policy shape', async () => {
    const context = await api.json('/context');
    assert.deepEqual(context.capabilities, { mutations: true, liveStream: false, events: true, ticketCommands: ['create', 'revise', 'cancel'] });
    assert.equal(context.trackingMode, 'internal');
    assert.equal(context.requestedSpecialties.length, 9);
    assert.deepEqual(context.requestedSpecialties.find((s) => s.id === 'qa'), { id: 'qa', displayName: 'QA' });
    assert.deepEqual(context.requestedSpecialties.find((s) => s.id === 'tech-writer'), { id: 'tech-writer', displayName: 'Technical Writer' });
    const policy = context.attachmentPolicy;
    assert.deepEqual(Object.keys(policy).sort(), ['extractionCharLimit', 'formats', 'maxFileBytes', 'maxFiles', 'maxTotalBytes']);
    assert.equal(policy.maxFiles, 10);
    assert.equal(policy.maxFileBytes, 10485760);
    assert.equal(policy.maxTotalBytes, 26214400);
    assert.equal(policy.extractionCharLimit, 100000);
    assert.deepEqual(policy.formats.map((f) => f.extraction), ['extracted', 'stored_not_read', 'reference_only']);
    assert.deepEqual(policy.formats[0].extensions, ['.txt', '.md', '.json']);
    for (const format of policy.formats) assert.deepEqual(Object.keys(format).sort(), ['extensions', 'extraction', 'mediaTypes']);
  });

  await suite.test('create -> 201, appears in /cards backlog with counts, replay -> 200', async () => {
    const before = await api.json('/cards');
    const commandId = newId();
    const body = {
      commandId,
      title: 'Add export button',
      description: 'Operators need CSV export.',
      criteria: ['CSV downloads', 'Header row present'],
      priority: 'high',
      requestedSpecialty: 'developer',
      references: { jiraIssues: ['PROJ-1'], jiraParents: [], confluence: [], figma: [], links: ['https://example.test/x'] },
      artifactIds: [],
    };
    const res = await api.post('/tickets', body);
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.replayed, false);
    assert.match(created.ticket.ticketId, /^tkt_/);
    assert.equal(created.ticket.status, 'backlog');
    assert.equal(created.ticket.version, 1);
    assert.equal(created.revision.ordinal, 1);
    assert.deepEqual(created.revision.references.jiraIssues, [{ value: 'PROJ-1', availability: 'not_retrieved' }]);
    assert.deepEqual(created.revision.references.links, [{ value: 'https://example.test/x', availability: 'not_retrieved' }]);
    assert.deepEqual(Object.keys(created).sort(), ['replayed', 'revision', 'ticket']);

    const cards = await api.json('/cards');
    assert.equal(cards.counts.backlog, before.counts.backlog + 1);
    const card = cards.cards.find((c) => c.cardId === created.ticket.ticketId);
    assert.ok(card);
    assert.equal(card.cardKind, 'ticket');
    assert.equal(card.ticketId, card.cardId);
    assert.equal(card.boardColumn, 'backlog');
    assert.equal(card.executionStatus, null);
    assert.equal(card.displayStatus, 'Draft');
    assert.equal(card.primaryRole, null);
    assert.deepEqual(card.participatingRoles, []);
    assert.equal(card.requestedSpecialty, 'developer');
    assert.equal(card.priority, 'high');
    assert.equal(card.revisionOrdinal, 1);
    assert.equal(card.attachmentCount, 0);
    assert.equal(card.title, 'Add export button');

    const replay = await api.post('/tickets', body);
    assert.equal(replay.status, 200);
    const again = await replay.json();
    assert.equal(again.replayed, true);
    assert.equal(again.ticket.ticketId, created.ticket.ticketId);
    assert.equal(count('tickets') >= 1, true);
    assert.equal(runtime.state.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE title = ?').get('Add export button').n, 1);

    const other = await api.post('/tickets', { ...body, title: 'Different payload' });
    assert.equal(other.status, 409);
    assert.equal((await other.json()).error.code, 'conflict');
  });

  await suite.test('revise: stale version, ok, old revision unchanged, detail shape', async () => {
    const { ticket, revision } = await api.create({ title: 'Original title', description: 'first' });
    const stale = await api.post(`/tickets/${ticket.ticketId}/revisions`, { commandId: newId(), expectedVersion: 7, title: 'Nope' });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.error.code, 'stale_version');
    assert.equal(staleBody.error.details.currentVersion, 1);

    const ok = await api.post(`/tickets/${ticket.ticketId}/revisions`, {
      commandId: newId(), expectedVersion: 1, title: 'Revised title', description: 'second',
    });
    assert.equal(ok.status, 201);
    const revised = await ok.json();
    assert.equal(revised.revision.ordinal, 2);
    assert.equal(revised.revision.parentRevisionId, revision.revisionId);
    assert.equal(revised.ticket.version, 2);
    assert.equal(revised.ticket.title, 'Revised title');

    const detail = await api.json(`/tickets/${ticket.ticketId}`);
    assert.deepEqual(Object.keys(detail).sort(), ['activeRun', 'artifacts', 'availableActions', 'revision', 'revisions', 'runs', 'ticket', 'unavailableActions']);
    assert.equal(detail.revisions.length, 2);
    assert.deepEqual(Object.keys(detail.revisions[0]).sort(), ['actor', 'createdAt', 'parentRevisionId', 'ordinal', 'revisionId'].sort());
    assert.equal(detail.revision.revisionId, revised.revision.revisionId);
    assert.deepEqual(detail.availableActions, ['edit', 'submit', 'cancel']);
    assert.deepEqual(detail.runs, []);
    assert.equal(detail.activeRun, null);
    assert.deepEqual(detail.unavailableActions.map((a) => a.action),
      ['accept', 'corrections', 'pause', 'resume', 'stop', 'return_to_backlog', 'commit', 'push']);
    assert.ok(detail.unavailableActions.every((a) => a.action && a.reason && a.milestone === 'M7'));

    const old = await api.json(`/tickets/${ticket.ticketId}/revisions/${revision.revisionId}`);
    assert.deepEqual(Object.keys(old).sort(), ['artifacts', 'revision']);
    assert.equal(old.revision.title, 'Original title');
    assert.equal(old.revision.description, 'first');
    assert.deepEqual(old.artifacts, []);

    const missing = await api.get(`/tickets/${ticket.ticketId}/revisions/rev_nope`);
    assert.equal(missing.status, 404);
    assert.equal((await api.get('/tickets/tkt_nope')).status, 404);
  });

  await suite.test('cancel moves to Closed, then revise is invalid_state', async () => {
    const { ticket } = await api.create({ title: 'To be cancelled' });
    const res = await api.post(`/tickets/${ticket.ticketId}/cancel`, { commandId: newId(), expectedVersion: 1 });
    assert.equal(res.status, 201);
    const cancelled = await res.json();
    assert.equal(cancelled.ticket.status, 'cancelled');
    assert.equal(cancelled.ticket.version, 2);

    const cards = await api.json('/cards?column=closed&limit=100');
    const card = cards.cards.find((c) => c.cardId === ticket.ticketId);
    assert.equal(card.boardColumn, 'closed');
    assert.equal(card.displayStatus, 'Cancelled');

    const revise = await api.post(`/tickets/${ticket.ticketId}/revisions`, { commandId: newId(), expectedVersion: 2, title: 'Too late' });
    assert.equal(revise.status, 409);
    assert.equal((await revise.json()).error.code, 'invalid_state');

    const detail = await api.json(`/tickets/${ticket.ticketId}`);
    assert.deepEqual(detail.availableActions, []);
  });

  await suite.test('validation, origin, and session failures', async () => {
    const bad = await api.post('/tickets', { commandId: newId(), title: '', priority: 'urgent' });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.error.code, 'invalid_request');
    assert.ok(Array.isArray(badBody.error.details));
    const fields = badBody.error.details.map((d) => d.field);
    assert.ok(fields.includes('title') && fields.includes('priority'));
    const unknown = await api.post('/tickets', { commandId: newId(), title: 'x', surprise: 1 });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.details[0].field, 'surprise');

    const noOrigin = await api.post('/tickets', { commandId: newId(), title: 'x' }, { withOrigin: false });
    assert.equal(noOrigin.status, 403);
    const noOriginUpload = await fetch(`${api.base}/artifacts`, {
      method: 'POST', headers: { Cookie: api.cookie, 'X-Filename': 'a.txt' }, body: 'hello',
    });
    assert.equal(noOriginUpload.status, 403);

    const anon = await api.post('/tickets', { commandId: newId(), title: 'x' }, { cookie: null });
    assert.equal(anon.status, 401);
    const anonUpload = await fetch(`${api.base}/artifacts`, {
      method: 'POST', headers: { Origin: api.origin, 'X-Filename': 'a.txt' }, body: 'hello',
    });
    assert.equal(anonUpload.status, 401);
    assert.equal((await fetch(`${api.base}/tickets/tkt_x`)).status, 401);

    const malformed = await fetch(`${api.base}/tickets`, {
      method: 'POST', headers: { Cookie: api.cookie, Origin: api.origin, 'Content-Type': 'application/json' }, body: '{oops',
    });
    assert.equal(malformed.status, 400);
    const huge = await api.post('/tickets', { commandId: newId(), title: 'x', description: 'y'.repeat(1100 * 1024) });
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error.code, 'payload_too_large');
  });

  await suite.test('upload classes and rejections', async () => {
    const txt = await api.stage('notes.txt', Buffer.from('hello world\n'));
    assert.equal(txt.extraction, 'extracted');
    assert.equal(txt.state, 'staged');
    assert.equal(txt.mediaType, 'text/plain');
    assert.equal(txt.extractedChars, 12);
    assert.equal(txt.extractionTruncated, false);
    assert.equal(txt.size, 12);
    assert.match(txt.sha256, /^[0-9a-f]{64}$/);
    assert.equal(txt.storageRef, undefined);
    assert.deepEqual(Object.keys(txt).sort(),
      ['artifactId', 'createdAt', 'displayName', 'extractedChars', 'extractionTruncated', 'extraction', 'mediaType', 'sha256', 'size', 'state'].sort());

    assert.equal((await api.stage('shot.png', PNG)).extraction, 'stored_not_read');
    assert.equal((await api.stage('spec.pdf', PDF)).extraction, 'reference_only');

    const html = await api.upload('page.html', Buffer.from('<h1>x</h1>'));
    assert.equal(html.status, 415);
    assert.equal((await html.json()).error.code, 'unsupported_media_type');
    const fake = await api.upload('fake.png', Buffer.from('not a png'));
    assert.equal(fake.status, 415);

    const noName = await fetch(`${api.base}/artifacts`, {
      method: 'POST', headers: { Cookie: api.cookie, Origin: api.origin, 'Content-Type': 'text/plain' }, body: 'hello',
    });
    assert.equal(noName.status, 400);

    const big = await api.upload('big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    assert.equal(big.status, 413);
    assert.equal((await big.json()).error.code, 'payload_too_large');

    const meta = await api.json(`/artifacts/${txt.artifactId}`);
    assert.deepEqual(meta, txt);
    assert.equal((await api.get('/artifacts/art_nope')).status, 404);
  });

  await suite.test('download headers and bytes', async () => {
    const png = await api.stage('shot.png', PNG);
    const res = await api.get(`/artifacts/${png.artifactId}/content`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="shot\.png"; filename\*=UTF-8''shot\.png$/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);

    const text = Buffer.from('caf\u00e9 notes\n', 'utf8');
    const named = await api.stage('\u043e\u0442\u0447\u0451\u0442 "q".txt', text);
    const dl = await api.get(`/artifacts/${named.artifactId}/content`);
    assert.equal(dl.status, 200);
    const disposition = dl.headers.get('content-disposition');
    assert.ok(disposition.startsWith('attachment; filename="'));
    assert.ok(/^[\x20-\x7e]*$/.test(disposition));
    assert.ok(disposition.includes("filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%22q%22.txt"));
    assert.equal(dl.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), text);
  });

  await suite.test('artifacts attach on create and cannot be reused by a second ticket', async () => {
    const art = await api.stage('req.md', Buffer.from('# Requirements\n'));
    const { ticket } = await api.create({ title: 'With file', artifactIds: [art.artifactId] });
    const detail = await api.json(`/tickets/${ticket.ticketId}`);
    assert.equal(detail.artifacts.length, 1);
    assert.equal(detail.artifacts[0].artifactId, art.artifactId);
    assert.equal(detail.artifacts[0].state, 'attached');
    assert.equal(detail.artifacts[0].storageRef, undefined);
    assert.equal(detail.revision.artifactIds[0], art.artifactId);
    const card = (await api.json('/cards?q=With%20file')).cards.find((c) => c.cardId === ticket.ticketId);
    assert.equal(card.attachmentCount, 1);

    const second = await api.post('/tickets', { commandId: newId(), title: 'Thief', artifactIds: [art.artifactId] });
    assert.equal(second.status, 400);
    const secondBody = await second.json();
    assert.equal(secondBody.error.code, 'invalid_request');
    assert.equal(secondBody.error.details[0].field, 'artifactIds[0]');

    const dl = await api.get(`/artifacts/${art.artifactId}/content`);
    assert.equal(dl.status, 200);
  });

  await suite.test('board merge: ordering, paging, q, role, and ticket card ids', async () => {
    const { ticket } = await api.create({ title: 'Searchable needle title' });
    const byTitle = await api.json('/cards?q=NEEDLE');
    assert.deepEqual(byTitle.cards.map((c) => c.cardId), [ticket.ticketId]);
    const byId = await api.json(`/cards?q=${ticket.ticketId.toLowerCase()}`);
    assert.deepEqual(byId.cards.map((c) => c.cardId), [ticket.ticketId]);
    assert.deepEqual((await api.json('/cards?role=orch-explorer')).cards.filter((c) => c.cardKind === 'ticket'), []);

    const all = await api.json('/cards?limit=100');
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 100; i += 1) {
      const page = await api.json(`/cards?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.cards.map((c) => c.cardId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, all.cards.map((c) => c.cardId));
    assert.equal(all.counts.backlog + all.counts.closed, all.cards.length);

    const res = await api.get(`/cards/${ticket.ticketId}`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'not_found');
    assert.equal(body.error.details.ticketUrl, `/api/dashboard/v1/tickets/${ticket.ticketId}`);
    assert.equal((await api.get(`/cards/${ticket.ticketId}/events`)).status, 404);
  });

  await suite.test('events carry ids and counts only, never titles', async () => {
    const secret = 'Confidential-Title-Zebra';
    const art = await api.stage('secret-name-zebra.txt', Buffer.from('secret body zebra'));
    const { ticket } = await api.create({ title: secret, artifactIds: [art.artifactId] });
    const { ticket: updated } = await (await api.post(`/tickets/${ticket.ticketId}/revisions`, {
      commandId: newId(), expectedVersion: 1, title: `${secret} v2`, artifactIds: [art.artifactId],
    })).json();
    await api.post(`/tickets/${ticket.ticketId}/cancel`, { commandId: newId(), expectedVersion: updated.version });

    const { events, nextAfter } = await api.json(`/tickets/${ticket.ticketId}/events`);
    assert.deepEqual(events.map((e) => e.type), ['ticket_created', 'ticket_revised', 'ticket_cancelled']);
    assert.ok(events.every((e) => e.ticketId === ticket.ticketId));
    assert.equal(nextAfter, events[events.length - 1].sequence);
    assert.deepEqual(events[0].payload, { ordinal: 1, version: 1, artifactCount: 1 });
    assert.deepEqual(events[1].payload, { ordinal: 2, version: 2, artifactCount: 1 });
    assert.equal(events[2].payload.version, 3);
    const serialized = JSON.stringify(events);
    assert.ok(!/zebra/i.test(serialized));

    const tail = await api.json(`/tickets/${ticket.ticketId}/events?after=${events[0].sequence}&limit=1`);
    assert.equal(tail.events.length, 1);
    assert.equal(tail.events[0].type, 'ticket_revised');
    assert.equal((await api.get('/tickets/tkt_nope/events')).status, 404);
    assert.equal((await api.get(`/tickets/${ticket.ticketId}/events?limit=0`)).status, 400);

    const staged = runtime.state.db.prepare("SELECT * FROM runtime_events WHERE type = 'artifact_staged' ORDER BY sequence DESC").all();
    assert.ok(staged.length >= 1);
    assert.ok(!/zebra/i.test(JSON.stringify(staged)));
    assert.deepEqual(JSON.parse(staged[0].payload_json).extraction !== undefined, true);

    // A replay records nothing new.
    const before = (await api.json(`/tickets/${ticket.ticketId}/events`)).events.length;
    const commandId = newId();
    const body = { commandId, title: 'Replayed event check' };
    assert.equal((await api.post('/tickets', body)).status, 201);
    assert.equal((await api.post('/tickets', body)).status, 200);
    assert.equal((await api.json(`/tickets/${ticket.ticketId}/events`)).events.length, before);
    const replayedTicketId = runtime.state.db.prepare('SELECT ticket_id FROM requirement_revisions WHERE command_id = ?').get(commandId).ticket_id;
    assert.equal((await api.json(`/tickets/${replayedTicketId}/events`)).events.length, 1);
  });

  await suite.test('restart keeps data, prunes stale staged artifacts only, and does not back up again', async () => {
    const attachedArt = await api.stage('keep.txt', Buffer.from('keep me'));
    const { ticket } = await api.create({ title: 'Survivor', artifactIds: [attachedArt.artifactId] });
    await api.post(`/tickets/${ticket.ticketId}/revisions`, { commandId: newId(), expectedVersion: 1, title: 'Survivor v2', artifactIds: [attachedArt.artifactId] });
    const oldStaged = await api.stage('old.txt', Buffer.from('old staged'));
    const freshStaged = await api.stage('fresh.txt', Buffer.from('fresh staged'));
    const artifactRow = (id) => runtime.state.db.prepare('SELECT storage_ref FROM artifacts WHERE artifact_id = ?').get(id);
    const fileOf = (id) => path.join(root, 'artifacts', artifactRow(id).storage_ref);
    const oldFile = fileOf(oldStaged.artifactId);
    const keepFile = fileOf(attachedArt.artifactId);
    const freshFile = fileOf(freshStaged.artifactId);
    assert.ok(fs.existsSync(oldFile) && fs.existsSync(keepFile) && fs.existsSync(freshFile));
    const backupsBefore = backups();
    const ticketsBefore = count('tickets');
    const revisionsBefore = count('requirement_revisions');

    await runtime.close();
    const raw = new Database(stateFile);
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    raw.prepare('UPDATE artifacts SET created_at = ? WHERE artifact_id IN (?, ?)').run(past, oldStaged.artifactId, attachedArt.artifactId);
    raw.close();

    api = await boot();
    assert.equal(count('tickets'), ticketsBefore);
    assert.equal(count('requirement_revisions'), revisionsBefore);
    assert.deepEqual(backups(), backupsBefore);
    const detail = await api.json(`/tickets/${ticket.ticketId}`);
    assert.equal(detail.revisions.length, 2);
    assert.equal(detail.ticket.title, 'Survivor v2');
    assert.equal((await api.get(`/artifacts/${oldStaged.artifactId}`)).status, 404);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(keepFile), true);
    assert.equal(fs.existsSync(freshFile), true);
    assert.equal((await api.get(`/artifacts/${attachedArt.artifactId}`)).status, 200);
    assert.equal((await api.get(`/artifacts/${freshStaged.artifactId}`)).status, 200);
    const dl = await api.get(`/artifacts/${attachedArt.artifactId}/content`);
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString('utf8'), 'keep me');
  });

  await suite.test('a near-max multibyte ticket payload above 256 KiB is accepted', async () => {
    const item = '\u20ac'.repeat(2000);
    const references = {};
    for (const kind of ['jiraIssues', 'jiraParents', 'confluence', 'figma', 'links']) references[kind] = Array.from({ length: 20 }, () => item);
    const body = { commandId: newId(), title: 'Big', description: '\u20ac'.repeat(32000), references };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 256 * 1024);
    const res = await api.post('/tickets', body);
    assert.equal(res.status, 201);
  });

  await suite.test('staging caps reject by count and by bytes with 409 staging_limit', async () => {
    const db = runtime.state.db;
    db.prepare("DELETE FROM artifacts WHERE state = 'staged'").run();
    let accepted = 0;
    for (; accepted < 60; accepted += 1) {
      const res = await api.upload(`cap-${accepted}.txt`, Buffer.from(`x${accepted}`));
      if (res.status !== 201) {
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.error.code, 'staging_limit');
        assert.match(body.error.message, /Too many pending uploads/);
        break;
      }
    }
    assert.equal(accepted, 50);
    db.prepare("DELETE FROM artifacts WHERE state = 'staged'").run();
    db.prepare(
      "INSERT INTO artifacts (artifact_id, ticket_id, state, kind, media_type, display_name, size, sha256, storage_ref, "
      + "extraction, extracted_chars, extraction_truncated, origin, created_at) "
      + "VALUES ('art_bigbigbigbigbigbigbig', NULL, 'staged', 'attachment', 'text/plain', 'big.txt', ?, 'x', 'bi/art_bigbigbigbigbigbigbig', "
      + "'extracted', 0, 0, 'operator_upload', ?)",
    ).run(100 * 1024 * 1024 - 1000, new Date().toISOString());
    const over = await api.upload('over.txt', Buffer.alloc(2000, 97));
    assert.equal(over.status, 409);
    assert.equal((await over.json()).error.code, 'staging_limit');
    const fits = await api.upload('fits.txt', Buffer.alloc(500, 97));
    assert.equal(fits.status, 201);
    db.prepare("DELETE FROM artifacts WHERE state = 'staged'").run();
  });

  await suite.test('ticket commands create no A2A task or dispatch row', async () => {
    assert.equal(count('tasks'), tasksBefore);
    assert.equal(count('dispatch_journal'), dispatchBefore);
  });
});
