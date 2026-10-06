'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const childProcess = require('node:child_process');
const { nonInteractiveEnv } = require('./git-adapter');

// Per-path changed-line counts for the adaptive route gate. Fixed argv, no shell, same hardening
// as the Git adapter (no fsmonitor, no hooks, no external diff driver).
const HARDENING_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30 * 1000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

function defaultRunGit(workspace) {
  const exec = promisify(childProcess.execFile);
  const env = nonInteractiveEnv();
  return async (argv) => {
    const result = await exec('git', [...HARDENING_ARGS, ...argv], { cwd: workspace, env, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return typeof result === 'string' ? result : result.stdout;
  };
}

function safeRel(file) {
  return typeof file === 'string' && file !== '' && !file.includes('\0') && !file.startsWith('-')
    && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
}

/**
 * Returns [{ path, addedLines, removedLines }] for every path, or null when any count is unknown
 * (binary file, oversized or unreadable untracked file, unsafe path, git failure).
 */
async function countChangedLines({ workspace, paths, runGit } = {}) {
  try {
    if (typeof workspace !== 'string' || !workspace || !Array.isArray(paths) || !paths.every(safeRel)) return null;
    if (paths.length === 0) return [];
    const git = typeof runGit === 'function' ? runGit : defaultRunGit(workspace);
    const tracked = new Set((await git(['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean));
    const trackedPaths = paths.filter((file) => tracked.has(file));
    const counts = new Map();
    if (trackedPaths.length > 0) {
      const out = await git(['diff', '--numstat', '--no-renames', '--relative', 'HEAD', '--', ...trackedPaths]);
      for (const line of out.split('\n')) {
        if (!line) continue;
        const [added, removed, ...rest] = line.split('\t');
        if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) return null;
        counts.set(rest.join('\t'), { addedLines: Number(added), removedLines: Number(removed) });
      }
    }
    const rows = [];
    for (const file of paths) {
      if (tracked.has(file)) {
        // A tracked path absent from numstat has no difference from HEAD.
        rows.push({ path: file, ...(counts.get(file) || { addedLines: 0, removedLines: 0 }) });
        continue;
      }
      const full = path.join(workspace, file);
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return null;
      let newlines = 0;
      for (const byte of fs.readFileSync(full)) if (byte === 10) newlines += 1;
      rows.push({ path: file, addedLines: newlines, removedLines: 0 });
    }
    return rows;
  } catch (_) {
    return null;
  }
}

module.exports = { countChangedLines };
