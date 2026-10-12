'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { StagingLog, InMemoryStagingLog, hasStagingTable, isSafeIdentity } = require('../src/staging-log');
const { buildReport, parseArgs, main } = require('../src/staging-report');

function disposableDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-log-'));
  const file = path.join(dir, 'state.sqlite');
  return { dir, file, open: () => new Database(file) };
}

function sample(overrides = {}) {
  return {
    eventId: 'event-1', type: 'problem.updated', runId: 'run-1', assignmentId: 'assign-1',
    attemptId: 'attempt-1', role: 'verifier', problemId: 'P-14', decisionId: 'ADR-8',
    target: 'docs/evidence.md#check-2', status: 'failed', payload: { summary: 'check failed', evidenceRef: 'evidence-7' },
    ...overrides,
  };
}

test('events survive database reopen and duplicate retries preserve their original timestamp', () => {
  const tmp = disposableDb();
  const firstDb = tmp.open();
  const first = new StagingLog({ db: firstDb }).record(sample());
  firstDb.close();
  const reopenedDb = tmp.open();
  const log = new StagingLog({ db: reopenedDb });
  const retry = log.record(sample({ payload: { evidenceRef: 'evidence-7', summary: 'check failed' } }));
  assert.equal(retry.createdAt, first.createdAt);
  assert.deepEqual(log.list(), [first]);
  assert.throws(() => log.record(sample({ status: 'passed' })), /different content/);
  assert.equal(log.list().length, 1);
  reopenedDb.close();
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

test('events are append-only and reads return immutable normalized records', () => {
  const db = new Database(':memory:');
  const log = new StagingLog({ db });
  const event = log.record(sample());
  assert.throws(() => { event.payload.summary = 'changed'; }, TypeError);
  assert.throws(() => db.prepare('UPDATE staging_events SET status = ? WHERE event_id = ?').run('passed', event.eventId), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM staging_events WHERE event_id = ?').run(event.eventId), /append-only/);
  db.close();
});

test('redaction runs before idempotency comparison and preserves failure context', () => {
  const db = new Database(':memory:');
  const log = new StagingLog({ db });
  const first = log.record(sample({ payload: {
    summary: 'verification failed after Bearer abc.def',
    api_key: 'sensitive-value',
    details: 'received sk-12345678901234567890 from service',
  } }));
  const retry = log.record(sample({ payload: {
    summary: 'verification failed after Bearer different.token',
    api_key: 'other-sensitive-value',
    details: 'received sk-abcdefghijklmnopqrst from service',
  } }));
  assert.deepEqual(retry, first);
  assert.equal(first.payload.summary, 'verification failed after Bearer [REDACTED]');
  assert.equal(first.payload.api_key, '[REDACTED]');
  assert.match(first.payload.details, /\[REDACTED\]/);
  assert.throws(() => log.record(sample({ eventId: 'raw-event', payload: { stdout: 'tool output' } })), /raw source, tool output/);
  db.close();
});

test('the exported identity validator matches staging log identity acceptance', () => {
  assert.equal(isSafeIdentity('problem-14'), true);
  assert.equal(isSafeIdentity(null), true);
  assert.equal(isSafeIdentity('token=probe-secret'), false);
  assert.equal(isSafeIdentity('Bearer probe-secret'), false);
  assert.equal(isSafeIdentity('https://user:password@host/path'), false);
  assert.equal(isSafeIdentity(`x${'x'.repeat(512)}`), false);
  const memory = new InMemoryStagingLog();
  assert.throws(() => memory.list({ problemId: 'token=probe-secret' }), /credential-like text/);
});

test('list filters chronologically, and in-memory log follows the same duplicate and filter rules', () => {
  const db = new Database(':memory:');
  const log = new StagingLog({ db });
  log.record(sample());
  log.record(sample({ eventId: 'event-2', type: 'decision.accepted', problemId: null, status: 'accepted' }));
  log.record(sample({ eventId: 'event-3', runId: 'run-2' }));
  assert.deepEqual(log.list({ runId: 'run-1', problemId: 'P-14', type: 'problem.updated' }).map((event) => event.eventId), ['event-1']);
  assert.equal(log.list({ limit: 1 }).length, 1);
  assert.throws(() => log.list({ limit: 0 }), /limit/);
  const memory = new InMemoryStagingLog();
  const first = memory.record(sample());
  assert.deepEqual(memory.record(sample()), first);
  assert.deepEqual(memory.list({ problemId: 'P-14' }), [first]);
  assert.throws(() => memory.record(sample({ status: 'accepted' })), /different content/);
  db.close();
});

test('equal timestamps preserve insertion order in SQLite and memory', () => {
  const NativeDate = global.Date;
  global.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-12T12:00:00.000Z'])); }
  };
  try {
    const db = new Database(':memory:');
    const log = new StagingLog({ db });
    log.record(sample({ eventId: 'z-open', status: 'open' }));
    log.record(sample({ eventId: 'a-closed', status: 'closed' }));
    assert.deepEqual(log.list().map((event) => event.eventId), ['z-open', 'a-closed']);
    const memory = new InMemoryStagingLog();
    memory.record(sample({ eventId: 'z-open', status: 'open' }));
    memory.record(sample({ eventId: 'a-closed', status: 'closed' }));
    assert.deepEqual(memory.list().map((event) => event.eventId), ['z-open', 'a-closed']);
    db.close();
  } finally {
    global.Date = NativeDate;
  }
});

test('readonly constructor does not create a table and reports a missing log as unavailable', () => {
  const db = new Database(':memory:');
  const log = new StagingLog({ db, readonly: true });
  assert.equal(hasStagingTable(db), false);
  assert.throws(() => log.list(), (error) => error.code === 'STAGING_LOG_UNAVAILABLE');
  assert.throws(() => log.record(sample()), /read-only/);
  assert.deepEqual(buildReport(db), { available: false, message: 'Staging event log unavailable: staging_events table is missing.' });
  db.close();
});

test('report CLI entry opens the state database read-only, prints history and rejects invalid flags', () => {
  const tmp = disposableDb();
  let db = tmp.open();
  new StagingLog({ db }).record(sample());
  db.close();
  const output = { stdout: '', stderr: '' };
  const status = main(['--state', tmp.file, '--run', 'run-1', '--json'], {}, {
    stdout: { write: (value) => { output.stdout += value; } },
    stderr: { write: (value) => { output.stderr += value; } },
  });
  assert.equal(status, 0, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.available, true);
  assert.equal(report.count, 1);
  assert.equal(report.problems[0].status, 'failed');
  assert.equal(report.problems[0].events[0].target, 'docs/evidence.md#check-2');
  assert.throws(() => parseArgs(['--limit', '-2']), /limit/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown/);
  db = new Database(tmp.file, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM staging_events').get().n, 1);
  db.close();
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

test('report CLI says logging is unavailable when the event table does not exist', () => {
  const tmp = disposableDb();
  const db = tmp.open();
  db.exec('CREATE TABLE unrelated (id INTEGER)');
  db.close();
  const output = { stdout: '', stderr: '' };
  const status = main(['--state', tmp.file], {}, {
    stdout: { write: (value) => { output.stdout += value; } },
    stderr: { write: (value) => { output.stderr += value; } },
  });
  assert.equal(status, 0, output.stderr);
  assert.match(output.stdout, /unavailable/);
  assert.doesNotMatch(output.stdout, /Staging events: 0/);
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

test('limited report keeps the later close, reports partial coverage, and bounds status claims', () => {
  const db = new Database(':memory:');
  const log = new StagingLog({ db });
  const NativeDate = global.Date;
  let tick = 0;
  global.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [`2026-10-12T12:00:0${tick++}.000Z`]));
    }
  };
  try {
    log.record(sample({ eventId: 'open', status: 'open' }));
    log.record(sample({ eventId: 'closed', status: 'closed' }));
  } finally {
    global.Date = NativeDate;
  }
  const report = buildReport(db, { limit: 1 });
  assert.deepEqual(report.events.map((event) => event.eventId), ['closed']);
  assert.deepEqual(report.coverage, { totalEvents: 2, returnedEvents: 1, partial: true });
  assert.equal(report.problems[0].status, 'closed');
  assert.equal(report.problems[0].statusComplete, false);
  assert.equal(report.problems[0].statusScope, 'latest event in retained window');
  db.close();
});

test('correlation IDs reject credential-like text and free-text fields redact credentials', () => {
  const db = new Database(':memory:');
  const log = new StagingLog({ db });
  assert.throws(() => log.record(sample({ runId: 'Bearer top-secret' })), /credential-like/);
  assert.throws(
    () => log.record(sample({ payload: { nested: { env: { DATABASE_URL: 'postgres://user:pass@db' } } } })),
    /environment/,
  );
  assert.throws(
    () => log.record(sample({ payload: { details: { environment: { DATABASE_URL: 'postgres://user:pass@db' } } } })),
    /environment/,
  );
  assert.throws(() => log.record(sample({ payload: { userPrompt: 'include the full task prompt' } })), /prompt/);
  const event = log.record(sample({
    role: 'worker Bearer top-secret',
    target: 'https://reader:password@example.test/check?client_secret=top-secret&view=summary',
    status: 'failed token=top-secret',
    payload: {
      summary: 'Request failed at https://user:pass@example.test/check?access_token=top-secret&retry=1',
      artifactRef: 'https://files.example.test/download?X-Amz-Signature=top-secret',
    },
  }));
  assert.equal(event.role, 'worker Bearer [REDACTED]');
  assert.equal(event.target, 'https://[REDACTED]@example.test/check?client_secret=[REDACTED]&view=summary');
  assert.equal(event.status, 'failed token=[REDACTED]');
  assert.equal(event.payload.summary, 'Request failed at https://[REDACTED]@example.test/check?access_token=[REDACTED]&retry=1');
  assert.equal(event.payload.artifactRef, 'https://files.example.test/download?X-Amz-Signature=[REDACTED]');
  db.close();
});

test('URI user-info and secret query values are redacted across schemes and event fields', () => {
  const cases = [
    ['postgres', 'postgres://user:probe-password@db.local/staging?sslmode=require'],
    ['postgresql', 'postgresql://user%3Aencoded%40name:probe%40password@db.local/staging?token=topsecret'],
    ['mysql', 'mysql://service:mysqlpass@db.local/app?client_secret=mysqlsecret'],
    ['redis', 'redis://:cachepassword@cache.local/0?access_token=cachetoken'],
    ['amqp', 'amqp://worker:mqpass@mq.local/vhost?api_key=amqpkey'],
    ['custom', 'custom+service://agent:custompass@service.local/path?credential=customsecret'],
  ];
  const db = new Database(':memory:');
  const log = new StagingLog({ db });
  for (const [name, uri] of cases) {
    const event = log.record(sample({
      eventId: `uri-${name}`,
      target: `connection target ${uri}`,
      payload: { summary: `Connection failed: ${uri}; retry scheduled`, artifactRef: `logref=${uri}` },
    }));
    for (const secret of ['probe-password', 'encoded%40name', 'probe%40password', 'topsecret', 'mysqlpass', 'mysqlsecret',
      'cachepassword', 'cachetoken', 'mqpass', 'amqpkey', 'custompass', 'customsecret']) {
      assert.equal(event.target.includes(secret), false, `${name} target retained ${secret}`);
      assert.equal(event.payload.summary.includes(secret), false, `${name} summary retained ${secret}`);
      assert.equal(event.payload.artifactRef.includes(secret), false, `${name} ref retained ${secret}`);
    }
    assert.match(event.payload.summary, /Connection failed: .*retry scheduled/);
    assert.match(event.target, /connection target /);
    assert.match(event.payload.artifactRef, /logref=/);
    assert.match(event.target, /\[REDACTED\]@/);
    assert.match(event.payload.summary, /\[REDACTED\]@/);
    assert.match(event.payload.artifactRef, /\[REDACTED\]@/);
  }
  assert.throws(() => log.record(sample({ runId: cases[0][1] })), /credential-like/);
  assert.throws(() => log.record(sample({ assignmentId: cases[3][1] })), /credential-like/);
  db.close();
});
