'use strict';

// Read-only dashboard API (D-M1-4). Every handler is GET; projection and journal do the reading.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const MAX_EVENTS_LIMIT = 500;
const DEFAULT_EVENTS_LIMIT = 100;
const STATUS_BY_CODE = Object.freeze({ invalid_request: 400, not_found: 404 });
const MESSAGE_BY_CODE = Object.freeze({ invalid_request: 'Invalid request', not_found: 'Not found' });

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

function createDashboardApi({ projection, events, roles, leadRole, workspace, projectId, startedAt, version } = {}) {
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

  router.get('/context', handle(() => ({
    apiVersion: 1,
    project: { projectId: resolvedProjectId, displayName: path.basename(fs.realpathSync(workspace)), workspace: fs.realpathSync(workspace) },
    server: { version: version || null, startedAt: started, now: new Date().toISOString() },
    capabilities: { mutations: false, liveStream: false, events: true },
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

  router.use((req, res) => sendError(res, 404, 'not_found', 'Not found', newRequestId()));

  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    const requestId = newRequestId();
    if (error instanceof URIError || (error?.status === 400 && !STATUS_BY_CODE[error?.code])) {
      return sendError(res, 400, 'invalid_request', MESSAGE_BY_CODE.invalid_request || 'Invalid request', requestId);
    }
    const status = STATUS_BY_CODE[error?.code];
    if (status) {
      const message = status === 400 && typeof error.message === 'string' ? error.message.slice(0, 200) : MESSAGE_BY_CODE[error.code];
      return sendError(res, status, error.code, message, requestId);
    }
    process.stderr.write(`dashboard api error ${requestId}: ${error?.stack || error}\n`);
    return sendError(res, 500, 'unavailable', 'Internal error', requestId);
  });

  return router;
}

module.exports = { createDashboardApi, computeProjectId, sendError, newRequestId };
