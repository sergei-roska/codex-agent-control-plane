'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

// Git mechanics for writer lanes (see docs/parallel-writers-design.md). Every call is
// shell-free (all synchronous except applyPatch) and never touches the shared repo's index, HEAD, refs, stash
// or config: index work uses a temporary GIT_INDEX_FILE.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
// Lane content is untrusted: no fsmonitor and no hooks for any git child process (R2).
const GIT_HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false'];

class WorktreeError extends Error {
  constructor(code, message, stderr = '') {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.stderr = stderr;
  }
}

function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return { ...env, ...extra };
}

// Returns stdout as a Buffer. Throws WorktreeError(code 'git_failed' | 'git_unavailable').
function runGit(cwd, args, { env, input } = {}) {
  try {
    return execFileSync('git', [...GIT_HARDENING, '-C', cwd, ...args], {
      env: gitEnv(env),
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new WorktreeError('git_unavailable', 'git executable not found');
    const stderr = error.stderr ? error.stderr.toString('utf8') : '';
    const first = stderr.split('\n').find(Boolean) || error.message;
    const failure = new WorktreeError('git_failed', `git ${args[0]} failed: ${first}`, stderr);
    failure.status = error.status;
    throw failure;
  }
}

function gitText(cwd, args, options) {
  return runGit(cwd, args, options).toString('utf8');
}

function hasHead(cwd) {
  try { runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']); return true; } catch (_) { return false; }
}

function inspectRepo(root) {
  try {
    if (gitText(root, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
      return { ok: false, reason: 'not_a_git_work_tree' };
    }
    const gitRoot = gitText(root, ['rev-parse', '--show-toplevel']).trim();
    const prefix = gitText(root, ['rev-parse', '--show-prefix']).trim();
    if (fs.existsSync(path.join(gitRoot, '.gitmodules'))) return { ok: false, reason: 'has_submodules' };
    if (hasHead(gitRoot)) {
      const tree = gitText(gitRoot, ['ls-tree', '-r', 'HEAD']);
      if (/^160000 /m.test(tree)) return { ok: false, reason: 'has_submodules' };
    }
    return { ok: true, gitRoot, prefix };
  } catch (error) {
    return { ok: false, reason: error.code === 'git_unavailable' ? 'git_unavailable' : 'not_a_git_work_tree' };
  }
}

function requireRepo(root) {
  const info = inspectRepo(root);
  if (!info.ok) throw new WorktreeError('not_a_repo', `not a usable git work tree: ${info.reason}`);
  return info;
}

// Runs fn(env) with a throwaway index file; the file is always removed.
function withTempIndex(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-index-'));
  try {
    return fn({ GIT_INDEX_FILE: path.join(dir, 'index') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createBase(root) {
  const { gitRoot } = requireRepo(root);
  const now = new Date().toISOString();
  const identity = {
    GIT_AUTHOR_NAME: 'lane-base', GIT_AUTHOR_EMAIL: 'lane-base@localhost', GIT_AUTHOR_DATE: now,
    GIT_COMMITTER_NAME: 'lane-base', GIT_COMMITTER_EMAIL: 'lane-base@localhost', GIT_COMMITTER_DATE: now,
  };
  return withTempIndex((env) => {
    const born = hasHead(gitRoot);
    runGit(gitRoot, born ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env });
    runGit(gitRoot, ['add', '-A'], { env });
    const tree = gitText(gitRoot, ['write-tree'], { env }).trim();
    const args = ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(born ? ['-p', 'HEAD'] : []), '-m', 'lane base'];
    const commit = gitText(gitRoot, args, { env: { ...env, ...identity } }).trim();
    return { commit, tree };
  });
}

function isIgnored(cwd, name) {
  try {
    runGit(cwd, ['check-ignore', '-q', '--', name]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function addLane({ root, base, dir, links = [] }) {
  const { gitRoot, prefix } = requireRepo(root);
  const lanePath = path.resolve(dir);
  runGit(gitRoot, ['worktree', 'add', '--detach', lanePath, base]);
  const adminDir = findAdminDir(gitRoot, lanePath);
  if (!adminDir) throw new WorktreeError('admin_dir_not_found', `no worktree admin dir for ${lanePath}`);
  const workspacePath = path.join(lanePath, prefix).replace(/\/+$/, '') || lanePath;
  const sharedWorkspace = path.join(gitRoot, prefix);
  const linked = [];
  for (const name of links) {
    const shared = path.join(sharedWorkspace, name);
    let exists = true;
    try { fs.lstatSync(shared); } catch (_) { exists = false; }
    if (!exists || !isIgnored(sharedWorkspace, name)) continue;
    const target = path.join(workspacePath, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(shared, target);
    linked.push(name);
  }
  return { path: lanePath, workspacePath, linked, adminDir };
}

function realish(file) {
  const resolved = path.resolve(file);
  try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch (_) { return resolved; }
}

function commonDir(gitRoot) {
  return path.resolve(gitRoot, gitText(gitRoot, ['rev-parse', '--git-common-dir']).trim());
}

// Admin dirs live in the shared repo, which a lane cannot write, so the lane's own
// `.git` pointer is never trusted: the admin dir is the one whose `gitdir` file names the lane.
function findAdminDir(gitRoot, lanePath) {
  const wanted = realish(path.join(lanePath, '.git'));
  const base = path.join(commonDir(gitRoot), 'worktrees');
  let names = [];
  try { names = fs.readdirSync(base); } catch (_) { return null; }
  for (const name of names) {
    try {
      const pointer = fs.readFileSync(path.join(base, name, 'gitdir'), 'utf8').trim();
      if (realish(pointer) === wanted) return path.join(base, name);
    } catch (_) { /* not an admin dir */ }
  }
  return null;
}

// Environment that pins git to the lane's admin dir and work tree (ignores the lane's `.git`).
function laneEnv(lane, { adminDir, root }) {
  let admin = adminDir;
  if (!admin && root) admin = findAdminDir(requireRepo(root).gitRoot, lane);
  if (!admin) throw new WorktreeError('admin_dir_required', 'lane operations need adminDir or root');
  return { GIT_DIR: admin, GIT_WORK_TREE: lane };
}

function unsafe(reason, paths) {
  const error = new WorktreeError('lane_unsafe', `lane is unsafe to collect: ${reason}: ${paths.join(', ')}`);
  error.reason = reason;
  error.paths = paths;
  return error;
}

function excludeSpecs(exclude) {
  return exclude.map((name) => `:(exclude,literal)${String(name).replace(/\/+$/, '')}`);
}

// Stages the lane into the temp index. A nested repository without commits makes `add -A` fail;
// that is reported as nested_git instead of a git error.
function stageLane(laneRoot, env, exclude) {
  try {
    runGit(laneRoot, ['add', '-A', '--', '.', ...excludeSpecs(exclude)], { env });
  } catch (error) {
    const match = error.code === 'git_failed' && /'(.+?)\/?' does not have a commit checked out/.exec(error.stderr);
    if (!match) throw error;
    return { ok: false, reason: 'nested_git', paths: [match[1]] };
  }
  return { ok: true };
}

// Targets of the given symlink blobs, in order (one `cat-file --batch` call).
function symlinkTargets(laneRoot, env, shas) {
  const out = runGit(laneRoot, ['cat-file', '--batch'], { env, input: `${shas.join('\n')}\n` });
  const targets = [];
  let offset = 0;
  for (let i = 0; i < shas.length; i += 1) {
    const eol = out.indexOf('\n', offset);
    const size = Number(out.subarray(offset, eol).toString('utf8').split(' ')[2]);
    targets.push(out.subarray(eol + 1, eol + 1 + size).toString('utf8'));
    offset = eol + 1 + size + 1;
  }
  return targets;
}

// Inspects what `add -A` staged (so ignored content never matters): gitlinks, symlinks whose
// target is absolute or leaves the lane, then `.git` entries in non-ignored directories (git
// never stages a `.git` entry, and a bogus `.git` file is not a gitlink, so this is a file scan).
function inspectStaged(laneRoot, env, exclude) {
  const entries = gitText(laneRoot, ['ls-files', '-s', '-z'], { env }).split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    const [mode, sha] = record.slice(0, tab).split(' ');
    return { mode, sha, path: record.slice(tab + 1) };
  });
  const gitlinks = entries.filter((entry) => entry.mode === '160000').map((entry) => entry.path);
  if (gitlinks.length) return { ok: false, reason: 'gitlink', paths: gitlinks.sort() };
  const links = entries.filter((entry) => entry.mode === '120000');
  if (links.length) {
    const targets = symlinkTargets(laneRoot, env, links.map((entry) => entry.sha));
    const bad = links.filter((entry, i) => {
      if (path.isAbsolute(targets[i])) return true;
      return path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), targets[i])).startsWith('..');
    }).map((entry) => entry.path);
    if (bad.length) return { ok: false, reason: 'escaping_symlink', paths: bad.sort() };
  }
  const ignored = new Set(gitText(laneRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { env })
    .split('\0').filter((name) => name.endsWith('/')).map((name) => path.normalize(name).replace(/[\\/]+$/, '')));
  for (const name of exclude) ignored.add(path.normalize(String(name)).replace(/[\\/]+$/, ''));
  const nested = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(laneRoot, rel), { withFileTypes: true })) {
      const r = path.join(rel, entry.name);
      if (ignored.has(r)) continue;
      if (entry.name === '.git') {
        if (rel !== '') nested.push(r);
      } else if (entry.isDirectory()) {
        walk(r);
      }
    }
  };
  walk('');
  return nested.length ? { ok: false, reason: 'nested_git', paths: nested.sort() } : { ok: true };
}

// `{ ok: true }` or `{ ok: false, reason: gitlink | escaping_symlink | nested_git, paths }`.
// Only content `add -A` would stage counts; ignored directories are not inspected.
// Needs `adminDir` (from addLane) or `root`.
function inspectLaneSafety({ lane, exclude = [], adminDir, root } = {}) {
  const laneRoot = path.resolve(lane);
  const pinned = laneEnv(laneRoot, { adminDir, root });
  return withTempIndex((env) => {
    const full = { ...env, ...pinned };
    runGit(laneRoot, ['read-tree', '--empty'], { env: full });
    const staged = stageLane(laneRoot, full, exclude);
    return staged.ok ? inspectStaged(laneRoot, full, exclude) : staged;
  });
}

// `diff-index --name-status -z --no-renames` yields "S\0path\0".
function parseNameStatus(raw) {
  const tokens = raw.split('\0');
  const changes = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    if (tokens[index]) changes.push({ status: tokens[index][0], path: tokens[index + 1] });
  }
  return changes;
}

// Throws WorktreeError('lane_unsafe') with `.reason` and `.paths` when the lane is refused.
// Needs `adminDir` (from addLane) or `root` so git is pinned to the lane's admin dir.
function collectPatch({ lane, base, exclude = [], adminDir, root }) {
  const laneRoot = path.resolve(lane);
  const pinned = laneEnv(laneRoot, { adminDir, root });
  return withTempIndex((env) => {
    const full = { ...env, ...pinned };
    runGit(laneRoot, ['read-tree', base], { env: full });
    const staged = stageLane(laneRoot, full, exclude);
    const verdict = staged.ok ? inspectStaged(laneRoot, full, exclude) : staged;
    if (!verdict.ok) throw unsafe(verdict.reason, verdict.paths);
    const patch = runGit(laneRoot, ['diff-index', '--cached', '-p', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', base], { env: full });
    const names = gitText(laneRoot, ['diff-index', '--cached', '--name-status', '-z', '--no-renames', base], { env: full });
    return { patch, changes: parseNameStatus(names) };
  });
}

// Pulls file names out of `git apply --check` complaints.
function conflictPaths(stderr) {
  const found = new Set();
  for (const line of stderr.split('\n')) {
    let match = /^error: patch failed: (.+?):\d+$/.exec(line);
    if (!match) {
      match = /^error: (.+?): (?:patch does not apply|does not exist in working directory|already exists in working directory|does not match index|No such file or directory)/.exec(line);
    }
    if (match) found.add(match[1]);
  }
  return [...found];
}

// Check first (nothing written), then apply in a detached child so a crash of this process
// mid-apply cannot be mistaken for a quiescent tree: `onSpawn(pid)` lets the caller record it.
// Resolves { applied: true } | { applied: false, conflict: true, paths, message } |
// { applied: false, conflict: false, partial: true, message } (apply failed after a passing check).
// `spawnFn` is a test seam.
async function applyPatch({ root, patch, onSpawn, spawnFn = spawn }) {
  if (!patch || patch.length === 0) return { applied: true };
  const { gitRoot } = requireRepo(root);
  try {
    runGit(gitRoot, ['apply', '--check', '--binary', '--whitespace=nowarn'], { input: patch });
  } catch (error) {
    if (error.code !== 'git_failed') throw error;
    if (/corrupt patch|unrecognized input|No valid patches/.test(error.stderr)) {
      throw new WorktreeError('invalid_patch', error.message, error.stderr);
    }
    return { applied: false, conflict: true, paths: conflictPaths(error.stderr), message: error.stderr.trim() };
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('git', [...GIT_HARDENING, '-C', gitRoot, 'apply', '--binary', '--whitespace=nowarn'], {
        env: gitEnv(), detached: true, stdio: ['pipe', 'ignore', 'pipe'], shell: false,
      });
    } catch (error) {
      reject(new WorktreeError('git_unavailable', `cannot spawn git: ${error.message}`));
      return;
    }
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new WorktreeError('git_unavailable', `git apply could not run: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ applied: true });
      else resolve({ applied: false, conflict: false, partial: true, message: stderr.trim() || `git apply exited with ${code ?? signal}` });
    });
    if (child.pid && onSpawn) onSpawn(child.pid);
    child.stdin.on('error', () => {});
    child.stdin.end(patch);
  });
}

// Removes one lane. A vanished lane dir leaves its admin dir behind; only the admin dir whose
// `gitdir` file names this lane is deleted, and only when the lane is inside `lanesRoot`.
function removeLane({ root, lane, lanesRoot }) {
  const { gitRoot } = requireRepo(root);
  const lanePath = path.resolve(lane);
  if (fs.existsSync(lanePath)) {
    runGit(gitRoot, ['worktree', 'remove', '--force', lanePath]);
    return;
  }
  if (!lanesRoot) throw new WorktreeError('lanes_root_required', 'removeLane of a vanished lane needs lanesRoot');
  const inside = path.relative(realish(lanesRoot), realish(lanePath));
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new WorktreeError('lane_outside_root', `${lanePath} is not inside ${lanesRoot}`);
  }
  const admin = findAdminDir(gitRoot, lanePath);
  if (admin) fs.rmSync(admin, { recursive: true, force: true });
}

module.exports = {
  WorktreeError,
  inspectRepo,
  createBase,
  addLane,
  collectPatch,
  inspectLaneSafety,
  applyPatch,
  removeLane,
};
