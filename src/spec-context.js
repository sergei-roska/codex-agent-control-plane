'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const CONTEXT_VERSION = 'spec-context/v1';
const TRACEABILITY_VERSION = 'spec-traceability/v1';
const SHA256_RE = /^[a-f0-9]{64}$/;
const FEATURE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TASK_ID_RE = /^T[0-9]{3,6}$/;
const CHECKPOINT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RISK_TAGS = Object.freeze(['risk_change', 'performance', 'component_complete']);
const REVIEW_KINDS = Object.freeze(['routine', 'risk_change', 'performance', 'component_complete']);
const ARTIFACT_ROLES = Object.freeze(['spec', 'plan', 'tasks']);
const MAX_CONTEXT_BYTES = 1024 * 1024;
const MAX_MAP_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_FINDINGS = 200;
const MAX_ITEMS = 100;
const MAX_TEXT = 4000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addError(errors, code, fieldPath, message) {
  if (errors.length >= MAX_FINDINGS) return;
  errors.push({ code, path: String(fieldPath || '$').slice(0, 300), message: String(message).slice(0, 500) });
}

function exactObject(value, fields, fieldPath, errors) {
  if (!isPlainObject(value)) {
    addError(errors, 'object_required', fieldPath, 'Expected a plain object.');
    return false;
  }
  const expected = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) addError(errors, 'unknown_field', `${fieldPath}.${key}`, 'Field is not supported.');
  }
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) addError(errors, 'required_field', `${fieldPath}.${key}`, 'Required field is missing.');
  }
  return true;
}

function boundedString(value, fieldPath, errors, { min = 1, max = MAX_TEXT } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    addError(errors, 'string_bounds', fieldPath, `Expected a string with ${min}..${max} characters.`);
    return false;
  }
  return true;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false;
  if (value.includes('\\') || value.includes('\0') || /[\u0001-\u001f\u007f]/.test(value)) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (/[*?\[\]]/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function assertWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw new Error('workspace_root_invalid');
  const root = fs.realpathSync(workspaceRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('workspace_root_not_directory');
  return root;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function inspectWorkspacePath(workspaceRoot, relativePath, { mustExist = false, expectedType = null, rejectSymlinks = false } = {}) {
  if (!isSafeRelativePath(relativePath)) throw new Error('path_unsafe');
  const root = assertWorkspaceRoot(workspaceRoot);
  const parts = relativePath.split('/');
  let current = root;
  let exists = true;
  let finalStat = null;
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        exists = false;
        if (mustExist) throw new Error('path_missing');
        current = path.join(current, ...parts.slice(index));
        break;
      }
      throw new Error('path_unreadable');
    }
    let resolved = candidate;
    if (stat.isSymbolicLink()) {
      if (rejectSymlinks) throw new Error('path_symlink_forbidden');
      try { resolved = fs.realpathSync(candidate); } catch (_) { throw new Error('path_symlink_unresolved'); }
      if (!isWithin(root, resolved)) throw new Error('path_symlink_escape');
      stat = fs.statSync(resolved);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('path_ancestor_not_directory');
    current = resolved;
    finalStat = stat;
  }
  if (exists && expectedType) {
    if (expectedType === 'file' && !finalStat.isFile()) throw new Error('path_type_mismatch');
    if (expectedType === 'directory' && !finalStat.isDirectory()) throw new Error('path_type_mismatch');
  }
  return { root, path: path.resolve(root, ...parts), realPath: current, exists, type: !exists ? null : finalStat.isFile() ? 'file' : finalStat.isDirectory() ? 'directory' : 'other' };
}

function splitSourceLines(text) {
  if (typeof text !== 'string') throw new TypeError('source text must be a string');
  if (/\r(?!\n)/.test(text)) throw new Error('source_newline_unsupported');
  return text.length === 0 ? [''] : text.split(/\r\n|\n/);
}

function extractSourceLocation(source, startLine, endLine) {
  const text = Buffer.isBuffer(source) ? UTF8.decode(source) : source;
  const lines = splitSourceLines(text);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error('source_line_range_invalid');
  }
  return lines.slice(startLine - 1, endLine).join('\n');
}

function validateStringList(value, fieldPath, errors, { minItems = 0, maxItems = 100, maxChars = 500 } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    addError(errors, 'array_bounds', fieldPath, `Expected an array with ${minItems}..${maxItems} items.`);
    return false;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxChars) {
      addError(errors, 'string_bounds', `${fieldPath}[${index}]`, `Expected a non-empty string of at most ${maxChars} characters.`);
      return;
    }
    if (seen.has(item)) addError(errors, 'duplicate_value', `${fieldPath}[${index}]`, 'Duplicate value.');
    seen.add(item);
  });
  return true;
}

function validateScopeEntry(entry, fieldPath, errors) {
  if (!exactObject(entry, ['kind', 'path'], fieldPath, errors)) return false;
  if (!['file', 'directory'].includes(entry.kind)) addError(errors, 'scope_kind_invalid', `${fieldPath}.kind`, 'Scope kind must be file or directory.');
  if (!isSafeRelativePath(entry.path)) addError(errors, 'path_unsafe', `${fieldPath}.path`, 'Expected a safe workspace-relative path.');
  return true;
}

