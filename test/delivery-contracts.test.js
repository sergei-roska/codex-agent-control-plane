'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  VERSION, DeliveryContractError, validateObjective, validateTask, validateDependency,
  validateAttempt, validateClaim, validateEvent, validateCandidate, validateReceipt,
  validateDependencyGraph, validatePlanDelta,
} = require('../src/delivery-contracts');

const base = { schemaVersion: VERSION, projectId: 'project-alpha', objectiveId: 'objective-main' };
function task(taskId, extra = {}) {
  return {
    ...base, schemaVersion: VERSION, taskId, revision: 1, role: 'engineer', kind: 'implementation',
    objective: `Implement ${taskId}`, priority: 0, dependencies: [], productWritePaths: ['src/new-module.js'],
    readScope: { kind: 'unknown', paths: null, reason: 'Dependency closure has not been established.' },
    scratchWriteRoots: ['.scratch/task-output'], resourceClaims: ['port:ephemeral'],
    publicationAuthority: { state: 'unknown', reason: 'Controller decides at integration.' }, state: 'queued', ...extra,
  };
}
function dep(predecessorId, successorTaskId, extra = {}) {
  return { projectId: base.projectId, objectiveId: base.objectiveId, predecessorType: 'task', predecessorId, successorTaskId, kind: 'requires_output', ...extra };
}
function throwsCode(fn, code, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DeliveryContractError);
    assert.equal(error.code, code);
    if (path) assert.equal(error.path, path);
    return true;
  });
}

test('normalizes realistic versioned delivery records without mutating input', () => {
  const objective = { ...base, sessionId: 'session-opaque', engineVersion: 'delivery-v1', goalRevision: 3, requirementDigest: 'sha256:' + 'a'.repeat(64), checksDigest: 'sha256:' + 'b'.repeat(64), authorityRevision: 2, controlRevision: 4, disposition: 'executing', legacyRunId: null };
  const candidate = { ...base, candidateId: 'candidate-base', integrationGeneration: 0, snapshotRef: 'snapshot:sha256:abc', contentManifestDigest: 'sha256:' + 'c'.repeat(64), status: 'frozen', parentCandidateId: null, sourceAttemptId: null };
  const attempt = { ...base, attemptId: 'attempt-opaque-a', taskId: 'task-a', taskRevision: 1, attemptNo: 1, executionGeneration: 0, fencingToken: 1, contractDigest: 'sha256:' + 'd'.repeat(64), selectedSettingsDigest: 'sha256:' + 'e'.repeat(64), state: 'running', providerContextId: null, outcome: null };
  const claim = { ...base, claimId: 'claim-a', taskId: 'task-a', attemptId: attempt.attemptId, ownerGeneration: 0, fencingToken: 1, role: 'engineer', capacityClass: 'engineer', leaseUntil: 1000, heartbeatAt: 900, state: 'active' };
  const event = { schemaVersion: VERSION, projectId: base.projectId, sequence: 1, eventId: 'event-a', eventType: 'attempt.started', objectRevision: 1, payload: { known: null }, dedupeKey: 'attempt-a-started' };
  const receipt = { ...base, receiptId: 'receipt-a', checkpointId: 'checkpoint-a', candidateId: candidate.candidateId, contextDigest: 'sha256:' + 'f'.repeat(64), inputManifestDigest: 'sha256:' + '0'.repeat(64), checkPins: ['check:v1'], toolPins: [], profilePins: ['profile:engineer:v1'], role: 'verifier', attemptId: attempt.attemptId, outcome: 'passed', evidenceRefs: ['artifact:report-a'] };
  for (const [validate, record] of [[validateObjective, objective], [validateTask, task('task-a')], [validateAttempt, attempt], [validateClaim, claim], [validateEvent, event], [validateCandidate, candidate], [validateReceipt, receipt]]) {
    const before = structuredClone(record);
    assert.deepEqual(validate(record), before);
    assert.deepEqual(record, before);
  }
});

