'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const HARDENING_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];
const FILTER_CONFIG_PATTERN = '^filter\\..*\\.(clean|smudge|process)$';
const SNAPSHOT_GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', LC_ALL: 'C' };
delete SNAPSHOT_GIT_ENV.SSH_ASKPASS;
delete SNAPSHOT_GIT_ENV.SSH_ASKPASS_REQUIRE;
const SENSITIVE_ENTRY_LIMIT = 8192;
const SENSITIVE_DEPTH_LIMIT = 32;
// Large Drupal checkouts often contain a sizeable `vendor` tree. Keep discovery
// bounded, but leave headroom above the ordinary source-tree size.
const DISCOVERY_ENTRY_LIMIT = 262144;
const DISCOVERY_DEPTH_LIMIT = 48;

// Sensitive ignored paths are represented only by names and filesystem metadata.
// Secret bytes and secret-derived hashes never enter snapshots or fingerprints.
function isSensitivePath(file) {
  const normalized = file.split(path.sep).join('/');
  return normalized.split('/').some((name) => name === '.env' || name.startsWith('.env.')) ||
    ['.runtime', 'runtime', 'data', '.codex/auth.json', '.codex/sessions']
      .some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function metadata(stat, kind) {
  return {
    kind,
    mode: Number(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    ino: String(stat.ino),
  };
}

function readDirectory(absolute, limit, dirents = false) {
  const handle = fs.opendirSync(absolute);
  const entries = [];
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      if (entries.length >= limit) throw new Error('sensitive_snapshot_limit_exceeded');
      entries.push(dirents ? entry : entry.name);
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((a, b) => {
    const left = typeof a === 'string' ? a : a.name;
    const right = typeof b === 'string' ? b : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function runGit(workspace, args) {
  try {
    const configured = execFileSync('git', [...HARDENING_ARGS, '-C', workspace, 'config', '--get-regexp', FILTER_CONFIG_PATTERN], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER, env: SNAPSHOT_GIT_ENV,
    });
    if (configured.trim()) throw new Error('git_filters_configured');
  } catch (error) {
    if (error.message === 'git_filters_configured') throw error;
    if (error.status !== 1 || String(error.stdout || '').trim()) throw new Error('git_filter_check_failed');
  }
  return execFileSync('git', [...HARDENING_ARGS, '-C', workspace, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: GIT_MAX_BUFFER,
    env: SNAPSHOT_GIT_ENV,
  });
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashPath(absolute) {
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return sha256(fs.readlinkSync(absolute));
    if (stat.isDirectory()) return null; // e.g. a submodule or nested repository
    return sha256(fs.readFileSync(absolute));
  } catch (_) {
    return null;
  }
}

// `status --porcelain=v1 -z` yields "XY path" records; a rename or copy is followed by
// one extra record holding the original path.
function parseStatus(raw) {
  const records = raw.split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    entries.push({ path: record.slice(3), status });
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      if (records[index]) entries.push({ path: records[index], status: `${status}<` });
    }
  }
  return entries;
}

function compare(a, b) {
  return (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.status < b.status ? -1 : a.status > b.status ? 1 : 0);
}

function sensitiveEntries(workspace, limits = {}) {
  const sensitiveEntryLimit = limits.sensitiveEntryLimit ?? SENSITIVE_ENTRY_LIMIT;
  const discoveryEntryLimit = limits.discoveryEntryLimit ?? DISCOVERY_ENTRY_LIMIT;
  const entries = new Map();
  const addTree = (absolute, relative, depth = 0) => {
    if (entries.size >= sensitiveEntryLimit || depth > SENSITIVE_DEPTH_LIMIT) {
      throw new Error('sensitive_snapshot_limit_exceeded');
    }
    let stat;
    try { stat = fs.lstatSync(absolute, { bigint: true }); } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('sensitive_snapshot_unavailable');
    }
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    entries.set(relative, { path: relative, ...metadata(stat, kind) });
    // Never follow symlinks. Their own metadata remains part of the snapshot.
    if (kind !== 'directory') return;
    let children;
    try { children = readDirectory(absolute, sensitiveEntryLimit - entries.size); } catch (error) {
      if (error?.message === 'sensitive_snapshot_limit_exceeded') throw error;
      throw new Error('sensitive_snapshot_unavailable');
    }
    if (entries.size + children.length > sensitiveEntryLimit) throw new Error('sensitive_snapshot_limit_exceeded');
    for (const name of children) addTree(path.join(absolute, name), `${relative}/${name}`, depth + 1);
  };

  const rootNames = readDirectory(workspace, discoveryEntryLimit);
  for (const name of rootNames) {
    if (name === '.env' || name.startsWith('.env.') || ['.runtime', 'runtime', 'data'].includes(name)) {
      addTree(path.join(workspace, name), name);
    }
  }
  const codexDir = path.join(workspace, '.codex');
  try {
    const stat = fs.lstatSync(codexDir, { bigint: true });
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    entries.set('.codex', { path: '.codex', ...metadata(stat, kind) });
    if (kind === 'directory') {
      addTree(path.join(codexDir, 'auth.json'), '.codex/auth.json');
      addTree(path.join(codexDir, 'sessions'), '.codex/sessions');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('sensitive_snapshot_unavailable');
  }

  const skipSensitiveSubtree = (relative) => ['.runtime', 'runtime', 'data', '.codex/auth.json', '.codex/sessions']
    .some((root) => relative === root || relative.startsWith(`${root}/`));
  let visited = 0;
  const discoverNestedEnv = (absolute, relative, depth) => {
    if (depth > DISCOVERY_DEPTH_LIMIT) throw new Error('sensitive_snapshot_limit_exceeded');
    let children;
    try { children = readDirectory(absolute, discoveryEntryLimit - visited, true); } catch (error) {
      if (error?.message === 'sensitive_snapshot_limit_exceeded') throw error;
      throw new Error('sensitive_snapshot_unavailable');
    }
    for (const child of children) {
      visited += 1;
      if (visited > discoveryEntryLimit) throw new Error('sensitive_snapshot_limit_exceeded');
      const childPath = relative ? `${relative}/${child.name}` : child.name;
      if (child.name === '.git' || child.name === 'node_modules' || skipSensitiveSubtree(childPath)) continue;
      const childAbsolute = path.join(absolute, child.name);
      if (child.name === '.env' || child.name.startsWith('.env.')) {
        addTree(childAbsolute, childPath);
        continue;
      }
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        let stat;
        try { stat = fs.lstatSync(childAbsolute); } catch (_) {
          throw new Error('sensitive_snapshot_unavailable');
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('sensitive_snapshot_unavailable');
        discoverNestedEnv(childAbsolute, childPath, depth + 1);
      } else if (!child.isFile()) {
        throw new Error('sensitive_snapshot_unavailable');
      }
    }
  };
  discoverNestedEnv(workspace, '', 0);
  if (entries.size > sensitiveEntryLimit) throw new Error('sensitive_snapshot_limit_exceeded');
  return [...entries.values()].sort(compare);
}

function takeSnapshot(workspace, limits) {
  try {
    if (runGit(workspace, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
      return { kind: 'unavailable', reason: 'not_a_git_work_tree' };
    }
    const prefix = runGit(workspace, ['rev-parse', '--show-prefix']).trim();
    let head = null;
    try { head = runGit(workspace, ['rev-parse', 'HEAD']).trim() || null; } catch (_) { head = null; }
    const entries = parseStatus(runGit(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']))
      .map(({ path: file, status }) => {
        // Porcelain paths are repository-root-relative even for a subtree query; report them workspace-relative.
        const rel = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file;
        return { path: rel, status, sha256: isSensitivePath(rel) ? null : hashPath(path.join(workspace, rel)) };
      })
      .sort(compare);
    const protectedEntries = sensitiveEntries(workspace, limits);
    const fingerprint = sha256(JSON.stringify({ head, entries, protectedEntries }));
    return { kind: 'git', head, entries, protectedEntries, fingerprint };
  } catch (error) {
    return { kind: 'unavailable', reason: String(error?.message || error).split('\n')[0] };
  }
}

function diffSnapshots(before, after, workspace) {
  if (before?.kind !== 'git' || after?.kind !== 'git') {
    return { known: false, headChanged: false, changedPaths: [] };
  }
  const key = (entries) => new Map(entries.map((entry) => [entry.path, `${entry.status}\0${entry.sha256}`]));
  const was = key(before.entries);
  const now = key(after.entries);
  const changed = new Set();
  for (const file of new Set([...was.keys(), ...now.keys()])) {
    if (was.get(file) !== now.get(file)) changed.add(file);
  }
  if (!Array.isArray(before.protectedEntries) || !Array.isArray(after.protectedEntries)) {
    return { known: false, headChanged: false, changedPaths: [] };
  }
  const protectedKey = (entries) => new Map(entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  const protectedBefore = protectedKey(before.protectedEntries);
  const protectedAfter = protectedKey(after.protectedEntries);
  for (const file of new Set([...protectedBefore.keys(), ...protectedAfter.keys()])) {
    if (protectedBefore.get(file) !== protectedAfter.get(file)) changed.add(file);
  }
  const headChanged = before.head !== after.head;
  // Born -> unborn (checkout --orphan): the old tree vanished from HEAD and nothing can be diffed.
  if (before.head && !after.head) return { known: false, headChanged, changedPaths: [] };
  if (headChanged && after.head && workspace) {
    try {
      if (before.head) {
        for (const file of runGit(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--relative', '-z', before.head, after.head]).split('\0')) {
          if (file) changed.add(file);
        }
      } else {
        // First commit in a repository that had none: every committed path in the subtree is new.
        const prefix = runGit(workspace, ['rev-parse', '--show-prefix']).trim();
        for (const file of runGit(workspace, ['ls-tree', '-r', '--name-only', '-z', '--full-tree', after.head]).split('\0')) {
          if (!file || (prefix && !file.startsWith(prefix))) continue;
          changed.add(prefix ? file.slice(prefix.length) : file);
        }
      }
    } catch (_) {
      return { known: false, headChanged, changedPaths: [] };
    }
  }
  return { known: true, headChanged, changedPaths: [...changed].sort() };
}

module.exports = { takeSnapshot, diffSnapshots };
