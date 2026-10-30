'use strict';

const VERSION = 'delivery/v1';
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 12000;
const MAX_ITEMS = 1000;
const ID_RE = /^[\x21-\x7e]{1,128}$/;
const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const TASK_STATES = ['draft', 'queued', 'ready', 'claimed', 'running', 'settling', 'succeeded', 'blocked', 'failed', 'canceled', 'superseded'];
const OBJECTIVE_STATES = ['planning', 'executing', 'draining', 'paused_owner', 'waiting_budget', 'waiting_owner', 'recovering', 'blocked_technical', 'validating', 'accepted', 'partial', 'canceled'];
const ATTEMPT_STATES = ['claimed', 'running', 'settling', 'succeeded', 'failed', 'canceled', 'unknown'];
const CLAIM_STATES = ['active', 'released', 'expired', 'fenced'];
const PLANNER_TASK_STATES = ['draft', 'queued', 'blocked'];
const PLANNER_PUBLICATION_STATES = ['denied', 'unknown'];
const EDGE_KINDS = ['requires_output', 'requires_acceptance', 'integration_after'];
const RECORDS = Object.freeze({
  objective: ['projectId', 'objectiveId', 'sessionId', 'engineVersion', 'goalRevision', 'requirementDigest', 'checksDigest', 'authorityRevision', 'controlRevision', 'disposition'],
  task: ['projectId', 'objectiveId', 'taskId', 'revision', 'role', 'kind', 'objective', 'priority', 'dependencies', 'productWritePaths', 'readScope', 'scratchWriteRoots', 'resourceClaims', 'publicationAuthority', 'state'],
  dependency: ['projectId', 'objectiveId', 'predecessorType', 'predecessorId', 'successorTaskId', 'kind'],
  attempt: ['projectId', 'objectiveId', 'attemptId', 'taskId', 'taskRevision', 'attemptNo', 'executionGeneration', 'fencingToken', 'contractDigest', 'selectedSettingsDigest', 'state'],
  claim: ['projectId', 'objectiveId', 'claimId', 'taskId', 'attemptId', 'ownerGeneration', 'fencingToken', 'role', 'capacityClass', 'leaseUntil', 'heartbeatAt', 'state'],
  event: ['projectId', 'sequence', 'eventId', 'eventType', 'objectRevision', 'payload', 'dedupeKey'],
  candidate: ['projectId', 'objectiveId', 'candidateId', 'integrationGeneration', 'snapshotRef', 'contentManifestDigest', 'status'],
  receipt: ['projectId', 'objectiveId', 'receiptId', 'checkpointId', 'candidateId', 'contextDigest', 'inputManifestDigest', 'checkPins', 'toolPins', 'profilePins', 'role', 'attemptId', 'outcome', 'evidenceRefs'],
});
const OPTIONAL = Object.freeze({
  objective: ['legacyRunId', 'createdAt', 'updatedAt'],
  task: ['checkpointId', 'baseCandidateId', 'supersedesTaskId', 'acceptance', 'checks', 'skillPins', 'toolPins', 'profilePins', 'evidenceRefs', 'retryPolicy', 'blockedReason', 'idempotencyKey', 'outputContract'],
  dependency: ['expectedOutput'],
  attempt: ['providerContextId', 'externalTaskId', 'threadId', 'laneId', 'capturedControls', 'outcome', 'effect', 'evidenceRefs', 'startedAt', 'settledAt'],
  claim: ['startedAt', 'releasedAt'],
  event: ['taskId', 'attemptId', 'candidateId', 'createdAt', 'evidenceRef'],
  candidate: ['parentCandidateId', 'sourceAttemptId', 'attestedDeltaRef', 'environmentDigest', 'createdAt'],
  receipt: ['createdAt'],
});

