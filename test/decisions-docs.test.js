'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const Database = require('better-sqlite3');
const { EventJournal } = require('../src/event-journal');
const {
  projectDecisions,
  collectDecisions,
  projectDocs,
  readDocsCatalog,
  DOC_MAX_CHARS,
} = require('../src/dashboard-projection');
const { createDashboardApi } = require('../src/dashboard-api');
const { migrateProductSchema } = require('../src/product-migrations');
const { ProductStore } = require('../src/product-store');

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let clock = Date.parse('2026-10-01T10:00:00.000Z');
let cmdSeq = 0;
const cmd = () => `cmd-${String(++cmdSeq).padStart(6, '0')}`;
const base = (extra = {}) => ({ commandId: cmd(), title: 'Fix login', ...extra });

async function makeStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-docs-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'state.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  await migrateProductSchema({ db, filePath: file });
  const store = new ProductStore({
    db, projectId: 'proj', now: () => new Date((clock += 1000)), ...options,
  });
  return { store, db, dir };
}

const SNAPSHOT = { provider: 'openai', rolePack: 'legacy-orch', promptVersions: { intake: 'pm-intake-v1', lead: 'pm-lead-v1' } };
const PLAN = {
  stages: [{ stageId: 'build', roleId: 'orch-builder', objective: 'Build', dependencies: [], allowedFiles: ['a.js'], required: true }],
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
        stages: [{ stageId: 'build', status: 'succeeded', attemptIds: ['att-1'] }],
      },
      integrityHash: 'h'.repeat(64),
    },
    diffArtifact: { artifactId: 'art_diff', displayName: 'candidate.diff', size: 10, sha256: 'd'.repeat(64), storageRef: 'ref/art_diff' },
    outcome: 'review',
  });
}

function makeDocsPack(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-pack-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'TEAM.md'), '# Team\nSafe content.\n');
  fs.writeFileSync(path.join(dir, 'agents', 'architect.toml'), 'role = "architect"\n');
  fs.writeFileSync(path.join(dir, 'presets', 'feature.json'), JSON.stringify({ id: 'feature' }));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    packId: 'test',
    version: '1.0.0',
    coordinator: { publicId: 'pm', runtimeId: 'pm' },
    roles: [{ publicId: 'architect', runtimeId: 'architect', displayName: 'A' }],
    repairChains: {},
    presets: ['feature'],
    unavailablePresets: ['missing'],
  }));
  if (extra.leakyTeam) {
    fs.writeFileSync(path.join(dir, 'TEAM.md'), 'token sk-SECRETKEY99 and Bearer abc.def.ghi\n');
  }
  if (extra.longTeam) {
    fs.writeFileSync(path.join(dir, 'TEAM.md'), 'x'.repeat(DOC_MAX_CHARS + 500));
  }
  if (extra.nulAgent) {
    fs.mkdirSync(path.join(dir, 'agents', 'binary.toml'));
  }
  if (extra.nulFile) {
    fs.writeFileSync(path.join(dir, 'agents', 'nul.toml'), Buffer.from([0x61, 0x00, 0x62]));
  }
  return dir;
}

test('empty successful decisions projection', () => {
  const read = collectDecisions({ listTickets: () => [], listReviews: () => [], listControlRequests: () => [], latestRunOf: () => null, getReviewForRun: () => null, getCandidate: () => null, listRuns: () => [], listDecisions: () => [], getRun: () => null });
  const projected = projectDecisions(read);
  assert.equal(projected.available, true);
  assert.deepEqual(projected.pending, []);
  assert.deepEqual(projected.responses, []);
});

