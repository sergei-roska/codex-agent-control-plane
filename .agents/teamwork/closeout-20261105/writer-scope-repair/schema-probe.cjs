'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Ajv = require('ajv');
const { ConcurrentDeliveryEngine } = require(path.resolve('src/concurrent-delivery-engine'));
const original = ConcurrentDeliveryEngine.prototype.plannerOutputSchema;
let variantsChecked = 0;
function sample(s) {
  if (s.enum) return s.enum[0];
  if (s.anyOf) return sample(s.anyOf[0]);
  if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties).map(([k,v]) => [k,sample(v)]));
  if (s.type === 'array') return Array.from({length:s.minItems || 0},()=>sample(s.items));
  if (s.type === 'integer') return 1;
  if (s.type === 'null') return null;
  return 'source.txt';
}
ConcurrentDeliveryEngine.prototype.plannerOutputSchema = function (...args) {
  const schema = original.apply(this,args);
  const changes = schema.properties.delta.anyOf.find(x=>x.type==='object').properties.tasks.items.anyOf;
  for (const change of changes) for (const variant of change.properties.task.anyOf) {
    const validate = new Ajv({strict:false}).compile(variant);
    const value = sample(variant);
    const writable = this.roleFor(value.role)?.sandbox !== 'read-only';
    value.productWritePaths = [];
    assert.equal(validate(value), !writable, JSON.stringify(validate.errors));
    value.productWritePaths = ['source.txt'];
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    variantsChecked++;
  }
  return schema;
};
process.on('exit',()=>{ if(variantsChecked) console.log('Independent Ajv role/scope variants checked: '+variantsChecked); });
