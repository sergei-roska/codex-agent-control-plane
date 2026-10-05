'use strict';

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { readAuthToken } = require('./src/local-auth');
const { parseCheckCommand } = require('./src/acceptance');
const { CodexAppServer } = require('./src/codex-app-server');
const { loadRoles, createLeadRole } = require('./src/role-catalog');

const app = express();
const PORT = Number(process.env.LAUNCHER_PORT) || 8080;

let orchestratorProcess = null;
let serverLogs = [];
let serverStatus = 'stopped'; // 'stopped' | 'starting' | 'running'
let cachedLimits = null;
let lastLimitsFetch = 0;

// Automatically detect active orchestrator on port 3000
async function checkOrchestratorAlive() {
  try {
    const res = await fetch('http://127.0.0.1:3000/orchestrator/agent-card.json', { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      serverStatus = 'running';
      return;
    }
  } catch (_) {}
  if (serverStatus !== 'starting' && !orchestratorProcess) {
    serverStatus = 'stopped';
  }
}
checkOrchestratorAlive();
setInterval(checkOrchestratorAlive, 2000);

app.use(express.json());

// Main UI: modern orchestrator console interface
app.use('/ui', express.static(path.join(__dirname, 'launcher-ui'), { index: false }));

app.get('/', (req, res) => {
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  fs.readFile(path.join(__dirname, 'launcher-ui', 'index.html'), 'utf8', (err, page) => {
    if (err) return res.status(500).send('UI unavailable: ' + err.message);
    res.type('html').send(page.split('__DEFAULT_WORKSPACE__').join(escapeHtml(process.cwd())));
  });
});

// API: Server status
app.get('/api/server/status', (req, res) => {
  res.json({
    status: serverStatus,
    logs: serverLogs.slice(-200)
  });
});

function freePort3000() {
  try {
    const { execSync } = require('child_process');
    const pids = execSync('lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (pids) {
      for (const raw of pids.split('\n')) {
        const pid = parseInt(raw.trim(), 10);
        if (pid && pid !== process.pid) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

// API: Start orchestrator server
app.post('/api/server/start', async (req, res) => {
  // If orchestrator is already running and responds, record status
  try {
    const ping = await fetch('http://127.0.0.1:3000/orchestrator/agent-card.json', { signal: AbortSignal.timeout(800) });
    if (ping.ok) {
      serverStatus = 'running';
      return res.json({ success: true, message: 'Orchestrator is already running' });
    }
  } catch (_) {}

  // Clean up dangling processes on port 3000 before startup
  freePort3000();
  await new Promise(r => setTimeout(r, 200));

  const workspace = req.body.workspace || process.cwd();
  if (!fs.existsSync(workspace)) {
    return res.status(400).json({ success: false, message: 'Specified folder does not exist: ' + workspace });
  }

  serverStatus = 'starting';
  serverLogs = [`[LAUNCHER] Starting orchestrator for workspace: ${workspace}\n`];

  orchestratorProcess = spawn('node', ['src/server.js'], {
    cwd: __dirname,
    env: { ...process.env, CODEX_WORKSPACE: workspace }
  });

  orchestratorProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    serverLogs.push(text);
    if (text.includes('listening at') || text.includes('Codex Universal A2A')) {
      serverStatus = 'running';
    }
  });

  orchestratorProcess.stderr.on('data', (chunk) => {
    serverLogs.push(chunk.toString());
  });

  orchestratorProcess.on('close', (code) => {
    serverLogs.push(`\n[LAUNCHER] Server process exited (code: ${code})\n`);
    orchestratorProcess = null;
    serverStatus = 'stopped';
  });

  // Fast polling for port 3000 readiness
  let attempts = 0;
  const pollTimer = setInterval(async () => {
    attempts++;
    try {
      const ping = await fetch('http://127.0.0.1:3000/orchestrator/agent-card.json', { signal: AbortSignal.timeout(500) });
      if (ping.ok) {
        serverStatus = 'running';
        clearInterval(pollTimer);
      }
    } catch (_) {}
    if (attempts > 20) clearInterval(pollTimer);
  }, 400);

  res.json({ success: true });
});

// API: Stop server
app.post('/api/server/stop', (req, res) => {
  serverLogs.push('\n[LAUNCHER] Stopping server process...\n');
  if (orchestratorProcess) {
    try { orchestratorProcess.kill('SIGTERM'); } catch (_) {}
    const proc = orchestratorProcess;
    setTimeout(() => {
      if (orchestratorProcess === proc) {
        try { orchestratorProcess.kill('SIGKILL'); } catch (_) {}
      }
    }, 2000);
    orchestratorProcess = null;
  }

  // Force release port 3000 if process hangs
  freePort3000();

  serverStatus = 'stopped';
  serverLogs.push('[LAUNCHER] Orchestrator server stopped.\n');
  res.json({ success: true });
});

// API: Send A2A task directly via verified SDK
app.post('/api/task/send', async (req, res) => {
  try {
    if (serverStatus !== 'running') {
      return res.status(400).json({ success: false, error: 'Orchestrator server is not running!' });
    }

    const { goal, checks, taskId, continueFrom, decision, choice } = req.body;
    if (taskId && continueFrom) {
      return res.status(400).json({ success: false, error: 'taskId and continueFrom are mutually exclusive' });
    }
    const baseUrl = 'http://127.0.0.1:3000';
    const authToken = readAuthToken(process.env.CODEX_A2A_TOKEN_FILE ? { filePath: process.env.CODEX_A2A_TOKEN_FILE } : undefined);
    const client = await new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json');
    const requestOptions = { serviceParameters: { Authorization: `Bearer ${authToken}` } };

    let contextId = '';
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

function formatLeadTask(db, lead) {
  let goal = '';
  let lastInstruction = '';
  let continuesFrom = '';
  if (lead.history) {
    try {
      const history = JSON.parse(lead.history);
      const userMsgs = history.filter(m => m.role === 'ROLE_USER' || m.role === 1 || m.role === 'user');
      if (userMsgs.length > 0) {
        const firstMsg = userMsgs[0];
        if (Array.isArray(firstMsg.referenceTaskIds) && typeof firstMsg.referenceTaskIds[0] === 'string') {
          continuesFrom = firstMsg.referenceTaskIds[0];
        }
        for (const part of firstMsg.parts || []) {
          const text = part.text || part.content?.value;
          if (typeof text === 'string' && text.trim()) {
            goal = text.trim();
            break;
          }
        }
        if (userMsgs.length > 1) {
          const lastMsg = userMsgs[userMsgs.length - 1];
          for (const part of lastMsg.parts || []) {
            const text = part.text || part.content?.value;
            if (typeof text === 'string' && text.trim()) {
              lastInstruction = text.trim();
              break;
            }
          }
        }
      }
    } catch (_) {}
  }

  const workers = db.prepare("SELECT role, state, task_id, updated_at FROM dispatch_journal WHERE run_id = ? ORDER BY created_at ASC").all(lead.id);

  return {
    leadTask: {
      id: lead.id,
      goal: goal || null,
      lastInstruction: lastInstruction || null,
      continuesFrom: continuesFrom || null,
      state: lead.status_state,
      status: lead.status ? JSON.parse(lead.status) : null,
      artifacts: lead.artifacts ? JSON.parse(lead.artifacts) : [],
      metadata: lead.metadata ? JSON.parse(lead.metadata) : {},
      updatedAt: lead.status_last_updated
    },
    workers
  };
}

// API: Get latest task state
app.get('/api/tasks/latest', (req, res) => {
  try {
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.json({ leadTask: null, workers: [] });
    
    const db = new Database(dbPath, { readonly: true });
    try {
      const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' ORDER BY status_last_updated DESC LIMIT 1").get();
      if (!lead) return res.json({ leadTask: null, workers: [] });

      res.json(formatLeadTask(db, lead));
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: List all tasks in history
app.get('/api/tasks/history', (req, res) => {
  try {
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.json({ tasks: [] });

    const db = new Database(dbPath, { readonly: true });
    try {
      const leads = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' ORDER BY status_last_updated DESC").all();
      const tasks = leads.map(lead => {
        let goal = '';
        let continuesFrom = null;
        if (lead.history) {
          try {
            const h = JSON.parse(lead.history);
            const userMsg = h.find(m => m.role === 'ROLE_USER' || m.role === 1 || m.role === 'user');
            if (userMsg && Array.isArray(userMsg.referenceTaskIds) && typeof userMsg.referenceTaskIds[0] === 'string') {
              continuesFrom = userMsg.referenceTaskIds[0];
            }
            if (userMsg && Array.isArray(userMsg.parts)) {
              for (const part of userMsg.parts) {
                const text = part.text || part.content?.value;
                if (typeof text === 'string' && text.trim()) {
                  goal = text.trim();
                  break;
                }
              }
            }
          } catch (_) {}
        }
        const workerCount = db.prepare("SELECT count(*) as c FROM dispatch_journal WHERE run_id = ?").get(lead.id).c;
        let disposition = null;
        if (lead.artifacts) {
          try {
            const arts = JSON.parse(lead.artifacts);
            disposition = arts?.at(-1)?.metadata?.acceptance?.disposition || null;
          } catch (_) {}
        }
        return {
          id: lead.id,
          goal: goal || '(no description)',
          state: lead.status_state,
          updatedAt: lead.status_last_updated,
          workerCount,
          disposition,
          continuesFrom
        };
      });
      res.json({ tasks });
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Details of a specific task by ID
app.get('/api/tasks/:id', (req, res) => {
  try {
    const taskId = req.params.id;
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

    const db = new Database(dbPath, { readonly: true });
    try {
      const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' AND id = ?").get(taskId);
      if (!lead) return res.status(404).json({ error: 'Task not found' });

      res.json(formatLeadTask(db, lead));
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Safe deletion of a task and its records
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const taskId = req.params.id;
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

    const db = new Database(dbPath);
    try {
      const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' AND id = ?").get(taskId);
      if (!lead) return res.status(404).json({ error: 'Task not found' });

      const deletableStates = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'];
      if (!deletableStates.includes(lead.status_state)) {
        return res.status(400).json({ error: 'Cannot delete an active task!' });
      }

      const deleteTx = db.transaction(() => {
        const workers = db.prepare("SELECT task_id FROM dispatch_journal WHERE run_id = ?").all(taskId).map(r => r.task_id);
        if (workers.length > 0) {
          const placeholders = workers.map(() => '?').join(',');
          db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...workers);
          try { db.prepare(`DELETE FROM writer_executions WHERE task_id IN (${placeholders})`).run(...workers); } catch (_) {}
        }
        db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
        db.prepare("DELETE FROM dispatch_journal WHERE run_id = ?").run(taskId);
        try { db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(taskId); } catch (_) {}
        try { db.prepare("DELETE FROM writes WHERE thread_id = ?").run(taskId); } catch (_) {}
        try { db.prepare("DELETE FROM usage_ledger WHERE run_id = ?").run(taskId); } catch (_) {}
        try { db.prepare("DELETE FROM writer_executions WHERE task_id = ?").run(taskId); } catch (_) {}
      });

      deleteTx();
      res.json({ success: true, deletedId: taskId });
    } finally {
      db.close();
    }
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Launcher listening at: http://127.0.0.1:${PORT}`);
});