function validateSourceLocation(location, fieldPath, errors, sourceById) {
  if (!exactObject(location, ['sourceId', 'startLine', 'endLine'], fieldPath, errors)) return;
  if (typeof location.sourceId !== 'string' || !ID_RE.test(location.sourceId)) addError(errors, 'source_id_invalid', `${fieldPath}.sourceId`, 'Source ID is invalid.');
  if (!Number.isSafeInteger(location.startLine) || location.startLine < 1 || location.startLine > 1000000) addError(errors, 'source_line_invalid', `${fieldPath}.startLine`, 'Line number is out of bounds.');
  if (!Number.isSafeInteger(location.endLine) || location.endLine < 1 || location.endLine > 1000000) addError(errors, 'source_line_invalid', `${fieldPath}.endLine`, 'Line number is out of bounds.');
  if (Number.isSafeInteger(location.startLine) && Number.isSafeInteger(location.endLine) && location.endLine < location.startLine) addError(errors, 'source_line_order', fieldPath, 'endLine must be greater than or equal to startLine.');
  const source = sourceById.get(location.sourceId);
  if (!source) {
    addError(errors, 'source_reference_unknown', `${fieldPath}.sourceId`, 'Source reference does not resolve.');
    return;
  }
  if (source.lines && Number.isSafeInteger(location.endLine) && location.endLine > source.lines.length) {
    addError(errors, 'source_line_range_invalid', fieldPath, `Source has ${source.lines.length} lines.`);
  }
}

function scopePathContains(parent, child) {
  if (!parent || !child || typeof parent.path !== 'string' || typeof child.path !== 'string') return false;
  if (parent.kind === 'file') return child.kind === 'file' && parent.path === child.path;
  if (parent.kind !== 'directory') return false;
  if (parent.path === child.path) return child.kind === 'directory';
  return child.path.startsWith(`${parent.path}/`);
}

function scopesOverlap(left, right) {
  if (!left || !right || typeof left.path !== 'string' || typeof right.path !== 'string') return false;
  if (left.path === right.path) return true;
  if (left.kind === 'directory' && right.path.startsWith(`${left.path}/`)) return true;
  if (right.kind === 'directory' && left.path.startsWith(`${right.path}/`)) return true;
  return false;
}

function scopeAllowed(scope, writeScope) {
  if (!scope || !writeScope || !Array.isArray(writeScope.allow) || !Array.isArray(writeScope.deny)) return false;
  return writeScope.allow.some((allowed) => scopePathContains(allowed, scope))
    && !writeScope.deny.some((denied) => scopesOverlap(denied, scope));
}

function rulesForScope(scope, riskRules) {
  if (!Array.isArray(riskRules)) return [];
  return riskRules.filter((rule) => rule && scopePathContains(rule.path, scope));
}

function validateContextShape(context, errors) {
  const rootFields = ['schemaVersion', 'featureId', 'featureDir', 'sources', 'requirements', 'acceptanceCriteria', 'writeScope', 'riskRules', 'checks', 'priorEvidence', 'decisions'];
  if (!exactObject(context, rootFields, '$', errors)) return false;
  if (context.schemaVersion !== CONTEXT_VERSION) addError(errors, 'schema_version_unsupported', '$.schemaVersion', `Expected ${CONTEXT_VERSION}.`);
  if (typeof context.featureId !== 'string' || context.featureId.length > 64 || !FEATURE_ID_RE.test(context.featureId)) addError(errors, 'feature_id_invalid', '$.featureId', 'Feature ID must be a lowercase slug of at most 64 characters.');
  if (!isSafeRelativePath(context.featureDir)) addError(errors, 'path_unsafe', '$.featureDir', 'Expected a safe workspace-relative feature directory.');
  for (const [name, minimum, maximum] of [['sources', 1, 32], ['requirements', 1, 100], ['acceptanceCriteria', 1, 200], ['riskRules', 1, 200], ['checks', 1, 100], ['priorEvidence', 1, 200], ['decisions', 0, 200]]) {
    if (!Array.isArray(context[name]) || context[name].length < minimum || context[name].length > maximum) addError(errors, 'array_bounds', `$.${name}`, `Expected an array with ${minimum}..${maximum} entries.`);
  }
  return true;
}

function readSources(context, workspaceRoot, errors) {
  const loaded = new Map();
  if (!Array.isArray(context.sources)) return loaded;
  let totalBytes = 0;
  const seenIds = new Set();
  const seenPaths = new Set();
  context.sources.forEach((source, index) => {
    const label = `$.sources[${index}]`;
    if (!exactObject(source, ['id', 'path', 'sha256'], label, errors)) return;
    if (typeof source.id !== 'string' || !ID_RE.test(source.id) || source.id.length > 64) addError(errors, 'source_id_invalid', `${label}.id`, 'Source ID is invalid.');
    if (seenIds.has(source.id)) addError(errors, 'duplicate_id', `${label}.id`, 'Duplicate source ID.');
    seenIds.add(source.id);
    if (!isSafeRelativePath(source.path)) {
      addError(errors, 'path_unsafe', `${label}.path`, 'Expected a safe workspace-relative source path.');
      return;
    }
    if (seenPaths.has(source.path)) addError(errors, 'duplicate_source_path', `${label}.path`, 'Source paths must be unique.');
    seenPaths.add(source.path);
    if (typeof source.sha256 !== 'string' || !SHA256_RE.test(source.sha256)) addError(errors, 'sha256_invalid', `${label}.sha256`, 'Expected a lowercase SHA-256 digest.');
    try {
      const resolved = inspectWorkspacePath(workspaceRoot, source.path, { mustExist: true, expectedType: 'file' });
      const stat = fs.statSync(resolved.realPath);
      if (stat.size > MAX_SOURCE_BYTES) throw new Error('source_size_limit');
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_SOURCE_BYTES) throw new Error('source_total_size_limit');
      const bytes = fs.readFileSync(resolved.realPath);
      const actual = sha256(bytes);
      if (actual !== source.sha256) addError(errors, 'source_digest_mismatch', `${label}.sha256`, `Digest mismatch for ${source.path}.`);
      let text;
      try { text = UTF8.decode(bytes); } catch (_) { throw new Error('source_utf8_invalid'); }
      const lines = splitSourceLines(text);
      loaded.set(source.id, { id: source.id, path: source.path, sha256: actual, bytes, text, lines });
    } catch (error) {
      addError(errors, error.message || 'source_unreadable', `${label}.path`, `Cannot verify source ${source.path}.`);
    }
  });
  return loaded;
}

