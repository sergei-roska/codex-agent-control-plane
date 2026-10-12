'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeReviewTarget, reviewResult } = require('../src/review-policy');

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
});
