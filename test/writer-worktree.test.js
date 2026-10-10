'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const wt = require('../src/writer-worktree');

// All repositories here are throwaway temp directories.
function sh(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRepo(files = {}) {
  const dir = fs.realpathSync(tmp('wt-repo-'));
  sh(dir, 'init', '-q');
  const all = { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b1\n', 'del.txt': 'gone\n', 'keep.txt': 'keep\n', ...files };
  for (const [rel, content] of Object.entries(all)) write(dir, rel, content);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

// path -> "mode:content" for every non-.git file (symlinks are listed by target).
function readTree(dir, rel = '') {
  const out = {};
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const r = path.join(rel, entry.name);
    const abs = path.join(dir, r);
    if (entry.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(abs)}`;
    else if (entry.isDirectory()) Object.assign(out, readTree(dir, r));
    else out[r] = `${(fs.statSync(abs).mode & 0o111) ? 'x' : '-'}:${fs.readFileSync(abs).toString('base64')}`;
  }
  return out;
}

function repoState(dir) {
  const gitDir = path.join(dir, '.git');
  let head = '';
  try { head = sh(dir, 'rev-parse', 'HEAD'); } catch (_) { head = 'unborn'; }
  return {
    index: fs.existsSync(path.join(gitDir, 'index')) ? fs.readFileSync(path.join(gitDir, 'index')).toString('base64') : null,
    head,
    refs: sh(dir, 'for-each-ref'),
    stash: sh(dir, 'stash', 'list'),
    config: fs.readFileSync(path.join(gitDir, 'config'), 'utf8'),
  };
}

function blob(dir, commit, rel) {
  return execFileSync('git', ['-C', dir, 'cat-file', 'blob', `${commit}:${rel}`]);
}

function laneDir() {
  return path.join(tmp('wt-lane-'), 'lane');
}

test('createBase captures modification, deletion, untracked; skips ignored', () => {
  const dir = makeRepo({ '.gitignore': 'ignored.log\n' });
  try {
    write(dir, 'a.txt', 'changed\n');
    fs.rmSync(path.join(dir, 'del.txt'));
    write(dir, 'new.txt', 'new\n');
    write(dir, 'ignored.log', 'noise\n');
    const { commit, tree } = wt.createBase(dir);
    assert.match(commit, /^[0-9a-f]{40}$/);
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.equal(blob(dir, commit, 'a.txt').toString(), 'changed\n');
    assert.equal(blob(dir, commit, 'new.txt').toString(), 'new\n');
    const names = sh(dir, 'ls-tree', '-r', '--name-only', commit).split('\n');
    assert.ok(!names.includes('del.txt'));
    assert.ok(!names.includes('ignored.log'));
    assert.ok(names.includes('keep.txt'));
    assert.equal(sh(dir, 'rev-parse', `${commit}^`).trim(), sh(dir, 'rev-parse', 'HEAD').trim());
  } finally { cleanup(dir); }
});

test('shared repo index, HEAD, refs, stash and config are untouched by every operation', () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    write(dir, 'a.txt', 'dirty\n');
    write(dir, 'untracked.txt', 'u\n');
    const before = repoState(dir);
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'b.txt', 'b-lane\n');
    const { patch } = wt.collectPatch({ lane: added.path, base: base.commit });
    assert.ok(patch.length > 0);
    assert.deepEqual(repoState(dir), before);
    // The patch is relative to the base, which already holds the dirty a.txt, so it applies as-is.
    assert.deepEqual(wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.deepEqual(repoState(dir), before);
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b-lane\n');
    wt.removeLane({ root: dir, lane: added.path });
    assert.deepEqual(repoState(dir), before);
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('two lanes from one base: binary file, delete and new file, both apply in sequence', () => {
  const dir = makeRepo({ 'img.bin': Buffer.from([0, 1, 2, 255, 0, 7]) });
  const l1 = laneDir();
  const l2 = laneDir();
  try {
    const original = readTree(dir);
    const base = wt.createBase(dir);
    const one = wt.addLane({ root: dir, base: base.commit, dir: l1 });
    const two = wt.addLane({ root: dir, base: base.commit, dir: l2 });
    const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
    write(one.workspacePath, 'a.txt', 'a1\nA2\na3\n');
    fs.writeFileSync(path.join(one.workspacePath, 'img.bin'), bytes);
    fs.rmSync(path.join(two.workspacePath, 'del.txt'));
    write(two.workspacePath, 'sub/new.txt', 'brand new\n');
    const p1 = wt.collectPatch({ lane: one.path, base: base.commit });
    const p2 = wt.collectPatch({ lane: two.path, base: base.commit });
    assert.deepEqual(p1.changes.map((c) => `${c.status}:${c.path}`).sort(), ['M:a.txt', 'M:img.bin']);
    assert.deepEqual(p2.changes.map((c) => `${c.status}:${c.path}`).sort(), ['A:sub/new.txt', 'D:del.txt']);
    assert.deepEqual(wt.applyPatch({ root: dir, patch: p1.patch }), { applied: true });
    assert.deepEqual(wt.applyPatch({ root: dir, patch: p2.patch }), { applied: true });
    const expected = { ...original };
    expected['a.txt'] = readTree(one.workspacePath)['a.txt'];
    expected['img.bin'] = `-:${bytes.toString('base64')}`;
    delete expected['del.txt'];
    expected[path.join('sub', 'new.txt')] = `-:${Buffer.from('brand new\n').toString('base64')}`;
    assert.deepEqual(readTree(dir), expected);
    wt.removeLane({ root: dir, lane: one.path });
    wt.removeLane({ root: dir, lane: two.path });
  } finally { cleanup(dir, path.dirname(l1), path.dirname(l2)); }
});

test('a lane edit of a file the shared tree changed meanwhile is a conflict and leaves the tree byte-identical', () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'a.txt', 'a1\nlane\na3\n');
    write(added.workspacePath, 'b.txt', 'b-lane\n');
    const { patch } = wt.collectPatch({ lane: added.path, base: base.commit });
    write(dir, 'a.txt', 'a1\nshared\na3\n');
    const before = readTree(dir);
    const state = repoState(dir);
    const result = wt.applyPatch({ root: dir, patch });
    assert.equal(result.applied, false);
    assert.equal(result.conflict, true);
    assert.deepEqual(result.paths, ['a.txt']);
    assert.match(result.message, /a\.txt/);
    assert.deepEqual(readTree(dir), before);
    assert.deepEqual(repoState(dir), state);
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('a new file that already exists in the shared tree is reported as a conflict path', () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'fresh.txt', 'lane\n');
    const { patch } = wt.collectPatch({ lane: added.path, base: base.commit });
    write(dir, 'fresh.txt', 'shared\n');
    const result = wt.applyPatch({ root: dir, patch });
    assert.equal(result.conflict, true);
    assert.deepEqual(result.paths, ['fresh.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'fresh.txt'), 'utf8'), 'shared\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('a patch applies when the shared tree differs from the base only in unrelated files', () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'a.txt', 'a1\nA2\na3\n');
    const { patch } = wt.collectPatch({ lane: added.path, base: base.commit });
    write(dir, 'keep.txt', 'someone else\n');
    write(dir, 'extra.txt', 'x\n');
    assert.deepEqual(wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a1\nA2\na3\n');
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'someone else\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('an empty patch applies without git', () => {
  assert.deepEqual(wt.applyPatch({ root: '/nonexistent-dir', patch: Buffer.alloc(0) }), { applied: true });
});

test('ignored .venv is symlinked into the lane and never shows up in collectPatch', () => {
  const dir = makeRepo({ '.gitignore': '.venv/\nnode_modules/\n', 'plain/x.txt': 'x\n' });
  const lane = laneDir();
  try {
    write(dir, '.venv/lib/mod.py', 'print(1)\n');
    const base = wt.createBase(dir);
    assert.ok(!sh(dir, 'ls-tree', '-r', '--name-only', base.commit).includes('.venv'));
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane, links: ['.venv', 'node_modules', 'plain'] });
    assert.deepEqual(added.linked, ['.venv']);
    const link = path.join(added.workspacePath, '.venv');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link), path.join(dir, '.venv'));
    assert.ok(fs.existsSync(path.join(link, 'lib', 'mod.py')));
    write(added.workspacePath, 'a.txt', 'a1\nA2\na3\n');
    const withLinks = wt.collectPatch({ lane: added.path, base: base.commit });
    assert.ok(withLinks.changes.some((c) => c.path === '.venv'), 'the symlink is visible without exclusion');
    const excluded = wt.collectPatch({ lane: added.path, base: base.commit, exclude: ['.venv'] });
    assert.deepEqual(excluded.changes, [{ status: 'M', path: 'a.txt' }]);
    assert.ok(!excluded.patch.toString().includes('.venv'));
    wt.removeLane({ root: dir, lane: added.path });
    assert.ok(fs.existsSync(path.join(dir, '.venv', 'lib', 'mod.py')), 'removing a lane never follows the link');
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('executable bit change and a file name with spaces round-trip', () => {
  const dir = makeRepo({ 'run.sh': '#!/bin/sh\n' });
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    fs.chmodSync(path.join(added.workspacePath, 'run.sh'), 0o755);
    write(added.workspacePath, 'dir with space/my file.txt', 'spaced\n');
    const { patch, changes } = wt.collectPatch({ lane: added.path, base: base.commit });
    assert.deepEqual(changes.map((c) => `${c.status}:${c.path}`).sort(), ['A:dir with space/my file.txt', 'M:run.sh']);
    assert.deepEqual(wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.ok(fs.statSync(path.join(dir, 'run.sh')).mode & 0o100);
    assert.equal(fs.readFileSync(path.join(dir, 'dir with space', 'my file.txt'), 'utf8'), 'spaced\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('an unborn HEAD repository works end to end', () => {
  const dir = fs.realpathSync(tmp('wt-unborn-'));
  const lane = laneDir();
  try {
    sh(dir, 'init', '-q');
    write(dir, 'a.txt', 'one\n');
    assert.deepEqual(wt.inspectRepo(dir), { ok: true, gitRoot: dir, prefix: '' });
    const base = wt.createBase(dir);
    assert.equal(sh(dir, 'rev-list', '--parents', '-n', '1', base.commit).trim(), base.commit);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'a.txt', 'two\n');
    write(added.workspacePath, 'b.txt', 'b\n');
    const { patch, changes } = wt.collectPatch({ lane: added.path, base: base.commit });
    assert.equal(changes.length, 2);
    assert.deepEqual(wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('a workspace in a subdirectory gets the right prefix and workspacePath', () => {
  const dir = makeRepo({ 'ws/inner.txt': 'inner\n', 'ws/.gitignore': '.venv/\n', 'top.txt': 'top\n' });
  const lane = laneDir();
  try {
    const root = path.join(dir, 'ws');
    write(root, '.venv/x', 'x\n');
    assert.deepEqual(wt.inspectRepo(root), { ok: true, gitRoot: dir, prefix: 'ws/' });
    const base = wt.createBase(root);
    const added = wt.addLane({ root, base: base.commit, dir: lane, links: ['.venv'] });
    assert.equal(added.workspacePath, path.join(added.path, 'ws'));
    assert.deepEqual(added.linked, ['.venv']);
    assert.ok(fs.lstatSync(path.join(added.workspacePath, '.venv')).isSymbolicLink());
    write(added.workspacePath, 'inner.txt', 'edited\n');
    write(added.path, 'top.txt', 'top edited\n');
    const { patch, changes } = wt.collectPatch({ lane: added.path, base: base.commit, exclude: ['ws/.venv'] });
    assert.deepEqual(changes.map((c) => c.path).sort(), ['top.txt', 'ws/inner.txt']);
    assert.deepEqual(wt.applyPatch({ root, patch }), { applied: true });
    assert.equal(fs.readFileSync(path.join(root, 'inner.txt'), 'utf8'), 'edited\n');
    assert.equal(fs.readFileSync(path.join(dir, 'top.txt'), 'utf8'), 'top edited\n');
    wt.removeLane({ root, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('removeLane after the directory was deleted does not throw; prune leaves only the main tree', () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    assert.equal(sh(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 2);
    fs.rmSync(added.path, { recursive: true, force: true });
    wt.removeLane({ root: dir, lane: added.path });
    wt.removeLane({ root: dir, lane: added.path });
    wt.pruneLanes(dir);
    const listed = sh(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
    assert.deepEqual(listed, [`worktree ${dir}`]);
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('inspectRepo rejects a non-git directory and a repo with submodules', () => {
  const plain = tmp('wt-plain-');
  const withGitlink = makeRepo();
  const withModules = makeRepo();
  try {
    const bad = wt.inspectRepo(plain);
    assert.equal(bad.ok, false);
    assert.ok(bad.reason);
    sh(withGitlink, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/sub`);
    sh(withGitlink, 'commit', '-q', '-m', 'gitlink');
    assert.deepEqual(wt.inspectRepo(withGitlink), { ok: false, reason: 'has_submodules' });
    write(withModules, '.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
    assert.deepEqual(wt.inspectRepo(withModules), { ok: false, reason: 'has_submodules' });
    assert.throws(() => wt.createBase(plain), (error) => error instanceof wt.WorktreeError && error.code === 'not_a_repo');
  } finally { cleanup(plain, withGitlink, withModules); }
});

test('timing: createBase + addLane + collectPatch + applyPatch on ~1000 files', () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    for (let i = 0; i < 1000; i += 1) write(dir, `src/d${i % 20}/file${i}.txt`, `content ${i}\n`.repeat(10));
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'many');
    for (let i = 0; i < 10; i += 1) write(dir, `src/d${i % 20}/file${i}.txt`, 'dirty\n');
    const t0 = Date.now();
    const base = wt.createBase(dir);
    const t1 = Date.now();
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    const t2 = Date.now();
    for (let i = 100; i < 105; i += 1) write(added.workspacePath, `src/d${i % 20}/file${i}.txt`, 'lane edit\n');
    const { patch, changes } = wt.collectPatch({ lane: added.path, base: base.commit });
    const t3 = Date.now();
    const result = wt.applyPatch({ root: dir, patch });
    const t4 = Date.now();
    assert.equal(changes.length, 5);
    assert.equal(result.applied, true);
    wt.removeLane({ root: dir, lane: added.path });
    console.log(`# timing ms: createBase=${t1 - t0} addLane=${t2 - t1} collectPatch=${t3 - t2} applyPatch=${t4 - t3} total=${t4 - t0}`);
  } finally { cleanup(dir, path.dirname(lane)); }
});
