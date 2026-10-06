'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { EventJournal, withDispatchEvents, EVENT_TYPES, redactDiagnosticMessage } = require('../src/event-journal');
const { InMemoryDispatchJournal } = require('../src/durable-store');

function makeJournal() {
  const db = new Database(':memory:');
  let n = 0;
  const journal = new EventJournal({ db, randomId: () => `evt-${++n}` });
  journal.ensureSchema();
  return { db, journal };
}

test('records events in sequence order and pages by run', () => {
  const { journal } = makeJournal();
  for (let i = 0; i < 5; i += 1) journal.record('run_submitted', { runId: 'r1', taskId: 't1', namespace: 'orchestrator' });
  journal.record('run_submitted', { runId: 'r2' });
  const all = journal.listByRun('r1');
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((e) => e.sequence), [...all.map((e) => e.sequence)].sort((a, b) => a - b));
  const page = journal.listByRun('r1', { limit: 2 });
  assert.equal(page.length, 2);
  const next = journal.listByRun('r1', { after: page[1].sequence, limit: 10 });
  assert.equal(next.length, 3);
  assert.equal(next[0].sequence > page[1].sequence, true);
  assert.equal(journal.listByTask('orchestrator', 't1').length, 5);
  assert.equal(journal.lastSequence(), 6);
  assert.equal(journal.health().status, 'ok');
});

test('sanitizes payload: drops unknown fields, truncates strings, bounds size', () => {
  const { journal } = makeJournal();
  journal.record('run_error', {
    runId: 'r1',
    payload: { errorName: 'Boom', message: 'x'.repeat(2000), goal: 'secret goal', prompt: 'p', text: 'model output', env: { A: 1 } },
  });
  const [event] = journal.listByRun('r1');
  assert.equal(event.payload.message.length, 500);
  assert.equal(event.payload.goal, undefined);
  assert.equal(event.payload.prompt, undefined);
  assert.equal(event.payload.text, undefined);
  assert.equal(event.payload.env, undefined);

  journal.record('run_completed', { runId: 'r2', payload: { assignments: Array.from({ length: 50 }, () => 'y'.repeat(500)) } });
  const [big] = journal.listByRun('r2');
  assert.ok(JSON.stringify(big.payload).length <= 4096);
});

test('unknown types are rejected and counted; types stay a closed set', () => {
  const { journal } = makeJournal();
  assert.equal(journal.record('made_up_type', { runId: 'r1' }), null);
  assert.equal(journal.listByRun('r1').length, 0);
  assert.equal(journal.health().status, 'degraded');
  assert.equal(journal.health().failures, 1);
  assert.ok(EVENT_TYPES.includes('run_submitted'));
});

test('record never throws when the table is missing or the db is closed', () => {
  const db = new Database(':memory:');
  const journal = new EventJournal({ db });
  assert.doesNotThrow(() => journal.record('run_submitted', { runId: 'r1' }));
  assert.equal(journal.health().status, 'degraded');
  assert.deepEqual(journal.listByRun('r1'), []);
  assert.equal(journal.lastSequence(), 0);

  const { db: db2, journal: j2 } = makeJournal();
  j2.record('run_submitted', { runId: 'r1' });
  db2.close();
  assert.doesNotThrow(() => j2.record('run_submitted', { runId: 'r1' }));
  assert.equal(j2.health().status, 'degraded');
  assert.ok(j2.health().lastFailureAt);
  assert.deepEqual(j2.listByRun('r1'), []);
});

test('withDispatchEvents delegates, preserves results and exceptions, and records dispatch events', () => {
  const { journal: events } = makeJournal();
  const inner = new InMemoryDispatchJournal();
  const wrapped = withDispatchEvents(inner, events);
  const row = { attemptId: 'a1', runId: 'r1', assignmentId: 'as1', role: 'orch-explorer', sandbox: 'read-only', contextId: 'c1' };
  const submitting = wrapped.recordSubmitting(row);
  assert.equal(submitting.state, 'submitting');
  assert.equal(wrapped.recordSubmitted('a1', 'task-1').taskId, 'task-1');
  const finished = wrapped.recordFinished('a1', { status: 'completed', taskId: 'task-1', text: 'SECRET OUTPUT' });
  assert.equal(finished.state, 'finished');
  assert.equal(wrapped.get('a1').state, 'finished');
  assert.equal(wrapped.listByRun('r1').length, 1);

  const list = events.listByRun('r1');
  assert.deepEqual(list.map((e) => e.type), ['dispatch_submitting', 'dispatch_submitted', 'dispatch_finished']);
  assert.equal(list[2].payload.outcome, 'completed');
  assert.equal(JSON.stringify(list).includes('SECRET OUTPUT'), false);
  assert.equal(list[0].attemptId, 'a1');

  assert.throws(() => wrapped.recordSubmitted('missing', 't'), /Unknown dispatch attempt/);
  assert.equal(events.listByRun('r1').length, 3);
});

