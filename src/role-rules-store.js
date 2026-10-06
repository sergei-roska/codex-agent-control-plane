'use strict';

// Operator-written project rules per role: free-text guidance with immutable history.
// Keyed by (projectId, packId, roleRuntimeId). Every change writes a new revision holding the full
// rule list and moves the current pointer. Rules are guidance only; nothing here grants tools,
// paths, permissions, checks or credentials.

const { ProductError, canonicalJson, validateEnvelope, sha256, defaultRandomId } = require('./product-store');

const MAX_RULE_CHARS = 2000;
const MAX_RULES = 20;
const MAX_TOTAL_CHARS = 8000;
const HISTORY_LIMIT = 50;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
// Control characters other than \n and \t.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const ADD_FIELDS = ['commandId', 'packId', 'roleRuntimeId', 'expectedRevisionId', 'text'];
const EDIT_FIELDS = [...ADD_FIELDS, 'ruleId'];
const REMOVE_FIELDS = ['commandId', 'packId', 'roleRuntimeId', 'expectedRevisionId', 'ruleId'];

function rowToRevision(row) {
  return row ? {
    rulesRevisionId: row.rules_revision_id,
    packId: row.pack_id,
    roleRuntimeId: row.role_runtime_id,
    rules: JSON.parse(row.rules_json),
    changeKind: row.change_kind,
    changeRuleId: row.change_rule_id,
    supersedesId: row.supersedes_id,
    actor: row.actor,
    createdAt: row.created_at,
  } : null;
}

function checkEnvelope(body, allowed) {
  validateEnvelope(body, allowed);
  const errors = [];
  for (const field of ['packId', 'roleRuntimeId']) {
    if (typeof body[field] !== 'string' || !ID_RE.test(body[field])) errors.push({ field, message: 'must be a valid identifier' });
  }
  if (body.expectedRevisionId !== null && (typeof body.expectedRevisionId !== 'string' || !body.expectedRevisionId)) {
    errors.push({ field: 'expectedRevisionId', message: 'must be a revision id or null' });
  }
  if (allowed.includes('ruleId') && (typeof body.ruleId !== 'string' || !ID_RE.test(body.ruleId))) {
    errors.push({ field: 'ruleId', message: 'must be a valid identifier' });
  }
  if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
}

// Returns the normalized text (CRLF -> LF, trimmed) or throws invalid_request.
function normalizeText(value) {
  const fail = (message) => { throw new ProductError('invalid_request', 'invalid request', [{ field: 'text', message }]); };
  if (typeof value !== 'string') return fail('must be a string');
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length === 0) return fail('must not be empty or whitespace only');
  if (text.length > MAX_RULE_CHARS) return fail(`must be at most ${MAX_RULE_CHARS} characters`);
  if (CONTROL_RE.test(text)) return fail('must not contain control characters');
  return text;
}

