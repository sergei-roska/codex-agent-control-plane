'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { openStateDatabase, createTaskStore, DispatchJournal } = require('../src/durable-store');
const { UsageLedger } = require('../src/usage-ledger');
const { createProjection } = require('../src/dashboard-projection');

const ROLES = ['orch-builder', 'orch-reviewer'];
const STATES = {
  submitted: 1, working: 2, completed: 3, failed: 4, canceled: 5, input_required: 6, rejected: 7, auth_required: 8, unspecified: 0,
};

const textPart = (value) => ({ content: { $case: 'text', value }, mediaType: '', filename: '', metadata: undefined });
const userMessage = (taskId, text, extra = {}) => ({
  messageId: `${taskId}-u`, contextId: `ctx-${taskId}`, taskId, role: 1, parts: [textPart(text)], extensions: [], referenceTaskIds: [], ...extra,
});

let clock = Date.parse('2026-01-01T00:00:00.000Z');
function makeTask(id, { state = 'working', goal = `goal ${id}`, metadata, artifacts = [], statusText, stamp, history } = {}) {
  clock += 1000;
  return {
    id,
    contextId: `ctx-${id}`,
    status: {
      state: STATES[state],
      message: statusText ? { messageId: `${id}-s`, contextId: `ctx-${id}`, taskId: id, role: 2, parts: [textPart(statusText)], extensions: [], referenceTaskIds: [] } : undefined,
      timestamp: new Date(stamp ?? clock).toISOString(),
    },
    artifacts,
    history: history || [userMessage(id, goal)],
    metadata,
  };
}

async function fixture() {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const projection = createProjection({ db: state.db, roleIds: ROLES, projectId: 'prj_test' });
  const save = async (ns, task, tenant = '') => createTaskStore(state, ns).save(task, new ServerCallContext({ tenant }));
  return { state, projection, save, db: state.db };
}

const refId = (projection, namespace, taskId, tenant = '') => projection.encodeCardId({ namespace, tenant, taskId });

test('every A2A state maps to the contract column, unknown states need attention', async () => {
  const { state, projection, save } = await fixture();
  const expected = {
    submitted: ['pending', 'queued'],
    working: ['in_progress', 'working'],
    input_required: ['needs_attention', 'waiting'],
    completed: ['closed', 'completed'],
    failed: ['needs_attention', 'failed'],
    rejected: ['needs_attention', 'rejected'],
    canceled: ['closed', 'canceled'],
    auth_required: ['needs_attention', 'unknown'],
    unspecified: ['needs_attention', 'unknown'],
  };
  for (const name of Object.keys(expected)) await save('orchestrator', makeTask(`t-${name}`, { state: name }));
  // A raw state no enum knows.
  await save('orchestrator', makeTask('t-weird'));
  state.db.prepare("UPDATE tasks SET status_state = 'TASK_STATE_FUTURE' WHERE id = 't-weird'").run();
  const { cards } = projection.listCards({});
  const byId = Object.fromEntries(cards.map((c) => [c.runtimeTaskRef.taskId, c]));
  for (const [name, [column, status]] of Object.entries(expected)) {
    assert.equal(byId[`t-${name}`].boardColumn, column, name);
    assert.equal(byId[`t-${name}`].executionStatus, status, name);
    assert.equal(byId[`t-${name}`].humanReview, 'unknown');
    assert.equal(byId[`t-${name}`].cardKind, 'legacy_run');
    assert.equal(byId[`t-${name}`].primaryRole, 'orch-lead');
    assert.equal(byId[`t-${name}`].ticketId, null);
    assert.equal(byId[`t-${name}`].projectId, 'prj_test');
  }
  assert.equal(byId['t-weird'].boardColumn, 'needs_attention');
  assert.equal(byId['t-weird'].executionStatus, 'unknown');
  assert.equal(byId['t-weird'].rawState, 'TASK_STATE_FUTURE');
  assert.equal(byId['t-working'].rawState, 'TASK_STATE_WORKING');
  assert.equal(projection.listCards({}).counts.backlog, 0);
  await state.close();
});