test('withDispatchEvents is unaffected by a failing event journal', () => {
  const inner = new InMemoryDispatchJournal();
  const wrapped = withDispatchEvents(inner, new EventJournal({ db: new Database(':memory:') }));
  const row = { attemptId: 'a1', runId: 'r1', assignmentId: 'as1', role: 'orch-explorer', sandbox: 'read-only', contextId: 'c1' };
  assert.equal(wrapped.recordSubmitting(row).attemptId, 'a1');
  assert.equal(wrapped.recordFinished('a1', { status: 'completed' }).state, 'finished');
});

test('redactDiagnosticMessage redacts assignment secrets outside a URL', () => {
  const text = [
    'password=secret',
    'token=abc',
    'Token: abc',
    'API_KEY=k',
    'client_secret: s',
    'json {"access_token":"json-secret"}',
    'GITHUB_TOKEN=github-secret refresh_token=refresh-secret',
    'Cookie: session=very-secret',
    'x-api-key: header-secret',
    'ghp_123456789012345678901234567890123456',
    'github_pat_abcdefghijklmnopqrstuvwx0123456789',
    'ATATT3xFfGF0abcDEF12345678901234567890',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature0123456789abcdef',
    'https://user:secret@host/repo?token=abc',
    'Authorization: Bearer leak.token',
    'prefix Bearer leak.token',
    'model key sk-LEAKME99abcd',
    'mytoken=abc',
    'notpassword=visible',
    'build.12345678.release',
  ].join('\n');
  const redacted = redactDiagnosticMessage(text);
  const lines = redacted.split('\n');
  assert.equal(lines[0], 'password=[REDACTED]');
  assert.equal(lines[1], 'token=[REDACTED]');
  assert.equal(redacted.includes('password=secret'), false);
  assert.equal(redacted.includes('password=[REDACTED]'), true);
  assert.equal(redacted.includes('token=[REDACTED]'), true);
  assert.equal(redacted.includes('Token: [REDACTED]'), true);
  assert.equal(redacted.includes('API_KEY=[REDACTED]'), true);
  assert.equal(redacted.includes('client_secret: [REDACTED]'), true);
  assert.equal(redacted.includes('json {"access_token":"[REDACTED]"}'), true);
  assert.equal(redacted.includes('GITHUB_TOKEN=[REDACTED] refresh_token=[REDACTED]'), true);
  assert.equal(redacted.includes('Cookie: [REDACTED]'), true);
  assert.equal(redacted.includes('x-api-key: [REDACTED]'), true);
  assert.equal(redacted.includes('ghp_123456789012345678901234567890123456'), false);
  assert.equal(redacted.includes('github_pat_abcdefghijklmnopqrstuvwx0123456789'), false);
  assert.equal(redacted.includes('ATATT3xFfGF0abcDEF12345678901234567890'), false);
  assert.equal(redacted.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature0123456789abcdef'), false);
  assert.equal(redacted.includes('https://host/repo?<redacted>'), true);
  assert.equal(redacted.includes('Authorization: [REDACTED]'), true);
  assert.equal(redacted.includes('Bearer [REDACTED]'), true);
  assert.equal(redacted.includes('sk-LEAKME99abcd'), false);
  assert.equal(redacted.includes('mytoken=abc'), true);
  assert.equal(redacted.includes('notpassword=visible'), true);
  assert.equal(redacted.includes('build.12345678.release'), true);
  assert.equal(redacted.includes('json-secret'), false);
  assert.equal(redacted.includes('github-secret'), false);
  assert.equal(redacted.includes('refresh-secret'), false);
  assert.equal(redacted.includes('very-secret'), false);
  assert.equal(redacted.includes('header-secret'), false);
});

test('listRecent returns the newest window oldest-first and fails closed without throwing', () => {
  const { db, journal } = makeJournal();
  for (let i = 0; i < 5; i += 1) journal.record('run_submitted', { runId: `r${i}` });
  const page = journal.listRecent({ limit: 3 });
  assert.equal(page.ok, true);
  assert.equal(page.events.length, 3);
  assert.deepEqual(page.events.map((event) => event.sequence), [3, 4, 5]);
  db.close();
  let closed;
  assert.doesNotThrow(() => { closed = journal.listRecent({ limit: 3 }); });
  assert.deepEqual(closed, { ok: false, events: [] });
});

test('route events keep their payload fields and bound the reason strings', () => {
  const { journal } = makeJournal();
  const reasons = ['protected_path:' + 'x'.repeat(600), 'too_many_files'];
  journal.record('route_decided', { runId: 'r1', payload: { mode: 'on', requested: 'lean', verdict: 'full', effective: 'full', reasons, goal: 'secret' } });
  journal.record('route_promoted', { runId: 'r1', payload: { reasons: ['delta_unknown'], at: 'implement', scriptedDecisions: 2 } });
  const [decided, promoted] = journal.listByRun('r1');
  assert.deepEqual(Object.keys(decided.payload).sort(), ['effective', 'mode', 'reasons', 'requested', 'verdict']);
  assert.equal(decided.payload.reasons[0].length, 500);
  assert.equal(decided.payload.reasons[1], 'too_many_files');
  assert.deepEqual(promoted.payload, { reasons: ['delta_unknown'], at: 'implement', scriptedDecisions: 2 });
});
