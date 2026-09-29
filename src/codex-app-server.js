const { spawn } = require('node:child_process');
const readline = require('node:readline');

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

class CodexAppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CodexAppServerError';
    Object.assign(this, details);
  }
}

class CodexAppServer {
  constructor({ codexPath = 'codex', spawnImpl = spawn, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.codexPath = codexPath;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.runs = new Map();
    this.startPromise = null;
    this.closed = false;
    this.exitError = null;
  }

  async start() {
    if (this.closed) throw new CodexAppServerError('Codex App Server client is closed');
    if (this.exitError) throw this.exitError;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._start();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async _start() {
    const child = this.spawnImpl(this.codexPath, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;
    this.closed = false;
    this.exitError = null;

    child.stdout.on('error', (error) => this._failAll(new CodexAppServerError('Codex App Server stdout failed', { cause: error })));
    child.stdin.on('error', (error) => this._failAll(new CodexAppServerError('Codex App Server stdin failed', { cause: error })));
    child.on('error', (error) => this._failAll(new CodexAppServerError('Could not start Codex App Server', { cause: error })));
    child.on('exit', (code, signal) => {
      if (!this.closed) {
        const error = new CodexAppServerError(`Codex App Server exited unexpectedly (${signal || code})`, { code, signal });
        this.exitError = error;
        this._failAll(error);
      }
    });

    this.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this._handleLine(line));
    this.reader.on('close', () => {
      if (!this.closed && !this.exitError) this._failAll(new CodexAppServerError('Codex App Server stdout closed unexpectedly'));
    });

    await this._request('initialize', {
      clientInfo: { name: 'codex-a2a-runtime', title: 'Codex A2A Runtime', version: '0.1.0' },
    });
    this._notify('initialized', {});
  }

  async getAccount() {
    await this.start();
    const result = await this._request('account/read', {});
    return {
      account: sanitizeAccount(result.account),
      requiresOpenaiAuth: Boolean(result.requiresOpenaiAuth),
    };
  }

  async run({ role, cwd, input, onEvent, signal, threadId: existingThreadId, outputSchema } = {}) {
    if (!role || !role.name) throw new TypeError('role.name is required');
    if (!cwd) throw new TypeError('cwd is required');
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input must be a non-empty string');
    if (signal?.aborted) throw abortError();
    await this.start();

    const threadResult = existingThreadId ? null : await this._request('thread/start', {
      model: role.model || null,
      cwd,
      developerInstructions: role.instructions || `You are the ${role.name} agent.`,
      sandbox: normalizeSandbox(role.sandbox),
      approvalPolicy: 'on-request',
    }, { signal });

    const threadId = existingThreadId || threadResult?.thread?.id;
    if (!threadId) throw new CodexAppServerError('Codex App Server did not return a thread ID');
    if (this.runs.has(threadId)) {
      throw new CodexAppServerError(`A Codex turn is already active for thread ${threadId}`, { threadId });
    }

    const run = { threadId, turnId: null, status: null, text: '', events: [], onEvent, terminal: null };
    run.abortRequested = false;
    run.interruptSent = false;
    this.runs.set(threadId, run);
    const abortHandler = () => {
      run.abortRequested = true;
      this._interruptRun(run);
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      if (signal?.aborted) throw abortError();
      const turnResult = await this._request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input }],
        ...(role.model ? { model: role.model } : {}),
        ...(role.effort ? { effort: role.effort } : {}),
        cwd,
        sandboxPolicy: sandboxPolicy(role.sandbox),
        approvalPolicy: 'on-request',
        ...(outputSchema ? { outputSchema } : {}),
      });

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
      if (run.abortRequested && error.name !== 'AbortError') {
        throw abortError({ threadId, turnId: run.turnId, cause: error });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      this.runs.delete(threadId);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.reader?.close();
    this._failAll(new CodexAppServerError('Codex App Server client closed'));
    if (this.child && this.child.exitCode == null && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
    this.startPromise = null;
  }

  _request(method, params, { signal, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child || this.closed || this.exitError) return Promise.reject(this.exitError || new CodexAppServerError('Codex App Server is not running'));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new CodexAppServerError(`Codex App Server request timed out: ${method}`, { method, id });
        if (method === 'turn/start') {
          const run = this.runs.get(params.threadId);
          if (run) {
            run.failSafeError = error;
            this._terminateProcess();
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
      this._failAll(new CodexAppServerError('Codex App Server sent invalid JSONL', { cause: error }));
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
        this._emit(run, message);
        run.resolveTerminal?.(run.terminal);
      }
      return;
    }

    const run = this.runs.get(params.threadId);
    if (run) {
      if (message.method === 'turn/started' && params.turn?.id) {
        run.turnId = params.turn.id;
        if (run.abortRequested) this._interruptRun(run);
      }
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage') run.text = params.item.text || run.text;
      if (message.method === 'item/agentMessage/delta') run.text += params.delta || '';
      this._emit(run, message);
    }
  }

  _declineServerRequest(message) {
    const { id, method, params = {} } = message;
    let result;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      result = { decision: 'decline' };
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
      const timer = setTimeout(() => {
        const error = new CodexAppServerError('Timed out waiting for Codex turn completion', {
          threadId: run.threadId,
          turnId: run.turnId,
        });
        run.failSafeError = error;
        this._interruptRun(run);
        this._terminateProcess();
      }, this.requestTimeoutMs);
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
  }

  _terminateProcess() {
    const child = this.child;
    if (!child || child.exitCode != null || child.killed) return;
    child.kill('SIGTERM');
    clearTimeout(this.forceKillTimer);
    this.forceKillTimer = setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    }, 1_000);
    this.forceKillTimer.unref?.();
  }

  _failAll(error) {
    this.exitError = error;
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      this.pending.delete(id);
    }
    clearTimeout(this.forceKillTimer);
    for (const run of this.runs.values()) run.rejectTerminal?.(run.failSafeError || error);
  }
}

function abortError() {
  const error = new Error('Codex turn aborted');
  error.name = 'AbortError';
  return error;
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
