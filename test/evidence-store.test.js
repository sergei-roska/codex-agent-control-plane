'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const {
  EvidenceError,
  MAX_STORED_BYTES,
  MAX_RUN_BYTES,
  MAX_READ_BYTES,
  createEvidenceStore,
  parseRetentionDays,
  main,
} = require('../src/evidence-store');

const MiB = 1024 * 1024;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const SCRIPT = path.resolve(__dirname, '..', 'src', 'evidence-store.js');

function setup(options = {}) {
  const db = new Database(':memory:');
  let clock = 1_000_000;
  let n = 0;
  const store = createEvidenceStore(db, {
    now: () => clock,
    randomId: () => `ev_${(n++).toString(16).padStart(32, '0')}`,
    retentionDays: 30,
    ...options,
  });
  return { db, store, tick: (ms) => { clock += ms; }, clock: () => clock };
}

function input(content, extra = {}) {
  return {
    runId: 'run-1',
    kind: 'check_stdout',
    mediaType: 'text/plain; charset=utf-8',
    content,
    summary: 'summary',
    source: { producer: 'acceptance' },
    ...extra,
  };
}

function code(fn) {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EvidenceError, `expected EvidenceError, got ${error}`);
    return error.code;
  }
  return assert.fail('expected a throw');
}

test('put, getRef, and read round trip', () => {
  const { store, clock } = setup();
  const ref = store.put(input('hello', { checkId: 'check-1', attemptId: 'a1', taskId: 't1' }));
  assert.equal(ref.contract, 'evidence-ref/v1');
  assert.match(ref.id, /^ev_[0-9a-f]{32}$/);
  assert.equal(ref.stored, true);
  assert.equal(ref.originalBytes, 5);
  assert.equal(ref.storedBytes, 5);
  assert.equal(ref.truncated, false);
  assert.equal(ref.omitted, null);
  assert.equal(ref.sha256, sha(Buffer.from('hello')));
  assert.equal(ref.originalSha256, ref.sha256);
  assert.equal(ref.error, null);
  assert.equal(ref.checkId, 'check-1');
  assert.equal(ref.createdAt, clock());
  assert.equal(ref.expiresAt, clock() + 30 * 86400000);
  assert.deepEqual(ref.source, { producer: 'acceptance' });
  assert.deepEqual(store.getRef(ref.id, { runId: 'run-1' }), ref);
  const out = store.read(ref.id, { runId: 'run-1' });
  assert.equal(out.bytes.toString(), 'hello');
  assert.equal(out.eof, true);
  assert.deepEqual(out.ref, ref);
});

test('default random id is ev_ plus 32 hex chars', () => {
  const db = new Database(':memory:');
  const store = createEvidenceStore(db, { retentionDays: 1 });
  assert.match(store.put(input('x')).id, /^ev_[0-9a-f]{32}$/);
});

test('Buffer, string, and complete capture inputs are equivalent', () => {
  const { store } = setup();
  const text = 'caf\u00e9 output';
  const buf = Buffer.from(text, 'utf8');
  const a = store.put(input(text));
  const b = store.put(input(buf));
  const c = store.put(input({ head: buf.subarray(0, 4), tail: buf.subarray(4), originalBytes: buf.length, originalSha256: sha(buf) }));
  for (const ref of [a, b, c]) {
    assert.equal(ref.originalBytes, buf.length);
    assert.equal(ref.sha256, sha(buf));
    assert.equal(ref.truncated, false);
    assert.equal(store.read(ref.id, { runId: 'run-1' }).bytes.toString('utf8'), text);
  }
});

test('Buffer over the bound keeps head and tail around a marker', () => {
  const { store } = setup();
  const total = 20 * MiB;
  const full = Buffer.alloc(total);
  for (let i = 0; i < total; i += 1) full[i] = i % 251;
  const ref = store.put(input(full));
  const omittedBytes = total - 8 * MiB;
  const marker = `\n[evidence: ${omittedBytes} bytes omitted]\n`;
  assert.equal(ref.truncated, true);
  assert.deepEqual(ref.omitted, { offset: 2 * MiB, bytes: omittedBytes });
  assert.equal(ref.originalBytes, total);
  assert.equal(ref.storedBytes, 8 * MiB + marker.length);
  assert.equal(marker.length, 36);
  assert.equal(ref.originalSha256, sha(full));
  const expected = Buffer.concat([full.subarray(0, 2 * MiB), Buffer.from(marker), full.subarray(total - 6 * MiB)]);
  assert.equal(ref.sha256, sha(expected));
  assert.notEqual(ref.sha256, ref.originalSha256);
  // Read the marker region.
  const out = store.read(ref.id, { runId: 'run-1', offset: 2 * MiB, length: 36 });
  assert.equal(out.bytes.toString(), marker);
  assert.equal(out.eof, false);
});

