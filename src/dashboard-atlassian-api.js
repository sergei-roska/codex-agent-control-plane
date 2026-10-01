'use strict';

const express = require('express');
const { CALLBACK_PATH } = require('./integrations/atlassian-config');

const JSON_LIMIT = '8kb';
const CALLBACK_ERROR = '/dashboard/#atlassian-oauth-error=failed';
const CALLBACK_ROUTE = CALLBACK_PATH.replace(/^\/api\/dashboard\/v1/, '');

function record(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key));
}
function exact(value, fields) { return record(value, fields) && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)); }
function scalar(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value); }
function coded(code) { const error = new Error('Atlassian request failed'); error.code = code; return error; }

function createAtlassianDashboardApi({ integration, auth } = {}) {
  if (!integration || !auth) throw new TypeError('Atlassian integration and dashboard auth are required');
  const router = express.Router();
  const json = express.json({ limit: JSON_LIMIT, strict: true });
  const run = (fn) => async (req, res, next) => {
    try { res.json(await fn(req)); } catch (error) { next(error); }
  };
  const session = (req) => {
    const value = req.dashboardSession?.hash;
    if (!scalar(value)) throw coded('unauthorized');
    return value;
  };
  const body = (req, fields) => {
    if (!exact(req.body, fields)) throw coded('invalid_request');
    return req.body;
  };

  router.get('/integrations/atlassian', run(() => integration.health()));
  router.post('/integrations/atlassian/begin', auth.originGuard, json, run((req) => {
    body(req, []);
    return integration.begin({ sessionId: session(req), origin: `http://${req.headers.host}` });
  }));
  router.post('/integrations/atlassian/complete', auth.originGuard, json, run((req) => {
    const input = body(req, ['handle']);
    if (!scalar(input.handle) || !/^[A-Za-z0-9_-]{43}$/.test(input.handle)) throw coded('invalid_request');
    return integration.complete({ sessionId: session(req), handle: input.handle });
  }));
  router.get('/integrations/atlassian/resources', run(() => integration.resources()));
  router.put('/integrations/atlassian/site', auth.originGuard, json, run((req) => {
    const input = body(req, ['cloudId']);
    if (!scalar(input.cloudId) || !/^[A-Za-z0-9-]{1,128}$/.test(input.cloudId)) throw coded('invalid_request');
    return integration.selectSite({ cloudId: input.cloudId });
  }));
  router.post('/integrations/atlassian/disconnect', auth.originGuard, json, run((req) => {
    body(req, []);
    return integration.disconnect({ sessionId: session(req) });
  }));
  router.post('/integrations/atlassian/import', auth.originGuard, json, run((req) => {
    const input = body(req, ['commandId', 'originId', 'issueIdOrKey']);
    if (!scalar(input.commandId) || !/^[A-Za-z0-9_-]{8,100}$/.test(input.commandId) || !scalar(input.originId) || !scalar(input.issueIdOrKey)) throw coded('invalid_request');
    if (!/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8})$/.test(input.issueIdOrKey)) throw coded('invalid_request');
    return integration.importIssue(input);
  }));
  router.post('/tickets/:ticketId/source/refresh', auth.originGuard, json, run((req) => {
    const input = body(req, ['commandId', 'expectedVersion']);
    if (!scalar(input.commandId) || !/^[A-Za-z0-9_-]{8,100}$/.test(input.commandId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw coded('invalid_request');
    return integration.refreshTicket(req.params.ticketId, input);
  }));
  router.get('/tickets/:ticketId/source', run((req) => {
    const source = integration.getTicketSource(req.params.ticketId);
    if (!source) throw coded('not_found');
    return source;
  }));
  router.get('/tickets/:ticketId/source/history', run((req) => {
    const allowed = ['beforeOrdinal', 'limit'];
    if (!record(req.query, allowed)) throw coded('invalid_request');
    const options = {};
    if (req.query.beforeOrdinal !== undefined) {
      if (typeof req.query.beforeOrdinal !== 'string' || !/^[1-9]\d{0,14}$/.test(req.query.beforeOrdinal)) throw coded('invalid_request');
      options.beforeOrdinal = Number(req.query.beforeOrdinal);
      if (!Number.isSafeInteger(options.beforeOrdinal)) throw coded('invalid_request');
    }
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(req.query.limit)) throw coded('invalid_request');
      options.limit = Number(req.query.limit);
      if (!Number.isSafeInteger(options.limit) || options.limit > 100) throw coded('invalid_request');
    }
    const history = integration.getTicketSourceHistory(req.params.ticketId, options);
    if (!history) throw coded('not_found');
    return history;
  }));
  router.get('/tickets/:ticketId/source/snapshots/:snapshotId', run((req) => {
    const snapshot = integration.getTicketSourceSnapshot(req.params.ticketId, req.params.snapshotId);
    if (!snapshot) throw coded('not_found');
    return { snapshot };
  }));
  return router;
}

function atlassianCallbackRoute({ integration, auth } = {}) {
  if (!integration || !auth) throw new TypeError('Atlassian integration and dashboard auth are required');
  const router = express.Router();
  router.get(CALLBACK_ROUTE, auth.hostGuard, auth.noStore, (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const query = req.query || {};
    const keys = Object.keys(query);
    const validKeys = keys.every((key) => ['state', 'code', 'error', 'error_description'].includes(key));
    const state = query.state;
    const code = query.code;
    const oauthError = query.error;
    const shapeValid = validKeys && keys.includes('state') && scalar(state) &&
      ((scalar(code) && oauthError === undefined && query.error_description === undefined) ||
        (scalar(oauthError) && code === undefined && (query.error_description === undefined || scalar(query.error_description))));
    if (!shapeValid) {
      if (scalar(state)) {
        try { integration.receiveCallback({ state, code: null }); } catch { /* consume malformed known states without exposing callback input */ }
      }
      return res.redirect(303, CALLBACK_ERROR);
    }
    try {
      const handoff = integration.receiveCallback({ state, ...(code !== undefined ? { code } : { error: oauthError }) });
      return res.redirect(303, `/dashboard/#atlassian-oauth=${encodeURIComponent(handoff.handle)}`);
    } catch {
      return res.redirect(303, CALLBACK_ERROR);
    }
  });
  return router;
}

module.exports = { CALLBACK_ERROR, CALLBACK_ROUTE, createAtlassianDashboardApi, atlassianCallbackRoute };
