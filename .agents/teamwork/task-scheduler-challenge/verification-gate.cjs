'use strict';
const assert = require('node:assert/strict');
const { resourceConflict, isCriticalReview } = require('../../../src/task-resource-policy');
const task = (taskId, role, kind, writes, reads) => ({ taskId, role, kind, productWritePaths: writes,
  readScope: { kind: 'known', paths: reads }, dependencies: [], resourceClaims: [] });
const live = [{ claim: { state: 'active' }, attempt: { state: 'running' },
  task: task('writer', 'engineer', 'implementation', ['src/a.js'], []) }];
const candidate = task('verifier', 'verifier', 'verification', [], ['test/b.js']);
const actual = resourceConflict(candidate, live, { writerMode: 'shared' });
console.log(JSON.stringify({ critical: isCriticalReview(candidate), actual }));
assert.equal(actual.eligible, false, 'shared-tree verification must wait for live writer absent frozen proof');
