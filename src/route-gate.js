'use strict';

// Code-side authority for the adaptive delivery route (ADR adaptive-delivery-route D2/D3).
// The model may only propose a route; these pure functions decide and promote.

const DEFAULT_ROUTE_LIMITS = Object.freeze({ maxFiles: 3, maxChangedLines: 30, maxChangedBytes: 20000 });
const MODES = Object.freeze(['off', 'shadow', 'on']);
const SENSITIVE_WORDS = Object.freeze([
  'auth', 'authentication', 'authorization', 'authz', 'permission', 'permissions', 'access',
  'security', 'session', 'sessions', 'oauth', 'credential', 'credentials', 'secret', 'secrets',
]);
const MANIFESTS = Object.freeze([
  'composer.json', 'composer.lock', 'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.gitlab-ci.yml', 'dockerfile', '.lando.yml', 'schema.yml',
]);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

function resolveRouteLimits(policyLimits) {
  const limits = isObject(policyLimits) ? policyLimits : {};
  const extra = Array.isArray(limits.protectedPaths)
    ? limits.protectedPaths.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [];
  return {
    maxFiles: isPositiveInt(limits.maxFiles) ? limits.maxFiles : DEFAULT_ROUTE_LIMITS.maxFiles,
    maxChangedLines: isPositiveInt(limits.maxChangedLines) ? limits.maxChangedLines : DEFAULT_ROUTE_LIMITS.maxChangedLines,
    maxChangedBytes: isPositiveInt(limits.maxChangedBytes) ? limits.maxChangedBytes : DEFAULT_ROUTE_LIMITS.maxChangedBytes,
    protectedPaths: extra,
  };
}

// Glob-like matcher: ** crosses directories, * and ? stay inside a segment. A pattern ending
// in "/" is a directory prefix; a pattern without "/" matches the file name at any depth.
function matchesPattern(relPath, pattern) {
  const lowerPath = relPath.toLowerCase();
  let pat = pattern.toLowerCase().replace(/^\.\//, '');
  if (pat === '') return false;
  const dir = pat.endsWith('/');
  if (dir) pat = pat.slice(0, -1);
  let source = '';
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      source += '.*';
      i += 1;
      if (pat[i + 1] === '/') i += 1;
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = pat.includes('/') ? '^' : '^(?:.*/)?';
  const tail = dir ? '(?:/.*)?$' : '$';
  return new RegExp(`${prefix}${source}${tail}`).test(lowerPath);
}

// rawName keeps the original case: Drupal site files are lower-case, a PSR-4 Settings.php is a class.
function builtInProtected(segments, rawName) {
  const name = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  const stem = name.split('.')[0];
  if (segments.some((seg) => SENSITIVE_WORDS.includes(seg)) || SENSITIVE_WORDS.includes(stem)) return true;
  if (segments[0] === 'config' || (segments[0] === 'web' && segments[1] === 'config' && segments.length > 2)) return true;
  if (dirs.includes('config')) return true;
  if (name.endsWith('.routing.yml') || name.endsWith('.permissions.yml') || name === '.htaccess') return true;
  if (dirs.some((seg) => seg === 'migration' || seg === 'migrations' || seg === 'db' || seg === 'database')) return true;
  if (name.endsWith('.install')) return true;
  if (MANIFESTS.includes(name)) return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|sql)$/.test(name)) return true;
  if (rawName === 'settings.php' || rawName === 'services.yml' || /^settings\..+\.php$/.test(rawName)) return true;
  if (/^docker-compose.*\.ya?ml$/.test(name)) return true;
  if (dirs.some((seg) => seg === '.github' || seg === '.ddev')) return true;
  return false;
}

function isProtectedPath(relPath, extraPatterns = []) {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) return true;
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return true;
  const segments = normalized.toLowerCase().split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segments.length === 0 || segments.includes('..')) return true;
  const rawSegments = normalized.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (builtInProtected(segments, rawSegments[rawSegments.length - 1])) return true;
  const extras = Array.isArray(extraPatterns) ? extraPatterns : [];
  return extras.some((pattern) => typeof pattern === 'string' && matchesPattern(segments.join('/'), pattern));
}

// A file-like entry names one file: no trailing slash and a dot in the last path segment.
function isFileLikeEntry(entry) {
  if (typeof entry !== 'string' || entry.endsWith('/')) return false;
  return entry.split('/').pop().includes('.');
}