class DeliveryContractError extends Error {
  constructor(code, path, message) {
    super(message || `${code} at ${path}`);
    this.name = 'DeliveryContractError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) { throw new DeliveryContractError(code, path, message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function checkJson(value, path = '$', depth = 0, counter = { count: 0 }) {
  if (++counter.count > MAX_NODES) fail('json_too_complex', path);
  if (depth > MAX_DEPTH) fail('json_too_deep', path);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('json_string_invalid', path);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('number_not_finite', path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) fail('array_too_large', path);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('json_array_property_invalid', path);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('json_array_item_invalid', `${path}[${index}]`);
      checkJson(descriptor.value, `${path}[${index}]`, depth + 1, counter);
    }
    return;
  }
  if (!isObject(value)) fail('json_plain_object_required', path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('json_key_invalid', path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('json_property_invalid', `${path}.${key}`);
    if (key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('json_key_invalid', `${path}.${key}`);
    checkJson(descriptor.value, `${path}.${key}`, depth + 1, counter);
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validateEnvelope(value, kind, path = '$') {
  checkJson(value, path);
  if (!isObject(value)) fail('record_object_required', path);
  const allowed = new Set(['schemaVersion', ...RECORDS[kind], ...OPTIONAL[kind]]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('field_unknown', `${path}.${key}`);
  for (const key of ['schemaVersion', ...RECORDS[kind]]) if (!Object.hasOwn(value, key)) fail('field_required', `${path}.${key}`);
  if (value.schemaVersion !== VERSION) fail('schema_version_unsupported', `${path}.schemaVersion`);
  return value;
}
function string(value, path, { min = 1, max = 4000 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail('string_invalid', path);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('string_control_character', path);
  return value;
}
function id(value, path) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail('id_invalid', path);
  return value;
}
function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('integer_invalid', path);
  return value;
}
function enumValue(value, values, path) {
  if (!values.includes(value)) fail('enum_invalid', path);
  return value;
}
function nullableString(value, path, opts) { if (value !== null) string(value, path, opts); }
function pin(value, path) {
  if (value === null) return;
  string(value, path, { max: 256 });
}
function digest(value, path) {
  if (value === null) return;
  string(value, path, { max: 72 });
  if (!DIGEST_RE.test(value)) fail('digest_invalid', path);
}
function pinArray(value, path) {
  if (!Array.isArray(value) || value.length > 100) fail('array_invalid', path);
  value.forEach((item, i) => pin(item, `${path}[${i}]`));
}
function safeRelativePath(value, path) {
  if (typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value)) fail('path_unsafe', path);
  string(value, path, { max: 500 });
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) fail('path_unsafe', path);
  return value;
}
function pathArray(value, path) {
  if (!Array.isArray(value) || value.length > 500) fail('array_invalid', path);
  const seen = new Set();
  value.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    safeRelativePath(item, itemPath);
    if (seen.has(item)) fail('path_duplicate', itemPath);
    seen.add(item);
  });
}
function validateReadScope(value, path) {
  if (!isObject(value)) fail('read_scope_invalid', path);
  for (const key of Object.keys(value)) if (!['kind', 'paths', 'reason'].includes(key)) fail('field_unknown', `${path}.${key}`);
  enumValue(value.kind, ['known', 'unknown'], `${path}.kind`);
  if (value.kind === 'known') {
    if (!Array.isArray(value.paths)) fail('field_required', `${path}.paths`);
    pathArray(value.paths, `${path}.paths`);
    if (Object.hasOwn(value, 'reason') && value.reason !== null) fail('field_forbidden', `${path}.reason`);
  } else {
    if (value.paths !== null) fail('unknown_read_scope_must_be_null', `${path}.paths`);
    if (!Object.hasOwn(value, 'reason') || value.reason === null) fail('unknown_read_scope_reason_required', `${path}.reason`);
    string(value.reason, `${path}.reason`, { max: 500 });
  }
}
function validateDependency(dep, projectId, objectiveId, path) {
  if (!isObject(dep)) fail('dependency_object_required', path);
  for (const key of Object.keys(dep)) if (!['projectId', 'objectiveId', 'predecessorType', 'predecessorId', 'successorTaskId', 'kind', 'expectedOutput'].includes(key)) fail('field_unknown', `${path}.${key}`);
  for (const key of ['projectId', 'objectiveId', 'predecessorType', 'predecessorId', 'successorTaskId', 'kind']) if (!Object.hasOwn(dep, key)) fail('field_required', `${path}.${key}`);
  id(dep.projectId, `${path}.projectId`); id(dep.objectiveId, `${path}.objectiveId`);
  if (dep.projectId !== projectId) fail('project_reference_mismatch', `${path}.projectId`);
  if (dep.objectiveId !== objectiveId) fail('objective_reference_mismatch', `${path}.objectiveId`);
  enumValue(dep.predecessorType, ['task', 'checkpoint'], `${path}.predecessorType`);
  id(dep.predecessorId, `${path}.predecessorId`); id(dep.successorTaskId, `${path}.successorTaskId`);
  enumValue(dep.kind, EDGE_KINDS, `${path}.kind`);
  if (dep.predecessorType === 'checkpoint' && dep.kind !== 'requires_acceptance') fail('checkpoint_edge_kind_invalid', `${path}.kind`);
  if (dep.predecessorType === 'task' && dep.kind === 'requires_acceptance') fail('task_edge_kind_invalid', `${path}.kind`);
  if (Object.hasOwn(dep, 'expectedOutput')) pin(dep.expectedOutput, `${path}.expectedOutput`);
}
function validateRecord(kind, input) {
  if (!Object.hasOwn(RECORDS, kind)) fail('record_kind_invalid', '$.kind');
  const value = validateEnvelope(input, kind);
  const identityFields = { objective: ['projectId', 'objectiveId', 'sessionId'], task: ['projectId', 'objectiveId', 'taskId'], dependency: ['projectId', 'objectiveId', 'predecessorId', 'successorTaskId'], attempt: ['projectId', 'objectiveId', 'attemptId', 'taskId'], claim: ['projectId', 'objectiveId', 'claimId', 'taskId', 'attemptId'], event: ['projectId', 'eventId'], candidate: ['projectId', 'objectiveId', 'candidateId'], receipt: ['projectId', 'objectiveId', 'receiptId', 'checkpointId', 'candidateId', 'attemptId'] }[kind];
  for (const key of identityFields) id(value[key], `$.${key}`);
  for (const key of ['projectId', 'objectiveId', 'taskId', 'checkpointId', 'candidateId', 'attemptId', 'claimId', 'receiptId', 'eventId', 'sessionId']) if (Object.hasOwn(value, key) && value[key] !== null) id(value[key], `$.${key}`);
  switch (kind) {
    case 'objective':
      if (Object.hasOwn(value, 'legacyRunId')) nullableString(value.legacyRunId, '$.legacyRunId', { max: 128 });
      string(value.engineVersion, '$.engineVersion', { max: 64 });
      for (const key of ['goalRevision', 'authorityRevision', 'controlRevision']) integer(value[key], `$.${key}`);
      digest(value.requirementDigest, '$.requirementDigest'); digest(value.checksDigest, '$.checksDigest');
      enumValue(value.disposition, OBJECTIVE_STATES, '$.disposition');
      for (const key of ['createdAt', 'updatedAt']) if (Object.hasOwn(value, key) && value[key] !== null) integer(value[key], `$.${key}`);
      break;
    case 'task':
      integer(value.revision, '$.revision', { min: 1 }); string(value.role, '$.role', { max: 80 }); string(value.kind, '$.kind', { max: 80 }); string(value.objective, '$.objective', { max: 8000 }); integer(value.priority, '$.priority', { min: -100000, max: 100000 }); enumValue(value.state, TASK_STATES, '$.state');
      if (!Array.isArray(value.dependencies) || value.dependencies.length > 500) fail('array_invalid', '$.dependencies');
      value.dependencies.forEach((dep, i) => validateDependency(dep, value.projectId, value.objectiveId, `$.dependencies[${i}]`));
      pathArray(value.productWritePaths, '$.productWritePaths'); validateReadScope(value.readScope, '$.readScope'); pathArray(value.scratchWriteRoots, '$.scratchWriteRoots');
      if (!Array.isArray(value.resourceClaims) || value.resourceClaims.length > 100) fail('array_invalid', '$.resourceClaims');
      value.resourceClaims.forEach((item, i) => string(item, `$.resourceClaims[${i}]`, { max: 256 }));
      if (!isObject(value.publicationAuthority) || !['granted', 'denied', 'unknown'].includes(value.publicationAuthority.state)) fail('publication_authority_invalid', '$.publicationAuthority');
      for (const key of Object.keys(value.publicationAuthority)) if (!['state', 'reason', 'authorityRevision'].includes(key)) fail('field_unknown', `$.publicationAuthority.${key}`);
      if (Object.hasOwn(value.publicationAuthority, 'reason') && value.publicationAuthority.reason !== null) string(value.publicationAuthority.reason, '$.publicationAuthority.reason', { max: 500 });
      if (Object.hasOwn(value.publicationAuthority, 'authorityRevision') && value.publicationAuthority.authorityRevision !== null) integer(value.publicationAuthority.authorityRevision, '$.publicationAuthority.authorityRevision');
      for (const key of ['checkpointId', 'baseCandidateId', 'supersedesTaskId']) if (Object.hasOwn(value, key) && value[key] !== null) id(value[key], `$.${key}`);
      for (const key of ['acceptance', 'checks', 'evidenceRefs', 'retryPolicy', 'outputContract']) if (Object.hasOwn(value, key) && value[key] !== null) checkJson(value[key], `$.${key}`);
      for (const key of ['skillPins', 'toolPins', 'profilePins']) if (Object.hasOwn(value, key)) pinArray(value[key], `$.${key}`);
      for (const key of ['blockedReason', 'idempotencyKey']) if (Object.hasOwn(value, key)) nullableString(value[key], `$.${key}`, { max: 1000 });
      break;
    case 'dependency': { const { schemaVersion, ...dependency } = value; validateDependency(dependency, value.projectId, value.objectiveId, '$'); break; }
    case 'attempt':
      integer(value.taskRevision, '$.taskRevision', { min: 1 }); integer(value.attemptNo, '$.attemptNo', { min: 1 }); integer(value.executionGeneration, '$.executionGeneration'); integer(value.fencingToken, '$.fencingToken', { min: 1 }); digest(value.contractDigest, '$.contractDigest'); digest(value.selectedSettingsDigest, '$.selectedSettingsDigest'); enumValue(value.state, ATTEMPT_STATES, '$.state');
      for (const key of ['providerContextId', 'externalTaskId', 'threadId', 'laneId']) if (Object.hasOwn(value, key)) nullableString(value[key], `$.${key}`, { max: 256 });
      for (const key of ['capturedControls', 'outcome', 'effect', 'evidenceRefs']) if (Object.hasOwn(value, key) && value[key] !== null) checkJson(value[key], `$.${key}`);
      for (const key of ['startedAt', 'settledAt']) if (Object.hasOwn(value, key) && value[key] !== null) integer(value[key], `$.${key}`);
      break;
    case 'claim':
      integer(value.ownerGeneration, '$.ownerGeneration'); integer(value.fencingToken, '$.fencingToken', { min: 1 }); string(value.role, '$.role', { max: 80 }); string(value.capacityClass, '$.capacityClass', { max: 80 }); integer(value.leaseUntil, '$.leaseUntil'); integer(value.heartbeatAt, '$.heartbeatAt'); enumValue(value.state, CLAIM_STATES, '$.state');
      for (const key of ['startedAt', 'releasedAt']) if (Object.hasOwn(value, key) && value[key] !== null) integer(value[key], `$.${key}`);
      break;
    case 'event':
      integer(value.sequence, '$.sequence', { min: 1 }); string(value.eventType, '$.eventType', { max: 100 }); integer(value.objectRevision, '$.objectRevision'); checkJson(value.payload, '$.payload'); string(value.dedupeKey, '$.dedupeKey', { max: 256 });
      for (const key of ['taskId', 'attemptId', 'candidateId']) if (Object.hasOwn(value, key) && value[key] !== null) id(value[key], `$.${key}`);
      for (const key of ['createdAt']) if (Object.hasOwn(value, key) && value[key] !== null) integer(value[key], `$.${key}`);
      if (Object.hasOwn(value, 'evidenceRef')) nullableString(value.evidenceRef, '$.evidenceRef', { max: 1000 });
      break;
    case 'candidate':
      integer(value.integrationGeneration, '$.integrationGeneration'); digest(value.contentManifestDigest, '$.contentManifestDigest'); string(value.snapshotRef, '$.snapshotRef', { max: 1000 }); string(value.status, '$.status', { max: 64 });
      for (const key of ['parentCandidateId', 'sourceAttemptId']) if (Object.hasOwn(value, key) && value[key] !== null) id(value[key], `$.${key}`);
      for (const key of ['attestedDeltaRef']) if (Object.hasOwn(value, key)) nullableString(value[key], `$.${key}`, { max: 1000 });
      for (const key of ['environmentDigest']) if (Object.hasOwn(value, key)) digest(value[key], `$.${key}`);
      if (Object.hasOwn(value, 'createdAt') && value.createdAt !== null) integer(value.createdAt, '$.createdAt');
      break;
    case 'receipt':
      for (const key of ['checkpointId', 'candidateId', 'attemptId']) id(value[key], `$.${key}`);
      for (const key of ['contextDigest', 'inputManifestDigest']) digest(value[key], `$.${key}`);
      for (const key of ['checkPins', 'toolPins', 'profilePins']) pinArray(value[key], `$.${key}`);
      string(value.role, '$.role', { max: 80 }); enumValue(value.outcome, ['passed', 'failed', 'inconclusive', 'blocked'], '$.outcome');
      if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 100) fail('array_invalid', '$.evidenceRefs');
      value.evidenceRefs.forEach((item, i) => string(item, `$.evidenceRefs[${i}]`, { max: 1000 }));
      if (Object.hasOwn(value, 'createdAt') && value.createdAt !== null) integer(value.createdAt, '$.createdAt');
      break;
  }
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('json_encoding_invalid', '$'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES) fail('record_too_large', '$');
  return clone(value);
}
function validateDependencyGraph(tasks, checkpoints = []) {
  if (!Array.isArray(tasks)) fail('tasks_array_required', '$.tasks');
  if (!Array.isArray(checkpoints)) fail('checkpoints_array_required', '$.checkpoints');
  const byId = new Map();
  const checkpointMap = new Map();
  for (const [index, checkpoint] of checkpoints.entries()) {
    const path = `$.checkpoints[${index}]`;
    if (!isObject(checkpoint)) fail('checkpoint_object_required', path);
    const checkpointId = id(checkpoint.checkpointId, `${path}.checkpointId`);
    const checkpointProjectId = id(checkpoint.projectId, `${path}.projectId`);
    const checkpointObjectiveId = id(checkpoint.objectiveId, `${path}.objectiveId`);
    if (checkpointMap.has(checkpointId)) fail('checkpoint_id_duplicate', `${path}.checkpointId`);
    checkpointMap.set(checkpointId, { projectId: checkpointProjectId, objectiveId: checkpointObjectiveId });
  }
  let graphIdentity = null;
  tasks.forEach((task, i) => {
    const normalized = validateRecord('task', task);
    const path = `$.tasks[${i}]`;
    if (graphIdentity && (normalized.projectId !== graphIdentity.projectId || normalized.objectiveId !== graphIdentity.objectiveId)) fail('graph_identity_mismatch', `${path}.projectId`);
    graphIdentity ||= { projectId: normalized.projectId, objectiveId: normalized.objectiveId };
    if (byId.has(normalized.taskId)) fail('task_id_duplicate', `${path}.taskId`);
    byId.set(normalized.taskId, { task: normalized, path });
  });
  const edges = new Map([...byId.keys()].map((key) => [key, []]));
  for (const [taskId, entry] of byId) {
    const dependencyKeys = new Set();
    entry.task.dependencies.forEach((dep, i) => {
      const depPath = `${entry.path}.dependencies[${i}]`;
      const dependencyKey = `${dep.predecessorType}:${dep.predecessorId}:${dep.kind}`;
      if (dependencyKeys.has(dependencyKey)) fail('dependency_duplicate', depPath);
      dependencyKeys.add(dependencyKey);
      if (dep.projectId !== entry.task.projectId) fail('project_reference_mismatch', `${depPath}.projectId`);
      if (dep.objectiveId !== entry.task.objectiveId) fail('objective_reference_mismatch', `${depPath}.objectiveId`);
      if (dep.successorTaskId !== taskId) fail('dependency_successor_mismatch', `${depPath}.successorTaskId`);
      if (dep.predecessorType === 'task') {
        if (dep.predecessorId === taskId) fail('dependency_self_reference', `${depPath}.predecessorId`);
        if (!byId.has(dep.predecessorId)) fail('dependency_reference_missing', `${depPath}.predecessorId`);
        const predecessor = byId.get(dep.predecessorId).task;
        if (predecessor.projectId !== entry.task.projectId) fail('project_reference_mismatch', `${depPath}.projectId`);
        if (predecessor.objectiveId !== entry.task.objectiveId) fail('objective_reference_mismatch', `${depPath}.objectiveId`);
        edges.get(dep.predecessorId).push(taskId);
      } else {
        const checkpoint = checkpointMap.get(dep.predecessorId);
        if (!checkpoint) fail('checkpoint_reference_missing', `${depPath}.predecessorId`);
        if (checkpoint.projectId !== dep.projectId) fail('project_reference_mismatch', `${depPath}.projectId`);
        if (checkpoint.objectiveId !== dep.objectiveId) fail('objective_reference_mismatch', `${depPath}.objectiveId`);
      }
    });
  }
  const visiting = new Set(); const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) fail('dependency_cycle', `${byId.get(taskId).path}.dependencies`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const successor of edges.get(taskId)) visit(successor);
    visiting.delete(taskId); visited.add(taskId);
  }
  for (const taskId of byId.keys()) visit(taskId);
  return tasks.map((task) => clone(task));
}
function validatePlanDelta(currentProjection, input) {
  if (!isObject(currentProjection)) fail('projection_object_required', '$.currentProjection');
  id(currentProjection.projectId, '$.currentProjection.projectId');
  id(currentProjection.objectiveId, '$.currentProjection.objectiveId');
  checkJson(currentProjection, '$.currentProjection');
  if (Object.hasOwn(currentProjection, 'checkpoints') && !Array.isArray(currentProjection.checkpoints)) fail('checkpoints_array_required', '$.currentProjection.checkpoints');
  checkJson(input);
  if (!isObject(input)) fail('plan_object_required', '$');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_PLAN_BYTES) fail('plan_too_large', '$');
  const allowed = ['schemaVersion', 'expectedPlanRevision', 'expectedGoalRevision', 'expectedAuthorityRevision', 'expectedControlRevision', 'nextPlanRevision', 'tasks', 'dependencies'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail('field_unknown', `$.${key}`);
  for (const key of allowed) if (!Object.hasOwn(input, key)) fail('field_required', `$.${key}`);
  if (input.schemaVersion !== VERSION) fail('schema_version_unsupported', '$.schemaVersion');
  const revFields = ['expectedPlanRevision', 'expectedGoalRevision', 'expectedAuthorityRevision', 'expectedControlRevision'];
  const currentFields = ['planRevision', 'goalRevision', 'authorityRevision', 'controlRevision'];
  revFields.forEach((field, i) => {
    integer(input[field], `$.${field}`);
    if (!Number.isSafeInteger(currentProjection[currentFields[i]]) || input[field] !== currentProjection[currentFields[i]]) fail('plan_revision_stale', `$.${field}`);
  });
  integer(input.nextPlanRevision, '$.nextPlanRevision');
  if (input.nextPlanRevision !== input.expectedPlanRevision + 1) fail('plan_revision_step_invalid', '$.nextPlanRevision');
  if (!Array.isArray(currentProjection.tasks) || !Array.isArray(input.tasks) || input.tasks.length > 500) fail('tasks_array_required', '$.tasks');
  if (!Array.isArray(input.dependencies) || input.dependencies.length > 2000) fail('dependencies_array_required', '$.dependencies');
  const existing = new Map();
  currentProjection.tasks.forEach((task, i) => {
    const valid = validateRecord('task', task);
    if (valid.projectId !== currentProjection.projectId) fail('project_reference_mismatch', `$.currentProjection.tasks[${i}].projectId`);
    if (valid.objectiveId !== currentProjection.objectiveId) fail('objective_reference_mismatch', `$.currentProjection.tasks[${i}].objectiveId`);
    if (existing.has(valid.taskId)) fail('task_id_duplicate', `$.currentProjection.tasks[${i}].taskId`);
    existing.set(valid.taskId, valid);
  });
  const replacements = new Map();
  const normalizedTasks = input.tasks.map((entry, i) => {
    const path = `$.tasks[${i}]`;
    if (!isObject(entry) || !Object.hasOwn(entry, 'task')) fail('plan_task_change_invalid', path);
    for (const key of Object.keys(entry)) if (!['task', 'expectedRevision'].includes(key)) fail('field_unknown', `${path}.${key}`);
    const next = validateRecord('task', entry.task);
    if (next.projectId !== currentProjection.projectId) fail('project_reference_mismatch', `${path}.task.projectId`);
    if (next.objectiveId !== currentProjection.objectiveId) fail('objective_reference_mismatch', `${path}.task.objectiveId`);
    if (!PLANNER_TASK_STATES.includes(next.state)) fail('planner_task_state_invalid', `${path}.task.state`);
    if (!PLANNER_PUBLICATION_STATES.includes(next.publicationAuthority.state)) fail('planner_publication_authority_invalid', `${path}.task.publicationAuthority.state`);
    const previous = existing.get(next.taskId);
    if (!previous) {
      if (next.revision !== 1) fail('new_task_revision_invalid', `${path}.task.revision`);
      if (next.supersedesTaskId !== undefined && next.supersedesTaskId !== null) {
        const superseded = existing.get(next.supersedesTaskId);
        if (replacements.has(next.supersedesTaskId)) fail('task_change_duplicate', `${path}.task.supersedesTaskId`);
        if (!superseded) fail('superseded_task_missing', `${path}.task.supersedesTaskId`);
        integer(entry.expectedRevision, `${path}.expectedRevision`, { min: 1 });
        if (entry.expectedRevision !== superseded.revision) fail('task_revision_stale', `${path}.expectedRevision`);
        if (['claimed', 'running', 'settling'].includes(superseded.state)) fail('active_task_contract_immutable', `${path}.task.supersedesTaskId`);
        if (['succeeded', 'canceled', 'superseded'].includes(superseded.state)) fail('terminal_task_immutable', `${path}.task.supersedesTaskId`);
        if (superseded.projectId !== next.projectId || superseded.objectiveId !== next.objectiveId) fail('task_reference_mismatch', `${path}.task.supersedesTaskId`);
        replacements.set(superseded.taskId, { ...superseded, state: 'superseded' });
      } else if (Object.hasOwn(entry, 'expectedRevision')) fail('unexpected_expected_revision', `${path}.expectedRevision`);
    } else {
      integer(entry.expectedRevision, `${path}.expectedRevision`, { min: 1 });
      if (entry.expectedRevision !== previous.revision) fail('task_revision_stale', `${path}.expectedRevision`);
      if (['claimed', 'running', 'settling'].includes(previous.state)) fail('active_task_contract_immutable', `${path}.task`);
      if (['succeeded', 'canceled', 'superseded'].includes(previous.state)) fail('terminal_task_immutable', `${path}.task`);
      if (next.revision !== previous.revision + 1) fail('task_revision_step_invalid', `${path}.task.revision`);
      if (next.state !== 'queued' && next.state !== 'blocked') fail('replacement_task_state_invalid', `${path}.task.state`);
      if ((previous.supersedesTaskId ?? null) !== (next.supersedesTaskId ?? null)) fail('supersession_lineage_immutable', `${path}.task.supersedesTaskId`);
    }
    if (replacements.has(next.taskId)) fail('task_id_duplicate', `${path}.task.taskId`);
    replacements.set(next.taskId, next);
    return next;
  });
  const revisedExistingTaskIds = new Set(normalizedTasks.filter((task) => existing.has(task.taskId)).map((task) => task.taskId));
  const resulting = [...existing.values()].map((task) => replacements.get(task.taskId) || task).concat(normalizedTasks.filter((task) => !existing.has(task.taskId)));
  const dependencies = input.dependencies.map((dep, i) => validateRecord('dependency', dep));
  const resultingTaskIds = new Set(resulting.map((task) => task.taskId));
  const dependencyKeys = new Set();
  for (const [index, dep] of dependencies.entries()) {
    const path = `$.dependencies[${index}]`;
    if (dep.projectId !== currentProjection.projectId) fail('project_reference_mismatch', `${path}.projectId`);
    if (dep.objectiveId !== currentProjection.objectiveId) fail('objective_reference_mismatch', `${path}.objectiveId`);
    if (!resultingTaskIds.has(dep.successorTaskId)) fail('dependency_successor_missing', `${path}.successorTaskId`);
    const key = JSON.stringify([dep.successorTaskId, dep.predecessorType, dep.predecessorId, dep.kind]);
    if (dependencyKeys.has(key)) fail('dependency_duplicate', path);
    dependencyKeys.add(key);
    if (existing.has(dep.successorTaskId) && !revisedExistingTaskIds.has(dep.successorTaskId)) fail('dependency_change_requires_task_revision', '$.dependencies');
  }
  const overrides = new Map();
  for (const task of resulting) overrides.set(task.taskId, { ...task, dependencies: task.dependencies.filter((dep) => !dependencies.some((d) => d.successorTaskId === task.taskId && d.predecessorType === dep.predecessorType && d.predecessorId === dep.predecessorId && d.kind === dep.kind)).concat(dependencies.filter((dep) => dep.successorTaskId === task.taskId).map(({ schemaVersion, ...dep }) => dep)) });
  validateDependencyGraph([...overrides.values()], currentProjection.checkpoints === undefined ? [] : currentProjection.checkpoints);
  return clone({ ...input, tasks: normalizedTasks, dependencies });
}

module.exports = {
  VERSION, MAX_RECORD_BYTES, MAX_PLAN_BYTES, TASK_STATES, OBJECTIVE_STATES, ATTEMPT_STATES, CLAIM_STATES, EDGE_KINDS, PLANNER_TASK_STATES, PLANNER_PUBLICATION_STATES,
  DeliveryContractError, validateRecord, validateObjective: (value) => validateRecord('objective', value),
  validateTask: (value) => validateRecord('task', value), validateDependency: (value) => validateRecord('dependency', value),
  validateAttempt: (value) => validateRecord('attempt', value), validateClaim: (value) => validateRecord('claim', value),
  validateEvent: (value) => validateRecord('event', value), validateCandidate: (value) => validateRecord('candidate', value),
  validateReceipt: (value) => validateRecord('receipt', value), validateDependencyGraph, validatePlanDelta,
};