function validateSourceRefArray(items, name, sourceById, errors, { idField = 'id', fields, maxItems = MAX_ITEMS, minItems = 0 } = {}) {
  if (!Array.isArray(items)) return new Map();
  const byId = new Map();
  if (items.length < minItems || items.length > maxItems) addError(errors, 'array_bounds', `$.${name}`, `Expected ${minItems}..${maxItems} entries.`);
  items.forEach((item, index) => {
    const label = `$.${name}[${index}]`;
    if (!exactObject(item, fields, label, errors)) return;
    if (typeof item[idField] !== 'string' || !ID_RE.test(item[idField]) || item[idField].length > 64) addError(errors, 'id_invalid', `${label}.${idField}`, 'ID is invalid.');
    if (byId.has(item[idField])) addError(errors, 'duplicate_id', `${label}.${idField}`, 'Duplicate ID.');
    byId.set(item[idField], item);
    validateSourceLocation(item.sourceLocation, `${label}.sourceLocation`, errors, sourceById);
  });
  return byId;
}

function validateContext(context, { workspaceRoot } = {}) {
  const errors = [];
  if (!validateContextShape(context, errors)) return { ok: false, errors, context: null, sources: {} };
  let root;
  try { root = assertWorkspaceRoot(workspaceRoot); } catch (error) {
    addError(errors, 'workspace_root_invalid', '$options.workspaceRoot', error.message || 'Workspace root is unavailable.');
    return { ok: false, errors, context, sources: {} };
  }
  const sourcesById = readSources(context, root, errors);
  try { inspectWorkspacePath(root, context.featureDir, { mustExist: true, expectedType: 'directory' }); } catch (error) {
    addError(errors, error.message || 'feature_dir_invalid', '$.featureDir', 'Feature directory must be a safe existing directory inside the workspace.');
  }
  const requirements = validateSourceRefArray(context.requirements, 'requirements', sourcesById, errors, {
    fields: ['id', 'sourceLocation', 'mandatory', 'acceptanceIds', 'riskTags', 'exclusionReason'], minItems: 1,
  });
  const criteria = validateSourceRefArray(context.acceptanceCriteria, 'acceptanceCriteria', sourcesById, errors, {
    fields: ['id', 'sourceLocation', 'requirementIds', 'mandatory', 'checkIds', 'exclusionReason'], minItems: 1,
  });
  const checks = new Map();
  if (Array.isArray(context.checks)) context.checks.forEach((check, index) => {
    const label = `$.checks[${index}]`;
    if (!exactObject(check, ['id', 'argv', 'timeoutMs', 'verifierWritePaths', 'sourceLocation', 'rationale'], label, errors)) return;
    if (typeof check.id !== 'string' || !ID_RE.test(check.id) || check.id.length > 64) addError(errors, 'id_invalid', `${label}.id`, 'Check ID is invalid.');
    if (checks.has(check.id)) addError(errors, 'duplicate_id', `${label}.id`, 'Duplicate check ID.');
    checks.set(check.id, check);
    if (!Array.isArray(check.argv) || check.argv.length < 1 || check.argv.length > 32 || check.argv.some((x) => typeof x !== 'string' || x.length < 1 || x.length > 3000)) addError(errors, 'argv_invalid', `${label}.argv`, 'argv must be a nonempty bounded string array.');
    if (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 3600000) addError(errors, 'timeout_invalid', `${label}.timeoutMs`, 'timeoutMs must be a positive integer no greater than 3600000.');
    boundedString(check.rationale, `${label}.rationale`, errors);
    validateSourceLocation(check.sourceLocation, `${label}.sourceLocation`, errors, sourcesById);
    if (!Array.isArray(check.verifierWritePaths) || check.verifierWritePaths.length < 1 || check.verifierWritePaths.length > 100) addError(errors, 'verifier_scope_empty', `${label}.verifierWritePaths`, 'Verifier write scope must be a nonempty bounded array.');
    if (Array.isArray(check.verifierWritePaths)) check.verifierWritePaths.forEach((entry, entryIndex) => validateScopeEntry(entry, `${label}.verifierWritePaths[${entryIndex}]`, errors));
  });
  const evidence = validateSourceRefArray(context.priorEvidence, 'priorEvidence', sourcesById, errors, {
    fields: ['id', 'sourceLocation', 'description'], minItems: 1,
  });
  for (const item of Array.isArray(context.priorEvidence) ? context.priorEvidence : []) boundedString(item && item.description, `$.priorEvidence.${item && item.id || 'unknown'}.description`, errors);
  const decisions = new Map();
  if (Array.isArray(context.decisions)) context.decisions.forEach((decision, index) => {
    const label = `$.decisions[${index}]`;
    if (!exactObject(decision, ['id', 'status', 'affectedRequirementIds', 'sourceLocation', 'rationale', 'resolution'], label, errors)) return;
    if (typeof decision.id !== 'string' || !ID_RE.test(decision.id) || decision.id.length > 64) addError(errors, 'id_invalid', `${label}.id`, 'Decision ID is invalid.');
    if (decisions.has(decision.id)) addError(errors, 'duplicate_id', `${label}.id`, 'Duplicate decision ID.');
    decisions.set(decision.id, decision);
    if (!['resolved', 'unresolved'].includes(decision.status)) addError(errors, 'decision_status_invalid', `${label}.status`, 'Decision status must be resolved or unresolved.');
    validateStringList(decision.affectedRequirementIds, `${label}.affectedRequirementIds`, errors, { minItems: 0, maxItems: 200 });
    validateSourceLocation(decision.sourceLocation, `${label}.sourceLocation`, errors, sourcesById);
    boundedString(decision.rationale, `${label}.rationale`, errors);
    if (decision.status === 'resolved') boundedString(decision.resolution, `${label}.resolution`, errors);
    if (decision.status === 'unresolved' && decision.resolution !== null) addError(errors, 'decision_resolution_invalid', `${label}.resolution`, 'Unresolved decisions must use null resolution.');
  });
  const writeScope = context.writeScope;
  if (exactObject(writeScope, ['allow', 'deny'], '$.writeScope', errors)) {
    if (!Array.isArray(writeScope.allow) || writeScope.allow.length < 1 || writeScope.allow.length > 200) addError(errors, 'scope_allow_empty', '$.writeScope.allow', 'Allow scope must be nonempty and bounded.');
    if (!Array.isArray(writeScope.deny) || writeScope.deny.length > 200) addError(errors, 'scope_deny_invalid', '$.writeScope.deny', 'Deny scope must be a bounded array.');
    for (const name of ['allow', 'deny']) if (Array.isArray(writeScope[name])) writeScope[name].forEach((entry, index) => {
      validateScopeEntry(entry, `$.writeScope.${name}[${index}]`, errors);
      if (isSafeRelativePath(entry && entry.path)) {
        try { inspectWorkspacePath(root, entry.path, { expectedType: entry.kind, rejectSymlinks: true }); } catch (error) { addError(errors, error.message || 'scope_path_invalid', `$.writeScope.${name}[${index}].path`, 'Scope path or an existing ancestor is unsafe.'); }
      }
      for (let previous = 0; previous < index; previous += 1) {
        if (writeScope[name][previous] && entry && writeScope[name][previous].path === entry.path) addError(errors, 'duplicate_scope', `$.writeScope.${name}[${index}]`, 'Duplicate scope path.');
      }
    });
  }
  const riskRules = [];
  const riskRuleIds = new Set();
  if (Array.isArray(context.riskRules)) context.riskRules.forEach((rule, index) => {
    const label = `$.riskRules[${index}]`;
    if (!exactObject(rule, ['id', 'path', 'riskTags', 'sourceLocation', 'rationale'], label, errors)) return;
    if (typeof rule.id !== 'string' || !ID_RE.test(rule.id) || rule.id.length > 64) addError(errors, 'id_invalid', `${label}.id`, 'Risk rule ID is invalid.');
    if (riskRuleIds.has(rule.id)) addError(errors, 'duplicate_id', `${label}.id`, 'Duplicate risk rule ID.');
    riskRuleIds.add(rule.id);
    validateScopeEntry(rule.path, `${label}.path`, errors);
    validateStringList(rule.riskTags, `${label}.riskTags`, errors, { minItems: 0, maxItems: 3 });
    for (const tag of Array.isArray(rule.riskTags) ? rule.riskTags : []) if (!RISK_TAGS.includes(tag)) addError(errors, 'risk_tag_invalid', `${label}.riskTags`, `Unsupported risk tag ${String(tag).slice(0, 80)}.`);
    validateSourceLocation(rule.sourceLocation, `${label}.sourceLocation`, errors, sourcesById);
    boundedString(rule.rationale, `${label}.rationale`, errors);
    if (isSafeRelativePath(rule.path && rule.path.path)) {
      try { inspectWorkspacePath(root, rule.path.path, { expectedType: rule.path.kind, rejectSymlinks: true }); } catch (error) { addError(errors, error.message || 'risk_path_invalid', `${label}.path`, 'Risk rule path or an existing ancestor is unsafe.'); }
    }
    riskRules.push(rule);
  });
  if (writeScope && Array.isArray(writeScope.allow) && Array.isArray(writeScope.deny)) {
    for (const [index, allowed] of writeScope.allow.entries()) {
      if (!isPlainObject(allowed)) continue;
      const exactRule = riskRules.some((rule) => rule.path && rule.path.kind === allowed.kind && rule.path.path === allowed.path);
      if (!exactRule) addError(errors, 'risk_rule_missing', `$.writeScope.allow[${index}]`, 'Every allowed path needs an exact reviewed risk rule.');
    }
    for (const [index, rule] of riskRules.entries()) {
      if (!scopeAllowed(rule.path, writeScope)) addError(errors, 'risk_rule_outside_scope', `$.riskRules[${index}].path`, 'Risk rule must be within allowed scope and outside denied scope.');
    }
    for (const check of Array.isArray(context.checks) ? context.checks : []) {
      if (!isPlainObject(check)) continue;
      for (const [index, entry] of (Array.isArray(check.verifierWritePaths) ? check.verifierWritePaths : []).entries()) {
        if (!scopeAllowed(entry, writeScope)) addError(errors, 'verifier_scope_denied', `$.checks.${check.id}.verifierWritePaths[${index}]`, 'Verifier path is outside allowed scope or overlaps denied scope.');
        if (rulesForScope(entry, riskRules).length === 0) addError(errors, 'risk_rule_missing', `$.checks.${check.id}.verifierWritePaths[${index}]`, 'Verifier path has no matching risk rule.');
        if (entry && isSafeRelativePath(entry.path)) {
          try { inspectWorkspacePath(root, entry.path, { expectedType: entry.kind, rejectSymlinks: true }); } catch (error) { addError(errors, error.message || 'verifier_scope_path_invalid', `$.checks.${check.id}.verifierWritePaths[${index}]`, 'Verifier scope path or an existing ancestor is unsafe.'); }
        }
      }
    }
  }
  for (const [id, requirement] of requirements) {
    if (typeof requirement.mandatory !== 'boolean') addError(errors, 'boolean_required', `$.requirements.${id}.mandatory`, 'mandatory must be boolean.');
    validateStringList(requirement.acceptanceIds, `$.requirements.${id}.acceptanceIds`, errors, { minItems: requirement.mandatory === true ? 1 : 0 });
    validateStringList(requirement.riskTags, `$.requirements.${id}.riskTags`, errors, { minItems: 0, maxItems: 3 });
    for (const tag of Array.isArray(requirement.riskTags) ? requirement.riskTags : []) if (!RISK_TAGS.includes(tag)) addError(errors, 'risk_tag_invalid', `$.requirements.${id}.riskTags`, `Unsupported risk tag ${String(tag).slice(0, 80)}.`);
    if (requirement.mandatory === false) boundedString(requirement.exclusionReason, `$.requirements.${id}.exclusionReason`, errors);
    if (requirement.mandatory === true && requirement.exclusionReason !== null) addError(errors, 'exclusion_reason_invalid', `$.requirements.${id}.exclusionReason`, 'Mandatory items must not have an exclusion reason.');
    for (const acceptanceId of Array.isArray(requirement.acceptanceIds) ? requirement.acceptanceIds : []) {
      const criterion = criteria.get(acceptanceId);
      if (!criterion) addError(errors, 'acceptance_reference_unknown', `$.requirements.${id}.acceptanceIds`, `Unknown acceptance criterion ${acceptanceId}.`);
      else if (!Array.isArray(criterion.requirementIds) || !criterion.requirementIds.includes(id)) addError(errors, 'requirement_acceptance_link_mismatch', `$.requirements.${id}.acceptanceIds`, `${acceptanceId} does not link back to ${id}.`);
    }
  }
  for (const [id, criterion] of criteria) {
    if (typeof criterion.mandatory !== 'boolean') addError(errors, 'boolean_required', `$.acceptanceCriteria.${id}.mandatory`, 'mandatory must be boolean.');
    validateStringList(criterion.requirementIds, `$.acceptanceCriteria.${id}.requirementIds`, errors, { minItems: 1 });
    validateStringList(criterion.checkIds, `$.acceptanceCriteria.${id}.checkIds`, errors, { minItems: criterion.mandatory === true ? 1 : 0 });
    if (criterion.mandatory === false) boundedString(criterion.exclusionReason, `$.acceptanceCriteria.${id}.exclusionReason`, errors);
    if (criterion.mandatory === true && criterion.exclusionReason !== null) addError(errors, 'exclusion_reason_invalid', `$.acceptanceCriteria.${id}.exclusionReason`, 'Mandatory items must not have an exclusion reason.');
    for (const requirementId of Array.isArray(criterion.requirementIds) ? criterion.requirementIds : []) {
      const requirement = requirements.get(requirementId);
      if (!requirement) addError(errors, 'requirement_reference_unknown', `$.acceptanceCriteria.${id}.requirementIds`, `Unknown requirement ${requirementId}.`);
      else if (!Array.isArray(requirement.acceptanceIds) || !requirement.acceptanceIds.includes(id)) addError(errors, 'acceptance_requirement_link_mismatch', `$.acceptanceCriteria.${id}.requirementIds`, `${requirementId} does not link back to ${id}.`);
    }
    for (const checkId of Array.isArray(criterion.checkIds) ? criterion.checkIds : []) if (!checks.has(checkId)) addError(errors, 'check_reference_unknown', `$.acceptanceCriteria.${id}.checkIds`, `Unknown check ${checkId}.`);
  }
  for (const [id, decision] of decisions) {
    validateStringList(decision.affectedRequirementIds, `$.decisions.${id}.affectedRequirementIds`, errors, { minItems: 0, maxItems: 200 });
    for (const requirementId of Array.isArray(decision.affectedRequirementIds) ? decision.affectedRequirementIds : []) if (!requirements.has(requirementId)) addError(errors, 'requirement_reference_unknown', `$.decisions.${id}.affectedRequirementIds`, `Unknown requirement ${requirementId}.`);
  }
  const sources = Object.fromEntries([...sourcesById].map(([id, source]) => [id, source]));
  return { ok: errors.length === 0, errors, context, contextSha256: null, sources };
}

