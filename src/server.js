'use strict';

const express = require('express');
const fs = require('node:fs');
const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const { CodexAppServer } = require('./codex-app-server');
const { loadRoles, createLeadRole } = require('./role-catalog');
const { registerRoleAgents } = require('./a2a-role-service');
const { LeadOrchestrator, ResumeInputError } = require('./lead-orchestrator');
const { openStateDatabase, createTaskStore, DispatchJournal, reconcileInterruptedTasks, acquireStateLock, acquireWorkspaceLock } = require('./durable-store');
const { WriterAdmission } = require('./writer-admission');
const { UsageLedger } = require('./usage-ledger');
const { createEvidenceStore } = require('./evidence-store');
const { validateAcceptanceContract, formatAcceptance, invalidAcceptanceContract } = require('./acceptance');
const { loadOrCreateAuthToken, createAuthMiddleware } = require('./local-auth');
const { loadSkillCatalog } = require('./skill-catalog');
const { canonicalRoleId, roleDisplayName } = require('./role-names');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function textPart(text) {
  return { content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined };
}

function status(state, message) {
  return { state, message, timestamp: new Date().toISOString() };
}

function extractGoal(message, { allowEmpty = false } = {}) {
  const parts = message?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    if (allowEmpty) return '';
    throw new Error('Provide a non-empty text goal.');
  }
  const values = parts.map((part) => {
    if (part?.content?.$case === 'text') return part.content.value;
    if (typeof part?.text === 'string') return part.text;
    throw new Error('The lead accepts text parts only.');
  });
  const goal = values.join('\n').trim();
  if (!goal && !allowEmpty) throw new Error('Provide a non-empty text goal.');
  return goal;
}

function agentMessage(taskId, contextId, suffix, text) {
  return { messageId: `${taskId}-${suffix}`, contextId, taskId, role: 2, parts: [textPart(text)] };
}

function answerCommand(taskId, pause) {
  const parts = [`npm run ask -- --task ${taskId}`];
  if (pause?.kind === 'human_decision') {
    if (pause.decisionId) parts.push(`--decision ${pause.decisionId}`);
    parts.push('--choice <optionId>');
  }
  parts.push('"<answer>"');
  return parts.join(' ');
}

/** Human-readable INPUT_REQUIRED text for a pause, including how to answer. */
function describePause(taskId, pause) {
  const lines = [];
  if (pause?.kind === 'human_decision') {
    lines.push(`Decision required: ${pause.question || '(no question given)'}`);
    if (pause.reason) lines.push(`Reason: ${pause.reason}`);
    if (Array.isArray(pause.options) && pause.options.length > 0) {
      lines.push('Options:');
      for (const option of pause.options) lines.push(`  - ${option.id}: ${option.description}`);
    }
    if (pause.recommendation) lines.push(`Recommendation: ${pause.recommendation}`);
    if (pause.decisionId) lines.push(`Decision ID: ${pause.decisionId}`);
  } else if (pause?.kind === 'waiting_for_budget') {
    lines.push(`Waiting for budget (${pause.source || 'unknown source'}): ${pause.message || 'usage limit reached.'}`);
    if (pause.resetsAt) lines.push(`Reported reset hint: ${pause.resetsAt}`);
    lines.push('Send a message to this task to retry once quota is available.');
  } else if (pause?.kind === 'writer_unresolved') {
    lines.push('Earlier writer outcome(s) are unresolved: the server could not prove the writer stopped, so writable work is blocked.');
    for (const attempt of pause.attempts || []) lines.push(`  - ${attempt.attemptId} (${attempt.role}): ${attempt.reason}`);
    lines.push('Send any message to this task to retry reconciliation once the earlier writer is proven stopped.');
  } else if (pause?.kind === 'error') {
    lines.push(`The run stopped on an error${pause.errorName ? ` (${pause.errorName})` : ''}: ${pause.message || 'unknown error'}`);
    lines.push('Send a message to this task to retry the failed step.');
  } else if (pause?.kind === 'restart') {
    lines.push('Run interrupted by server restart. Send a message to this task to resume.');
  } else {
    lines.push('The run is paused and needs input.');
  }
  lines.push(`Answer with: ${answerCommand(taskId, pause)}`);
  return lines.join('\n');
}

