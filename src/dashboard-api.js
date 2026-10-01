'use strict';

// Dashboard API. M1 reads (D-M1-4) plus M2 ticket commands and attachments (D-M2-3..5).
// Product commands never touch A2A tasks or the dispatch journal.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { MAX_ARTIFACT_BYTES, MAX_EXTRACTED_CHARS, ArtifactError, sanitizeDisplayName } = require('./artifact-store');
const { parseWorkerReport } = require('./contracts');
const { LIMITS, SPECIALTIES, ACTIVE_RUN_STATUSES } = require('./product-store');
const { createPipelinesRouter } = require('./dashboard-pipelines-api');
const { createSettingsRouter, makeSettingsResolver } = require('./dashboard-settings-api');
const { loadLegacyPack, loadRolePack } = require('./role-pack');
const { createAtlassianDashboardApi } = require('./dashboard-atlassian-api');

const MAX_EVENTS_LIMIT = 500;
const DEFAULT_EVENTS_LIMIT = 100;
const JSON_BODY_LIMIT = '1mb';
const STAGED_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STAGED_ARTIFACTS = 50;
const MAX_STAGED_BYTES = 100 * 1024 * 1024;
const STATUS_BY_CODE = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  stale_version: 409,
  conflict: 409,
  staging_limit: 409,
  invalid_state: 409,
  command_conflict: 409,
  connection_changed: 409,
  reconnect_required: 409,
  site_not_authorized: 409,
  scope_not_authorized: 409,
  not_configured: 503,
  source_unavailable: 503,
  request_timeout: 503,
  stale_decision: 409,
  settings_invalid: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  catalog_unavailable: 503,
});
const SPECIALTY_NAMES = Object.freeze({
  'project-manager': 'Project Manager',
  architect: 'Architect',
  developer: 'Developer',
  qa: 'QA',
  reviewer: 'Reviewer',
  security: 'Security',
  performance: 'Performance',
  devops: 'DevOps',
  'tech-writer': 'Technical Writer',
});
const ATTACHMENT_FORMATS = Object.freeze([
  { extensions: ['.txt', '.md', '.json'], mediaTypes: ['text/plain', 'text/markdown', 'application/json'], extraction: 'extracted' },
  { extensions: ['.png', '.jpg', '.jpeg', '.webp'], mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], extraction: 'stored_not_read' },
  {
    extensions: ['.pdf', '.doc', '.docx'],
    mediaTypes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    extraction: 'reference_only',
  },
]);
const UNAVAILABLE_TICKET_ACTIONS = ['accept', 'corrections', 'pause', 'resume', 'stop', 'return_to_backlog', 'commit', 'push']
  .map((action) => ({ action, reason: 'Operator commands are not available in this release', milestone: 'M7' }));
const MESSAGE_BY_CODE = Object.freeze({ invalid_request: 'Invalid request', not_found: 'Not found' });
const SAFE_MESSAGE_ERRORS = new Set(['ProductError', 'ArtifactError']);

function computeProjectId(workspace) {
  const real = fs.realpathSync(workspace);
  return `prj_${crypto.createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 16)}`;
}

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function sendError(res, status, code, message, requestId, details) {
  const error = { code, message, requestId };
  if (details !== undefined) error.details = details;
  res.status(status).json({ error });
}

// Deletes staged artifacts older than 24 h (file first, then row). Attached artifacts are never touched.
function collectStaleStagedArtifacts(productStore, artifactStore, now = Date.now()) {
  const cutoff = new Date(now - STAGED_ARTIFACT_TTL_MS).toISOString();
  const result = { deleted: 0, failed: 0 };
  for (const artifact of productStore.listStaleStagedArtifacts(cutoff)) {
    try {
      artifactStore.remove(artifact.storageRef);
      if (productStore.deleteStagedArtifact(artifact.artifactId)) result.deleted += 1;
    } catch (_) {
      result.failed += 1;
    }
  }
  return result;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

function single(query, name) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${name} must be a single string value`);
  return value;
}

function integerParam(query, name, { min, max, fallback }) {
  const value = single(query, name);
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,9}$/.test(value)) throw invalid(`${name} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) throw invalid(`${name} must be between ${min} and ${max}`);
  return n;
}

function publicArtifact(artifact) {
  return {
    artifactId: artifact.artifactId,
    displayName: artifact.displayName,
    mediaType: artifact.mediaType,
    size: artifact.size,
    sha256: artifact.sha256,
    extraction: artifact.extraction,
    extractedChars: artifact.extractedChars,
    extractionTruncated: artifact.extractionTruncated,
    state: artifact.state,
    createdAt: artifact.createdAt,
  };
}

