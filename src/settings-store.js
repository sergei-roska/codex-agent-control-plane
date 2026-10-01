'use strict';

// Per-role saved defaults (model, reasoning effort, service tier) with immutable history.
// Keyed by (packId, roleRuntimeId). Validation runs against the model catalog before any write.

const { ProductError, canonicalJson, validateEnvelope, sha256, defaultRandomId } = require('./product-store');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SAVE_FIELDS = ['commandId', 'packId', 'roleRuntimeId', 'model', 'effort', 'serviceTier', 'expectedRevisionId'];
const RESET_FIELDS = ['commandId', 'packId', 'roleRuntimeId', 'expectedRevisionId'];

function rowToRevision(row) {
  return row ? {
    settingsRevisionId: row.settings_revision_id,
    packId: row.pack_id,
    roleRuntimeId: row.role_runtime_id,
    model: row.model,
    effort: row.effort,
    serviceTier: row.service_tier,
    supersedesId: row.supersedes_id,
    actor: row.actor,
    createdAt: row.created_at,
  } : null;
}

function checkIds(body, extra = []) {
  const errors = [];
  for (const field of ['packId', 'roleRuntimeId']) {
    if (typeof body[field] !== 'string' || !ID_RE.test(body[field])) errors.push({ field, message: 'must be a valid identifier' });
  }
  if (body.expectedRevisionId !== null && (typeof body.expectedRevisionId !== 'string' || !body.expectedRevisionId)) {
    errors.push({ field: 'expectedRevisionId', message: 'must be a revision id or null' });
  }
  errors.push(...extra);
  if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
}

function createSettingsStore({ db, catalog, now, randomId, events, roleExists } = {}) {
  if (!db) throw new Error('createSettingsStore requires db');
  if (!catalog || typeof catalog.validateSelection !== 'function') throw new Error('createSettingsStore requires catalog');
  const clock = () => {
    const value = typeof now === 'function' ? now() : now;
    const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
    return date.toISOString();
  };
  const newId = randomId || defaultRandomId;
  const stmts = {};
  const stmt = (sql) => { if (!stmts[sql]) stmts[sql] = db.prepare(sql); return stmts[sql]; };

  const emit = (type, packId, roleRuntimeId, revisionId) => {
    if (!events) return;
    try { events.record(type, { namespace: packId, role: roleRuntimeId, causationId: revisionId, payload: {} }); } catch (_) { /* diagnostic only */ }
  };

  function currentFor(packId, roleRuntimeId) {
    return rowToRevision(stmt(
      'SELECT r.* FROM role_settings_current c JOIN role_settings_revisions r ON r.settings_revision_id = c.settings_revision_id '
      + 'WHERE c.pack_id = ? AND c.role_runtime_id = ?').get(String(packId), String(roleRuntimeId)));
  }

  function history(packId, roleRuntimeId) {
    return stmt('SELECT * FROM role_settings_revisions WHERE pack_id = ? AND role_runtime_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(String(packId), String(roleRuntimeId)).map(rowToRevision);
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

  function requireCurrent(packId, roleRuntimeId, expected) {
    const current = currentFor(packId, roleRuntimeId);
    const currentId = current ? current.settingsRevisionId : null;
    if (currentId !== expected) {
      throw new ProductError('stale_version', 'saved default is stale', { currentRevisionId: currentId });
    }
    return current;
  }

  async function saveRoleDefault(body, { actor = 'operator', roleExists: predicate } = {}) {
    validateEnvelope(body, SAVE_FIELDS);
    checkIds(body);
    const { commandId, ...rest } = body;
    const payloadHash = sha256(canonicalJson({ kind: 'role_default_save', body: rest }));
    const replay = priorCommand(commandId, payloadHash);
    if (replay) return replay;
    requireRole(body.packId, body.roleRuntimeId, predicate);
    const verdict = await catalog.validateSelection({ model: body.model, effort: body.effort, serviceTier: body.serviceTier });
    if (!verdict.ok) {
      if (verdict.code === 'catalog_unavailable') throw new ProductError('catalog_unavailable', 'model catalog is unavailable', verdict.errors);
      throw new ProductError('invalid_request', 'invalid settings', verdict.errors);
    }
    const sel = verdict.selection;
    const result = db.transaction(() => {
      const again = priorCommand(commandId, payloadHash);
      if (again) return again;
      const previous = requireCurrent(body.packId, body.roleRuntimeId, body.expectedRevisionId);
      const at = clock();
      const revisionId = newId('rs_');
      stmt('INSERT INTO role_settings_revisions (settings_revision_id, pack_id, role_runtime_id, model, effort, service_tier, '
        + 'supersedes_id, actor, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(revisionId, body.packId, body.roleRuntimeId, sel.model, sel.effort, sel.serviceTier,
          previous ? previous.settingsRevisionId : null, actor, commandId, at);
      stmt('INSERT INTO role_settings_current (pack_id, role_runtime_id, settings_revision_id) VALUES (?, ?, ?) '
        + 'ON CONFLICT (pack_id, role_runtime_id) DO UPDATE SET settings_revision_id = excluded.settings_revision_id')
        .run(body.packId, body.roleRuntimeId, revisionId);
      const out = { revision: currentFor(body.packId, body.roleRuntimeId) };
      stmt('INSERT INTO product_commands (command_id, kind, payload_sha256, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(commandId, 'role_default_save', payloadHash, JSON.stringify(out), at);
      return { ...out, replayed: false };
    }).immediate();
    if (!result.replayed) emit('role_default_saved', body.packId, body.roleRuntimeId, result.revision.settingsRevisionId);
    return result;
  }

  // Deletes only the current pointer; every revision stays in history.
  function resetRoleDefault(body, { roleExists: predicate } = {}) {
    validateEnvelope(body, RESET_FIELDS);
    checkIds(body);
    const { commandId, ...rest } = body;
    const payloadHash = sha256(canonicalJson({ kind: 'role_default_reset', body: rest }));
    const result = db.transaction(() => {
      const again = priorCommand(commandId, payloadHash);
      if (again) return again;
      requireRole(body.packId, body.roleRuntimeId, predicate);
      const previous = requireCurrent(body.packId, body.roleRuntimeId, body.expectedRevisionId);
      if (!previous) throw new ProductError('invalid_state', 'no saved default to reset');
      stmt('DELETE FROM role_settings_current WHERE pack_id = ? AND role_runtime_id = ?').run(body.packId, body.roleRuntimeId);
      const out = { reset: true, resetRevisionId: previous.settingsRevisionId };
      stmt('INSERT INTO product_commands (command_id, kind, payload_sha256, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(commandId, 'role_default_reset', payloadHash, JSON.stringify(out), clock());
      return { ...out, replayed: false };
    }).immediate();
    if (!result.replayed) emit('role_default_reset', body.packId, body.roleRuntimeId, result.resetRevisionId);
    return result;
  }

  function effectiveDefault(packId, roleRuntimeId, profileRole = {}) {
    const saved = currentFor(packId, roleRuntimeId);
    if (saved) {
      return { model: saved.model, effort: saved.effort, serviceTier: saved.serviceTier, source: 'saved', settingsRevisionId: saved.settingsRevisionId };
    }
    return {
      model: profileRole.model ?? null,
      effort: profileRole.effort ?? null,
      serviceTier: profileRole.serviceTier ?? null,
      source: 'profile',
      settingsRevisionId: null,
    };
  }

  return { saveRoleDefault, resetRoleDefault, currentFor, history, effectiveDefault };
}

module.exports = { createSettingsStore };
