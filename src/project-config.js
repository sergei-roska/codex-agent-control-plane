'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateAcceptanceContract } = require('./acceptance');

const MAX_CHECKS = 20;
const MAX_BASE_REF = 200;
const MAX_DESCRIPTION = 200;
const PREFIX_PATTERN = /^[a-z0-9][a-z0-9/_-]{0,30}$/;
const TOP_KEYS = ['baseRef', 'branchPrefixes', 'checks'];
const PREFIX_KEYS = ['feature', 'bugfix', 'docs'];
const CHECK_KEYS = ['id', 'argv', 'timeoutMs', 'description'];

const DEFAULT_CONFIG = Object.freeze({
  baseRef: 'main',
  branchPrefixes: Object.freeze({ feature: 'feature/', bugfix: 'fix/', docs: 'docs/' }),
  checks: Object.freeze([]),
});

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has unknown field "${key}"`);
  }
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw)) throw new TypeError('project config must be an object');
  rejectUnknown(raw, TOP_KEYS, 'project config');
  const baseRef = raw.baseRef === undefined ? DEFAULT_CONFIG.baseRef : raw.baseRef;
  if (typeof baseRef !== 'string' || !baseRef.trim() || baseRef.length > MAX_BASE_REF) {
    throw new TypeError(`baseRef must be a non-empty string of at most ${MAX_BASE_REF} chars`);
  }
  const prefixesRaw = raw.branchPrefixes === undefined ? {} : raw.branchPrefixes;
  if (!isPlainObject(prefixesRaw)) throw new TypeError('branchPrefixes must be an object');
  rejectUnknown(prefixesRaw, PREFIX_KEYS, 'branchPrefixes');
  const branchPrefixes = {};
  for (const key of PREFIX_KEYS) {
    const prefix = prefixesRaw[key] === undefined ? DEFAULT_CONFIG.branchPrefixes[key] : prefixesRaw[key];
    if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix) || !/[/-]$/.test(prefix)) {
      throw new TypeError(`branchPrefixes.${key} must match ${PREFIX_PATTERN} and end with "/" or "-"`);
    }
    branchPrefixes[key] = prefix;
  }
  const checksRaw = raw.checks === undefined ? [] : raw.checks;
  if (!Array.isArray(checksRaw)) throw new TypeError('checks must be an array');
  if (checksRaw.length > MAX_CHECKS) throw new TypeError(`checks has more than ${MAX_CHECKS} entries`);
  const descriptions = checksRaw.map((check, index) => {
    if (!isPlainObject(check)) throw new TypeError(`checks[${index}] must be an object`);
    rejectUnknown(check, CHECK_KEYS, `checks[${index}]`);
    const description = check.description === undefined ? '' : check.description;
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) {
      throw new TypeError(`checks[${index}].description must be a string of at most ${MAX_DESCRIPTION} chars`);
    }
    return description;
  });
  // validateAcceptanceContract caps at 10 entries; validate in chunks to allow 20 while reusing its rules.
  const validated = [];
  for (let start = 0; start < checksRaw.length; start += 10) {
    const chunk = checksRaw.slice(start, start + 10).map(({ id, argv, timeoutMs }) => {
      const out = { id, argv };
      if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
      return out;
    });
    validated.push(...validateAcceptanceContract({ requiredChecks: chunk }).requiredChecks);
  }
  const seen = new Set();
  const checks = validated.map((check, index) => {
    if (seen.has(check.id)) throw new TypeError(`checks[${index}].id "${check.id}" is duplicated`);
    seen.add(check.id);
    return { id: check.id, argv: check.argv, timeoutMs: check.timeoutMs, description: descriptions[index] };
  });
  return { baseRef: baseRef.trim(), branchPrefixes, checks };
}

function loadProjectConfig({ filePath } = {}) {
  let bytes = null;
  if (filePath) {
    try {
      bytes = fs.readFileSync(filePath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  if (bytes === null) {
    const config = normalizeConfig({});
    return { ...config, revision: sha256(JSON.stringify(config)), source: 'defaults' };
  }
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new TypeError(`project config is not valid JSON: ${error.message}`);
  }
  return { ...normalizeConfig(raw), revision: sha256(bytes), source: 'file' };
}

function defaultProjectConfigPath(stateFile, env = process.env) {
  if (env.CODEX_PROJECT_CONFIG) return env.CODEX_PROJECT_CONFIG;
  return path.join(path.dirname(path.resolve(stateFile)), 'project.json');
}

module.exports = { loadProjectConfig, defaultProjectConfigPath, DEFAULT_CONFIG };
