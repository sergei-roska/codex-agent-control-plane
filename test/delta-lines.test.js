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
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].path, rows[0].addedLines, rows[0].removedLines], ['src/a.js', 2, 1]);
  assert.ok(Number.isInteger(rows[0].bytes) && rows[0].bytes > 0);
});

test('a tracked path the numstat output does not report is unknown, never zero', async (t) => {
  const dir = makeRepo(t);
  assert.equal(await countChangedLines({ workspace: dir, paths: ['src/a.js'] }), null);
});

test('deleted file counts its removed lines', async (t) => {
  const dir = makeRepo(t);
  fs.rmSync(path.join(dir, 'src', 'gone.js'));
  const rows = await countChangedLines({ workspace: dir, paths: ['src/gone.js'] });
  assert.deepEqual(rows.map((row) => [row.path, row.addedLines, row.removedLines]), [['src/gone.js', 0, 3]]);
});

test('untracked new file counts newline-terminated lines', async (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, 'src', 'new.js'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\nthree\nfour\nfive\n');
  const rows = await countChangedLines({ workspace: dir, paths: ['src/new.js', 'src/a.js'] });
  assert.deepEqual(rows.map((row) => [row.path, row.addedLines, row.removedLines]), [['src/new.js', 3, 0], ['src/a.js', 1, 0]]);
  assert.equal(rows[0].bytes, 6);
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
  const runGit = async (argv) => {
    seen.push(argv);
    if (argv.includes('ls-files')) return 'src/a.js\0';
    if (argv.includes('--numstat')) return '1\t0\tsrc/a.js\0';
    return '';
  };
  const rows = await countChangedLines({ workspace: dir, paths: ['src/a.js'], runGit });
  assert.deepEqual(rows, [{ path: 'src/a.js', addedLines: 1, removedLines: 0, bytes: 0 }]);
  assert.deepEqual(seen[0], ['--literal-pathspecs', 'ls-files', '-z', '--', 'src/a.js']);
  assert.deepEqual(seen[1], ['--literal-pathspecs', 'diff', '--numstat', '-z', '--no-renames', '--relative', 'HEAD', '--', 'src/a.js']);
});

test('unusual names are counted literally: non-ASCII, glob characters, leading colon', async (t) => {
  const dir = makeRepo(t);
  const names = ['caf\u00e9-\u6587.txt', 'a[1].txt', ':odd.txt', 'sp ace\ttab.txt'];
  names.forEach((name) => fs.writeFileSync(path.join(dir, name), 'x\n'));
  vcs(dir, 'add', '-A');
  vcs(dir, 'commit', '-q', '-m', 'names');
  names.forEach((name) => fs.writeFileSync(path.join(dir, name), 'y\n'.repeat(500)));
  const rows = await countChangedLines({ workspace: dir, paths: names });
  assert.ok(rows, 'counted');
  rows.forEach((row) => {
    assert.equal(row.addedLines, 500, row.path);
    assert.equal(row.removedLines, 1, row.path);
    assert.ok(row.bytes > 1000, row.path);
  });
});

test('a changed path missing from the numstat output is unknown', async (t) => {
  const dir = makeRepo(t);
  const runGit = async (argv) => {
    if (argv.includes('ls-files')) return 'src/a.js\0src/gone.js\0';
    if (argv.includes('--numstat')) return '1\t0\tsrc/a.js\0';
    return '';
  };
  assert.equal(await countChangedLines({ workspace: dir, paths: ['src/a.js', 'src/gone.js'], runGit }), null);
});

test('a mode-only change is flagged and a content change reports its patch bytes', async (t) => {
  const dir = makeRepo(t);
  fs.chmodSync(path.join(dir, 'src', 'a.js'), 0o755);
  const rows = await countChangedLines({ workspace: dir, paths: ['src/a.js'] });
  assert.equal(rows[0].modeChanged, true);
  assert.equal(rows[0].addedLines + rows[0].removedLines, 0);
  fs.chmodSync(path.join(dir, 'src', 'a.js'), 0o644);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), `${'z'.repeat(100)}\n`.repeat(1000));
  const big = await countChangedLines({ workspace: dir, paths: ['src/a.js'] });
  assert.equal(big[0].modeChanged, undefined);
  assert.ok(big[0].bytes > 100000);
});
