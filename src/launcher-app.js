'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { ClientFactory } = require('@a2a-js/sdk/client');
const { parseCheckCommand } = require('./acceptance');
const { CodexAppServer } = require('./codex-app-server');
const { createAccountProfiles } = require('./account-profiles');
const { createConnectorPreferences } = require('./connector-preferences');
const { createConnectorService } = require('./connector-status');
const { loadRoles, createLeadRole, LEAD_ROLE_NAME } = require('./role-catalog');
const { canonicalRoleId } = require('./role-names');
const {
  RoleOverrideError,
  normalizeOverride,
  resolveRoleName,
  readOverridesFile,
  writeOverridesFile,
  effectiveRole,
  ROLE_CAPACITY_DEFAULTS,
} = require('./role-overrides');
const { ProjectError } = require('./launcher-projects');
const {
  SessionError,
  TERMINAL_STATES,
  formatLeadTask,
  listSessions,
  getSession,
  deleteLeadTask,
  deleteSession,
  sessionLeadTaskIds,
} = require('./launcher-sessions');
const { UsageLedger } = require('./usage-ledger');
const { summarize } = require('./usage-report');
const { sessionPerformance } = require('./session-performance');
const { buildSituation, buildReviewContexts, ownerPausedLead, gitStatus } = require('./session-situation');
const { createAskService, AskError } = require('./launcher-ask');
const { projectDeliveryObjectives, projectDeliveryVisibility, MAX_PAGE_SIZE } = require('./delivery-visibility');
const { readOwnerSettings, writeDeliveryEngine } = require('./launcher-project-settings');

const UI_DIR = path.join(__dirname, '..', 'launcher-ui');
const PROJECT_ID = /^[0-9a-f]{10}$/;
const ERROR_STATUS = {
  not_found: 404,
  not_a_directory: 400,
  running: 409,
  not_managed: 409,
  no_port: 503,
};
const LIMITS_TTL_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const ASK_PACK_FILES = 50;
const CONTROL_TIMEOUT_MS = 3000;
const RESUME_TEXT = 'Continue.';
const SYSTEM_KEY = '__system__';
const RESERVED_NAMES = new Set(['system']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendProjectError(res, err) {
  const status = err instanceof ProjectError ? (ERROR_STATUS[err.code] || 500) : 500;
  res.status(status).json({ success: false, error: err.message || String(err) });
}

const LEGACY_LEAD_ROLE = 'orch-lead';
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];

function usageBlock(rows) {
  const tokens = summarize(rows).tokens || Object.fromEntries(TOKEN_FIELDS.map((key) => [key, null]));
  return { ...tokens, attempts: rows.length };
}

// Lead rows are keyed by run id (= lead task id) and worker rows by the dispatch journal, because
// worker rows carry a per-attempt context id, not the session contextId. listByRun returns both.
// Returns null when the session does not exist.
function sessionUsage(db, contextId) {
  const leadIds = sessionLeadTaskIds(db, contextId);
  if (leadIds.length === 0) return null;
  const hasLedger = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger'").get());
  const rows = [];
  if (hasLedger) {
    const ledger = new UsageLedger({ db, readonly: true });
    const seen = new Set();
    for (const leadId of leadIds) {
      for (const row of ledger.listByRun(leadId)) {
        if (seen.has(row.entryId)) continue;
        seen.add(row.entryId);
        // Lead rows written before the lead role was named coordinator fold into the current lead key.
        if (row.kind === 'lead_turn' && row.role === LEGACY_LEAD_ROLE) row.role = LEAD_ROLE_NAME;
        rows.push(row);
      }
    }
  }
  const byRole = {};
  for (const role of [...new Set(rows.map((row) => row.role))].sort()) {
    byRole[role] = usageBlock(rows.filter((row) => row.role === role));
  }
  return { contextId, byRole, total: usageBlock(rows), unknownCount: summarize(rows).tokensUnknownRows };
}