// RFC 5987 ext-value plus an ASCII-only fallback for clients that ignore filename*.
function contentDisposition(displayName) {
  const fallback = displayName.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(displayName).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Per-status actions (D-M3-7). `answer` is offered only while a decision is pending.
function ticketActions(ticket, { latestRun, activeRun, pendingDecision }) {
  const available = [];
  const unavailable = [];
  const blockedBy = (action, reason, milestone = null) => unavailable.push({ action, reason, milestone });
  const statusReason = `Ticket is ${ticket.status}`;
  if (ticket.status === 'backlog') available.push('edit');
  else blockedBy('edit', statusReason);
  if (ticket.status === 'backlog' || (ticket.status === 'blocked' && !activeRun && latestRun)) available.push('submit');
  else blockedBy('submit', statusReason);
  if (pendingDecision) available.push('answer');
  const activeExecution = ticket.status === 'pending' || ticket.status === 'in_progress' || (latestRun && latestRun.status === 'running');
  if (ticket.status === 'backlog' || ((ticket.status === 'waiting_human' || ticket.status === 'blocked') && !activeExecution)) {
    available.push('cancel');
  } else if (activeExecution && ticket.status !== 'cancelled' && ticket.status !== 'done') {
    blockedBy('cancel', 'Stopping active work arrives in M7', 'M7');
  } else {
    blockedBy('cancel', statusReason);
  }
  return {
    availableActions: available,
    unavailableActions: [...unavailable, ...UNAVAILABLE_TICKET_ACTIONS.map((entry) => ({ ...entry }))],
  };
}

// Stage list for a run whose candidate does not exist yet: plan stages with journal attempts matched by stageId.
function liveStages(db, run, plan) {
  let rows = [];
  try {
    rows = db.prepare('SELECT attempt_id, role, state, result_json, stage_id FROM dispatch_journal WHERE run_id = ? ORDER BY created_at, rowid')
      .all(String(run.leadTaskId));
  } catch (_) { rows = []; }
  const parse = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
  const byStage = new Map();
  for (const row of rows) {
    if (!row.stage_id) continue;
    if (!byStage.has(row.stage_id)) byStage.set(row.stage_id, []);
    byStage.get(row.stage_id).push(row);
  }
  const stageRows = plan.stages.map((stage) => ({ stage, mine: byStage.get(stage.stageId) || [] }));
  const succeeded = new Set();
  const statusOf = ({ mine }) => {
    if (mine.length === 0) return null;
    const last = mine[mine.length - 1];
    if (last.state !== 'finished') return 'running';
    const result = parse(last.result_json) || {};
    // The worker report is JSON text in the task artifact; parse it exactly as the lead graph does.
    const { report } = result.status === 'TASK_STATE_COMPLETED'
      ? parseWorkerReport(result.artifacts?.[0]?.text || result.text)
      : { report: null };
    return report && report.outcome === 'completed' ? 'succeeded' : 'failed';
  };
  const statuses = stageRows.map((entry) => statusOf(entry));
  stageRows.forEach((entry, index) => { if (statuses[index] === 'succeeded') succeeded.add(entry.stage.stageId); });
  return stageRows.map((entry, index) => {
    const { stage, mine } = entry;
    let status = statuses[index];
    if (status === null) status = stage.dependencies.every((dep) => succeeded.has(dep)) ? 'eligible' : 'pending';
    return {
      stageId: stage.stageId,
      roleId: stage.roleId,
      required: stage.required,
      status,
      attempts: mine.map((row) => {
        const result = parse(row.result_json);
        const outcome = result && typeof result === 'object'
          ? (['outcome', 'status', 'state'].map((key) => result[key]).find((value) => typeof value === 'string') || null)
          : null;
        return { attemptId: row.attempt_id, role: row.role, journalState: row.state, outcome };
      }),
    };
  });
}

function createDashboardApi({
  projection, events, workspace, projectId, startedAt, version, auth, productStore, artifactStore, deliveryController, activePack, legacyPack, settingsResolver, modelCatalog, accountHealth, settingsStore, atlassianIntegration,
} = {}) {
  if (!projection || !events) throw new TypeError('createDashboardApi requires projection and events');
  const resolvedProjectId = projectId || computeProjectId(workspace);
  const started = startedAt || new Date().toISOString();
  const router = express.Router();

  const handle = (fn) => (req, res, next) => {
    try {
      res.json(fn(req));
    } catch (error) {
      next(error);
    }
  };

  const tickets = Boolean(productStore && artifactStore && auth);

  if (atlassianIntegration && auth) router.use(createAtlassianDashboardApi({ integration: atlassianIntegration, auth }));

  router.get('/context', handle(() => ({
    apiVersion: 1,
    project: { projectId: resolvedProjectId, displayName: path.basename(fs.realpathSync(workspace)), workspace: fs.realpathSync(workspace) },
    server: { version: version || null, startedAt: started, now: new Date().toISOString() },
    capabilities: {
      mutations: tickets,
      liveStream: false,
      events: true,
      ...(tickets ? { ticketCommands: ['create', 'revise', 'cancel'] } : {}),
    },
    ...(tickets ? {
      requestedSpecialties: SPECIALTIES.map((id) => ({ id, displayName: SPECIALTY_NAMES[id] || id })),
      attachmentPolicy: {
        formats: ATTACHMENT_FORMATS.map((entry) => ({ ...entry, extensions: [...entry.extensions], mediaTypes: [...entry.mediaTypes] })),
        maxFiles: LIMITS.artifactIds,
        maxFileBytes: MAX_ARTIFACT_BYTES,
        maxTotalBytes: LIMITS.artifactBytes,
        extractionCharLimit: MAX_EXTRACTED_CHARS,
      },
      trackingMode: 'internal',
    } : {}),
    health: { eventJournal: events.health() },
    lastEventSequence: events.lastSequence(),
  })));

  // Packs come from the server; the default profile paths are a fallback for embedded use.
  const legacy = legacyPack || loadLegacyPack();
  const pack = activePack || loadRolePack();
  if (modelCatalog && accountHealth && settingsStore && auth) {
    router.use(createSettingsRouter({ activePack: pack, legacyPack: legacy, modelCatalog, accountHealth, settingsStore, auth }));
  }
  router.use(createPipelinesRouter({
    activePack: pack, legacyPack: legacy, productStore, db: productStore ? productStore.db : null,
    settingsResolver: settingsResolver || (settingsStore ? makeSettingsResolver({ settingsStore }) : undefined),
  }));

  router.get('/cards', handle((req) => projection.listCards({
    column: single(req.query, 'column'),
    role: single(req.query, 'role'),
    q: single(req.query, 'q'),
    limit: single(req.query, 'limit'),
    cursor: single(req.query, 'cursor'),
  })));

  router.get('/cards/:cardId', handle((req) => projection.getCard(req.params.cardId)));
  router.get('/cards/:cardId/attempts', handle((req) => projection.getAttempts(req.params.cardId)));
  router.get('/cards/:cardId/usage', handle((req) => projection.getUsage(req.params.cardId)));

  router.get('/cards/:cardId/events', handle((req) => {
    const after = integerParam(req.query, 'after', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    const limit = integerParam(req.query, 'limit', { min: 1, max: MAX_EVENTS_LIMIT, fallback: DEFAULT_EVENTS_LIMIT });
    const ref = projection.decodeCardId(req.params.cardId);
    projection.getCard(req.params.cardId); // existence check: not_found for unknown or child cards
    const list = ref.namespace === 'orchestrator'
      ? events.listByRun(ref.taskId, { after, limit })
      : events.listByTask(ref.namespace, ref.taskId, { after, limit });
    return { events: list, nextAfter: list.length ? list[list.length - 1].sequence : after };
  }));

  if (tickets) {
    const jsonBody = express.json({ limit: JSON_BODY_LIMIT });
    const rawBody = express.raw({ type: () => true, limit: MAX_ARTIFACT_BYTES });
    const artifactsOf = (revision) => revision.artifactIds
      .map((id) => productStore.getArtifact(id)).filter(Boolean).map(publicArtifact);
    const requireTicket = (ticketId) => {
      const ticket = productStore.getTicket(ticketId);
      if (!ticket) throw Object.assign(new Error('Ticket not found'), { code: 'not_found' });
      return ticket;
    };
    const commandResult = (res, result, type, payload) => {
      if (!result.replayed) {
        events.record(type, { ticketId: result.ticket.ticketId, payload: payload(result) });
      }
      const body = { ticket: result.ticket, revision: result.revision, replayed: result.replayed };
      if (result.run) body.run = result.run;
      if (result.decision) body.decision = result.decision;
      res.status(result.replayed ? 200 : 201).json(body);
    };
    // Wakes the delivery loop after a committed command; its failures never reach the caller.
    const poke = () => {
      if (!deliveryController) return;
      try { Promise.resolve(deliveryController.poke()).catch(() => {}); } catch (_) { /* best effort */ }
    };
    const revisionPayload = (result) => ({
      ordinal: result.revision.ordinal,
      version: result.ticket.version,
      artifactCount: result.revision.artifactIds.length,
    });

    router.post('/tickets', auth.originGuard, jsonBody, (req, res, next) => {
      try {
        commandResult(res, productStore.createTicket(req.body), 'ticket_created', revisionPayload);
      } catch (error) { next(error); }
    });

    router.post('/tickets/:ticketId/revisions', auth.originGuard, jsonBody, (req, res, next) => {
      try {
        commandResult(res, productStore.reviseTicket(req.params.ticketId, req.body), 'ticket_revised', revisionPayload);
      } catch (error) { next(error); }
    });

    router.post('/tickets/:ticketId/cancel', auth.originGuard, jsonBody, async (req, res, next) => {
      try {
        const result = deliveryController
          ? await deliveryController.cancelTicket(req.params.ticketId, req.body)
          : productStore.cancelTicket(req.params.ticketId, req.body);
        commandResult(res, result, 'ticket_cancelled',
          (r) => ({ ordinal: r.revision.ordinal, version: r.ticket.version }));
        poke();
      } catch (error) { next(error); }
    });

    if (deliveryController) {
      router.post('/tickets/:ticketId/submit', auth.originGuard, jsonBody, async (req, res, next) => {
        try {
          // A replayed command returns its stored outcome without revalidating the catalog.
          const result = productStore.replayedSubmit(req.params.ticketId, req.body)
            || productStore.submitTicket(req.params.ticketId, req.body, await deliveryController.validatedSettingsSnapshot());
          commandResult(res, result, 'ticket_submitted', (r) => ({ version: r.ticket.version }));
          poke();
        } catch (error) { next(error); }
      });

      router.post('/tickets/:ticketId/decisions/:decisionId/answer', auth.originGuard, jsonBody, (req, res, next) => {
        try {
          const result = productStore.answerDecision(req.params.ticketId, req.params.decisionId, req.body);
          commandResult(res, result, 'ticket_answered', (r) => ({ version: r.ticket.version }));
          poke();
        } catch (error) { next(error); }
      });
    }

    router.get('/tickets/:ticketId', handle((req) => {
      const ticket = requireTicket(req.params.ticketId);
      const revision = productStore.getRevision(ticket.ticketId, ticket.currentRevisionId);
      const runs = productStore.listRuns(ticket.ticketId);
      const activeRun = productStore.getActiveRun(ticket.ticketId);
      const latestRun = productStore.latestRunOf(ticket.ticketId);
      const pendingDecision = latestRun
        ? productStore.listDecisions(latestRun.runId).some((decision) => decision.state === 'pending' && ACTIVE_RUN_STATUSES.includes(latestRun.status))
        : false;
      return {
        ticket,
        revision,
        revisions: productStore.listRevisions(ticket.ticketId).map((entry) => ({
          revisionId: entry.revisionId,
          ordinal: entry.ordinal,
          createdAt: entry.createdAt,
          actor: entry.actor,
          parentRevisionId: entry.parentRevisionId,
        })),
        artifacts: artifactsOf(revision),
        runs,
        activeRun: activeRun ? runs.find((entry) => entry.runId === activeRun.runId) : null,
        ...ticketActions(ticket, { latestRun, activeRun, pendingDecision }),
      };
    }));

    router.get('/runs/:runId', handle((req) => {
      const run = productStore.getRun(req.params.runId);
      if (!run) throw Object.assign(new Error('Run not found'), { code: 'not_found' });
      let stages;
      if (run.leadTaskId && !run.candidateId && run.planRevisionId) {
        const plan = productStore.getPlanRevision(run.planRevisionId);
        if (plan) stages = liveStages(productStore.db, run, plan);
      }
      return productStore.getRunView(run.runId, { stages });
    }));

    router.get('/runs/:runId/candidate/diff', (req, res, next) => {
      let artifact;
      let stream;
      try {
        const run = productStore.getRun(req.params.runId);
        const candidate = run && run.candidateId ? productStore.getCandidate(run.candidateId) : null;
        artifact = candidate && candidate.diffArtifactId ? productStore.getArtifact(candidate.diffArtifactId) : null;
        if (!artifact) throw Object.assign(new Error('Candidate diff not found'), { code: 'not_found' });
        stream = artifactStore.createReadStream(artifact.storageRef);
      } catch (error) {
        return next(error);
      }
      stream.once('error', (error) => {
        if (res.headersSent) return res.destroy(error);
        return next(error.code === 'ENOENT' ? Object.assign(new Error('Candidate diff not found'), { code: 'not_found' }) : error);
      });
      stream.once('open', () => {
        res.set({
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': String(artifact.size),
          'Content-Disposition': 'inline',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        });
        stream.pipe(res);
      });
      res.once('close', () => stream.destroy());
      return undefined;
    });

    router.get('/tickets/:ticketId/revisions/:revisionId', handle((req) => {
      const ticket = requireTicket(req.params.ticketId);
      const revision = productStore.getRevision(ticket.ticketId, req.params.revisionId);
      if (!revision) throw Object.assign(new Error('Revision not found'), { code: 'not_found' });
      return { revision, artifacts: artifactsOf(revision) };
    }));

    router.get('/tickets/:ticketId/events', handle((req) => {
      const after = integerParam(req.query, 'after', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      const limit = integerParam(req.query, 'limit', { min: 1, max: MAX_EVENTS_LIMIT, fallback: DEFAULT_EVENTS_LIMIT });
      const ticket = requireTicket(req.params.ticketId);
      const list = events.listByTicket(ticket.ticketId, { after, limit });
      return { events: list, nextAfter: list.length ? list[list.length - 1].sequence : after };
    }));

    router.post('/artifacts', auth.originGuard, rawBody, (req, res, next) => {
      let stored = null;
      try {
        const displayName = sanitizeDisplayName(req.get('x-filename'));
        collectStaleStagedArtifacts(productStore, artifactStore);
        const usage = productStore.stagedUsage();
        const incoming = Buffer.isBuffer(req.body) ? req.body.length : 0;
        if (usage.count >= MAX_STAGED_ARTIFACTS || usage.bytes + incoming > MAX_STAGED_BYTES) {
          throw new ArtifactError('staging_limit', 'Too many pending uploads; save or discard drafts first');
        }
        stored = artifactStore.store(req.body, displayName);
        const artifact = productStore.recordStagedArtifact(stored);
        events.record('artifact_staged', {
          causationId: artifact.artifactId,
          payload: { size: artifact.size, extraction: artifact.extraction },
        });
        res.status(201).json(publicArtifact(artifact));
      } catch (error) {
        if (stored) {
          try { artifactStore.remove(stored.storageRef); } catch (_) { /* best effort; staged GC has no row to find */ }
        }
        next(error);
      }
    });

    const lookupArtifact = (artifactId) => {
      const artifact = productStore.getArtifact(artifactId);
      if (!artifact) throw Object.assign(new Error('Artifact not found'), { code: 'not_found' });
      return artifact;
    };

    router.get('/artifacts/:artifactId', handle((req) => publicArtifact(lookupArtifact(req.params.artifactId))));

    router.get('/artifacts/:artifactId/content', (req, res, next) => {
      let artifact;
      let stream;
      try {
        artifact = lookupArtifact(req.params.artifactId);
        stream = artifactStore.createReadStream(artifact.storageRef);
      } catch (error) {
        return next(error);
      }
      stream.once('error', (error) => {
        if (res.headersSent) return res.destroy(error);
        return next(error.code === 'ENOENT' ? Object.assign(new Error('Artifact content not found'), { code: 'not_found' }) : error);
      });
      stream.once('open', () => {
        const type = artifact.extraction === 'extracted' ? `${artifact.mediaType}; charset=utf-8` : artifact.mediaType;
        res.set({
          'Content-Type': type,
          'Content-Length': String(artifact.size),
          'Content-Disposition': contentDisposition(artifact.displayName),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        });
        stream.pipe(res);
      });
      res.once('close', () => stream.destroy());
      return undefined;
    });
  }

  router.use((req, res) => sendError(res, 404, 'not_found', 'Not found', newRequestId()));

  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    const requestId = newRequestId();
    if (error instanceof URIError || (error?.status === 400 && !STATUS_BY_CODE[error?.code])) {
      return sendError(res, 400, 'invalid_request', MESSAGE_BY_CODE.invalid_request || 'Invalid request', requestId);
    }
    if (error?.type === 'entity.too.large' || error?.status === 413) {
      return sendError(res, 413, 'payload_too_large', 'Request body too large', requestId);
    }
    const status = STATUS_BY_CODE[error?.code];
    if (status) {
      const safe = SAFE_MESSAGE_ERRORS.has(error.name) || status === 400;
      const message = safe && typeof error.message === 'string' && status !== 404 ? error.message.slice(0, 200) : MESSAGE_BY_CODE[error.code] || 'Request failed';
      return sendError(res, status, error.code, message, requestId, error.details);
    }
    process.stderr.write(`dashboard api error ${requestId}: ${error?.stack || error}\n`);
    return sendError(res, 500, 'unavailable', 'Internal error', requestId);
  });

  return router;
}

module.exports = { collectStaleStagedArtifacts, createDashboardApi, liveStages, computeProjectId, sendError, newRequestId };
