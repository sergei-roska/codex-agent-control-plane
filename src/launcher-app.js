'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { ClientFactory } = require('@a2a-js/sdk/client');
const { parseCheckCommand } = require('./acceptance');
const { CodexAppServer } = require('./codex-app-server');
const { createAccountProfiles } = require('./account-profiles');
const { loadRoles, createLeadRole, LEAD_ROLE_NAME } = require('./role-catalog');
const { canonicalRoleId } = require('./role-names');
const {
  RoleOverrideError,
  normalizeOverride,
  resolveRoleName,
  readOverridesFile,
  writeOverridesFile,
  effectiveRole,
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
  systemAgent = null,
  createClient = (baseUrl) => new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json'),
  createRoleClient = (roleUrl) => new ClientFactory().createFromUrl(`${roleUrl}/agent-card.json`, ''),
  openTasksDb = (file, options) => new Database(file, options),
  createAppServer = (options) => new CodexAppServer(options),
  accountProfiles = createAccountProfiles(),
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  limitsTtlMs = LIMITS_TTL_MS,
  askOptions = {},
}) {
  const app = express();
  const limitsCache = new Map();
  const logins = new Map();

  app.use(express.json());
  if (systemAgent?.router) app.use(systemAgent.router);

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

  app.get('/api/system-agent', (_req, res) => res.json(systemAgent?.descriptor?.() || null));

  app.put('/api/system-agent/settings', (req, res) => {
    if (!systemAgent?.saveSettings) return res.status(404).json({ success: false, error: 'System agent settings are unavailable' });
    try {
      const settings = systemAgent.saveSettings(req.body);
      res.json({ success: true, ...settings, systemAgent: systemAgent.descriptor() });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Invalid system agent settings' });
    }
  });

  app.delete('/api/system-agent/settings', (_req, res) => {
    if (!systemAgent?.resetSettings) return res.status(404).json({ success: false, error: 'System agent settings are unavailable' });
    try {
      const settings = systemAgent.resetSettings();
      res.json({ success: true, ...settings, systemAgent: systemAgent.descriptor() });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Could not reset system agent settings' });
    }
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
      const { logs, ...project } = projects.status(req.params.id);
      res.json({ project, status: project.status, logs });
    } catch (err) {
      sendProjectError(res, err);
    }
  });

  // API: Send A2A task directly via verified SDK
  app.post('/api/projects/:id/task/send', async (req, res) => {
    try {
      const id = req.params.id;
      if (projects.get(id).status !== 'running') {
        return res.status(400).json({ success: false, error: 'Orchestrator server is not running!' });
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
    sandbox: r.sandbox,
    tools: { mcpServers: r.tools.mcpServers, skills: r.tools.skills },
  });

  app.get('/api/team', (req, res) => {
    try {
      const lead = createLeadRole();
      const roles = Array.from(loadRoles().values());
      const projectRoles = [lead, ...roles];
      res.json({
        lead: pickRole(lead),
        roles: roles.map(pickRole),
        systemAgent: systemAgent?.descriptor?.() || null,
        models: [...new Set(projectRoles.map((role) => role.model))].sort(),
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
        defaults: { model: base.model, effort: base.effort },
        override: override ? { model: override.model ?? null, effort: override.effort ?? null, extraRules: override.extraRules ?? null } : null,
      };
    };
    const all = [baseLead, ...baseRoles.values()];
    return {
      lead: describe(baseLead),
      roles: [...baseRoles.values()].map(describe),
      systemAgent: systemAgent?.descriptor?.() || null,
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
    const value = await readLimits(home);
    limitsCache.set(key, { at: now, value });
    return value;
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

  // Closes every pending login server; called by the launcher on shutdown.
  app.closeSystemAgent = async () => systemAgent?.close?.();

  app.closeAccountLogins = async () => {
    await Promise.all([...logins.values()].filter((l) => l.status === 'pending').map((l) => endLogin(l, 'failed', 'Launcher stopped')));
  };

  return app;
}

module.exports = { createLauncherApp };
