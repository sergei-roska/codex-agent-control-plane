const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { readProcessIdentity, listGroupMembers } = require('./process-quiescence');

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
// Pin the approvals reviewer to the client so every approval request reaches
// _declineServerRequest instead of a Codex auto-reviewer that could approve escalations.
const APPROVALS_REVIEWER = 'user';
const ZERO_TOTAL = Object.freeze(Object.fromEntries(TOKEN_FIELDS.map((key) => [key, 0])));
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_PERMISSION_EVENTS = 50;
const MAX_TEXT_CHARS = 500;
const MAX_COMMAND_CHARS = 300;
const MAX_HOOK_COMMAND_CHARS = 200;
const HOOK_BLOCK_PREFIX = 'Command blocked by PreToolUse hook:';

function resolveTurnTimeoutMs(value = process.env.CODEX_A2A_TURN_TIMEOUT_MS) {
  if (value === undefined) return DEFAULT_TURN_TIMEOUT_MS;
  const timeoutMs = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('CODEX_A2A_TURN_TIMEOUT_MS must be a positive safe integer');
  }
  return timeoutMs;
}

class CodexAppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CodexAppServerError';
    Object.assign(this, details);
  }
}

// A group id still answering right after our leader exited is our own group (the kernel does not
// reuse a pid while it is a live PGID); a pid wrap inside this window is not realistic.
const OWN_GROUP_EXIT_WINDOW_MS = 5_000;
const SANDBOX_DENIAL_PATTERN = /Read-only file system|Operation not permitted|Permission denied/i;

class CodexAppServer {
  constructor({
    codexPath = 'codex',
    spawnImpl = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    turnTimeoutMs = resolveTurnTimeoutMs(),
    interruptTimeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS,
    killImpl = process.kill.bind(process),
    readProcessIdentityImpl = readProcessIdentity,
    listGroupMembersImpl = listGroupMembers,
  } = {}) {
    this.codexPath = codexPath;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnTimeoutMs = resolveTurnTimeoutMs(turnTimeoutMs);
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.killImpl = killImpl;
    this.readProcessIdentityImpl = readProcessIdentityImpl;
    this.listGroupMembersImpl = listGroupMembersImpl;
    this.lastTermination = null;
    this.childIdentity = null;
    this.childExitAt = null;
    this.childExitTimes = new WeakMap();
    this.terminatedChildren = new WeakSet();
    this.threadTotals = new Map();
    this.appServerVersion = null;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.runs = new Map();
    this.startPromise = null;
    this.closed = false;
    this.exitError = null;
    this.loadedThreads = new Set();
    this.generation = 0;
    this.childExited = true;
    this.childExitPromise = null;
    this.resolveChildExit = null;
    this.hookInventories = new Map();
  }