test('rejects malformed bounded IDs, unsupported versions, non-finite values, and unsafe paths with stable locations', () => {
  throwsCode(() => validateTask(task('bad id')), 'id_invalid', '$.taskId');
  throwsCode(() => validateTask({ ...task('task-a'), schemaVersion: 'delivery/v9' }), 'schema_version_unsupported', '$.schemaVersion');
  throwsCode(() => validateClaim({ ...base, claimId: 'claim-a', taskId: 'task-a', attemptId: 'attempt-a', ownerGeneration: 0, fencingToken: 1, role: 'engineer', capacityClass: 'engineer', leaseUntil: Infinity, heartbeatAt: 0, state: 'active' }), 'number_not_finite', '$.leaseUntil');
  throwsCode(() => validateTask(task('task-a', { productWritePaths: ['../outside'] })), 'path_unsafe', '$.productWritePaths[0]');
  throwsCode(() => validateTask(task('task-a', { scratchWriteRoots: ['/tmp/outside'] })), 'path_unsafe', '$.scratchWriteRoots[0]');
  throwsCode(() => validateTask(task('task-a', { productWritePaths: ['src//x'] })), 'path_unsafe', '$.productWritePaths[0]');
  throwsCode(() => validateTask(task('task-a', { productWritePaths: ['src/'] })), 'path_unsafe', '$.productWritePaths[0]');
  throwsCode(() => validateTask(task('task-a', { readScope: { kind: 'unknown', paths: ['src'], reason: 'unknown' } })), 'unknown_read_scope_must_be_null', '$.readScope.paths');
});

test('keeps unknown read scope distinct from bounded writes and scratch permissions', () => {
  const normalized = validateTask(task('task-a'));
  assert.deepEqual(normalized.readScope, { kind: 'unknown', paths: null, reason: 'Dependency closure has not been established.' });
  assert.deepEqual(normalized.productWritePaths, ['src/new-module.js']);
  assert.deepEqual(normalized.scratchWriteRoots, ['.scratch/task-output']);
  assert.deepEqual(normalized.resourceClaims, ['port:ephemeral']);
  assert.deepEqual(normalized.publicationAuthority, { state: 'unknown', reason: 'Controller decides at integration.' });
});

test('validates explicit task and checkpoint dependencies and rejects self, missing, cross-project, and cyclic references', () => {
  const a = task('task-a');
  const b = task('task-b', { dependencies: [dep('task-a', 'task-b')] });
  const c = task('task-c', { dependencies: [{ projectId: base.projectId, objectiveId: base.objectiveId, predecessorType: 'checkpoint', predecessorId: 'checkpoint-1', successorTaskId: 'task-c', kind: 'requires_acceptance' }] });
  assert.equal(validateDependencyGraph([a, b, c], [{ projectId: base.projectId, objectiveId: base.objectiveId, checkpointId: 'checkpoint-1' }]).length, 3);
  throwsCode(() => validateDependencyGraph([task('task-a', { dependencies: [dep('task-a', 'task-a')] })]), 'dependency_self_reference', '$.tasks[0].dependencies[0].predecessorId');
  throwsCode(() => validateDependencyGraph([task('task-a', { dependencies: [dep('missing', 'task-a')] })]), 'dependency_reference_missing', '$.tasks[0].dependencies[0].predecessorId');
  throwsCode(() => validateDependencyGraph([task('task-a', { dependencies: [dep('task-b', 'task-a', { projectId: 'project-other' })] }), task('task-b')]), 'project_reference_mismatch', '$.dependencies[0].projectId');
  const ca = task('task-a', { dependencies: [dep('task-b', 'task-a')] });
  const cb = task('task-b', { dependencies: [dep('task-a', 'task-b')] });
  throwsCode(() => validateDependencyGraph([ca, cb]), 'dependency_cycle');
  throwsCode(() => validateDependencyGraph([c]), 'checkpoint_reference_missing');
  throwsCode(() => validateDependencyGraph([c], [{ projectId: 'project-other', objectiveId: base.objectiveId, checkpointId: 'checkpoint-1' }]), 'project_reference_mismatch');
});

test('permits distinct same-role task identities and rejects duplicate IDs', () => {
  assert.equal(validateDependencyGraph([task('task-a'), task('task-b')]).length, 2);
  throwsCode(() => validateDependencyGraph([task('task-a'), task('task-a')]), 'task_id_duplicate');
});

function projection(tasks = [task('task-a')]) {
  return { projectId: base.projectId, objectiveId: base.objectiveId, planRevision: 5, goalRevision: 3, authorityRevision: 2, controlRevision: 4, tasks, checkpoints: [] };
}
function delta(tasks = []) {
  return { schemaVersion: VERSION, expectedPlanRevision: 5, expectedGoalRevision: 3, expectedAuthorityRevision: 2, expectedControlRevision: 4, nextPlanRevision: 6, tasks, dependencies: [] };
}

