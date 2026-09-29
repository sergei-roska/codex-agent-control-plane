'use strict';

const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const express = require('express');
const {
  WORKER_REPORT_SCHEMA, WORKER_REPORT_CONTRACT, classifyCodexError, findCodexErrorInfo,
} = require('./contracts');

function roleSlug(roleId) {
  if (!/^orch-[a-z0-9-]+$/.test(roleId)) {
    throw new TypeError(`Invalid role id "${roleId}"; expected an orch-* slug`);
  }
  return roleId;
}

function extractText(message) {
  if (!Array.isArray(message?.parts) || message.parts.length === 0) {
    throw new Error('Unsupported input: provide at least one text part.');
  }

  const texts = [];
  for (const part of message.parts) {
    if (part?.content?.$case === 'text' && typeof part.content.value === 'string') {
      texts.push(part.content.value);
    } else if (typeof part?.text === 'string') {
      // Accept the JSON Schema form used by some A2A clients as well as the SDK
      // protobuf JSON representation.
      texts.push(part.text);
    } else {
      throw new Error('Unsupported input part: this agent accepts text parts only.');
    }
  }
  return texts.join('\n');
}

function failureMetadata(error) {
  return {
    failureKind: error ? classifyCodexError(error) : 'other',
    codexErrorInfo: error ? findCodexErrorInfo(error) : null,
  };
}

function makeStatus(state, message) {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  };
}

function makeRoleCard({ roleId, role, endpoint }) {
  const skillId = roleId;
  return {
    name: role.name,
    description: role.description,
    supportedInterfaces: [{
      url: endpoint,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: '',
    }],
    provider: { url: endpoint, organization: 'Codex Universal' },
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {
      bearerAuth: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'Bearer token required for A2A JSON-RPC requests.',
            scheme: 'Bearer',
            bearerFormat: 'opaque',
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: skillId,
      name: role.name,
      description: role.description,
      tags: [roleId],
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: [],
    }],
    signatures: [],
  };
}

function makeExecutor({ roleId, role, appServer, workspace }) {
  const reservations = new Map();
  const releaseReservation = (taskId, reservation) => {
    if (reservations.get(taskId) === reservation) reservations.delete(taskId);
  };
  const executor = {
    async execute(requestContext, eventBus) {
      const { taskId, contextId } = requestContext;
      let activeTask = reservations.get(taskId);
      if (activeTask?.entered) {
        throw new Error(`Task "${taskId}" already has an active Codex run.`);
      }
      if (!activeTask) {
        activeTask = { taskId, entered: false, terminal: false, cancelRequested: false };
        reservations.set(taskId, activeTask);
      }
      activeTask.entered = true;
      activeTask.contextId = contextId;
      activeTask.eventBus = eventBus;
      const controller = new AbortController();
      activeTask.controller = controller;
      const publishTerminalStatus = (state, message) => {
        if (activeTask.terminal) return;
        activeTask.terminal = true;
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: makeStatus(state, message),
          metadata: {},
        }));
      };
      const task = requestContext.task || {
        id: taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_SUBMITTED),
        artifacts: [],
        history: [],
        metadata: {},
      };

      // The SDK requires a task/message event before any status or artifact event.
      eventBus.publish(AgentEvent.task(task));
      try {
        let input;
        try {
          input = extractText(requestContext.userMessage);
        } catch (error) {
          publishTerminalStatus(TaskState.TASK_STATE_FAILED, {
            messageId: `${taskId}-input-error`,
            contextId,
            taskId,
            role: 2,
            parts: [{ content: { $case: 'text', value: error.message } }],
            metadata: { failureKind: 'other', codexErrorInfo: null },
          });
          return;
        }

        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: makeStatus(TaskState.TASK_STATE_WORKING),
          metadata: {},
        }));

        if (activeTask.cancelRequested) {
          controller.abort();
          publishTerminalStatus(TaskState.TASK_STATE_CANCELED);
          return;
        }
        const result = await appServer.run({
          role: { id: roleId, ...role },
          cwd: workspace,
          input,
          outputSchema: WORKER_REPORT_SCHEMA,
          signal: controller.signal,
        });
        const resultText = typeof result?.text === 'string' ? result.text : '';
        const canceled = controller.signal.aborted;
        const completed = result?.status === 'completed';
        if (!canceled && completed) {
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: {
              artifactId: `${taskId}-result`,
              name: `${role.name} result`,
              description: role.description,
              parts: [{ content: { $case: 'text', value: resultText } }],
              metadata: { contract: WORKER_REPORT_CONTRACT, threadId: result.threadId || null },
              extensions: [],
            },
            append: false,
            lastChunk: true,
            metadata: {},
          }));
        }
        publishTerminalStatus(
          canceled ? TaskState.TASK_STATE_CANCELED : completed ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_FAILED,
          !canceled && !completed ? {
            messageId: `${taskId}-error`,
            contextId,
            taskId,
            role: 2,
            parts: [{ content: { $case: 'text', value: resultText || `Codex App Server returned status "${String(result?.status)}".` } }],
            metadata: failureMetadata(result?.error),
          } : undefined,
        );
      } catch (error) {
        const canceled = controller.signal.aborted;
        publishTerminalStatus(
          canceled ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
          canceled ? undefined : {
            messageId: `${taskId}-error`,
            contextId,
            taskId,
            role: 2,
            parts: [{ content: { $case: 'text', value: error?.message || String(error) } }],
            metadata: failureMetadata(error),
          },
        );
      } finally {
        releaseReservation(taskId, activeTask);
      }
    },

    async cancelTask(taskId) {
      const activeTask = reservations.get(taskId);
      if (!activeTask) return;
      activeTask.cancelRequested = true;
      activeTask.controller?.abort();
    },

    reserveTask(taskId) {
      if (reservations.has(taskId)) return undefined;
      const reservation = { taskId, entered: false, terminal: false, cancelRequested: false };
      reservations.set(taskId, reservation);
      return reservation;
    },

    releaseTask(taskId, reservation) {
      if (!reservation.entered) releaseReservation(taskId, reservation);
    },
  };
  return executor;
}

