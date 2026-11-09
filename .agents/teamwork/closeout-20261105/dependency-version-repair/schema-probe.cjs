'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { ConcurrentDeliveryEngine } = require(path.resolve('src/concurrent-delivery-engine'));
const { validatePlanDelta } = require(path.resolve('src/delivery-contracts'));
const raw = JSON.parse(fs.readFileSync(path.resolve('.agents/teamwork/closeout-20261105/qualification/second-native-planner-output.json')));
const corrected = structuredClone(raw);
corrected.delta.dependencies = corrected.delta.dependencies.map(dependency => ({ schemaVersion: 'delivery/v1', ...dependency }));
const first = raw.delta.tasks[0].task;
const projection = { projectId: first.projectId, objectiveId: first.objectiveId,
  planRevision: 0, goalRevision: 1, authorityRevision: 1, controlRevision: 1, tasks: [], checkpoints: [] };
assert.throws(() => validatePlanDelta(projection, raw.delta), error => error.code === 'field_required' && error.path === '$.schemaVersion');
assert.equal(validatePlanDelta(projection, corrected.delta).dependencies.length, 5);
const original = ConcurrentDeliveryEngine.prototype.plannerOutputSchema;
let checked = 0;
ConcurrentDeliveryEngine.prototype.plannerOutputSchema = function (...args) {
  const schema = original.apply(this, args);
  const validate = new Ajv({strict: false}).compile(schema);
  assert.equal(validate(raw), false, 'unversioned standalone records must fail actual native output schema');
  assert.equal(validate(corrected), true, JSON.stringify(validate.errors));
  checked++;
  return schema;
};
process.on('exit', () => { if (checked) console.log('Independent raw/corrected native schema checks: ' + checked); });
