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
const MAX_PATHS = 100;

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

// Parses numstat -z output (rename form disabled): records "added<TAB>removed<TAB>path" separated by NUL.
function parseNumstatZ(out) {
  const counts = new Map();
  for (const record of out.split('\0')) {
    if (!record) continue;
    const first = record.indexOf('\t');
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1);
    if (second < 0) return null;
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) return null;
    counts.set(record.slice(second + 1), { addedLines: Number(added), removedLines: Number(removed) });
  }
  return counts;
}

// Parses raw -z output: ":oldmode newmode oldsha newsha status" NUL path NUL. Returns the set of paths
// whose mode changed, or null when the output is not understood.
function parseModeChanges(out) {
  const changed = new Set();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const meta = tokens[i];
    if (!meta) continue;
    if (!meta.startsWith(':')) return null;
    const fields = meta.slice(1).split(' ');
    const file = tokens[i + 1];
    if (fields.length < 5 || typeof file !== 'string' || file === '') return null;
    i += 1;
    if (fields[0] !== '000000' && fields[1] !== '000000' && fields[0] !== fields[1]) changed.add(file);
  }
  return changed;
}

/**
 * Returns [{ path, addedLines, removedLines, bytes, modeChanged? }] for every path, or null when any
 * count is unknown (binary file, oversized or unreadable untracked file, unsafe path, a tracked path
 * missing from the numstat output, git failure). `bytes` is the patch size (tracked) or file size (untracked).
 */
async function countChangedLines({ workspace, paths, runGit } = {}) {
  try {
    if (typeof workspace !== 'string' || !workspace || !Array.isArray(paths) || !paths.every(safeRel)) return null;
    if (paths.length === 0) return [];
    if (paths.length > MAX_PATHS) return null;
    const git = typeof runGit === 'function' ? runGit : defaultRunGit(workspace);
    const tracked = new Set((await git(['--literal-pathspecs', 'ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean));
    const trackedPaths = paths.filter((file) => tracked.has(file));
    let counts = new Map();
    let modes = new Set();
    const bytes = new Map();
    if (trackedPaths.length > 0) {
      counts = parseNumstatZ(await git(['--literal-pathspecs', 'diff', '--numstat', '-z', '--no-renames', '--relative', 'HEAD', '--', ...trackedPaths]));
      if (!counts) return null;
      modes = parseModeChanges(await git(['--literal-pathspecs', 'diff', 'HEAD', '--raw', '-z', '--no-renames', '--relative', '--', ...trackedPaths]));
      if (!modes) return null;
      for (const file of trackedPaths) {
        if (!counts.has(file)) continue;
        const patch = await git(['--literal-pathspecs', 'diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', '--unified=0', '--', file]);
        bytes.set(file, Buffer.byteLength(patch));
      }
    }
    const rows = [];
    for (const file of paths) {
      if (tracked.has(file)) {
        // A tracked path git did not report is unknown, not zero: a mismatched name must not fail open.
        const row = counts.get(file);
        if (!row) return null;
        rows.push({ path: file, ...row, bytes: bytes.get(file), ...(modes.has(file) ? { modeChanged: true } : {}) });
        continue;
      }
      const full = path.join(workspace, file);
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return null;
      let newlines = 0;
      for (const byte of fs.readFileSync(full)) if (byte === 10) newlines += 1;
      rows.push({ path: file, addedLines: newlines, removedLines: 0, bytes: stat.size });
    }
    return rows;
  } catch (_) {
    return null;
  }
}

module.exports = { countChangedLines };
