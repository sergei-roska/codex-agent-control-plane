'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { takeSnapshot, diffSnapshots } = require('../src/workspace-snapshot');

// All repositories here are throwaway temp directories.
function sh(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-'));
  sh(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'other\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function delta(dir, mutate) {
  const before = takeSnapshot(dir);
  mutate();
  return diffSnapshots(before, takeSnapshot(dir), dir);
}

test('snapshot records head, dirty entries with content hashes and a stable fingerprint', () => {
  const dir = makeRepo();
  try {
    const clean = takeSnapshot(dir);
    assert.equal(clean.kind, 'git');
    assert.match(clean.head, /^[0-9a-f]{40}$/);
    assert.deepEqual(clean.entries, []);
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two\n');
    const dirty = takeSnapshot(dir);
    assert.equal(dirty.entries.length, 1);
    assert.equal(dirty.entries[0].path, 'tracked.txt');
    assert.match(dirty.entries[0].sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(dirty.fingerprint, clean.fingerprint);
    assert.equal(takeSnapshot(dir).fingerprint, dirty.fingerprint);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('snapshot status does not refresh the shared physical index', () => {
  const dir = makeRepo();
  try {
    const tracked = path.join(dir, 'tracked.txt');
    fs.utimesSync(tracked, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const indexPath = path.join(dir, '.git', 'index');
    const before = fs.readFileSync(indexPath);
    const snapshot = takeSnapshot(dir);
    assert.equal(snapshot.kind, 'git');
    assert.deepEqual(snapshot.entries, []);
    assert.ok(fs.readFileSync(indexPath).equals(before));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diff reports a modified tracked file', () => {
  const dir = makeRepo();
  try {
    const result = delta(dir, () => fs.writeFileSync(path.join(dir, 'tracked.txt'), 'changed\n'));
    assert.deepEqual(result, { known: true, headChanged: false, changedPaths: ['tracked.txt'] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diff reports a pre-existing dirty file changed again', () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n');
    const result = delta(dir, () => fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirtier\n'));
    assert.deepEqual(result.changedPaths, ['tracked.txt']);
    const same = delta(dir, () => {});
    assert.deepEqual(same, { known: true, headChanged: false, changedPaths: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diff reports new untracked files, including inside new directories', () => {
  const dir = makeRepo();
  try {
    const result = delta(dir, () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'new.txt'), 'new\n');
      fs.writeFileSync(path.join(dir, 'top.txt'), 'top\n');
    });
    assert.deepEqual(result.changedPaths, ['sub/new.txt', 'top.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diff reports a deleted file and a revert of a dirty file', () => {
  const dir = makeRepo();
  try {
    assert.deepEqual(delta(dir, () => fs.rmSync(path.join(dir, 'other.txt'))).changedPaths, ['other.txt']);
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n');
    assert.deepEqual(delta(dir, () => fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')).changedPaths, ['tracked.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diff reports a commit as a HEAD change with the committed paths', () => {
  const dir = makeRepo();
  try {
    const result = delta(dir, () => {
      fs.writeFileSync(path.join(dir, 'committed.txt'), 'c\n');
      sh(dir, 'add', 'committed.txt');
      sh(dir, 'commit', '-q', '-m', 'work');
    });
    assert.equal(result.known, true);
    assert.equal(result.headChanged, true);
    assert.deepEqual(result.changedPaths, ['committed.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('renames yield both paths and a repo without commits has a null head', () => {
  const dir = makeRepo();
  try {
    const result = delta(dir, () => sh(dir, 'mv', 'other.txt', 'moved.txt'));
    assert.deepEqual(result.changedPaths, ['moved.txt', 'other.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-empty-'));
  try {
    sh(empty, 'init', '-q');
    assert.equal(takeSnapshot(empty).head, null);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('a non-git directory is unavailable and its diff is unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-plain-'));
  try {
    const snapshot = takeSnapshot(dir);
    assert.equal(snapshot.kind, 'unavailable');
    assert.deepEqual(diffSnapshots(snapshot, snapshot, dir), { known: false, headChanged: false, changedPaths: [] });
    const repo = makeRepo();
    try {
      assert.equal(diffSnapshots(takeSnapshot(repo), snapshot, repo).known, false);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a workspace below the repository root reports workspace-relative paths and ignores edits outside it', () => {
  const dir = makeRepo();
  try {
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'in.txt'), 'in\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'sub');
    const before = takeSnapshot(sub);
    fs.writeFileSync(path.join(sub, 'in.txt'), 'changed\n');
    fs.writeFileSync(path.join(sub, 'new.txt'), 'new\n');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'outside\n');
    const after = takeSnapshot(sub);
    assert.deepEqual(after.entries.map((entry) => entry.path), ['in.txt', 'new.txt']);
    assert.ok(after.entries.every((entry) => entry.sha256));
    assert.deepEqual(diffSnapshots(before, after, sub).changedPaths, ['in.txt', 'new.txt']);

    const headBefore = takeSnapshot(sub);
    fs.writeFileSync(path.join(sub, 'c.txt'), 'c\n');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'other2\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'next');
    const headDelta = diffSnapshots(headBefore, takeSnapshot(sub), sub);
    assert.equal(headDelta.headChanged, true);
    assert.deepEqual(headDelta.changedPaths, ['c.txt', 'in.txt', 'new.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a first commit in an unborn repository reports the committed paths, including out-of-scope ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-first-'));
  try {
    sh(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, 'sub'));
    const sub = path.join(dir, 'sub');
    const beforeRoot = takeSnapshot(dir);
    const beforeSub = takeSnapshot(sub);
    assert.equal(beforeRoot.head, null);
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'x\n');
    fs.writeFileSync(path.join(sub, 'in.txt'), 'y\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'first');
    const root = diffSnapshots(beforeRoot, takeSnapshot(dir), dir);
    assert.equal(root.known, true);
    assert.equal(root.headChanged, true);
    assert.deepEqual(root.changedPaths, ['outside.txt', 'sub/in.txt']);
    assert.deepEqual(diffSnapshots(beforeSub, takeSnapshot(sub), sub).changedPaths, ['in.txt']);
    // A failing ls-tree makes the delta unknown.
    const broken = { ...takeSnapshot(dir), head: '0'.repeat(40) };
    assert.equal(diffSnapshots(beforeRoot, broken, dir).known, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HEAD going from born to unborn (checkout --orphan) is an unknown delta', () => {
  const dir = makeRepo();
  try {
    const result = delta(dir, () => sh(dir, 'checkout', '-q', '--orphan', 'fresh'));
    assert.equal(result.known, false);
    assert.equal(result.headChanged, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
