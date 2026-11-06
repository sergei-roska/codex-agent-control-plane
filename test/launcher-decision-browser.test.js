'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const CHROME = '/usr/bin/google-chrome';
const PAUSE = {
  kind: 'owner_decision',
  decisionId: 'decision-browser-1',
  reason: 'infeasible_requirement',
  question: 'Which supported recovery path should the team take?',
  recommendation: 'recover',
  options: [
    { id: 'recover', description: 'Use the supported recovery path.' },
    { id: 'defer', description: 'Defer until the missing capability is available.' },
  ],
  evidenceChecked: ['Checked the provider capability matrix.', 'Confirmed the workspace cannot change it.'],
  independentWork: 'The team can document the fallback while waiting.',
};

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() { socket.close(); },
  };
}

test('headless Chrome renders and submits the real launcher decision card', { skip: !fs.existsSync(CHROME) }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-decision-chrome-'));
  const submitted = [];
  let currentState = 'TASK_STATE_INPUT_REQUIRED';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/ui/' || url.pathname === '/ui/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(ROOT, 'launcher-ui/index.html')));
      return;
    }
    if (url.pathname === '/ui/app.js' || url.pathname === '/ui/styles.css' || url.pathname === '/ui/performance.css') {
      const name = url.pathname.slice('/ui/'.length);
      const contentType = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      res.writeHead(200, { 'content-type': contentType });
      res.end(fs.readFileSync(path.join(ROOT, 'launcher-ui', name)));
      return;
    }
    if (url.pathname === '/api/projects') {
      json(res, { projects: [{ id: 'project-a', name: 'Synthetic Project', path: '/tmp/synthetic-project', port: 4310, status: 'running' }] });
      return;
    }
    if (url.pathname === '/api/projects/project-a/status') {
      json(res, { status: 'running', readiness: 'ready', taskReady: true });
      return;
    }
    if (url.pathname === '/api/projects/project-a/sessions') {
      json(res, { sessions: [{ contextId: 'session-a' }] });
      return;
    }
    if (url.pathname === '/api/projects/project-a/sessions/session-a') {
      const leadTask = currentState === 'TASK_STATE_INPUT_REQUIRED'
        ? { id: 'task-a', goal: 'Resolve the blocked requirement.', state: currentState, metadata: { pause: PAUSE } }
        : { id: 'task-a', goal: 'Resolve the blocked requirement.', state: currentState, metadata: {}, artifacts: [] };
      json(res, { turns: [{ leadTask, workers: [] }] });
      return;
    }
    if (url.pathname === '/api/projects/project-a/team') {
      json(res, { lead: { name: 'coordinator', sandbox: 'read-only', model: 'synthetic', effort: 'medium' }, roles: [] });
      return;
    }
    if (url.pathname === '/api/connectors') {
      json(res, { connectors: [] });
      return;
    }
    if (url.pathname === '/api/accounts') {
      json(res, { accounts: [], activeAccountId: null, autoSwitch: false });
      return;
    }
    if (url.pathname === '/api/accounts/usage') {
      json(res, { accounts: [] });
      return;
    }
    if (url.pathname === '/api/projects/project-a/task/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      submitted.push({ pathname: url.pathname, body: parsed });
      currentState = 'TASK_STATE_COMPLETED';
      json(res, { success: true, result: { status: { state: currentState } } });
      return;
    }
    json(res, {}, 404);
  });

  let chrome;
  let cdp;
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (cdp) cdp.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([once(chrome, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
    await closeServer(server);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  try {
    const appPort = await listen(server);
    const debugPort = await freePort();
    chrome = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-allow-origins=*',
      '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile,
      'http://127.0.0.1:' + appPort + '/ui/?project=project-a',
    ], { stdio: 'ignore' });
    t.after(cleanup);

    const page = await waitFor(async () => {
      try {
        const pages = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
        return pages.find((item) => item.type === 'page' && item.url.startsWith('http://127.0.0.1:' + appPort));
      } catch (_) { return null; }
    }, 'Chrome page');
    cdp = await connectCdp(page.webSocketDebuggerUrl);

    const card = await waitFor(async () => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const card = document.getElementById('decisionCard');
          return card && !card.classList.contains('hidden') && document.querySelectorAll('#decisionOptionsList input[type="radio"]').length === 2;
        })()`,
        returnByValue: true,
      });
      return result.result.value;
    }, 'the visible decision card');
    assert.equal(card, true);

    const rendered = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const text = (id) => document.getElementById(id).textContent.trim();
        const radios = [...document.querySelectorAll('#decisionOptionsList input[type="radio"]')];
        return {
          reason: text('decisionReason'),
          question: text('decisionQuestion'),
          recommendation: document.querySelector('.decision-recommended')?.textContent.trim(),
          optionDescriptions: [...document.querySelectorAll('.decision-option-text')].map((node) => node.textContent.trim()),
          evidence: [...document.querySelectorAll('#decisionEvidenceList li')].map((node) => node.textContent.trim()),
          independentWork: text('decisionIndependent'),
          evidenceCount: text('decisionEvidenceCount'),
          radioCount: radios.length
        };
      })()`,
      returnByValue: true,
    });
    assert.deepEqual(rendered.result.value, {
      reason: 'Infeasible requirement',
      question: PAUSE.question,
      recommendation: 'Recommended',
      optionDescriptions: PAUSE.options.map((option) => option.description),
      evidence: PAUSE.evidenceChecked,
      independentWork: PAUSE.independentWork,
      evidenceCount: '2',
      radioCount: 2,
    });

    const optionOnly = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const answer = document.getElementById('decisionAnswer');
        const submit = document.getElementById('decisionSubmit');
        answer.value = 'Free text is not an option selection.';
        answer.dispatchEvent(new Event('input', { bubbles: true }));
        const disabledWithoutOption = submit.disabled;
        answer.value = '';
        const radio = document.querySelector('#decisionOptionsList input[value="recover"]');
        radio.click();
        const enabledWithOption = !submit.disabled;
        submit.click();
        return { disabledWithoutOption, enabledWithOption, selected: radio.checked };
      })()`,
      returnByValue: true,
    });
    assert.deepEqual(optionOnly.result.value, { disabledWithoutOption: true, enabledWithOption: true, selected: true });

    await waitFor(() => submitted.length === 1, 'scoped task submission');
    assert.deepEqual(submitted, [{
      pathname: '/api/projects/project-a/task/send',
      body: { goal: 'recover', taskId: 'task-a', decision: 'decision-browser-1', choice: 'recover' },
    }]);
  } finally {
    await cleanup();
  }
});
