'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { Command, GraphRecursionError, MemorySaver } = require('@langchain/langgraph');
const { createLeadRole } = require('./role-catalog');
const { DECISION_SCHEMA, safeRelativePath } = require('./contracts');
const { InMemoryDispatchJournal } = require('./durable-store');
const { validateAcceptanceContract } = require('./acceptance');
const { buildLeadGraph, isTerminalTask, pauseMessage } = require('./lead-graph');
const { loadSkillCatalog } = require('./skill-catalog');
const { loadMcpCatalog } = require('./mcp-catalog');

const DEFAULT_MAX_ROUNDS = null;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_CANCEL_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_RETRY_INTERVAL_MS = 250;
// Keep LangGraph invokes long, but roll forward from checkpoints if an invoke reaches this ceiling.
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

const DIGEST_MAX_CHARS = 12000;
const digestClip = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

/** Bounded plain-object digest of a finished run's checkpoint state. */
function buildRunDigest(values) {
  const outcomes = (Array.isArray(values.outcomes) ? values.outcomes : []).filter((entry) => entry && entry.kind !== 'reconciliation');
  const changed = new Set();
  const inspected = new Map();
  const digestOutcomes = outcomes.map((outcome) => {
    const report = outcome.report || null;
    for (const file of outcome.writerExecution?.delta?.changedPaths || []) if (typeof file === 'string' && file) changed.add(file);
    for (const file of report?.filesInspected || []) if (typeof file === 'string' && file) inspected.set(file, (inspected.get(file) || 0) + 1);
    const entry = { role: outcome.role || null };
    const objective = digestClip(outcome.objective ?? outcome.assignment?.objective, 300);
    if (objective) entry.objective = objective;
    entry.status = outcome.status || null;
    if (report?.outcome) entry.outcome = report.outcome;
    entry.summary = digestClip(report?.summary, 400);
    const question = digestClip(report?.decisionRequest?.question, 300);
    if (question) entry.decisionQuestion = question;
    return entry;
  });
  const text = typeof values.text === 'string' ? values.text : '';
  const nextParagraph = text.split(/\n\s*\n/).map((part) => part.trim())
    .find((part) => /^\W*(next work|next steps?|remaining work|follow-?ups?)\b/i.test(part));
  return {
    goal: digestClip(values.goal, 2000),
    text: digestClip(text, 4000),
    rounds: Number.isInteger(values.round) ? values.round : 0,
    status: values.status || null,
    outcomes: digestOutcomes,
    openDecisions: (values.openDecisions || []).map((entry) => ({
      id: entry.id ?? null,
      role: entry.role ?? null,
      question: digestClip(entry.request?.question, 300),
    })),
    changedFiles: [...changed].sort().slice(0, 100),
    inspectedDocs: [...inspected.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 30)
      .map(([file, count]) => ({ file, count })),
    nextWork: nextParagraph ? digestClip(nextParagraph, 1500) : '',
  };
}

/** Compact text block (at most 12000 chars) for a digest; trims outcome summaries, then inspectedDocs, then changedFiles. */
function renderRunDigest(digest, maxChars = DIGEST_MAX_CHARS) {
  if (!digest || typeof digest !== 'object') return '';
  const build = ({ summaries, docs, files }) => {
    const lines = [`Run status: ${digest.status || 'unknown'}; dispatch rounds: ${digest.rounds ?? 0}`];
    if (digest.goal) lines.push(`Goal: ${digest.goal}`);
    if (digest.text) lines.push(`Final text: ${digest.text}`);
    // The paragraph often starts with its own "Next work:" label; do not double it.
    if (digest.nextWork) lines.push(/^\W*next work\b/i.test(digest.nextWork) ? digest.nextWork : `Next work: ${digest.nextWork}`);
    const outcomes = digest.outcomes || [];
    if (outcomes.length > 0) {
      lines.push('Worker outcomes:');
      for (const outcome of outcomes) {
        const head = `- ${outcome.role || 'role'} [${outcome.outcome || outcome.status || 'unknown'}]${outcome.objective ? ` ${outcome.objective}` : ''}`;
        lines.push(head);
        if (summaries && outcome.summary) lines.push(`  summary: ${summaries === 'short' ? digestClip(outcome.summary, 120) : outcome.summary}`);
        if (outcome.decisionQuestion) lines.push(`  decision question: ${outcome.decisionQuestion}`);
      }
    }
    const open = digest.openDecisions || [];
    if (open.length > 0) {
      lines.push('Open decisions:');
      for (const entry of open) lines.push(`- ${entry.id} (${entry.role}): ${entry.question}`);
    }
    if (files && (digest.changedFiles || []).length > 0) lines.push(`Changed files: ${digest.changedFiles.join(', ')}`);
    if (docs && (digest.inspectedDocs || []).length > 0) lines.push(`Most inspected files: ${digest.inspectedDocs.map((entry) => `${entry.file} (${entry.count})`).join(', ')}`);
    return lines.join('\n');
  };
  const stages = [
    { summaries: 'full', docs: true, files: true },
    { summaries: 'short', docs: true, files: true },
    { summaries: false, docs: true, files: true },
    { summaries: false, docs: false, files: true },
    { summaries: false, docs: false, files: false },
  ];
  let rendered = '';
  for (const stage of stages) {
    rendered = build(stage);
    if (rendered.length <= maxChars) return rendered;
  }
  return `${rendered.slice(0, maxChars - 3)}...`;
}

