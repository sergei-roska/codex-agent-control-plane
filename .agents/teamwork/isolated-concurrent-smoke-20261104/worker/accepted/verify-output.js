'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.readFileSync('output.txt', 'utf8'), 'concurrent-smoke-ok\n');
process.stdout.write('PASS exact synthetic output\n');
