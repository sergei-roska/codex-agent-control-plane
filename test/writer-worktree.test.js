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

test('createBase captures modification, deletion, untracked; skips ignored', async () => {
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

test('shared repo index, HEAD, refs, stash and config are untouched by every operation', async () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    write(dir, 'a.txt', 'dirty\n');
    write(dir, 'untracked.txt', 'u\n');
    const before = repoState(dir);
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'b.txt', 'b-lane\n');
    const { patch } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    assert.ok(patch.length > 0);
    assert.deepEqual(repoState(dir), before);
    // The patch is relative to the base, which already holds the dirty a.txt, so it applies as-is.
    assert.deepEqual(await wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.deepEqual(repoState(dir), before);
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b-lane\n');
    wt.removeLane({ root: dir, lane: added.path });
    assert.deepEqual(repoState(dir), before);
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('two lanes from one base: binary file, delete and new file, both apply in sequence', async () => {
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
    const p1 = wt.collectPatch({ lane: one.path, adminDir: one.adminDir, base: base.commit });
    const p2 = wt.collectPatch({ lane: two.path, adminDir: two.adminDir, base: base.commit });
    assert.deepEqual(p1.changes.map((c) => `${c.status}:${c.path}`).sort(), ['M:a.txt', 'M:img.bin']);
    assert.deepEqual(p2.changes.map((c) => `${c.status}:${c.path}`).sort(), ['A:sub/new.txt', 'D:del.txt']);
    assert.deepEqual(await wt.applyPatch({ root: dir, patch: p1.patch }), { applied: true });
    assert.deepEqual(await wt.applyPatch({ root: dir, patch: p2.patch }), { applied: true });
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

test('a lane edit of a file the shared tree changed meanwhile is a conflict and leaves the tree byte-identical', async () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'a.txt', 'a1\nlane\na3\n');
    write(added.workspacePath, 'b.txt', 'b-lane\n');
    const { patch } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    write(dir, 'a.txt', 'a1\nshared\na3\n');
    const before = readTree(dir);
    const state = repoState(dir);
    const result = await wt.applyPatch({ root: dir, patch });
    assert.equal(result.applied, false);
    assert.equal(result.conflict, true);
    assert.deepEqual(result.paths, ['a.txt']);
    assert.match(result.message, /a\.txt/);
    assert.deepEqual(readTree(dir), before);
    assert.deepEqual(repoState(dir), state);
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('a new file that already exists in the shared tree is reported as a conflict path', async () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'fresh.txt', 'lane\n');
    const { patch } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    write(dir, 'fresh.txt', 'shared\n');
    const result = await wt.applyPatch({ root: dir, patch });
    assert.equal(result.conflict, true);
    assert.deepEqual(result.paths, ['fresh.txt']);
    assert.equal(fs.readFileSync(path.join(dir, 'fresh.txt'), 'utf8'), 'shared\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('a patch applies when the shared tree differs from the base only in unrelated files', async () => {
  const dir = makeRepo();
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'a.txt', 'a1\nA2\na3\n');
    const { patch } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    write(dir, 'keep.txt', 'someone else\n');
    write(dir, 'extra.txt', 'x\n');
    assert.deepEqual(await wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a1\nA2\na3\n');
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'someone else\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('an empty patch applies without git', async () => {
  assert.deepEqual(await wt.applyPatch({ root: '/nonexistent-dir', patch: Buffer.alloc(0) }), { applied: true });
});

test('ignored .venv is symlinked into the lane and never shows up in collectPatch', async () => {
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
    assert.throws(() => wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit }), (e) => e.reason === 'escaping_symlink' && e.paths[0] === '.venv', 'the link is refused without exclusion');
    const excluded = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit, exclude: ['.venv'] });
    assert.deepEqual(excluded.changes, [{ status: 'M', path: 'a.txt' }]);
    assert.ok(!excluded.patch.toString().includes('.venv'));
    wt.removeLane({ root: dir, lane: added.path });
    assert.ok(fs.existsSync(path.join(dir, '.venv', 'lib', 'mod.py')), 'removing a lane never follows the link');
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('executable bit change and a file name with spaces round-trip', async () => {
  const dir = makeRepo({ 'run.sh': '#!/bin/sh\n' });
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    fs.chmodSync(path.join(added.workspacePath, 'run.sh'), 0o755);
    write(added.workspacePath, 'dir with space/my file.txt', 'spaced\n');
    const { patch, changes } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    assert.deepEqual(changes.map((c) => `${c.status}:${c.path}`).sort(), ['A:dir with space/my file.txt', 'M:run.sh']);
    assert.deepEqual(await wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.ok(fs.statSync(path.join(dir, 'run.sh')).mode & 0o100);
    assert.equal(fs.readFileSync(path.join(dir, 'dir with space', 'my file.txt'), 'utf8'), 'spaced\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('an unborn HEAD repository works end to end', async () => {
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
    const { patch, changes } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    assert.equal(changes.length, 2);
    assert.deepEqual(await wt.applyPatch({ root: dir, patch }), { applied: true });
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b\n');
    wt.removeLane({ root: dir, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('a workspace in a subdirectory gets the right prefix and workspacePath', async () => {
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
    const { patch, changes } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit, exclude: ['ws/.venv'] });
    assert.deepEqual(changes.map((c) => c.path).sort(), ['top.txt', 'ws/inner.txt']);
    assert.deepEqual(await wt.applyPatch({ root, patch }), { applied: true });
    assert.equal(fs.readFileSync(path.join(root, 'inner.txt'), 'utf8'), 'edited\n');
    assert.equal(fs.readFileSync(path.join(dir, 'top.txt'), 'utf8'), 'top edited\n');
    wt.removeLane({ root, lane: added.path });
  } finally { cleanup(dir, path.dirname(lane)); }
});

test('removeLane of a vanished lane deletes only its admin dir and leaves other worktrees alone', async () => {
  const dir = makeRepo();
  const l1 = laneDir();
  const l2 = laneDir();
  const l3 = laneDir();
  try {
    const base = wt.createBase(dir);
    const one = wt.addLane({ root: dir, base: base.commit, dir: l1 });
    const two = wt.addLane({ root: dir, base: base.commit, dir: l2 });
    const three = wt.addLane({ root: dir, base: base.commit, dir: l3 });
    assert.ok(fs.existsSync(one.adminDir));
    fs.rmSync(one.path, { recursive: true, force: true });
    fs.rmSync(two.path, { recursive: true, force: true });
    const lanesRoot = path.dirname(l1);
    assert.throws(() => wt.removeLane({ root: dir, lane: one.path }), (e) => e.code === 'lanes_root_required');
    assert.throws(() => wt.removeLane({ root: dir, lane: one.path, lanesRoot: path.dirname(l2) }), (e) => e.code === 'lane_outside_root');
    wt.removeLane({ root: dir, lane: one.path, lanesRoot });
    wt.removeLane({ root: dir, lane: one.path, lanesRoot });
    assert.ok(!fs.existsSync(one.adminDir));
    assert.ok(fs.existsSync(two.adminDir), 'another vanished worktree is not ours to prune');
    assert.ok(fs.existsSync(three.adminDir));
    wt.removeLane({ root: dir, lane: three.path });
    assert.ok(!fs.existsSync(three.adminDir));
    assert.ok(fs.existsSync(two.adminDir));
  } finally { cleanup(dir, path.dirname(l1), path.dirname(l2), path.dirname(l3)); }
});

test('inspectRepo rejects a non-git directory and a repo with submodules', async () => {
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

test('timing: createBase + addLane + collectPatch + applyPatch on ~1000 files', async () => {
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
    const { patch, changes } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    const t3 = Date.now();
    const result = await wt.applyPatch({ root: dir, patch });
    const t4 = Date.now();
    assert.equal(changes.length, 5);
    assert.equal(result.applied, true);
    wt.removeLane({ root: dir, lane: added.path });
    console.log(`# timing ms: createBase=${t1 - t0} addLane=${t2 - t1} collectPatch=${t3 - t2} applyPatch=${t4 - t3} total=${t4 - t0}`);
  } finally { cleanup(dir, path.dirname(lane)); }
});

function hookMarkers(dir) {
  const marker = path.join(dir, '..', `${path.basename(dir)}-marker`);
  const script = path.join(dir, '..', `${path.basename(dir)}-script.sh`);
  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  fs.copyFileSync(script, path.join(dir, '.git', 'hooks', 'post-checkout'));
  fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);
  fs.appendFileSync(path.join(dir, '.git', 'config'), `[core]\n\tfsmonitor = ${script}\n`);
  return { marker, script };
}

test('hooks and fsmonitor configured in the repo are never run by any module call', async () => {
  const dir = makeRepo();
  const lane = laneDir();
  const { marker, script } = hookMarkers(dir);
  try {
    write(dir, 'a.txt', 'dirty\n');
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    write(added.workspacePath, 'b.txt', 'lane\n');
    wt.inspectRepo(dir);
    wt.inspectLaneSafety({ lane: added.path, adminDir: added.adminDir });
    const { patch } = wt.collectPatch({ lane: added.path, adminDir: added.adminDir, base: base.commit });
    write(dir, 'a.txt', 'a1\na2\na3\n');
    await wt.applyPatch({ root: dir, patch });
    wt.removeLane({ root: dir, lane: added.path });
    assert.ok(!fs.existsSync(marker), 'a hook or fsmonitor ran');
  } finally { cleanup(dir, path.dirname(lane), marker, script); }
});

function laneFixture(files) {
  const dir = makeRepo(files);
  const lane = laneDir();
  const base = wt.createBase(dir);
  const added = wt.addLane({ root: dir, base: base.commit, dir: lane, links: ['.venv'] });
  return { dir, lane, base, added, done: () => cleanup(dir, path.dirname(lane)) };
}

function refused(fx, reason, exclude = []) {
  const safety = wt.inspectLaneSafety({ lane: fx.added.path, adminDir: fx.added.adminDir, exclude });
  assert.equal(safety.ok, false);
  assert.equal(safety.reason, reason);
  assert.throws(
    () => wt.collectPatch({ lane: fx.added.path, adminDir: fx.added.adminDir, base: fx.base.commit, exclude }),
    (e) => e.code === 'lane_unsafe' && e.reason === reason && e.paths.length > 0,
  );
  return safety;
}

test('a nested .git directory or file is refused', async () => {
  const fx = laneFixture();
  try {
    fs.mkdirSync(path.join(fx.added.path, 'vendor', 'x', '.git'), { recursive: true });
    assert.deepEqual(refused(fx, 'nested_git').paths, [path.join('vendor', 'x', '.git')]);
    fs.rmSync(path.join(fx.added.path, 'vendor'), { recursive: true });
    write(fx.added.path, 'other/.git', 'gitdir: /somewhere/else\n');
    assert.deepEqual(refused(fx, 'nested_git').paths, [path.join('other', '.git')]);
    fs.rmSync(path.join(fx.added.path, 'other'), { recursive: true });
    assert.equal(wt.inspectLaneSafety({ lane: fx.added.path, adminDir: fx.added.adminDir }).ok, true);
  } finally { fx.done(); }
});

test('a nested repository staged as a gitlink is refused at the index level', async () => {
  const fx = laneFixture();
  try {
    const real = path.join(fx.added.path, 'sub');
    fs.mkdirSync(real);
    execFileSync('git', ['-C', real, 'init', '-q']);
    write(real, 'f.txt', 'f\n');
    execFileSync('git', ['-C', real, 'add', '.']);
    execFileSync('git', ['-C', real, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'x']);
    assert.deepEqual(refused(fx, 'gitlink').paths, ['sub']);
    // A repository without commits cannot be staged at all: reported as nested_git.
    fs.rmSync(real, { recursive: true });
    fs.mkdirSync(real);
    execFileSync('git', ['-C', real, 'init', '-q']);
    write(real, 'f.txt', 'f\n');
    assert.deepEqual(refused(fx, 'nested_git').paths, ['sub']);
  } finally { fx.done(); }
});

test('ignored directories are not inspected; the same content in a tracked-visible dir is refused', async () => {
  const fx = laneFixture({ '.gitignore': 'envs/\n' });
  try {
    const work = fx.added.path;
    // Inside an ignored dir: absolute symlink, nested repo with a commit, and a stray .git file.
    fs.mkdirSync(path.join(work, 'envs', 'py'), { recursive: true });
    fs.symlinkSync('/usr/bin/python3', path.join(work, 'envs', 'py', 'python'));
    const nested = path.join(work, 'envs', 'repo');
    fs.mkdirSync(nested);
    execFileSync('git', ['-C', nested, 'init', '-q']);
    write(nested, 'f.txt', 'f\n');
    execFileSync('git', ['-C', nested, 'add', '.']);
    execFileSync('git', ['-C', nested, '-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'x']);
    write(work, 'envs/stray/.git', 'gitdir: /nonexistent\n');
    write(work, 'a.txt', 'a1\nA2\na3\n');
    assert.deepEqual(wt.inspectLaneSafety({ lane: work, adminDir: fx.added.adminDir }), { ok: true });
    const { changes } = wt.collectPatch({ lane: work, adminDir: fx.added.adminDir, base: fx.base.commit });
    assert.deepEqual(changes, [{ status: 'M', path: 'a.txt' }]);
    // Same shapes in a visible dir are refused.
    fs.symlinkSync('/usr/bin/python3', path.join(work, 'python'));
    assert.deepEqual(refused(fx, 'escaping_symlink').paths, ['python']);
    fs.rmSync(path.join(work, 'python'));
    write(work, 'visible/.git', 'gitdir: /nonexistent\n');
    assert.deepEqual(refused(fx, 'nested_git').paths, [path.join('visible', '.git')]);
  } finally { fx.done(); }
});

test('absolute and escaping symlinks are refused, in-tree relative ones allowed', async () => {
  const fx = laneFixture();
  try {
    fs.symlinkSync('a.txt', path.join(fx.added.path, 'rel-ok'));
    fs.mkdirSync(path.join(fx.added.path, 'd'));
    fs.symlinkSync('../a.txt', path.join(fx.added.path, 'd', 'up-ok'));
    assert.equal(wt.inspectLaneSafety({ lane: fx.added.path, adminDir: fx.added.adminDir }).ok, true);
    const ok = wt.collectPatch({ lane: fx.added.path, adminDir: fx.added.adminDir, base: fx.base.commit });
    assert.deepEqual(ok.changes.map((c) => c.path).sort(), ['d/up-ok', 'rel-ok']);
    fs.symlinkSync('/etc/passwd', path.join(fx.added.path, 'abs'));
    assert.deepEqual(refused(fx, 'escaping_symlink').paths, ['abs']);
    fs.rmSync(path.join(fx.added.path, 'abs'));
    fs.symlinkSync('../../outside', path.join(fx.added.path, 'd', 'up-bad'));
    assert.deepEqual(refused(fx, 'escaping_symlink').paths, [path.join('d', 'up-bad')]);
  } finally { fx.done(); }
});

test('the linked env dir is skipped by the safety scan when excluded', async () => {
  const fx = laneFixture({ '.gitignore': '.venv/\n' });
  try {
    assert.deepEqual(fx.added.linked, []);
    fs.symlinkSync(path.join(fx.dir, 'a.txt'), path.join(fx.added.path, '.venv'));
    refused(fx, 'escaping_symlink');
    assert.equal(wt.inspectLaneSafety({ lane: fx.added.path, adminDir: fx.added.adminDir, exclude: ['.venv'] }).ok, true);
  } finally { fx.done(); }
});

test('a rewritten lane .git pointer cannot redirect git; the admin dir comes from the shared repo', async () => {
  const dir = makeRepo();
  const decoy = makeRepo({ 'decoy.txt': 'decoy\n' });
  const lane = laneDir();
  try {
    const base = wt.createBase(dir);
    const added = wt.addLane({ root: dir, base: base.commit, dir: lane });
    assert.equal(fs.realpathSync(path.dirname(added.adminDir)), fs.realpathSync(path.join(dir, '.git', 'worktrees')));
    fs.writeFileSync(path.join(added.path, '.git'), `gitdir: ${path.join(decoy, '.git')}\n`);
    write(added.workspacePath, 'a.txt', 'a1\nA2\na3\n');
    const { changes } = wt.collectPatch({ lane: added.path, root: dir, base: base.commit });
    assert.deepEqual(changes, [{ status: 'M', path: 'a.txt' }]);
  } finally { cleanup(dir, decoy, path.dirname(lane)); }
});

test('renames show as delete plus add', async () => {
  const fx = laneFixture();
  try {
    fs.renameSync(path.join(fx.added.path, 'keep.txt'), path.join(fx.added.path, 'moved.txt'));
    const { changes } = wt.collectPatch({ lane: fx.added.path, adminDir: fx.added.adminDir, base: fx.base.commit });
    assert.deepEqual(changes.map((c) => `${c.status}:${c.path}`).sort(), ['A:moved.txt', 'D:keep.txt']);
    assert.ok(changes.every((c) => c.oldPath === undefined));
  } finally { fx.done(); }
});

test('detached apply reports its pid through onSpawn and applies', async () => {
  const fx = laneFixture();
  try {
    write(fx.added.workspacePath, 'a.txt', 'a1\nA2\na3\n');
    const { patch } = wt.collectPatch({ lane: fx.added.path, adminDir: fx.added.adminDir, base: fx.base.commit });
    const pids = [];
    assert.deepEqual(await wt.applyPatch({ root: fx.dir, patch, onSpawn: (pid) => pids.push(pid) }), { applied: true });
    assert.equal(pids.length, 1);
    assert.ok(Number.isInteger(pids[0]) && pids[0] > 0);
    assert.equal(fs.readFileSync(path.join(fx.dir, 'a.txt'), 'utf8'), 'a1\nA2\na3\n');
  } finally { fx.done(); }
});

test('a non-zero apply exit after a passing check is reported as partial', async () => {
  const fx = laneFixture();
  try {
    write(fx.added.workspacePath, 'a.txt', 'a1\nA2\na3\n');
    const { patch } = wt.collectPatch({ lane: fx.added.path, adminDir: fx.added.adminDir, base: fx.base.commit });
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const calls = [];
    const spawnFn = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdin = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => { child.stderr.write('error: disk full\n'); child.emit('close', 1, null); });
      return child;
    };
    const pids = [];
    const result = await wt.applyPatch({ root: fx.dir, patch, spawnFn, onSpawn: (pid) => pids.push(pid) });
    assert.deepEqual(result, { applied: false, conflict: false, partial: true, message: 'error: disk full' });
    assert.deepEqual(pids, [4242]);
    assert.equal(calls[0].options.detached, true);
    assert.ok(calls[0].args.includes('--whitespace=nowarn'));
    assert.ok(calls[0].args.includes('core.hooksPath=/dev/null'));
  } finally { fx.done(); }
});
