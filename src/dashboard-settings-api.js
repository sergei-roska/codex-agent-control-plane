'use strict';

// M5 settings, account and model catalog API (D-M5-3, D-M5-6). Mounted by createDashboardApi behind
// the dashboard session; mutations add the origin guard. Errors use the dashboard JSON error shape.

const crypto = require('node:crypto');
const express = require('express');
const { MAX_RULE_CHARS, MAX_RULES, MAX_TOTAL_CHARS } = require('./role-rules-store');

const JSON_BODY_LIMIT = '16kb';
const STATUS_BY_CODE = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  stale_version: 409,
  conflict: 409,
  invalid_state: 409,
  catalog_unavailable: 503,
});
const FORBIDDEN_BODY_KEYS = ['packId', 'roleRuntimeId'];

const selectionOf = (role) => ({ model: role.model ?? null, effort: role.effort ?? null, serviceTier: role.serviceTier ?? null });

// (packId, runtimeId, role) -> effective settings, for the M4 /roles endpoint.
function makeSettingsResolver({ settingsStore } = {}) {
  if (!settingsStore || typeof settingsStore.effectiveDefault !== 'function') {
    throw new TypeError('makeSettingsResolver requires settingsStore');
  }
  return (packId, runtimeId, role) => {
    const profile = role && typeof role === 'object' ? role : {};
    const effective = settingsStore.effectiveDefault(packId, runtimeId, selectionOf(profile));
    return {
      model: effective.model,
      effort: effective.effort,
      serviceTier: effective.serviceTier,
      settingsSource: effective.source,
      source: effective.source,
    };
  };
}

function packRoles(pack) {
  const list = [{
    roleRuntimeId: pack.coordinator.runtimeId,
    publicId: pack.coordinator.publicId ?? null,
    displayName: pack.coordinator.displayName,
    kind: 'coordinator',
    role: pack.coordinator.role,
  }];
  for (const entry of pack.roles) {
    list.push({ roleRuntimeId: entry.runtimeId, publicId: entry.publicId ?? null, displayName: entry.displayName, kind: 'specialist', role: entry.role });
  }
  for (const [runtimeId, role] of pack.repairProfiles) {
    list.push({ roleRuntimeId: runtimeId, publicId: null, displayName: runtimeId, kind: 'repair', role });
  }
  return list;
}

