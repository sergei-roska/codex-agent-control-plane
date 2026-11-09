'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync('docs/RUNTIME_DIAGNOSTIC.md', 'utf8'), '# Runtime diagnostic\n\nProject: Agent Harness\n');
console.log('Diagnostic content verified.');
