'use strict';

// Minimal real-server harness for runtime-contracts tests: real startServer, real SQLite,
// real A2A HTTP on loopback. Only the Codex app server is faked.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { startServer } = require('../../src/server');
const { LeadOrchestrator } = require('../../src/lead-orchestrator');

// Test files run in parallel processes; keep workspace locks private to this process.
process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-rc-lock-'));

function makeFakeAppServer({ workerImpl } = {}) {
  const fake = {
    workerCalls: [],
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async close() {},
    async readRateLimits() { return null; },
    async run({ role, input, signal }) {
      fake.workerCalls.push({ role: role?.name, input });
      if (workerImpl) return workerImpl({ role: role?.name, input, signal });
      return { threadId: 'worker-thread', status: 'completed', text: 'plain text answer' };
    },
  };
  return fake;
}

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function boot(root, appServer) {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const tokenFile = path.join(root, 'token', 'a2a-token');
  const runtime = await startServer({
    port: 0,
    workspace,
    appServer,
    stateFile: path.join(root, 'state.sqlite'),
    tokenFile,
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
  });
  const origin = `http://${runtime.host}:${runtime.port}`;
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return { runtime, origin, requestOptions: { serviceParameters: { Authorization: `Bearer ${token}` } } };
}

async function withStack(appServer, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-rc-'));
  let stack;
  try {
    stack = await boot(root, appServer);
    await fn(stack, root);
  } finally {
    if (stack) await stack.runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let seq = 0;
async function sendToAgent(stack, agentId, text) {
  const client = await new ClientFactory().createFromUrl(stack.origin, `/agents/${agentId}/agent-card.json`);
  seq += 1;
  return client.sendMessage({
    tenant: '',
    message: {
      messageId: `rc-${process.pid}-${seq}`,
      contextId: '',
      taskId: '',
      role: 1,
      parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
    metadata: undefined,
  }, stack.requestOptions);
}

module.exports = { makeFakeAppServer, canBind, withStack, sendToAgent };