function createSettingsRouter({
  activePack, legacyPack, modelCatalog, accountHealth, settingsStore, roleRulesStore, auth,
} = {}) {
  if (!activePack || !modelCatalog || !accountHealth || !settingsStore || !auth) {
    throw new TypeError('createSettingsRouter requires activePack, modelCatalog, accountHealth, settingsStore and auth');
  }
  const router = express.Router();
  const jsonBody = express.json({ limit: JSON_BODY_LIMIT });
  const wrap = (fn) => async (req, res, next) => {
    try { res.json(await fn(req)); } catch (error) { next(error); }
  };
  const fail = (code, message, details) => Object.assign(new Error(message), { code, ...(details !== undefined ? { details } : {}) });

  // Role keys resolve in the active pack first, then the legacy pack (its lead is configurable too).
  function locate(roleRuntimeId) {
    for (const pack of [activePack, legacyPack]) {
      if (!pack) continue;
      const entry = packRoles(pack).find((candidate) => candidate.roleRuntimeId === roleRuntimeId);
      if (entry) return { pack, entry };
    }
    throw fail('not_found', 'Role not found', [{ field: 'roleRuntimeId', message: 'unknown role' }]);
  }
  const roleExistsIn = (pack) => (packId, roleRuntimeId) => pack.packId === packId
    && packRoles(pack).some((entry) => entry.roleRuntimeId === roleRuntimeId);

  const catalogBody = async () => {
    const models = await modelCatalog.list();
    return { catalog: modelCatalog.status(), models };
  };

  router.get('/models', wrap(catalogBody));
  router.post('/models/refresh', auth.originGuard, wrap(async () => {
    await modelCatalog.refresh();
    return { catalog: modelCatalog.status(), models: await modelCatalog.list() };
  }));

  router.get('/account', wrap(() => accountHealth.get()));
  router.post('/account/refresh', auth.originGuard, wrap(() => accountHealth.get({ force: true })));

  router.get('/settings/roles', wrap(async () => {
    await modelCatalog.list();
    const roles = [];
    for (const entry of packRoles(activePack)) {
      const profile = selectionOf(entry.role);
      const current = settingsStore.currentFor(activePack.packId, entry.roleRuntimeId);
      const effective = settingsStore.effectiveDefault(activePack.packId, entry.roleRuntimeId, profile);
      const rulesCurrent = roleRulesStore ? roleRulesStore.currentFor(activePack.packId, entry.roleRuntimeId) : null;
      const verdict = await modelCatalog.validateSelection({ model: effective.model, effort: effective.effort, serviceTier: effective.serviceTier });
      roles.push({
        roleRuntimeId: entry.roleRuntimeId,
        publicId: entry.publicId,
        displayName: entry.displayName,
        kind: entry.kind,
        profile,
        current: current ? {
          settingsRevisionId: current.settingsRevisionId,
          model: current.model,
          effort: current.effort,
          serviceTier: current.serviceTier,
          createdAt: current.createdAt,
        } : null,
        effective: { model: effective.model, effort: effective.effort, serviceTier: effective.serviceTier, source: effective.source },
        valid: verdict.ok,
        errors: verdict.errors,
        ...(roleRulesStore ? { rules: { rulesRevisionId: rulesCurrent ? rulesCurrent.rulesRevisionId : null, count: rulesCurrent ? rulesCurrent.rules.length : 0 } } : {}),
      });
    }
    return { pack: { packId: activePack.packId, version: activePack.version }, roles };
  }));

  function commandBody(req, roleRuntimeId, packId) {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw fail('invalid_request', 'invalid request', [{ field: 'body', message: 'must be an object' }]);
    }
    const errors = FORBIDDEN_BODY_KEYS.filter((key) => Object.hasOwn(body, key)).map((field) => ({ field, message: 'unknown field' }));
    if (errors.length > 0) throw fail('invalid_request', 'invalid request', errors);
    return { ...body, packId, roleRuntimeId };
  }

  router.put('/settings/roles/:roleRuntimeId', auth.originGuard, jsonBody, async (req, res, next) => {
    try {
      const { pack } = locate(req.params.roleRuntimeId);
      const body = commandBody(req, req.params.roleRuntimeId, pack.packId);
      if (body.serviceTier === undefined) body.serviceTier = null;
      const result = await settingsStore.saveRoleDefault(body, { roleExists: roleExistsIn(pack) });
      res.status(result.replayed ? 200 : 201).json({ revision: result.revision, replayed: result.replayed });
    } catch (error) { next(error); }
  });

  router.delete('/settings/roles/:roleRuntimeId', auth.originGuard, jsonBody, (req, res, next) => {
    try {
      const { pack } = locate(req.params.roleRuntimeId);
      const body = commandBody(req, req.params.roleRuntimeId, pack.packId);
      const result = settingsStore.resetRoleDefault(body, { roleExists: roleExistsIn(pack) });
      res.json({ reset: result.reset, resetRevisionId: result.resetRevisionId, replayed: result.replayed });
    } catch (error) { next(error); }
  });

  router.get('/settings/roles/:roleRuntimeId/history', wrap((req) => {
    const { pack, entry } = locate(req.params.roleRuntimeId);
    const current = settingsStore.currentFor(pack.packId, entry.roleRuntimeId);
    return {
      packId: pack.packId,
      roleRuntimeId: entry.roleRuntimeId,
      currentRevisionId: current ? current.settingsRevisionId : null,
      revisions: settingsStore.history(pack.packId, entry.roleRuntimeId),
    };
  }));

  if (roleRulesStore) {
    router.get('/settings/roles/:roleRuntimeId/rules', wrap((req) => {
      const { pack, entry } = locate(req.params.roleRuntimeId);
      const current = roleRulesStore.currentFor(pack.packId, entry.roleRuntimeId);
      return {
        packId: pack.packId,
        roleRuntimeId: entry.roleRuntimeId,
        currentRevisionId: current ? current.rulesRevisionId : null,
        rules: current ? current.rules : [],
        limits: { maxRuleChars: MAX_RULE_CHARS, maxRules: MAX_RULES, maxTotalChars: MAX_TOTAL_CHARS },
        history: roleRulesStore.history(pack.packId, entry.roleRuntimeId),
      };
    }));

    const ruleCommand = (method, successStatus) => (req, res, next) => {
      try {
        const { pack } = locate(req.params.roleRuntimeId);
        const body = commandBody(req, req.params.roleRuntimeId, pack.packId);
        if (req.params.ruleId !== undefined) body.ruleId = req.params.ruleId;
        const result = roleRulesStore[method](body, { roleExists: roleExistsIn(pack) });
        res.status(result.replayed ? 200 : successStatus).json({ revision: result.revision, replayed: result.replayed });
      } catch (error) { next(error); }
    };
    router.post('/settings/roles/:roleRuntimeId/rules', auth.originGuard, jsonBody, ruleCommand('addRule', 201));
    router.put('/settings/roles/:roleRuntimeId/rules/:ruleId', auth.originGuard, jsonBody, ruleCommand('editRule', 200));
    router.delete('/settings/roles/:roleRuntimeId/rules/:ruleId', auth.originGuard, jsonBody, ruleCommand('removeRule', 200));
  }

  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    const status = STATUS_BY_CODE[error && error.code];
    if (!status || res.headersSent) return next(error);
    const message = status === 404 ? 'Not found' : String(error.message || 'Request failed').slice(0, 200);
    const body = { code: error.code, message, requestId: crypto.randomBytes(6).toString('hex') };
    if (error.details !== undefined) body.details = error.details;
    return res.status(status).json({ error: body });
  });

  return router;
}

module.exports = { createSettingsRouter, makeSettingsResolver };
