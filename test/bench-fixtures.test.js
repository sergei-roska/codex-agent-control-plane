'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTrialWorkspace } = require('../bench/make-trial-workspace');

const BENCH = path.join(__dirname, '..', 'bench');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function grade(id, finalText, workspace, disposition) {
  counter += 1;
  const finalPath = path.join(tmp, `${id}-${counter}.txt`);
  fs.writeFileSync(finalPath, finalText);
  const args = [path.join(BENCH, 'graders', `${id}.js`), '--final', finalPath, '--workspace', workspace];
  if (disposition) args.push('--disposition', disposition);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: res.status, out: JSON.parse(res.stdout) };
}

test('make-trial-workspace yields a clean repo with one commit and no grader files', () => {
  const t = makeTrialWorkspace('f2-repair');
  const git = (...a) => spawnSync('git', ['-C', t.workspace, ...a], { encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(git('status', '--porcelain'), '');
  assert.strictEqual(git('rev-list', '--count', 'HEAD'), '1');
  assert.strictEqual(git('rev-parse', 'HEAD'), t.commit);
  assert.ok(!fs.existsSync(path.join(t.workspace, 'REFERENCE_FIX.patch')));
  assert.ok(!fs.existsSync(path.join(t.workspace, 'GOAL.txt')));
  fs.rmSync(t.workspace, { recursive: true, force: true });
});

test('F1 grader passes a known-good answer and fails a wrong one', () => {
  const t = makeTrialWorkspace('f1');
  const good = 'Defined at config/retry.js:4. Callers: src/http-client.js, src/queue-worker.js, src/sync-job.js.';
  const ok = grade('f1', good, t.workspace);
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(ok.out.passed, true);
  const wrong = grade('f1', 'config/retry.js:9 and src/http-client.js only', t.workspace);
  assert.strictEqual(wrong.code, 1);
  assert.strictEqual(wrong.out.passed, false);
  assert.ok(wrong.out.reasons.length >= 3);
  fs.rmSync(t.workspace, { recursive: true, force: true });
});

test('F2 fails before the reference fix, passes after, and grader checks scope', () => {
  const t = makeTrialWorkspace('f2');
  // The outer runner sets NODE_TEST_CONTEXT, which would make the inner run report as a subtest.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const npmTest = () => spawnSync('npm', ['test'], { cwd: t.workspace, encoding: 'utf8', env });
  const before = npmTest();
  assert.notStrictEqual(before.status, 0);
  assert.match(before.stdout + before.stderr, /applyDiscount takes a whole-number percentage off/);

  const patch = path.join(BENCH, 'fixtures', 'f2-repair', 'REFERENCE_FIX.patch');
  const applied = spawnSync('git', ['-C', t.workspace, 'apply', patch], { encoding: 'utf8' });
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.strictEqual(npmTest().status, 0);

  assert.strictEqual(grade('f2', 'done', t.workspace, 'accepted').code, 0);
  assert.strictEqual(grade('f2', 'done', t.workspace, 'rejected').code, 1);

  fs.writeFileSync(path.join(t.workspace, 'extra.txt'), 'x');
  const extra = grade('f2', 'done', t.workspace, 'accepted');
  assert.strictEqual(extra.code, 1);
  assert.match(extra.out.reasons.join(' '), /extra\.txt/);
  fs.rmSync(t.workspace, { recursive: true, force: true });
});

test('F3 emits about EMIT_LOG_MB with exactly one E4711 line and the grader checks it', () => {
  const script = path.join(BENCH, 'fixtures', 'f3-large-output', 'scripts', 'emit-log.js');
  const res = spawnSync(process.execPath, [script], {
    env: { ...process.env, EMIT_LOG_MB: '1' },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.strictEqual(res.status, 0);
  assert.ok(Math.abs(res.stdout.length - 1024 * 1024) < 1024, `size ${res.stdout.length}`);
  const text = res.stdout.toString('utf8');
  assert.strictEqual(text.split('\n').filter((l) => l.includes('ERROR E4711')).length, 1);
  assert.strictEqual(text.split('E4711').length - 1, 1);

  assert.strictEqual(grade('f3', 'The error code is E4711.', tmp).code, 0);
  assert.strictEqual(grade('f3', 'I could not find it.', tmp).code, 1);
});