test('pending and answered run decisions are projected with safe request text and version bindings', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  const ticket = store.getTicket(ticketId);
  const run = store.getRun(runId);
  db.prepare("UPDATE tickets SET status = 'waiting_human', version = version + 1 WHERE ticket_id = ?").run(ticketId);
  db.prepare("UPDATE runs SET status = 'running' WHERE run_id = ?").run(runId);
  db.prepare('INSERT INTO decisions (decision_id, kind, ticket_id, run_id, revision_id, plan_revision_id, state, request_json, answer_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('dec_pending', 'intake_clarification', ticketId, runId, run.revisionId, run.planRevisionId, 'pending', JSON.stringify({ questions: [{ id: 'q1', question: 'Use token=secret-value?', why: 'Needed' }] }), null, new Date().toISOString());
  db.prepare('INSERT INTO decisions (decision_id, kind, ticket_id, run_id, revision_id, plan_revision_id, state, request_json, answer_json, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('dec_answered', 'lead_decision', ticketId, runId, run.revisionId, run.planRevisionId, 'answered', JSON.stringify({ question: 'Pick one', options: [{ id: 'a', description: 'First' }] }), JSON.stringify({ answer: 'Choose A', choice: 'a' }), new Date().toISOString(), new Date().toISOString());

  const projected = projectDecisions(collectDecisions(store));
  const pending = projected.pending.find((item) => item.decisionId === 'dec_pending');
  const answered = projected.responses.find((item) => item.decisionId === 'dec_answered');
  assert.equal(pending.actionable, true);
  assert.equal(pending.ticketId, ticketId);
  assert.equal(pending.runId, runId);
  assert.equal(pending.revisionId, run.revisionId);
  assert.equal(pending.planRevisionId, run.planRevisionId);
  assert.equal(pending.expectedVersion, store.getTicket(ticketId).version);
  assert.equal(pending.request.questions[0].question.includes('secret-value'), false);
  assert.deepEqual(answered.answer, { answer: 'Choose A', choice: 'a' });
  assert.equal(answered.actionable, false);

  const currentVersion = store.getTicket(ticketId).version;
  store.reviseTicket(ticketId, { commandId: cmd(), expectedVersion: currentVersion, title: 'Changed after decision' });
  const staged = store.getStagedRevision(ticketId);
  db.prepare('UPDATE tickets SET current_revision_id = ?, staged_revision_id = NULL WHERE ticket_id = ?').run(staged.revisionId, ticketId);
  const staleProjection = projectDecisions(collectDecisions(store));
  const stalePending = staleProjection.pending.find((item) => item.decisionId === 'dec_pending');
  assert.equal(stalePending.state, 'stale');
  assert.equal(stalePending.actionable, false);
  assert.equal(stalePending.binding, 'stale');
});

test('failed or missing store does not throw; available false', () => {
  let result;
  assert.doesNotThrow(() => { result = projectDecisions({ ok: false, reason: 'disk read failed' }); });
  assert.equal(result.available, false);
  assert.deepEqual(result.pending, []);
  const missing = collectDecisions(null);
  assert.equal(missing.ok, false);
  assert.equal(projectDecisions(missing).available, false);
});

test('pending human review is actionable with binding metadata', async () => {
  const { store } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  toReview(store, runId);
  const read = collectDecisions(store);
  assert.equal(read.ok, true);
  const projected = projectDecisions(read);
  const pending = projected.pending.find((item) => item.kind === 'review');
  assert.ok(pending);
  assert.equal(pending.actionable, true);
  assert.equal(pending.binding, 'current');
  assert.equal(pending.ticketId, ticketId);
  assert.equal(pending.runId, runId);
  assert.ok(pending.revisionId);
  assert.ok(pending.candidateId);
  assert.ok(pending.integrityHash);
});

test('stale accepted review is not authorized after revision change', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  toReview(store, runId);
  const ticket = store.getTicket(ticketId);
  const run = store.getRun(runId);
  const candidate = store.getCandidate(run.candidateId);
  db.prepare(
    'INSERT INTO reviews (review_id, ticket_id, run_id, revision_id, plan_revision_id, candidate_id, integrity_hash, verdict, findings, actor, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('rvw_old', ticketId, runId, run.revisionId, run.planRevisionId, candidate.candidateId, candidate.integrityHash, 'accepted', null, 'operator', cmd(), new Date().toISOString());
  store.reviseTicket(ticketId, { commandId: cmd(), expectedVersion: ticket.version, title: 'v2' });
  const staged = store.getStagedRevision(ticketId);
  assert.ok(staged);
  db.prepare('UPDATE tickets SET current_revision_id = ?, staged_revision_id = NULL WHERE ticket_id = ?').run(staged.revisionId, ticketId);
  const response = projectDecisions(collectDecisions(store)).responses.find((r) => r.id === 'rvw_old');
  assert.ok(response);
  assert.equal(response.binding, 'stale');
  assert.equal(response.authorized, false);
});

test('findings secrets are redacted in decisions projection', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  toReview(store, runId);
  const run = store.getRun(runId);
  const candidate = store.getCandidate(run.candidateId);
  const leaky = 'model sk-LEAKME99abcd failed';
  db.prepare(
    'INSERT INTO reviews (review_id, ticket_id, run_id, revision_id, plan_revision_id, candidate_id, integrity_hash, verdict, findings, actor, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('rvw_leak', ticketId, runId, run.revisionId, run.planRevisionId, candidate.candidateId, candidate.integrityHash, 'corrections', leaky, 'operator', cmd(), new Date().toISOString());
  const json = JSON.stringify(projectDecisions(collectDecisions(store)));
  assert.equal(json.includes('LEAKME99'), false);
});

test('pending pause control_request is operator_command and not authorized', async () => {
  const { store, db } = await makeStore();
  const { ticketId, runId } = submitNew(store);
  db.prepare("UPDATE runs SET control_request = 'pause', control_requested_at = ? WHERE run_id = ?").run(new Date().toISOString(), runId);
  const pending = projectDecisions(collectDecisions(store)).pending.find((p) => p.kind === 'operator_command');
  assert.ok(pending);
  assert.equal(pending.command, 'pause');
  assert.equal(pending.authorized, false);
  assert.equal(pending.actionable, false);
  assert.equal(pending.ticketId, ticketId);
});

test('docs catalog reads pack files with redaction and truncation', () => {
  const packDir = makeDocsPack({ leakyTeam: true, longTeam: true, nulFile: true, nulAgent: true });
  const catalog = readDocsCatalog({
    packDir,
    projectConfig: { source: 'defaults', revision: 'abc', baseRef: 'main', branchPrefixes: {}, rolePack: 'delivery', delivery: { remotes: ['origin'] }, checks: [] },
    projectConfigPath: null,
  });
  assert.equal(catalog.ok, true);
  const team = catalog.documents.find((d) => d.id === 'role:team');
  assert.equal(team.source, 'role');
  assert.equal(team.status, 'truncated');
  assert.equal(team.content.length, DOC_MAX_CHARS);
  assert.equal(String(team.content).includes('SECRETKEY99'), false);
  const preset = catalog.documents.find((d) => d.id === 'preset:feature');
  assert.equal(preset.status, 'available');
  const missing = catalog.documents.find((d) => d.id === 'preset:missing');
  assert.equal(missing.status, 'unavailable');
  const nul = catalog.documents.find((d) => d.id === 'role:nul');
  assert.equal(nul.status, 'unavailable');
  assert.doesNotThrow(() => readDocsCatalog({ packDir: '/no/such/pack', projectConfig: null, projectConfigPath: null }));
});

test('GET /docs does not expose prototype fixture titles', async (t) => {
  const packDir = makeDocsPack();
  const db = new Database(':memory:');
  const events = new EventJournal({ db });
  events.ensureSchema();
  const app = express();
  app.use(createDashboardApi({
    projection: { listCards: () => ({ cards: [] }) },
    events,
    projectId: 'prj_test',
    docsPackDir: packDir,
    projectConfig: { source: 'defaults', revision: 'r', baseRef: 'main', branchPrefixes: {}, rolePack: 'delivery', delivery: { remotes: ['origin'] }, checks: [] },
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) {} resolve(); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/docs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const text = JSON.stringify(body);
  assert.equal(text.includes('Architecture-Overview'), false);
  assert.equal(text.includes('Locked ADR'), false);
  assert.equal(body.available, true);
});

test('GET /decisions failure returns 200 without breaking other routes', async (t) => {
  const db = new Database(':memory:');
  const events = new EventJournal({ db });
  events.ensureSchema();
  const throwingStore = {
    listTickets() { throw new Error('store exploded'); },
    listReviews: () => [],
    listControlRequests: () => [],
    latestRunOf: () => null,
    getReviewForRun: () => null,
    getCandidate: () => null,
  };
  const app = express();
  app.use(createDashboardApi({
    projection: { listCards: () => ({ cards: [] }) },
    events,
    projectId: 'prj_test',
    productStore: throwingStore,
    workspace: process.cwd(),
    docsPackDir: '/no/such/pack-dir',
    projectConfig: null,
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) {} resolve(); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const decisions = await fetch(`${origin}/decisions`);
  assert.equal(decisions.status, 200);
  const body = await decisions.json();
  assert.equal(body.available, false);
  const monitor = await fetch(`${origin}/monitor`);
  assert.equal(monitor.status, 200);
  const context = await fetch(`${origin}/context`);
  assert.equal(context.status, 200);
  const docs = await fetch(`${origin}/docs`);
  assert.equal(docs.status, 200);
});

function createDocument() {
  const byId = new Map();
  let activeElement = null;
  class El {
    constructor(tag) {
      this.tagName = String(tag).toLowerCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.className = '';
      this._text = '';
      this.disabled = false;
      this._value = '';
      this.dataset = {};
      this.listeners = {};
      this.id = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.selectionDirection = 'none';
    }
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent).join('');
      return this._text;
    }
    set textContent(value) {
      this.children = [];
      this._text = value == null ? '' : String(value);
    }
    setAttribute(name, value) {
      const text = String(value);
      this.attributes[name] = text;
      if (name === 'id') { this.id = text; byId.set(text, this); }
      if (name === 'value') this._value = text;
    }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); if (child.id) byId.set(child.id, child); return child; }
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({ type, target: this })); }
    click() { (this.listeners.click || []).forEach((fn) => fn({ type: 'click', target: this })); }
    focus() { activeElement = this; }
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction || 'none'; }
    get value() { return this._value; }
    set value(v) { this._value = String(v); }
    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => {
        if (selector === 'textarea.decisions-findings' && node.tagName === 'textarea' && /(^|\s)decisions-findings(\s|$)/.test(node.className)) matches.push(node);
        node.children.forEach(visit);
      };
      visit(this);
      return matches;
    }
    closest(sel) {
      if (sel === '[data-action]' && this.getAttribute('data-action')) return this;
      return this.parentNode && this.parentNode.closest ? this.parentNode.closest(sel) : null;
    }
  }
  const root = new El('div');
  ['adr-list', 'escalation-list', 'docs-list', 'doc-viewer-content', 'active-doc-title', 'doc-copy-status', 'btn-toggle-raw', 'btn-copy-doc'].forEach((id) => {
    const el = new El('div');
    el.id = id;
    byId.set(id, el);
    root.appendChild(el);
  });
  return { get activeElement() { return activeElement; }, getElementById: (id) => byId.get(id) || null, createElement: (tag) => new El(tag), querySelector: (sel) => {
    if (sel && sel.indexOf('data-id') !== -1) return null;
    return null;
  }, querySelectorAll: () => [] };
}