test('each pause kind maps to a waitReason; other states have none', async () => {
  const { state, projection, save } = await fixture();
  const kinds = {
    human_decision: 'human_decision',
    waiting_for_budget: 'budget',
    restart: 'restart',
    writer_unresolved: 'writer_unresolved',
    error: 'execution_error',
    something_else: 'unknown',
  };
  for (const kind of Object.keys(kinds)) {
    await save('orchestrator', makeTask(`p-${kind}`, { state: 'input_required', metadata: { pause: { kind, question: 'Q?' } } }));
  }
  await save('orchestrator', makeTask('p-none', { state: 'input_required' }));
  await save('orchestrator', makeTask('p-working', { state: 'working', metadata: { pause: { kind: 'restart' } } }));
  const byId = Object.fromEntries(projection.listCards({}).cards.map((c) => [c.runtimeTaskRef.taskId, c]));
  for (const [kind, reason] of Object.entries(kinds)) assert.equal(byId[`p-${kind}`].waitReason, reason, kind);
  assert.equal(byId['p-none'].waitReason, 'unknown');
  assert.equal(byId['p-working'].waitReason, null);
  await state.close();
});

test('journal-linked worker tasks are children; unlinked specialist tasks are standalone cards', async () => {
  const { state, projection, save, db } = await fixture();
  await save('orchestrator', makeTask('run-1', { state: 'working' }));
  await save('orch-builder', makeTask('worker-1', { state: 'completed', goal: 'build it' }));
  await save('orch-reviewer', makeTask('worker-2', { state: 'working', goal: 'review it' }));
  await save('orch-builder', makeTask('solo-1', { state: 'working', goal: 'direct builder task' }));
  const journal = new DispatchJournal(state);
  for (const [n, role, taskId] of [[1, 'orch-builder', 'worker-1'], [2, 'orch-reviewer', 'worker-2']]) {
    journal.recordSubmitting({ attemptId: `run-1:r1:a${n}:t1`, runId: 'run-1', assignmentId: `run-1:r1:a${n}`, role, sandbox: 'workspace-write', contextId: `ctx-${taskId}` });
    journal.recordSubmitted(`run-1:r1:a${n}:t1`, taskId);
  }
  journal.recordFinished('run-1:r1:a1:t1', { status: 'TASK_STATE_COMPLETED', text: 'ok' });
  journal.recordSubmitting({ attemptId: 'run-1:r2:a1:t1', runId: 'run-1', assignmentId: 'run-1:r2:a1', role: 'orch-builder', sandbox: 'workspace-write', contextId: 'ctx-none' });

  const { cards, roleCounts } = projection.listCards({});
  assert.deepEqual(cards.map((c) => c.runtimeTaskRef.taskId).sort(), ['run-1', 'solo-1']);
  const lead = cards.find((c) => c.runtimeTaskRef.taskId === 'run-1');
  assert.equal(lead.attemptCount, 3);
  assert.deepEqual(lead.participatingRoles, ['orch-lead', 'orch-builder', 'orch-reviewer']);
  const solo = cards.find((c) => c.runtimeTaskRef.taskId === 'solo-1');
  assert.equal(solo.cardKind, 'standalone_execution');
  assert.equal(solo.primaryRole, 'orch-builder');
  assert.deepEqual(solo.participatingRoles, ['orch-builder']);
  assert.equal(solo.attemptCount, 0);
  assert.deepEqual(roleCounts, { 'orch-lead': 1, 'orch-builder': 2, 'orch-reviewer': 1 });

  // A child task is not a card.
  assert.throws(() => projection.getCard(refId(projection, 'orch-builder', 'worker-1')), { code: 'not_found' });

  const { attempts } = projection.getAttempts(lead.cardId);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].attemptId, 'run-1:r1:a1:t1');
  assert.equal(attempts[0].journalState, 'finished');
  assert.equal(attempts[0].outcome, 'TASK_STATE_COMPLETED');
  assert.equal(attempts[0].taskState, 'TASK_STATE_COMPLETED');
  assert.deepEqual(attempts[0].runtimeTaskRef, { namespace: 'orch-builder', tenant: '', taskId: 'worker-1', contextId: 'ctx-worker-1' });
  assert.equal(attempts[1].taskState, 'TASK_STATE_WORKING');
  assert.equal(attempts[2].journalState, 'submitting');
  assert.equal(attempts[2].runtimeTaskRef, null);
  assert.equal(attempts[2].taskState, null);
  assert.equal(attempts[2].outcome, null);
  assert.deepEqual(projection.getAttempts(solo.cardId), { attempts: [] });
  void db;
  await state.close();
});