function readBoundedFile(workspaceRoot, relativePath, maxBytes) {
  const resolved = inspectWorkspacePath(workspaceRoot, relativePath, { mustExist: true, expectedType: 'file' });
  const stat = fs.statSync(resolved.realPath);
  if (stat.size > maxBytes) throw new Error('input_size_limit');
  const bytes = fs.readFileSync(resolved.realPath);
  if (bytes.length > maxBytes) throw new Error('input_size_limit');
  return { bytes, sha256: sha256(bytes), path: resolved.path };
}

function parseJsonBytes(bytes) {
  let text;
  try { text = UTF8.decode(bytes); } catch (_) { return { value: null, error: 'input_utf8_invalid' }; }
  try { return { value: JSON.parse(text), error: null }; } catch (_) { return { value: null, error: 'input_json_invalid' }; }
}

function loadContext({ workspaceRoot, contextPath, expectedSha256 } = {}) {
  const errors = [];
  if (typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)) {
    addError(errors, 'expected_context_digest_invalid', '$options.expectedSha256', 'Expected digest must be a lowercase SHA-256 value supplied by the caller.');
    return { ok: false, errors, context: null, contextSha256: null, sources: {} };
  }
  let file;
  try { file = readBoundedFile(workspaceRoot, contextPath, MAX_CONTEXT_BYTES); } catch (error) {
    addError(errors, error.message || 'context_read_failed', '$options.contextPath', 'Cannot read the bounded context file safely.');
    return { ok: false, errors, context: null, contextSha256: null, sources: {} };
  }
  if (file.sha256 !== expectedSha256) {
    addError(errors, 'context_digest_mismatch', '$options.expectedSha256', 'Context bytes do not match the caller-supplied digest.');
    return { ok: false, errors, context: null, contextSha256: file.sha256, sources: {} };
  }
  const parsed = parseJsonBytes(file.bytes);
  if (parsed.error) {
    addError(errors, parsed.error, '$', 'Context bytes are not valid bounded UTF-8 JSON.');
    return { ok: false, errors, context: null, contextSha256: file.sha256, sources: {} };
  }
  const result = validateContext(parsed.value, { workspaceRoot });
  return { ...result, contextSha256: file.sha256 };
}