function createRoleRulesStore({ db, projectId, now, randomId, events, roleExists } = {}) {
  if (!db) throw new Error('createRoleRulesStore requires db');
  if (typeof projectId !== 'string' || !projectId) throw new Error('createRoleRulesStore requires projectId');
  const clock = () => {
    const value = typeof now === 'function' ? now() : now;
    const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
    return date.toISOString();
  };
  const newId = randomId || defaultRandomId;
  const stmts = {};
  const stmt = (sql) => { if (!stmts[sql]) stmts[sql] = db.prepare(sql); return stmts[sql]; };

  // Rule text is never part of an event; ids only.
  const emit = (type, packId, roleRuntimeId, revisionId) => {
    if (!events) return;
    try { events.record(type, { namespace: packId, role: roleRuntimeId, causationId: revisionId, payload: {} }); } catch (_) { /* diagnostic only */ }
  };

  function currentFor(packId, roleRuntimeId) {
    return rowToRevision(stmt(
      'SELECT r.* FROM role_rules_current c JOIN role_rules_revisions r ON r.rules_revision_id = c.rules_revision_id '
      + 'WHERE c.project_id = ? AND c.pack_id = ? AND c.role_runtime_id = ?').get(projectId, String(packId), String(roleRuntimeId)));
  }

  function history(packId, roleRuntimeId, { limit = HISTORY_LIMIT } = {}) {
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : HISTORY_LIMIT;
    return stmt('SELECT * FROM role_rules_revisions WHERE project_id = ? AND pack_id = ? AND role_runtime_id = ? '
      + 'ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(projectId, String(packId), String(roleRuntimeId), cap).map((row) => ({
        rulesRevisionId: row.rules_revision_id,
        actor: row.actor,
        createdAt: row.created_at,
        changeKind: row.change_kind,
        changeRuleId: row.change_rule_id,
        ruleCount: JSON.parse(row.rules_json).length,
      }));
  }

  function effectiveRules(packId, roleRuntimeId) {
    const current = currentFor(packId, roleRuntimeId);
    if (!current || current.rules.length === 0) return null;
    return { rulesRevisionId: current.rulesRevisionId, rules: current.rules.map((rule) => rule.text) };
  }

  function priorCommand(commandId, payloadHash) {
    const prior = stmt('SELECT payload_sha256, result_json FROM product_commands WHERE command_id = ?').get(commandId);
    if (!prior) return null;
    if (prior.payload_sha256 !== payloadHash) throw new ProductError('conflict', 'commandId was already used with a different payload');
    return { ...JSON.parse(prior.result_json), replayed: true };
  }

  function requireRole(packId, roleRuntimeId, predicate) {
    const check = predicate || roleExists;
    if (typeof check === 'function' && !check(packId, roleRuntimeId)) {
      throw new ProductError('not_found', 'role not found in the pack', [{ field: 'roleRuntimeId', message: 'unknown role' }]);
    }
  }

  function checkLimits(rules) {
    const errors = [];
    if (rules.length > MAX_RULES) errors.push({ field: 'rules', message: `at most ${MAX_RULES} rules per role` });
    if (rules.reduce((sum, rule) => sum + rule.text.length, 0) > MAX_TOTAL_CHARS) {
      errors.push({ field: 'rules', message: `total rule text must be at most ${MAX_TOTAL_CHARS} characters` });
    }
    if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
  }

  // kind: add | edit | remove. change(rules) returns { rules, ruleId } for the next revision.
  function mutate(kind, body, allowed, { actor, roleExists: predicate }, normalized, change) {
    checkEnvelope(body, allowed);
    const text = normalized ? normalizeText(body.text) : null;
    const { commandId, ...rest } = body;
    const payloadHash = sha256(canonicalJson({ kind: `role_rule_${kind}`, projectId, body: rest }));
    const replay = priorCommand(commandId, payloadHash);
    if (replay) return replay;
    requireRole(body.packId, body.roleRuntimeId, predicate);
    const result = db.transaction(() => {
      const again = priorCommand(commandId, payloadHash);
      if (again) return again;
      const previous = currentFor(body.packId, body.roleRuntimeId);
      const currentId = previous ? previous.rulesRevisionId : null;
      if (currentId !== body.expectedRevisionId) {
        throw new ProductError('stale_version', 'project rules are stale', { currentRevisionId: currentId });
      }
      const next = change(previous ? previous.rules : [], text);
      checkLimits(next.rules);
      const at = clock();
      const revisionId = newId('rr_');
      stmt('INSERT INTO role_rules_revisions (rules_revision_id, project_id, pack_id, role_runtime_id, rules_json, change_kind, '
        + 'change_rule_id, supersedes_id, actor, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(revisionId, projectId, body.packId, body.roleRuntimeId, JSON.stringify(next.rules), kind, next.ruleId,
          currentId, actor, commandId, at);
      stmt('INSERT INTO role_rules_current (project_id, pack_id, role_runtime_id, rules_revision_id) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT (project_id, pack_id, role_runtime_id) DO UPDATE SET rules_revision_id = excluded.rules_revision_id')
        .run(projectId, body.packId, body.roleRuntimeId, revisionId);
      const out = { revision: currentFor(body.packId, body.roleRuntimeId) };
      stmt('INSERT INTO product_commands (command_id, kind, payload_sha256, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(commandId, `role_rule_${kind}`, payloadHash, JSON.stringify(out), at);
      return { ...out, replayed: false };
    }).immediate();
    if (!result.replayed) emit(`role_rule_${kind === 'add' ? 'added' : kind === 'edit' ? 'edited' : 'removed'}`, body.packId, body.roleRuntimeId, result.revision.rulesRevisionId);
    return result;
  }

  const unknownRule = () => new ProductError('not_found', 'rule not found', [{ field: 'ruleId', message: 'unknown rule' }]);

  function addRule(body, { actor = 'operator', roleExists: predicate } = {}) {
    return mutate('add', body, ADD_FIELDS, { actor, roleExists: predicate }, true, (rules, text) => {
      const ruleId = newId('rl_');
      return { rules: [...rules, { ruleId, text }], ruleId };
    });
  }

  function editRule(body, { actor = 'operator', roleExists: predicate } = {}) {
    return mutate('edit', body, EDIT_FIELDS, { actor, roleExists: predicate }, true, (rules, text) => {
      if (!rules.some((rule) => rule.ruleId === body.ruleId)) throw unknownRule();
      return { rules: rules.map((rule) => (rule.ruleId === body.ruleId ? { ruleId: rule.ruleId, text } : rule)), ruleId: body.ruleId };
    });
  }

  function removeRule(body, { actor = 'operator', roleExists: predicate } = {}) {
    return mutate('remove', body, REMOVE_FIELDS, { actor, roleExists: predicate }, false, (rules) => {
      if (!rules.some((rule) => rule.ruleId === body.ruleId)) throw unknownRule();
      return { rules: rules.filter((rule) => rule.ruleId !== body.ruleId), ruleId: body.ruleId };
    });
  }

  return { currentFor, history, effectiveRules, addRule, editRule, removeRule };
}

module.exports = { createRoleRulesStore, MAX_RULE_CHARS, MAX_RULES, MAX_TOTAL_CHARS, HISTORY_LIMIT };
