'use strict';

// Per-project owner settings, kept in one JSON file per project: `.runtime/projects/<id>/project-settings.json`.
// Like the role overrides, the file is edited by the owner only while the project server is stopped and the
// server reads it once at startup. Nothing the lead agent produces can reach these settings.
//
// Settings:
//   acceptanceScratch: { env: ["NAME", ...], baseDir?: "/absolute/dir" }
//     Opt-in. Sandboxed acceptance checks of the project get a fresh per-run scratch directory (see
//     src/acceptance-scratch.js) and each listed variable names its scratch subdirectory.
//   ownerChecks: ["command arg ...", ...]
//     Opt-in, 1-8 commands. Default owner acceptance checks of a new run that carries no explicit checks
//     (see makeLeadExecutor in src/server.js). Each command is parsed like a CLI `--check`; owner checks run
//     on the host outside the Codex sandbox. Absent, null, or [] disables the default.

const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_VERSION = 1;
const MAX_SCRATCH_ENV = 8;
const MAX_OWNER_CHECKS = 8;
const MAX_ENV_NAME = 64;
const MAX_BASE_DIR = 1024;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// Names the control plane or the platform owns. TMPDIR is always set to the run's tmp directory.
const RESERVED_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'IFS', 'ENV', 'BASH_ENV', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'LANG',
]);
const RESERVED_ENV_PREFIXES = ['LD_', 'DYLD_', 'LC_', 'PYTHON', 'NODE_', 'NPM_', 'GIT_', 'XDG_', 'CODEX_', 'BASH_FUNC_'];

class ProjectSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectSettingsError';
  }
}

/**
 * Validates the acceptanceScratch setting. Returns null (disabled) for undefined or null, else
 * { env: string[], baseDir?: string }. Throws ProjectSettingsError on any problem.
 */
function normalizeAcceptanceScratch(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new ProjectSettingsError('acceptanceScratch must be an object');
  for (const key of Object.keys(input)) {
    if (key !== 'env' && key !== 'baseDir') throw new ProjectSettingsError(`acceptanceScratch has unknown field "${key}"`);
  }
  const env = input.env === undefined ? [] : input.env;
  if (!Array.isArray(env)) throw new ProjectSettingsError('acceptanceScratch.env must be an array of variable names');
  if (env.length > MAX_SCRATCH_ENV) throw new ProjectSettingsError(`acceptanceScratch.env has more than ${MAX_SCRATCH_ENV} names`);
  const seen = new Set();
  for (const name of env) {
    if (typeof name !== 'string' || name.length > MAX_ENV_NAME || !ENV_NAME.test(name)) {
      throw new ProjectSettingsError(`acceptanceScratch.env names must match ${ENV_NAME} (at most ${MAX_ENV_NAME} chars)`);
    }
    if (RESERVED_ENV.has(name) || RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new ProjectSettingsError(`acceptanceScratch.env name "${name}" is reserved`);
    }
    if (seen.has(name)) throw new ProjectSettingsError(`acceptanceScratch.env name "${name}" is duplicated`);
    seen.add(name);
  }
  const out = { env: [...env] };
  if (input.baseDir !== undefined) {
    const dir = input.baseDir;
    if (typeof dir !== 'string' || !dir || dir.length > MAX_BASE_DIR || dir.includes('\0') || !path.isAbsolute(dir) || path.resolve(dir) !== dir) {
      throw new ProjectSettingsError('acceptanceScratch.baseDir must be a normalized absolute path');
    }
    out.baseDir = dir;
  }
  return out;
}

/**
 * Validates the ownerChecks setting. Returns null (disabled) for undefined, null, or [], else the array of
 * trimmed command strings. Each one must parse with parseCheckCommand and pass owner contract validation.
 * Throws ProjectSettingsError on any problem.
 */
function normalizeOwnerChecks(input) {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) throw new ProjectSettingsError('ownerChecks must be an array of command strings');
  if (input.length === 0) return null;
  if (input.length > MAX_OWNER_CHECKS) throw new ProjectSettingsError(`ownerChecks has more than ${MAX_OWNER_CHECKS} entries`);
  const commands = input.map((command, index) => {
    if (typeof command !== 'string' || command.trim() === '') throw new ProjectSettingsError(`ownerChecks[${index}] must be a non-empty command string`);
    return command.trim();
  });
  // Loaded lazily: ./acceptance reaches ./acceptance-scratch, which requires this module at load time.
  const { parseCheckCommand, validateAcceptanceContract } = require('./acceptance');
  try {
    validateAcceptanceContract({ requiredChecks: commands.map((command, index) => parseCheckCommand(command, index)) });
  } catch (error) {
    throw new ProjectSettingsError(`ownerChecks is not a valid check list: ${error && error.message}`);
  }
  return commands;
}

/** Validates a whole settings document. Owner opt-ins are strict and default off. */
function validateSettingsDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ProjectSettingsError('Settings file must be an object');
  if (doc.version !== SETTINGS_VERSION) throw new ProjectSettingsError(`Unsupported settings version ${JSON.stringify(doc.version)}`);
  for (const key of Object.keys(doc)) {
    if (!['version', 'acceptanceScratch', 'ownerChecks', 'aut03LeadSkillEnabled', 'updatedAt'].includes(key)) throw new ProjectSettingsError(`Unknown settings field: ${key}`);
  }
  if (doc.aut03LeadSkillEnabled !== undefined && typeof doc.aut03LeadSkillEnabled !== 'boolean') {
    throw new ProjectSettingsError('aut03LeadSkillEnabled must be a boolean');
  }
  return {
    acceptanceScratch: normalizeAcceptanceScratch(doc.acceptanceScratch),
    ownerChecks: normalizeOwnerChecks(doc.ownerChecks),
    aut03LeadSkillEnabled: doc.aut03LeadSkillEnabled === true,
  };
}

/**
 * Reads the settings file. Missing file -> defaults (everything disabled). Invalid file -> defaults plus a
 * `warning`; a broken file never enables anything. This never throws.
 */
function readSettingsFile(file) {
  const defaults = { acceptanceScratch: null, ownerChecks: null, aut03LeadSkillEnabled: false };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ...defaults, warning: null };
    return { ...defaults, warning: `Project settings ignored: cannot read ${file}: ${error && error.message}` };
  }
  try {
    return { ...validateSettingsDocument(JSON.parse(raw)), warning: null };
  } catch (error) {
    return { ...defaults, warning: `Project settings ignored: ${file} is invalid: ${error && error.message}` };
  }
}

/**
 * The acceptanceScratch setting the server hands to the orchestrator: `env` plus an absolute `baseDir`
 * (the configured one, else `<settings dir>/acceptance-scratch`). Null when disabled.
 */
function resolveAcceptanceScratch(settings, file) {
  const scratch = settings?.acceptanceScratch;
  if (!scratch) return null;
  return { env: [...scratch.env], baseDir: scratch.baseDir || path.join(path.dirname(file), 'acceptance-scratch') };
}

module.exports = {
  SETTINGS_VERSION,
  MAX_SCRATCH_ENV,
  MAX_OWNER_CHECKS,
  ProjectSettingsError,
  normalizeAcceptanceScratch,
  normalizeOwnerChecks,
  validateSettingsDocument,
  readSettingsFile,
  resolveAcceptanceScratch,
};
