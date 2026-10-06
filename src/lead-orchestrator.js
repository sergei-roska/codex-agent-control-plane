'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { Command, MemorySaver } = require('@langchain/langgraph');
const { createLeadRole } = require('./role-catalog');
const { DECISION_SCHEMA, safeRelativePath, normalizeEffectiveSettings } = require('./contracts');
const { InMemoryDispatchJournal } = require('./durable-store');
const { validateAcceptanceContract } = require('./acceptance');
const { buildLeadGraph, isTerminalTask, pauseMessage } = require('./lead-graph');
const { routingOf } = require('./route-runtime');

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;
const DEFAULT_CANCEL_RETRY_INTERVAL_MS = 250;
// Effectively unbounded: rounds are limited by maxRounds, not by LangGraph steps.
const RECURSION_LIMIT = 100_000;
// Only returned when a test passes interruptAfter and the graph stops at that node boundary.
const INTERRUPTED_FOR_TEST = 'interrupted_for_test';

class UnconfirmedCancellationError extends Error {
  constructor(taskId, timeoutMs, options = {}) {
    super(`Could not confirm that A2A task ${taskId} stopped within ${timeoutMs}ms`, options);
    this.name = 'UnconfirmedCancellationError';
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
  }
}

class RunNotFoundError extends Error {
  constructor(runId) {
    super(`No checkpoint exists for run ${runId}`);
    this.name = 'RunNotFoundError';
    this.runId = runId;
  }
}

class ResumeInputError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ResumeInputError';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('A2A cancellation request timed out')), timeoutMs);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