function evaluatePlanRoute({ classification, plan, policy } = {}) {
  const planObj = isObject(plan) ? plan : {};
  const policyObj = isObject(policy) ? policy : {};
  const limits = resolveRouteLimits(policyObj.routeLimits);
  const mode = MODES.includes(policyObj.adaptiveRoute) ? policyObj.adaptiveRoute : 'off';
  const requested = planObj.route === 'lean' || planObj.route === 'full' ? planObj.route : null;
  const files = [];
  (Array.isArray(planObj.stages) ? planObj.stages : []).forEach((stage) => {
    const list = isObject(stage) && Array.isArray(stage.allowedFiles) ? stage.allowedFiles : [];
    list.forEach((file) => { if (!files.includes(file)) files.push(file); });
  });
  const stageList = Array.isArray(planObj.stages) ? planObj.stages : [];
  const checks = Array.isArray(planObj.checkIds) ? planObj.checkIds : [];

  const reasons = [];
  if (classification !== 'bugfix') reasons.push('not_bugfix');
  if (requested !== 'lean') reasons.push('not_requested');
  if (files.length > limits.maxFiles) reasons.push('too_many_files');
  files.forEach((file) => {
    if (isProtectedPath(file, limits.protectedPaths)) reasons.push(`protected_path:${file}`);
  });
  files.forEach((file) => {
    if (!isFileLikeEntry(file)) reasons.push(`non_file_entry:${file}`);
  });
  if (stageList.some((stage) => isObject(stage) && stage.presetStageKey === null)) {
    reasons.push('optional_stage');
  }
  if (checks.length < 1) reasons.push('no_mechanical_check');

  const verdict = reasons.length === 0 ? 'lean' : 'full';
  if (mode === 'off' && verdict === 'lean') reasons.push('policy_off');
  return { requested, verdict, effective: mode === 'on' ? verdict : 'full', mode, reasons };
}

function evaluateDelta({ allowedFiles, changed, checksPassed, scopeExpansions, needsDecision, limits } = {}) {
  const lim = resolveRouteLimits(limits);
  const allowed = Array.isArray(allowedFiles) ? allowedFiles : [];
  const reasons = [];
  let unknown = !Array.isArray(changed);
  const entries = unknown ? [] : changed;
  let total = 0;
  let totalBytes = 0;
  entries.forEach((entry) => {
    const ok = isObject(entry) && typeof entry.path === 'string'
      && Number.isInteger(entry.addedLines) && entry.addedLines >= 0
      && Number.isInteger(entry.removedLines) && entry.removedLines >= 0;
    if (!ok || !Number.isInteger(entry.bytes) || entry.bytes < 0) unknown = true;
    else {
      total += entry.addedLines + entry.removedLines;
      totalBytes += entry.bytes;
    }
  });
  if (unknown) reasons.push('delta_unknown');
  if (checksPassed !== true) reasons.push('check_not_passed');
  const paths = entries.filter((entry) => isObject(entry) && typeof entry.path === 'string').map((entry) => entry.path);
  const allowedEntries = allowed.filter((entry) => typeof entry === 'string').map((entry) => entry.replace(/\/+$/, ''));
  paths.forEach((file) => {
    if (!allowedEntries.some((entry) => file === entry || file.startsWith(`${entry}/`))) reasons.push(`outside_allowed_files:${file}`);
  });
  paths.forEach((file) => { if (isProtectedPath(file, lim.protectedPaths)) reasons.push(`protected_path:${file}`); });
  if (total > lim.maxChangedLines) reasons.push('too_many_changed_lines');
  if (totalBytes > lim.maxChangedBytes) reasons.push('too_many_changed_bytes');
  if (entries.some((entry) => isObject(entry) && entry.modeChanged === true)) reasons.push('mode_change');
  if (!(scopeExpansions === 0 || scopeExpansions === undefined || scopeExpansions === null) && !(Number.isFinite(scopeExpansions) && scopeExpansions <= 0)) {
    reasons.push('scope_expansion');
  }
  if (needsDecision === true) reasons.push('needs_decision');
  return { promote: reasons.length > 0, reasons };
}

module.exports = { DEFAULT_ROUTE_LIMITS, resolveRouteLimits, isProtectedPath, evaluatePlanRoute, evaluateDelta };
