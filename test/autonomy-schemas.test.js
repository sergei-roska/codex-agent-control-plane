'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readJson(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  const text = fs.readFileSync(absolute, 'utf8');
  return JSON.parse(text);
}

const SCHEMA_FILES = [
  'schemas/autonomy-corpus-v1.schema.json',
  'schemas/autonomy-observation-v1.schema.json',
  'schemas/autonomy-baseline-v1.schema.json',
];

const FIXTURE_FILES = [
  'test/fixtures/autonomy/corpus-v1/corpus.json',
  'test/fixtures/autonomy/corpus-v1/observations.json',
  'test/fixtures/autonomy/corpus-v1/baseline.json',
  'test/fixtures/autonomy/corpus-v2/corpus.json',
  'test/fixtures/autonomy/corpus-v2/observations.json',
  'test/fixtures/autonomy/corpus-v2/baseline.json',
  'test/fixtures/autonomy/corpus-v3/corpus.json',
  'test/fixtures/autonomy/corpus-v3/observations.json',
  'test/fixtures/autonomy/corpus-v3/baseline.json',
];

function isObjectSchema(schema) {
  const type = schema.type;
  return type === 'object' || (Array.isArray(type) && type.includes('object'));
}

// Recursively verify every object schema is strict: additionalProperties:false,
// and `required` lists exactly the declared `properties` (no gaps, no extras).
function walk(schema, label) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return;

  if (isObjectSchema(schema)) {
    assert.equal(schema.additionalProperties, false, `${label}: additionalProperties must be false`);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${label}: required must be a non-empty array`);
    assert.ok(schema.properties && typeof schema.properties === 'object' && Object.keys(schema.properties).length > 0, `${label}: properties must be a non-empty object`);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${label}: required lists exactly the declared properties`,
    );
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' || key === 'definitions' || key === 'patternProperties') {
      for (const [name, sub] of Object.entries(value)) walk(sub, `${label}.${key}.${name}`);
    } else if (key === 'items') {
      if (Array.isArray(value)) value.forEach((s, i) => walk(s, `${label}.items[${i}]`));
      else walk(value, `${label}.items`);
    } else if (key === 'if' || key === 'then' || key === 'else') {
      walk(value, `${label}.${key}`);
    }
  }
}

test('each schema file parses as JSON with strict object shapes (recursive)', () => {
  for (const file of SCHEMA_FILES) {
    const schema = readJson(file); // throws if not valid JSON
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#', `${file} draft-07 $schema`);
    assert.equal(schema.type, 'object', `${file} top-level type is object`);
    walk(schema, file);
  }
});

test('each fixture file parses as JSON', () => {
  for (const file of FIXTURE_FILES) {
    const value = readJson(file); // throws if not valid JSON
    assert.equal(typeof value, 'object', `${file} parses to an object`);
    assert.ok(value !== null, `${file} is not null`);
  }
});

test('fixture observations carry the new strict fields (dataOrigin, identityNullReasons)', () => {
  const obs = readJson('test/fixtures/autonomy/corpus-v3/observations.json');
  assert.equal(obs.schemaVersion, 'autonomy-observation/v1');
  for (const o of obs.observations) {
    assert.ok(['illustrative', 'real'].includes(o.dataOrigin), `${o.observationId} dataOrigin`);
    assert.equal(typeof o.identityNullReasons, 'object', `${o.observationId} identityNullReasons`);
    for (const id of ['runId', 'taskId', 'assignmentId', 'attemptId', 'checkpointId', 'candidateId']) {
      const reason = o.identityNullReasons[id];
      if (o[id] === null) {
        assert.equal(typeof reason, 'string', `${o.observationId}.${id} null must have a non-empty reason`);
        assert.ok(reason.length > 0, `${o.observationId}.${id} reason non-empty`);
      } else {
        assert.equal(reason, null, `${o.observationId}.${id} populated must have null reason`);
      }
    }
  }
});