test('precomputed truncated capture records the omitted range', () => {
  const { store } = setup();
  const head = Buffer.from('HEAD');
  const tail = Buffer.from('TAIL');
  const ref = store.put(input({ head, tail, originalBytes: 100, originalSha256: 'a'.repeat(64) }));
  const marker = '\n[evidence: 92 bytes omitted]\n';
  assert.equal(ref.truncated, true);
  assert.deepEqual(ref.omitted, { offset: 4, bytes: 92 });
  assert.equal(ref.originalSha256, 'a'.repeat(64));
  assert.equal(ref.storedBytes, 8 + marker.length);
  assert.equal(store.read(ref.id, { runId: 'run-1' }).bytes.toString(), `HEAD${marker}TAIL`);
});

test('put rejects invalid input', () => {
  const { store } = setup();
  assert.equal(code(() => store.put(input('x', { kind: 'nope' }))), 'evidence_invalid_input');
  assert.equal(code(() => store.put(input('x', { mediaType: 'image/png' }))), 'evidence_invalid_input');
  assert.equal(code(() => store.put(input('x', { summary: 'a'.repeat(2001) }))), 'evidence_invalid_input');
  assert.equal(code(() => store.put(input('x', { runId: '' }))), 'evidence_invalid_input');
  assert.equal(code(() => store.put(input('x', { source: null }))), 'evidence_invalid_input');
  assert.equal(code(() => store.put(input(42))), 'evidence_invalid_input');
  assert.equal(store.put(input('x', { summary: 'a'.repeat(2000) })).summary.length, 2000);
});

test('per-run quota yields a not_stored ref and does not throw', () => {
  const { store } = setup();
  const chunk = Buffer.alloc(MAX_STORED_BYTES, 1);
  for (let i = 0; i < MAX_RUN_BYTES / MAX_STORED_BYTES; i += 1) assert.equal(store.put(input(chunk)).stored, true);
  const over = store.put(input('one more'));
  assert.equal(over.stored, false);
  assert.equal(over.error, 'evidence_quota_exceeded');
  assert.equal(over.storedBytes, 0);
  assert.equal(over.sha256, null);
  assert.equal(over.originalBytes, 8);
  assert.equal(over.originalSha256, sha(Buffer.from('one more')));
  assert.equal(over.summary, 'summary');
  assert.equal(code(() => store.read(over.id, { runId: 'run-1' })), 'evidence_not_stored');
  assert.equal(store.getRef(over.id, { runId: 'run-1' }).stored, false);
  // Another run is unaffected.
  assert.equal(store.put(input('ok', { runId: 'run-2' })).stored, true);
});

test('read range limits and eof', () => {
  const { store } = setup();
  const ref = store.put(input('0123456789'));
  const mid = store.read(ref.id, { runId: 'run-1', offset: 2, length: 3 });
  assert.equal(mid.bytes.toString(), '234');
  assert.equal(mid.offset, 2);
  assert.equal(mid.eof, false);
  const end = store.read(ref.id, { runId: 'run-1', offset: 7, length: 3 });
  assert.equal(end.bytes.toString(), '789');
  assert.equal(end.eof, true);
  const past = store.read(ref.id, { runId: 'run-1', offset: 50 });
  assert.equal(past.bytes.length, 0);
  assert.equal(past.eof, true);
  for (const bad of [{ offset: -1 }, { offset: 1.5 }, { length: -1 }, { length: 'x' }, { length: MAX_READ_BYTES + 1 }]) {
    assert.equal(code(() => store.read(ref.id, { runId: 'run-1', ...bad })), 'evidence_read_too_large');
  }
  assert.equal(store.read(ref.id, { runId: 'run-1', length: MAX_READ_BYTES }).bytes.length, 10);
});

test('tampered payload fails the checksum', () => {
  const { db, store } = setup();
  const ref = store.put(input('original'));
  db.prepare('UPDATE evidence SET payload = ? WHERE id = ?').run(Buffer.from('tampered'), ref.id);
  assert.equal(code(() => store.read(ref.id, { runId: 'run-1', offset: 0, length: 1 })), 'evidence_corrupt');
});

