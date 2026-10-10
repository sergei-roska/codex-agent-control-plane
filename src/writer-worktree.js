'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Git mechanics for writer lanes (see docs/parallel-writers-design.md). Every call is
// synchronous, shell-free, and never touches the shared repo's index, HEAD, refs, stash
// or config: index work uses a temporary GIT_INDEX_FILE.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

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
    return execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
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
  return { path: lanePath, workspacePath, linked };
}

// `diff --name-status -z` yields "S\0path\0"; renames and copies are "Rnn\0old\0new\0".
function parseNameStatus(raw) {
  const tokens = raw.split('\0');
  const changes = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      changes.push({ status: status[0], path: tokens[index + 2], oldPath: tokens[index + 1] });
      index += 2;
    } else {
      changes.push({ status: status[0], path: tokens[index + 1] });
      index += 1;
    }
  }
  return changes;
}

function collectPatch({ lane, base, exclude = [] }) {
  return withTempIndex((env) => {
    runGit(lane, ['read-tree', base], { env });
    const specs = exclude.map((name) => `:(exclude,literal)${String(name).replace(/\/+$/, '')}`);
    runGit(lane, ['add', '-A', '--', '.', ...specs], { env });
    const patch = runGit(lane, ['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', base], { env });
    const names = gitText(lane, ['diff', '--cached', '--name-status', '-z', '-M', '--no-ext-diff', base], { env });
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

function applyPatch({ root, patch }) {
  if (!patch || patch.length === 0) return { applied: true };
  const { gitRoot } = requireRepo(root);
  try {
    runGit(gitRoot, ['apply', '--check', '--binary'], { input: patch });
  } catch (error) {
    if (error.code !== 'git_failed') throw error;
    if (/corrupt patch|unrecognized input|No valid patches/.test(error.stderr)) {
      throw new WorktreeError('invalid_patch', error.message, error.stderr);
    }
    return { applied: false, conflict: true, paths: conflictPaths(error.stderr), message: error.stderr.trim() };
  }
  runGit(gitRoot, ['apply', '--binary'], { input: patch });
  return { applied: true };
}

function pruneLanes(root) {
  const { gitRoot } = requireRepo(root);
  runGit(gitRoot, ['worktree', 'prune']);
}

function removeLane({ root, lane }) {
  const { gitRoot } = requireRepo(root);
  try {
    runGit(gitRoot, ['worktree', 'remove', '--force', path.resolve(lane)]);
  } catch (error) {
    if (fs.existsSync(lane)) throw error;
    runGit(gitRoot, ['worktree', 'prune']);
  }
}

module.exports = {
  WorktreeError,
  inspectRepo,
  createBase,
  addLane,
  collectPatch,
  applyPatch,
  removeLane,
  pruneLanes,
};