  async start() {
    if (this.closed) throw new CodexAppServerError('Codex App Server client is closed');
    if (this.startPromise) return this.startPromise;

    const startPromise = this._startWhenReady();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } catch (error) {
      const ownsStart = this.startPromise === startPromise;
      if (ownsStart) this.startPromise = null;
      if (ownsStart && !this.exitError) this._failAll(error);
      if (ownsStart || (this.exitError && this.child && !this.childExited)) this._terminateProcess();
      throw error;
    }
  }

  async _startWhenReady() {
    if (this.closed) throw new CodexAppServerError('Codex App Server client is closed');
    if (this.exitError && this.child && !this.childExited) {
      this._terminateProcess();
      await this.childExitPromise;
    }
    if (this.closed) throw new CodexAppServerError('Codex App Server client is closed');
    if (this.exitError) this._discardFailedChild();
    return this._start();
  }

  async _start() {
    const child = this.spawnImpl(this.codexPath, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      // Own process group, so the whole tree can be signalled and proven gone.
      detached: true,
    });
    const generation = ++this.generation;
    this.child = child;
    this.closed = false;
    this.exitError = null;
    this.loadedThreads = new Set();
    this.threadTotals = new Map();
    this.hookInventories = new Map();
    const identity = typeof child.pid === 'number' ? this.readProcessIdentityImpl(child.pid) : null;
    this.childIdentity = identity;
    this.childExitAt = null;
    this.childExited = false;
    this.childExitPromise = new Promise((resolve) => { this.resolveChildExit = resolve; });

    child.stdout.on('error', (error) => {
      if (this._isCurrentChild(child, generation)) this._failAndTerminate(new CodexAppServerError('Codex App Server stdout failed', { cause: error }));
    });
    child.stdin.on('error', (error) => {
      if (this._isCurrentChild(child, generation)) this._failAndTerminate(new CodexAppServerError('Codex App Server stdin failed', { cause: error }));
    });
    child.on('error', (error) => {
      if (this._isCurrentChild(child, generation)) this._failAll(new CodexAppServerError('Could not start Codex App Server', { cause: error }));
    });
    child.on('exit', (code, signal) => {
      const exitAt = Date.now();
      this.childExitTimes.set(child, exitAt);
      if (this._isCurrentChild(child, generation)) this.childExitAt = exitAt;
      this._markChildExited(child, generation);
      // The leader is gone; make sure no member of its group outlives it (also after close()).
      this._signalOwnGroup(identity, 'SIGKILL', { child, exitAt });
      if (this._isCurrentChild(child, generation) && !this.closed) {
        const error = new CodexAppServerError(`Codex App Server exited unexpectedly (${signal || code})`, { code, signal });
        this.exitError = error;
        this._failAll(error);
      }
    });
    child.on('close', () => this._markChildExited(child, generation));

    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader = reader;
    reader.on('line', (line) => {
      if (this._isCurrentChild(child, generation)) this._handleLine(line);
    });
    reader.on('close', () => {
      if (this._isCurrentChild(child, generation) && !this.closed && !this.exitError) {
        this._failAndTerminate(new CodexAppServerError('Codex App Server stdout closed unexpectedly'));
      }
    });

    const initResult = await this._request('initialize', {
      clientInfo: { name: 'codex-a2a-runtime', title: 'Codex A2A Runtime', version: '0.1.0' },
    });
    this.appServerVersion = typeof initResult?.userAgent === 'string' ? initResult.userAgent : null;
    this._notify('initialized', {});
  }

  processIdentity() {
    if (!this.child || this.childExited || !this.childIdentity) return null;
    return { ...this.childIdentity };
  }

  _isCurrentChild(child, generation) {
    return this.child === child && this.generation === generation;
  }

  _markChildExited(child, generation) {
    if (!this._isCurrentChild(child, generation) || this.childExited) return;
    this.childExited = true;
    this.resolveChildExit?.();
    this.resolveChildExit = null;
  }

  _discardFailedChild() {
    this.reader?.close();
    this.child = null;
    this.childIdentity = null;
    this.reader = null;
    this.exitError = null;
    this.childExited = true;
    this.childExitPromise = null;
    this.resolveChildExit = null;
  }

  async getAccount() {
    await this.start();
    const result = await this._request('account/read', {});
    return {
      account: sanitizeAccount(result.account),
      requiresOpenaiAuth: Boolean(result.requiresOpenaiAuth),
    };
  }

  async listHooks(cwd) {
    try {
      await this.start();
      const result = await this._request('hooks/list', cwd ? { cwds: [cwd] } : {});
      const hooks = [];
      for (const entry of Array.isArray(result?.data) ? result.data : []) {
        for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
          hooks.push(sanitizeHook(hook));
        }
      }
      return hooks;
    } catch (_) {
      return null;
    }
  }

  async hookInventory(cwd) {
    const key = cwd || '';
    if (!this.hookInventories.has(key)) {
      const pending = this.listHooks(cwd);
      this.hookInventories.set(key, pending);
      pending.then((hooks) => { if (hooks === null && this.hookInventories.get(key) === pending) this.hookInventories.delete(key); });
    }
    return this.hookInventories.get(key);
  }

  async readRateLimits() {
    try {
      await this.start();
      return await this._request('account/rateLimits/read', {});
    } catch (_) {
      return null;
    }
  }

  async run({ role, cwd, input, onEvent, signal, threadId: existingThreadId, outputSchema, onTurnStart } = {}) {
    if (!role || !role.name) throw new TypeError('role.name is required');
    if (!cwd) throw new TypeError('cwd is required');
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input must be a non-empty string');
    if (signal?.aborted) throw abortError();

    const ctx = {
      processIdentity: null,
      threadId: existingThreadId || null,
      turnId: null,
      turnStartSent: false,
      turnStartRejected: false,
      run: null,
      model: role.model || null,
      effort: role.effort || null,
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
      permissionEvents: [],
      pendingHooks: new Map(),
      permissionConfig: {
        sandbox: normalizeSandbox(role.sandbox),
        sandboxPolicy: sandboxPolicy(role.sandbox).type,
        approvalPolicy: 'on-request',
        approvalsReviewer: APPROVALS_REVIEWER,
        cwd,
      },
    };
    try {
      const result = await this._run(ctx, { role, cwd, input, onEvent, signal, existingThreadId, outputSchema, onTurnStart });
      return { ...result, execution: executionOf(ctx), usage: this._usageOf(ctx), ...permissionOf(ctx) };
    } catch (error) {
      // Concurrent runs can share one error instance (child failure); give each its own copy.
      const own = cloneError(error);
      own.execution = executionOf(ctx);
      own.usage = this._usageOf(ctx);
      Object.assign(own, permissionOf(ctx));
      throw own;
    }
  }

  async _run(ctx, { role, cwd, input, onEvent, signal, existingThreadId, outputSchema, onTurnStart }) {
    await this.start();

    const developerInstructions = role.instructions || `You are the ${role.name} agent.`;
    let threadResult = null;
    let baseline = null;
    if (!existingThreadId) {
      threadResult = await this._request('thread/start', {
        model: role.model || null,
        cwd,
        developerInstructions,
        sandbox: normalizeSandbox(role.sandbox),
        approvalPolicy: 'on-request',
        approvalsReviewer: APPROVALS_REVIEWER,
      }, { signal });
      if (threadResult?.thread?.id) {
        this.loadedThreads.add(threadResult.thread.id);
        // A brand-new thread has consumed nothing yet.
        if (!this.threadTotals.has(threadResult.thread.id)) this.threadTotals.set(threadResult.thread.id, ZERO_TOTAL);
      }
      ctx.model = threadResult?.model || ctx.model;
      ctx.effort = ctx.effort || threadResult?.reasoningEffort || null;
    } else if (!this.loadedThreads.has(existingThreadId)) {
      // A restarted App Server no longer has the thread loaded; resume it from disk.
      // thread/resume carries no token usage, so the baseline stays unknown until an update arrives.
      const resumed = await this._request('thread/resume', {
        threadId: existingThreadId,
        cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: APPROVALS_REVIEWER,
        sandbox: normalizeSandbox(role.sandbox),
        model: role.model || null,
        developerInstructions,
      }, { signal });
      this.loadedThreads.add(existingThreadId);
      ctx.model = resumed?.model || ctx.model;
      ctx.effort = ctx.effort || resumed?.reasoningEffort || null;
    }

    const threadId = existingThreadId || threadResult?.thread?.id;
    if (!threadId) throw new CodexAppServerError('Codex App Server did not return a thread ID');
    ctx.threadId = threadId;
    if (this.runs.has(threadId)) {
      throw new CodexAppServerError(`A Codex turn is already active for thread ${threadId}`, { threadId });
    }
    baseline = this.threadTotals.get(threadId) || null;

    const run = { threadId, turnId: null, status: null, text: '', events: [], onEvent, terminal: null, baseline, lastTotal: null, ctx };
    run.abortRequested = false;
    run.interruptSent = false;
    ctx.run = run;
    this.runs.set(threadId, run);
    const abortHandler = () => {
      run.abortRequested = true;
      this._interruptRun(run);
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      if (signal?.aborted) throw abortError();
      ctx.processIdentity = this.processIdentity();
      if (onTurnStart) onTurnStart({ processIdentity: ctx.processIdentity, threadId });
      const turnStartRequest = this._request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input }],
        ...(role.model ? { model: role.model } : {}),
        ...(role.effort ? { effort: role.effort } : {}),
        cwd,
        sandboxPolicy: sandboxPolicy(role.sandbox),
        approvalPolicy: 'on-request',
        approvalsReviewer: APPROVALS_REVIEWER,
        ...(outputSchema ? { outputSchema } : {}),
      }, { onWritten: () => { ctx.turnStartSent = true; } });
      let turnResult;
      try {
        turnResult = await turnStartRequest;
      } catch (error) {
        // A JSON-RPC error response means the server refused the request: no turn was created.
        if (error?.rpcResponse === true) ctx.turnStartRejected = true;
        throw error;
      }

      run.turnId = turnResult.turn?.id || run.turnId;
      if (!run.turnId) throw new CodexAppServerError('Codex App Server did not return a turn ID');
      if (run.abortRequested) this._interruptRun(run);
      if (!run.terminal) {
        run.terminal = await this._waitForTerminal(run);
      }
      if (run.abortRequested) throw abortError({ threadId, turnId: run.turnId, status: run.status });
      if (run.status === 'failed') {
        throw new CodexAppServerError(run.terminal?.error?.message || 'Codex turn failed', {
          threadId,
          turnId: run.turnId,
          status: run.status,
          codexError: run.terminal?.error || null,
        });
      }
      return { threadId, turnId: run.turnId, status: run.status, text: run.text, events: run.events };
    } catch (error) {
      let cause = error;
      // A fail-safe error (child terminated) is the authoritative outcome.
      if (run.failSafeError && error.name !== 'AbortError') cause = run.failSafeError;
      const termination = cause.outcomeUnknown && !cause.termination && this.lastTermination?.survivors?.length ? this.lastTermination : null;
      if (termination) cause.termination = termination;
      if (run.abortRequested && cause.name !== 'AbortError') {
        throw abortError({ threadId, turnId: run.turnId, cause, ...(cause.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(cause.termination ? { termination: cause.termination } : {}) });
      }
      throw cause;
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      clearTimeout(run.interruptTimer);
      this.runs.delete(threadId);
    }
  }

  _usageOf(ctx) {
    const run = ctx.run;
    const cumulativeTotal = run?.lastTotal ? { ...run.lastTotal } : null;
    let tokens = null;
    let tokenSource = 'unavailable';
    if (run?.lastTotal && run.baseline) {
      // `last` in thread/tokenUsage/updated is not documented as per-turn, so use the
      // total delta against the baseline known before this turn.
      const delta = {};
      let sound = true;
      for (const key of TOKEN_FIELDS) {
        const end = run.lastTotal[key];
        const start = run.baseline[key];
        if (!Number.isFinite(end) || !Number.isFinite(start) || end < start) { delta[key] = null; sound = false; continue; }
        delta[key] = end - start;
      }
      if (sound) { tokens = delta; tokenSource = 'total_delta'; }
    }
    return {
      model: ctx.model,
      effort: ctx.effort,
      startedAt: ctx.startedAt,
      elapsedMs: Math.round(performance.now() - ctx.startedMs),
      // A run that failed before turn/start was sent has a known count of zero turns.
      turns: ctx.turnStartSent ? 1 : 0,
      // The schema does not say updates map one-to-one to model requests.
      modelRequests: null,
      tokens,
      tokenSource,
      cumulativeTotal,
      appServerVersion: this.appServerVersion,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.loadedThreads.clear();
    this.reader?.close();
    this._failAll(new CodexAppServerError('Codex App Server client closed'));
    this.childExited = true;
    this.resolveChildExit?.();
    this.resolveChildExit = null;
    this._terminateProcess();
    this.child = null;
    this.startPromise = null;
  }

  _request(method, params, { signal, timeoutMs = this.requestTimeoutMs, onWritten } = {}) {
    if (!this.child || this.closed || this.exitError) return Promise.reject(this.exitError || new CodexAppServerError('Codex App Server is not running'));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new CodexAppServerError(`Codex App Server request timed out: ${method}`, { method, id });
        if (method === 'turn/start') {
          const run = this.runs.get(params.threadId);
          if (run) {
            // The turn may have started: the child (and its group) must be gone before we report.
            error.outcomeUnknown = true;
            run.failSafeError = error;
            this.pending.delete(id);
            this._terminateProcess();
            reject(error);
            return;
          }
        }
        this.pending.delete(id);
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); },
        reject: (error) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); },
      });
      try {
        this._write({ id, method, params });
        onWritten?.();
      } catch (error) {
        this.pending.get(id)?.reject(error);
        this.pending.delete(id);
      }
    });
  }

  _notify(method, params) {
    this._write({ method, params });
  }

  _write(message) {
    if (!this.child || this.closed) throw this.exitError || new CodexAppServerError('Codex App Server is not running');
    if (!this.child.stdin.write(`${JSON.stringify(message)}\n`)) {
      // Node buffers writes; a false return only signals backpressure.
    }
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this._failAndTerminate(new CodexAppServerError('Codex App Server sent invalid JSONL', { cause: error }));
      return;
    }

    if (Object.hasOwn(message, 'id')) {
      if (message.method && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) {
        this._declineServerRequest(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexAppServerError(message.error.message || 'Codex App Server RPC failed', {
        rpcResponse: true,
        rpcCode: message.error.code,
        rpcData: message.error.data,
      }));
      else pending.resolve(message.result || {});
      return;
    }

    if (!message.method) return;
    const params = message.params || {};
    if (message.method === 'turn/completed') {
      const run = this.runs.get(params.threadId);
      if (run && (!run.turnId || run.turnId === params.turn?.id)) {
        run.turnId ||= params.turn?.id || null;
        run.status = params.turn?.status || 'unknown';
        run.terminal = params.turn || {};
        clearTimeout(run.interruptTimer);
        this._emit(run, message);
        run.resolveTerminal?.(run.terminal);
      }
      return;
    }

    if (message.method === 'thread/tokenUsage/updated' && params.threadId && params.tokenUsage?.total) {
      this.threadTotals.set(params.threadId, params.tokenUsage.total);
      const owner = this.runs.get(params.threadId);
      if (owner && (!owner.turnId || owner.turnId === params.turnId)) owner.lastTotal = params.tokenUsage.total;
    }

    const run = this.runs.get(params.threadId);
    if (run) {
      if (message.method === 'turn/started' && params.turn?.id) {
        run.turnId = params.turn.id;
        if (run.abortRequested) this._interruptRun(run);
      }
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage') run.text = params.item.text || run.text;
      if (message.method === 'item/agentMessage/delta') run.text += params.delta || '';
      try { recordPermissionEvent(run.ctx, message.method, params); } catch (_) { /* Provenance capture is best effort. */ }
      this._emit(run, message);
    }
  }

  _declineServerRequest(message) {
    const { id, method, params = {} } = message;
    const threadKey = typeof params.threadId === 'string' ? params.threadId : params.conversationId;
    const owner = (typeof threadKey === 'string' ? this.runs.get(threadKey) : null)
      || (this.runs.size === 1 ? [...this.runs.values()][0] : null);
    const legacy = method === 'applyPatchApproval' || method === 'execCommandApproval';
    if (owner && (/requestApproval$/.test(method) || legacy)) {
      pushPermissionEvent(owner.ctx, { type: 'approval_request_declined', method, reason: 'client_declines_all' });
    }
    let result;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      result = { decision: 'decline' };
    } else if (legacy) {
      // Legacy ReviewDecision: the schema's decline is the `denied` variant.
      result = { decision: { denied: { rejection: 'Declined by client: approvals are not available' } } };
    } else if (method === 'item/permissions/requestApproval') {
      result = { permissions: {}, scope: 'turn' };
    } else if (method === 'mcpServer/elicitation/request') {
      result = { action: 'decline', content: null };
    } else if (method === 'item/tool/requestUserInput') {
      result = {
        answers: Object.fromEntries((params.questions || []).map((question) => [question.id, { answers: [] }])),
      };
    } else {
      this._write({ id, error: { code: -32000, message: 'Unsupported server request; denied by client' } });
      return;
    }
    this._write({ id, result });
  }

  _emit(run, event) {
    run.events.push(event);
    try { run.onEvent?.(event); } catch (_) { /* Event consumers cannot break protocol routing. */ }
  }

  _waitForTerminal(run) {
    if (run.terminal) return Promise.resolve(run.terminal);
    return new Promise((resolve, reject) => {
      run.resolveTerminal = resolve;
      let remainingMs = this.turnTimeoutMs;
      let timer;
      const onTimeout = () => {
        remainingMs -= Math.min(remainingMs, MAX_TIMER_DELAY_MS);
        if (remainingMs > 0) {
          timer = setTimeout(onTimeout, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
          timer.unref?.();
          return;
        }
        const error = new CodexAppServerError('Timed out waiting for Codex turn completion', {
          threadId: run.threadId,
          turnId: run.turnId,
          outcomeUnknown: true,
        });
        run.failSafeError = error;
        this._interruptRun(run);
        this._terminateProcess();
      };
      timer = setTimeout(onTimeout, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      timer.unref?.();
      const finish = run.resolveTerminal;
      run.resolveTerminal = (value) => { clearTimeout(timer); finish(value); };
      const cleanup = () => clearTimeout(timer);
      run.rejectTerminal = (error) => { cleanup(); reject(error); };
    });
  }

  _interruptRun(run) {
    if (!run.turnId || run.terminal || run.interruptSent) return;
    run.interruptSent = true;
    this._request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
    if (run.abortRequested) {
      // Wait a bounded time for the interrupt to be confirmed by turn/completed. If it is not,
      // terminate the shared child: this also interrupts every other concurrent turn on it (they
      // surface as outcomeUnknown; read-only ones are harmless) but proves this turn cannot mutate.
      run.interruptTimer = setTimeout(() => {
        if (run.terminal) return;
        run.failSafeError = abortError({ threadId: run.threadId, turnId: run.turnId, outcomeUnknown: true });
        this._terminateProcess();
      }, this.interruptTimeoutMs);
      run.interruptTimer.unref?.();
    }
  }

  /**
   * Signal the process group we spawned, never a group that merely shares its number.
   * - Leader alive with the spawn-time start time and pgid === pid: signal -pgid.
   * - Leader alive with another start time: the number was reused, do not signal.
   * - Leader absent: signal -pgid only if our child's exit was observed under 5 s ago (a pid
   *   cannot be reallocated while it is still a live PGID, so an answering group is ours).
   * - No start time (/proc unreadable at spawn): never signal by number.
   * The child handle is signalled whenever the group was not, since the handle cannot hit a stranger.
   * Returns true when the group was signalled.
   */
  _signalOwnGroup(identity, signal, { child = null, exitAt = null } = {}) {
    const viaHandle = () => {
      if (child && child.exitCode == null && child.signalCode == null) {
        try { child.kill(signal); } catch (_) { /* already gone */ }
      }
      return false;
    };
    if (!identity || identity.startTime == null || !Number.isInteger(identity.pid) || identity.pgid !== identity.pid) return viaHandle();
    const now = this.readProcessIdentityImpl(identity.pid);
    let own = false;
    if (now && now.startTime != null) {
      own = now.startTime === identity.startTime && now.pgid === identity.pid;
    } else {
      own = exitAt != null && Date.now() - exitAt < OWN_GROUP_EXIT_WINDOW_MS;
    }
    if (!own) return viaHandle();
    try {
      this.killImpl(-identity.pgid, signal);
      return true;
    } catch (error) {
      if (error && error.code === 'ESRCH') return false;
      return viaHandle();
    }
  }

  _delayedKill(child, identity, termination = null) {
    const exitAt = this.childExitTimes.get(child) ?? null;
    if (this._signalOwnGroup(identity, 'SIGKILL', { child, exitAt })) return;
    if (!identity || typeof identity.pid !== 'number') return;
    let survivors = [];
    try { survivors = this.listGroupMembersImpl(identity.pgid); } catch (_) { /* diagnostics only */ }
    const at = new Date().toISOString();
    // The record is shared with the errors of the runs this termination failed (their copies
    // hold the same object), so they learn what outlived it.
    const record = termination || { identity, survivors: [], at };
    record.survivors = survivors;
    record.at = at;
    this.lastTermination = record;
  }

  _terminateProcess() {
    const child = this.child;
    if (!child || this.terminatedChildren.has(child)) return;
    if (typeof child.pid !== 'number' && (child.exitCode != null || child.killed)) return;
    this.terminatedChildren.add(child);
    const identity = this.childIdentity;
    const termination = { identity, survivors: [], at: new Date().toISOString() };
    for (const run of this.runs.values()) {
      const error = run.failSafeError || this.exitError;
      if (error && error.outcomeUnknown) error.termination = termination;
    }
    this._signalOwnGroup(identity, 'SIGTERM', { child, exitAt: this.childExitTimes.get(child) ?? null });
    clearTimeout(this.forceKillTimer);
    // Not cleared on child exit: grandchildren in the group may outlive the leader.
    this.forceKillTimer = setTimeout(() => this._delayedKill(child, identity, termination), 1_000);
    this.forceKillTimer.unref?.();
  }

  // A failure that leaves the child running must not leave an outcomeUnknown run with a live group.
  _failAndTerminate(error) {
    const active = this.runs.size > 0;
    this._failAll(error);
    if (active) this._terminateProcess();
  }

  _failAll(error) {
    if (this.runs.size > 0) error.outcomeUnknown = true;
    this.exitError = error;
    this.startPromise = null;
    this.loadedThreads.clear();
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const run of this.runs.values()) run.rejectTerminal?.(run.failSafeError || error);
  }
}

