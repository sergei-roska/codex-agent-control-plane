'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler, ServerCallContext } = require('@a2a-js/sdk/server');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const { CodexAppServer } = require('./codex-app-server');
const { loadRoles, createLeadRole } = require('./role-catalog');
const { registerRoleAgents } = require('./a2a-role-service');
const { LeadOrchestrator, ResumeInputError } = require('./lead-orchestrator');
const { openStateDatabase, stateDbPath, createTaskStore, DispatchJournal, reconcileInterruptedTasks, acquireStateLock, acquireWorkspaceLock } = require('./durable-store');
const { WriterAdmission } = require('./writer-admission');
const { EventJournal, withDispatchEvents, NOOP_EVENTS } = require('./event-journal');
const { UsageLedger } = require('./usage-ledger');
const { validateAcceptanceContract, formatAcceptance } = require('./acceptance');
const { loadOrCreateAuthToken, tokenPath, createAuthMiddleware } = require('./local-auth');
const { createDashboardAuth } = require('./dashboard-auth');
const { createProjection } = require('./dashboard-projection');
const { migrateProductSchema } = require('./product-migrations');
const { ProductStore } = require('./product-store');
const { ArtifactStore, defaultArtifactRoot } = require('./artifact-store');
const { createPmLeadRole } = require('./intake');
const { validatePlan, validatePresetPlan } = require('./plan-validator');
const { loadRolePack, loadLegacyPack } = require('./role-pack');
const { createModelCatalog } = require('./model-catalog');
const { createAccountHealth } = require('./account-health');
const { createSettingsStore } = require('./settings-store');
const { loadProjectConfig, defaultProjectConfigPath } = require('./project-config');
const { createGitAdapter } = require('./git-adapter');
const { buildLeanRouting } = require('./route-runtime');
const { evaluatePlanRoute } = require('./route-gate');
const { countChangedLines } = require('./delta-lines');
const { createGitDelivery } = require('./git-delivery');
const {
  createDeliveryController, computeRolePackHash, LEAD_PROMPT_VERSION,
} = require('./delivery-controller');
const { collectStaleStagedArtifacts, createDashboardApi, computeProjectId, sendError, newRequestId } = require('./dashboard-api');
const { loadAtlassianConfig } = require('./integrations/atlassian-config');
const { createAtlassianIntegration } = require('./integrations/atlassian-integration');
const { atlassianCallbackRoute } = require('./dashboard-atlassian-api');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const DASHBOARD_WEB_DIR = path.resolve(__dirname, '..', 'web', 'dashboard');
const PACKAGE_VERSION = require('../package.json').version;

