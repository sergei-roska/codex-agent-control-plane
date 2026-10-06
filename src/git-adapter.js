'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const childProcess = require('node:child_process');

// The only module allowed to change Git state, and the only mutation is creating or
// switching a task branch. Fixed argv, no shell; agents never run git mutations.
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_INLINE_BYTES = 256 * 1024;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 2000;
const DEFAULT_GIT_TIMEOUT_MS = 60 * 1000;
// Repository config is untrusted input: no fsmonitor hook, no hooks path, no external diff driver.
const HARDENING_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];
const SLUG_MAX = 40;
const OPERATION_MARKERS = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'];
const BRANCH_PREFIXES = {
  feature: 'feature',
  bugfix: 'fix',
  fix: 'fix',
  refactor: 'refactor',
  docs: 'docs',
  chore: 'chore',
};

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Shared with git-delivery.js so verification recomputes exactly what captureCandidate hashed.
function computeIntegrityHash(head, manifest) {
  return sha256(`${head}\n${JSON.stringify(manifest)}`);
}

// Environment for every Git call: never prompt for credentials. GIT_SSH_COMMAND is not set here
// (it would override core.sshCommand); network callers add batch mode themselves.
function nonInteractiveEnv(base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', LC_ALL: 'C' };
  delete env.SSH_ASKPASS;
  delete env.SSH_ASKPASS_REQUIRE;
  return env;
}

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'task';
}

// `status --porcelain=v1 -z`: "XY path" records; a rename or copy is followed by one extra
// record holding the original path.
function parsePorcelain(raw) {
  const records = raw.split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const entry = { path: record.slice(3), xy };
    if (xy.includes('R') || xy.includes('C')) {
      index += 1;
      if (records[index]) entry.oldPath = records[index];
    }
    entries.push(entry);
  }
  return entries;
}

// `diff --name-status -z -M`: "S\0path" or "Rnn\0old\0new".
function parseNameStatus(raw) {
  const parts = raw.split('\0');
  const entries = [];
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      entries.push({ path: parts[index + 2], status: letter, oldPath: parts[index + 1] });
      index += 2;
    } else {
      entries.push({ path: parts[index + 1], status: letter });
      index += 1;
    }
  }
  return entries.filter((entry) => entry.path);
}

function statusLetter(xy) {
  if (xy === '??') return '??';
  return xy[0] !== ' ' ? xy[0] : xy[1];
}

function hashFileStream(absolute) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absolute);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// lstat first (size and kind without reading), then a streamed hash so large files never sit in memory.
async function describeFile(absolute) {
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return { sha256: sha256(fs.readlinkSync(absolute)), size: stat.size, kind: 'symlink', mode: 'symlink' };
    if (stat.isDirectory()) return { sha256: null, size: null, kind: 'directory', mode: null };
    return { sha256: await hashFileStream(absolute), size: stat.size, kind: 'file', mode: stat.mode & 0o111 ? 'exec' : 'file' };
  } catch (_) {
    return { sha256: null, size: null, kind: 'missing', mode: null };
  }
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return null;
  }
}

function quotePath(p) {
  return /^[\x21-\x7e]+$/.test(p) && !p.includes('"') ? p : JSON.stringify(p);
}