test('plan CAS rejects stale owner correction and completed task edits', () => {
  throwsCode(() => validatePlanDelta({ ...projection(), goalRevision: 4 }, delta()), 'plan_revision_stale', '$.expectedGoalRevision');
  const completed = task('task-a', { state: 'succeeded' });
  const replacement = task('task-a', { revision: 2, objective: 'Changed completed task' });
  throwsCode(() => validatePlanDelta(projection([completed]), delta([{ expectedRevision: 1, task: replacement }])), 'terminal_task_immutable');
});

test('plan CAS rejects active contract edits and accepts explicit queued revision changes', () => {
  for (const state of ['claimed', 'running', 'settling']) {
    const active = task('task-a', { state });
    throwsCode(() => validatePlanDelta(projection([active]), delta([{ expectedRevision: 1, task: task('task-a', { revision: 2, state: 'queued' }) }])), 'active_task_contract_immutable');
  }
  const corrected = task('task-a', { revision: 2, objective: 'Corrected queued scope' });
  const next = validatePlanDelta(projection(), delta([{ expectedRevision: 1, task: corrected }]));
  assert.equal(next.tasks[0].revision, 2);
  assert.equal(next.nextPlanRevision, 6);
  throwsCode(() => validatePlanDelta(projection(), delta([{ expectedRevision: 2, task: corrected }])), 'task_revision_stale');
});

test('plan delta validates new task references and finite revision/capacity-like integers', () => {
  const activeProjection = projection([task('task-a', { state: 'running' }), task('task-b')]);
  const dependencyOnly = delta();
  dependencyOnly.dependencies = [{ schemaVersion: VERSION, ...dep('task-b', 'task-a') }];
  throwsCode(() => validatePlanDelta(activeProjection, dependencyOnly), 'dependency_change_requires_task_revision');
  const completedProjection = projection([task('task-a', { state: 'succeeded' }), task('task-b')]);
  throwsCode(() => validatePlanDelta(completedProjection, dependencyOnly), 'dependency_change_requires_task_revision');
  const newTask = task('task-b');
  const withEdge = delta([{ task: newTask }]);
  withEdge.dependencies = [{ schemaVersion: VERSION, ...dep('task-b', 'task-b') }];
  throwsCode(() => validatePlanDelta(projection(), withEdge), 'dependency_self_reference');
  const bad = delta(); bad.nextPlanRevision = 6.5;
  throwsCode(() => validatePlanDelta(projection(), bad), 'integer_invalid', '$.nextPlanRevision');
  const stale = delta(); stale.expectedAuthorityRevision = 1;
  throwsCode(() => validatePlanDelta(projection(), stale), 'plan_revision_stale', '$.expectedAuthorityRevision');
});

test('allows an explicit queued-task supersession and rejects active or stale supersession', () => {
  const superseding = task('task-b', { supersedesTaskId: 'task-a' });
  const supersession = delta([{ expectedRevision: 1, task: superseding }]);
  const normalized = validatePlanDelta(projection(), supersession);
  assert.equal(normalized.tasks[0].supersedesTaskId, 'task-a');
  throwsCode(() => validatePlanDelta(projection([task('task-a', { state: 'running' })]), supersession), 'active_task_contract_immutable');
  throwsCode(() => validatePlanDelta(projection(), delta([{ expectedRevision: 2, task: superseding }])), 'task_revision_stale');
});

test('revisioned replacements preserve supersession lineage and cannot introduce unchecked lineage', () => {
  const replacementWithNewLineage = task('task-b', { revision: 2, supersedesTaskId: 'task-a' });
  throwsCode(() => validatePlanDelta(projection([task('task-a', { state: 'running' }), task('task-b')]), delta([{ expectedRevision: 1, task: replacementWithNewLineage }])), 'supersession_lineage_immutable', '$.tasks[0].task.supersedesTaskId');
  throwsCode(() => validatePlanDelta(projection([task('task-b')]), delta([{ expectedRevision: 1, task: replacementWithNewLineage }])), 'supersession_lineage_immutable', '$.tasks[0].task.supersedesTaskId');

  const oldLineage = task('task-a', { state: 'superseded' });
  const current = task('task-b', { supersedesTaskId: 'task-a' });
  const keepLineage = task('task-b', { revision: 2, objective: 'Corrected queued scope', supersedesTaskId: 'task-a' });
  const next = validatePlanDelta(projection([oldLineage, current]), delta([{ expectedRevision: 1, task: keepLineage }]));
  assert.equal(next.tasks[0].supersedesTaskId, 'task-a');

  const removeLineage = task('task-b', { revision: 2 });
  throwsCode(() => validatePlanDelta(projection([oldLineage, current]), delta([{ expectedRevision: 1, task: removeLineage }])), 'supersession_lineage_immutable', '$.tasks[0].task.supersedesTaskId');
  const changeLineage = task('task-b', { revision: 2, supersedesTaskId: 'task-other' });
  throwsCode(() => validatePlanDelta(projection([oldLineage, current]), delta([{ expectedRevision: 1, task: changeLineage }])), 'supersession_lineage_immutable', '$.tasks[0].task.supersedesTaskId');

  const twoIdentitiesMutateTarget = delta([
    { expectedRevision: 1, task: task('task-a', { revision: 2 }) },
    { task: task('task-c', { supersedesTaskId: 'task-a' }) },
  ]);
  throwsCode(() => validatePlanDelta(projection(), twoIdentitiesMutateTarget), 'task_change_duplicate', '$.tasks[1].task.supersedesTaskId');
});

