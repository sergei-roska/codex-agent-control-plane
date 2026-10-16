'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeReviewTarget, reviewResult, sameReviewScope } = require('../src/review-policy');

const review = { kind: 'risk_change', checkpointId: 'cp-1', reason: 'boundary change', paths: ['src/file.js'], evidenceIds: [] };

test('review targets reject a file reached through an escaping parent symlink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'review-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, 'file.js'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'src'));
  const target = computeReviewTarget({ workspace: root, review });
  assert.equal(target.known, false);
  assert.equal(target.identity, null);
});

test('review targets allow an in-workspace parent symlink and change when scoped content changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'real-src'));
  fs.writeFileSync(path.join(root, 'real-src', 'file.js'), 'one');
  fs.symlinkSync(path.join(root, 'real-src'), path.join(root, 'src'));
  const first = computeReviewTarget({ workspace: root, review });
  assert.equal(first.known, true);
  fs.writeFileSync(path.join(root, 'real-src', 'file.js'), 'two');
  const second = computeReviewTarget({ workspace: root, review });
  assert.equal(second.known, true);
  assert.notEqual(first.identity, second.identity);
});

test('prerequisite links are part of immutable scope and target identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'file.js'), 'candidate');
  const unlinked = { ...review, prerequisiteFor: [] };
  const linked = { ...review, prerequisiteFor: ['critical-1'] };
  assert.equal(sameReviewScope(unlinked, linked), false);
  assert.equal(sameReviewScope(review, unlinked), true);
  assert.equal(
    computeReviewTarget({ workspace: root, review }).identity,
    computeReviewTarget({ workspace: root, review: unlinked }).identity,
  );
  assert.notEqual(
    computeReviewTarget({ workspace: root, review: unlinked }).identity,
    computeReviewTarget({ workspace: root, review: linked }).identity,
  );
});

test('every normalized review field is part of matching and target identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-policy-fields-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'file.js'), 'candidate');
  const baseline = {
    kind: 'risk_change', checkpointId: 'cp-1', reason: 'boundary change',
    paths: ['src/file.js'], evidenceIds: ['evidence-1'], prerequisiteFor: ['critical-1'],
  };
  const baselineTarget = computeReviewTarget({ workspace: root, review: baseline, runId: 'run-1' });
  for (const [field, value] of Object.entries({
    kind: 'performance', checkpointId: 'cp-2', reason: 'different reason',
    paths: ['src'], evidenceIds: ['evidence-2'], prerequisiteFor: ['critical-2'],
  })) {
    const changed = { ...baseline, [field]: value };
    assert.equal(sameReviewScope(baseline, changed), false, `${field} must remain immutable`);
    assert.notEqual(
      computeReviewTarget({ workspace: root, review: changed, runId: 'run-1' }).identity,
      baselineTarget.identity,
      `${field} must affect target identity`,
    );
  }
});

test('review results must inspect the declared scope and pass all reported checks', () => {
  const outcome = {
    status: 'TASK_STATE_COMPLETED',
    sandbox: 'read-only',
    report: {
      outcome: 'completed', summary: 'VERDICT: pass\nReviewed.',
      filesInspected: ['docs/other.md'], checks: [{ result: 'passed' }], decisionRequest: null,
    },
  };
  assert.equal(reviewResult(outcome, 'auditor', review).reason, 'review_did_not_inspect_declared_scope');
  outcome.report.filesInspected = ['src/file.js'];
  assert.equal(reviewResult(outcome, 'auditor', review).valid, true);
  outcome.report.checks[0].result = 'not_run';
  assert.equal(reviewResult(outcome, 'auditor', review).reason, 'review_checks_failed_or_unrun');
  outcome.report.checks[0].result = 'failed';
  assert.equal(reviewResult(outcome, 'auditor', review).reason, 'review_checks_failed_or_unrun');
});

test('auditor verdict must be the complete standalone first line', () => {
  const outcome = {
    status: 'TASK_STATE_COMPLETED',
    sandbox: 'read-only',
    report: {
      outcome: 'completed', summary: 'VERDICT: pass',
      filesInspected: ['src/file.js'], checks: [{ result: 'passed' }], decisionRequest: null,
    },
  };
  assert.equal(reviewResult(outcome, 'auditor', review).valid, true);
  for (const summary of [
    'VERDICT: pass. Authority/release: PASS',
    'VERDICT: pass (verified)',
    'Audit complete.\nVERDICT: pass',
    'VERDICT: inconclusive details',
  ]) {
    outcome.report.summary = summary;
    assert.equal(reviewResult(outcome, 'auditor', review).reason, 'audit_verdict_missing_or_invalid', summary);
  }
});

test('a writable verifier accepts only a proven empty lane with stable review coverage', () => {
  const outcome = {
    status: 'TASK_STATE_COMPLETED',
    sandbox: 'workspace-write',
    report: {
      outcome: 'completed', summary: 'Focused verification passed.',
      filesInspected: ['src/file.js'], checks: [{ result: 'passed' }], decisionRequest: null,
    },
    writerExecution: {
      state: null,
      lane: { state: 'not_integrated', reason: 'no_changes' },
      delta: { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: 'lane_collection' },
    },
    reviewCoverage: { targetKnown: true, targetIdentity: 'review-target:stable', stable: true },
  };
  assert.equal(reviewResult(outcome, 'verifier', review).status, 'accepted');

  const rejected = (changes) => {
    const changed = structuredClone(outcome);
    changes(changed);
    return reviewResult(changed, 'verifier', review);
  };
  assert.equal(rejected((value) => { value.writerExecution.delta.known = false; }).reason, 'review_writer_unsettled');
  assert.equal(rejected((value) => { value.writerExecution.delta.changedPaths = ['src/file.js']; }).reason, 'review_writer_unsettled');
  assert.equal(rejected((value) => { value.writerExecution.delta.changedPathCount = 1; }).reason, 'review_writer_unsettled');
  assert.equal(rejected((value) => { value.writerExecution.lane.reason = 'lane_unsafe'; }).reason, 'review_writer_unsettled');
  assert.equal(rejected((value) => { value.reviewCoverage.stable = false; }).reason, 'review_target_unknown_or_changed');
  assert.equal(rejected((value) => { value.reviewCoverage.targetKnown = false; }).reason, 'review_target_unknown_or_changed');
  assert.equal(rejected((value) => { value.scopeViolations = ['src/other.js']; }).reason, 'review_scope_violation');
  assert.equal(rejected((value) => { value.boundary = { results: [{ result: 'FAIL' }] }; }).reason, 'review_boundary_failed');
  assert.equal(rejected((value) => { value.boundary = { results: [{ result: 'PASS', advisory: true, code: 'attested_scope_violation' }] }; }).reason, 'review_scope_violation');
  assert.equal(reviewResult({ ...outcome, status: 'TASK_STATE_CANCELED' }, 'verifier', review).valid, false);
  assert.equal(reviewResult(outcome, 'auditor', review).reason, 'review_writer_unsettled');
});
