'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCriticalReview, pathOverlaps, resourceConflict } = require('../src/task-resource-policy');

function task(taskId, extra = {}) {
  return {
    taskId, role: 'engineer', kind: 'implementation', productWritePaths: ['src/a.js'],
    readScope: { kind: 'known', paths: [] }, dependencies: [], resourceClaims: [],
    ...extra,
  };
}
function live(taskRecord) { return [{ task: taskRecord, claim: { state: 'active' }, attempt: { state: 'running' } }]; }

test('relative paths conflict on exact path and subtree boundaries', () => {
  assert.equal(pathOverlaps('src/a.js', 'src/a.js'), true);
  assert.equal(pathOverlaps('src/a.js', 'src'), true);
  assert.equal(pathOverlaps('src/a.js', 'src/ab'), false);
});

test('isolated writers overlap only with disjoint declared writes and reads', () => {
  const occupied = task('occupied');
  assert.deepEqual(resourceConflict(task('disjoint', { productWritePaths: ['lib/b.js'] }), live(occupied), { writerMode: 'isolated' }), { eligible: true, reason: null });
  assert.equal(resourceConflict(task('same', { productWritePaths: ['src'] }), live(occupied), { writerMode: 'isolated' }).reason, 'write_conflict');
  assert.equal(resourceConflict(task('read-conflict', { productWritePaths: ['lib/b.js'], readScope: { kind: 'known', paths: ['src'] } }), live(occupied), { writerMode: 'isolated' }).reason, 'read_conflict');
});

test('shared mode serializes writers while allowing independent read-only tasks', () => {
  const writer = task('writer');
  const readonly = task('reviewer', { role: 'explorer', kind: 'inspection', productWritePaths: [], readScope: { kind: 'known', paths: ['docs'] } });
  assert.equal(resourceConflict(task('other-writer', { productWritePaths: ['lib/b.js'] }), live(writer), { writerMode: 'shared' }).reason, 'write_conflict');
  assert.deepEqual(resourceConflict(readonly, live(writer), { writerMode: 'shared' }), { eligible: true, reason: null });
  assert.deepEqual(resourceConflict(readonly, live({ ...readonly, taskId: 'reviewer-two' }), { writerMode: 'shared' }), { eligible: true, reason: null });
});

test('unknown read scope and explicit resource identities stay conservative', () => {
  const unknownReader = task('unknown-reader', { role: 'explorer', productWritePaths: [], readScope: { kind: 'unknown', paths: null, reason: 'not declared' } });
  assert.equal(resourceConflict(task('writer'), live(unknownReader), { writerMode: 'isolated' }).reason, 'read_conflict');
  const claimed = task('resource-owner', { resourceClaims: ['db:migrations'] });
  assert.equal(resourceConflict(task('resource-user', { productWritePaths: ['lib/b.js'], resourceClaims: ['db:migrations'] }), live(claimed), { writerMode: 'isolated' }).reason, 'resource_conflict');
});

test('critical live-tree review waits for writers unless injected frozen proof accepts it', () => {
  const auditor = task('audit', { role: 'auditor', kind: 'review', productWritePaths: [], readScope: { kind: 'known', paths: ['src'] } });
  const writer = task('writer');
  assert.equal(resourceConflict(auditor, live(writer), { writerMode: 'shared' }).reason, 'review_barrier');
  assert.equal(resourceConflict(auditor, live(writer), { writerMode: 'shared', isFrozenReview: () => true }).eligible, true);
  const auditorTwo = { ...auditor, taskId: 'audit-two' };
  assert.equal(resourceConflict(auditorTwo, live(auditor), { writerMode: 'shared' }).eligible, true);
});

test('frozen review proof cannot waive declared product writes', () => {
  const reviewerWriter = task('review-writer', { role: 'auditor', kind: 'review', productWritePaths: ['src/a.js'] });
  const writer = task('writer', { productWritePaths: ['src/a.js'] });
  const actual = resourceConflict(reviewerWriter, live(writer), {
    writerMode: 'isolated',
    isFrozenReview: ({ task: reviewed }) => reviewed.taskId === 'review-writer',
  });
  assert.equal(actual.eligible, false);
  assert.equal(actual.reason, 'review_barrier');
});

test('canonical verifier role and verification kind trigger the critical review barrier', () => {
  const verifier = task('verifier-task', {
    role: 'verifier', kind: 'verification', productWritePaths: [],
    readScope: { kind: 'known', paths: ['test/b.js'] },
  });
  const writer = task('writer', { productWritePaths: ['src/a.js'] });
  assert.equal(resourceConflict(verifier, live(writer), { writerMode: 'shared' }).reason, 'review_barrier');
  assert.equal(isCriticalReview(verifier), true);
  assert.equal(isCriticalReview({ ...verifier, role: 'orch-verifier', kind: 'inspection' }), true);
});
