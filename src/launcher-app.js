'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { ClientFactory } = require('@a2a-js/sdk/client');
const { parseCheckCommand } = require('./acceptance');
const { CodexAppServer } = require('./codex-app-server');
const { loadRoles, createLeadRole } = require('./role-catalog');
const { ProjectError } = require('./launcher-projects');
const {
  SessionError,
  TERMINAL_STATES,
  formatLeadTask,
  listSessions,
  getSession,
  deleteLeadTask,
  deleteSession,
} = require('./launcher-sessions');

const UI_DIR = path.join(__dirname, '..', 'launcher-ui');
const PROJECT_ID = /^[0-9a-f]{10}$/;
const ERROR_STATUS = {
  not_found: 404,
  not_a_directory: 400,
  running: 409,
  not_managed: 409,
  no_port: 503,
};
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

function createLauncherApp({
  projects,
  readAuthToken,
  createClient = (baseUrl) => new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json'),
  openTasksDb = (file, options) => new Database(file, options),
}) {
  const app = express();
  let cachedLimits = null;
  let lastLimitsFetch = 0;

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
  app.get('/api/team', (req, res) => {
    try {
      const pick = (r) => ({
        name: r.name,
        description: r.description,
        model: r.model,
        effort: r.effort,
        sandbox: r.sandbox,
        tools: { mcpServers: r.tools.mcpServers, skills: r.tools.skills },
      });
      res.json({
        lead: pick(createLeadRole()),
        roles: Array.from(loadRoles().values()).map(pick),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // API: Fetch 5h and weekly account limits via Codex App Server
  app.get('/api/limits', async (req, res) => {
    const force = req.query.force === '1';
    const now = Date.now();
    if (!force && cachedLimits && (now - lastLimitsFetch < 30_000)) {
      return res.json(cachedLimits);
    }

    try {
      const server = new CodexAppServer({ cwd: process.cwd() });
      try {
        const [data, accountData] = await Promise.all([
          server.readRateLimits(),
          server.getAccount().catch(() => null)
        ]);
        const r = data?.rateLimits;
        if (r) {
          cachedLimits = {
            success: true,
            email: accountData?.account?.email || null,
            planType: accountData?.account?.planType || r.planType || 'plus',
            primary: r.primary || null,    // 5h
            secondary: r.secondary || null // weekly
          };
          lastLimitsFetch = now;
          return res.json(cachedLimits);
        }
      } finally {
        await server.close();
      }
    } catch (err) {
      if (cachedLimits) return res.json(cachedLimits);
      return res.status(500).json({ success: false, error: err.message });
    }

    res.json({ success: false, primary: null, secondary: null });
  });

  return app;
}

module.exports = { createLauncherApp };
