'use strict';
const { validatePlanDelta, validateTask, DeliveryContractError } = require('../../../src/delivery-contracts');
const Ajv = require('ajv');
const schema = require('../../../schemas/delivery-v1.schema.json');
const ajv = new Ajv({ strict: false });
const check = ajv.compile(schema);
const base = { schemaVersion: 'delivery/v1', projectId: 'p', objectiveId: 'o' };
function task(id, extra = {}) { return { ...base, taskId: id, revision: 1, role: 'engineer', kind: 'implementation', objective: 'work', priority: 0, dependencies: [], productWritePaths: ['src/a'], readScope: { kind: 'known', paths: [] }, scratchWriteRoots: ['tmp/a'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued', ...extra }; }
function projection(tasks = [task('a')], checkpoints = []) { return { projectId: 'p', objectiveId: 'o', planRevision: 1, goalRevision: 1, authorityRevision: 1, controlRevision: 1, tasks, checkpoints }; }
function delta(tasks = [], dependencies = []) { return { schemaVersion: 'delivery/v1', expectedPlanRevision: 1, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 2, tasks, dependencies }; }
function result(name, fn) { try { const value = fn(); console.log(JSON.stringify({ name, accepted: true, value })); } catch (e) { console.log(JSON.stringify({ name, accepted: false, error: e.name, code: e.code, path: e.path, message: e.message })); } }
result('malformed-checkpoints-object', () => validatePlanDelta(projection(undefined, {}), delta()));
result('malformed-checkpoints-string', () => validatePlanDelta(projection(undefined, 'bad'), delta()));
result('replacement-forged-supersedes', () => validatePlanDelta(projection([task('a'), task('b')]), delta([{ expectedRevision: 1, task: task('b', { revision: 2, supersedesTaskId: 'a' }) }])));
result('replacement-supersedes-active', () => validatePlanDelta(projection([task('a', { state: 'running' }), task('b')]), delta([{ expectedRevision: 1, task: task('b', { revision: 2, supersedesTaskId: 'a' }) }])));
result('replacement-supersedes-missing', () => validatePlanDelta(projection([task('b')]), delta([{ expectedRevision: 1, task: task('b', { revision: 2, supersedesTaskId: 'missing' }) }])));
result('task-double-slash-validator', () => validateTask(task('a', { productWritePaths: ['src//x'] })));
result('task-double-slash-schema', () => ({ valid: check(task('a', { productWritePaths: ['src//x'] })), errors: check.errors }));
result('task-empty-objective-validator', () => validateTask(task('a', { objective: 'x'.repeat(8001) })));
result('task-empty-objective-schema', () => ({ valid: check(task('a', { objective: 'x'.repeat(8001) })), errors: check.errors }));
const edge = (predecessorId, successorTaskId) => ({ ...base, predecessorType: 'task', predecessorId, successorTaskId, kind: 'requires_output' });
result('standalone-edge-missing-successor', () => validatePlanDelta(projection([task('a')]), delta([], [edge('a', 'missing')])));
result('standalone-edge-duplicate-valid-successor', () => validatePlanDelta(projection([task('a')]), delta([{ task: task('b') }], [edge('a', 'b'), edge('a', 'b')])));
result('standalone-edge-duplicate-missing-successor', () => validatePlanDelta(projection([task('a')]), delta([], [edge('a', 'missing'), edge('a', 'missing')])));
result('lineage-preserved-existing-replacement', () => validatePlanDelta(projection([task('a', { state: 'superseded' }), task('b', { supersedesTaskId: 'a' })]), delta([{ expectedRevision: 1, task: task('b', { revision: 2, supersedesTaskId: 'a' }) }])));
result('lineage-removal-existing-replacement', () => validatePlanDelta(projection([task('a', { state: 'superseded' }), task('b', { supersedesTaskId: 'a' })]), delta([{ expectedRevision: 1, task: task('b', { revision: 2 }) }])));
result('standalone-tuple-colon-ids', () => validatePlanDelta(projection([task('a'), task('a:task:b'), task('c'), task('b:task:c')]), delta([{ expectedRevision: 1, task: task('a', { revision: 2 }) }, { expectedRevision: 1, task: task('a:task:b', { revision: 2 }) }], [edge('c', 'a:task:b'), edge('b:task:c', 'a')])));