function deriveReviewKind(tags) {
  if (tags.has('risk_change')) return 'risk_change';
  if (tags.has('performance')) return 'performance';
  if (tags.has('component_complete')) return 'component_complete';
  return 'routine';
}

function validateTraceabilityShape(map, errors) {
  const fields = ['schemaVersion', 'featureId', 'contextSha256', 'artifactBindings', 'tasks'];
  if (!exactObject(map, fields, '$', errors)) return false;
  if (map.schemaVersion !== TRACEABILITY_VERSION) addError(errors, 'schema_version_unsupported', '$.schemaVersion', `Expected ${TRACEABILITY_VERSION}.`);
  if (typeof map.featureId !== 'string' || map.featureId.length > 64 || !FEATURE_ID_RE.test(map.featureId)) addError(errors, 'feature_id_invalid', '$.featureId', 'Feature ID must be a lowercase slug of at most 64 characters.');
  if (typeof map.contextSha256 !== 'string' || !SHA256_RE.test(map.contextSha256)) addError(errors, 'context_digest_invalid', '$.contextSha256', 'Expected a lowercase SHA-256 digest.');
  if (!Array.isArray(map.artifactBindings) || map.artifactBindings.length !== 3) addError(errors, 'artifact_bindings_invalid', '$.artifactBindings', 'Exactly three artifact bindings are required.');
  if (!Array.isArray(map.tasks) || map.tasks.length < 1 || map.tasks.length > 100) addError(errors, 'array_bounds', '$.tasks', 'Tasks must be a nonempty bounded array.');
  return true;
}