test('acceptance disposition is surfaced and completed never implies human review', async () => {
  const { state, projection, save } = await fixture();
  const artifact = (id, acceptance) => ({
    artifactId: `${id}-result`, name: 'Orchestrator result', description: '', parts: [textPart('Final answer text')],
    metadata: { rounds: 1, ...(acceptance ? { acceptance } : {}) }, extensions: [],
  });
  await save('orchestrator', makeTask('acc-1', { state: 'completed', artifacts: [artifact('acc-1', { disposition: 'accepted', reasons: [] })] }));
  await save('orchestrator', makeTask('acc-2', { state: 'completed', artifacts: [artifact('acc-2', { disposition: 'rejected', reasons: ['tests missing'] })] }));
  await save('orchestrator', makeTask('acc-3', { state: 'completed', artifacts: [artifact('acc-3')] }));
  const byId = Object.fromEntries(projection.listCards({}).cards.map((c) => [c.runtimeTaskRef.taskId, c]));
  assert.deepEqual(byId['acc-1'].acceptance, { disposition: 'accepted', reasons: [] });
  assert.deepEqual(byId['acc-2'].acceptance, { disposition: 'rejected', reasons: ['tests missing'] });
  assert.equal(byId['acc-3'].acceptance, null);
  for (const card of Object.values(byId)) {
    assert.equal(card.humanReview, 'unknown');
    assert.equal(card.boardColumn, 'closed');
  }
  const detail = projection.getCard(byId['acc-2'].cardId);
  assert.equal(detail.resultText, 'Final answer text');
  assert.deepEqual(detail.card.acceptance, { disposition: 'rejected', reasons: ['tests missing'] });
  await state.close();
});

test('detail: caps, pause sanitizing, user messages, actions', async () => {
  const { state, projection, save } = await fixture();
  const long = 'x'.repeat(30000);
  await save('orchestrator', makeTask('d-1', {
    state: 'input_required',
    statusText: long,
    metadata: { pause: { kind: 'human_decision', question: 'Which?', options: [{ id: 'a', description: 'Opt A', secret: 's' }], decisionId: 'dec-1', hidden: 'nope' } },
    history: [
      userMessage('d-1', `  first\n\n goal   ${long}`),
      { messageId: 'm2', contextId: 'ctx-d-1', taskId: 'd-1', role: 2, parts: [textPart('agent says hi')], extensions: [], referenceTaskIds: [] },
      userMessage('d-1', 'second answer', { messageId: 'm3' }),
    ],
    artifacts: [{ artifactId: 'd-1-result', name: 'r', description: '', parts: [textPart(long)], metadata: {}, extensions: [] }],
  }));
  const id = refId(projection, 'orchestrator', 'd-1');
  const detail = projection.getCard(id);
  assert.equal(detail.card.title.length, 200);
  assert.ok(detail.card.title.startsWith('first goal xxx'));
  assert.equal(detail.statusMessage.length, 4000);
  assert.equal(detail.resultText.length, 20000);
  assert.equal(detail.userMessages.length, 2);
  assert.equal(detail.userMessages[0].text.length, 4000);
  assert.equal(detail.userMessages[1].text, 'second answer');
  assert.equal(detail.userMessages[1].at, null);
  assert.deepEqual(detail.pause, { kind: 'human_decision', decisionId: 'dec-1', question: 'Which?', options: [{ id: 'a', description: 'Opt A' }] });
  assert.deepEqual(detail.availableActions, []);
  assert.deepEqual(detail.unavailableActions.map((a) => a.action), ['pause', 'resume', 'stop', 'cancel', 'edit', 'return_to_backlog', 'review', 'commit', 'push']);
  for (const action of detail.unavailableActions) {
    assert.equal(action.reason, 'Operator commands are not available in this release');
    assert.equal(action.milestone, 'M7');
  }
  await save('orchestrator', makeTask('d-2', { history: [] }));
  const empty = projection.getCard(refId(projection, 'orchestrator', 'd-2'));
  assert.equal(empty.card.title, '(no goal text)');
  assert.equal(empty.statusMessage, null);
  assert.equal(empty.pause, null);
  assert.equal(empty.resultText, null);
  assert.deepEqual(empty.userMessages, []);
  await state.close();
});

