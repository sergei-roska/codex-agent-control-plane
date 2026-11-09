'use strict';

const assert = require('node:assert/strict');
const { formatLabel } = require('./format-label');
const { sumPositive } = require('./sum-positive');
const { report } = require('./report');

assert.equal(formatLabel('  north star  '), 'NORTH STAR');
assert.equal(formatLabel('MiXeD'), 'MIXED');
assert.equal(formatLabel('   '), '');
assert.throws(() => formatLabel(null), TypeError);
assert.throws(() => formatLabel(3), TypeError);

const values = [4, -2, 0, 1.5, Infinity, -Infinity, NaN, '8', null];
const before = values.slice();
assert.equal(sumPositive(values), 5.5);
assert.deepEqual(values, before);
assert.equal(sumPositive([]), 0);
assert.throws(() => sumPositive(null), TypeError);
assert.throws(() => sumPositive({ length: 0 }), TypeError);

assert.deepEqual(report('  north star  ', [4, -2, 1.5, NaN]), { label: 'NORTH STAR', total: 5.5 });
assert.throws(() => report(false, []), TypeError);
assert.throws(() => report('ok', null), TypeError);

process.stdout.write('PASS product contract\n');