function validateTask(task, index, errors) {
  const label = `$.tasks[${index}]`;
  const fields = ['id', 'role', 'objective', 'requirementIds', 'acceptanceIds', 'dependsOn', 'parallel', 'writePaths', 'checkIds', 'priorEvidenceIds', 'stopConditions', 'additionalRiskTags', 'declaredReviewKind', 'checkpointId', 'reviewReason'];
  if (!exactObject(task, fields, label, errors)) return false;
  if (typeof task.id !== 'string' || !TASK_ID_RE.test(task.id)) addError(errors, 'task_id_invalid', `${label}.id`, 'Task ID must be T followed by 3 to 6 digits.');
  if (task.role !== 'engineer') addError(errors, 'task_role_invalid', `${label}.role`, 'Phase 1 tasks use the engineer role.');
  boundedString(task.objective, `${label}.objective`, errors, { max: 3000 });
  for (const field of ['requirementIds', 'acceptanceIds', 'checkIds', 'priorEvidenceIds', 'dependsOn']) validateStringList(task[field], `${label}.${field}`, errors, { minItems: ['dependsOn'].includes(field) ? 0 : 1 });
  if (typeof task.parallel !== 'boolean') addError(errors, 'boolean_required', `${label}.parallel`, 'parallel must be boolean.');
  if (!Array.isArray(task.writePaths) || task.writePaths.length < 1 || task.writePaths.length > 100) addError(errors, 'array_bounds', `${label}.writePaths`, 'writePaths must be a nonempty bounded array.');
  if (Array.isArray(task.writePaths)) task.writePaths.forEach((entry, pathIndex) => validateScopeEntry(entry, `${label}.writePaths[${pathIndex}]`, errors));
  if (!Array.isArray(task.stopConditions) || task.stopConditions.length < 1 || task.stopConditions.length > 100) addError(errors, 'array_bounds', `${label}.stopConditions`, 'stopConditions must be a nonempty bounded array.');
  if (Array.isArray(task.stopConditions)) task.stopConditions.forEach((value, stopIndex) => boundedString(value, `${label}.stopConditions[${stopIndex}]`, errors, { max: 3000 }));
  validateStringList(task.additionalRiskTags, `${label}.additionalRiskTags`, errors, { minItems: 0, maxItems: 3 });
  for (const tag of Array.isArray(task.additionalRiskTags) ? task.additionalRiskTags : []) if (!RISK_TAGS.includes(tag)) addError(errors, 'risk_tag_invalid', `${label}.additionalRiskTags`, `Unsupported risk tag ${String(tag).slice(0, 80)}.`);
  if (!REVIEW_KINDS.includes(task.declaredReviewKind)) addError(errors, 'review_kind_invalid', `${label}.declaredReviewKind`, 'Unsupported review kind.');
  if (typeof task.checkpointId !== 'string' || task.checkpointId.length < 1 || task.checkpointId.length > 160 || !CHECKPOINT_RE.test(task.checkpointId)) addError(errors, 'checkpoint_id_invalid', `${label}.checkpointId`, 'Checkpoint ID is invalid.');
  boundedString(task.reviewReason, `${label}.reviewReason`, errors, { max: 1000 });
  return true;
}