test('rejects malformed checkpoint containers with stable contract errors', () => {
  for (const checkpoints of [{}, 'bad', null]) {
    throwsCode(() => validatePlanDelta({ ...projection([]), checkpoints }, delta()), 'checkpoints_array_required', '$.currentProjection.checkpoints');
  }
  throwsCode(() => validateDependencyGraph([], {}), 'checkpoints_array_required', '$.checkpoints');
});

test('validates standalone dependency successors and duplicates before graph projection', () => {
  const missingSuccessor = delta();
  missingSuccessor.dependencies = [{ schemaVersion: VERSION, ...dep('task-a', 'missing') }];
  throwsCode(() => validatePlanDelta(projection(), missingSuccessor), 'dependency_successor_missing', '$.dependencies[0].successorTaskId');

  const duplicateMissingSuccessor = delta();
  duplicateMissingSuccessor.dependencies = [{ schemaVersion: VERSION, ...dep('task-a', 'missing') }, { schemaVersion: VERSION, ...dep('task-a', 'missing') }];
  throwsCode(() => validatePlanDelta(projection(), duplicateMissingSuccessor), 'dependency_successor_missing', '$.dependencies[0].successorTaskId');

  const duplicateExistingSuccessor = delta();
  duplicateExistingSuccessor.dependencies = [{ schemaVersion: VERSION, ...dep('task-a', 'task-b') }, { schemaVersion: VERSION, ...dep('task-a', 'task-b') }];
  duplicateExistingSuccessor.tasks = [{ task: task('task-b') }];
  throwsCode(() => validatePlanDelta(projection(), duplicateExistingSuccessor), 'dependency_duplicate', '$.dependencies[1]');

  const explicitReplacement = delta([{ expectedRevision: 1, task: task('task-a', { revision: 2, dependencies: [] }) }]);
  explicitReplacement.dependencies = [{ schemaVersion: VERSION, ...dep('task-b', 'task-a') }];
  const next = validatePlanDelta(projection([task('task-a', { dependencies: [dep('task-b', 'task-a')] }), task('task-b')]), explicitReplacement);
  assert.deepEqual(next.dependencies, [{ schemaVersion: VERSION, ...dep('task-b', 'task-a') }]);

  const colonIds = projection([task('a'), task('a:task:b'), task('c'), task('b:task:c')]);
  const distinctColonEdges = delta([
    { expectedRevision: 1, task: task('a', { revision: 2 }) },
    { expectedRevision: 1, task: task('a:task:b', { revision: 2 }) },
  ]);
  distinctColonEdges.dependencies = [
    { schemaVersion: VERSION, ...dep('c', 'a:task:b') },
    { schemaVersion: VERSION, ...dep('b:task:c', 'a') },
  ];
  assert.equal(validatePlanDelta(colonIds, distinctColonEdges).dependencies.length, 2);
});


test('planner deltas cannot claim execution success or grant publication authority', () => {
  const empty = projection([]);
  const proposed = task('task-new', { state: 'succeeded', publicationAuthority: { state: 'granted' } });
  assert.equal(validateTask(proposed).state, 'succeeded');
  throwsCode(() => validatePlanDelta(empty, delta([{ task: proposed }])), 'planner_task_state_invalid', '$.tasks[0].task.state');
  const grantedNew = task('task-new', { publicationAuthority: { state: 'granted' } });
  throwsCode(() => validatePlanDelta(empty, delta([{ task: grantedNew }])), 'planner_publication_authority_invalid', '$.tasks[0].task.publicationAuthority.state');

  const superseding = task('task-new', { supersedesTaskId: 'task-a', publicationAuthority: { state: 'granted' } });
  throwsCode(() => validatePlanDelta(projection(), delta([{ expectedRevision: 1, task: superseding }])), 'planner_publication_authority_invalid');
  const supersedingSuccess = task('task-new', { supersedesTaskId: 'task-a', state: 'succeeded' });
  throwsCode(() => validatePlanDelta(projection(), delta([{ expectedRevision: 1, task: supersedingSuccess }])), 'planner_task_state_invalid');

  const replacement = task('task-a', { revision: 2, publicationAuthority: { state: 'granted' } });
  throwsCode(() => validatePlanDelta(projection(), delta([{ expectedRevision: 1, task: replacement }])), 'planner_publication_authority_invalid');
  const replacementSuccess = task('task-a', { revision: 2, state: 'succeeded' });
  throwsCode(() => validatePlanDelta(projection(), delta([{ expectedRevision: 1, task: replacementSuccess }])), 'planner_task_state_invalid');
});

