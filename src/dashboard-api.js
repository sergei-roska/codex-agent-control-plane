'use strict';

// Dashboard API. M1 reads (D-M1-4) plus M2 ticket commands and attachments (D-M2-3..5).
// Product commands never touch A2A tasks or the dispatch journal.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { MAX_ARTIFACT_BYTES, MAX_EXTRACTED_CHARS, ArtifactError, sanitizeDisplayName } = require('./artifact-store');
const { LIMITS, SPECIALTIES } = require('./product-store');

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
  payload_too_large: 413,
  unsupported_media_type: 415,
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
const UNAVAILABLE_TICKET_ACTIONS = ['pause', 'resume', 'stop', 'return_to_backlog', 'review', 'commit', 'push']
  .map((action) => ({ action, reason: 'Operator commands are not available in this release', milestone: 'M7' }));
const ALL_TICKET_ACTIONS = ['submit', 'edit', 'cancel', ...UNAVAILABLE_TICKET_ACTIONS.map((entry) => entry.action)];
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

function ticketActions(ticket) {
  if (ticket.status === 'backlog') {
    return {
      availableActions: ['edit', 'cancel'],
      unavailableActions: [
        { action: 'submit', reason: 'Intake arrives in M3', milestone: 'M3' },
        ...UNAVAILABLE_TICKET_ACTIONS.map((entry) => ({ ...entry })),
      ],
    };
  }
  return {
    availableActions: [],
    unavailableActions: ALL_TICKET_ACTIONS.map((action) => ({ action, reason: `Ticket is ${ticket.status}`, milestone: null })),
  };
}

function createDashboardApi({
  projection, events, roles, leadRole, workspace, projectId, startedAt, version, auth, productStore, artifactStore,
} = {}) {
  if (!projection || !events) throw new TypeError('createDashboardApi requires projection and events');
  const resolvedProjectId = projectId || computeProjectId(workspace);
  const started = startedAt || new Date().toISOString();
  const roleList = [
    ...(leadRole ? [{ role: leadRole, kind: 'lead' }] : []),
    ...[...(roles instanceof Map ? roles.values() : roles || [])].map((role) => ({ role, kind: 'specialist' })),
  ].map(({ role, kind }) => ({
    id: role.name,
    displayName: role.name,
    description: role.description,
    sandbox: role.sandbox,
    model: role.model,
    effort: role.effort,
    kind,
  }));
  const router = express.Router();

  const handle = (fn) => (req, res, next) => {
    try {
      res.json(fn(req));
    } catch (error) {
      next(error);
    }
  };

  const tickets = Boolean(productStore && artifactStore && auth);

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

  router.get('/roles', handle(() => ({ roles: roleList.map((entry) => ({ ...entry })) })));

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
      res.status(result.replayed ? 200 : 201).json({ ticket: result.ticket, revision: result.revision, replayed: result.replayed });
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

    router.post('/tickets/:ticketId/cancel', auth.originGuard, jsonBody, (req, res, next) => {
      try {
        commandResult(res, productStore.cancelTicket(req.params.ticketId, req.body), 'ticket_cancelled',
          (result) => ({ ordinal: result.revision.ordinal, version: result.ticket.version }));
      } catch (error) { next(error); }
    });

    router.get('/tickets/:ticketId', handle((req) => {
      const ticket = requireTicket(req.params.ticketId);
      const revision = productStore.getRevision(ticket.ticketId, ticket.currentRevisionId);
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
        ...ticketActions(ticket),
      };
    }));

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

module.exports = { collectStaleStagedArtifacts, createDashboardApi, computeProjectId, sendError, newRequestId };
