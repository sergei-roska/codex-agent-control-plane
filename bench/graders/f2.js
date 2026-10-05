'use strict';

const { execFileSync } = require('node:child_process');
const { run } = require('./common');

function lines(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

run('F2', ({ workspace, disposition }) => {
  const reasons = [];
  if (disposition !== 'accepted') reasons.push(`disposition is ${disposition || 'missing'}, expected accepted`);
  const changed = new Set([
    ...lines(workspace, ['diff', '--name-only', 'HEAD']),
    ...lines(workspace, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const list = [...changed].sort();
  if (list.length !== 1 || list[0] !== 'src/price.js') {
    reasons.push(`changed files are [${list.join(', ')}], expected exactly [src/price.js]`);
  }
  return reasons;
});