test('cross-run access is forbidden without leaking the owner', () => {
  const { store } = setup();
  const ref = store.put(input('secret', { runId: 'owner-run-xyz' }));
  for (const fn of [
    () => store.getRef(ref.id, { runId: 'other' }),
    () => store.read(ref.id, { runId: 'other' }),
    () => store.read(ref.id, {}),
  ]) {
    try { fn(); assert.fail('expected throw'); } catch (error) {
      assert.equal(error.code, 'evidence_forbidden');
      assert.ok(!error.message.includes('owner-run-xyz'));
    }
  }
});

test('invalid ids are rejected before any query', () => {
  const { db, store } = setup();
  db.exec('DROP TABLE evidence');
  const ids = [
    '../../etc/passwd', 'ev_../x', '/etc/passwd', 'EV_' + 'a'.repeat(32), 'ev_' + 'A'.repeat(32),
    'ev_' + 'a'.repeat(31), 'ev_' + 'a'.repeat(33), `ev_${'a'.repeat(31)}\0`, '', 'ev_' + 'a'.repeat(32) + '\n', 42, null, undefined,
  ];
  for (const id of ids) {
    assert.equal(code(() => store.getRef(id, { runId: 'run-1' })), 'evidence_invalid_id', String(id));
    assert.equal(code(() => store.read(id, { runId: 'run-1' })), 'evidence_invalid_id', String(id));
  }
});

test('unknown id is not found', () => {
  const { store } = setup();
  const id = `ev_${'0'.repeat(32)}`;
  assert.equal(code(() => store.getRef(id, { runId: 'run-1' })), 'evidence_not_found');
  assert.equal(code(() => store.read(id, { runId: 'run-1' })), 'evidence_not_found');
});

test('expiry leaves a tombstone', () => {
  const { db, store, tick } = setup({ retentionDays: 1 });
  const stored = store.put(input('data'));
  tick(86400000 + 1);
  assert.equal(store.sweepExpired(), 1);
  const row = db.prepare('SELECT state, payload FROM evidence WHERE id = ?').get(stored.id);
  assert.equal(row.state, 'expired');
  assert.equal(row.payload, null);
  assert.equal(code(() => store.read(stored.id, { runId: 'run-1' })), 'evidence_expired');
  assert.equal(code(() => store.getRef(stored.id, { runId: 'run-1' })), 'evidence_expired');
  assert.equal(store.listByRun('run-1')[0].error, 'evidence_expired');
  assert.equal(store.sweepExpired(), 0);
});

test('a past-due row is expired before any sweep has run', () => {
  const { db, store, tick } = setup({ retentionDays: 1 });
  const stored = store.put(input('data'));
  tick(86400000);
  assert.equal(db.prepare('SELECT state FROM evidence WHERE id = ?').get(stored.id).state, 'stored');
  assert.equal(code(() => store.read(stored.id, { runId: 'run-1' })), 'evidence_expired');
  assert.equal(code(() => store.getRef(stored.id, { runId: 'run-1' })), 'evidence_expired');
  assert.equal(code(() => store.read(stored.id, { runId: 'other' })), 'evidence_forbidden');
});

test('sweep expires not_stored rows too and runs when the store is created', () => {
  const db = new Database(':memory:');
  let clock = 5_000;
  const first = createEvidenceStore(db, { now: () => clock, retentionDays: 1 });
  const ref = first.put(input('data'));
  db.prepare("UPDATE evidence SET state = 'not_stored', payload = NULL WHERE id = ?").run(ref.id);
  clock += 2 * 86400000;
  createEvidenceStore(db, { now: () => clock, retentionDays: 1 });
  assert.equal(db.prepare('SELECT state FROM evidence WHERE id = ?').get(ref.id).state, 'expired');
});

test('put sweeps at most once per hour', () => {
  const { db, store, tick } = setup({ retentionDays: 1 });
  const old = store.put(input('old'));
  tick(86400000 + 1000);
  // Less than an hour since store creation? Creation was 1 day ago, so first put sweeps.
  store.put(input('trigger'));
  assert.equal(db.prepare('SELECT state FROM evidence WHERE id = ?').get(old.id).state, 'expired');
  // Next row expires in a day; within the hour a put must not sweep even after expiry.
  const second = store.put(input('second'));
  db.prepare('UPDATE evidence SET expires_at = 0 WHERE id = ?').run(second.id);
  tick(30 * 60 * 1000);
  store.put(input('no sweep'));
  assert.equal(db.prepare('SELECT state FROM evidence WHERE id = ?').get(second.id).state, 'stored');
  tick(31 * 60 * 1000);
  store.put(input('sweep'));
  assert.equal(db.prepare('SELECT state FROM evidence WHERE id = ?').get(second.id).state, 'expired');
});

