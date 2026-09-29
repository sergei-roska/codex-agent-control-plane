'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { Role: A2ARole, TaskState } = require('@a2a-js/sdk');
const { createLeadRole } = require('./role-catalog');

const MAX_ASSIGNMENTS = 4;
const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;
const DEFAULT_CANCEL_RETRY_INTERVAL_MS = 250;
const MAX_OUTCOME_TEXT_CHARS = 12_000;
const MAX_STATUS_TEXT_CHARS = 2_000;
const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);
const INTERRUPTED_STATES = new Set([
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'assignments', 'final'],
  properties: {
    action: { type: 'string', enum: ['dispatch', 'finish'] },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'objective', 'allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions'],
        properties: {
          role: { type: 'string' },
          objective: { type: 'string' },
          allowedFiles: { type: 'array', items: { type: 'string' } },
          inputs: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'string' } },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          checks: { type: 'array', items: { type: 'string' } },
          stopConditions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    final: { type: 'string' },
  },
};

const STATE_NAMES = new Map(Object.entries(TaskState).map(([name, value]) => [value, name]));

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

class UnconfirmedCancellationError extends Error {
  constructor(taskId, timeoutMs, options = {}) {
    super(`Could not confirm that A2A task ${taskId} stopped within ${timeoutMs}ms`, options);
    this.name = 'UnconfirmedCancellationError';
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortable(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function wait(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

function isTerminalTask(task) {
  const state = task?.status?.state;
  return TERMINAL_STATES.has(state) || [
    'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_CANCELLED',
    'TASK_STATE_REJECTED',
    'COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED', 'REJECTED',
  ].includes(taskStateName(state));
}

function isTaskFinished(task) {
  const state = task?.status?.state;
  return isTerminalTask(task) || INTERRUPTED_STATES.has(state) || ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED', 'INPUT_REQUIRED', 'AUTH_REQUIRED'].includes(taskStateName(state));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function extractTextParts(parts = []) {
  return parts.map((part) => {
    if (part?.content?.$case === 'text') return part.content.value || '';
    if (typeof part?.text === 'string') return part.text;
    return '';
  }).filter(Boolean).join('\n');
}

function taskStateName(state) {
  if (typeof state === 'string') return state;
  return STATE_NAMES.get(state) || String(state ?? 'unknown');
}

function resultTask(result) {
  if (result?.task) return result.task;
  if (result?.id && result?.status) return result;
  return null;
}

function safeRelativePath(file) {
  if (!isNonEmptyString(file) || file.includes('\\') || file.includes('\0')) return false;
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return false;
  const segments = file.split('/');
  return segments.every((segment) => segment !== '..' && segment !== '.' && segment !== '') && segments[0] !== '.';
}

function assignmentResult(task) {
  const status = task?.status;
  const statusMessage = extractTextParts(status?.message?.parts).slice(0, MAX_STATUS_TEXT_CHARS);
  const artifacts = (task?.artifacts || []).slice(0, 20).map((artifact) => ({
    name: artifact.name || '',
    description: artifact.description || '',
    text: extractTextParts(artifact.parts).slice(0, MAX_OUTCOME_TEXT_CHARS),
  }));
  const history = (task?.history || []).slice(-5).map((message) => extractTextParts(message.parts).slice(0, MAX_STATUS_TEXT_CHARS)).filter(Boolean);
  const text = artifacts.map((artifact) => artifact.text).filter(Boolean).join('\n') || statusMessage || history.at(-1) || '';
  return {
    taskId: task?.id || null,
    contextId: task?.contextId || null,
    status: taskStateName(status?.state),
    statusMessage,
    artifacts,
    history,
    text: text.slice(0, MAX_OUTCOME_TEXT_CHARS),
  };
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
  }

  async run({ goal, signal, onEvent } = {}) {
    if (!isNonEmptyString(goal)) throw new TypeError('goal must be a non-empty string');
    const outcomes = [];
    const assignments = [];
    const attemptedRoles = new Set();
    let threadId;
    let rounds = 0;

    try {
      while (true) {
        throwIfAborted(signal);
        const prompt = this._decisionInput(goal, rounds, outcomes);
        const leadResult = await this.appServer.run({
          role: this.leadRole,
          cwd: this.workspace,
          input: prompt,
          ...(threadId ? { threadId } : {}),
          outputSchema: DECISION_SCHEMA,
          signal,
        });
        threadId = leadResult.threadId || threadId;
        const decision = this._parseDecision(leadResult.text);
        this._validateDecision(decision, attemptedRoles, outcomes);
        this._emit(onEvent, { type: 'decision', round: rounds + 1, action: decision.action });

        if (decision.action === 'finish') {
          return { status: 'completed', text: decision.final.trim(), rounds, assignments };
        }
        if (rounds >= this.maxRounds) {
          return {
            status: 'max_rounds',
            text: decision.final.trim() || `Stopped after reaching the limit of ${this.maxRounds} dispatch rounds.`,
            rounds,
            assignments,
          };
        }

        rounds += 1;
        for (const assignment of decision.assignments) attemptedRoles.add(assignment.role);
        const parallel = decision.assignments.every((assignment) => this.roles.get(assignment.role).sandbox === 'read-only');
        const roundResults = parallel
          ? await this._dispatchBatch(decision.assignments, signal)
          : await this._dispatchSerially(decision.assignments, signal);
        for (const result of roundResults) {
          assignments.push(result);
          outcomes.push(result);
          this._emit(onEvent, { type: 'assignment', round: rounds, ...result });
        }
        this._emit(onEvent, { type: 'round', round: rounds, outcomes: roundResults });
        if (signal?.aborted) return this._canceledResult(rounds, assignments);
      }
    } catch (error) {
      if (error?.name === 'AbortError' && signal?.aborted) return this._canceledResult(rounds, assignments);
      throw error;
    }
  }

  _canceledResult(rounds, assignments) {
    return { status: 'canceled', text: 'Canceled after all active A2A tasks were confirmed stopped.', rounds, assignments };
  }

  _decisionInput(goal, rounds, outcomes) {
    return [
      'Plan and coordinate the requested work as the read-only team lead. Return only JSON matching the supplied schema.',
      'The lead must not edit files. Delegate all changes through the A2A role agents.',
      `User goal:\n${goal}`,
      `Dispatch rounds already used: ${rounds}/${this.maxRounds}. A dispatch decision consumes one round.`,
      'Available roles:\n' + JSON.stringify([...this.roles.values()].map(({ name, description, sandbox, model, effort }) => ({ name, description, sandbox, model, effort }))),
      'Prior worker outcomes (including failures):\n' + JSON.stringify(outcomes),
      'Every assignment must include role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, and stopConditions. Writable roles require one or more explicit safe relative allowedFiles. Keep each brief bounded.',
    ].join('\n\n');
  }

  _parseDecision(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Lead returned an empty decision');
    let decision;
    try {
      decision = JSON.parse(text);
    } catch (error) {
      throw new Error('Lead decision was not valid JSON', { cause: error });
    }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('Lead decision must be a JSON object');
    return decision;
  }

  _validateDecision(decision, attemptedRoles, outcomes) {
    const keys = Object.keys(decision).sort();
    if (keys.join(',') !== ['action', 'assignments', 'final'].sort().join(',')) throw new Error('Lead decision must contain only action, assignments, and final');
    if (!['dispatch', 'finish'].includes(decision.action)) throw new Error(`Unsupported lead action: ${String(decision.action)}`);
    if (!Array.isArray(decision.assignments)) throw new Error('Lead assignments must be an array');
    if (typeof decision.final !== 'string') throw new Error('Lead final must be a string');
    if (decision.action === 'finish') {
      if (decision.assignments.length !== 0 || !decision.final.trim()) throw new Error('Finish decisions require no assignments and non-empty final text');
      return;
    }
    if (decision.assignments.length < 1 || decision.assignments.length > MAX_ASSIGNMENTS) {
      throw new Error(`Dispatch must contain between 1 and ${MAX_ASSIGNMENTS} assignments`);
    }
    if (decision.final.trim()) throw new Error('Dispatch decisions must leave final empty');

    for (const assignment of decision.assignments) {
      const fields = ['role', 'objective', 'allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions'];
      if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) throw new Error('Each assignment must be an object');
      if (Object.keys(assignment).sort().join(',') !== fields.slice().sort().join(',')) {
        throw new Error('Assignment must contain exactly role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, and stopConditions');
      }
      const role = this.roles.get(assignment.role);
      if (!role) throw new Error(`Unknown role: ${String(assignment.role)}`);
      if (!isNonEmptyString(assignment.objective)) throw new Error(`Assignment for ${role.name} needs an objective`);
      for (const field of ['allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions']) {
        if (!Array.isArray(assignment[field]) || assignment[field].some((value) => !isNonEmptyString(value))) {
          throw new Error(`Assignment for ${role.name} needs a string array for ${field}`);
        }
        if (assignment[field].length > 20 || assignment[field].some((value) => value.length > 3_000)) {
          throw new Error(`Assignment for ${role.name} exceeds the size limit for ${field}`);
        }
      }
      if (assignment.inputs.length === 0) throw new Error(`Assignment for ${role.name} requires bounded inputs`);
      if (assignment.evidence.length === 0) throw new Error(`Assignment for ${role.name} requires prior evidence`);
      if (role.sandbox !== 'read-only' && assignment.allowedFiles.length === 0) {
        throw new Error(`Writable role ${role.name} requires explicit allowedFiles`);
      }
      for (const file of assignment.allowedFiles) {
        if (!safeRelativePath(file)) throw new Error(`Unsafe allowedFiles path for ${role.name}: ${file}`);
      }
      if (assignment.acceptanceCriteria.length === 0 || assignment.checks.length === 0 || assignment.stopConditions.length === 0) {
        throw new Error(`Assignment for ${role.name} requires acceptanceCriteria, checks, and stopConditions`);
      }
      if (role.name === 'orch-repair-xhigh' && !attemptedRoles.has('orch-builder')) {
        throw new Error('orch-repair-xhigh can only be dispatched after an orch-builder attempt');
      }
      if (role.name === 'orch-repair-sol' && !attemptedRoles.has('orch-repair-xhigh')) {
        throw new Error('orch-repair-sol can only be dispatched after an orch-repair-xhigh attempt');
      }
      if (role.name === 'orch-architect') {
        if (outcomes.length === 0) throw new Error('orch-architect requires inspected prior evidence');
        if (assignment.objective.length > 240 || decision.assignments.length !== 1) {
          throw new Error('orch-architect must receive one narrowly framed decision');
        }
      }
    }
  }

  async _dispatchSerially(assignments, signal) {
    const results = [];
    for (const assignment of assignments) results.push(await this._dispatch(assignment, signal));
    return results;
  }

  async _dispatchBatch(assignments, signal) {
    const settled = await Promise.allSettled(assignments.map((assignment) => this._dispatch(assignment, signal)));
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return settled.map((result) => result.value);
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

  async _dispatch(assignment, signal) {
    throwIfAborted(signal);
    const role = this.roles.get(assignment.role);
    const client = await this._clientFor(assignment.role);
    const text = JSON.stringify({ ...assignment, workspace: this.workspace });
    let task;
    const contextId = randomUUID();
    let taskId;
    const requestOptions = (includeSignal = true) => ({
      ...(includeSignal && signal ? { signal } : {}),
      ...(this.authToken ? { serviceParameters: { authorization: `Bearer ${this.authToken}` } } : {}),
    });
    throwIfAborted(signal);
    try {
      const submitted = await abortable(client.sendMessage({
        message: {
          messageId: randomUUID(),
          contextId,
          role: A2ARole.ROLE_USER,
          parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain' }],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] },
        metadata: {},
      }, requestOptions()), signal);
      task = resultTask(submitted);
      taskId = task?.id || submitted?.taskId || null;
      if (!task) {
        if (submitted?.message) {
          return { role: role.name, brief: assignment, taskId: null, status: 'completed', text: extractTextParts(submitted.message.parts), evidence: submitted };
        }
        throw new Error(`A2A role ${role.name} did not return a task ID`);
      }

      while (!isTaskFinished(task)) {
        throwIfAborted(signal);
        await wait(this.pollIntervalMs, signal);
        task = await abortable(client.getTask({ id: taskId, historyLength: 20 }, requestOptions()), signal);
      }
      const result = assignmentResult(task);
      return {
        role: role.name,
        brief: assignment,
        ...result,
        evidence: {
          taskId: result.taskId,
          status: result.status,
          statusMessage: result.statusMessage,
          artifactNames: result.artifacts.map((artifact) => artifact.name),
        },
      };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        const stoppedTask = await this._cancelUntilConfirmed(client, taskId, contextId);
        const result = assignmentResult(stoppedTask);
        return {
          role: role.name,
          brief: assignment,
          ...result,
          status: taskStateName(stoppedTask?.status?.state),
          evidence: { taskId: result.taskId || taskId, status: taskStateName(stoppedTask?.status?.state), cancellationConfirmed: true },
        };
      }
      return {
        role: role.name,
        brief: assignment,
        taskId,
        status: 'dispatch_error',
        text: (error?.message || String(error)).slice(0, MAX_STATUS_TEXT_CHARS),
        failure: { name: error?.name || 'Error', message: (error?.message || String(error)).slice(0, MAX_STATUS_TEXT_CHARS) },
      };
    }
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

module.exports = { LeadOrchestrator, DECISION_SCHEMA, safeRelativePath };