class LeadOrchestrator {
  constructor({
    appServer,
    roles,
    workspace,
    baseUrl,
    maxRounds = DEFAULT_MAX_ROUNDS,
    clientFactory = new ClientFactory(),
    leadRole = createLeadRole(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    authToken,
    cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
    cancelRetryIntervalMs = DEFAULT_CANCEL_RETRY_INTERVAL_MS,
    checkpointer = new MemorySaver(),
    journal = new InMemoryDispatchJournal(),
    admission = null,
    reconcileWaitMs,
    usageLedger = null,
    runCheckImpl,
    snapshot,
    deltaLines,
    repairChains,
    operatorControl,
  } = {}) {
    if (!appServer || typeof appServer.run !== 'function') throw new TypeError('appServer.run is required');
    if (!(roles instanceof Map)) throw new TypeError('roles must be a Map');
    if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required');
    if (typeof baseUrl !== 'string' || !baseUrl) throw new TypeError('baseUrl is required');
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new TypeError('maxRounds must be a positive integer');
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new TypeError('pollIntervalMs must be a non-negative number');
    if (!Number.isFinite(cancelTimeoutMs) || cancelTimeoutMs < 0) throw new TypeError('cancelTimeoutMs must be a non-negative number');
    if (!Number.isFinite(cancelRetryIntervalMs) || cancelRetryIntervalMs < 0) throw new TypeError('cancelRetryIntervalMs must be a non-negative number');
    if (!clientFactory || typeof clientFactory.createFromUrl !== 'function') {
      throw new TypeError('clientFactory.createFromUrl is required');
    }

    this.appServer = appServer;
    this.roles = roles;
    this.workspace = path.resolve(workspace);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.maxRounds = maxRounds;
    this.clientFactory = clientFactory;
    this.leadRole = { ...leadRole, sandbox: 'read-only' };
    this.pollIntervalMs = pollIntervalMs;
    this.authToken = authToken;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.cancelRetryIntervalMs = cancelRetryIntervalMs;
    this.clients = new Map();
    this.journal = journal;
    this.checkpointer = checkpointer;
    // Per-run runtime objects (signal, onEvent). Never checkpointed and never passed to LangGraph.
    this.runtimes = new Map();
    this.graph = buildLeadGraph({
      appServer: this.appServer,
      roles: this.roles,
      leadRole: this.leadRole,
      workspace: this.workspace,
      maxRounds: this.maxRounds,
      journal,
      pollIntervalMs: this.pollIntervalMs,
      admission,
      reconcileWaitMs,
      usageLedger,
      runCheckImpl,
      snapshot,
      ...(typeof deltaLines === 'function' ? { deltaLines } : {}),
      ...(repairChains ? { repairChains } : {}),
      ...(typeof operatorControl === 'function' ? { operatorControl } : {}),
      runtimeFor: (runId) => this.runtimes.get(runId),
      clientFor: (roleName) => this._clientFor(roleName),
      authOptions: () => this._authRequestOptions(),
      cancelUntilConfirmed: (client, taskId, contextId) => this._cancelUntilConfirmed(client, taskId, contextId),
      emit: (onEvent, event) => this._emit(onEvent, event),
      checkpointer,
    });
  }

  _config(runId, interruptAfter) {
    return {
      configurable: { thread_id: runId },
      recursionLimit: RECURSION_LIMIT,
      ...(interruptAfter ? { interruptAfter } : {}),
    };
  }

  async _snapshot(runId) {
    return this.graph.getState({ configurable: { thread_id: runId } });
  }

  static _pendingInterrupt(snapshot) {
    for (const task of snapshot.tasks || []) {
      if (task.interrupts?.length) return task.interrupts[0].value;
    }
    return null;
  }

  static _planState(plan) {
    const stages = plan?.stages;
    if (!Array.isArray(stages) || stages.length === 0) throw new TypeError('plan.stages must be a non-empty array');
    for (const stage of stages) {
      if (!stage || !isNonEmptyString(stage.stageId) || !isNonEmptyString(stage.roleId)
        || !Array.isArray(stage.dependencies) || !Array.isArray(stage.allowedFiles)) {
        throw new TypeError('each plan stage needs stageId, roleId, dependencies, and allowedFiles');
      }
    }
    const routing = routingOf(plan);
    const pinned = JSON.parse(JSON.stringify({
      planRevisionId: plan.planRevisionId ?? null,
      classification: plan.classification ?? null,
      ...(typeof plan.presetId === 'string' ? { presetId: plan.presetId } : {}),
      stages: stages.map((stage) => ({
        stageId: stage.stageId,
        roleId: stage.roleId,
        ...(typeof stage.publicRoleId === 'string' ? { publicRoleId: stage.publicRoleId } : {}),
        ...(typeof stage.presetStageKey === 'string' ? { presetStageKey: stage.presetStageKey } : {}),
        objective: stage.objective ?? '',
        dependencies: stage.dependencies,
        allowedFiles: stage.allowedFiles,
        required: stage.required === true,
      })),
      checkIds: Array.isArray(plan.checkIds) ? plan.checkIds : [],
      ...(routing.effective === 'lean' ? { routing } : {}),
    }));
    return {
      plan: pinned,
      // A skipped stage of a lean route is satisfied from the start and never dispatched.
      stageStatuses: Object.fromEntries(pinned.stages.map((stage) => [stage.stageId, { status: routing.skipStageIds.includes(stage.stageId) ? 'skipped' : 'pending', attemptIds: [] }])),
    };
  }

  // Pinned per-run role settings: { [roleRuntimeId]: { model, effort, serviceTier } }. Malformed entries are refused.
  static _settingsState(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('settings must be an object keyed by role runtime id');
    const pinned = {};
    for (const [roleId, entry] of Object.entries(settings)) {
      const normalized = normalizeEffectiveSettings(entry);
      if (!normalized) throw new TypeError(`settings for ${roleId} must have a valid model, effort, and serviceTier`);
      pinned[roleId] = normalized;
    }
    return pinned;
  }

  static _exists(snapshot) {
    return Object.keys(snapshot.values || {}).length > 0 || (snapshot.next || []).length > 0;
  }

  /** Pending interrupt value ({ kind: 'human_decision' | 'waiting_for_budget' | 'writer_unresolved', ... }) or null. */
  async getPause(runId) {
    if (!isNonEmptyString(runId)) return null;
    return LeadOrchestrator._pendingInterrupt(await this._snapshot(runId));
  }

  /** True when a checkpoint exists and the graph still has nodes to run (e.g. after a crashed step). */
  async isResumable(runId) {
    if (!isNonEmptyString(runId)) return false;
    const snapshot = await this._snapshot(runId);
    return LeadOrchestrator._exists(snapshot) && (snapshot.next || []).length > 0;
  }

  /**
   * `contract` is the acceptance contract; it is pinned in graph state here and never changed afterwards.
   * `plan` (optional, already validated by the caller) is pinned the same way and constrains dispatch; null = legacy.
   * `settings` (optional, the snapshot roles map) is pinned the same way; a resume never changes it.
   */
  async run({ goal, runId = randomUUID(), contract, plan = null, settings = null, signal, onEvent, interruptAfter } = {}) {
    if (!isNonEmptyString(goal)) throw new TypeError('goal must be a non-empty string');
    if (!isNonEmptyString(runId)) throw new TypeError('runId must be a non-empty string');
    const pinnedContract = validateAcceptanceContract(contract);
    if (LeadOrchestrator._exists(await this._snapshot(runId))) throw new Error(`A checkpoint already exists for run ${runId}; use resume()`);
    const planState = plan == null ? {} : LeadOrchestrator._planState(plan);
    const settingsState = settings == null ? {} : { settings: LeadOrchestrator._settingsState(settings) };
    return this._drive(runId, { goal, runId, contract: pinnedContract, ...planState, ...settingsState }, { signal, onEvent, interruptAfter, resumed: false });
  }

  async resume({ runId, input, signal, onEvent, interruptAfter } = {}) {
    if (!isNonEmptyString(runId)) throw new TypeError('runId must be a non-empty string');
    const snapshot = await this._snapshot(runId);
    if (!LeadOrchestrator._exists(snapshot)) throw new RunNotFoundError(runId);
    const pending = LeadOrchestrator._pendingInterrupt(snapshot);
    if (!pending && (snapshot.next || []).length === 0) {
      if (snapshot.values.result) return snapshot.values.result;
      throw new RunNotFoundError(runId);
    }
    let graphInput = null;
    if (pending?.kind === 'human_decision') {
      if (!input || typeof input !== 'object' || !isNonEmptyString(input.answer)) {
        throw new ResumeInputError('Resuming a human decision requires input { answer, choice?, decisionId? }');
      }
      if (input.decisionId !== undefined && input.decisionId !== pending.decisionId) {
        throw new ResumeInputError(`decisionId ${String(input.decisionId)} does not match the pending decision ${pending.decisionId}`);
      }
      if (input.choice !== undefined
        && (!isNonEmptyString(input.choice) || !(pending.options || []).some((option) => option.id === input.choice))) {
        throw new ResumeInputError('choice must match one of the pending human decision option ids');
      }
      graphInput = new Command({ resume: input });
    } else if (pending) {
      graphInput = new Command({ resume: input ?? true });
    }
    return this._drive(runId, graphInput, { signal, onEvent, interruptAfter, resumed: true });
  }

  async _drive(runId, graphInput, { signal, onEvent, interruptAfter, resumed }) {
    this.runtimes.set(runId, { signal, onEvent, resumed, pendingNotes: [] });
    try {
      await this.graph.invoke(graphInput, this._config(runId, interruptAfter));
      return await this._settle(runId, onEvent);
    } catch (error) {
      if (error?.name === 'AbortError' && signal?.aborted) {
        const snapshot = await this._snapshot(runId);
        return { runId, status: 'canceled', text: 'Canceled after all active A2A tasks were confirmed stopped.', rounds: snapshot.values.round || 0, assignments: snapshot.values.outcomes || [], acceptance: snapshot.values.acceptance ?? null };
      }
      throw error;
    } finally {
      this.runtimes.delete(runId);
    }
  }

  async _settle(runId, onEvent) {
    const snapshot = await this._snapshot(runId);
    const values = snapshot.values;
    const pending = LeadOrchestrator._pendingInterrupt(snapshot);
    if (pending) {
      const message = pending.message || pauseMessage(pending);
      const pause = { ...pending, message };
      this._emit(onEvent, { type: 'pause', round: values.round, pause });
      return {
        runId,
        status: pending.kind === 'waiting_for_budget' ? 'waiting_for_budget' : 'input_required',
        text: message,
        rounds: values.round,
        assignments: values.outcomes,
        pause,
      };
    }
    if ((snapshot.next || []).length > 0) {
      return { runId, status: INTERRUPTED_FOR_TEST, text: `Stopped before ${snapshot.next.join(', ')} (test breakpoint).`, rounds: values.round, assignments: values.outcomes };
    }
    return values.result;
  }

  async _clientFor(roleName) {
    if (!this.clients.has(roleName)) {
      const roleUrl = `${this.baseUrl}/agents/${encodeURIComponent(roleName)}`;
      const cardUrl = new URL(`${roleUrl}/agent-card.json`).toString();
      const pending = this.clientFactory.createFromUrl(cardUrl, '');
      this.clients.set(roleName, pending);
    }
    return this.clients.get(roleName);
  }

  async _cancelUntilConfirmed(client, initialTaskId, contextId) {
    const deadline = Date.now() + this.cancelTimeoutMs;
    let taskId = initialTaskId;
    let lastError;
    while (true) {
      if (!taskId) {
        try {
          const remainingMs = Math.max(0, deadline - Date.now());
          const response = await withTimeout(client.listTasks({
            contextId,
            status: TaskState.TASK_STATE_UNSPECIFIED,
            pageSize: 100,
            pageToken: '',
            historyLength: 20,
            statusTimestampAfter: undefined,
          }, this._authRequestOptions()), remainingMs);
          const candidate = response?.tasks?.find((entry) => entry.contextId === contextId);
          if (candidate?.id) taskId = candidate.id;
        } catch (error) {
          lastError = error;
        }
      }
      if (taskId) {
        let task;
        try {
          const remainingMs = Math.max(0, deadline - Date.now());
          task = await withTimeout(client.cancelTask({ id: taskId }, this._authRequestOptions()), remainingMs);
          if (isTerminalTask(task)) return task;
        } catch (error) {
          lastError = error;
        }
        try {
          const remainingMs = Math.max(0, deadline - Date.now());
          task = await withTimeout(client.getTask({ id: taskId, historyLength: 20 }, this._authRequestOptions()), remainingMs);
          if (isTerminalTask(task)) return task;
        } catch (error) {
          lastError = error;
        }
      }
      if (Date.now() >= deadline) {
        throw new UnconfirmedCancellationError(taskId || contextId, this.cancelTimeoutMs, { cause: lastError });
      }
      await delay(Math.min(this.cancelRetryIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  _authRequestOptions() {
    return this.authToken ? { serviceParameters: { authorization: `Bearer ${this.authToken}` } } : {};
  }

  _emit(onEvent, event) {
    try { onEvent?.(event); } catch (_) { /* Observers cannot break orchestration. */ }
  }
}

module.exports = {
  LeadOrchestrator,
  DECISION_SCHEMA,
  safeRelativePath,
  RunNotFoundError,
  ResumeInputError,
  UnconfirmedCancellationError,
  INTERRUPTED_FOR_TEST,
};