test('tenant and namespace collisions produce distinct cardIds', async () => {
  const { state, projection, save } = await fixture();
  await save('orchestrator', makeTask('same', { goal: 'lead default tenant' }), '');
  await save('orchestrator', makeTask('same', { goal: 'lead tenant a' }), 'a');
  await save('orch-builder', makeTask('same', { goal: 'builder default tenant' }), '');
  await save('orch-reviewer', makeTask('same', { goal: 'reviewer tenant a' }), 'a');
  const { cards } = projection.listCards({});
  assert.equal(cards.length, 4);
  assert.equal(new Set(cards.map((c) => c.cardId)).size, 4);
  for (const card of cards) {
    const { namespace, tenant, taskId } = projection.decodeCardId(card.cardId);
    assert.deepEqual({ namespace, tenant, taskId }, { namespace: card.runtimeTaskRef.namespace, tenant: card.runtimeTaskRef.tenant, taskId: 'same' });
    assert.equal(projection.getCard(card.cardId).card.title, card.title);
  }
  assert.ok(cards[0].cardId.startsWith('lr_'));
  await state.close();
});

test('role, q and column filters; counts ignore column, roleCounts ignore all filters', async () => {
  const { state, projection, save } = await fixture();
  await save('orchestrator', makeTask('alpha-run', { state: 'working', goal: 'Fix the LOGIN bug' }));
  await save('orchestrator', makeTask('beta-run', { state: 'completed', goal: 'Write docs' }));
  await save('orchestrator', makeTask('gamma-run', { state: 'failed', goal: 'login tests' }));
  await save('orch-builder', makeTask('solo-b', { state: 'submitted', goal: 'builder login work' }));
  await save('orch-reviewer', makeTask('solo-r', { state: 'completed', goal: 'review login' }));

  const all = projection.listCards({});
  assert.deepEqual(all.counts, { backlog: 0, pending: 1, in_progress: 1, needs_attention: 1, closed: 2 });
  assert.deepEqual(all.roleCounts, { 'orch-lead': 3, 'orch-builder': 1, 'orch-reviewer': 1 });

  const q = projection.listCards({ q: 'LoGiN' });
  assert.equal(q.cards.length, 4);
  assert.deepEqual(q.counts, { backlog: 0, pending: 1, in_progress: 1, needs_attention: 1, closed: 1 });
  assert.deepEqual(q.roleCounts, all.roleCounts);

  const byTaskId = projection.listCards({ q: 'BETA-run' });
  assert.deepEqual(byTaskId.cards.map((c) => c.runtimeTaskRef.taskId), ['beta-run']);

  const role = projection.listCards({ role: 'orch-builder' });
  assert.deepEqual(role.cards.map((c) => c.runtimeTaskRef.taskId), ['solo-b']);
  assert.deepEqual(role.counts, { backlog: 0, pending: 1, in_progress: 0, needs_attention: 0, closed: 0 });
  assert.deepEqual(role.roleCounts, all.roleCounts);

  const column = projection.listCards({ column: 'closed', q: 'login' });
  assert.deepEqual(column.cards.map((c) => c.runtimeTaskRef.taskId), ['solo-r']);
  assert.deepEqual(column.counts, q.counts);
  assert.deepEqual(projection.listCards({ column: 'backlog' }).cards, []);
  await state.close();
});

