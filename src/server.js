'use strict';

const express = require('express');
const fs = require('node:fs');
const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const { CodexAppServer } = require('./codex-app-server');
const { loadRoles, createLeadRole } = require('./role-catalog');
const { registerRoleAgents } = require('./a2a-role-service');
const { LeadOrchestrator } = require('./lead-orchestrator');
const { loadOrCreateAuthToken, createAuthMiddleware } = require('./local-auth');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function textPart(text) {
  return { content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined };
}

function status(state, message) {
  return { state, message, timestamp: new Date().toISOString() };
}

function extractGoal(message) {
  const parts = message?.parts;
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('Provide a non-empty text goal.');
  const values = parts.map((part) => {
    if (part?.content?.$case === 'text') return part.content.value;
    if (typeof part?.text === 'string') return part.text;
    throw new Error('The lead accepts text parts only.');
  });
  const goal = values.join('\n').trim();
  if (!goal) throw new Error('Provide a non-empty text goal.');
  return goal;
}

function makeLeadCard({ leadRole, endpoint }) {
  const roleId = 'orch-lead';
  return {
    name: leadRole.name,
    description: leadRole.description,
    supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    provider: { url: endpoint, organization: 'Codex Universal' },
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {
      localBearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer', bearerFormat: 'opaque', description: 'Local A2A access token.' } } },
    },
    securityRequirements: [{ schemes: { localBearer: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: roleId,
      name: leadRole.name,
      description: leadRole.description,
      tags: [roleId],
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: [],
    }],
    signatures: [],
  };
}

function makeLeadExecutor({ orchestrator }) {
  const controllers = new Map();
  const reservations = new Set();
  return {
    async execute(requestContext, eventBus) {
      const { taskId, contextId } = requestContext;
      if (controllers.has(taskId)) return;
      reservations.delete(taskId);
      const controller = new AbortController();
      controllers.set(taskId, controller);
      const task = requestContext.task || {
        id: taskId,
        contextId,
        status: status(TaskState.TASK_STATE_SUBMITTED),
        artifacts: [],
        history: [],
        metadata: {},
      };
      try {
        eventBus.publish(AgentEvent.task(task));
        let goal;
        try {
          goal = extractGoal(requestContext.userMessage);
        } catch (error) {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, {
              messageId: `${taskId}-input-error`, contextId, taskId, role: 2, parts: [textPart(error.message)],
            }),
            metadata: {},
          }));
          return;
        }

        eventBus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_WORKING), metadata: {} }));
        const result = await orchestrator.run({ goal, signal: controller.signal });
        const cancellationConfirmed = result?.status === 'canceled';
        const cancellationUnconfirmed = controller.signal.aborted && !cancellationConfirmed;
        const canceled = cancellationConfirmed;
        const completed = result?.status === 'completed' && !controller.signal.aborted;
        const failed = !completed && !canceled;
        const output = cancellationUnconfirmed
          ? 'Cancellation was requested, but downstream A2A cancellation could not be confirmed.'
          : typeof result?.text === 'string' ? result.text : '';
        if (completed) {
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: {
              artifactId: `${taskId}-result`,
              name: 'Orchestrator result',
              description: 'Final result from the Codex Universal A2A team.',
              parts: [textPart(output)],
              metadata: { rounds: result?.rounds ?? 0, assignments: result?.assignments ?? [] },
              extensions: [],
            },
            append: false,
            lastChunk: true,
            metadata: {},
          }));
        }
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(
            canceled ? TaskState.TASK_STATE_CANCELED : failed ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED,
            failed ? { messageId: `${taskId}-error`, contextId, taskId, role: 2, parts: [textPart(output || `Orchestrator ended with status: ${result?.status || 'unknown'}.`)] } : undefined,
          ),
          metadata: {},
        }));
      } catch (error) {
        const cancellationUnconfirmed = controller.signal.aborted;
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_FAILED,
            { messageId: `${taskId}-error`, contextId, taskId, role: 2, parts: [textPart(cancellationUnconfirmed ? 'Cancellation was requested, but downstream A2A cancellation could not be confirmed.' : error?.message || String(error))] }),
          metadata: {},
        }));
      } finally {
        controllers.delete(taskId);
      }
    },
    async cancelTask(taskId) {
      controllers.get(taskId)?.abort();
    },
    cancelAll() {
      for (const controller of controllers.values()) controller.abort();
    },
    isTaskActive(taskId) {
      return controllers.has(taskId) || reservations.has(taskId);
    },
    reserveTask(taskId) {
      if (!taskId || controllers.has(taskId) || reservations.has(taskId)) return false;
      reservations.add(taskId);
      return true;
    },
    releaseTaskReservation(taskId) {
      reservations.delete(taskId);
    },
  };
}