function makeLeadCard({ leadRole, endpoint }) {
  const roleId = canonicalRoleId('orch-lead');
  return {
    name: leadRole.displayName || roleDisplayName(roleId),
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
      name: leadRole.displayName || roleDisplayName(roleId),
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

const MAX_ERROR_PAUSE_CHARS = 2000;

/** Text of the first non-empty user message in a task history, or ''. */
function firstUserGoal(task) {
  for (const message of task?.history || []) {
    if (message?.role !== 1) continue;
    try {
      const text = extractGoal(message, { allowEmpty: true });
      if (text) return text;
    } catch (_) { /* skip messages without usable text */ }
  }
  return '';
}

/** Metadata of the first non-empty user message in a task history, or {}. */
function firstUserMetadata(task) {
  for (const message of task?.history || []) {
    if (message?.role !== 1) continue;
    try {
      if (extractGoal(message, { allowEmpty: true })) return message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
    } catch (_) { /* skip messages without usable text */ }
  }
  return {};
}

const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);
const MAX_EARLIER_CONTEXT_CHARS = 24000;
const TRUNCATION_PREFIX = '[earlier context truncated]\n';

function partsText(parts) {
  return (parts || [])
    .map((part) => (part?.content?.$case === 'text' ? part.content.value : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function priorResultText(refTask) {
  const artifacts = refTask?.artifacts || [];
  const fromArtifact = partsText(artifacts[artifacts.length - 1]?.parts);
  return fromArtifact || partsText(refTask?.status?.message?.parts) || '(no result text)';
}

/** Goal for a new run that continues a finished task; priorGoal falls back to the referenced task's first user message. */
function composeFollowUpGoal({ refTask, priorGoal, newRequest }) {
  const artifacts = refTask.artifacts || [];
  const disposition = artifacts[artifacts.length - 1]?.metadata?.acceptance?.disposition || 'n/a';
  let earlier = `Earlier goal:\n${priorGoal || firstUserGoal(refTask)}\nEarlier result:\n${priorResultText(refTask)}`;
  if (earlier.length > MAX_EARLIER_CONTEXT_CHARS) {
    earlier = TRUNCATION_PREFIX + earlier.slice(earlier.length - (MAX_EARLIER_CONTEXT_CHARS - TRUNCATION_PREFIX.length));
  }
  return [
    'This is a follow-up to an earlier orchestrator task in the same conversation.',
    `Earlier task ${refTask.id} ended as ${TaskState[refTask.status?.state] || 'UNKNOWN'} (acceptance: ${disposition}).`,
    earlier,
    'New request (authoritative; the earlier context is background only):',
    newRequest,
  ].join('\n');
}

/** Reference task ids of the first non-empty user message in a task history, or []. */
function firstUserReferenceIds(task) {
  for (const message of task?.history || []) {
    if (message?.role !== 1) continue;
    try {
      if (extractGoal(message, { allowEmpty: true })) return Array.isArray(message.referenceTaskIds) ? message.referenceTaskIds : [];
    } catch (_) { /* skip messages without usable text */ }
  }
  return [];
}

function isResumeInputError(error) {
  return error instanceof ResumeInputError;
}

function makeLeadExecutor({ orchestrator, loadTask }) {
  const controllers = new Map();
  const reservations = new Set();
  const inflight = new Set();

  async function executeLead(requestContext, eventBus) {
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
    const resuming = requestContext.task?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED;
    let effectivePause = null;
    const republishPause = (pause, explanation, suffix) => {
      const text = explanation ? `${explanation}\n${describePause(taskId, pause)}` : describePause(taskId, pause);
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_INPUT_REQUIRED, agentMessage(taskId, contextId, `${suffix}-${Date.now()}`, text)),
        metadata: pause ? { pause } : {},
      }));
    };
    try {
      eventBus.publish(AgentEvent.task(task));
      let goal;
      let livePause = null;
      if (resuming) {
        try { livePause = (await orchestrator.getPause?.(taskId)) || null; } catch (_) { livePause = null; }
        // The checkpoint is authoritative; the stored task metadata is only a fallback.
        effectivePause = livePause || requestContext.task.metadata?.pause || null;
      }
      const pauseKind = effectivePause?.kind;
      try {
        goal = extractGoal(requestContext.userMessage, { allowEmpty: resuming && pauseKind !== 'human_decision' });
      } catch (error) {
        if (resuming) {
          republishPause(effectivePause, `${error.message} The task is still waiting.`, 'input-error');
          return;
        }
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'input-error', error.message)),
          metadata: {},
        }));
        return;
      }

      // The acceptance contract is read from a new run only; a resume can never change it.
      let contract;
      if (!resuming) {
        const raw = requestContext.userMessage?.metadata?.acceptance ?? requestContext.request?.metadata?.acceptance;
        try {
          if (raw && typeof raw === 'object' && 'invalid' in raw) throw new TypeError('acceptance has unknown field "invalid"');
          contract = validateAcceptanceContract(raw);
        } catch (error) {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'acceptance-error', `Invalid acceptance contract: ${error.message}`)),
            metadata: {},
          }));
          return;
        }
      }

      const referenceIds = !resuming ? requestContext.userMessage?.referenceTaskIds || [] : [];
      if (referenceIds.length > 0) {
        const refId = referenceIds[0];
        const refTask = referenceIds.length === 1 ? (requestContext.referenceTasks || []).find((candidate) => candidate?.id === refId) : undefined;
        const problem = referenceIds.length > 1 ? 'Only one reference task is supported.'
          : !refTask ? `Reference task ${refId} was not found.`
          : !TERMINAL_STATES.has(refTask.status?.state) ? `Reference task ${refId} is still active; answer or cancel it instead of continuing it.`
          : null;
        if (problem) {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'reference-error', problem)),
            metadata: {},
          }));
          return;
        }
        let priorGoal = null;
        try { priorGoal = (await orchestrator.getRunGoal?.(refId)) || null; } catch (_) { priorGoal = null; }
        goal = composeFollowUpGoal({ refTask, priorGoal, newRequest: goal });
      }

      let resumeInput;
      if (resuming) {
        const messageMeta = requestContext.userMessage?.metadata || {};
        if (pauseKind === 'human_decision') {
          if (messageMeta.decisionId && livePause?.decisionId && messageMeta.decisionId !== livePause.decisionId) {
            republishPause(effectivePause, `Decision ID "${messageMeta.decisionId}" does not match the pending decision "${livePause.decisionId}". The task is still waiting.`, `decision-mismatch`);
            return;
          }
          resumeInput = { answer: goal, choice: messageMeta.choice, decisionId: messageMeta.decisionId };
        } else {
          resumeInput = { answer: goal };
        }
      }

      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_WORKING,
          resuming && requestContext.userMessage?.metadata?.acceptance !== undefined
            ? agentMessage(taskId, contextId, `resume-note-${Date.now()}`, 'Resumed. Acceptance metadata on a resume message is ignored; the contract was pinned when the run started.')
            : undefined),
        // Task metadata merges shallowly, so a cleared pause is null rather than absent.
        metadata: resuming ? { pause: null } : {},
      }));
      let result;
      if (resuming) {
        try {
          result = await orchestrator.resume({ runId: taskId, input: resumeInput, signal: controller.signal });
        } catch (error) {
          if (error?.name !== 'RunNotFoundError' || pauseKind !== 'restart') throw error;
          // Crash before the first checkpoint: start over from the original goal.
          let original = firstUserGoal(task);
          const originalRefIds = original ? firstUserReferenceIds(task) : [];
          if (originalRefIds.length > 0) {
            const refId = originalRefIds[0];
            const refTask = originalRefIds.length === 1 ? await loadTask?.(refId) : undefined;
            if (!refTask) throw new Error(`Reference task ${refId} could not be loaded to recover the original goal.`);
            let priorGoal = null;
            try { priorGoal = (await orchestrator.getRunGoal?.(refId)) || null; } catch (_) { priorGoal = null; }
            original = composeFollowUpGoal({ refTask, priorGoal, newRequest: original });
          }
          if (!original) throw new Error('The run has no checkpoint and the original goal could not be recovered from the task history.');
          let originalContract;
          try {
            originalContract = validateAcceptanceContract(firstUserMetadata(task).acceptance);
          } catch (contractError) {
            // Never continue as if no checks were required: carry an invalid marker into acceptance.
            originalContract = invalidAcceptanceContract(`Stored acceptance contract is invalid: ${contractError.message}`);
          }
          result = await orchestrator.run({ goal: original, runId: taskId, contract: originalContract, signal: controller.signal });
        }
      } else {
        result = await orchestrator.run({ goal, runId: taskId, contract, signal: controller.signal });
      }
      const paused = (result?.status === 'input_required' || result?.status === 'waiting_for_budget') && !controller.signal.aborted;
      if (paused) {
        const pause = result.pause || await orchestrator.getPause?.(taskId) || { kind: result.status === 'waiting_for_budget' ? 'waiting_for_budget' : 'human_decision' };
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_INPUT_REQUIRED, agentMessage(taskId, contextId, `pause-${Date.now()}`, describePause(taskId, pause))),
          metadata: { pause },
        }));
        return;
      }
      const cancellationConfirmed = result?.status === 'canceled';
      const cancellationUnconfirmed = controller.signal.aborted && !cancellationConfirmed;
      const canceled = cancellationConfirmed;
      const completed = result?.status === 'completed' && !controller.signal.aborted;
      const failed = !completed && !canceled;
      const output = cancellationUnconfirmed
        ? 'Cancellation was requested, but downstream A2A cancellation could not be confirmed.'
        : typeof result?.text === 'string' ? result.text : '';
      if (completed) {
        const acceptanceText = formatAcceptance(result?.acceptance);
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: `${taskId}-result`,
            name: 'Orchestrator result',
            description: 'Final result from the Codex Universal A2A team.',
            parts: [textPart(acceptanceText ? `${acceptanceText}\n\n${output}` : output)],
            metadata: {
              rounds: result?.rounds ?? 0,
              assignments: result?.assignments ?? [],
              ...(result?.acceptance ? { acceptance: result.acceptance } : {}),
            },
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
      const cancellationRequested = controller.signal.aborted;
      if (resuming && !cancellationRequested && isResumeInputError(error)) {
        republishPause(effectivePause, `The answer was rejected: ${error?.message || String(error)}. The task is still waiting.`, 'input-error');
        return;
      }
      let resumable = false;
      if (!cancellationRequested && error?.name !== 'UnconfirmedCancellationError') {
        try { resumable = Boolean(await orchestrator.isResumable?.(taskId)); } catch (_) { resumable = false; }
      }
      if (resumable) {
        const message = String(error?.message || error).slice(0, MAX_ERROR_PAUSE_CHARS);
        const pause = { kind: 'error', message, errorName: error?.name || 'Error' };
        republishPause(pause, '', 'error-pause');
        return;
      }
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_FAILED,
          { messageId: `${taskId}-error`, contextId, taskId, role: 2, parts: [textPart(cancellationRequested ? 'Cancellation was requested, but downstream A2A cancellation could not be confirmed.' : error?.message || String(error))] }),
        metadata: {},
      }));
    } finally {
      controllers.delete(taskId);
    }
  }

  return {
    execute(requestContext, eventBus) {
      const running = executeLead(requestContext, eventBus);
      inflight.add(running);
      const forget = () => inflight.delete(running);
      running.then(forget, forget);
      return running;
    },
    async cancelTask(taskId, eventBus) {
      const controller = controllers.get(taskId);
      if (controller) {
        controller.abort();
        return;
      }
      // Paused task: nothing is running, so the executor itself ends the task.
      eventBus?.publish(AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: status(TaskState.TASK_STATE_CANCELED),
        metadata: { pause: null },
      }));
      eventBus?.finished?.();
    },
    /** Resolves when every in-flight execute() has settled. */
    async settled() {
      await Promise.allSettled([...inflight]);
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

function registerLead(app, { leadRole, orchestrator, baseUrl, authMiddleware, taskStore = new InMemoryTaskStore() }) {
  const endpoint = new URL('/orchestrator', `${baseUrl}/`).toString();
  const card = makeLeadCard({ leadRole, endpoint });
  const executor = makeLeadExecutor({ orchestrator, loadTask: (id) => taskStore.load(id, {}) });
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);
  app.use('/orchestrator/agent-card.json', agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(card) }));
  app.use('/orchestrator', authMiddleware, express.json(), rejectOverlappingLeadTask(executor), jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  return { card, requestHandler, executor };
}