// SES-01: explicit context-size threshold for a session's lead thread, or null (then 60% of the
// model window, else 150000, is used by the graph).
function rolloverTokensFromEnv(env = process.env) {
  const value = env.CODEX_A2A_LEAD_ROLLOVER_TOKENS ? Number(env.CODEX_A2A_LEAD_ROLLOVER_TOKENS) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const SESSION_DIGEST_MAX_CHARS = 12000;

class LeadOrchestrator {
  constructor({
    appServer,
    roles,
    workspace,
    baseUrl,
    maxRounds = DEFAULT_MAX_ROUNDS,
    stepLimit = RECURSION_LIMIT,
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
    stagingLog = null,
    parallelWriters = false,
    activityStore = null,
    evidenceStore = null,
    runCheckImpl,
    snapshot,
    acceptanceScratch = null,
    skillCatalog = loadSkillCatalog(),
    mcpCatalog = loadMcpCatalog(),
    aut03TrialRunIds = new Set(),
    aut03SkillPin,
    sessionThreads = null,
    rolloverTokens = rolloverTokensFromEnv(),
  } = {}) {
    if (!appServer || typeof appServer.run !== 'function') throw new TypeError('appServer.run is required');
    if (!(roles instanceof Map)) throw new TypeError('roles must be a Map');
    if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required');
    if (typeof baseUrl !== 'string' || !baseUrl) throw new TypeError('baseUrl is required');
    if (maxRounds !== null && (!Number.isSafeInteger(maxRounds) || maxRounds < 1)) {
      throw new TypeError('maxRounds must be null or a positive safe integer');
    }
    if (!Number.isSafeInteger(stepLimit) || stepLimit < 1) {
      throw new TypeError('stepLimit must be a positive safe integer');
    }
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
    this.stepLimit = stepLimit;
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
      stagingLog,
      parallelWriters,
      activityStore,
      evidenceStore,
      runCheckImpl,
      snapshot,
      // Owner-side setting (project-settings.json); never read from the lead's output.
      acceptanceScratch,
      skillCatalog,
      mcpCatalog,
      aut03TrialRunIds,
      ...(aut03SkillPin ? { aut03SkillPin } : {}),
      sessionThreads,
      rolloverTokens,
      sessionDigest: (input) => this._sessionDigest(input),
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
      recursionLimit: this.stepLimit,
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

  static _exists(snapshot) {
    return Object.keys(snapshot.values || {}).length > 0 || (snapshot.next || []).length > 0;
  }

  /** Pending interrupt value ({ kind: 'human_decision' | 'waiting_for_budget' | 'writer_unresolved' | 'owner_pause', ... }) or null. */
  async getPause(runId) {
    if (!isNonEmptyString(runId)) return null;
    return LeadOrchestrator._pendingInterrupt(await this._snapshot(runId));
  }

  /**
   * PAUSE-01: asks an active run to park as owner_pause at its next safe boundary (start of decide, or
   * after collect). Returns false when the run is not active. No worker turn is cancelled by a pause.
   */
  requestPause(runId) {
    const runtime = this.runtimes.get(runId);
    if (!runtime) return false;
    runtime.pauseRequested = true;
    return true;
  }

  /** Withdraws a pause request that has not parked yet. Returns true when one was pending. */
  cancelPauseRequest(runId) {
    const runtime = this.runtimes.get(runId);
    if (!runtime || runtime.pauseRequested !== true) return false;
    runtime.pauseRequested = false;
    return true;
  }

  isPauseRequested(runId) {
    return this.runtimes.get(runId)?.pauseRequested === true;
  }

  /** Active runs with their pause flag; a run that parked or ended is no longer listed. */
  activeRuns() {
    return [...this.runtimes].map(([runId, runtime]) => ({ runId, pauseRequested: runtime.pauseRequested === true }));
  }

  /** The goal pinned in the run's checkpointed state, or null when there is no checkpoint. */
  async getRunGoal(runId) {
    if (!isNonEmptyString(runId)) return null;
    const goal = (await this._snapshot(runId)).values?.goal;
    return isNonEmptyString(goal) ? goal : null;
  }

  /** Bounded digest of a run's checkpointed state for follow-up runs, or null when there is no checkpoint. */
  async getRunDigest(runId) {
    if (!isNonEmptyString(runId)) return null;
    const snapshot = await this._snapshot(runId);
    if (!LeadOrchestrator._exists(snapshot) || !snapshot.values?.goal) return null;
    return buildRunDigest(snapshot.values);
  }

  /** True when a checkpoint exists and the graph still has nodes to run (e.g. after a crashed step). */
  async isResumable(runId) {
    if (!isNonEmptyString(runId)) return false;
    const snapshot = await this._snapshot(runId);
    return LeadOrchestrator._exists(snapshot) && (snapshot.next || []).length > 0;
  }

  /**
   * Digest for a lead thread that starts mid-session (SES-01): the current run's digest, then the final
   * texts of the session's earlier runs (newest first), bounded to 12000 chars. The earlier runs are the
   * ids kept in the session row; their final text comes from their checkpoints.
   */
  async _sessionDigest({ runId, runIds = [], state }) {
    const parts = [];
    const current = renderRunDigest(buildRunDigest(state), 6000);
    if (current) parts.push(`Current run so far:\n${current}`);
    const earlier = [];
    for (const id of [...runIds].reverse()) {
      if (id === runId) continue;
      let values = null;
      try { values = (await this._snapshot(id)).values || null; } catch (_) { values = null; }
      if (!values?.goal) continue;
      earlier.push(`- Run ${id} [${values.status || 'unknown'}] goal: ${digestClip(values.newRequest || values.goal, 400)}\n  final: ${digestClip(values.text, 1500) || '(none)'}`);
    }
    if (earlier.length > 0) parts.push(`Earlier runs in this session (newest first):\n${earlier.join('\n')}`);
    return digestClip(parts.join('\n\n'), SESSION_DIGEST_MAX_CHARS);
  }

  /** `contract` is the acceptance contract; it is pinned in graph state here and never changed afterwards. */
  async run({ goal, runId = randomUUID(), contract, signal, onEvent, interruptAfter, contextId, newRequest } = {}) {
    if (!isNonEmptyString(goal)) throw new TypeError('goal must be a non-empty string');
    if (!isNonEmptyString(runId)) throw new TypeError('runId must be a non-empty string');
    const pinnedContract = validateAcceptanceContract(contract);
    if (LeadOrchestrator._exists(await this._snapshot(runId))) throw new Error(`A checkpoint already exists for run ${runId}; use resume()`);
    return this._drive(runId, {
      goal, runId, contract: pinnedContract,
      ...(isNonEmptyString(contextId) ? { contextId } : {}),
      ...(isNonEmptyString(newRequest) ? { newRequest } : {}),
    }, { signal, onEvent, interruptAfter, resumed: false, contextId });
  }

  async resume({ runId, input, signal, onEvent, interruptAfter, contextId } = {}) {
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
    return this._drive(runId, graphInput, { signal, onEvent, interruptAfter, resumed: true, contextId });
  }

  async _drive(runId, graphInput, { signal, onEvent, interruptAfter, resumed, contextId }) {
    this.runtimes.set(runId, { signal, onEvent, resumed, pendingNotes: [], ...(isNonEmptyString(contextId) ? { contextId } : {}) });
    try {
      let input = graphInput;
      for (;;) {
        const before = await this._snapshot(runId);
        try {
          await this.graph.invoke(input, this._config(runId, interruptAfter));
          break;
        } catch (error) {
          if (!(error instanceof GraphRecursionError)) throw error;
          const snapshot = await this._snapshot(runId);
          if (signal?.aborted) {
            if (snapshot.values?.result) return snapshot.values.result;
            if (LeadOrchestrator._pendingInterrupt(snapshot)) break;
            throw error;
          }
          if (LeadOrchestrator._pendingInterrupt(snapshot) || (snapshot.next || []).length === 0) break;
          const beforeStep = before.metadata?.step;
          const afterStep = snapshot.metadata?.step;
          const beforeId = before.config?.configurable?.checkpoint_id;
          const afterId = snapshot.config?.configurable?.checkpoint_id;
          const beforeEmpty = !LeadOrchestrator._exists(before)
            && !Number.isSafeInteger(beforeStep)
            && typeof beforeId !== 'string';
          const advancedStep = Number.isSafeInteger(afterStep)
            && (beforeEmpty || (Number.isSafeInteger(beforeStep) && afterStep > beforeStep));
          const advancedCheckpoint = typeof afterId === 'string'
            && (beforeEmpty || (typeof beforeId === 'string' && afterId !== beforeId));
          if (!advancedStep || !advancedCheckpoint) throw error;
          input = null;
        }
      }
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
  renderRunDigest,
  DECISION_SCHEMA,
  safeRelativePath,
  RunNotFoundError,
  ResumeInputError,
  UnconfirmedCancellationError,
  INTERRUPTED_FOR_TEST,
};