function validateTraceability(map, { workspaceRoot, contextResult, expectedContextSha256 } = {}) {
  const errors = [];
  if (!validateTraceabilityShape(map, errors)) return { ok: false, errors, map: null, mapSha256: null };
  if (!contextResult || contextResult.ok !== true || !contextResult.context) {
    addError(errors, 'context_unverified', '$options.contextResult', 'A successfully loaded context is required.');
    return { ok: false, errors, map, mapSha256: null };
  }
  if (typeof expectedContextSha256 !== 'string' || !SHA256_RE.test(expectedContextSha256)) addError(errors, 'expected_context_digest_invalid', '$options.expectedContextSha256', 'Expected context digest must be caller-supplied.');
  if (contextResult.contextSha256 !== expectedContextSha256) addError(errors, 'accepted_context_digest_mismatch', '$options.expectedContextSha256', 'Loaded context digest does not match the caller-supplied digest.');
  if (map.contextSha256 !== expectedContextSha256) addError(errors, 'map_context_digest_mismatch', '$.contextSha256', 'Map must bind the externally supplied context digest.');
  const context = contextResult.context;
  if (map.featureId !== context.featureId) addError(errors, 'feature_id_mismatch', '$.featureId', 'Map and context feature IDs must match.');
  const root = (() => { try { return assertWorkspaceRoot(workspaceRoot); } catch (_) { addError(errors, 'workspace_root_invalid', '$options.workspaceRoot', 'Workspace root is unavailable.'); return null; } })();
  const bindingByRole = new Map();
  const bindingPaths = new Set();
  if (Array.isArray(map.artifactBindings)) map.artifactBindings.forEach((binding, index) => {
    const label = `$.artifactBindings[${index}]`;
    if (!exactObject(binding, ['role', 'path', 'sha256'], label, errors)) return;
    if (!ARTIFACT_ROLES.includes(binding.role)) addError(errors, 'artifact_role_invalid', `${label}.role`, 'Artifact role must be spec, plan, or tasks.');
    if (bindingByRole.has(binding.role)) addError(errors, 'artifact_role_duplicate', `${label}.role`, 'Artifact roles must be unique.');
    bindingByRole.set(binding.role, binding);
    if (!isSafeRelativePath(binding.path)) addError(errors, 'path_unsafe', `${label}.path`, 'Artifact path must be safe and workspace-relative.');
    if (bindingPaths.has(binding.path)) addError(errors, 'artifact_path_duplicate', `${label}.path`, 'Artifact paths must be unique.');
    bindingPaths.add(binding.path);
    if (typeof binding.sha256 !== 'string' || !SHA256_RE.test(binding.sha256)) addError(errors, 'sha256_invalid', `${label}.sha256`, 'Expected a lowercase SHA-256 digest.');
    if (root && isSafeRelativePath(binding.path)) {
      try {
        if (!binding.path.startsWith(`${context.featureDir}/`)) addError(errors, 'artifact_outside_feature', `${label}.path`, 'Bound artifacts must be inside featureDir.');
        const file = readBoundedFile(root, binding.path, MAX_SOURCE_BYTES);
        if (file.sha256 !== binding.sha256) addError(errors, 'artifact_digest_mismatch', `${label}.sha256`, `Artifact bytes do not match ${binding.path}.`);
      } catch (error) { addError(errors, error.message || 'artifact_read_failed', `${label}.path`, 'Cannot safely read bound artifact.'); }
    }
  });
  for (const role of ARTIFACT_ROLES) if (!bindingByRole.has(role)) addError(errors, 'artifact_role_missing', '$.artifactBindings', `Missing ${role} artifact binding.`);

  const tasks = new Map();
  if (Array.isArray(map.tasks)) map.tasks.forEach((task, index) => {
    validateTask(task, index, errors);
    if (task && typeof task.id === 'string') {
      if (tasks.has(task.id)) addError(errors, 'duplicate_task_id', `$.tasks[${index}].id`, 'Task ID is duplicated.');
      tasks.set(task.id, task);
    }
  });
  const requirements = new Map((Array.isArray(context.requirements) ? context.requirements : []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
  const criteria = new Map((Array.isArray(context.acceptanceCriteria) ? context.acceptanceCriteria : []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
  const checks = new Map((Array.isArray(context.checks) ? context.checks : []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
  const evidence = new Map((Array.isArray(context.priorEvidence) ? context.priorEvidence : []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
  const assignedRequirements = new Set();
  const assignedCriteria = new Set();
  for (const [taskId, task] of tasks) {
    const label = `$.tasks.${taskId}`;
    const linkedRequirements = new Set();
    const linkedCriteria = new Set();
    for (const requirementId of Array.isArray(task.requirementIds) ? task.requirementIds : []) {
      const requirement = requirements.get(requirementId);
      if (!requirement) addError(errors, 'requirement_reference_unknown', `${label}.requirementIds`, `Unknown requirement ${requirementId}.`);
      else {
        linkedRequirements.add(requirementId);
        assignedRequirements.add(requirementId);
      }
    }
    for (const acceptanceId of Array.isArray(task.acceptanceIds) ? task.acceptanceIds : []) {
      const criterion = criteria.get(acceptanceId);
      if (!criterion) addError(errors, 'acceptance_reference_unknown', `${label}.acceptanceIds`, `Unknown acceptance criterion ${acceptanceId}.`);
      else {
        linkedCriteria.add(acceptanceId);
        assignedCriteria.add(acceptanceId);
        if (!Array.isArray(criterion.requirementIds) || !criterion.requirementIds.some((id) => linkedRequirements.has(id) || (Array.isArray(task.requirementIds) && task.requirementIds.includes(id)))) addError(errors, 'acceptance_requirement_mismatch', `${label}.acceptanceIds`, `${acceptanceId} is not related to a linked requirement.`);
      }
    }
    const taskChecks = new Set(Array.isArray(task.checkIds) ? task.checkIds : []);
    for (const checkId of taskChecks) if (!checks.has(checkId)) addError(errors, 'check_reference_unknown', `${label}.checkIds`, `Unknown check ${checkId}.`);
    for (const evidenceId of Array.isArray(task.priorEvidenceIds) ? task.priorEvidenceIds : []) if (!evidence.has(evidenceId)) addError(errors, 'evidence_reference_unknown', `${label}.priorEvidenceIds`, `Unknown prior evidence ${evidenceId}.`);
    for (const dependencyId of Array.isArray(task.dependsOn) ? task.dependsOn : []) {
      if (dependencyId === taskId) addError(errors, 'dependency_self_reference', `${label}.dependsOn`, 'A task cannot depend on itself.');
      else if (!tasks.has(dependencyId) && !map.tasks.some((candidate) => candidate && candidate.id === dependencyId)) addError(errors, 'dependency_reference_unknown', `${label}.dependsOn`, `Unknown task ${dependencyId}.`);
    }
    const tags = new Set(Array.isArray(task.additionalRiskTags) ? task.additionalRiskTags : []);
    for (const requirementId of linkedRequirements) for (const tag of requirements.get(requirementId).riskTags || []) tags.add(tag);
    for (const scope of Array.isArray(task.writePaths) ? task.writePaths : []) {
      if (root && isSafeRelativePath(scope && scope.path)) {
        try { inspectWorkspacePath(root, scope.path, { expectedType: scope.kind, rejectSymlinks: true }); } catch (error) { addError(errors, error.message || 'write_path_invalid', `${label}.writePaths`, `Unsafe proposed write path ${String(scope.path).slice(0, 200)}.`); }
      }
      if (!scopeAllowed(scope, context.writeScope)) addError(errors, 'write_scope_denied', `${label}.writePaths`, `Write path is outside allowed scope or overlaps a denied path.`);
      const rules = rulesForScope(scope, context.riskRules || []);
      if (rules.length === 0) addError(errors, 'risk_rule_missing', `${label}.writePaths`, 'Write path has no reviewed risk rule.');
      for (const rule of rules) for (const tag of rule.riskTags || []) tags.add(tag);
    }
    for (const checkId of taskChecks) {
      const check = checks.get(checkId);
      if (!check) continue;
      for (const checkScope of check.verifierWritePaths || []) {
        const rules = rulesForScope(checkScope, context.riskRules || []);
        if (!scopeAllowed(checkScope, context.writeScope) || rules.length === 0) addError(errors, 'verifier_scope_invalid', `${label}.checkIds`, `Verifier scope for ${checkId} is not independently allowed and classified.`);
        for (const rule of rules) for (const tag of rule.riskTags || []) tags.add(tag);
      }
    }
    for (const decision of context.decisions || []) if (decision && decision.status === 'unresolved' && (decision.affectedRequirementIds || []).some((id) => linkedRequirements.has(id))) addError(errors, 'decision_unresolved', `${label}.requirementIds`, `Unresolved decision ${decision.id} affects this task.`);
    const derivedKind = deriveReviewKind(tags);
    if (task.declaredReviewKind !== derivedKind) addError(errors, 'review_kind_mismatch', `${label}.declaredReviewKind`, `Declared review kind must be ${derivedKind}.`);
  }
  for (const requirement of Array.isArray(context.requirements) ? context.requirements : []) if (requirement && requirement.mandatory === true && !assignedRequirements.has(requirement.id)) addError(errors, 'mandatory_requirement_unassigned', '$.tasks', `Mandatory requirement ${requirement.id} is not assigned.`);
  for (const criterion of Array.isArray(context.acceptanceCriteria) ? context.acceptanceCriteria : []) if (criterion && criterion.mandatory === true) {
    const coveringTasks = (Array.isArray(map.tasks) ? map.tasks : []).filter((task) => task && Array.isArray(task.acceptanceIds) && task.acceptanceIds.includes(criterion.id));
    if (!assignedCriteria.has(criterion.id) || coveringTasks.length === 0) addError(errors, 'mandatory_acceptance_unassigned', '$.tasks', `Mandatory acceptance criterion ${criterion.id} is not assigned.`);
    const checksCovered = new Set(coveringTasks.flatMap((task) => Array.isArray(task.checkIds) ? task.checkIds : []));
    for (const checkId of criterion.checkIds || []) if (!checksCovered.has(checkId)) addError(errors, 'required_check_unassigned', '$.tasks', `Acceptance criterion ${criterion.id} is missing check ${checkId}.`);
  }
  return { ok: errors.length === 0, errors, map, mapSha256: null };
}

function loadTraceability({ workspaceRoot, mapPath, contextResult, expectedContextSha256 } = {}) {
  let file;
  try { file = readBoundedFile(workspaceRoot, mapPath, MAX_MAP_BYTES); } catch (error) {
    const errors = [];
    addError(errors, error.message || 'map_read_failed', '$options.mapPath', 'Cannot safely read the bounded map file.');
    return { ok: false, errors, map: null, mapSha256: null };
  }
  const parsed = parseJsonBytes(file.bytes);
  if (parsed.error) {
    const errors = [];
    addError(errors, parsed.error, '$', 'Map bytes are not valid bounded UTF-8 JSON.');
    return { ok: false, errors, map: null, mapSha256: file.sha256 };
  }
  const result = validateTraceability(parsed.value, { workspaceRoot, contextResult, expectedContextSha256 });
  return { ...result, mapSha256: file.sha256 };
}

module.exports = {
  CONTEXT_VERSION,
  TRACEABILITY_VERSION,
  MAX_CONTEXT_BYTES,
  MAX_MAP_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TOTAL_SOURCE_BYTES,
  isSafeRelativePath,
  inspectWorkspacePath,
  splitSourceLines,
  extractSourceLocation,
  deriveReviewKind,
  validateContext,
  loadContext,
  validateTraceability,
  loadTraceability,
};
