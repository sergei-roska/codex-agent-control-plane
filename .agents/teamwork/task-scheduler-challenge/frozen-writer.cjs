'use strict';
const assert = require('node:assert/strict');
const { resourceConflict } = require('../../../src/task-resource-policy');
const task = (taskId, role, kind, writes) => ({ taskId, role, kind, productWritePaths: writes,
  readScope: { kind: 'known', paths: [] }, dependencies: [], resourceClaims: [] });
const live = [{ claim: { state: 'active' }, attempt: { state: 'running' },
  task: task('writer', 'engineer', 'implementation', ['src/a.js']) }];
const candidate = task('review-writer', 'auditor', 'review', ['src/a.js']);
const actual = resourceConflict(candidate, live, { writerMode: 'isolated', isFrozenReview: ({ task }) => task.taskId === 'review-writer' });
console.log(JSON.stringify({ candidateWrites: candidate.productWritePaths, liveWrites: live[0].task.productWritePaths, actual }));
assert.equal(actual.eligible, false, 'frozen review proof must not waive overlapping product writes');