test('retention days parsing', () => {
  assert.equal(parseRetentionDays('7'), 7);
  assert.equal(parseRetentionDays('1'), 1);
  assert.equal(parseRetentionDays('365'), 365);
  for (const bad of ['0', '366', '-1', '1.5', 'abc', '', undefined, null, '7d', 0, 400]) {
    assert.equal(parseRetentionDays(bad), 30, String(bad));
  }
  const prev = process.env.CODEX_A2A_EVIDENCE_RETENTION_DAYS;
  try {
    process.env.CODEX_A2A_EVIDENCE_RETENTION_DAYS = '5';
    assert.equal(createEvidenceStore(new Database(':memory:')).retentionDays, 5);
    process.env.CODEX_A2A_EVIDENCE_RETENTION_DAYS = 'junk';
    assert.equal(createEvidenceStore(new Database(':memory:')).retentionDays, 30);
    assert.equal(createEvidenceStore(new Database(':memory:'), { retentionDays: 9 }).retentionDays, 9);
  } finally {
    if (prev === undefined) delete process.env.CODEX_A2A_EVIDENCE_RETENTION_DAYS;
    else process.env.CODEX_A2A_EVIDENCE_RETENTION_DAYS = prev;
  }
});

test('listByRun and deleteRun', () => {
  const { store } = setup();
  const a = store.put(input('a'));
  const b = store.put(input('b'));
  const other = store.put(input('c', { runId: 'run-2' }));
  assert.deepEqual(store.listByRun('run-1').map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(store.listByRun('nobody'), []);
  assert.equal(store.deleteRun('run-1'), 2);
  assert.deepEqual(store.listByRun('run-1'), []);
  assert.equal(store.listByRun('run-2')[0].id, other.id);
  assert.equal(store.deleteRun('run-1'), 0);
});

function cliFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const store = createEvidenceStore(db, { retentionDays: 30 });
  const ref = store.put(input('0123456789', { checkId: 'c1' }));
  db.close();
  return { file, ref };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, encoding: 'buffer' });
}

test('CLI lists refs as JSON lines and reads raw bytes', (t) => {
  const { file, ref } = cliFixture(t);
  const list = run(['--run', 'run-1', '--state', file]);
  assert.equal(list.status, 0);
  const lines = list.stdout.toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [ref]);

  const all = run(['--run', 'run-1', '--id', ref.id], { CODEX_A2A_STATE_DB: file });
  assert.equal(all.status, 0);
  assert.equal(all.stdout.toString(), '0123456789');

  const part = run(['--run', 'run-1', '--id', ref.id, '--offset', '3', '--length', '4', '--state', file]);
  assert.equal(part.stdout.toString(), '3456');
});

test('CLI error and usage exit codes', (t) => {
  const { file, ref } = cliFixture(t);
  const bad = run(['--run', 'run-1', '--id', '../../etc/passwd', '--state', file]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr.toString(), /^evidence_invalid_id: /);
  const forbidden = run(['--run', 'other', '--id', ref.id, '--state', file]);
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr.toString(), /^evidence_forbidden: /);
  assert.ok(!forbidden.stderr.toString().includes('run-1'));
  const big = run(['--run', 'run-1', '--id', ref.id, '--length', String(MAX_READ_BYTES + 1), '--state', file]);
  assert.equal(big.status, 1);
  assert.match(big.stderr.toString(), /^evidence_read_too_large: /);
  assert.equal(run(['--state', file]).status, 2);
  assert.equal(run(['--run', 'run-1', '--bogus', 'x', '--state', file]).status, 2);
  assert.equal(run(['--run']).status, 2);
  assert.equal(run(['--run', 'run-1', '--offset', '1', '--state', file]).status, 2);
});

test('CLI main returns codes through injected streams and opens read-only', (t) => {
  const { file } = cliFixture(t);
  const out = [];
  const err = [];
  const io = { stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) } };
  assert.equal(main(['--run', 'nobody', '--state', file], {}, io), 0);
  assert.deepEqual(out, []);
  assert.equal(main(['--run', 'run-1', '--state', path.join(path.dirname(file), 'missing.sqlite')], {}, io), 1);
  assert.equal(main([], {}, io), 2);
  assert.equal(err.length, 2);
});