function rejectOverlappingLeadTask(executor) {
  return function rejectOverlappingLeadTaskMiddleware(req, res, next) {
    if (req.method !== 'POST' || req.body?.method !== 'SendMessage') return next();
    const taskId = req.body?.params?.message?.taskId;
    if (!taskId) return next();
    if (!executor.reserveTask(taskId)) {
      res.status(200).json({
        jsonrpc: '2.0',
        id: req.body.id ?? null,
        error: {
          code: -32000,
          message: `Task "${taskId}" is already executing; concurrent messages for one task are rejected.`,
        },
      });
      return;
    }
    const releaseIfUnclaimed = () => executor.releaseTaskReservation(taskId);
    res.once?.('finish', releaseIfUnclaimed);
    return next();
  };
}

function registerLead(app, { leadRole, orchestrator, baseUrl, authMiddleware }) {
  const endpoint = new URL('/orchestrator', `${baseUrl}/`).toString();
  const card = makeLeadCard({ leadRole, endpoint });
  const executor = makeLeadExecutor({ orchestrator });
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  app.use('/orchestrator/agent-card.json', agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(card) }));
  app.use('/orchestrator', authMiddleware, express.json(), rejectOverlappingLeadTask(executor), jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  return { card, requestHandler, executor };
}

function protectRoleRpcMounts(app, authMiddleware) {
  const protectedApp = {
    use(route, ...handlers) {
      if (typeof route === 'string' && /^\/agents\/orch-[a-z0-9-]+$/.test(route)) {
        app.use(route, authMiddleware, ...handlers);
      } else {
        app.use(route, ...handlers);
      }
      return protectedApp;
    },
    get: app.get.bind(app),
  };
  return protectedApp;
}

async function startServer({
  port = Number(process.env.PORT || DEFAULT_PORT),
  workspace = process.env.CODEX_WORKSPACE || process.cwd(),
  appServer = new CodexAppServer(),
  listen = true,
  listenImpl = (application, listenPort, host, callback) => application.listen(listenPort, host, callback),
  profilesDir,
  tokenFile,
  orchestratorFactory = (options) => new LeadOrchestrator(options),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535');
  if (typeof workspace !== 'string' || !workspace || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`workspace must be an existing directory: ${workspace}`);
  }
  let httpServer = null;
  try {
    await appServer.start?.();
    const accountResult = await appServer.getAccount();
    const account = accountResult?.account || accountResult;
    if (account?.type !== 'chatgpt') throw new Error('Codex Universal requires an authenticated ChatGPT account via Codex OAuth.');

    const authToken = loadOrCreateAuthToken(tokenFile ? { filePath: tokenFile } : undefined);
    const authMiddleware = createAuthMiddleware(authToken);
    const roles = loadRoles(profilesDir ? { profilesDir } : undefined);
    const app = express();
    if (listen) {
      httpServer = await new Promise((resolve, reject) => {
        const server = listenImpl(app, port, HOST, () => resolve(server));
        server.once('error', reject);
      });
    }
    const actualPort = httpServer?.address()?.port ?? port;
    const baseUrl = `http://${HOST}:${actualPort}`;
    const leadRole = createLeadRole(profilesDir ? { profilesDir } : undefined);
    const orchestrator = orchestratorFactory({ appServer, roles, workspace, baseUrl, authToken });
    const protectedRoleApp = protectRoleRpcMounts(app, authMiddleware);
    const specialistAgents = registerRoleAgents(protectedRoleApp, { roles, appServer, workspace, baseUrl });
    const leadAgent = registerLead(app, { leadRole, orchestrator, baseUrl, authMiddleware });
    return {
      app,
      httpServer,
      appServer,
      roles,
      specialistAgents,
      leadAgent,
      host: HOST,
      port: actualPort,
      async close() {
        leadAgent.executor.cancelAll();
        let appServerShutdown;
        try {
          appServerShutdown = bounded(appServer.close?.(), SHUTDOWN_TIMEOUT_MS);
        } catch (error) {
          appServerShutdown = Promise.reject(error);
        }
        if (httpServer) await closeHttpServer(httpServer);
        await appServerShutdown;
      },
    };
  } catch (error) {
    try { await bounded(appServer.close?.(), SHUTDOWN_TIMEOUT_MS); } catch (_) { /* Preserve the startup failure. */ }
    if (httpServer) await closeHttpServer(httpServer);
    throw error;
  }
}

function bounded(promise, timeoutMs) {
  if (!promise || typeof promise.then !== 'function') return Promise.resolve(promise);
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

function closeHttpServer(server) {
  let timer;
  const closed = new Promise((resolve) => {
    server.close(() => resolve());
  });
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([closed, timeout]).finally(() => clearTimeout(timer));
}

if (require.main === module) {
  startServer().then((server) => {
    process.stdout.write(`Codex Universal A2A listening at http://${server.host}:${server.port}\n`);
    const shutdown = () => server.close().finally(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { startServer, makeLeadExecutor, extractGoal, makeLeadCard, registerLead, rejectOverlappingLeadTask, protectRoleRpcMounts };