function createLauncherApp({
  projects,
  readAuthToken,
  createClient = (baseUrl) => new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json'),
  createRoleClient = (roleUrl) => new ClientFactory().createFromUrl(`${roleUrl}/agent-card.json`, ''),
  openTasksDb = (file, options) => new Database(file, options),
  createAppServer = (options) => new CodexAppServer(options),
  accountProfiles = createAccountProfiles(),
  connectorLogoutImpl,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  limitsTtlMs = LIMITS_TTL_MS,
  askOptions = {},
}) {
  const app = express();
  const limitsCache = new Map();
  const limitsCacheEpochs = new Map();
  const limitsForcePending = new Map();
  const logins = new Map();
  const handshakes = new Map();

  app.use(express.json());

  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // Main UI: modern orchestrator console interface
  app.use('/ui', express.static(UI_DIR, { index: false }));

  app.get('/', (req, res) => {
    fs.readFile(path.join(UI_DIR, 'index.html'), 'utf8', (err, page) => {
      if (err) return res.status(500).send('UI unavailable: ' + err.message);
      res.type('html').send(page.split('__DEFAULT_WORKSPACE__').join(escapeHtml(process.cwd())));
    });
  });

  app.param('id', (req, res, next, id) => {
    if (!PROJECT_ID.test(id) || !projects.get(id)) {
      return res.status(404).json({ success: false, error: 'Unknown project: ' + id });
    }
    next();
  });

  // API: project registry
  app.get('/api/projects', (req, res) => {
    res.json({ projects: projects.list() });
  });

  app.post('/api/projects', async (req, res) => {
    try {
      const project = await projects.add(req.body && req.body.path);
      res.json({ success: true, project });
    } catch (err) {
      sendProjectError(res, err);
    }
  });

  app.delete('/api/projects/:id', async (req, res) => {
    try {
      const project = await projects.remove(req.params.id);
      ask.forget(req.params.id);
      res.json({ success: true, project });
    } catch (err) {
      sendProjectError(res, err);
    }
  });

  app.post('/api/projects/:id/start', async (req, res) => {
    try {
      const project = await projects.start(req.params.id);
      await projects.touch(req.params.id);
      res.json({ success: true, project });
    } catch (err) {
      sendProjectError(res, err);
    }
  });

  app.post('/api/projects/:id/stop', async (req, res) => {
    try {
      const project = await projects.stop(req.params.id);
      res.json({ success: true, project });
    } catch (err) {
      sendProjectError(res, err);
    }
  });

  app.get('/api/projects/:id/status', (req, res) => {
    try {
      const { logs, startupDiagnostic, ...project } = projects.status(req.params.id);
      res.json({
        project,
        status: project.status,
        readiness: project.readiness,
        readinessReason: project.readinessReason,
        taskReady: project.taskReady,
        logs,
        startupDiagnostic: startupDiagnostic || null
      });
    } catch (err) {
      sendProjectError(res, err);
    }
  });

  // API: Send A2A task directly via verified SDK
  app.post('/api/projects/:id/task/send', async (req, res) => {
    try {
      const id = req.params.id;
      const project = projects.get(id);
      if (project.status !== 'running') {
        return res.status(400).json({ success: false, error: 'Orchestrator server is not running!' });
      }
      if (project.taskReady !== true) {
        return res.status(503).json({
          success: false,
          code: 'project_not_task_ready',
          readiness: project.readiness || 'unknown',
          reason: project.readinessReason || null,
          error: 'Project server is not ready to accept tasks.'
        });
      }

      const { goal, checks, taskId, continueFrom, decision, choice, contextId: newContextId } = req.body;
      if (taskId && continueFrom) {
        return res.status(400).json({ success: false, error: 'taskId and continueFrom are mutually exclusive' });
      }
      // A client-provided contextId only names a new session (no taskId, no continueFrom).
      const startsSession = !taskId && !continueFrom && newContextId !== undefined && newContextId !== null && newContextId !== '';
      if (startsSession && !(typeof newContextId === 'string' && UUID.test(newContextId))) {
        return res.status(400).json({ success: false, error: 'contextId must be a UUID' });
      }
      const baseUrl = projects.baseUrl(id);
      const authToken = readAuthToken(process.env.CODEX_A2A_TOKEN_FILE ? { filePath: process.env.CODEX_A2A_TOKEN_FILE } : undefined);
      const client = await createClient(baseUrl);
      const requestOptions = { serviceParameters: { Authorization: `Bearer ${authToken}` } };

      let contextId = startsSession ? newContextId : '';
      const lookupId = taskId || continueFrom;
      if (lookupId) {
        const existing = await client.getTask({ tenant: '', id: lookupId }, requestOptions);
        contextId = existing?.contextId || '';
      }

      const messageMetadata = {};
      if (choice !== undefined && choice !== '') messageMetadata.choice = choice;
      if (decision !== undefined && decision !== '') messageMetadata.decisionId = decision;
      if (Array.isArray(checks) && checks.length > 0) {
        messageMetadata.acceptance = {
          requiredChecks: checks.map((cmd, idx) => parseCheckCommand(cmd, idx))
        };
      }

      await projects.touch(id);
      const result = await client.sendMessage({
        tenant: '',
        message: {
          messageId: `web-${Date.now()}`,
          contextId,
          taskId: taskId || '',
          role: 1, // USER
          parts: [{ content: { $case: 'text', value: goal || '' }, mediaType: 'text/plain', filename: '', metadata: undefined }],
          metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
          extensions: [],
          referenceTaskIds: continueFrom ? [continueFrom] : [],
        },
        configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
        metadata: undefined,
      }, requestOptions);

      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Runs fn(db) on the project state DB; returns undefined when the DB file does not exist yet.
  function withTasksDb(projectId, options, fn) {
    const dbPath = projects.stateDbPath(projectId);
    if (!fs.existsSync(dbPath)) return undefined;
    const db = openTasksDb(dbPath, options);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  // Like withTasksDb, for an async projection that reads the database after an await.
  async function withTasksDbAsync(projectId, options, fn) {
    const dbPath = projects.stateDbPath(projectId);
    if (!fs.existsSync(dbPath)) return undefined;
    const db = openTasksDb(dbPath, options);
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }

  // API: sessions (one A2A contextId = one conversation of lead tasks)
  app.get('/api/projects/:id/sessions', (req, res) => {
    try {
      const sessions = withTasksDb(req.params.id, { readonly: true }, listSessions);
      res.json({ sessions: sessions || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Additive read-only projection. It intentionally reads optional delivery tables
  // directly: constructing a store here would create schema during a GET.
  app.get('/api/projects/:id/delivery/objectives', (req, res) => {
    const { sessionId } = req.query;
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128)) {
      return res.status(400).json({ error: 'Invalid delivery objective query' });
    }
    try {
      const projection = withTasksDb(req.params.id, { readonly: true, fileMustExist: true }, db => projectDeliveryObjectives(db, { projectId: req.params.id, sessionId }));
      res.json(projection || { available: false, objectives: [], truncated: false });
    } catch (err) {
      res.status(500).json({ error: 'Delivery objectives unavailable', code: err.code || 'visibility_error' });
    }
  });

  app.get('/api/projects/:id/delivery/backlog', (req, res) => {
    const { objectiveId, sessionId, afterCursor = '' } = req.query;
    const limitText = req.query.limit === undefined ? '25' : req.query.limit;
    if (typeof objectiveId !== 'string' || !objectiveId || objectiveId.length > 128
      || (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128))
      || typeof afterCursor !== 'string' || afterCursor.length > 2048
      || typeof limitText !== 'string' || !/^\d{1,3}$/.test(limitText)) {
      return res.status(400).json({ error: 'Invalid delivery backlog query' });
    }
    const limit = Number(limitText);
    if (limit < 1 || limit > MAX_PAGE_SIZE) return res.status(400).json({ error: 'Invalid delivery backlog limit' });
    try {
      const projection = withTasksDb(req.params.id, { readonly: true, fileMustExist: true }, db =>
        projectDeliveryVisibility(db, { projectId: req.params.id, objectiveId, sessionId, afterCursor, limit }));
      res.json(projection || { schema: 'delivery-visibility/v1', projectId: req.params.id, objectiveId, sessionId: sessionId || null,
        available: false, objective: null, counts: { ready: null, blocked: null, active: null }, tasks: [], nextCursor: null,
        capacity: null, planner: { available: false, state: 'unknown' }, inbox: { available: false, state: 'unknown' }, unavailableReason: 'state_database_unavailable' });
    } catch (err) {
      if (err instanceof TypeError) return res.status(400).json({ error: 'Invalid delivery backlog cursor or scope' });
      res.status(500).json({ error: 'Delivery visibility unavailable', code: err.code || 'visibility_error' });
    }
  });

  function deliveryRunMapping(projectId, objectiveId, sessionId) {
    return withTasksDb(projectId, { readonly: true, fileMustExist: true }, (db) => {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='concurrent_delivery_runs'").get();
      if (!table) return null;
      return db.prepare('SELECT run_id FROM concurrent_delivery_runs WHERE project_id=? AND objective_id=? AND session_id=?')
        .get(projectId, objectiveId, sessionId) || null;
    });
  }

  function validScopeId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  }

  function controlScopeMatches(status, projectId, sessionId, objectiveId, runId) {
    return status && status.engine === 'concurrent-v1' && status.projectId === projectId
      && status.sessionId === sessionId && status.objectiveId === objectiveId && status.runId === runId;
  }

  app.get('/api/projects/:id/delivery/control', async (req, res) => {
    const { objectiveId, sessionId } = req.query;
    if (!validScopeId(objectiveId) || !validScopeId(sessionId)) return res.status(400).json({ error: 'Invalid delivery control scope' });
    try {
      if (projects.get(req.params.id).status !== 'running') return res.json({ available: false, reason: 'project_stopped' });
      const mapping = deliveryRunMapping(req.params.id, objectiveId, sessionId);
      if (!mapping) return res.json({ available: false, reason: 'concurrent_run_unavailable' });
      let control;
      try { control = await controlCall(req.params.id, 'GET', `/control/delivery/${encodeURIComponent(mapping.run_id)}`); }
      catch (_) { return res.json({ available: false, reason: 'owner_control_unavailable' }); }
      if (!controlScopeMatches(control, req.params.id, sessionId, objectiveId, mapping.run_id)) {
        return res.status(502).json({ error: 'Delivery control scope could not be verified' });
      }
      res.json(control);
    } catch (_) {
      res.status(503).json({ available: false, reason: 'delivery_control_unavailable' });
    }
  });

  const STEER_FIELDS = ['runId', 'projectId', 'sessionId', 'objectiveId', 'messageId', 'text', 'expectedPlanRevision', 'expectedGoalRevision', 'expectedControlRevision'];
  app.post('/api/projects/:id/delivery/steer', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== STEER_FIELDS.length
      || Object.keys(body).some((key) => !STEER_FIELDS.includes(key))
      || STEER_FIELDS.some((key) => !Object.hasOwn(body, key))
      || !validScopeId(body.runId) || body.projectId !== req.params.id || !validScopeId(body.sessionId)
      || !validScopeId(body.objectiveId) || !validScopeId(body.messageId)
      || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000
      || ['expectedPlanRevision', 'expectedGoalRevision', 'expectedControlRevision'].some((key) => !Number.isSafeInteger(body[key]) || body[key] < 0)) {
      return res.status(400).json({ error: 'Invalid delivery steering request' });
    }
    try {
      if (projects.get(req.params.id).status !== 'running') return res.status(409).json({ error: 'Project server is stopped' });
      const mapping = deliveryRunMapping(req.params.id, body.objectiveId, body.sessionId);
      if (!mapping || mapping.run_id !== body.runId) return res.status(409).json({ error: 'Delivery run scope is no longer current' });
      let current;
      try { current = await controlCall(req.params.id, 'GET', `/control/delivery/${encodeURIComponent(mapping.run_id)}`); }
      catch (_) { return res.status(503).json({ error: 'Owner steering is unavailable' }); }
      if (!controlScopeMatches(current, req.params.id, body.sessionId, body.objectiveId, mapping.run_id)) return res.status(409).json({ error: 'Delivery run scope is no longer current' });
      try {
        const acknowledgement = await controlCall(req.params.id, 'POST', `/control/delivery/${encodeURIComponent(mapping.run_id)}/steer`, body);
        const validAck = controlScopeMatches(acknowledgement, req.params.id, body.sessionId, body.objectiveId, mapping.run_id)
          && acknowledgement.messageId === body.messageId && acknowledgement.acknowledged === true
          && ['received', 'applied', 'blocked'].includes(acknowledgement.state);
        if (!validAck) return res.status(502).json({ error: 'Steering acknowledgement could not be verified' });
        res.json(acknowledgement);
      } catch (error) {
        const status = /answered 409/.test(error.message) ? 409 : /answered 404/.test(error.message) ? 503 : 502;
        res.status(status).json({ error: status === 409 ? 'Delivery state changed; refresh before sending' : 'Owner steering is unavailable' });
      }
    } catch (_) {
      res.status(503).json({ error: 'Owner steering is unavailable' });
    }
  });

  app.get('/api/projects/:id/delivery-engine', (req, res) => {
    try {
      const stopped = projects.get(req.params.id).status === 'stopped';
      const settings = readOwnerSettings(projects.projectSettingsPath(req.params.id));
      res.json({ deliveryEngine: settings.deliveryEngine || 'legacy', running: !stopped, stopped });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });

  app.put('/api/projects/:id/delivery-engine', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'deliveryEngine')
      || !['legacy', 'concurrent-v1'].includes(req.body.deliveryEngine)) return res.status(400).json({ error: 'Invalid delivery engine' });
    if (projects.get(req.params.id).status !== 'stopped') return res.status(409).json({ error: 'Stop the project server before changing its delivery engine' });
    try {
      const settings = writeDeliveryEngine(projects.projectSettingsPath(req.params.id), req.body.deliveryEngine);
      res.json({ deliveryEngine: settings.deliveryEngine, running: false });
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  });

  app.get('/api/projects/:id/sessions/:contextId', (req, res) => {
    try {
      const session = withTasksDb(req.params.id, { readonly: true }, db => getSession(db, req.params.contextId));
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Token usage of one session: { contextId, byRole, total, unknownCount }. No state DB yet -> empty usage.
  app.get('/api/projects/:id/sessions/:contextId/usage', (req, res) => {
    try {
      const contextId = req.params.contextId;
      const usage = withTasksDb(req.params.id, { readonly: true }, db => sessionUsage(db, contextId));
      if (usage === null) return res.status(404).json({ error: 'Session not found' });
      const response = usage || { contextId, byRole: {}, total: usageBlock([]), unknownCount: 0 };
      if (req.query.details === 'performance') {
        const performance = withTasksDb(req.params.id, { readonly: true }, db => sessionPerformance(db, contextId));
        if (performance === null) return res.status(404).json({ error: 'Session not found' });
        response.performance = performance || {
          schema: 'session-performance/v1',
          generatedAt: new Date().toISOString(),
          totals: summarize([]),
          byRole: {},
          retryAttempts: 0,
          attempts: [],
        };
      }
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Calls a project server control route with the loopback token; the body is the server's JSON.
  async function controlCall(projectId, method, route, body) {
    const authToken = readAuthToken(process.env.CODEX_A2A_TOKEN_FILE ? { filePath: process.env.CODEX_A2A_TOKEN_FILE } : undefined);
    const response = await fetch(projects.baseUrl(projectId) + route, {
      method,
      headers: { Authorization: `Bearer ${authToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Project server answered ${response.status} for ${route}`);
    return response.json();
  }

  // Lead task ids with a pending pause request; [] when the server is stopped or does not answer.
  async function pauseRequestedRuns(projectId) {
    if (projects.get(projectId).status !== 'running') return [];
    try {
      const { runs } = await controlCall(projectId, 'GET', '/control/pause');
      return (Array.isArray(runs) ? runs : []).filter((run) => run.pauseRequested === true).map((run) => run.taskId);
    } catch (_) {
      return [];
    }
  }

  // Situation of one session: where the lead is, the current batch, open decisions, progress.
  app.get('/api/projects/:id/sessions/:contextId/situation', async (req, res) => {
    try {
      const requested = await pauseRequestedRuns(req.params.id);
      const situation = await withTasksDbAsync(req.params.id, { readonly: true }, db => buildSituation(db, req.params.contextId, { pauseRequestedRuns: requested }));
      if (!situation) return res.status(404).json({ error: 'Session not found' });
      res.json(situation);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stored review contexts from the latest session checkpoint.
  app.get('/api/projects/:id/sessions/:contextId/review-contexts', async (req, res) => {
    try {
      const reviewContexts = await withTasksDbAsync(req.params.id, { readonly: true }, db => buildReviewContexts(db, req.params.contextId));
      if (!reviewContexts) return res.status(404).json({ error: 'Session not found' });
      res.json(reviewContexts);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PAUSE-01: soft stop. A pause only flags the active lead run(s); the run parks at its next safe
  // boundary and no worker is cancelled. 409 {error} when there is nothing to act on.
  const conflict = (res, error) => res.status(409).json({ success: false, error });

  app.post('/api/projects/:id/pause', async (req, res) => {
    try {
      if (projects.get(req.params.id).status !== 'running') return conflict(res, 'Orchestrator server is not running');
      const { runs } = await controlCall(req.params.id, 'POST', '/control/pause', {});
      if (!Array.isArray(runs) || runs.length === 0) return conflict(res, 'No lead run is active, so there is nothing to pause');
      res.json({ success: true, runs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  app.post('/api/projects/:id/pause/cancel', async (req, res) => {
    try {
      if (projects.get(req.params.id).status !== 'running') return conflict(res, 'Orchestrator server is not running');
      const { runs } = await controlCall(req.params.id, 'POST', '/control/pause/cancel', {});
      if (!Array.isArray(runs) || runs.length === 0) return conflict(res, 'No pause request is pending');
      res.json({ success: true, runs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Sends the continue message to the lead task of the given (or latest) session when it is parked on an owner pause.
  app.post('/api/projects/:id/resume', async (req, res) => {
    try {
      const id = req.params.id;
      if (projects.get(id).status !== 'running') return conflict(res, 'Orchestrator server is not running');
      const wanted = req.body?.sessionContextId;
      if (wanted !== undefined && wanted !== null && wanted !== '' && typeof wanted !== 'string') {
        return res.status(400).json({ success: false, error: 'sessionContextId must be a string' });
      }
      const paused = withTasksDb(id, { readonly: true }, (db) => {
        const contextId = wanted || listSessions(db)[0]?.contextId;
        return contextId ? ownerPausedLead(db, contextId) : null;
      });
      if (!paused) return conflict(res, 'Nothing is paused');
      const client = await createClient(projects.baseUrl(id));
      const authToken = readAuthToken(process.env.CODEX_A2A_TOKEN_FILE ? { filePath: process.env.CODEX_A2A_TOKEN_FILE } : undefined);
      await projects.touch(id);
      await client.sendMessage({
        tenant: '',
        message: {
          messageId: `web-resume-${Date.now()}`,
          contextId: paused.contextId,
          taskId: paused.taskId,
          role: 1, // USER
          parts: [{ content: { $case: 'text', value: RESUME_TEXT }, mediaType: 'text/plain', filename: '', metadata: undefined }],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
        metadata: undefined,
      }, { serviceParameters: { Authorization: `Bearer ${authToken}` } });
      res.json({ success: true, taskId: paused.taskId });
    } catch (err) {
      const message = err.message || String(err);
      res.status(/already executing/.test(message) ? 409 : 500).json({ success: false, error: message });
    }
  });

  // Git status of the project directory; a git failure other than "not a repository" is a 503.
  app.get('/api/projects/:id/git-status', async (req, res) => {
    try {
      res.json(await gitStatus(projects.get(req.params.id).path));
    } catch (err) {
      res.status(503).json({ error: err.killed ? 'git status timed out' : (err.message || String(err)) });
    }
  });

  // SIT-5: owner questions answered by the read-only scout; the lead loop is never contacted.
  async function askPack(projectId, sessionContextId) {
    let situation = null;
    if (sessionContextId) {
      try {
        situation = (await withTasksDbAsync(projectId, { readonly: true }, db => buildSituation(db, sessionContextId))) || null;
      } catch (_) { /* the pack is optional context */ }
    }
    let git = null;
    try {
      git = await gitStatus(projects.get(projectId).path);
      if (Array.isArray(git.files) && git.files.length > ASK_PACK_FILES) {
        git = { ...git, files: git.files.slice(0, ASK_PACK_FILES), filesOmitted: git.files.length - ASK_PACK_FILES };
      }
    } catch (_) { /* the pack is optional context */ }
    return { situation, git };
  }

  const ask = createAskService({
    projects,
    authToken: () => readAuthToken(process.env.CODEX_A2A_TOKEN_FILE ? { filePath: process.env.CODEX_A2A_TOKEN_FILE } : undefined),
    createClient: createRoleClient,
    buildPack: askPack,
    ...askOptions,
  });

  function sendAskError(res, err) {
    if (err instanceof AskError) return res.status(err.status).json({ success: false, error: err.message });
    res.status(500).json({ success: false, error: err.message || String(err) });
  }

  app.post('/api/projects/:id/ask', (req, res) => {
    try {
      res.json(ask.start(req.params.id, req.body));
    } catch (err) {
      sendAskError(res, err);
    }
  });

  app.get('/api/projects/:id/ask/:askId', (req, res) => {
    const record = ask.get(req.params.id, req.params.askId);
    if (!record) return res.status(404).json({ success: false, error: 'Unknown ask: ' + req.params.askId });
    res.json(record);
  });

  app.delete('/api/projects/:id/ask/:askId', async (req, res) => {
    try {
      const record = await ask.cancel(req.params.id, req.params.askId);
      if (!record) return res.status(404).json({ success: false, error: 'Unknown ask: ' + req.params.askId });
      res.json(record);
    } catch (err) {
      sendAskError(res, err);
    }
  });

  app.delete('/api/projects/:id/sessions/:contextId', (req, res) => {
    try {
      const deletedIds = withTasksDb(req.params.id, {}, db => deleteSession(db, req.params.contextId));
      if (!deletedIds) return res.status(404).json({ success: false, error: 'Session not found' });
      res.json({ success: true, deletedIds });
    } catch (err) {
      if (err instanceof SessionError) {
        return res.status(err.code === 'not_found' ? 404 : 400).json({ success: false, error: err.message });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // API: Details of a specific task by ID
  app.get('/api/projects/:id/tasks/:taskId', (req, res) => {
    try {
      const dbPath = projects.stateDbPath(req.params.id);
      if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });
      const result = withTasksDb(req.params.id, { readonly: true }, (db) => {
        const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' AND id = ?").get(req.params.taskId);
        return lead ? formatLeadTask(db, lead) : null;
      });
      if (!result) return res.status(404).json({ error: 'Task not found' });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: Safe deletion of a task and its records
  app.delete('/api/projects/:id/tasks/:taskId', (req, res) => {
    try {
      const taskId = req.params.taskId;
      const dbPath = projects.stateDbPath(req.params.id);
      if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });
      const outcome = withTasksDb(req.params.id, {}, (db) => {
        const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' AND id = ?").get(taskId);
        if (!lead) return { status: 404, body: { error: 'Task not found' } };
        if (!TERMINAL_STATES.includes(lead.status_state)) {
          return { status: 400, body: { error: 'Cannot delete an active task!' } };
        }
        deleteLeadTask(db, taskId);
        return { status: 200, body: { success: true, deletedId: taskId } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: team description for the "about" card
  const pickRole = (r) => ({
    name: r.name,
    displayName: r.displayName || r.name,
    description: r.description,
    model: r.model,
    effort: r.effort,
    maxConcurrentAgents: r.maxConcurrentAgents,
    fastMode: r.fastMode,
    sandbox: r.sandbox,
    tools: { mcpServers: r.tools.mcpServers, skills: r.tools.skills },
  });

  app.get('/api/team', (req, res) => {
    try {
      res.json({
        lead: pickRole(createLeadRole()),
        roles: Array.from(loadRoles().values()).map(pickRole),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ROLE-01: the team of one project with its role overrides applied (model, effort, extra rules).
  // The project server reads the overrides once at start, so they are edited only while it is stopped.
  const serverActive = (id) => projects.get(id).status !== 'stopped';

  function projectTeam(file, id) {
    const baseLead = createLeadRole();
    const baseRoles = loadRoles();
    const { roles: overrides, warning } = readOverridesFile(file, [...baseRoles.keys()]);
    const describe = (base) => {
      const override = overrides[canonicalRoleId(base.name)] || null;
      return {
        ...pickRole(effectiveRole(base, override)),
        defaults: { model: base.model, effort: base.effort, maxConcurrentAgents: ROLE_CAPACITY_DEFAULTS[canonicalRoleId(base.name)] || 1, fastMode: base.fastMode || 'off' },
        override: override ? { model: override.model ?? null, effort: override.effort ?? null, maxConcurrentAgents: override.maxConcurrentAgents ?? null, fastMode: override.fastMode ?? null, extraRules: override.extraRules ?? null } : null,
      };
    };
    const all = [baseLead, ...baseRoles.values()];
    return {
      lead: describe(baseLead),
      roles: [...baseRoles.values()].map(describe),
      models: [...new Set(all.map((role) => role.model))].sort(),
      warning,
      running: serverActive(id),
    };
  }

  app.get('/api/projects/:id/team', (req, res) => {
    try {
      res.json(projectTeam(projects.roleOverridesPath(req.params.id), req.params.id));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/models/capabilities', async (_req, res) => {
    const server = createAppServer({ cwd: process.cwd(), requestTimeoutMs: 15000 });
    try {
      res.json({ available: true, models: await server.listModels() });
    } catch (_) {
      res.json({ available: false, models: [], message: 'Model capabilities are unknown. Existing settings remain available.' });
    } finally {
      await server.close().catch(() => {});
    }
  });

  // Read-modify-write of the overrides file; it is synchronous, so concurrent requests cannot interleave.
  function changeRoleOverride(req, res, build) {
    try {
      if (serverActive(req.params.id)) {
        return res.status(409).json({ success: false, error: 'Stop the project server to change role settings; they are read when it starts.' });
      }
      const file = projects.roleOverridesPath(req.params.id);
      const known = [...loadRoles().keys()];
      const name = resolveRoleName(req.params.role, known);
      // A file that is invalid today is ignored by the server, so it is replaced rather than extended.
      const roles = { ...readOverridesFile(file, known).roles };
      const entry = build();
      if (entry && Object.keys(entry).length > 0) roles[name] = entry;
      else delete roles[name];
      writeOverridesFile(file, roles);
      res.json({ success: true, ...projectTeam(file, req.params.id) });
    } catch (e) {
      if (e instanceof RoleOverrideError) return res.status(400).json({ success: false, error: e.message });
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  }

  app.put('/api/projects/:id/roles/:role/override', (req, res) => {
    changeRoleOverride(req, res, () => normalizeOverride(req.body));
  });

  app.delete('/api/projects/:id/roles/:role/override', (req, res) => {
    changeRoleOverride(req, res, () => null);
  });

  // Reads email, plan and both limit windows with a short-lived App Server for one Codex home.
  async function readLimits(home) {
    const server = createAppServer({ cwd: process.cwd(), codexHome: home });
    try {
      const [data, accountData] = await Promise.all([
        server.readRateLimits(),
        server.getAccount().catch(() => null),
      ]);
      const r = data?.rateLimits;
      if (!r) throw new Error('Rate limits unavailable');
      return {
        email: accountData?.account?.email || null,
        planType: accountData?.account?.planType || r.planType || null,
        primary: r.primary || null,    // 5h
        secondary: r.secondary || null, // weekly
      };
    } finally {
      await server.close().catch(() => {});
    }
  }

  async function cachedLimits(key, home, force) {
    const hit = limitsCache.get(key);
    const now = Date.now();
    if (!force && hit && now - hit.at < limitsTtlMs) return hit.value;
    let epoch = limitsCacheEpochs.get(key) || 0;
    if (force) {
      epoch += 1;
      limitsCacheEpochs.set(key, epoch);
      limitsForcePending.set(key, (limitsForcePending.get(key) || 0) + 1);
    }
    try {
      const value = await readLimits(home);
      if ((limitsCacheEpochs.get(key) || 0) === epoch && (force || !limitsForcePending.get(key))) {
        limitsCacheEpochs.set(key, epoch + 1);
        limitsCache.set(key, { at: Date.now(), value });
      }
      return value;
    } finally {
      if (force) {
        const pending = (limitsForcePending.get(key) || 1) - 1;
        if (pending > 0) limitsForcePending.set(key, pending);
        else limitsForcePending.delete(key);
      }
    }
  }

  function storeLimits(key, value) {
    const epoch = limitsCacheEpochs.get(key) || 0;
    limitsCacheEpochs.set(key, epoch + 1);
    limitsCache.set(key, { at: Date.now(), value });
  }

  function activeKeyAndHome() {
    const state = accountProfiles.read();
    const profile = state.active ? state.profiles.find((p) => p.name === state.active) : null;
    return profile ? { key: profile.name, home: profile.home } : { key: SYSTEM_KEY, home: null };
  }

  // API: Fetch 5h and weekly limits of the active account (system or active profile)
  app.get('/api/limits', async (req, res) => {
    const force = req.query.force === '1';
    const { key, home } = activeKeyAndHome();
    try {
      const v = await cachedLimits(key, home, force);
      res.json({ success: true, email: v.email, planType: v.planType || 'plus', primary: v.primary, secondary: v.secondary });
    } catch (err) {
      const stale = limitsCache.get(key);
      if (stale) {
        const v = stale.value;
        return res.json({ success: true, email: v.email, planType: v.planType || 'plus', primary: v.primary, secondary: v.secondary });
      }
      res.json({ success: false, primary: null, secondary: null });
    }
  });

  // API: Codex accounts (system account plus named profiles)
  async function accountView(key, home, fallback, force) {
    const view = { email: fallback.email || null, planType: fallback.planType || null, primary: null, secondary: null, error: null };
    try {
      const v = await cachedLimits(key, home, force);
      view.email = v.email || view.email;
      view.planType = v.planType || view.planType;
      view.primary = v.primary;
      view.secondary = v.secondary;
    } catch (err) {
      view.error = err.message || String(err);
    }
    return view;
  }

  app.get('/api/accounts', async (req, res) => {
    try {
      const force = req.query.force === '1';
      const state = accountProfiles.read();
      const [system, ...profiles] = await Promise.all([
        accountView(SYSTEM_KEY, null, {}, force),
        ...state.profiles.map((p) => accountView(p.name, p.home, p, force)),
      ]);
      res.json({
        autoSwitch: state.autoSwitch,
        system: { active: !state.active, ...system },
        profiles: state.profiles.map((p, i) => ({ name: p.name, active: p.name === state.active, ...profiles[i] })),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  app.post('/api/accounts/:name/handshake', async (req, res) => {
    const name = req.params.name;
    let key = name;
    let home = null;
    let fallback = {};

    if (name === 'system') {
      key = SYSTEM_KEY;
    } else {
      const profile = accountProfiles.read().profiles.find((entry) => entry.name === name);
      if (!profile) return res.status(404).json({ success: false, error: 'Unknown account: ' + name });
      home = profile.home;
      fallback = profile;
    }

    let pending = handshakes.get(key);
    if (!pending) {
      pending = (async () => {
        const server = createAppServer({
          cwd: process.cwd(),
          codexHome: home,
          requestTimeoutMs: 15_000,
          turnTimeoutMs: 90_000,
        });
        try {
          await server.startAccountUsageWindow();
          let data = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            data = await server.readRateLimits();
            const resetsAt = data?.rateLimits?.primary?.resetsAt;
            if (data?.rateLimits && Number.isFinite(resetsAt) && resetsAt > Date.now() / 1000) break;
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
          }
          const accountData = await server.getAccount().catch(() => null);
          const r = data?.rateLimits;
          if (!r) throw new Error('Handshake completed but provider limits are not yet available');
          const value = {
            email: accountData?.account?.email || fallback.email || null,
            planType: accountData?.account?.planType || r.planType || fallback.planType || null,
            primary: r.primary || null,
            secondary: r.secondary || null,
          };
          storeLimits(key, value);
          return value;
        } finally {
          await server.close().catch(() => {});
        }
      })();
      handshakes.set(key, pending);
      pending.finally(() => {
        if (handshakes.get(key) === pending) handshakes.delete(key);
      }).catch(() => {});
    }

    try {
      const result = await pending;
      res.json({ success: true, turnStatus: 'completed', limitsRead: true, ...result });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message || String(err) });
    }
  });

  function removeUnfinishedHome(name) {
    try { fs.rmSync(path.join(accountProfiles.accountsDir, name), { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }

  // Ends a pending login: stops the timer and observer, closes the server. Returns false if already ended.
  async function endLogin(entry, status, error, { cancel = false } = {}) {
    if (entry.status !== 'pending' || entry.ending) return false;
    entry.ending = true;
    clearTimeout(entry.timer);
    entry.unsubscribe?.();
    if (status === 'completed') {
      try {
        const info = await entry.server.getAccount().catch(() => null);
        accountProfiles.addProfile({ name: entry.name, email: info?.account?.email || null, planType: info?.account?.planType || null });
      } catch (err) {
        status = 'failed';
        error = err.message || String(err);
        removeUnfinishedHome(entry.name);
      }
    } else {
      if (cancel && entry.loginId) await entry.server.loginCancel(entry.loginId).catch(() => {});
      removeUnfinishedHome(entry.name);
    }
    await entry.server.close().catch(() => {});
    entry.status = status;
    if (error) entry.error = error;
    return true;
  }

  function handleLoginCompleted(entry, params) {
    if (params.success) endLogin(entry, 'completed');
    else endLogin(entry, 'failed', params.error || 'Login failed');
  }

  app.post('/api/accounts', async (req, res) => {
    const name = req.body && req.body.name;
    const method = req.body && req.body.method;
    if (!accountProfiles.validateName(name) || RESERVED_NAMES.has(name)) {
      return res.status(400).json({ success: false, error: 'Name must match [a-z0-9-]{1,32} and not be reserved' });
    }
    if (method !== 'browser' && method !== 'device') {
      return res.status(400).json({ success: false, error: 'method must be browser or device' });
    }
    if (accountProfiles.read().profiles.some((p) => p.name === name)
      || [...logins.values()].some((l) => l.name === name && l.status === 'pending')) {
      return res.status(409).json({ success: false, error: 'Account already exists: ' + name });
    }
    const entry = { name, status: 'pending', loginId: null, early: null, server: null, timer: null, unsubscribe: null };
    let home;
    try {
      home = accountProfiles.ensureProfileHome(name);
      entry.server = createAppServer({ cwd: process.cwd(), codexHome: home });
      entry.unsubscribe = entry.server.onNotification('account/login/completed', (params) => {
        if (!entry.loginId) entry.early = params;
        else if (params.loginId === entry.loginId) handleLoginCompleted(entry, params);
      });
      const result = await entry.server.loginStart(method === 'device' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' });
      entry.loginId = result.loginId;
      logins.set(entry.loginId, entry);
      entry.timer = setTimeout(() => { endLogin(entry, 'expired', 'Login timed out', { cancel: true }); }, loginTimeoutMs);
      entry.timer.unref?.();
      if (entry.early && entry.early.loginId === entry.loginId) handleLoginCompleted(entry, entry.early);
      const body = { success: true, loginId: entry.loginId };
      if (method === 'device') {
        body.verificationUrl = result.verificationUrl;
        body.userCode = result.userCode;
      } else body.authUrl = result.authUrl;
      res.json(body);
    } catch (err) {
      entry.unsubscribe?.();
      removeUnfinishedHome(name);
      try { await entry.server?.close(); } catch (_) { /* best effort */ }
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  app.get('/api/accounts/login/:loginId', (req, res) => {
    const entry = logins.get(req.params.loginId);
    if (!entry) return res.status(404).json({ success: false, error: 'Unknown login' });
    const body = { status: entry.status };
    if (entry.error) body.error = entry.error;
    if (entry.status === 'completed') body.name = entry.name;
    res.json(body);
  });

  app.post('/api/accounts/login/:loginId/cancel', async (req, res) => {
    const entry = logins.get(req.params.loginId);
    if (!entry) return res.status(404).json({ success: false, error: 'Unknown login' });
    await endLogin(entry, 'failed', 'Cancelled', { cancel: true });
    const body = { status: entry.status };
    if (entry.error) body.error = entry.error;
    res.json(body);
  });

  app.post('/api/accounts/auto-switch', (req, res) => {
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    res.json({ success: true, autoSwitch: accountProfiles.setAutoSwitch(enabled).autoSwitch });
  });

  app.post('/api/accounts/system/activate', (req, res) => {
    accountProfiles.setActive(null);
    res.json({ success: true, active: null });
  });

  app.post('/api/accounts/:name/activate', (req, res) => {
    const name = req.params.name;
    if (!accountProfiles.read().profiles.some((p) => p.name === name)) {
      return res.status(404).json({ success: false, error: 'Unknown account: ' + name });
    }
    accountProfiles.setActive(name);
    res.json({ success: true, active: name });
  });

  app.delete('/api/accounts/:name', async (req, res) => {
    const name = req.params.name;
    const state = accountProfiles.read();
    const profile = state.profiles.find((p) => p.name === name);
    if (!profile) return res.status(404).json({ success: false, error: 'Unknown account: ' + name });
    if (state.active === name) return res.status(409).json({ success: false, error: 'Cannot remove the active account' });
    try {
      const server = createAppServer({ cwd: process.cwd(), codexHome: profile.home });
      try {
        await server.logout();
      } catch (_) { /* best effort: the profile is removed anyway */ } finally {
        await server.close().catch(() => {});
      }
      accountProfiles.removeProfile(name);
      limitsCache.delete(name);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // API: Harness connectors (state and browser sign-in). Codex stores the credentials in the account home.
  const connectorPreferences = createConnectorPreferences({ accountsDir: accountProfiles.accountsDir });
  const connectors = createConnectorService({
    createAppServer,
    getCodexHome: () => activeKeyAndHome().home,
    logoutImpl: connectorLogoutImpl,
    preferences: connectorPreferences,
  });

  app.get('/api/connectors', async (req, res) => {
    try {
      res.json({ connectors: await connectors.list() });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  app.post('/api/connectors/:name/sign-in', async (req, res) => {
    try {
      res.json(await connectors.signIn(req.params.name));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || String(err) });
    }
  });

  app.put('/api/connectors/:name/enabled', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'enabled') || typeof body.enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Request body must be exactly { enabled: boolean }' });
    }
    try {
      res.json(await connectors.setEnabled(req.params.name, body.enabled));
    } catch (err) {
      res.status(err.status || 500).json({ success: false, error: err.message || String(err) });
    }
  });

  app.post('/api/connectors/:name/switch-account', async (req, res) => {
    try {
      res.json(await connectors.switchAccount(req.params.name));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || String(err) });
    }
  });

  // Closes every pending login server; called by the launcher on shutdown.
  app.closeAccountLogins = async () => {
    await Promise.all([...logins.values()].filter((l) => l.status === 'pending').map((l) => endLogin(l, 'failed', 'Launcher stopped')));
    await connectors.close();
  };

  return app;
}

module.exports = { createLauncherApp };