test('decisions UI shows stale not authorized and posts review only', async () => {
  const ctx = vm.createContext({
    document: createDocument(),
    state: { activeTab: 'tab-decisions' },
    console,
    window: { confirm: () => true },
    apiGet: async () => projectDecisions({
      ok: true,
      pending: [{
        id: 'review:run-1', kind: 'review', ticketId: 'tkt_1', ticketTitle: 'T', runId: 'run-1', revisionId: 'rev_old', planRevisionId: null,
        candidateId: 'cand_1', integrityHash: 'h'.repeat(64), binding: 'stale', authorized: false, actionable: true, expectedVersion: 2,
      }],
      responses: [{ id: 'rvw_1', ticketId: 'tkt_1', ticketTitle: 'T', runId: 'run-1', revisionId: 'rev_old', binding: 'stale', authorized: false, verdict: 'accepted' }],
    }),
    apiPost: async () => { throw new Error('should not post stale'); },
  });
  const root = path.join(__dirname, '..', 'web', 'dashboard', 'js');
  vm.runInContext(fs.readFileSync(path.join(root, 'util.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'tabs', 'decisions.js'), 'utf8'), ctx);
  ctx.applyDecisionsSnapshot(await ctx.apiGet());
  const text = ctx.document.getElementById('adr-list').textContent + ctx.document.getElementById('escalation-list').textContent;
  assert.match(text, /not authorized/i);
  assert.equal(text.includes('Locked ADR'), false);
  assert.equal(text.includes('Secret required'), false);

  let posted = null;
  ctx.apiPost = async (url, body) => { posted = { url, body }; return {}; };
  ctx.applyDecisionsSnapshot(projectDecisions({
    ok: true,
    pending: [{
      id: 'review:run-2', kind: 'review', ticketId: 'tkt_2', ticketTitle: 'T2', runId: 'run-2', revisionId: 'rev_a', planRevisionId: null,
      candidateId: 'cand_2', integrityHash: 'h'.repeat(64), binding: 'current', authorized: false, actionable: true, expectedVersion: 3,
    }],
    responses: [],
  }));
  await ctx.handleDecisionsAction('accept', 'review:run-2');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(posted);
  assert.match(posted.url, /\/tickets\/tkt_2\/review$/);
});

test('pending review findings preserve draft, focus, and caret across polls; clear after action or removal', async () => {
  const document = createDocument();
  let posted = null;
  const ctx = vm.createContext({
    document,
    state: { activeTab: 'tab-decisions' },
    console,
    window: { confirm: () => true },
    apiPost: async (url, body) => { posted = { url, body }; return {}; },
  });
  const root = path.join(__dirname, '..', 'web', 'dashboard', 'js');
  vm.runInContext(fs.readFileSync(path.join(root, 'util.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'tabs', 'decisions.js'), 'utf8'), ctx);
  const review = (extra = {}) => ({
    id: 'review:run-1', kind: 'review', ticketId: 'tkt_1', ticketTitle: 'Review ticket', runId: 'run-1',
    revisionId: 'rev-1', planRevisionId: 'plan-1', candidateId: 'cand-1', integrityHash: 'h'.repeat(64),
    binding: 'current', authorized: true, actionable: true, expectedVersion: 3, ...extra,
  });
  const snapshot = (item) => ctx.applyDecisionsSnapshot({ available: true, pending: item ? [item] : [], responses: [] });
  const findArea = () => document.getElementById('escalation-list').querySelectorAll('textarea.decisions-findings')[0];

  snapshot(review());
  const first = findArea();
  first.value = 'Keep this draft while polling';
  first.dispatch('input');
  first.selectionStart = 8;
  first.selectionEnd = 12;
  first.focus();

  snapshot(review({ ticketTitle: 'Updated title', expectedVersion: 4 }));
  const refreshed = findArea();
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.value, 'Keep this draft while polling');
  assert.equal(document.activeElement, refreshed);
  assert.equal(refreshed.selectionStart, 8);
  assert.equal(refreshed.selectionEnd, 12);
  assert.match(document.getElementById('escalation-list').textContent, /Updated title/);

  await ctx.handleDecisionsAction('corrections', 'review:run-1');
  assert.ok(posted);
  assert.equal(posted.body.findings, 'Keep this draft while polling');
  assert.equal(findArea().value, '');

  const afterCompletion = findArea();
  afterCompletion.value = 'Discard after item removal';
  afterCompletion.dispatch('input');
  snapshot(null);
  snapshot(review());
  assert.equal(findArea().value, '');
});

test('Decisions tab answers only current projected decisions and shows answered history', async () => {
  const document = createDocument();
  let posted = null;
  const ctx = vm.createContext({
    document,
    state: { activeTab: 'tab-decisions' },
    console,
    apiPost: async (url, body) => { posted = { url, body }; return {}; },
  });
  const root = path.join(__dirname, '..', 'web', 'dashboard', 'js');
  vm.runInContext(fs.readFileSync(path.join(root, 'util.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'tabs', 'decisions.js'), 'utf8'), ctx);
  ctx.applyDecisionsSnapshot({ available: true, pending: [{
    id: 'decision:dec_1', decisionId: 'dec_1', kind: 'intake_clarification', state: 'pending', actionable: true,
    ticketId: 'tkt_1', runId: 'run_1', revisionId: 'rev_1', planRevisionId: 'plan_1', expectedVersion: 8,
    binding: 'current', request: { questions: [{ id: 'q1', question: 'Which?', why: null }] },
  }, {
    id: 'decision:dec_stale', decisionId: 'dec_stale', kind: 'lead_decision', state: 'stale', actionable: false,
    ticketId: 'tkt_1', runId: 'run_old', revisionId: 'rev_old', planRevisionId: 'plan_old', expectedVersion: 8,
    binding: 'stale', request: { question: 'Old choice?', options: [{ id: 'a', description: 'First' }] },
  }], responses: [{
    id: 'decision:dec_2', decisionId: 'dec_2', kind: 'lead_decision', state: 'answered', actionable: false,
    ticketId: 'tkt_1', runId: 'run_1', revisionId: 'rev_1', planRevisionId: 'plan_1', expectedVersion: 8,
    binding: 'current', request: { question: 'Choose?', options: [] }, answer: { choice: 'a', answer: 'Go with A' },
  }] });
  const find = (node, predicate) => predicate(node) ? node : node.children.map((child) => find(child, predicate)).find(Boolean);
  const area = find(document.getElementById('escalation-list'), (node) => node.tagName === 'textarea');
  area.value = 'Use the blue one';
  const staleCard = find(document.getElementById('escalation-list'), (node) => node.getAttribute && node.getAttribute('data-id') === 'decision:dec_stale');
  assert.equal(find(staleCard, (node) => node.tagName === 'textarea' || node.tagName === 'input'), undefined);
  const button = find(document.getElementById('escalation-list'), (node) => node.tagName === 'button');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(posted.url, '/tickets/tkt_1/decisions/dec_1/answer');
  assert.equal(posted.body.expectedVersion, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(posted.body.answers)), [{ questionId: 'q1', answer: 'Use the blue one' }]);
  assert.match(document.getElementById('adr-list').textContent, /Go with A/);
});

test('docs UI lists projected document and copy uses selected content only', async () => {
  const clipboard = { text: '' };
  const ctx = vm.createContext({
    document: createDocument(),
    state: { activeTab: 'tab-docs' },
    console,
    navigator: { clipboard: { writeText: (t) => { clipboard.text = t; return Promise.resolve(); } } },
    apiGet: async () => projectDocs({
      ok: true,
      documents: [
        { id: 'role:team', title: 'TEAM.md', source: 'role', sourcePath: 'TEAM.md', status: 'available', format: 'markdown', content: 'Alpha', truncated: false, reason: null },
        { id: 'role:other', title: 'other.md', source: 'role', sourcePath: 'other.md', status: 'available', format: 'markdown', content: 'Beta', truncated: false, reason: null },
      ],
    }),
  });
  const root = path.join(__dirname, '..', 'web', 'dashboard', 'js');
  vm.runInContext(fs.readFileSync(path.join(root, 'util.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'tabs', 'docs.js'), 'utf8'), ctx);
  ctx.applyDocsSnapshot(await ctx.apiGet());
  ctx.initDocsEvents();
  assert.match(ctx.document.getElementById('docs-list').textContent, /TEAM.md/);
  ctx.docsView.selectedId = 'role:other';
  ctx.renderDocs();
  assert.match(ctx.document.getElementById('doc-viewer-content').textContent, /Beta/);
  ctx.document.getElementById('btn-copy-doc').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(clipboard.text, 'Beta');
  ctx.docsView.rawView = false;
  ctx.document.getElementById('btn-toggle-raw').click();
  assert.equal(ctx.docsView.rawView, true);
  assert.match(ctx.document.getElementById('doc-viewer-content').textContent, /Beta/);
});