function rejectOverlappingTask(executor) {
  return (req, res, next) => {
    if (req.method !== 'POST' || req.body?.method !== 'SendMessage') return next();
    const taskId = req.body?.params?.message?.taskId;
    if (!taskId) return next();
    const reservation = executor.reserveTask(taskId);
    if (!reservation) {
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

    // Keep the reservation while the SDK awaits task-store/context work. A
    // socket close does not prove the SDK stopped processing the request, so
    // only a finished pre-executor response may release it here.
    res.once('finish', () => executor.releaseTask(taskId, reservation));
    try {
      next();
    } catch (error) {
      executor.releaseTask(taskId, reservation);
      throw error;
    }
  };
}

/** Mount one independently stored A2A JSON-RPC agent per role. */
function registerRoleAgents(app, {
  roles, appServer, workspace, baseUrl, taskStoreFactory = () => new InMemoryTaskStore(),
}) {
  if (!app || typeof app.use !== 'function' || typeof app.get !== 'function') {
    throw new TypeError('app must be an Express application');
  }
  if (!(roles instanceof Map)) throw new TypeError('roles must be a Map');
  if (!appServer || typeof appServer.run !== 'function') throw new TypeError('appServer.run is required');
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required');
  const origin = new URL(baseUrl);
  if (origin.hostname !== '127.0.0.1') throw new TypeError('baseUrl must use the 127.0.0.1 host');

  const registered = new Map();
  for (const [rawRoleId, role] of roles) {
    const roleId = roleSlug(rawRoleId);
    if (!role?.name || !role?.description) throw new TypeError(`Role ${roleId} needs name and description`);
    const route = `/agents/${roleId}`;
    const endpoint = new URL(route, `${origin.origin}/`).toString();
    const card = makeRoleCard({ roleId, role, endpoint });
    const executor = makeExecutor({ roleId, role, appServer, workspace });
    const handler = new DefaultRequestHandler(
      card,
      taskStoreFactory(roleId),
      executor,
    );
    app.use(`${route}/agent-card.json`, agentCardHandler({
      agentCardProvider: async () => AgentCard.toJSON(card),
    }));
    app.use(route, express.json(), rejectOverlappingTask(executor), jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }));
    registered.set(roleId, { card, handler });
  }
  return registered;
}

module.exports = { registerRoleAgents, extractText };