test('pagination is stable with cursors and limit is capped at 100', async () => {
  const { state, projection, save } = await fixture();
  const stamp = Date.parse('2026-02-01T00:00:00.000Z');
  for (let i = 0; i < 7; i += 1) {
    // Pairs share a timestamp so the cardId tiebreak is exercised.
    await save('orchestrator', makeTask(`pg-${i}`, { stamp: stamp + Math.floor(i / 2) * 1000 }));
  }
  const full = projection.listCards({}).cards.map((c) => c.cardId);
  assert.equal(full.length, 7);
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = projection.listCards({ limit: 3, cursor });
    assert.ok(page.cards.length <= 3);
    seen.push(...page.cards.map((c) => c.cardId));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, full);
  const exact = projection.listCards({ limit: 7 });
  assert.equal(exact.nextCursor, null);
  // Newer rows appearing mid-walk do not disturb the remaining pages.
  const first = projection.listCards({ limit: 3 });
  await save('orchestrator', makeTask('pg-new', { stamp: stamp + 99000 }));
  const second = projection.listCards({ limit: 3, cursor: first.nextCursor });
  assert.deepEqual([...first.cards, ...second.cards].map((c) => c.cardId), full.slice(0, 6));

  for (let i = 0; i < 105; i += 1) await save('orch-builder', makeTask(`bulk-${i}`));
  assert.equal(projection.listCards({ limit: 100 }).cards.length, 100);
  assert.equal(projection.listCards({}).cards.length, 50);
  assert.throws(() => projection.listCards({ limit: 101 }), { code: 'invalid_request' });
  await state.close();
});

test('invalid inputs are rejected; unknown cards are not_found', async () => {
  const { state, projection, save } = await fixture();
  await save('orchestrator', makeTask('ok-1'));
  const bad = [
    { column: 'done' }, { role: 'orch-nobody' }, { q: 'x'.repeat(201) }, { limit: 0 }, { limit: -1 }, { limit: 'abc' },
    { limit: 1.5 }, { cursor: '!!!' }, { cursor: Buffer.from('{"u":"x","c":1}').toString('base64url') }, { cursor: Buffer.from('nope').toString('base64url') },
  ];
  for (const input of bad) assert.throws(() => projection.listCards(input), { code: 'invalid_request' }, JSON.stringify(input));
  const b64 = (s) => `lr_${Buffer.from(s, 'utf8').toString('base64url')}`;
  const badIds = [undefined, '', 'nope', 'lr_', 'lr_***', 'xx_abc', b64('only-one'), b64('orchestrator\u0000t'), b64('unknown-ns\u0000\u0000id'), b64('orchestrator\u0000\u0000')];
  for (const id of badIds) {
    assert.throws(() => projection.getCard(id), { code: 'invalid_request' }, String(id));
    assert.throws(() => projection.getAttempts(id), { code: 'invalid_request' });
    assert.throws(() => projection.getUsage(id), { code: 'invalid_request' });
    assert.throws(() => projection.decodeCardId(id), { code: 'invalid_request' });
  }
  const missing = refId(projection, 'orchestrator', 'does-not-exist');
  assert.throws(() => projection.getCard(missing), { code: 'not_found' });
  assert.throws(() => projection.getAttempts(missing), { code: 'not_found' });
  assert.throws(() => projection.getUsage(missing), { code: 'not_found' });
  assert.throws(() => projection.getCard(refId(projection, 'orchestrator', 'ok-1', 'other-tenant')), { code: 'not_found' });
  await state.close();
});

