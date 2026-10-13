'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_OBSERVATIONS,
  MAX_EPISODES,
  makeObservation,
  observeLoopGuard,
  resetLoopGuard,
  reportEvidenceIdentity,
  warningText,
} = require('../src/loop-guard');

function outcome(overrides = {}) {
  return {
    role: 'explorer',
    assignmentId: 'run:r1:a0',
    attemptId: 'attempt-1',
    status: 'TASK_STATE_COMPLETED',
    objective: 'Inspect src/target.js',
    report: { outcome: 'completed', summary: 'src/target.js exports buildThing', filesInspected: ['src/target.js'], checks: [], risks: [] },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return makeObservation({
    item: {
      assignmentId: 'run:r1:a0',
      attemptId: 'attempt-1',
      role: 'explorer',
      sandbox: 'read-only',
      assignment: { objective: 'Inspect src/target.js', allowedFiles: [], checks: [] },
      ...(overrides.item || {}),
    },
    outcome: overrides.outcome || outcome(),
    ...(Object.hasOwn(overrides, 'contentIdentity') ? { contentIdentity: overrides.contentIdentity } : {}),
  });
}

test('unique research and productive outcomes can exceed the bounded history without pausing', () => {
  let state = null;
  for (let round = 1; round <= 40; round += 1) {
    const item = {
      assignmentId: `run:r${round}:a0`, attemptId: `attempt-${round}`, role: 'explorer', sandbox: 'read-only',
      assignment: { objective: `Inspect src/file-${round}.js`, allowedFiles: [], checks: [] },
    };
    const result = outcome({ assignmentId: item.assignmentId, attemptId: item.attemptId,
      objective: item.assignment.objective,
      report: { outcome: 'completed', summary: `src/file-${round}.js exports item${round}`, filesInspected: [`src/file-${round}.js`], checks: [], risks: [] } });
    state = observeLoopGuard(state, round, [makeObservation({ item, outcome: result })]);
    assert.equal(state.warning, null);
    assert.equal(state.pause, undefined);
  }
  assert.equal(state.observations.length, MAX_OBSERVATIONS);
  assert.ok(state.episodes.length <= MAX_EPISODES);
});

test('same read-only research warns on its third settled result and pauses on the next', () => {
  let state = null;
  const item = observation();
  state = observeLoopGuard(state, 1, [item]);
  state = observeLoopGuard(state, 2, [item]);
  state = observeLoopGuard(state, 3, [item]);
  assert.equal(state.warning.attempts, 3);
  assert.match(warningText(state.warning), /attempt-1/);
  state = observeLoopGuard(state, 4, [item]);
  assert.equal(state.pause.attempts, 4);
  assert.equal(state.pause.unchangedEvidence, true);
});

test('A-B repetition warns after each work item repeats and an unchanged recurrence pauses', () => {
  let state = null;
  const a = observation();
  const b = observation({ outcome: outcome({ report: { ...outcome().report, summary: 'src/target.js exports buildOther' } }) });
  for (const [round, entry] of [[1, a], [2, b], [3, a], [4, b], [5, a]]) {
    state = observeLoopGuard(state, round, [entry]);
  }
  assert.equal(state.warning.attempts, 3);
  state = observeLoopGuard(state, 6, [b]);
  assert.equal(state.warning.attempts, 3);
  state = observeLoopGuard(state, 7, [a]);
  assert.equal(state.pause.attempts, 4);
});

test('structured failure ignores objective, prose, and attempt ID churn', () => {
  const makeFailure = (id, objective, prose) => makeObservation({
    item: { assignmentId: `run:r${id}:a0`, attemptId: `attempt-${id}`, role: 'engineer', sandbox: 'workspace-write',
      assignment: { objective, allowedFiles: ['src/target.js'], checks: [] } },
    outcome: { role: 'engineer', assignmentId: `run:r${id}:a0`, attemptId: `attempt-${id}`, status: 'TASK_STATE_FAILED',
      failureKind: 'workspace_error', failure: { code: 'write_refused', message: prose },
      boundary: { results: [{ result: 'FAIL', code: 'write_refused', detail: prose }] },
      report: { outcome: 'blocked', summary: prose, filesInspected: [], checks: [], risks: [prose] },
      writerExecution: { delta: { known: false } }, attestedDeltaKnown: false },
  });
  const first = makeFailure(1, 'Edit the parser', 'first random task 111');
  const second = makeFailure(2, 'Repair parsing in another way', 'second random task 222');
  assert.equal(first.workKey, second.workKey);
  assert.equal(first.evidenceKey, second.evidenceKey);
  let state = null;
  for (let round = 1; round <= 3; round += 1) state = observeLoopGuard(state, round, [makeFailure(round, `Objective ${round}`, `message ${round}`)]);
  assert.ok(state.warning);
});

test('failed review identity ignores paraphrased instructions and incidental review IDs', () => {
  const failedReview = (round, checks, command = 'node --test test/parser.test.js', contentIdentity = 'candidate-a') => {
    const item = {
      assignmentId: `run:r${round}:a0`, attemptId: `attempt-${round}`, role: 'auditor', sandbox: 'read-only',
      assignment: {
        objective: `Inspect checkpoint in round ${round}`,
        allowedFiles: ['src/parser.js'],
        checks,
        review: {
          kind: 'risk_change', checkpointId: 'm4-r20-integrated-authority-persistence',
          reason: `Inspect the authority persistence change, attempt ${round}`,
          paths: ['src/parser.js'], evidenceIds: [`assignment-r${round}`, `attempt-${round}`],
        },
      },
    };
    const report = {
      outcome: 'completed', summary: 'VERDICT: fail\nThe parser drops authority metadata.',
      filesInspected: ['src/parser.js'], checks: [{ command, result: 'failed' }], risks: [],
    };
    return makeObservation({
      item,
      outcome: {
        role: 'auditor', assignmentId: item.assignmentId, attemptId: item.attemptId,
        status: 'TASK_STATE_COMPLETED', report,
        reviewResult: { status: 'rejected', verdict: 'fail' },
      },
      contentIdentity,
    });
  };
  const first = failedReview(31, ['Inspect authority persistence, including stale writes.']);
  const second = failedReview(32, ['Check that persisted authority survives restart and cannot go stale.']);
  assert.equal(first.workKey, second.workKey);
  assert.equal(first.evidenceKey, second.evidenceKey);
  assert.notEqual(first.evidenceKey, failedReview(33, ['Run the parser unit tests.'], 'node --test test/authority.test.js').evidenceKey);
  assert.notEqual(first.evidenceKey, failedReview(33, ['Inspect authority persistence.'], undefined, 'candidate-b').evidenceKey);

  let state = null;
  state = observeLoopGuard(state, 31, [failedReview(31, ['Inspect authority persistence and stale writes.'])]);
  state = observeLoopGuard(state, 32, [observation({
    item: { role: 'explorer', assignment: { objective: 'Check an unrelated diagnostic', allowedFiles: [], checks: [] } },
    outcome: outcome({ report: { ...outcome().report, summary: 'docs/setup.md describes local setup', filesInspected: ['docs/setup.md'] } }),
  })]);
  state = observeLoopGuard(state, 33, [failedReview(33, ['Check persisted authority after restart.'])]);
  state = observeLoopGuard(state, 34, [failedReview(34, ['Confirm stored authority remains available after restart.'])]);
  assert.equal(state.warning.attempts, 3);
  state = observeLoopGuard(state, 35, [failedReview(35, ['Review authority persistence across restart.'])]);
  assert.equal(state.pause.attempts, 4);
});

test('complete evidence beyond display caps remains distinct while failed prose churn is ignored', () => {
  const prefix = Array.from({ length: 20 }, (_, index) => `src/a${String(index).padStart(2, '0')}.js`);
  const inspect = (round) => makeObservation({
    item: { role: 'explorer', assignment: { objective: 'Inspect repository modules', allowedFiles: [], checks: [] } },
    outcome: { role: 'explorer', status: 'TASK_STATE_COMPLETED', report: {
      outcome: 'completed', summary: 'Inspected repository modules', filesInspected: [...prefix, `src/z${round}.js`], checks: [], risks: [],
    } },
  });
  const first = inspect(1);
  const second = inspect(2);
  assert.notEqual(first.evidenceKey, second.evidenceKey);

  const firstFailure = observation({ outcome: outcome({
    status: 'TASK_STATE_FAILED', failureKind: 'workspace_error', failure: { code: 'write_refused' },
    report: { ...outcome().report, outcome: 'blocked', risks: ['write refused in iteration 1'] },
  }) });
  const secondFailure = observation({ outcome: outcome({
    status: 'TASK_STATE_FAILED', failureKind: 'workspace_error', failure: { code: 'write_refused' },
    report: { ...outcome().report, outcome: 'blocked', risks: ['write refused in iteration 400'] },
  }) });
  assert.equal(firstFailure.evidenceKey, secondFailure.evidenceKey);
});

test('path evidence preserves case and complete path tails', () => {
  const inspect = (path) => makeObservation({
    item: { role: 'explorer', assignment: { objective: 'Inspect repository modules', allowedFiles: [], checks: [] } },
    outcome: { role: 'explorer', status: 'TASK_STATE_COMPLETED', report: {
      outcome: 'completed', summary: 'Inspected repository modules', filesInspected: [path], checks: [], risks: [],
    } },
  });
  assert.notEqual(inspect('src/A.js').evidenceKey, inspect('src/a.js').evidenceKey);
  assert.notEqual(
    inspect(`src/${'a'.repeat(300)}-2026-10-12/Run-ID.js`).evidenceKey,
    inspect(`src/${'a'.repeat(300)}-2026-10-12/run-id.js`).evidenceKey,
  );
});

test('precomputed report evidence ignores prose when the final review rejects it', () => {
  const rejected = (risk) => {
    const report = { outcome: 'completed', summary: 'src/target.js exports parseTarget', filesInspected: ['src/target.js'], checks: [], risks: [risk] };
    return makeObservation({
      item: { role: 'explorer', assignment: { objective: 'Inspect target', allowedFiles: ['src/target.js'], checks: [] } },
      outcome: {
        role: 'explorer', status: 'TASK_STATE_COMPLETED', report,
        loopEvidenceIdentity: reportEvidenceIdentity(report, { role: 'explorer' }),
        reviewResult: { status: 'rejected', verdict: 'fail' },
      },
    });
  };
  const first = rejected('Risk detail changed in review attempt 1');
  const second = rejected('Risk detail changed in review attempt 9');
  assert.equal(first.evidenceKey, second.evidenceKey);
  assert.notEqual(
    first.evidenceKey,
    makeObservation({
      item: { role: 'explorer', assignment: { objective: 'Inspect target', allowedFiles: ['src/target.js'], checks: [] } },
      outcome: {
        role: 'explorer', status: 'TASK_STATE_COMPLETED',
        report: { outcome: 'completed', summary: 'src/target.js exports parseTarget', filesInspected: ['src/target.js'], checks: [], risks: ['Risk detail changed in review attempt 1'] },
        loopEvidenceIdentity: reportEvidenceIdentity({ outcome: 'completed', summary: 'src/target.js exports parseTarget', filesInspected: ['src/target.js'], checks: [], risks: ['Risk detail changed in review attempt 1'] }, { role: 'explorer' }),
      },
    }).evidenceKey,
  );
});

test('precomputed blocked-report evidence ignores risk prose even if task status completed', () => {
  const blocked = (risk) => {
    const report = { outcome: 'blocked', summary: 'Unable to complete target inspection', filesInspected: ['src/target.js'], checks: [], risks: [risk] };
    return makeObservation({
      item: { role: 'explorer', assignment: { objective: 'Inspect target', allowedFiles: ['src/target.js'], checks: [] } },
      outcome: {
        role: 'explorer', status: 'TASK_STATE_COMPLETED', report,
        loopEvidenceIdentity: reportEvidenceIdentity(report, { role: 'explorer' }),
      },
    });
  };
  assert.equal(blocked('Unable to inspect in attempt 1').evidenceKey, blocked('Unable to inspect in attempt 8').evidenceKey);
});

test('a new finding on the same inspected file clears its warning; unrelated work does not', () => {
  let state = null;
  const same = observation();
  for (let round = 1; round <= 3; round += 1) state = observeLoopGuard(state, round, [same]);
  const unrelated = observation({
    item: { assignment: { objective: 'Inspect src/other.js', allowedFiles: [], checks: [] } },
    outcome: outcome({ objective: 'Inspect src/other.js', report: { ...outcome().report, filesInspected: ['src/other.js'] } }),
  });
  state = observeLoopGuard(state, 4, [unrelated]);
  assert.ok(state.warning);
  const newFinding = observation({ outcome: outcome({ report: { ...outcome().report, summary: 'src/target.js calls parseHeader before decode' } }) });
  state = observeLoopGuard(state, 5, [newFinding]);
  assert.equal(state.warning, null);
});

test('content identity changes are novel once, but toggling to a seen target cannot launder a loop', () => {
  let state = null;
  const a = observation({ contentIdentity: 'content-a' });
  const b = observation({ contentIdentity: 'content-b' });
  for (const [round, entry] of [[1, a], [2, b], [3, a], [4, b], [5, a], [6, b]]) state = observeLoopGuard(state, round, [entry]);
  assert.ok(state.warning);
  state = observeLoopGuard(state, 7, [a]);
  assert.ok(state.pause);
});

test('unknown deltas and artifact handle churn do not count as novelty', () => {
  const makeUnknown = (round, evidenceId) => makeObservation({
    item: { assignmentId: `run:r${round}:a0`, attemptId: `attempt-${round}`, role: 'engineer', sandbox: 'workspace-write',
      assignment: { objective: 'Fix target', allowedFiles: ['src/target.js'], checks: [] } },
    outcome: { role: 'engineer', assignmentId: `run:r${round}:a0`, attemptId: `attempt-${round}`, status: 'TASK_STATE_FAILED',
      failureKind: 'write_refused', report: { outcome: 'blocked', summary: 'No verified result', filesInspected: [], checks: [], risks: [] },
      evidence: [{ id: evidenceId }], writerExecution: { delta: { known: false } }, attestedDeltaKnown: false },
  });
  let state = null;
  for (let round = 1; round <= 4; round += 1) state = observeLoopGuard(state, round, [makeUnknown(round, `handle-${round}`)]);
  assert.ok(state.warning);
  assert.ok(state.pause);
  assert.equal(state.episodes[0].count, 4);
});

test('duplicate round replay is ignored and state reset clears an episode', () => {
  let state = observeLoopGuard(null, 1, [observation()]);
  const before = JSON.stringify(state);
  state = observeLoopGuard(state, 1, [observation()]);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(resetLoopGuard(), { observations: [], episodes: [], warnings: [], warning: null, lastRound: null });
});

test('cleared warnings can reappear, and unrelated work gets its own delivered warning', () => {
  let state = null;
  const a = observation();
  const b = observation({
    item: { assignment: { objective: 'Inspect src/other.js', allowedFiles: [], checks: [] } },
    outcome: outcome({ objective: 'Inspect src/other.js', report: { ...outcome().report, filesInspected: ['src/other.js'] } }),
  });
  state = observeLoopGuard(state, 1, [a]);
  state = observeLoopGuard(state, 2, [a]);
  state = observeLoopGuard(state, 3, [a]);
  state = observeLoopGuard(state, 4, [observation({ outcome: outcome({ report: { ...outcome().report, summary: 'src/target.js calls parseHeader' } }) })]);
  assert.equal(state.warning, null);
  state = observeLoopGuard(state, 5, [a]);
  state = observeLoopGuard(state, 6, [a]);
  assert.ok(state.warnings.some((entry) => entry.workKey === a.workKey));
  assert.equal(state.pause.description, a.description);

  state = null;
  for (const [round, entry] of [[1, a], [2, a], [3, a], [4, b], [5, b], [6, b]]) state = observeLoopGuard(state, round, [entry]);
  assert.equal(state.warnings.length, 2);
  assert.match(warningText(state), /inspect src\/target.js/);
  assert.match(warningText(state), /inspect src\/other.js/);
  state = observeLoopGuard(state, 7, [b]);
  assert.equal(state.pause.description, b.description);
});

test('same-work novelty suppresses an unchanged pause regardless of mixed-batch order', () => {
  const oldEvidence = { workKey: 'same-work', evidenceKey: 'old', description: 'same scoped work', assignmentId: 'a' };
  const newEvidence = { workKey: 'same-work', evidenceKey: 'new', description: 'same scoped work', assignmentId: 'b' };
  for (const batch of [[oldEvidence, newEvidence], [newEvidence, oldEvidence]]) {
    let state = null;
    for (let round = 1; round <= 3; round += 1) state = observeLoopGuard(state, round, [oldEvidence]);
    assert.ok(state.warning);
    state = observeLoopGuard(state, 4, batch);
    assert.equal(state.pause, undefined);
    assert.equal(state.warning, null);
    assert.deepEqual(state.warnings, []);
  }
});

test('warning text renders all current warnings and a legacy single warning checkpoint', () => {
  const first = { workKey: 'a', evidenceKey: '1', description: 'work A', attempts: 3 };
  const second = { workKey: 'b', evidenceKey: '1', description: 'work B', attempts: 3 };
  const current = warningText({ warnings: [first, second], warning: first });
  assert.match(current, /work A/);
  assert.match(current, /work B/);
  assert.match(warningText({ warning: first }), /work A/);
});

test('the prior checkpoint state is not mutated while applying a new observation', () => {
  const frozen = observeLoopGuard(null, 1, [observation()]);
  const before = JSON.stringify(frozen);
  observeLoopGuard(frozen, 2, [observation()]);
  assert.equal(JSON.stringify(frozen), before);
});
