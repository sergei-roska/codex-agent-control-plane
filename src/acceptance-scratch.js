'use strict';

// Opt-in per-run scratch directory for sandboxed acceptance checks (docs/execution-boundary-contract.md).
// One acceptance run gets one fresh directory `<baseDir>/run-XXXXXX` (mode 0700, real path) that is the only
// writable root of its sandboxed checks. It holds two sibling subdirectories that never nest or overlap:
//   tmp/      TMPDIR of the check
//   scratch/  every configured variable (for example TEAMWORK_TEST_SCRATCH_ROOT)
// The directory is removed after the run, whatever its outcome.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectSettingsError, normalizeAcceptanceScratch } = require('./project-settings');

const TMP_NAME = 'tmp';
const SCRATCH_NAME = 'scratch';

class ScratchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScratchError';
  }
}

function overlaps(a, b) {
  const rel = path.relative(a, b);
  const relBack = path.relative(b, a);
  const inside = (value) => value === '' || (value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
  return inside(rel) || inside(relBack);
}

function realOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch (_) {
    return null;
  }
}

// Roots the scratch directory must stay out of: /tmp and the effective temp dirs of this process.
function defaultForbiddenRoots() {
  return ['/tmp', os.tmpdir(), process.env.TMPDIR].filter(Boolean);
}

/** The sandbox policy of a run with a scratch directory; only `dir` is writable, /tmp and TMPDIR are not added. */
function scratchSandboxPolicy(dir) {
  return {
    type: 'workspaceWrite', writableRoots: [dir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  };
}

function makeWritable(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (_) {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  try { fs.chmodSync(target, stat.mode | 0o700); } catch (_) { /* best effort */ }
  let names = [];
  try { names = fs.readdirSync(target); } catch (_) { /* best effort */ }
  for (const name of names) makeWritable(path.join(target, name));
}

function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // A check may leave read-only directories behind; make them writable and retry once.
    makeWritable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fs.existsSync(dir)) throw new Error(`directory still exists: ${dir}`);
}

/**
 * Creates the run directory for `config` ({ env, baseDir }) next to a workspace. Returns
 * { dir, tmp, scratch, env, policy, cleanup() }; cleanup() never throws and returns { cleaned, error }.
 * Throws ScratchError when the location is unsafe (inside or around the workspace, inside /tmp, not owned by
 * this user, writable by others) and ProjectSettingsError for an invalid config.
 */
function provisionScratch(config, { workspace, forbiddenRoots = defaultForbiddenRoots() } = {}) {
  const normalized = normalizeAcceptanceScratch(config);
  if (!normalized || !normalized.baseDir) throw new ProjectSettingsError('acceptance scratch needs an absolute baseDir');
  fs.mkdirSync(normalized.baseDir, { recursive: true, mode: 0o700 });
  // The configured path itself must be the real directory: no symlink at baseDir or in any ancestor.
  if (fs.lstatSync(normalized.baseDir).isSymbolicLink()) throw new ScratchError(`scratch base is a symlink: ${normalized.baseDir}`);
  const base = fs.realpathSync(normalized.baseDir);
  if (base !== normalized.baseDir) throw new ScratchError(`scratch base is not a real path (resolves to ${base}): ${normalized.baseDir}`);
  const baseStat = fs.lstatSync(base);
  if (!baseStat.isDirectory()) throw new ScratchError(`scratch base is not a directory: ${base}`);
  if (typeof process.getuid === 'function' && baseStat.uid !== process.getuid()) throw new ScratchError(`scratch base is not owned by this user: ${base}`);
  if ((baseStat.mode & 0o022) !== 0) throw new ScratchError(`scratch base is writable by others: ${base}`);
  const roots = [{ label: 'the workspace', path: realOrNull(workspace) || path.resolve(workspace) }]
    .concat(forbiddenRoots.map((root) => ({ label: `${root}`, path: realOrNull(root) || path.resolve(root) })));
  for (const root of roots) {
    if (overlaps(base, root.path)) throw new ScratchError(`scratch base ${base} overlaps ${root.label}`);
  }
  const dir = fs.mkdtempSync(path.join(base, 'run-'));
  try {
    fs.chmodSync(dir, 0o700);
    if (fs.realpathSync(dir) !== dir || fs.lstatSync(dir).isSymbolicLink()) throw new ScratchError(`scratch directory is not a real path: ${dir}`);
    const tmp = path.join(dir, TMP_NAME);
    const scratch = path.join(dir, SCRATCH_NAME);
    fs.mkdirSync(tmp, { mode: 0o700 });
    fs.mkdirSync(scratch, { mode: 0o700 });
    const env = { TMPDIR: tmp };
    for (const name of normalized.env) env[name] = scratch;
    let result = null;
    return {
      dir,
      tmp,
      scratch,
      env,
      policy: scratchSandboxPolicy(dir),
      cleanup() {
        if (result) return result;
        try {
          removeTree(dir);
          result = { cleaned: true, error: null };
        } catch (error) {
          result = { cleaned: false, error: String(error?.message || error).slice(0, 300) };
        }
        return result;
      },
    };
  } catch (error) {
    try { removeTree(dir); } catch (_) { /* nothing more to do */ }
    throw error;
  }
}

module.exports = { provisionScratch, scratchSandboxPolicy, ScratchError, TMP_NAME, SCRATCH_NAME };