function assertWebDirOutsideArtifacts(webDir) {
  const artifacts = path.resolve(__dirname, '..', 'artifacts');
  const relative = path.relative(artifacts, webDir);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Dashboard web root must not be inside artifacts/: ${webDir}`);
  }
}

function realpathWithMissingTail(target) {
  const absolute = path.isAbsolute(target) ? target : path.resolve(target);
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  const missingTail = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (missingTail.length > 0) {
      if (segment === '..' && missingTail[missingTail.length - 1] !== '..') missingTail.pop();
      else if (segment !== '..' || missingTail.length === 0) missingTail.push(segment);
      continue;
    }
    const candidate = `${current.endsWith(path.sep) ? current : `${current}${path.sep}`}${segment}`;
    try {
      current = fs.realpathSync(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Operator path resolves through an unresolved symbolic link');
      } catch (statError) {
        if (statError.code !== 'ENOENT' && statError.code !== 'ENOTDIR') throw statError;
      }
      missingTail.push(segment);
    }
  }
  return path.resolve(current, ...missingTail);
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertWorkspaceOutsideApplicationRoot(workspace) {
  const applicationRoot = path.resolve(__dirname, '..');
  const workspacePath = path.resolve(workspace);
  const applicationRealPath = fs.realpathSync(applicationRoot);
  const workspaceRealPath = fs.realpathSync(workspacePath);
  const overlaps = (left, right) => isPathWithin(left, right) || isPathWithin(right, left);
  if (overlaps(applicationRoot, workspacePath) || overlaps(applicationRealPath, workspaceRealPath)) {
    throw new Error(`Refusing startup: writable task workspace must not overlap the application root (${applicationRoot})`);
  }
  return true;
}

function assertOperatorPathsOutsideWorkspace(workspace, operatorPaths) {
  const workspacePath = path.resolve(workspace);
  const workspaceRealPath = fs.realpathSync(workspacePath);
  const runtimeRoot = path.join(workspacePath, '.runtime');
  try {
    const runtimeStat = fs.lstatSync(runtimeRoot);
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
      throw new Error('Workspace .runtime path must be a real directory for protected operator state');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const runtimeRealPath = realpathWithMissingTail(runtimeRoot);
  for (const [label, configuredPath] of operatorPaths) {
    if (typeof configuredPath !== 'string' || !configuredPath || configuredPath === ':memory:') continue;
    const absolutePath = path.resolve(configuredPath);
    const canonicalPath = realpathWithMissingTail(absolutePath);
    const insideWorkspace = isPathWithin(workspacePath, absolutePath) || isPathWithin(workspaceRealPath, canonicalPath);
    if (!insideWorkspace) continue;
    const protectedRuntimePath = isPathWithin(runtimeRoot, absolutePath) && isPathWithin(runtimeRealPath, canonicalPath);
    if (!protectedRuntimePath) {
      throw new Error(`Refusing startup: operator-owned ${label} path must be outside the writable workspace or inside protected .runtime`);
    }
  }
  return true;
}

function mountDashboard(app, {
  auth, authMiddleware, state, roles, leadRole, workspace, events, projectId, productStore, artifactStore, deliveryController,
  activePack, legacyPack, modelCatalog, accountHealth, settingsStore, atlassianIntegration, gitDeliveryFactory, projectConfig, projectConfigPath, docsPackDir,
}) {
  assertWebDirOutsideArtifacts(DASHBOARD_WEB_DIR);
  const projection = createProjection({ db: state.db, roleIds: [...roles.keys()], projectId, productStore });
  const api = createDashboardApi({
    projection, events, roles, leadRole, workspace, projectId, startedAt: new Date().toISOString(), version: PACKAGE_VERSION,
    auth, productStore, artifactStore, deliveryController, activePack, legacyPack, modelCatalog, accountHealth, settingsStore, atlassianIntegration, gitDeliveryFactory,
    projectConfig, projectConfigPath, docsPackDir,
  });
  app.use('/api/dashboard/v1', auth.hostGuard, auth.noStore);
  if (atlassianIntegration) app.use('/api/dashboard/v1', atlassianCallbackRoute({ integration: atlassianIntegration, auth }));
  // Bearer only and deliberately no originGuard: the CLI sends no Origin header.
  app.post('/api/dashboard/v1/pairing-codes', auth.hostGuard, authMiddleware, auth.pairingCodeHandler);
  // The session router parses 1 KiB JSON bodies; confine it to /session so ticket commands are not affected.
  const sessionRouter = auth.sessionRouter();
  app.use('/api/dashboard/v1', (req, res, next) => (req.path === '/session' ? sessionRouter(req, res, next) : next()));
  app.use('/api/dashboard/v1', auth.requireSession, api);
  app.use('/api/dashboard', (req, res) => sendError(res, 404, 'not_found', 'Not found', newRequestId()));
  app.use('/dashboard', auth.hostGuard, auth.securityHeaders,
    express.static(DASHBOARD_WEB_DIR, { index: 'index.html', dotfiles: 'deny' }));
  app.get('/', (req, res) => res.redirect('/dashboard/'));
}

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
  } else if (pause?.kind === 'waiting_for_auth') {
    lines.push('Codex sign-in expired. Run `codex login` (ChatGPT), then press Resume; the server refreshes its Codex session itself.');
  } else if (pause?.kind === 'writer_unresolved') {
    lines.push('Earlier writer outcome(s) are unresolved: the server could not prove the writer stopped, so writable work is blocked.');
    for (const attempt of pause.attempts || []) lines.push(`  - ${attempt.attemptId} (${attempt.role}): ${attempt.reason}`);
    lines.push('Send any message to this task to retry reconciliation once the earlier writer is proven stopped.');
  } else if (pause?.kind === 'error') {
    lines.push(`The run stopped on an error${pause.errorName ? ` (${pause.errorName})` : ''}: ${pause.message || 'unknown error'}`);
    lines.push('Send a message to this task to retry the failed step.');
  } else if (pause?.kind === 'operator_pause') {
    lines.push('Paused by the operator. No new work is dispatched until the run is resumed.');
  } else if (pause?.kind === 'restart') {
    lines.push('Run interrupted by server restart. Send a message to this task to resume.');
  } else {
    lines.push('The run is paused and needs input.');
  }
  lines.push(`Answer with: ${answerCommand(taskId, pause)}`);
  return lines.join('\n');
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

function isResumeInputError(error) {
  return error instanceof ResumeInputError;
}

/** { runId, plan } from message metadata.delivery, or null when absent. Throws on a malformed value. */
function readDelivery(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || typeof raw.runId !== 'string' || !raw.runId.trim()
    || !raw.plan || typeof raw.plan !== 'object' || Array.isArray(raw.plan)) {
    throw new Error('delivery metadata must be { runId, plan }');
  }
  return {
    runId: raw.runId,
    plan: raw.plan,
    ...(typeof raw.planRevisionId === 'string' && raw.planRevisionId ? { planRevisionId: raw.planRevisionId } : {}),
    ...(typeof raw.planHash === 'string' && raw.planHash ? { planHash: raw.planHash } : {}),
    ...(typeof raw.rolePack === 'string' && raw.rolePack ? { rolePack: raw.rolePack } : {}),
    ...(raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings) ? { settings: raw.settings } : {}),
  };
}

/**
 * Re-validates a delivery-pack plan against its preset. The saved plan carries runtime role ids beside
 * publicRoleId; the preset validator takes public ids and returns both again.
 */
function validateDeliveryPlan(plan, pack, projectCheckIds) {
  const preset = pack.presets.get(plan.presetId);
  if (!preset) return { ok: false, errors: [{ path: 'plan.presetId', message: `unknown preset "${String(plan.presetId)}"` }], plan: null };
  const stages = Array.isArray(plan.stages)
    ? plan.stages.map((stage) => (stage && typeof stage === 'object'
      ? { ...stage, roleId: typeof stage.publicRoleId === 'string' ? stage.publicRoleId : pack.runtimeToPublic(stage.roleId) || stage.roleId }
      : stage))
    : plan.stages;
  return validatePresetPlan({ ...plan, stages }, { pack, preset, projectCheckIds });
}

// A lean routing claimed in delivery metadata. The claim only says "lean requested": the routing itself is
// built from the preset lean block, the re-validated plan and the project policy, and eligibility is
// recomputed from the plan and the policy, so a missing policy or a full verdict runs the full route.
function leanRoutingOf(raw, plan, { pack = null, projectConfig = null } = {}) {
  if (!raw || typeof raw !== 'object' || raw.effective !== 'lean' || !projectConfig || !pack) return {};
  const preset = plan && plan.presetId ? pack.presets.get(plan.presetId) : null;
  if (!preset) return {};
  const routing = buildLeanRouting({
    preset,
    plan,
    projectConfig,
    isWritableRole: (roleId) => {
      const role = pack.runtimeRoles.get(roleId);
      return role ? role.sandbox !== 'read-only' : true;
    },
  });
  if (!routing) return {};
  const verdict = evaluatePlanRoute({ classification: preset.classification, plan: { ...plan, route: 'lean' }, policy: projectConfig });
  return verdict.effective === 'lean' ? { routing } : {};
}

function makeLeadExecutor({
  orchestrator: defaultOrchestrator, deliveryOrchestrators = new Map(), events = NOOP_EVENTS, projectConfig = null,
}) {
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
    // Delivery runs are pinned to the PM lead instance: new runs by message metadata, resumes by task metadata.
    let delivery = null;
    let deliveryError = null;
    if (resuming) {
      const stored = requestContext.task.metadata?.delivery?.runId ? requestContext.task.metadata.delivery : firstUserMetadata(task).delivery;
      delivery = stored && typeof stored === 'object' && stored.runId ? stored : null;
    } else {
      try {
        delivery = readDelivery(requestContext.userMessage?.metadata?.delivery ?? requestContext.request?.metadata?.delivery);
      } catch (error) {
        deliveryError = error;
      }
    }
    // The role pack is pinned per run (message metadata for new runs, task metadata for resumes); missing means legacy-orch.
    const rolePackId = delivery ? (delivery.rolePack || 'legacy-orch') : null;
    const route = delivery ? deliveryOrchestrators.get(rolePackId) || null : null;
    const orchestrator = route ? route.orchestrator : defaultOrchestrator;
    const deliveryPack = route ? route.pack : null;
    const emit = (type, payload) => events.record(type, { runId: taskId, namespace: 'orchestrator', taskId, role: 'orch-lead', payload });
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

      if (deliveryError || (delivery && !route)) {
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'delivery-error', deliveryError ? `Invalid delivery metadata: ${deliveryError.message}` : `role_pack_unavailable: the role pack "${rolePackId}" is not available on this server.`)),
          metadata: {},
        }));
        return;
      }

      // The server never trusts the caller's plan: re-validate it against the project policy before any run starts.
      if (!resuming && delivery) {
        const projectCheckIds = ((projectConfig && projectConfig.checks) || []).map((check) => check.id);
        const checked = deliveryPack
          ? validateDeliveryPlan(delivery.plan, deliveryPack, projectCheckIds)
          : validatePlan(delivery.plan, { classification: delivery.plan.classification, projectCheckIds });
        if (!checked.ok) {
          const listed = checked.errors.map((entry) => `- ${entry.path}: ${entry.message}`).join('\n');
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'plan-error', `Invalid delivery plan:\n${listed}`)),
            metadata: {},
          }));
          return;
        }
        // Run the normalized plan, never the raw metadata plan.
        delivery = {
          ...delivery,
          plan: deliveryPack
            ? {
              ...checked.plan,
              planRevisionId: delivery.plan.planRevisionId ?? null,
              classification: delivery.plan.classification ?? null,
              ...leanRoutingOf(delivery.plan.routing, checked.plan, { pack: deliveryPack, projectConfig }),
            }
            : checked.plan,
        };
      }

      // The acceptance contract is read from a new run only; a resume can never change it.
      let contract;
      if (!resuming) {
        const raw = requestContext.userMessage?.metadata?.acceptance ?? requestContext.request?.metadata?.acceptance;
        try {
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
        metadata: resuming ? { pause: null } : delivery ? { delivery: { runId: delivery.runId, rolePack: rolePackId, ...(delivery.planRevisionId ? { planRevisionId: delivery.planRevisionId } : {}), ...(delivery.planHash ? { planHash: delivery.planHash } : {}) } } : {},
      }));
      let result;
      if (resuming) emit('run_resumed', { pauseKind });
      else emit('run_submitted', {});
      if (resuming) {
        try {
          result = await orchestrator.resume({ runId: taskId, input: resumeInput, signal: controller.signal });
        } catch (error) {
          if (error?.name !== 'RunNotFoundError' || pauseKind !== 'restart') throw error;
          // Crash before the first checkpoint: start over from the original goal.
          const original = firstUserGoal(task);
          if (!original) throw new Error('The run has no checkpoint and the original goal could not be recovered from the task history.');
          let originalContract;
          try { originalContract = validateAcceptanceContract(firstUserMetadata(task).acceptance); } catch (_) { originalContract = undefined; }
          const originalDelivery = delivery?.plan ? delivery : (() => { try { return readDelivery(firstUserMetadata(task).delivery); } catch (_) { return null; } })();
          result = await orchestrator.run({
            goal: original, runId: taskId, contract: originalContract, ...(originalDelivery?.plan ? { plan: originalDelivery.plan } : {}), ...(originalDelivery?.settings ? { settings: originalDelivery.settings } : {}), signal: controller.signal,
          });
        }
      } else {
        result = await orchestrator.run({
          goal, runId: taskId, contract, ...(delivery?.plan ? { plan: delivery.plan } : {}), ...(delivery?.settings ? { settings: delivery.settings } : {}), signal: controller.signal,
        });
      }
      const paused = (result?.status === 'input_required' || result?.status === 'waiting_for_budget') && !controller.signal.aborted;
      if (paused) {
        const pause = result.pause || await orchestrator.getPause?.(taskId) || { kind: result.status === 'waiting_for_budget' ? 'waiting_for_budget' : 'human_decision' };
        emit('run_paused', { pauseKind: pause?.kind });
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
      if (completed) emit('run_completed', { disposition: result?.acceptance?.disposition, rounds: result?.rounds });
      else if (canceled) emit('run_canceled', {});
      else emit('run_failed', { outcome: cancellationUnconfirmed ? 'cancellation_unconfirmed' : result?.status });
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
              ...(Array.isArray(result?.stages) ? { stages: result.stages } : {}),
              ...(result?.route ? { route: result.route } : {}),
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
      emit('run_error', { errorName: error?.name || 'Error', message: String(error?.message || error) });
      let resumable = false;
      if (!cancellationRequested && error?.name !== 'UnconfirmedCancellationError') {
        try { resumable = Boolean(await orchestrator.isResumable?.(taskId)); } catch (_) { resumable = false; }
      }
      if (resumable) {
        const message = String(error?.message || error).slice(0, MAX_ERROR_PAUSE_CHARS);
        const pause = { kind: 'error', message, errorName: error?.name || 'Error' };
        emit('run_paused', { pauseKind: 'error' });
        republishPause(pause, '', 'error-pause');
        return;
      }
      emit(cancellationRequested ? 'run_canceled' : 'run_failed', cancellationRequested ? {} : { outcome: 'error' });
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

/**
 * In-process A2A JSON-RPC client to this server's own /orchestrator endpoint (bearer token, same request
 * shape as src/cli.js). A new run sends goal + acceptance + delivery; a resume sends taskId + answer metadata.
 */
function createLeadClient({ origin, authToken }) {
  let clientPromise = null;
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json').catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  };
  const requestOptions = { serviceParameters: { Authorization: `Bearer ${authToken}` } };
  let sequence = 0;
  return {
    async send({ goal, acceptance, delivery, taskId, contextId, decisionId, choice, answer } = {}) {
      const client = await getClient();
      let resolvedContext = contextId || '';
      if (taskId && !resolvedContext) {
        const existing = await client.getTask({ tenant: '', id: taskId }, requestOptions);
        resolvedContext = existing?.contextId || '';
      }
      const metadata = {};
      if (acceptance !== undefined) metadata.acceptance = acceptance;
      if (delivery !== undefined) metadata.delivery = delivery;
      if (decisionId !== undefined) metadata.decisionId = decisionId;
      if (choice !== undefined) metadata.choice = choice;
      sequence += 1;
      const text = answer !== undefined ? answer : goal;
      const result = await client.sendMessage({
        tenant: '',
        message: {
          messageId: `delivery-${process.pid}-${Date.now()}-${sequence}`,
          contextId: resolvedContext,
          taskId: taskId || '',
          role: 1,
          parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
        metadata: undefined,
      }, requestOptions);
      const id = result?.id || result?.taskId;
      if (!id) throw new Error('The lead endpoint returned no task');
      return { taskId: id, contextId: result.contextId || resolvedContext };
    },
    async cancel(taskId) {
      const client = await getClient();
      return client.cancelTask({ tenant: '', id: taskId }, requestOptions);
    },
  };
}

/** Reads orchestrator tasks straight from the durable task store. */
function createLeadTaskReader({ state, taskStore }) {
  const context = new ServerCallContext({ tenant: '' });
  return {
    async get(taskId) {
      return (await taskStore.load(taskId, context)) || null;
    },
    // A lead task created for a delivery run, found by the runId pinned in its task metadata.
    async findByRun(runId) {
      const row = state.db.prepare(
        "SELECT id, context_id FROM tasks WHERE owner = 'orchestrator' AND json_extract(metadata, '$.delivery.runId') = ? LIMIT 1",
      ).get(String(runId));
      return row ? { taskId: row.id, contextId: row.context_id } : null;
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

function registerLead(app, {
  leadRole, orchestrator, deliveryOrchestrators, baseUrl, authMiddleware, taskStore = new InMemoryTaskStore(), events, projectConfig,
}) {
  const endpoint = new URL('/orchestrator', `${baseUrl}/`).toString();
  const card = makeLeadCard({ leadRole, endpoint });
  const executor = makeLeadExecutor({ orchestrator, deliveryOrchestrators, events, projectConfig });
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);
  app.use('/orchestrator/agent-card.json', agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(card) }));
  app.use('/orchestrator', authMiddleware, express.json(), rejectOverlappingLeadTask(executor), jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  return { card, requestHandler, executor };
}

function protectRoleRpcMounts(app, authMiddleware) {
  const protectedApp = {
    use(route, ...handlers) {
      if (typeof route === 'string' && /^\/agents\/(orch|dlv)-[a-z0-9-]+$/.test(route)) {
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
  projectConfigFile,
  deliveryTickMs,
  catalogNow,
  operatorControl,
  atlassianConfigPath = process.env.CODEX_ATLASSIAN_CONFIG,
  atlassianConfig: suppliedAtlassianConfig,
  atlassianIntegration: suppliedAtlassianIntegration,
  atlassianOAuth,
  atlassianProvider,
  atlassianFetchImpl,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535');
  if (typeof workspace !== 'string' || !workspace || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`workspace must be an existing directory: ${workspace}`);
  }
  assertWorkspaceOutsideApplicationRoot(workspace);
  let httpServer = null;
  let state = providedState || null;
  const ownsState = !providedState;
  let releaseLock = () => {};
  let releaseWorkspaceLock = () => {};
  let deliveryController = null;
  try {
    const effectiveStateFile = providedState
      ? providedState.filePath
      : stateFile ? stateFile : stateDbPath();
    const effectiveProjectConfigPath = projectConfigFile || (effectiveStateFile && effectiveStateFile !== ':memory:'
      ? defaultProjectConfigPath(effectiveStateFile)
      : null);
    const operatorPaths = [
      ['local token', tokenPath(tokenFile || undefined)],
      ['state database', effectiveStateFile],
      ['artifact root', process.env.CODEX_A2A_ARTIFACT_DIR || (effectiveStateFile && effectiveStateFile !== ':memory:'
        ? path.join(path.dirname(path.resolve(effectiveStateFile)), 'artifacts')
        : null)],
      ['workspace lock directory', workspaceLockDir || process.env.CODEX_A2A_WORKSPACE_LOCK_DIR || null],
      ['project configuration', effectiveProjectConfigPath],
      ['role profile directory', profilesDir || null],
      ['Atlassian configuration', atlassianConfigPath || null],
    ];
    assertOperatorPathsOutsideWorkspace(workspace, operatorPaths);

    await appServer.start?.();
    const accountResult = await appServer.getAccount();
    const account = accountResult?.account || accountResult;
    if (account?.type !== 'chatgpt') throw new Error('Codex Universal requires an authenticated ChatGPT account via Codex OAuth.');

    if (!state) state = await openStateDatabase(stateFile ? { filePath: stateFile } : undefined);
    if (ownsState) releaseLock = acquireStateLock(state.filePath);
    releaseWorkspaceLock = acquireWorkspaceLock(workspace, workspaceLockDir ? { lockDir: workspaceLockDir } : undefined);

    // Product schema first: a failed migration or backup aborts startup before anything serves.
    const migration = await migrateProductSchema({ db: state.db, filePath: state.filePath });
    if (migration.backupPath) process.stderr.write(`Product schema migrated v${migration.fromVersion} -> v${migration.toVersion}; backup written to ${migration.backupPath}\n`);
    // Operator-owned project policy (base ref, branch prefixes, approved checks), read once at startup.
    const projectConfigPath = projectConfigFile || (state.filePath === ':memory:' ? null : defaultProjectConfigPath(state.filePath));
    const projectConfig = loadProjectConfig({ filePath: projectConfigPath || undefined });
    process.stderr.write(`Project policy: ${projectConfig.source === 'file' ? projectConfigPath : 'defaults (no project config file)'} (revision ${projectConfig.revision.slice(0, 12)}, ${projectConfig.checks.length} approved check(s))\n`);
    const projectId = computeProjectId(workspace);
    const artifactStore = new ArtifactStore({ root: defaultArtifactRoot(state.filePath) });
    artifactStore.ensureRoot();
    const productStore = new ProductStore({ db: state.db, projectId });
    const staged = collectStaleStagedArtifacts(productStore, artifactStore);
    if (staged.deleted || staged.failed) process.stderr.write(`Staged artifact cleanup: deleted ${staged.deleted}, failed ${staged.failed}\n`);
    const swept = artifactStore.sweep({ olderThanMs: 24 * 60 * 60 * 1000, isKnown: (id) => Boolean(productStore.getArtifact(id)) });
    if (swept.tmp || swept.orphans) process.stderr.write(`Artifact sweep: removed ${swept.tmp} temp files, ${swept.orphans} orphan files\n`);

    const authToken = loadOrCreateAuthToken(tokenFile ? { filePath: tokenFile } : undefined);
    const authMiddleware = createAuthMiddleware(authToken);
    const roles = loadRoles(profilesDir ? { profilesDir } : undefined);
    // Role packs: the legacy orch-* pack as today plus the nine-role delivery pack (a profiles/delivery dir next to a custom profilesDir wins).
    const customPackDir = profilesDir ? path.join(profilesDir, 'delivery') : null;
    const deliveryPack = loadRolePack(customPackDir && fs.existsSync(path.join(customPackDir, 'pack.json')) ? { packDir: customPackDir } : undefined);
    const docsPackDir = customPackDir && fs.existsSync(path.join(customPackDir, 'pack.json'))
      ? customPackDir
      : path.join(__dirname, '..', 'profiles', 'delivery');
    const legacyPack = loadLegacyPack(profilesDir ? { profilesDir } : undefined);
    const useDelivery = projectConfig.rolePack !== 'legacy-orch';
    const activePack = useDelivery ? deliveryPack : legacyPack;
    // Legacy and delivery runtime roles are all A2A endpoints and projection namespaces; coordinators are never endpoints.
    const allRoles = new Map([...roles, ...deliveryPack.runtimeRoles]);
    const app = express();
    if (listen) {
      httpServer = await new Promise((resolve, reject) => {
        // Express 5 passes a listen failure (e.g. EADDRINUSE) to the callback.
        const server = listenImpl(app, port, HOST, (error) => (error ? reject(error) : resolve(server)));
        server.once('error', reject);
      });
    }
    // Reconcile only once this process owns both the state file and the port.
    const events = new EventJournal({ db: state.db });
    events.ensureSchema();
    productStore.events = events;
    const reconciledTasks = await reconcileInterruptedTasks(state, { leadNamespace: 'orchestrator' });
    const admission = new WriterAdmission({ db: state.db, workspace });
    const reconciledWriters = await admission.reconcileStale();
    const actualPort = httpServer?.address()?.port ?? port;
    let atlassianIntegration = suppliedAtlassianIntegration || null;
    if (!atlassianIntegration) {
      const atlassianConfig = suppliedAtlassianConfig === undefined
        ? loadAtlassianConfig({ workspace: path.resolve(workspace), configPath: atlassianConfigPath, port: actualPort })
        : suppliedAtlassianConfig;
      atlassianIntegration = createAtlassianIntegration({ db: state.db, productStore, artifactStore, workspace: path.resolve(workspace),
        config: atlassianConfig, oauth: atlassianOAuth, provider: atlassianProvider, fetchImpl: atlassianFetchImpl, events });
    }
    events.record('server_started', { payload: {
      port: actualPort,
      pid: process.pid,
      reconciledSpecialists: reconciledTasks?.specialists?.length ?? 0,
      reconciledLead: reconciledTasks?.lead?.length ?? 0,
    } });
    for (const id of reconciledTasks?.lead || []) events.record('task_reconciled_interrupted', { runId: id, namespace: 'orchestrator', taskId: id, payload: { restarted: true } });
    for (const ref of reconciledTasks?.specialistRefs || []) events.record('task_reconciled_interrupted', { namespace: ref.namespace, taskId: ref.taskId, payload: { restarted: false } });
    if (reconciledWriters && (reconciledWriters.reconciled?.length || reconciledWriters.unresolved?.length)) {
      events.record('writer_reconciled', { payload: {
        reconciled: reconciledWriters.reconciled.length,
        unresolved: reconciledWriters.unresolved.length,
        count: reconciledWriters.reconciled.length + reconciledWriters.unresolved.length,
      } });
    }
    const baseUrl = `http://${HOST}:${actualPort}`;
    const leadRole = createLeadRole(profilesDir ? { profilesDir } : undefined);
    const usageLedger = new UsageLedger({ db: state.db });
    const deltaLines = (paths) => countChangedLines({ workspace, paths });
    const orchestrator = orchestratorFactory({
      appServer, roles, workspace, baseUrl, authToken, checkpointer: state.checkpointer, journal: withDispatchEvents(new DispatchJournal(state), events), admission, usageLedger,
    });
    // Product runs (both packs) read operator control requests from the store; non-product lead tasks map to null.
    const controlOf = typeof operatorControl === 'function' ? operatorControl : (leadTaskId) => productStore.controlForLeadTask(leadTaskId);
    // Both delivery orchestrators exist so a run keeps the role pack pinned at submit whatever the project config says now.
    const deliveryOrchestrators = new Map([
      [deliveryPack.packId, {
        pack: deliveryPack,
        orchestrator: orchestratorFactory({
          appServer, roles: deliveryPack.runtimeRoles, workspace, baseUrl, authToken, checkpointer: state.checkpointer, journal: withDispatchEvents(new DispatchJournal(state), events), admission, usageLedger, deltaLines,
          leadRole: { ...deliveryPack.coordinator.role, promptVersion: LEAD_PROMPT_VERSION }, repairChains: deliveryPack.repairChains,
          operatorControl: controlOf,
        }),
      }],
      ['legacy-orch', {
        pack: null,
        orchestrator: orchestratorFactory({
          appServer, roles, workspace, baseUrl, authToken, checkpointer: state.checkpointer, journal: withDispatchEvents(new DispatchJournal(state), events), admission, usageLedger, leadRole: { ...createPmLeadRole(leadRole), promptVersion: LEAD_PROMPT_VERSION },
          operatorControl: controlOf,
        }),
      }],
    ]);
    // Model catalog, account health and saved role defaults (M5). The catalog is warmed once; failures leave it unavailable (fail closed).
    const modelCatalog = createModelCatalog({
      appServer: typeof appServer.listModels === 'function' ? appServer : { async listModels() { throw new Error('model/list is not supported by this App Server client'); } },
      now: catalogNow,
    });
    await modelCatalog.refresh();
    const protectedRoleApp = protectRoleRpcMounts(app, authMiddleware);
    const specialistAgents = registerRoleAgents(protectedRoleApp, {
      roles, appServer, workspace, baseUrl, admission, usageLedger, catalog: modelCatalog, taskStoreFactory: (roleId) => createTaskStore(state, roleId),
    });
    const deliveryAgents = registerRoleAgents(protectedRoleApp, {
      roles: deliveryPack.runtimeRoles, appServer, workspace, baseUrl, admission, usageLedger, catalog: modelCatalog, taskStoreFactory: (roleId) => createTaskStore(state, roleId),
    });
    for (const [id, agent] of deliveryAgents) specialistAgents.set(id, agent);
    const accountHealth = createAccountHealth({ appServer });
    // An auth failure or the recycle that follows it changes the account state the dashboard shows.
    if (appServer && 'onAuthStale' in appServer) appServer.onAuthStale = () => accountHealth.invalidate();
    const packsById = new Map([[deliveryPack.packId, deliveryPack], [legacyPack.packId, legacyPack]]);
    const settingsStore = createSettingsStore({
      db: state.db,
      catalog: modelCatalog,
      events,
      roleExists: (packId, roleRuntimeId) => {
        const found = packsById.get(packId);
        return Boolean(found) && (found.coordinator.runtimeId === roleRuntimeId || found.runtimeRoles.has(roleRuntimeId));
      },
    });
    const leadTaskStore = createTaskStore(state, 'orchestrator');
    const leadAgent = registerLead(app, {
      leadRole, orchestrator, deliveryOrchestrators, baseUrl, authMiddleware, taskStore: leadTaskStore, events, projectConfig,
    });
    if (httpServer) {
      deliveryController = createDeliveryController({
        store: productStore,
        artifactStore,
        gitAdapterFactory: () => createGitAdapter({ workspace }),
        gitDeliveryFactory: () => createGitDelivery({ workspace, remotes: projectConfig.delivery.remotes }),
        projectConfig,
        appServer,
        leadRole,
        roles,
        leadClient: createLeadClient({ origin: baseUrl, authToken }),
        taskReader: createLeadTaskReader({ state, taskStore: leadTaskStore }),
        usageLedger,
        events,
        workspace,
        tickMs: deliveryTickMs,
        rolePackHash: computeRolePackHash(path.resolve(profilesDir || path.join(__dirname, '..', 'profiles'))),
        appServerVersion: typeof appServer.version === 'string' ? appServer.version : null,
        deliveryPack,
        legacyPack,
        settingsStore,
        modelCatalog,
      });
    }
    const dashboardAuth = createDashboardAuth({ db: state.db, getPort: () => actualPort });
    mountDashboard(app, {
      auth: dashboardAuth, authMiddleware, state, roles: allRoles, leadRole, workspace, events, projectId, productStore, artifactStore, deliveryController,
      activePack, legacyPack, modelCatalog, accountHealth, settingsStore, atlassianIntegration,
      gitDeliveryFactory: () => createGitDelivery({ workspace, remotes: projectConfig.delivery.remotes }),
      projectConfig,
      projectConfigPath: projectConfig.source === 'file' ? projectConfigPath : null,
      docsPackDir,
    });
    deliveryController?.start();
    return {
      app,
      dashboardAuth,
      httpServer,
      appServer,
      state,
      events,
      roles,
      specialistAgents,
      leadAgent,
      productStore,
      projectConfig,
      deliveryController,
      activePack,
      legacyPack,
      modelCatalog,
      accountHealth,
      settingsStore,
      atlassianIntegration,
      host: HOST,
      port: actualPort,
      async close() {
        // Stop the controller first so it never reacts to the cancellations that follow.
        atlassianIntegration?.clear?.();
        await deliveryController?.stop();
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
    try { await deliveryController?.stop(); } catch (_) { /* Preserve the startup failure. */ }
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
    const { code } = server.dashboardAuth.issuePairingCode();
    process.stdout.write(`Dashboard pairing URL: ${server.dashboardAuth.pairingUrl(code)}\n`);
    const shutdown = () => server.close().finally(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer, createLeadClient, createLeadTaskReader, describePause, makeLeadExecutor, leanRoutingOf, extractGoal, makeLeadCard,
  registerLead, rejectOverlappingLeadTask, protectRoleRpcMounts, assertOperatorPathsOutsideWorkspace,
  assertWorkspaceOutsideApplicationRoot,
};
