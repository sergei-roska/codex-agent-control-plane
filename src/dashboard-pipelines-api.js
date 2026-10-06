'use strict';

// Read-only role, preset and pipeline views (D-M4-4). Mounted by createDashboardApi; never mutates state.

const express = require('express');
const { routeViewOf } = require('./ticket-telemetry');

const ACTIVE_STATUSES = ['queued', 'running', 'paused', 'interrupted'];
const DEFAULT_SETTLED_LIMIT = 20;
const MAX_SETTLED_LIMIT = 100;
const UNAVAILABLE_REASON = 'Needs its own contract and pilot';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

function limitParam(query) {
  const value = query.limit;
  if (value === undefined || value === '') return DEFAULT_SETTLED_LIMIT;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) throw invalid('limit must be an integer');
  const n = Number(value);
  if (n < 1 || n > MAX_SETTLED_LIMIT) throw invalid(`limit must be between 1 and ${MAX_SETTLED_LIMIT}`);
  return n;
}

// settingsResolver(packId, runtimeId, role) -> { model, effort, serviceTier, source } (M5); profile values otherwise.
function roleEntry(pack, { publicId, runtimeId, displayName, kind, role }, settingsResolver, activeByRuntime) {
  let resolved = null;
  if (typeof settingsResolver === 'function') {
    try { resolved = settingsResolver(pack.packId, runtimeId, role) || null; } catch (_) { resolved = null; }
  }
  const chain = pack.repairChains[runtimeId] || [];
  const activeAttempts = [runtimeId, ...chain].reduce((sum, id) => sum + (activeByRuntime.get(id) || 0), 0);
  return {
    publicId,
    runtimeId,
    displayName,
    kind,
    pack: pack.packId,
    sandbox: role.sandbox,
    model: resolved && resolved.model ? resolved.model : role.model,
    effort: resolved && resolved.effort ? resolved.effort : role.effort,
    serviceTier: resolved && resolved.serviceTier ? resolved.serviceTier : null,
    settingsSource: resolved && (resolved.source || resolved.settingsSource) === 'saved' ? 'saved' : 'profile',
    activeAttempts,
  };
}

function createPipelinesRouter({ activePack, legacyPack, productStore, db, settingsResolver } = {}) {
  if (!activePack) throw new TypeError('createPipelinesRouter requires activePack');
  const router = express.Router();
  const handle = (fn) => (req, res, next) => {
    try { res.json(fn(req)); } catch (error) { next(error); }
  };
  const database = db || (productStore && productStore.db) || null;

  const runningRuns = () => (productStore ? productStore.listActiveRuns().filter((run) => run.status === 'running') : []);

  // Nonterminal journal attempts of running runs, keyed by runtime role id.
  function activeAttemptCounts() {
    const counts = new Map();
    if (!database) return counts;
    const runIds = runningRuns().map((run) => run.leadTaskId).filter(Boolean).map(String);
    if (runIds.length === 0) return counts;
    try {
      const marks = runIds.map(() => '?').join(',');
      const rows = database.prepare(
        `SELECT role, COUNT(*) AS n FROM dispatch_journal WHERE state IN ('submitting','submitted') AND run_id IN (${marks}) GROUP BY role`,
      ).all(...runIds);
      for (const row of rows) counts.set(row.role, row.n);
    } catch (_) { /* journal table not available */ }
    return counts;
  }

  function packEntries(pack, legacy) {
    const list = [];
    const identity = (entry, kind) => ({
      publicId: legacy ? null : entry.publicId,
      runtimeId: entry.runtimeId,
      displayName: entry.displayName,
      kind: legacy ? 'legacy' : kind,
      role: entry.role,
    });
    list.push(identity(pack.coordinator, 'coordinator'));
    for (const entry of pack.roles) list.push(identity(entry, 'specialist'));
    for (const [runtimeId, role] of pack.repairProfiles) {
      list.push({ publicId: null, runtimeId, displayName: runtimeId, kind: legacy ? 'legacy' : 'repair', role });
    }
    return list;
  }

  router.get('/roles', handle(() => {
    const counts = activeAttemptCounts();
    const roles = packEntries(activePack, activePack.packId === 'legacy-orch')
      .map((entry) => roleEntry(activePack, entry, settingsResolver, counts));
    if (legacyPack && legacyPack.packId !== activePack.packId) {
      for (const entry of packEntries(legacyPack, true)) roles.push(roleEntry(legacyPack, entry, settingsResolver, counts));
    }
    return { activePack: { packId: activePack.packId, version: activePack.version }, roles };
  }));

  router.get('/presets', handle(() => ({
    presets: [...activePack.presets.values()].map((preset) => ({ ...preset, available: true })),
    unavailable: activePack.unavailablePresets.map((presetId) => ({ presetId, reason: UNAVAILABLE_REASON })),
  })));

  const packOf = (packId) => {
    if (legacyPack && packId === legacyPack.packId) return legacyPack;
    return activePack;
  };

  function pipelineRun(run) {
    const { liveStages, leanSkipStageIds } = require('./dashboard-api');
    const plan = run.planRevisionId ? productStore.getPlanRevision(run.planRevisionId) : null;
    const pack = packOf(run.settings && run.settings.rolePack);
    let base = [];
    if (plan) {
      const view = run.leadTaskId && !run.candidateId
        ? { stages: liveStages(database, run, plan, leanSkipStageIds(pack, plan, routeViewOf(productStore, run))) }
        : productStore.getRunView(run.runId);
      base = view.stages || [];
    }
    const planStages = new Map((plan ? plan.stages : []).map((stage) => [stage.stageId, stage]));
    const stages = base.map((stage) => {
      const planned = planStages.get(stage.stageId) || {};
      return {
        stageId: stage.stageId,
        publicRoleId: planned.publicRoleId || pack.runtimeToPublic(stage.roleId) || null,
        roleId: stage.roleId,
        required: stage.required,
        status: stage.status,
        attempts: (stage.attempts || []).map((attempt) => ({ ...attempt, repair: pack.repairProfiles.has(attempt.role) })),
      };
    });
    const ticket = productStore.getTicket(run.ticketId);
    return {
      runId: run.runId,
      ticketId: run.ticketId,
      title: ticket ? ticket.title : null,
      status: run.status,
      phase: run.phase,
      presetId: (plan && plan.presetId) || null,
      presetVersion: (plan && plan.presetVersion) || null,
      rolePack: (plan && plan.rolePack) || (run.settings && run.settings.rolePack) || null,
      planRevisionId: run.planRevisionId || null,
      stages,
    };
  }

  router.get('/pipelines', handle((req) => {
    const limit = limitParam(req.query);
    if (!productStore || !database) return { runs: [] };
    const active = productStore.listActiveRuns().reverse();
    const marks = ACTIVE_STATUSES.map(() => '?').join(',');
    const settled = database.prepare(
      `SELECT run_id FROM runs WHERE status NOT IN (${marks}) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...ACTIVE_STATUSES, limit).map((row) => productStore.getRun(row.run_id));
    return { runs: [...active, ...settled].map(pipelineRun) };
  }));

  return router;
}

module.exports = { createPipelinesRouter };