function protectRoleRpcMounts(app, authMiddleware) {
  const protectedApp = {
    use(route, ...handlers) {
      if (typeof route === 'string' && /^\/agents\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)) {
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
  stateFile,
  state: providedState,
  workspaceLockDir,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535');
  if (typeof workspace !== 'string' || !workspace || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`workspace must be an existing directory: ${workspace}`);
  }
  let httpServer = null;
  let state = providedState || null;
  const ownsState = !providedState;
  let releaseLock = () => {};
  let releaseWorkspaceLock = () => {};
  try {
    await appServer.start?.();
    const accountResult = await appServer.getAccount();
    const account = accountResult?.account || accountResult;
    if (account?.type !== 'chatgpt') throw new Error('Codex Universal requires an authenticated ChatGPT account via Codex OAuth.');

    if (!state) state = await openStateDatabase(stateFile ? { filePath: stateFile } : undefined);
    if (ownsState) releaseLock = acquireStateLock(state.filePath);
    releaseWorkspaceLock = acquireWorkspaceLock(workspace, workspaceLockDir ? { lockDir: workspaceLockDir } : undefined);

    const authToken = loadOrCreateAuthToken(tokenFile ? { filePath: tokenFile } : undefined);
    const authMiddleware = createAuthMiddleware(authToken);
    const roles = loadRoles(profilesDir ? { profilesDir } : undefined);
    const skillCatalog = loadSkillCatalog();
    const app = express();
    if (listen) {
      httpServer = await new Promise((resolve, reject) => {
        // Express 5 passes a listen failure (e.g. EADDRINUSE) to the callback.
        const server = listenImpl(app, port, HOST, (error) => (error ? reject(error) : resolve(server)));
        server.once('error', reject);
      });
    }
    // Reconcile only once this process owns both the state file and the port.
    await reconcileInterruptedTasks(state, { leadNamespace: 'orchestrator' });
    const admission = new WriterAdmission({ db: state.db, workspace });
    await admission.reconcileStale();
    const actualPort = httpServer?.address()?.port ?? port;
    const baseUrl = `http://${HOST}:${actualPort}`;
    const leadRole = createLeadRole(profilesDir ? { profilesDir } : undefined);
    const usageLedger = new UsageLedger({ db: state.db });
    const evidenceStore = createEvidenceStore(state.db);
    const orchestrator = orchestratorFactory({
      appServer, roles, workspace, baseUrl, authToken, leadRole, skillCatalog,
      checkpointer: state.checkpointer, journal: new DispatchJournal(state), admission, usageLedger, evidenceStore,
    });
    const protectedRoleApp = protectRoleRpcMounts(app, authMiddleware);
    const specialistAgents = registerRoleAgents(protectedRoleApp, {
      roles, appServer, workspace, baseUrl, admission, usageLedger, skillCatalog,
      taskStoreFactory: (roleId) => createTaskStore(state, roleId),
    });
    const leadAgent = registerLead(app, {
      leadRole, orchestrator, baseUrl, authMiddleware, taskStore: createTaskStore(state, 'orchestrator'),
    });
    return {
      app,
      httpServer,
      appServer,
      state,
      roles,
      specialistAgents,
      leadAgent,
      host: HOST,
      port: actualPort,
      async close() {
        leadAgent.executor.cancelAll();
        // Let canceled runs confirm downstream and persist their terminal state first.
        await bounded(leadAgent.executor.settled(), SHUTDOWN_TIMEOUT_MS);
        // The SDK persists the executor's last events on its own consumer loop, which only awaits
        // microtask-based SQLite calls; one macrotask turn lets it finish before the db closes.
        await new Promise((resolve) => setImmediate(resolve));
        let appServerShutdown;
        try {
          appServerShutdown = bounded(appServer.close?.(), SHUTDOWN_TIMEOUT_MS);
        } catch (error) {
          appServerShutdown = Promise.reject(error);
        }
        if (httpServer) await closeHttpServer(httpServer);
        try {
          await appServerShutdown;
        } finally {
          try {
            if (ownsState) await state.close();
          } finally {
            releaseLock();
            releaseWorkspaceLock();
          }
        }
      },
    };
  } catch (error) {
    try { await bounded(appServer.close?.(), SHUTDOWN_TIMEOUT_MS); } catch (_) { /* Preserve the startup failure. */ }
    if (httpServer) await closeHttpServer(httpServer);
    if (state && ownsState) { try { await state.close(); } catch (_) { /* Preserve the startup failure. */ } }
    releaseLock();
    releaseWorkspaceLock();
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

module.exports = { startServer, describePause, makeLeadExecutor, extractGoal, makeLeadCard, registerLead, rejectOverlappingLeadTask, protectRoleRpcMounts };