function syntheticDiff(relative, text) {
  const shown = quotePath(relative);
  const header = `diff --git a/${shown} b/${shown}\nnew file mode 100644\n--- /dev/null\n+++ b/${shown}\n`;
  if (text.length === 0) return header;
  const lines = text.split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  let body = `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
  if (!endsWithNewline) body += '\\ No newline at end of file\n';
  return header + body;
}

function createGitAdapter({ workspace, execFile, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required');
  const exec = execFile || promisify(childProcess.execFile);
  const env = nonInteractiveEnv();

  async function git(argv) {
    const result = await exec('git', [...HARDENING_ARGS, ...argv], { cwd: workspace, env, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', timeout: timeoutMs });
    return typeof result === 'string' ? result : result.stdout;
  }

  async function gitOrNull(argv) {
    try {
      return await git(argv);
    } catch (_) {
      return null;
    }
  }

  async function validBranchName(name) {
    if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
    return (await gitOrNull(['check-ref-format', '--branch', name])) !== null;
  }

  async function resolveCommit(ref) {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-')) return null;
    const out = await gitOrNull(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return out ? out.trim() : null;
  }

  async function currentBranch() {
    const out = await gitOrNull(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return out ? out.trim() : null;
  }

  async function currentHead() {
    const out = await gitOrNull(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return out ? out.trim() : null;
  }

  async function isRepoRoot() {
    const top = await gitOrNull(['rev-parse', '--show-toplevel']);
    if (!top) return false;
    try {
      return fs.realpathSync(top.trim()) === fs.realpathSync(workspace);
    } catch (_) {
      return false;
    }
  }

  async function operationInProgress() {
    const active = [];
    for (const marker of OPERATION_MARKERS) {
      const out = await gitOrNull(['rev-parse', '--git-path', marker]);
      if (!out) continue;
      if (fs.existsSync(path.resolve(workspace, out.trim()))) active.push(marker);
    }
    return active;
  }

  async function porcelain() {
    return parsePorcelain(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  }

  async function preflight({ baseRef = 'HEAD', ownedBranch = null } = {}) {
    const result = { ok: false, problems: [], notes: [], head: null, branch: null, baseCommit: null };
    const problem = (code, message) => result.problems.push({ code, message });
    if (!(await isRepoRoot())) {
      problem('not_a_repo', 'The configured workspace is not the root of a Git work tree');
      return result;
    }
    const operations = await operationInProgress();
    if (operations.length) problem('operation_in_progress', `Git operation in progress (${operations.join(', ')})`);
    const dirty = await porcelain();
    result.head = await currentHead();
    result.branch = await currentBranch();
    if (dirty.length) {
      const message = `The checkout has ${dirty.length} uncommitted or untracked path(s)`;
      if (ownedBranch && result.branch === ownedBranch) result.notes.push({ code: 'owned_branch_dirty', message });
      else problem('dirty_worktree', message);
    }
    if (!result.branch && result.head) result.notes.push({ code: 'detached_head_allowed', message: 'HEAD is detached' });
    result.baseCommit = await resolveCommit(baseRef);
    if (!result.baseCommit) problem('base_ref_missing', 'The base ref does not resolve to a commit');
    const ignored = await gitOrNull(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory']);
    const ignoredCount = ignored ? ignored.split('\0').filter(Boolean).length : 0;
    if (ignoredCount) result.notes.push({ code: 'ignored_files_present', message: `${ignoredCount} ignored path(s) present` });
    result.ok = result.problems.length === 0;
    return result;
  }

  // `branchPrefixes` is the project policy ({ feature, bugfix, docs }, each ending in "/" or "-");
  // the built-in mapping only covers classifications the policy does not name.
  async function branchName({ classification, title, ticketId, branchPrefixes, sourceKind, sourceDisplayKey } = {}) {
    const key = String(classification || '').toLowerCase();
    const policy = branchPrefixes && typeof branchPrefixes === 'object' ? branchPrefixes[key] : undefined;
    const isJira = sourceKind === 'jira';
    const jiraDefault = isJira && (key === 'feature' || key === 'bugfix') ? key : null;
    const prefix = typeof policy === 'string' && policy ? policy : `${jiraDefault || BRANCH_PREFIXES[key] || 'task'}/`;
    if (isJira) {
      if (typeof sourceDisplayKey !== 'string' || !/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8}$/.test(sourceDisplayKey)) {
        throw new Error('invalid Jira issue key for branch name');
      }
      const name = `${prefix}${sourceDisplayKey}`;
      if (!(await validBranchName(name))) throw new Error(`invalid branch name: ${name}`);
      return name;
    }
    const suffix = String(ticketId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6) || 'ticket';
    const name = `${prefix}${slugify(title)}-${suffix}`;
    if (!(await validBranchName(name))) throw new Error(`invalid branch name: ${name}`);
    return name;
  }

  async function branchExists(name) {
    if (!(await validBranchName(name))) return false;
    return (await gitOrNull(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) !== null;
  }

  async function prepareBranch({ name, baseCommit, ownedByThisTicket = false } = {}) {
    const fail = (code, message) => ({ ok: false, created: false, reused: false, branch: name, head: null, problems: [{ code, message }] });
    if (!(await validBranchName(name))) return fail('invalid_branch_name', 'The branch name is not a valid Git branch name');
    const commit = await resolveCommit(baseCommit);
    if (!commit) return fail('base_ref_missing', 'The base commit does not resolve');
    const exists = await branchExists(name);
    if (exists && !ownedByThisTicket) return fail('branch_collision', 'A branch with this name already exists and is not owned by this ticket');
    const onOwnedBranch = exists && (await currentBranch()) === name;
    // Continuing on the ticket's own (possibly dirty) branch needs no switch, so no clean checkout.
    if (!onOwnedBranch && (await porcelain()).length) return fail('dirty_worktree', 'The checkout is not clean');
    if (exists) {
      if ((await currentBranch()) !== name) await git(['switch', name]);
    } else {
      await git(['switch', '-c', name, commit]);
    }
    return { ok: true, created: !exists, reused: exists, branch: name, head: await currentHead(), problems: [] };
  }

  async function captureCandidate({ baseCommit } = {}) {
    const base = await resolveCommit(baseCommit);
    if (!base) throw new Error('baseCommit does not resolve to a commit');
    const head = await currentHead();
    const branch = await currentBranch();
    const entries = await porcelain();

    const byPath = new Map();
    for (const entry of entries) {
      byPath.set(entry.path, { path: entry.path, status: statusLetter(entry.xy), ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) });
    }
    const headMoved = head !== base;
    if (headMoved) {
      const committed = parseNameStatus(await git(['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', base, head, '--']));
      for (const entry of committed) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
    }

    const manifest = [];
    const untracked = [];
    const sorted = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifestTruncated = sorted.length > MAX_MANIFEST_ENTRIES;
    for (const entry of sorted.slice(0, MAX_MANIFEST_ENTRIES)) {
      const info = entry.status === 'D' ? { sha256: null, size: null, kind: 'missing', mode: null } : await describeFile(path.join(workspace, entry.path));
      manifest.push({ path: entry.path, status: entry.status, sha256: info.sha256, size: info.size, mode: info.mode, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) });
      if (entry.status === '??') untracked.push({ entry, info });
    }

    let truncated = false;
    let diffText = '';
    try {
      diffText = await git(['diff', '--no-ext-diff', '--no-textconv', '--binary', base, '--']);
    } catch (error) {
      if (error && typeof error.stdout === 'string' && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        diffText = error.stdout;
        truncated = true;
      } else {
        throw error;
      }
    }

    for (const { entry, info } of untracked) {
      if (truncated) break;
      const relative = entry.path;
      let piece;
      if (info.kind !== 'file') {
        piece = `# untracked ${info.kind} not inlined: ${quotePath(relative)}\n`;
      } else if (info.size > MAX_UNTRACKED_INLINE_BYTES) {
        piece = `# untracked file not inlined (larger than ${MAX_UNTRACKED_INLINE_BYTES} bytes): ${quotePath(relative)}\n`;
      } else {
        const text = decodeText(fs.readFileSync(path.join(workspace, relative)));
        piece = text === null
          ? `# untracked file not inlined (binary): ${quotePath(relative)}\n`
          : syntheticDiff(relative, text);
      }
      if (diffText && !diffText.endsWith('\n')) diffText += '\n';
      diffText += piece;
      if (Buffer.byteLength(diffText) > MAX_DIFF_BYTES) truncated = true;
    }
    if (Buffer.byteLength(diffText) > MAX_DIFF_BYTES) {
      truncated = true;
      diffText = Buffer.from(diffText).subarray(0, MAX_DIFF_BYTES).toString('utf8').replace(/\uFFFD$/, '');
    }

    return {
      baseCommit: base,
      head,
      branch,
      headMoved,
      manifest,
      manifestTruncated,
      diffText,
      truncated,
      integrityHash: computeIntegrityHash(head, manifest),
    };
  }

  return { preflight, branchName, prepareBranch, captureCandidate, branchExists };
}

module.exports = { createGitAdapter, computeIntegrityHash, nonInteractiveEnv, slugify, parsePorcelain, MAX_DIFF_BYTES, MAX_UNTRACKED_INLINE_BYTES };