test('usage reuses buildReport for runs and standalone tasks, with coverage', async () => {
  const { state, projection, save } = await fixture();
  await save('orchestrator', makeTask('u-run', { state: 'completed' }));
  await save('orch-builder', makeTask('u-solo', { state: 'completed' }));
  const ledger = new UsageLedger({ db: state.db });
  ledger.record({
    entryId: 'lead:u-run', kind: 'lead_turn', runId: 'u-run', role: 'orch-lead', taskId: 'u-run', model: 'm', effort: 'high',
    turns: 1, elapsedMs: 10, retries: 0, tokenSource: 'total_delta', outcome: 'completed',
    tokens: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 }, permissionEvents: [],
  });
  ledger.record({
    entryId: 'builder:u-solo', kind: 'worker_turn', role: 'orch-builder', taskId: 'u-solo', tokenSource: 'unavailable', permissionEvents: [],
  });
  const run = projection.getUsage(refId(projection, 'orchestrator', 'u-run'));
  assert.deepEqual(run.scope, { runId: 'u-run' });
  assert.equal(run.totals.tokens.totalTokens, 15);
  assert.equal(run.coverage.status, 'complete');
  const solo = projection.getUsage(refId(projection, 'orch-builder', 'u-solo'));
  assert.deepEqual(solo.scope, { taskId: 'u-solo' });
  assert.equal(solo.totals.tokens, null);
  assert.equal(solo.totals.turns, null);
  assert.equal(solo.coverage.status, 'partial');
  await save('orchestrator', makeTask('u-none', { state: 'working' }));
  const none = projection.getUsage(refId(projection, 'orchestrator', 'u-none'));
  assert.equal(none.coverage.status, 'unavailable');
  assert.equal(none.totals.tokens, null);
  await state.close();
});

test('reads cause no writes', async () => {
  const { state, projection, save, db } = await fixture();
  await save('orchestrator', makeTask('w-run', { state: 'input_required', metadata: { pause: { kind: 'restart' } } }));
  await save('orch-builder', makeTask('w-solo'));
  const journal = new DispatchJournal(state);
  journal.recordSubmitting({ attemptId: 'w-run:r1:a1:t1', runId: 'w-run', assignmentId: 'w-run:r1:a1', role: 'orch-builder', sandbox: 'read-only', contextId: 'c' });
  const snapshot = () => JSON.stringify(['tasks', 'dispatch_journal'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const changes = () => db.prepare('select total_changes() AS n').get().n;
  const beforeRows = snapshot();
  const beforeChanges = changes();
  const cardId = refId(projection, 'orchestrator', 'w-run');
  projection.listCards({});
  projection.listCards({ q: 'w-', column: 'needs_attention', role: 'orch-lead', limit: 1 });
  projection.getCard(cardId);
  projection.getAttempts(cardId);
  projection.getUsage(cardId);
  projection.getUsage(refId(projection, 'orch-builder', 'w-solo'));
  assert.equal(changes(), beforeChanges);
  assert.equal(snapshot(), beforeRows);
  await state.close();
});

test('a projection works against a state db without journal or ledger tables', async () => {
  const { state, save, db } = await fixture();
  db.exec('DROP TABLE dispatch_journal');
  const projection = createProjection({ db, roleIds: ROLES });
  await save('orchestrator', makeTask('n-run'));
  const { cards } = projection.listCards({});
  assert.equal(cards.length, 1);
  assert.equal(cards[0].attemptCount, 0);
  assert.deepEqual(projection.getAttempts(cards[0].cardId), { attempts: [] });
  assert.equal(projection.getUsage(cards[0].cardId).coverage.status, 'unavailable');
  await state.close();
});

test('summary cache serves unchanged rows and refreshes when a task changes', async () => {
  const { state, projection, save } = await fixture();
  await save('orchestrator', makeTask('c-run', { state: 'working', goal: 'cached goal' }));
  assert.equal(projection.listCards({}).cards[0].boardColumn, 'in_progress');
  const afterFirst = projection.cacheStats();
  assert.equal(afterFirst.misses, 1);
  projection.listCards({});
  assert.deepEqual([projection.cacheStats().hits, projection.cacheStats().misses], [afterFirst.hits + 1, 1]);

  await save('orchestrator', makeTask('c-run', {
    state: 'input_required', goal: 'cached goal', metadata: { pause: { kind: 'waiting_for_budget' } },
  }));
  const card = projection.listCards({}).cards[0];
  assert.equal(card.boardColumn, 'needs_attention');
  assert.equal(card.waitReason, 'budget');
  assert.equal(projection.cacheStats().misses, 2);

  // Same state, changed history (for example a new user message): the light tuple still changes.
  await save('orchestrator', makeTask('c-run', {
    state: 'input_required', stamp: Date.parse('2026-03-01T00:00:00.000Z'), metadata: { pause: { kind: 'waiting_for_budget' } },
    history: [userMessage('c-run', 'a different and longer goal text')],
  }));
  assert.equal(projection.listCards({}).cards[0].title, 'a different and longer goal text');
  await state.close();
});

test('a lost submission (task_id NULL) is a child by context id and shows in attempts', async () => {
  const { state, projection, save } = await fixture();
  await save('orchestrator', makeTask('lost-run', { state: 'working' }));
  await save('orch-builder', makeTask('lost-worker', { state: 'working' }));
  new DispatchJournal(state).recordSubmitting({
    attemptId: 'lost-run:r1:a1:t1', runId: 'lost-run', assignmentId: 'lost-run:r1:a1', role: 'orch-builder', sandbox: 'workspace-write', contextId: 'ctx-lost-worker',
  });
  const { cards } = projection.listCards({});
  assert.deepEqual(cards.map((c) => c.runtimeTaskRef.taskId), ['lost-run']);
  assert.throws(() => projection.getCard(refId(projection, 'orch-builder', 'lost-worker')), { code: 'not_found' });
  const { attempts } = projection.getAttempts(refId(projection, 'orchestrator', 'lost-run'));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].taskState, 'TASK_STATE_WORKING');
  assert.deepEqual(attempts[0].runtimeTaskRef, { namespace: 'orch-builder', tenant: '', taskId: 'lost-worker', contextId: 'ctx-lost-worker' });
  await state.close();
});

