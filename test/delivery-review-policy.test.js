'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { closuresIndependent, normalizeClosure, samePromotionIdentity, reviewDependencyEdges, frozenReviewMatches } = require('../src/delivery-review-policy');

const D = 'a'.repeat(64);
const closure = (readManifest, checkpointAncestors = [], checkpointId = null) => normalizeClosure({ known: true, readManifest, checkpointAncestors, checkpointId });

test('attested read-only scopes may share paths unless checkpoint ancestry couples them', () => {
  const a = { checkpointId: 'cp-a', closure: closure([{ path: 'src/a.js', digest: D }], ['cp-root'], 'cp-a') };
  const b = { checkpointId: 'cp-b', closure: closure([{ path: 'src/b.js', digest: D }], ['cp-root'], 'cp-b') };
  const samePath = { checkpointId: 'cp-c', closure: closure([{ path: 'src/a.js', digest: D }], [], 'cp-c') };
  const ancestor = { checkpointId: 'cp-root', closure: closure([{ path: 'src/c.js', digest: D }], [], 'cp-root') };
  const transitiveDependent = { checkpointId: 'cp-child', closure: closure([{ path: 'src/d.js', digest: D }], ['cp-a', 'cp-root'], 'cp-child') };
  assert.equal(closuresIndependent(a.closure, b.closure), true);
  assert.equal(closuresIndependent(a.closure, samePath.closure), true);
  assert.equal(closuresIndependent(a.closure, ancestor.closure), false);
  assert.equal(closuresIndependent(a.closure, transitiveDependent.closure), false);
  assert.equal(closuresIndependent({ known: false }, b.closure), false);
  assert.throws(() => closure([{ path: '../escape', digest: D }]), { code: 'review_closure_path_invalid' });
});

test('promotion compares immutable owner, check, pin, environment and full attested closure identities', () => {
  const base = { projectId: 'p', objectiveId: 'o', requirementDigest: D, checkIdentity: 'check-v1',
    checkPins: ['check-file-v1'], toolPins: ['tool-v1'], profilePins: ['profile-v1'], environmentDigest: D,
    closure: closure([{ path: 'src/a.js', digest: D }]) };
  assert.equal(samePromotionIdentity(base, { ...base, candidateId: 'candidate-next' }), true);
  assert.equal(samePromotionIdentity(base, { ...base, closure: closure([{ path: 'src/a.js', digest: 'b'.repeat(64) }]) }), false);
  assert.equal(samePromotionIdentity(base, { ...base, closure: { known: false } }), false);
  assert.equal(samePromotionIdentity(base, { ...base, requirementDigest: 'b'.repeat(64) }), false);
});

test('review dependencies are added only for declared checkpoint and verifier evidence flows', () => {
  const checkpoints = [{ checkpointId: 'cp', dependsOn: ['ancestor'] }, { checkpointId: 'ancestor', dependsOn: [] }];
  const proposals = [{ checkpointId: 'cp', role: 'auditor', dependsOnVerifierEvidence: true },
    { checkpointId: 'cp', role: 'auditor', dependsOnVerifierEvidence: false }];
  const edges = reviewDependencyEdges(checkpoints, proposals);
  assert.equal(edges.length, 3);
  assert.equal(edges.filter((edge) => edge.predecessorRole === 'verifier').length, 1);
  assert.throws(() => reviewDependencyEdges([checkpoints[0]], [{ checkpointId: 'cp', role: 'auditor', dependsOnVerifierEvidence: false }]), { code: 'review_checkpoint_dependency_missing' });
});

test('scheduler proof requires an exact registered read-only task and bound candidate snapshot', () => {
  const task = { projectId: 'p', objectiveId: 'o', taskId: 't', revision: 1, role: 'auditor', kind: 'review',
    productWritePaths: [], baseCandidateId: 'c', checkpointId: 'cp' };
  const registered = { task, context: { contextDigest: 'ctx', candidateId: 'c', candidateManifestDigest: D },
    candidate: { status: 'known', manifestDigest: D } };
  assert.equal(frozenReviewMatches(task, registered), true);
  assert.equal(frozenReviewMatches({ ...task, productWritePaths: ['src/a.js'] }, registered), false);
  assert.equal(frozenReviewMatches({ ...task, baseCandidateId: 'c2' }, registered), false);
  assert.equal(frozenReviewMatches(task, { ...registered, candidate: { status: 'known', manifestDigest: 'b'.repeat(64) } }), false);
});