function abortError(details = {}) {
  const error = new Error('Codex turn aborted');
  error.name = 'AbortError';
  Object.assign(error, details);
  return error;
}

function executionOf(ctx) {
  return {
    processIdentity: ctx.processIdentity,
    threadId: ctx.threadId,
    turnId: ctx.run?.turnId || ctx.turnId,
    turnStartSent: ctx.turnStartSent,
    turnStartRejected: ctx.turnStartRejected === true,
    turnTerminal: Boolean(ctx.run?.terminal),
  };
}

const SECRET_PATTERNS = [
  [/(authorization\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
];

function redact(text) {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function clean(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return value == null ? null : String(value).slice(0, max);
  const text = redact(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function pushPermissionEvent(ctx, event) {
  if (ctx?.permissionEvents && ctx.permissionEvents.length < MAX_PERMISSION_EVENTS) ctx.permissionEvents.push(event);
}

function hookRecord(run) {
  return {
    type: 'hook',
    eventName: clean(run.eventName),
    status: clean(run.status),
    source: clean(run.source),
    sourcePath: clean(run.sourcePath),
    hookId: clean(run.id),
    displayOrder: run.displayOrder == null ? null : Number(run.displayOrder),
    statusMessage: clean(run.statusMessage),
    entries: (Array.isArray(run.entries) ? run.entries : []).slice(0, 10)
      .map((entry) => ({ kind: clean(entry?.kind), text: clean(entry?.text) })),
  };
}

function recordPermissionEvent(ctx, method, params) {
  if (!ctx) return;
  if (method === 'hook/started' && params.run?.id) {
    ctx.pendingHooks.set(params.run.id, hookRecord(params.run));
  } else if (method === 'hook/completed' && params.run) {
    const hookRun = params.run;
    ctx.pendingHooks.delete(hookRun.id);
    const entries = Array.isArray(hookRun.entries) ? hookRun.entries : [];
    const notable = entries.some((entry) => ['stop', 'feedback', 'error'].includes(entry?.kind));
    if (hookRun.status !== 'completed' || (hookRun.eventName === 'preToolUse' && notable)) {
      pushPermissionEvent(ctx, hookRecord(hookRun));
    }
  } else if (method === 'item/completed' && params.item) {
    const item = params.item;
    if (item.type !== 'commandExecution' && item.type !== 'fileChange') return;
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    const blockedByHook = output.startsWith(HOOK_BLOCK_PREFIX);
    if (!blockedByHook && item.status !== 'declined' && item.status !== 'failed') return;
    // A failed command is a permission event only when a hook blocked it or the sandbox refused
    // it; an ordinary non-zero exit (e.g. rg with no match) is not a denial. Declined items stay.
    if (!blockedByHook && item.status === 'failed' && item.type === 'commandExecution' && !SANDBOX_DENIAL_PATTERN.test(output)) return;
    const event = { type: 'tool', tool: item.type, status: clean(item.status) };
    if (item.type === 'commandExecution') {
      event.command = clean(item.command, MAX_COMMAND_CHARS);
      event.cwd = clean(item.cwd);
    } else {
      event.paths = (Array.isArray(item.changes) ? item.changes : []).slice(0, 20).map((change) => clean(change?.path));
    }
    event.blockedByHook = blockedByHook;
    event.denial = blockedByHook || item.status === 'declined' || item.status === 'failed';
    event.reasonText = output ? clean(output) : null;
    pushPermissionEvent(ctx, event);
  } else if (method === 'item/autoApprovalReview/completed' && params.review && params.review.status !== 'approved') {
    pushPermissionEvent(ctx, {
      type: 'approval_review',
      status: clean(params.review.status),
      riskLevel: clean(params.review.riskLevel),
      rationale: clean(params.review.rationale),
      decisionSource: clean(params.decisionSource),
      targetItemId: clean(params.targetItemId),
    });
  }
}

function permissionOf(ctx) {
  const events = [...ctx.permissionEvents];
  // Hooks that started but never reported completion are still worth attributing.
  for (const record of ctx.pendingHooks.values()) {
    if (events.length >= MAX_PERMISSION_EVENTS) break;
    events.push(record);
  }
  return { permissionEvents: events, permissionConfig: { ...ctx.permissionConfig } };
}

function sanitizeHook(hook) {
  const safe = {
    key: clean(hook.key),
    eventName: hook.eventName ?? null,
    matcher: clean(hook.matcher),
    sourcePath: clean(hook.sourcePath),
    source: clean(hook.source),
    enabled: Boolean(hook.enabled),
    trustStatus: clean(hook.trustStatus),
  };
  if (typeof hook.command === 'string') safe.command = clean(hook.command, MAX_HOOK_COMMAND_CHARS);
  return safe;
}

function cloneError(error) {
  if (!error || typeof error !== 'object') return error;
  return Object.create(Object.getPrototypeOf(error), Object.getOwnPropertyDescriptors(error));
}

function normalizeSandbox(sandbox) {
  if (['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) return sandbox;
  return 'workspace-write';
}

function sandboxPolicy(sandbox) {
  const normalized = normalizeSandbox(sandbox);
  if (normalized === 'read-only') return { type: 'readOnly' };
  if (normalized === 'danger-full-access') return { type: 'dangerFullAccess' };
  return { type: 'workspaceWrite' };
}

function sanitizeAccount(account) {
  if (!account || typeof account !== 'object') return null;
  const safe = {};
  for (const key of ['type', 'email', 'planType', 'usesCodexManagedCredentials']) {
    if (Object.hasOwn(account, key)) safe[key] = account[key];
  }
  return safe;
}

module.exports = { CodexAppServer, CodexAppServerError };