test('run usage coverage is partial while attempts lack worker usage or the lead turn is missing', async () => {
  const { state, projection, save } = await fixture();
  await save('orchestrator', makeTask('cov-run', { state: 'completed' }));
  const journal = new DispatchJournal(state);
  for (const n of [1, 2]) {
    journal.recordSubmitting({ attemptId: `cov-run:r1:a${n}:t1`, runId: 'cov-run', assignmentId: `cov-run:r1:a${n}`, role: 'orch-builder', sandbox: 'workspace-write', contextId: `ctx-cov-${n}` });
  }
  journal.recordSubmitted('cov-run:r1:a1:t1', 'cov-w1');
  const ledger = new UsageLedger({ db: state.db });
  const leadEntry = {
    entryId: 'lead:cov-run', kind: 'lead_turn', runId: 'cov-run', role: 'orch-lead', taskId: 'cov-run', model: 'm', effort: 'high',
    turns: 1, elapsedMs: 10, retries: 0, tokenSource: 'total_delta', outcome: 'completed',
    tokens: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, permissionEvents: [],
  };
  const workerEntry = (id, extra) => ({
    entryId: id, kind: 'worker_turn', runId: 'cov-run', role: 'orch-builder', model: 'm', effort: 'high', turns: 1, elapsedMs: 5, retries: 0,
    tokenSource: 'total_delta', outcome: 'completed',
    tokens: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, permissionEvents: [], ...extra,
  });
  const id = refId(projection, 'orchestrator', 'cov-run');
  ledger.record(workerEntry('w1', { taskId: 'cov-w1', contextId: 'ctx-cov-1' }));
  let coverage = projection.getUsage(id).coverage;
  assert.equal(coverage.status, 'partial'); // no lead turn, attempt 2 has no usage
  assert.equal(coverage.attemptsWithoutUsage, 1);
  ledger.record(leadEntry);
  coverage = projection.getUsage(id).coverage;
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.attemptsWithoutUsage, 1);
  ledger.record(workerEntry('w2', { taskId: null, contextId: 'ctx-cov-2' }));
  coverage = projection.getUsage(id).coverage;
  assert.equal(coverage.attemptsWithoutUsage, 0);
  assert.equal(coverage.status, 'complete');
  await state.close();
});
