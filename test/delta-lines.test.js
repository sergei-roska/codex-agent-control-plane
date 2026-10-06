'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { countChangedLines } = require('../src/delta-lines');

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

const vcs = (cwd, ...args) => execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8' }).trim();

function makeRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delta-lines-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  vcs(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\nthree\nfour\n');
  fs.writeFileSync(path.join(dir, 'src', 'gone.js'), 'x\ny\nz\n');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
  vcs(dir, 'add', '-A');
  vcs(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('tracked edit counts added and removed lines against HEAD', async (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\nTWO\nthree\nfour\nfive\n');
  const rows = await countChangedLines({ workspace: dir, paths: ['src/a.js'] });
  assert.deepEqual(rows, [{ path: 'src/a.js', addedLines: 2, removedLines: 1 }]);
});

test('a tracked path with no difference counts zero', async (t) => {
  const dir = makeRepo(t);
  assert.deepEqual(await countChangedLines({ workspace: dir, paths: ['src/a.js'] }), [{ path: 'src/a.js', addedLines: 0, removedLines: 0 }]);
});

test('deleted file counts its removed lines', async (t) => {
  const dir = makeRepo(t);
  fs.rmSync(path.join(dir, 'src', 'gone.js'));
  assert.deepEqual(await countChangedLines({ workspace: dir, paths: ['src/gone.js'] }), [{ path: 'src/gone.js', addedLines: 0, removedLines: 3 }]);
});

test('untracked new file counts newline-terminated lines', async (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'src', 'new.js'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\nthree\nfour\nfive\n');
  const rows = await countChangedLines({ workspace: dir, paths: ['src/new.js', 'src/a.js'] });
  assert.deepEqual(rows, [
    { path: 'src/new.js', addedLines: 3, removedLines: 0 },
    { path: 'src/a.js', addedLines: 1, removedLines: 0 },
  ]);
});

test('unknown counts return null: binary, oversized or missing untracked file, unsafe path', async (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 1, 2]));
  assert.equal(await countChangedLines({ workspace: dir, paths: ['bin.dat'] }), null);
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x\n'.repeat(600 * 1024));
  assert.equal(await countChangedLines({ workspace: dir, paths: ['big.txt'] }), null);
  assert.equal(await countChangedLines({ workspace: dir, paths: ['missing.txt'] }), null);
  assert.equal(await countChangedLines({ workspace: dir, paths: ['../etc/passwd'] }), null);
  assert.equal(await countChangedLines({ workspace: dir, paths: ['--stat'] }), null);
  assert.equal(await countChangedLines({ workspace: dir, paths: 'src/a.js' }), null);
});

test('an empty path list is an empty result; git failure returns null', async (t) => {
  const dir = makeRepo(t);
  assert.deepEqual(await countChangedLines({ workspace: dir, paths: [] }), []);
  const notRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delta-lines-plain-')));
  t.after(() => fs.rmSync(notRepo, { recursive: true, force: true }));
  assert.equal(await countChangedLines({ workspace: notRepo, paths: ['a.txt'] }), null);
  const failing = async () => { throw new Error('git exploded'); };
  assert.equal(await countChangedLines({ workspace: dir, paths: ['src/a.js'], runGit: failing }), null);
});

test('git runs with a fixed argv array and no shell metacharacter expansion', async (t) => {
  const dir = makeRepo(t);
  const seen = [];
  const runGit = async (argv) => { seen.push(argv); return argv[0] === 'ls-files' ? 'src/a.js\0' : ''; };
  await countChangedLines({ workspace: dir, paths: ['src/a.js'], runGit });
  assert.deepEqual(seen[0], ['ls-files', '-z', '--', 'src/a.js']);
  assert.deepEqual(seen[1], ['diff', '--numstat', '--no-renames', '--relative', 'HEAD', '--', 'src/a.js']);
});