test('schema is strict and declares the same versioned record families', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'delivery-v1.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(schema.oneOf.length, 9);
  assert.equal(schema.definitions.planDelta.additionalProperties, false);
  assert.ok(schema.definitions.planDelta.required.includes('expectedAuthorityRevision'));
  assert.ok(schema.definitions.plannerTask.allOf.some((part) => part.properties?.state?.enum.join(',') === 'draft,queued,blocked'));
  assert.deepEqual(schema.definitions.plannerPublicationAuthority.properties.state.enum, ['denied', 'unknown']);
  for (const kind of ['objective', 'task', 'dependency', 'attempt', 'claim', 'event', 'candidate', 'receipt']) {
    const definition = schema.definitions[kind];
    assert.equal(definition.type, 'object');
    assert.equal(definition.additionalProperties, false);
    assert.ok(definition.required.includes('schemaVersion'));
  }
});

test('draft-07 schema and JavaScript agree on all task path arrays', () => {
  const Ajv = require('ajv');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'delivery-v1.schema.json'), 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);
  const pathFields = [
    ['productWritePaths', (record, value) => ({ ...record, productWritePaths: [value] })],
    ['readScope.paths', (record, value) => ({ ...record, readScope: { kind: 'known', paths: [value] } })],
    ['scratchWriteRoots', (record, value) => ({ ...record, scratchWriteRoots: [value] })],
  ];
  const unsafePaths = [
    ['src/with\ttab', 'path_unsafe'], ['src/with\nline-break', 'path_unsafe'], ['src/with\rcarriage-return', 'path_unsafe'],
    ['src/with\x00nul', 'json_string_invalid'], ['src/with\x01control', 'json_string_invalid'], ['src/with\x7fdel', 'json_string_invalid'],
    ['/absolute/path', 'path_unsafe'], ['C:/drive/path', 'path_unsafe'], ['src\\windows\\path', 'path_unsafe'],
    ['src/./path', 'path_unsafe'], ['src/../path', 'path_unsafe'], ['src//path', 'path_unsafe'], ['src/', 'path_unsafe'],
  ];
  for (const [field, withPath] of pathFields) {
    const valid = withPath(task('task-a'), 'src/module.js');
    const normalized = validateTask(valid);
    assert.equal(field === 'readScope.paths' ? normalized.readScope.paths[0] : normalized[field][0], 'src/module.js');
    assert.equal(validate(valid), true, `${field}: valid relative path`);
    for (const [unsafe, code] of unsafePaths) {
      const record = withPath(task('task-a'), unsafe);
      const path = field === 'readScope.paths' ? '$.readScope.paths[0]' : `$.${field}[0]`;
      throwsCode(() => validateTask(record), code, path);
      assert.equal(validate(record), false, `${field}: ${JSON.stringify(unsafe)}`);
    }
  }
});

test('validates task edge kind and project/objective identity on every reference', () => {
  throwsCode(() => validateDependency({ schemaVersion: VERSION, ...dep('task-a', 'task-b', { kind: 'requires_acceptance' }) }), 'task_edge_kind_invalid', '$.kind');
  throwsCode(() => validateDependencyGraph([task('task-a', { dependencies: [dep('task-b', 'task-a', { objectiveId: 'objective-other' })] }), task('task-b')]), 'objective_reference_mismatch', '$.dependencies[0].objectiveId');
  throwsCode(() => validateAttempt({ ...base, attemptId: 'attempt-a', taskId: 'task-a', taskRevision: 0, attemptNo: 1, executionGeneration: 0, fencingToken: 1, contractDigest: null, selectedSettingsDigest: null, state: 'running' }), 'integer_invalid', '$.taskRevision');
});
