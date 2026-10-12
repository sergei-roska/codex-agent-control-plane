'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Ignored files are invisible to `git status`, so they are outside this snapshot.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function runGit(workspace, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', workspace, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: GIT_MAX_BUFFER,
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

function takeSnapshot(workspace) {
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
        return { path: rel, status, sha256: hashPath(path.join(workspace, rel)) };
      })
      .sort(compare);
    const fingerprint = sha256(JSON.stringify({ head, entries }));
    return { kind: 'git', head, entries, fingerprint };
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
  const headChanged = before.head !== after.head;
  // Born -> unborn (checkout --orphan): the old tree vanished from HEAD and nothing can be diffed.
  if (before.head && !after.head) return { known: false, headChanged, changedPaths: [] };
  if (headChanged && after.head && workspace) {
    try {
      if (before.head) {
        for (const file of runGit(workspace, ['diff', '--name-only', '--relative', '-z', before.head, after.head]).split('\0')) {
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
