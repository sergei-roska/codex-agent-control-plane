const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { readProcessIdentity, listGroupMembers } = require('./process-quiescence');
const { classifyCodexError } = require('./contracts');
const { DEFAULT_SKILLS_ROOT } = require('./skill-catalog');
const { loadMcpCatalog, resolveMcpToolSelection, mcpToolPins } = require('./mcp-catalog');
const { withConnectors, resolveConnectorToolSelection, resolveManagedToolSelection } = require('./connector-catalog');
const { readConnectorPreferences } = require('./connector-preferences');
const {
  READ_ONLY_PROFILE, WORKSPACE_PROFILE, DANGER_FULL_ACCESS_PROFILE, resolveExecutionPermissions, nativeSandboxPolicy, withVerifierIpcNetworkAccess, scopedVerifierSandboxPolicy,
} = require('./execution-permissions');
const { canonicalRoleId } = require('./role-names');
const { normalizeModelCapability, resolveServiceTierForTurn } = require('./model-capabilities');
const { scopedExecutionDetails } = require('./delivery-role-capabilities');
const { stableDigest } = require('./backlog-store');
const { isLaneExecutionCapability, resolveLaneExecutionPolicy } = require('./lane-execution-policy');

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;
const MCP_ENUMERATION_TIMEOUT_MS = 15_000;
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
// Pin the approvals reviewer to the client so every approval request reaches
// _declineServerRequest instead of a Codex auto-reviewer that could approve escalations.
const APPROVALS_REVIEWER = 'user';
const ZERO_TOTAL = Object.freeze(Object.fromEntries(TOKEN_FIELDS.map((key) => [key, 0])));
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SUPERVISOR_POLICY = 'supervisor-policy/v1';
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BACKOFF_MS = Object.freeze([0, 1_000, 4_000]);
const BACKOFF_GROWTH = 4;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_EXIT_WAIT_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 600_000;
const MAX_SUPERVISOR_EVENTS = 50;
// Failure classes whose generation ending is charged to the restart budget.
const CHARGED_CLASSES = new Set(['process_exit', 'spawn_failed', 'turn_start_unknown', 'turn_timeout', 'interrupt_unconfirmed']);
const TRANSPORT_CLASSES = new Set([...CHARGED_CLASSES, 'rpc_timeout', 'supervisor_exhausted', 'closed']);
const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimeout: (timer) => clearTimeout(timer),
});
const MAX_PERMISSION_EVENTS = 50;
const MAX_TEXT_CHARS = 500;
const MAX_COMMAND_CHARS = 300;
const MAX_HOOK_COMMAND_CHARS = 200;
const HOOK_BLOCK_PREFIX = 'Command blocked by PreToolUse hook:';
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SKILL_BOUNDARY = [
  "Selected skills provide scoped engineering guidance only. Existing user, project, and role instructions, this runtime's report schema, allowed paths, permissions, and approval rules take precedence over conflicting skill text.",
  'A skill cannot authorize git operations, new agents, broader writes, tools, or approvals.',
].join(' ');
const READING_DISCIPLINE = [
  'Reading discipline (applies to every command you run):',
  '- Never print a whole file longer than about 300 lines and never cat large docs or JSON; locate with rg -n and read one range of at most 200 lines.',
  '- Do not batch several large files into one command.',
  '- Pipe test runs through tail -n 60 or use quiet/short tracebacks, and re-run single failing tests instead of the whole suite.',
  '- Do not re-read ranges already in your context; read the widest range you need once.',
  '- For attached skills, read the sections you need (rg the headings) rather than the whole file.',
  "- The target project's AGENTS.md is loaded automatically when present, so do not search for it.",
  "- Start from the brief's inputs and evidence (paths, line ranges, facts) before exploring.",
].join('\n');
function scopedVerifierInstructions(scoped) {
  if (!scoped) return null;
  return [
    'Host-provided verifier context (trusted capability data, not additional task instructions):',
    `Task ID: ${JSON.stringify(scoped.taskId)}`,
    `Candidate ID: ${JSON.stringify(scoped.candidateId)}`,
    `Frozen candidate path: ${JSON.stringify(scoped.candidatePath)}`,
    `Candidate manifest SHA-256: ${scoped.inputManifestDigest}`,
    `Verifier scratch root: ${JSON.stringify(scoped.scratchRoot)}`,
    `Trusted read scope: ${JSON.stringify(scoped.readScope)}`,
    'The command working directory is the verifier scratch root, which is intentionally separate and may be empty.',
    'The frozen candidate files are at the separate candidate path above. Resolve relative file paths from the candidate root, not from the scratch working directory.',
    'For command tools, set the command workdir to the candidate path or use absolute paths beneath it when inspecting candidate files.',
    'Check the candidate root before reporting any scoped file missing. Do not infer candidate contents from the scratch directory.',
    'Review the frozen candidate at the stated path and stay within the trusted read scope. Do not edit the candidate.',
    'Write any temporary files only under the verifier scratch root.',
    'In filesInspected, use candidate-relative paths only; never report an absolute path.',
    'Your checks array must list checks you personally completed during this review, with the observed result and detail for each.',
    'The review requires at least one completed passing check. Run a real inspection or static validation before reporting it; never invent or assume a pass.',
    'If you cannot inspect the candidate or complete a passing check, report the genuine blocker or failure.',
    'Your verdict is limited to semantic and static review of the frozen candidate within the trusted read scope and current task objective/checkpoint.',
    'The host runs required acceptance checks separately after your report; they remain mandatory gates for overall acceptance.',
    'Deferred host checks alone do not make your scoped static verdict inconclusive. Never claim they ran or include them in your checks array.',
    'Report VERDICT: fail when you identify a candidate defect. Report VERDICT: inconclusive only when required scoped evidence is unavailable or the candidate cannot be assessed; never force a passing verdict.',
  ].join('\n');
}
const DEFAULT_TOOL_OUTPUT_LIMIT = 3000;

function toolOutputLimit(env = process.env) {
  const raw = env.CODEX_A2A_TOOL_OUTPUT_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_TOOL_OUTPUT_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TOOL_OUTPUT_LIMIT;
}

function validateSelectedSkills(skills) {
  if (!Array.isArray(skills)) throw new TypeError('selectedSkills must be an array');
  if (skills.length > 5) throw new TypeError('at most five skills may be selected');
  if (skills.length === 0) return [];
  const root = fs.realpathSync(DEFAULT_SKILLS_ROOT);
  const seen = new Set();
  return skills.map((skill) => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)
      || typeof skill.id !== 'string' || !SKILL_ID_PATTERN.test(skill.id)
      || typeof skill.name !== 'string' || skill.name !== skill.id
      || typeof skill.path !== 'string' || !path.isAbsolute(skill.path)
      || typeof skill.sha256 !== 'string' || !SKILL_HASH_PATTERN.test(skill.sha256)) {
      throw new TypeError('selectedSkills entries must contain a valid id, name, absolute path, and SHA-256 hash');
    }
    if (seen.has(skill.id)) throw new TypeError('selectedSkills ids must be unique');
    seen.add(skill.id);
    const stat = fs.lstatSync(skill.path);
    const canonical = fs.realpathSync(skill.path);
    const relative = path.relative(root, canonical);
    if (!stat.isFile() || stat.isSymbolicLink() || canonical !== skill.path
      || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
      || path.basename(canonical) !== 'SKILL.md' || path.basename(path.dirname(canonical)) !== skill.id) {
      throw new TypeError(`selected skill path is not a canonical catalog skill: ${skill.id}`);
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(canonical)).digest('hex');
    if (hash !== skill.sha256) throw new TypeError(`selected skill file hash changed: ${skill.id}`);
    return { id: skill.id, name: skill.name, path: canonical, sha256: hash };
  });
}

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

/**
 * Deterministic failure class (supervisor-policy/v1) for an error seen by the client.
 * Returns null for a plain abort that carries no class.
 */
function classifyFailure(error) {
  if (!error || typeof error !== 'object') return 'request_rejected';
  if (TRANSPORT_CLASSES.has(error.failureClass)) return error.failureClass;
  if (classifyCodexError(error) === 'usage_limit') return 'usage_limit';
  if (error.failureClass) return error.failureClass;
  if (error.name === 'AbortError') return null;
  if (error.codexError || error.status === 'failed') return 'domain_failure';
  return 'request_rejected';
}

// A group id still answering right after our leader exited is our own group (the kernel does not
// reuse a pid while it is a live PGID); a pid wrap inside this window is not realistic.
const OWN_GROUP_EXIT_WINDOW_MS = 5_000;
const BACKGROUND_TERMINAL_CLEANUP_TIMEOUT_MS = 5_000;
const SANDBOX_DENIAL_PATTERN = /Read-only file system|Operation not permitted|Permission denied/i;

class CodexAppServer {
  constructor({
    codexPath = 'codex',
    spawnImpl = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    turnTimeoutMs = resolveTurnTimeoutMs(),
    interruptTimeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS,
    backgroundTerminalCleanupTimeoutMs = BACKGROUND_TERMINAL_CLEANUP_TIMEOUT_MS,
    killImpl = process.kill.bind(process),
    readProcessIdentityImpl = readProcessIdentity,
    listGroupMembersImpl = listGroupMembers,
    clock = DEFAULT_CLOCK,
    maxRestarts = DEFAULT_MAX_RESTARTS,
    windowMs = DEFAULT_WINDOW_MS,
    backoffMs = DEFAULT_BACKOFF_MS,
    exitWaitMs = DEFAULT_EXIT_WAIT_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    codexHome = null,
    connectorPreferencesFile = null,
    mcpCatalog = loadMcpCatalog(),
  } = {}) {
    if (!Number.isSafeInteger(backgroundTerminalCleanupTimeoutMs) || backgroundTerminalCleanupTimeoutMs <= 0) {
      throw new TypeError('backgroundTerminalCleanupTimeoutMs must be a positive safe integer');
    }
    this.codexPath = codexPath;
    this.codexHome = codexHome || null;
    this.connectorPreferencesFile = connectorPreferencesFile;
    this.mcpCatalog = mcpCatalog;
    this.notificationHandlers = new Map();
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnTimeoutMs = resolveTurnTimeoutMs(turnTimeoutMs);
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.backgroundTerminalCleanupTimeoutMs = backgroundTerminalCleanupTimeoutMs;
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
    this.startPending = false;
    this.closed = false;
    this.exitError = null;
    this.loadedThreads = new Set();
    this.threadMcpPolicies = new Map();
    this.threadExecutionPolicies = new Map();
    this.generation = 0;
    this.failedGeneration = 0;
    this.backgroundTerminalCleanupFailure = null;
    this.childExited = true;
    this.childExitPromise = null;
    this.resolveChildExit = null;
    this.childStates = new WeakMap();
    this.currentChildState = null;
    this.hookInventories = new Map();
    this.mcpInventories = new Map();
    this.configReads = new Map();
    this.clock = { ...DEFAULT_CLOCK, ...clock };
    this.policy = { maxRestarts, windowMs, backoffMs: [...backoffMs], exitWaitMs, cooldownMs };
    this.supState = 'stopped';
    this.charged = [];
    this.chargedGeneration = 0;
    this.currentCooldownMs = cooldownMs;
    this.nextStartAt = null;
    this.nextProbeAt = null;
    this.probing = false;
    this.exhaustedClasses = [];
    this.supEvents = [];
    this.sleepCancel = null;
    this.activeTermination = null;
  }

  async start() {
    if (this.closed) throw new CodexAppServerError('Codex App Server client is closed', { failureClass: 'closed' });
    if (this.startPending) return this.startPromise;
    if (this.child && !this.childExited && !this.exitError) return;
    if (this.supState === 'exhausted' && this.clock.now() < this.nextProbeAt) throw this._exhaustedError();

    let startPromise;
    startPromise = Promise.resolve().then(() => this._startWhenReady()).then((value) => {
      if (this.startPromise === startPromise) {
        this.startPending = false;
        this.startPromise = null;
      }
      return value;
    }, (error) => {
      if (error && typeof error === 'object') {
        if (!error.failureClass) error.failureClass = this.closed ? 'closed' : 'spawn_failed';
        if (error.failureClass === 'spawn_failed' && error.outcomeUnknown === undefined) error.outcomeUnknown = false;
        error.generation ??= this.generation;
      }
      if (this.supState === 'starting' && !this.closed) this._pushEvent('start_failed', error.failureClass, error.message);
      const ownsStart = this.startPromise === startPromise;
      if (ownsStart && !this.exitError) this._failAll(error);
      if (ownsStart && this.exitError && this.child && !this.childExited) this._terminateProcess(this.exitError.failureClass);
      if (ownsStart) {
        this.startPending = false;
        this.startPromise = null;
      }
      throw error;
    });
    this.startPromise = startPromise;
    this.startPending = true;
    return startPromise;
  }

  async _startWhenReady() {
    const closedError = () => new CodexAppServerError('Codex App Server client is closed', { failureClass: 'closed' });
    if (this.closed) throw closedError();
    if (this.supState === 'exhausted') {
      if (this.clock.now() < this.nextProbeAt) throw this._exhaustedError();
      this.probing = true;
      this._pushEvent('probe', null, `cooldown ${this.currentCooldownMs}ms elapsed`);
    }
    this.supState = 'starting';
    if (this.exitError && this.child && !this.childExited) {
      await this._waitForOldExit();
    }
    if (this.closed) throw closedError();
    if (this.exitError) this._discardFailedChild();
    if (!this.probing) {
      const delay = this._backoffDelay();
      if (delay > 0) {
        this.supState = 'backoff';
        this.nextStartAt = this.clock.now() + delay;
        this._pushEvent('backoff', null, `waiting ${delay}ms before the next spawn`);
        await this._sleep(delay);
        this.nextStartAt = null;
        if (this.closed) throw closedError();
        this.supState = 'starting';
      }
    }
    return this._start();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => { this.sleepCancel = null; resolve(); }, ms);
      this.sleepCancel = () => { this.clock.clearTimeout(timer); this.sleepCancel = null; resolve(); };
    });
  }

  // Wait for the terminated leader, bounded by exitWaitMs; an unreaped leader is recorded and bypassed.
  async _waitForOldExit() {
    const state = this.currentChildState;
    if (!state || state.exited) return;
    const exitWait = this._beginExitWait(state.child, state.generation, state.identity);
    this._terminateProcess(state.failure?.failureClass || this.exitError?.failureClass, state.generation);
    await Promise.race([state.exitPromise, exitWait]);
  }

  _beginExitWait(child, generation, identity = this.childIdentity) {
    const state = this.childStates.get(child);
    if (!state || state.generation !== generation) return Promise.resolve();
    if (state.exitWait) return state.exitWait.promise;
    let resolve;
    const record = { promise: new Promise((done) => { resolve = done; }), resolve, timer: null, expired: false };
    record.resolve = resolve;
    state.exitWait = record;
    record.timer = this.clock.setTimeout(() => {
      record.timer = null;
      if (!state.exited) {
        record.expired = true;
        let survivors = [];
        try { if (identity && typeof identity.pgid === 'number') survivors = this.listGroupMembersImpl(identity.pgid); } catch (_) { /* diagnostics only */ }
        this._pushEvent('unreaped', null, `old leader did not exit within ${this.policy.exitWaitMs}ms`, survivors, generation);
      }
      record.resolve();
    }, this.policy.exitWaitMs);
    record.timer.unref?.();
    return record.promise;
  }

  _chargedInWindow() {
    const floor = this.clock.now() - this.policy.windowMs;
    this.charged = this.charged.filter((entry) => entry.at > floor);
    return this.charged.length;
  }

  _backoffDelay() {
    const count = this._chargedInWindow();
    if (count === 0) return 0;
    const table = this.policy.backoffMs;
    const delay = count <= table.length
      ? table[count - 1]
      : Math.min(MAX_BACKOFF_MS, table[table.length - 1] * (BACKOFF_GROWTH ** (count - table.length)));
    const remaining = this.charged[count - 1].at + delay - this.clock.now();
    return Math.max(0, remaining);
  }

  _pushEvent(kind, failureClass = null, detail = null, survivors = null, generation = this.generation) {
    this.supEvents.push({
      at: new Date(this.clock.now()).toISOString(),
      generation,
      kind,
      class: failureClass,
      detail,
      survivors,
    });
    if (this.supEvents.length > MAX_SUPERVISOR_EVENTS) this.supEvents.splice(0, this.supEvents.length - MAX_SUPERVISOR_EVENTS);
  }

  // Charge a failed generation to the restart budget (once per generation); never for close().
  _charge(failureClass) {
    if (this.closed || !CHARGED_CLASSES.has(failureClass) || this.chargedGeneration === this.generation) return;
    this.chargedGeneration = this.generation;
    const now = this.clock.now();
    this._chargedInWindow();
    this.charged.push({ at: now, failureClass, generation: this.generation });
    if (this.probing || this.charged.length > this.policy.maxRestarts) {
      if (this.probing) this.currentCooldownMs = Math.min(this.currentCooldownMs * 2, MAX_COOLDOWN_MS);
      this.probing = false;
      this.supState = 'exhausted';
      this.nextProbeAt = now + this.currentCooldownMs;
      this.exhaustedClasses = this.charged.map((entry) => entry.failureClass);
      this._pushEvent('exhausted', failureClass, `${this.charged.length} charged endings in ${this.policy.windowMs}ms; next probe at ${new Date(this.nextProbeAt).toISOString()}`);
    } else if (this.supState !== 'backoff') {
      this.supState = 'stopped';
    }
  }

  _exhaustedError() {
    const nextProbeAt = new Date(this.nextProbeAt).toISOString();
    return new CodexAppServerError(
      `Codex App Server restart budget exhausted (last failures: ${this.exhaustedClasses.join(', ') || 'unknown'}); next probe at ${nextProbeAt}`,
      { code: 'supervisor_exhausted', failureClass: 'supervisor_exhausted', outcomeUnknown: false, generation: this.generation, nextProbeAt },
    );
  }

  supervisorState() {
    return {
      policy: SUPERVISOR_POLICY,
      state: this.supState,
      generation: this.generation,
      chargedInWindow: this._chargedInWindow(),
      nextStartAt: this.nextStartAt == null ? null : new Date(this.nextStartAt).toISOString(),
      nextProbeAt: this.supState === 'exhausted' && this.nextProbeAt != null ? new Date(this.nextProbeAt).toISOString() : null,
      events: this.supEvents.map((event) => ({ ...event, survivors: event.survivors ? [...event.survivors] : event.survivors })),
    };
  }

  // Operator/test reset: clears the window, the cooldown, and exhaustion.
  resetSupervisor() {
    this.charged = [];
    this.chargedGeneration = 0;
    this.currentCooldownMs = this.policy.cooldownMs;
    this.nextProbeAt = null;
    this.probing = false;
    this.exhaustedClasses = [];
    if (this.supState === 'exhausted') this.supState = this.child && !this.childExited && !this.exitError ? 'running' : 'stopped';
    this._pushEvent('reset');
  }

  async _start() {
    const spawnedMs = performance.now();
    this.startupInfo = null;
    const generation = ++this.generation;
    this.backgroundTerminalCleanupFailure = null;
    this.activeTermination = null;
    this._pushEvent('started');
    const child = this.spawnImpl(this.codexPath, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      // Own process group, so the whole tree can be signalled and proven gone.
      detached: true,
      ...(this.codexHome ? { env: { ...process.env, CODEX_HOME: this.codexHome } } : {}),
    });
    this.child = child;
    this.closed = false;
    this.exitError = null;
    this.loadedThreads = new Set();
    this.threadExecutionPolicies = new Map();
    this.threadTotals = new Map();
    this.hookInventories = new Map();
    this.mcpInventories = new Map();
    this.configReads = new Map();
    const identity = typeof child.pid === 'number' ? this.readProcessIdentityImpl(child.pid) : null;
    const state = {
      child,
      generation,
      identity,
      exited: false,
      failed: false,
      failure: null,
      termination: null,
      exitWait: null,
      forceKillTimer: null,
      reader: null,
    };
    state.exitPromise = new Promise((resolve) => { state.resolveExit = resolve; });
    this.childStates.set(child, state);
    this.currentChildState = state;
    this.childIdentity = identity;
    this.childExitAt = null;
    this.childExited = false;
    this.childExitPromise = new Promise((resolve) => { this.resolveChildExit = resolve; });

    child.stdout.on('error', (error) => {
      if (this._isCurrentChild(child, generation) && !state.failed) this._failAndTerminate(new CodexAppServerError('Codex App Server stdout failed', { cause: error, failureClass: 'process_exit', generation }));
    });
    child.stdin.on('error', (error) => {
      if (this._isCurrentChild(child, generation) && !state.failed) this._failAndTerminate(new CodexAppServerError('Codex App Server stdin failed', { cause: error, failureClass: 'process_exit', generation }));
    });
    child.on('error', (error) => {
      if (this._isCurrentChild(child, generation) && !state.failed) {
        this._failAll(new CodexAppServerError('Could not start Codex App Server', { cause: error, failureClass: this.supState === 'starting' ? 'spawn_failed' : 'process_exit', generation }));
      }
    });
    child.on('exit', (code, signal) => {
      const exitAt = this.clock.now();
      this.childExitTimes.set(child, exitAt);
      if (this._isCurrentChild(child, generation)) this.childExitAt = exitAt;
      this._markChildExited(child, generation);
      // The leader is gone; make sure no member of its group outlives it (also after close()).
      const signalled = this._signalOwnGroup(identity, 'SIGKILL', { child, exitAt });
      if (!this.closed) {
        const failureClass = state.failure?.failureClass && CHARGED_CLASSES.has(state.failure.failureClass) ? state.failure.failureClass : 'process_exit';
        let survivors = state.termination?.survivors || [];
        if (!this.terminatedChildren.has(child)) {
          // Same record _delayedKill keeps: the group was not ours to signal, so list who is left.
          if (!signalled && identity && typeof identity.pid === 'number') {
            try { survivors = this.listGroupMembersImpl(identity.pgid); } catch (_) { /* diagnostics only */ }
          }
          const termination = { identity, survivors, at: new Date(this.clock.now()).toISOString(), generation };
          state.termination = termination;
          if (this._isCurrentChild(child, generation)) {
            this.lastTermination = termination;
            this.activeTermination = termination;
          }
        } else if (this._isCurrentChild(child, generation)) {
          this.lastTermination = state.termination;
        }
        this._pushEvent('exited', failureClass, `exited (${signal || code})`, survivors, generation);
        if (this._isCurrentChild(child, generation) && !state.failed) {
          const error = new CodexAppServerError(`Codex App Server exited unexpectedly (${signal || code})`, { code, signal, failureClass, generation });
          this._failAll(error);
        }
      }
    });
    child.on('close', () => this._markChildExited(child, generation));

    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader = reader;
    state.reader = reader;
    reader.on('line', (line) => {
      if (this._isCurrentChild(child, generation)) this._handleLine(line);
    });
    reader.on('close', () => {
      if (this._isCurrentChild(child, generation) && !this.closed && !state.failed) {
        this._failAndTerminate(new CodexAppServerError('Codex App Server stdout closed unexpectedly', { failureClass: 'process_exit', generation }));
      }
    });

    const initResult = await this._request('initialize', {
      clientInfo: { name: 'codex-a2a-runtime', title: 'Codex A2A Runtime', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (state.failed || state.exited || this.exitError?.generation === generation) {
      throw state.failure || this.exitError || new CodexAppServerError('Codex App Server exited during initialization', { failureClass: 'process_exit', generation });
    }
    this.supState = 'running';
    if (this.probing) {
      this.probing = false;
      this.charged = [];
      this.currentCooldownMs = this.policy.cooldownMs;
      this.nextProbeAt = null;
      this.exhaustedClasses = [];
      this._pushEvent('recovered');
    }
    this.appServerVersion = typeof initResult?.userAgent === 'string' ? initResult.userAgent : null;
    this._notify('initialized', {});
    const readyMs = performance.now();
    // Spawn to initialize completion; the first run that started or waited on this process claims it.
    this.startupInfo = { startupMs: Math.round(readyMs - spawnedMs), readyMs, claimed: false };
  }

  processIdentity() {
    if (!this.child || this.childExited || !this.childIdentity) return null;
    return { ...this.childIdentity };
  }

  _isCurrentChild(child, generation) {
    return this.child === child && this.generation === generation;
  }

  _markChildExited(child, generation) {
    const state = this.childStates.get(child);
    if (!state || state.generation !== generation || state.exited) return;
    state.exited = true;
    if (state.exitWait?.timer) this.clock.clearTimeout(state.exitWait.timer);
    if (state.exitWait) {
      state.exitWait.timer = null;
      state.exitWait.resolve();
    }
    state.resolveExit?.();
    state.resolveExit = null;
    if (!this._isCurrentChild(child, generation)) return;
    this.childExited = true;
    this.resolveChildExit?.();
    this.resolveChildExit = null;
  }

  _discardFailedChild() {
    const state = this.currentChildState;
    if (!state || state.generation !== this.generation || !this.exitError) return;
    for (const [threadId, run] of this.runs) {
      if (run.ctx.generation !== state.generation) continue;
      if (!run.failedWith) run.failedWith = this._runError(run, this.exitError);
      run.rejectTerminal?.(run.failSafeError || run.failedWith);
      this.clock.clearTimeout(run.interruptTimer);
      this.runs.delete(threadId);
    }
    state.reader?.close();
    if (this.reader === state.reader) this.reader = null;
    this.child = null;
    this.childIdentity = null;
    this.exitError = null;
    this.childExited = true;
    this.childExitPromise = null;
    this.resolveChildExit = null;
    this.currentChildState = null;
  }

  async getAccount() {
    await this.start();
    const result = await this._request('account/read', {});
    return {
      account: sanitizeAccount(result.account),
      requiresOpenaiAuth: Boolean(result.requiresOpenaiAuth),
    };
  }

  async loginStart(params) {
    await this.start();
    return this._request('account/login/start', params);
  }

  async loginCancel(loginId) {
    await this.start();
    return this._request('account/login/cancel', { loginId });
  }

  async logout() {
    await this.start();
    return this._request('account/logout', {});
  }

  // Observes notifications that no run claims (for example account/login/completed).
  onNotification(method, handler) {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) this.notificationHandlers.set(method, handlers = new Set());
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }

  _dispatchNotification(message) {
    const handlers = this.notificationHandlers.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try { handler(message.params || {}, message); } catch (_) { /* Observers must not disturb the protocol loop. */ }
    }
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
    await this.start();
    const key = cwd || '';
    if (!this.hookInventories.has(key)) {
      const pending = this.listHooks(cwd);
      this.hookInventories.set(key, pending);
      pending.then((hooks) => { if (hooks === null && this.hookInventories.get(key) === pending) this.hookInventories.delete(key); });
    }
    return this.hookInventories.get(key);
  }

  // Names of MCP servers configured for a cwd, read without a model call or a thread.
  async readConfig(cwd) {
    await this.start();
    const key = cwd || '';
    if (!this.configReads.has(key)) {
      const pending = this._request('config/read', { cwd, includeLayers: false }, { timeoutMs: Math.min(this.requestTimeoutMs, MCP_ENUMERATION_TIMEOUT_MS) });
      this.configReads.set(key, pending);
      pending.catch(() => { if (this.configReads.get(key) === pending) this.configReads.delete(key); });
    }
    return this.configReads.get(key);
  }

  async resolveExecutionPermissions(cwd, requested = 'inherit', { fresh = false } = {}) {
    if (requested === 'strict') return resolveExecutionPermissions(this, cwd, requested);
    await this.start();
    if (fresh) this.configReads.delete(cwd || '');
    return resolveExecutionPermissions(this, cwd, requested);
  }

  async listMcpServerNames(cwd) {
    const result = await this.readConfig(cwd);
    const servers = result?.config?.mcp_servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      throw new CodexAppServerError('config/read returned no mcp_servers table');
    }
    return Object.keys(servers);
  }

  // Cached per child generation (the map is reset on every child start) and per cwd.
  async mcpInventory(cwd) {
    await this.start();
    const key = cwd || '';
    if (!this.mcpInventories.has(key)) {
      const pending = this.listMcpServerNames(cwd).then(
        (names) => ({ names }),
        (error) => ({ names: null, error: error?.message || String(error) }),
      );
      this.mcpInventories.set(key, pending);
      pending.then((entry) => { if (entry.names === null && this.mcpInventories.get(key) === pending) this.mcpInventories.delete(key); });
    }
    return this.mcpInventories.get(key);
  }

  // Fixed per-role tool surface: everything not declared in the role profile is off.
  async _toolPolicy(role, cwd, selectedMcpTools = []) {
    const allowed = [...new Set(role.tools?.mcpServers || [])];
    // Drupal tools keep their own resolver; harness connector tools go to the connector resolver.
    const connectors = withConnectors(this.mcpCatalog).connectorCatalog;
    const isConnector = ({ id }) => connectors.has(id);
    const selected = resolveMcpToolSelection(this.mcpCatalog,
      selectedMcpTools.filter((item) => !isConnector(item)).map(({ id }) => id),
      { allowedServers: allowed, pins: mcpToolPins(selectedMcpTools.filter((item) => !isConnector(item))) });
    const selectedConnector = resolveConnectorToolSelection(connectors,
      selectedMcpTools.filter(isConnector).map(({ id }) => id),
      { allowedServers: allowed, pins: mcpToolPins(selectedMcpTools.filter(isConnector)) });
    this._assertConnectorsEnabled(selectedConnector);
    const selectedByServer = new Map();
    for (const item of selected) {
      if (!selectedByServer.has(item.configName)) selectedByServer.set(item.configName, []);
      selectedByServer.get(item.configName).push(item.name);
    }
    const connectorByServer = new Map();
    for (const item of selectedConnector) {
      if (!connectorByServer.has(item.configName)) connectorByServer.set(item.configName, []);
      connectorByServer.get(item.configName).push(item.name);
    }
    const selectedNames = new Set([...selectedByServer.keys(), ...connectorByServer.keys()]);
    const skills = role.tools?.skills === true;
    const config = { 'features.apps': false, 'features.plugins': false, tool_output_token_limit: toolOutputLimit() };
    if (!skills) {
      config['skills.include_instructions'] = false;
      config['skills.bundled.enabled'] = false;
    }
    const policy = {
      mcpAllowed: [],
      mcpDisabled: [],
      mcpMissing: [],
      mcpSelectedTools: mcpToolPins([...selected, ...selectedConnector]),
      skills,
      apps: false,
      plugins: false,
      enforced: false,
      source: 'config/read',
    };
    const inventory = await this.mcpInventory(cwd);
    const configuredNames = new Set(inventory.names || []);
    if (inventory.names) {
      const known = new Set(inventory.names);
      policy.mcpAllowed = allowed.filter((name) => known.has(name) || selectedNames.has(name));
      policy.mcpMissing = allowed.filter((name) => !known.has(name) && !selectedNames.has(name));
      // P-39: a configured server stays on only when this assignment selected tools of it. That covers
      // servers outside the role's list, unselected Drupal and connector servers, and allowed servers
      // that are in no catalog (they must not keep every tool enabled).
      policy.mcpDisabled = inventory.names.filter((name) => !selectedNames.has(name));
      for (const name of policy.mcpDisabled) config[`mcp_servers.${name}.enabled`] = false;
      policy.enforced = true;
    } else {
      policy.mcpMissing = allowed;
      policy.reason = `MCP server enumeration failed: ${inventory.error}`;
      throw new CodexAppServerError('Cannot enforce the task-level MCP tool limit because MCP server enumeration failed', {
        failureClass: 'request_rejected',
      });
    }
    policy.mcpAllowed = [...new Set([...policy.mcpAllowed, ...selectedNames])];
    policy.mcpMissing = policy.mcpMissing.filter((name) => !selectedNames.has(name));
    for (const name of this.mcpCatalog.servers.keys()) {
      if (!selectedByServer.has(name) && configuredNames.has(name)) config[`mcp_servers.${name}.enabled`] = false;
    }
    for (const [name, toolNames] of selectedByServer) {
      const server = this.mcpCatalog.servers.get(name);
      if (!server || !allowed.includes(name)) throw new CodexAppServerError(`MCP server ${name} is not allowed for role ${role.name}`, { failureClass: 'request_rejected' });
      const autoload = path.join(server.absolutePackagePath, 'vendor', 'autoload.php');
      const entrypoint = path.join(server.absolutePackagePath, 'bin', 'server.php');
      if (!fs.existsSync(autoload)) throw new CodexAppServerError(`MCP dependencies are missing for ${name}; install the package dependencies first`, { failureClass: 'request_rejected' });
      if (!fs.existsSync(entrypoint)) throw new CodexAppServerError(`MCP entrypoint is missing for ${name}`, { failureClass: 'request_rejected' });
      config[`mcp_servers.${name}.command`] = 'php';
      config[`mcp_servers.${name}.args`] = [entrypoint];
      config[`mcp_servers.${name}.cwd`] = server.absolutePackagePath;
      config[`mcp_servers.${name}.env`] = { PROJECT_ROOT: cwd };
      config[`mcp_servers.${name}.enabled`] = true;
      config[`mcp_servers.${name}.required`] = true;
      config[`mcp_servers.${name}.enabled_tools`] = toolNames;
      config[`mcp_servers.${name}.disabled_tools`] = [];
    }
    // Connectors are remote and OAuth-backed: never required, so a missing sign-in cannot stop every turn.
    for (const [name, toolNames] of connectorByServer) {
      const server = connectors.servers.get(name);
      if (!server || !allowed.includes(name)) throw new CodexAppServerError(`MCP server ${name} is not allowed for role ${role.name}`, { failureClass: 'request_rejected' });
      config[`mcp_servers.${name}.url`] = server.url;
      config[`mcp_servers.${name}.enabled`] = true;
      config[`mcp_servers.${name}.required`] = false;
      config[`mcp_servers.${name}.enabled_tools`] = toolNames;
      config[`mcp_servers.${name}.disabled_tools`] = [];
    }
    return { config, policy };
  }

  _assertConnectorsEnabled(selectedConnectorTools) {
    if (!this.connectorPreferencesFile || selectedConnectorTools.length === 0) return;
    const disabled = new Set(readConnectorPreferences(this.connectorPreferencesFile).disabled);
    const names = [...new Set(selectedConnectorTools.map((item) => item.configName).filter((name) => disabled.has(name)))];
    if (names.length > 0) {
      throw new CodexAppServerError(`Connector${names.length === 1 ? '' : 's'} disabled for agent use: ${names.join(', ')}`, {
        failureClass: 'request_rejected', code: 'connector_disabled', connectors: names,
      });
    }
  }

  async mcpServerStatus(threadId) {
    await this.start();
    const result = await this._request('mcpServerStatus/list', { threadId, detail: 'full' });
    return Array.isArray(result?.data) ? result.data : [];
  }

  // Auth state of one configured MCP server. Needs no thread: with serverName only that server is probed.
  async mcpServerAuthStatus(serverName) {
    await this.start();
    const result = await this._request('mcpServerStatus/list', { serverName, detail: 'toolsAndAuthOnly' });
    return Array.isArray(result?.data) ? result.data : [];
  }

  // Starts a browser OAuth sign-in for a configured MCP server and returns { authorizationUrl, loginId }.
  // The sign-in completes (mcpServer/oauthLogin/completed) only while this app-server process stays alive.
  async mcpOauthLoginStart(name, { timeoutSecs } = {}) {
    await this.start();
    return this._request('mcpServer/oauth/login', { name, ...(timeoutSecs ? { timeoutSecs } : {}) });
  }

  async readRateLimits() {
    try {
      await this.start();
      return await this._request('account/rateLimits/read', {});
    } catch (_) {
      return null;
    }
  }

  async listModels() {
    await this.start();
    const result = await this._request('model/list', { includeHidden: false });
    return Array.isArray(result?.data) ? result.data.map(normalizeModelCapability).filter((model) => typeof model.id === 'string') : [];
  }

  async startAccountUsageWindow() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-handshake-'));
    try {
      const result = await this.run({
        role: {
          name: 'account-handshake',
          model: 'gpt-6.1-sol',
          effort: 'low',
          sandbox: 'read-only',
          instructions: 'Reply with exactly OK. Do not use tools.',
          tools: { mcpServers: [], skills: false },
        },
        cwd,
        input: 'Reply OK.',
        selectedSkills: [],
        selectedMcpTools: [],
        executionPermissions: 'strict',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        ephemeral: true,
      });
      if (result.status !== 'completed') throw new CodexAppServerError('Handshake turn did not complete', { status: result.status });
      return result;
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  async prepareThread({ role, cwd, permissionWorkspace = cwd, selectedSkills = [], selectedMcpTools = [], executionPermissions = 'inherit', sandboxPolicy: sandboxPolicyOverride = null, ephemeral = false } = {}) {
    if (!role || !role.name) throw new TypeError('role.name is required');
    if (!cwd) throw new TypeError('cwd is required');
    const validatedSkills = validateSelectedSkills(selectedSkills);
    const validatedMcpTools = resolveManagedToolSelection(this.mcpCatalog,
      selectedMcpTools.map((item) => item?.id),
      { allowedServers: role.tools?.mcpServers || [], pins: mcpToolPins(selectedMcpTools) });
    const connectorCatalog = withConnectors(this.mcpCatalog).connectorCatalog;
    this._assertConnectorsEnabled(validatedMcpTools.filter(({ id }) => connectorCatalog.has(id)));
    const permissionMode = await this.resolveExecutionPermissions(permissionWorkspace, executionPermissions,
      { fresh: executionPermissions === 'full-access' });
    assertFullAccessPermissionMode(executionPermissions, permissionMode);
    const fullAccess = permissionMode.mode === 'full-access';
    const verifierRole = canonicalRoleId(role.id || role.name) === 'verifier';
    const laneCapability = isLaneExecutionCapability(sandboxPolicyOverride) ? sandboxPolicyOverride : null;
    if (legacyNativeWorkspaceWrite(permissionMode) && sandboxPolicyOverride != null && !laneCapability) {
      throw new CodexAppServerError('Native workspace-write lane policy requires a host-owned capability', { failureClass: 'request_rejected' });
    }
    const laneExecution = laneCapability
      ? resolveLaneExecutionPolicy(laneCapability, { cwd, permissionWorkspace, permissionMode, verifierIpcNetworkAccess: verifierRole })
      : null;
    if (laneCapability) await this._validateLaneExecution(laneCapability, { cwd, permissionWorkspace, executionPermissions, verifierRole });
    const readOnly = role.sandbox === 'read-only' && !fullAccess;
    const usePermissionProfile = fullAccess || permissionMode.mode === 'inherit' && permissionMode.profileApi === true
      && !legacyNativeWorkspaceWrite(permissionMode);
    const inheritedProfile = fullAccess ? DANGER_FULL_ACCESS_PROFILE : permissionMode.mode === 'inherit'
      ? (readOnly ? READ_ONLY_PROFILE : permissionMode.writerProfile)
      : null;
    const selectedProfile = inheritedProfile || (readOnly ? READ_ONLY_PROFILE : WORKSPACE_PROFILE);
    const applyNativeApprovals = permissionMode.mode === 'inherit';
    const threadPermissions = usePermissionProfile
      ? { permissions: selectedProfile }
      : permissionMode.mode === 'inherit'
        ? { sandbox: readOnly ? 'read-only' : permissionMode.sandboxMode }
        : { sandbox: normalizeSandbox(role.sandbox) };
    const approvalSettings = fullAccess
      ? { approvalPolicy: 'never', approvalsReviewer: 'user' }
      : applyNativeApprovals
      ? { approvalPolicy: permissionMode.approvalPolicy, approvalsReviewer: permissionMode.approvalsReviewer }
      : { approvalPolicy: 'on-request', approvalsReviewer: APPROVALS_REVIEWER };
    const nativeLegacy = applyNativeApprovals && !usePermissionProfile;
    await this.start();
    const { config: toolConfig, policy: toolPolicy } = await this._toolPolicy(role, cwd, validatedMcpTools);
    if (fullAccess) await this._validateFullAccess(permissionWorkspace);
    if (laneCapability) await this._validateLaneExecution(laneCapability, { cwd, permissionWorkspace, executionPermissions, verifierRole });
    const threadResult = await this._request('thread/start', {
      model: role.model || null,
      cwd,
      ...(ephemeral ? { ephemeral: true } : {}),
      developerInstructions: [role.instructions || `You are the ${role.name} agent.`, SKILL_BOUNDARY, READING_DISCIPLINE].join('\n\n'),
      ...threadPermissions,
      ...approvalSettings,
      config: toolConfig,
    });
    const threadId = threadResult?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new CodexAppServerError('Codex App Server did not return a thread ID');
    const turnPermissions = usePermissionProfile
      ? { permissions: selectedProfile }
      : nativeLegacy && readOnly
        ? { sandboxPolicy: { type: 'readOnly', networkAccess: false } }
        : nativeLegacy
          ? { sandboxPolicy: laneExecution?.sandboxPolicy || (verifierRole && permissionMode.sandboxMode === 'workspace-write'
            ? withVerifierIpcNetworkAccess(nativeSandboxPolicy(permissionWorkspace, permissionMode.sandboxMode, permissionMode.sandboxWorkspaceWrite))
            : nativeSandboxPolicy(permissionWorkspace, permissionMode.sandboxMode, permissionMode.sandboxWorkspaceWrite)) }
          : { sandboxPolicy: verifierRole
            ? withVerifierIpcNetworkAccess(sandboxPolicyOverride || sandboxPolicy(role.sandbox))
            : sandboxPolicyOverride || sandboxPolicy(role.sandbox) };
    this.loadedThreads.add(threadId);
    this.threadMcpPolicies.set(threadId, JSON.stringify(mcpToolPins(validatedMcpTools)));
    this.threadExecutionPolicies.set(threadId, JSON.stringify({ threadPermissions, turnPermissions, approvalSettings }));
    this.threadTotals.set(threadId, ZERO_TOTAL);
    return { threadId, model: threadResult?.model || role.model || null, effort: threadResult?.reasoningEffort || role.effort || null,
      toolPolicy, permissionMode: permissionMode.mode };
  }

  async run({ role, cwd, permissionWorkspace = cwd, input, onEvent, signal, threadId: existingThreadId, outputSchema, onTurnStart, selectedSkills = [], selectedMcpTools = [], sandboxPolicy: sandboxPolicyOverride = null, executionPermissions = 'strict', ephemeral = false, deliveryCapability = null } = {}) {
    if (!role || !role.name) throw new TypeError('role.name is required');
    if (!cwd) throw new TypeError('cwd is required');
    if (typeof input !== 'string' || !input.trim()) throw new TypeError('input must be a non-empty string');
    if (signal?.aborted) throw abortError();
    const validatedSkills = validateSelectedSkills(selectedSkills);
    const validatedMcpTools = resolveManagedToolSelection(this.mcpCatalog,
      selectedMcpTools.map((item) => item?.id),
      { allowedServers: role.tools?.mcpServers || [], pins: mcpToolPins(selectedMcpTools) });
    const connectorCatalog = withConnectors(this.mcpCatalog).connectorCatalog;
    this._assertConnectorsEnabled(validatedMcpTools.filter(({ id }) => connectorCatalog.has(id)));
    const permissionMode = await this.resolveExecutionPermissions(permissionWorkspace, executionPermissions,
      { fresh: executionPermissions === 'full-access' });
    assertFullAccessPermissionMode(executionPermissions, permissionMode);
    const fullAccess = permissionMode.mode === 'full-access';
    const verifierRole = canonicalRoleId(role.id || role.name) === 'verifier';
    const laneCapability = isLaneExecutionCapability(sandboxPolicyOverride) ? sandboxPolicyOverride : null;
    if (legacyNativeWorkspaceWrite(permissionMode) && sandboxPolicyOverride != null && !laneCapability) {
      throw new CodexAppServerError('Native workspace-write lane policy requires a host-owned capability', { failureClass: 'request_rejected' });
    }
    const laneExecution = laneCapability
      ? resolveLaneExecutionPolicy(laneCapability, { cwd, permissionWorkspace, permissionMode, verifierIpcNetworkAccess: verifierRole })
      : null;
    if (laneCapability) await this._validateLaneExecution(laneCapability, { cwd, permissionWorkspace, executionPermissions, verifierRole });
    const readOnly = role.sandbox === 'read-only' && !fullAccess;
    const scoped = deliveryCapability ? scopedExecutionDetails(deliveryCapability) : null;
    if (scoped) {
      scoped.assertCurrent();
      const selectedPermissionMode = (executionPermissions === 'inherit' && permissionMode.mode === 'inherit')
        || (executionPermissions === 'strict' && permissionMode.mode === 'strict')
        || (executionPermissions === 'full-access' && permissionMode.mode === 'full-access');
      if (canonicalRoleId(role.id || role.name) !== 'verifier' || existingThreadId
        || fs.realpathSync(cwd) !== scoped.scratchRoot || fs.realpathSync(permissionWorkspace) !== scoped.permissionWorkspace
        || !selectedPermissionMode || scoped.executionPermissions !== executionPermissions
        || scoped.executionPolicyDigest !== scopedExecutionPolicyDigest(scoped)) {
        throw new CodexAppServerError('Scoped verifier execution identity or selected approval policy is unavailable', { failureClass: 'request_rejected' });
      }
      if (!scoped.verifyCandidate()) throw new CodexAppServerError('Frozen verifier candidate changed before execution', { failureClass: 'request_rejected' });
    }
    let executionRole = role;
    if (role.fastMode === 'off') {
      executionRole = { ...role, serviceTierForTurn: 'default' };
    } else if (role.fastMode === 'on') {
      await this.start();
      const models = await this.listModels();
      const model = models.find((entry) => entry.id === role.model);
      try {
        const serviceTierForTurn = resolveServiceTierForTurn(role.fastMode, model);
        executionRole = { ...role, ...(serviceTierForTurn ? { serviceTierForTurn } : {}) };
      } catch (error) {
        throw new CodexAppServerError(`${error.message} (${role.model || 'unknown model'})`);
      }
    }
    const usePermissionProfile = fullAccess || !scoped && permissionMode.mode === 'inherit' && permissionMode.profileApi === true
      && !legacyNativeWorkspaceWrite(permissionMode);
    const inheritedProfile = fullAccess ? DANGER_FULL_ACCESS_PROFILE : permissionMode.mode === 'inherit'
      ? (readOnly ? READ_ONLY_PROFILE : permissionMode.writerProfile)
      : null;
    const enforcedProfile = readOnly ? READ_ONLY_PROFILE : WORKSPACE_PROFILE;
    const selectedProfile = inheritedProfile || enforcedProfile;
    const applyNativeApprovals = permissionMode.mode === 'inherit';
    const nativeLegacy = applyNativeApprovals && !usePermissionProfile;
    const threadPermissions = fullAccess
      ? { permissions: DANGER_FULL_ACCESS_PROFILE }
      : scoped
      ? { sandbox: 'workspace-write' }
      : usePermissionProfile
      ? { permissions: selectedProfile }
      : nativeLegacy
        ? { sandbox: readOnly ? 'read-only' : permissionMode.sandboxMode }
        : { sandbox: normalizeSandbox(role.sandbox) };
    const turnPermissions = fullAccess
      ? { permissions: DANGER_FULL_ACCESS_PROFILE }
      : scoped
      ? { sandboxPolicy: scopedVerifierSandboxPolicy(scoped.scratchRoot) }
      : usePermissionProfile
      ? { permissions: selectedProfile }
      : nativeLegacy && readOnly
        ? { sandboxPolicy: { type: 'readOnly', networkAccess: false } }
        : nativeLegacy
          ? { sandboxPolicy: laneExecution?.sandboxPolicy || (verifierRole && permissionMode.sandboxMode === 'workspace-write'
            ? withVerifierIpcNetworkAccess(nativeSandboxPolicy(permissionWorkspace, permissionMode.sandboxMode, permissionMode.sandboxWorkspaceWrite))
            : nativeSandboxPolicy(permissionWorkspace, permissionMode.sandboxMode, permissionMode.sandboxWorkspaceWrite)) }
          : { sandboxPolicy: verifierRole
            ? withVerifierIpcNetworkAccess(sandboxPolicyOverride || sandboxPolicy(role.sandbox))
            : sandboxPolicyOverride || sandboxPolicy(role.sandbox) };
    const approvalSettings = fullAccess
      ? { approvalPolicy: 'never', approvalsReviewer: 'user' }
      : scoped && permissionMode.mode === 'strict'
      ? { approvalPolicy: 'on-request', approvalsReviewer: APPROVALS_REVIEWER }
      : applyNativeApprovals || scoped
      ? { approvalPolicy: permissionMode.approvalPolicy, approvalsReviewer: permissionMode.approvalsReviewer }
      : { approvalPolicy: 'on-request', approvalsReviewer: APPROVALS_REVIEWER };

    const ctx = {
      processIdentity: null,
      generation: null,
      threadId: existingThreadId || null,
      turnId: null,
      turnStartSent: false,
      turnStartRejected: false,
      run: null,
      model: role.model || null,
      effort: role.effort || null,
      fastMode: executionRole.fastMode || 'inherit',
      serviceTierForTurn: executionRole.serviceTierForTurn || null,
      startedAt: new Date().toISOString(),
      startedMs: performance.now(),
      startupMs: null,
      coldStart: null,
      permissionEvents: [],
      pendingHooks: new Map(),
      permissionConfig: {
        ...(fullAccess ? {
          mode: 'full-access', profile: DANGER_FULL_ACCESS_PROFILE,
          approvalPolicy: 'never', approvalsReviewer: 'user',
        } : permissionMode.mode === 'inherit' ? {
          mode: 'inherit',
          reason: permissionMode.reason,
          inherited: true,
          ...(nativeLegacy ? { nativeSandbox: permissionMode.sandboxMode } : {}),
        } : {
          sandbox: normalizeSandbox(role.sandbox),
          sandboxPolicy: sandboxPolicy(role.sandbox).type,
          approvalPolicy: 'on-request',
          approvalsReviewer: APPROVALS_REVIEWER,
        }),
        ...(usePermissionProfile ? { profile: selectedProfile } : {}),
        ...(verifierRole ? {
          verifierIpcNetworkAccess: usePermissionProfile
            ? selectedProfile === ':danger-full-access'
            : turnPermissions.sandboxPolicy?.networkAccess === true
              || turnPermissions.sandboxPolicy?.type === 'dangerFullAccess',
        } : {}),
        ...(permissionMode.mode === 'inherit' ? {
          approvalPolicy: permissionMode.approvalPolicy ?? null,
          approvalsReviewer: permissionMode.approvalsReviewer ?? null,
        } : {}),
        cwd,
      },
    };
    if (validatedSkills.length) {
      ctx.permissionConfig.selectedSkills = validatedSkills.map(({ id, sha256 }) => ({ id, sha256 }));
    }
    try {
      const result = await this._run(ctx, { role: executionRole, cwd, permissionWorkspace, executionPermissions, fullAccess, laneCapability, verifierRole, input, onEvent, signal, existingThreadId, outputSchema, onTurnStart, selectedSkills: validatedSkills, selectedMcpTools: validatedMcpTools, permissionMode, threadPermissions, turnPermissions, approvalSettings, ephemeral, scoped });
      if (scoped) {
        if (!scoped.verifyCandidate()) throw new CodexAppServerError('Frozen verifier candidate changed during execution', { failureClass: 'request_rejected', execution: executionOf(ctx) });
        if (result.threadId) scoped.pinObservedThread(result.threadId);
      }
      return { ...result, execution: executionOf(ctx), usage: this._usageOf(ctx), ...permissionOf(ctx) };
    } catch (error) {
      // Concurrent runs can share one error instance (child failure); give each its own copy.
      const own = cloneError(error);
      if (own && typeof own === 'object') {
        const failureClass = classifyFailure(own);
        if (failureClass) own.failureClass = failureClass;
        own.generation ??= ctx.generation ?? this.generation;
      }
      own.execution = executionOf(ctx);
      if (ctx.run?.terminal) {
        const providerError = ctx.run.terminal.error || null;
        let errorDetails = null;
        try { errorDetails = typeof providerError?.message === 'string' ? JSON.parse(providerError.message).error || null : null; } catch (_) { /* Preserve the bounded raw message only. */ }
        own.terminalTurn = {
          id: ctx.run.terminal.id || ctx.run.turnId || null,
          status: ctx.run.terminal.status || null,
          error: providerError ? {
            message: typeof providerError.message === 'string' ? providerError.message.slice(0, MAX_TEXT_CHARS) : null,
            code: providerError.code ?? errorDetails?.code ?? null,
            type: providerError.type ?? errorDetails?.type ?? null,
            param: errorDetails?.param ?? null,
          } : null,
          itemTypes: Array.isArray(ctx.run.terminal.items)
            ? ctx.run.terminal.items.slice(0, 64).map((item) => typeof item?.type === 'string' ? item.type : 'unknown') : [],
        };
      }
      own.usage = this._usageOf(ctx);
      Object.assign(own, permissionOf(ctx));
      throw own;
    }
  }

  async _validateLaneExecution(capability, { cwd, permissionWorkspace, executionPermissions, verifierRole = false }) {
    const current = await this.resolveExecutionPermissions(permissionWorkspace, executionPermissions, { fresh: true });
    return resolveLaneExecutionPolicy(capability, { cwd, permissionWorkspace, permissionMode: current, verifierIpcNetworkAccess: verifierRole });
  }

  async _validateFullAccess(permissionWorkspace) {
    const current = await this.resolveExecutionPermissions(permissionWorkspace, 'full-access', { fresh: true });
    assertFullAccessPermissionMode('full-access', current);
    return current;
  }

  async _run(ctx, { role, cwd, permissionWorkspace, executionPermissions, fullAccess, laneCapability, verifierRole, input, onEvent, signal, existingThreadId, outputSchema, onTurnStart, selectedSkills, selectedMcpTools, permissionMode, threadPermissions, turnPermissions, approvalSettings, ephemeral, scoped = null }) {
    await this.start();
    const connectors = withConnectors(this.mcpCatalog).connectorCatalog;
    this._assertConnectorsEnabled(selectedMcpTools.filter(({ id }) => connectors.has(id))
      .flatMap(({ id }) => resolveConnectorToolSelection(connectors, [id], { allowedServers: role.tools?.mcpServers || [] })));
    ctx.generation = this.generation;
    this._assertTurnAdmission(ctx);
    const startup = this.startupInfo;
    if (startup && !startup.claimed && ctx.startedMs <= startup.readyMs) {
      startup.claimed = true;
      ctx.startupMs = startup.startupMs;
      ctx.coldStart = true;
    } else {
      ctx.coldStart = false;
    }

    const developerInstructions = [role.instructions || `You are the ${role.name} agent.`, SKILL_BOUNDARY, READING_DISCIPLINE,
      scopedVerifierInstructions(scoped)].filter(Boolean).join('\n\n');
    const executionPolicyDigest = JSON.stringify({ threadPermissions, turnPermissions, approvalSettings });
    const mcpPolicyDigest = JSON.stringify(mcpToolPins(selectedMcpTools));
    if (existingThreadId) {
      const priorPolicy = this.threadMcpPolicies.get(existingThreadId);
      if ((this.loadedThreads.has(existingThreadId) && priorPolicy === undefined)
        || (priorPolicy !== undefined && priorPolicy !== mcpPolicyDigest)) {
        throw new CodexAppServerError('The MCP tool selection for this thread is unknown or changed; start a fresh thread', {
          failureClass: 'request_rejected', threadId: existingThreadId,
        });
      }
    }
    let toolConfig = null;
    if (!existingThreadId || !this.loadedThreads.has(existingThreadId)) {
      const { config, policy } = await this._toolPolicy(role, cwd, selectedMcpTools);
      toolConfig = config;
      ctx.permissionConfig.toolPolicy = policy;
    }
    let threadResult = null;
    let baseline = null;
    if (!existingThreadId) {
      if (scoped) { scoped.assertCurrent(); if (!scoped.verifyCandidate()) throw new CodexAppServerError('Frozen verifier candidate changed before thread start', { failureClass: 'request_rejected' }); }
      if (fullAccess) await this._validateFullAccess(permissionWorkspace);
      if (laneCapability) await this._validateLaneExecution(laneCapability, { cwd, permissionWorkspace, executionPermissions, verifierRole });
      threadResult = await this._request('thread/start', {
        model: role.model || null,
        cwd,
        ...(ephemeral ? { ephemeral: true } : {}),
        developerInstructions,
        ...threadPermissions,
        ...approvalSettings,
        config: toolConfig,
      }, { signal });
      if (threadResult?.thread?.id) {
        this.loadedThreads.add(threadResult.thread.id);
        this.threadMcpPolicies.set(threadResult.thread.id, mcpPolicyDigest);
        this.threadExecutionPolicies.set(threadResult.thread.id, executionPolicyDigest);
        // A brand-new thread has consumed nothing yet.
        if (!this.threadTotals.has(threadResult.thread.id)) this.threadTotals.set(threadResult.thread.id, ZERO_TOTAL);
      }
      ctx.model = threadResult?.model || ctx.model;
      ctx.effort = ctx.effort || threadResult?.reasoningEffort || null;
    } else if (!this.loadedThreads.has(existingThreadId)) {
      // A restarted App Server no longer has the thread loaded; resume it from disk.
      // thread/resume carries no token usage, so the baseline stays unknown until an update arrives.
      if (fullAccess) await this._validateFullAccess(permissionWorkspace);
      if (laneCapability) await this._validateLaneExecution(laneCapability, { cwd, permissionWorkspace, executionPermissions, verifierRole });
      const resumed = await this._request('thread/resume', {
        threadId: existingThreadId,
        cwd,
        ...threadPermissions,
        ...approvalSettings,
        model: role.model || null,
        developerInstructions,
        config: toolConfig,
      }, { signal });
      this.loadedThreads.add(existingThreadId);
      this.threadMcpPolicies.set(existingThreadId, mcpPolicyDigest);
      this.threadExecutionPolicies.set(existingThreadId, executionPolicyDigest);
      ctx.model = resumed?.model || ctx.model;
      ctx.effort = ctx.effort || resumed?.reasoningEffort || null;
    } else {
      const priorExecutionPolicy = this.threadExecutionPolicies.get(existingThreadId);
      if (priorExecutionPolicy !== executionPolicyDigest) {
        if (fullAccess) await this._validateFullAccess(permissionWorkspace);
        if (laneCapability) await this._validateLaneExecution(laneCapability, { cwd, permissionWorkspace, executionPermissions, verifierRole });
        if (fullAccess || permissionMode.mode === 'inherit' && permissionMode.profileApi === true) {
          await this._request('thread/settings/update', { threadId: existingThreadId, sandboxPolicy: null }, { signal });
        } else {
          await this._request('thread/settings/update', { threadId: existingThreadId, permissions: null }, { signal });
        }
        await this._request('thread/settings/update', {
          threadId: existingThreadId,
          ...turnPermissions,
          ...approvalSettings,
        }, { signal });
        this.threadExecutionPolicies.set(existingThreadId, executionPolicyDigest);
      }
    }

    const threadId = existingThreadId || threadResult?.thread?.id;
    if (!threadId) throw new CodexAppServerError('Codex App Server did not return a thread ID');
    ctx.threadId = threadId;
    if (this.runs.has(threadId)) {
      throw new CodexAppServerError(`A Codex turn is already active for thread ${threadId}`, { threadId });
    }
    baseline = this.threadTotals.get(threadId) || null;

    const run = { threadId, turnId: null, status: null, text: '', events: [], onEvent, terminal: null, baseline, lastTotal: null, lastRequest: null, contextWindow: null, ctx };
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
      this._assertTurnAdmission(ctx);
      if (scoped) { scoped.assertCurrent(); if (!scoped.verifyCandidate()) throw new CodexAppServerError('Frozen verifier candidate changed before turn start', { failureClass: 'request_rejected' }); }
      if (fullAccess) await this._validateFullAccess(permissionWorkspace);
      if (laneCapability) {
        const current = await this._validateLaneExecution(laneCapability, { cwd, permissionWorkspace, executionPermissions, verifierRole });
        if (JSON.stringify(current.sandboxPolicy) !== JSON.stringify(turnPermissions.sandboxPolicy)) {
          throw new CodexAppServerError('Native lane sandbox policy changed before turn start', { failureClass: 'request_rejected' });
        }
      }
      ctx.processIdentity = this.processIdentity();
      if (onTurnStart) onTurnStart({ processIdentity: ctx.processIdentity, threadId });
      this._assertTurnAdmission(ctx);
      const currentSkills = validateSelectedSkills(selectedSkills);
      const turnStartRequest = this._request('turn/start', {
        threadId,
        input: [
          ...currentSkills.map(({ name, path: skillPath }) => ({ type: 'skill', name, path: skillPath })),
          { type: 'text', text: currentSkills.length ? `${currentSkills.map(({ name }) => `$${name}`).join(' ')}\n${input}` : input },
        ],
        ...(role.model ? { model: role.model } : {}),
        ...(role.effort ? { effort: role.effort } : {}),
        ...(role.serviceTierForTurn ? { serviceTierForTurn: role.serviceTierForTurn } : {}),
        cwd,
        ...turnPermissions,
        ...approvalSettings,
        ...(outputSchema ? { outputSchema } : {}),
      }, { onSending: (generation) => {
        if (scoped) {
          scoped.assertCurrent();
          if (!scoped.verifyCandidate()) throw new CodexAppServerError('Frozen verifier candidate changed before turn start', { failureClass: 'request_rejected' });
        }
        if (laneCapability) {
          const current = resolveLaneExecutionPolicy(laneCapability, { cwd, permissionWorkspace, permissionMode, verifierIpcNetworkAccess: verifierRole });
          if (JSON.stringify(current.sandboxPolicy) !== JSON.stringify(turnPermissions.sandboxPolicy)) {
            throw new CodexAppServerError('Native lane execution identity changed at turn start', { failureClass: 'request_rejected' });
          }
        }
        ctx.turnStartSent = true;
        ctx.generation = generation;
        ctx.childState = this.currentChildState;
        ctx.processIdentity = this.processIdentity();
      }, onWriteError: (error) => {
        error.outcomeUnknown = false;
        ctx.turnStartSent = false;
        ctx.generation = null;
        ctx.childState = null;
      } });
      let turnResult;
      try {
        turnResult = await turnStartRequest;
      } catch (error) {
        // A JSON-RPC error response means the server refused the request: no turn was created.
        if (error?.rpcResponse === true) ctx.turnStartRejected = true;
        throw error;
      }

      if (run.failedWith || this.exitError?.generation === run.ctx.generation) {
        throw run.failSafeError || run.failedWith || this._runError(run, this.exitError);
      }

      run.turnId = turnResult.turn?.id || run.turnId;
      if (!run.turnId) throw new CodexAppServerError('Codex App Server did not return a turn ID');
      if (run.abortRequested) this._interruptRun(run);
      if (!run.terminal) {
        run.terminal = await this._waitForTerminal(run);
      }
      let terminalError = null;
      if (run.abortRequested) terminalError = abortError({ threadId, turnId: run.turnId, status: run.status });
      if (run.status === 'failed') {
        terminalError ||= new CodexAppServerError(run.terminal?.error?.message || 'Codex turn failed', {
          failureClass: 'domain_failure',
          threadId,
          turnId: run.turnId,
          status: run.status,
          codexError: run.terminal?.error || null,
        });
      }
      await this._cleanupTerminal(run, terminalError);
      if (run.abortRequested) terminalError ||= abortError({ threadId, turnId: run.turnId, status: run.status });
      if (terminalError) throw terminalError;
      return { threadId, turnId: run.turnId, status: run.status, text: run.text, events: run.events };
    } catch (error) {
      let cause = error;
      // A fail-safe error (child terminated) is the authoritative outcome.
      if (run.failSafeError && error.name !== 'AbortError') cause = run.failSafeError;
      else if (run.failedWith?.failureClass === 'process_exit') cause = run.failedWith;
      const termination = cause.outcomeUnknown && !cause.termination && this.lastTermination?.survivors?.length ? this.lastTermination : null;
      if (termination) cause.termination = termination;
      if (cause.failureClass === 'background_terminal_cleanup_failed') throw cause;
      if (run.abortRequested && cause.name !== 'AbortError') {
        throw abortError({ threadId, turnId: run.turnId, cause, ...(cause.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(cause.termination ? { termination: cause.termination } : {}) });
      }
      throw cause;
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      this.clock.clearTimeout(run.interruptTimer);
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
      fastMode: ctx.fastMode,
      serviceTierForTurn: ctx.serviceTierForTurn,
      startedAt: ctx.startedAt,
      elapsedMs: Math.round(performance.now() - ctx.startedMs),
      // A run that failed before turn/start was sent has a known count of zero turns.
      turns: ctx.turnStartSent ? 1 : 0,
      // The schema does not say updates map one-to-one to model requests.
      modelRequests: null,
      tokens,
      tokenSource,
      cumulativeTotal,
      contextTokens: Number.isFinite(run?.lastRequest?.inputTokens) ? run.lastRequest.inputTokens : null,
      contextWindow: run?.contextWindow ?? null,
      appServerVersion: this.appServerVersion,
      startupMs: ctx.startupMs,
      coldStart: ctx.coldStart,
    };
  }

  _assertTurnAdmission(ctx) {
    const failure = this.backgroundTerminalCleanupFailure;
    if (failure?.generation !== ctx.generation) return;
    throw new CodexAppServerError('New turns are blocked after background terminal cleanup failed in this App Server generation', {
      failureClass: 'background_terminal_cleanup_blocked',
      generation: ctx.generation,
      relatedCleanupFailure: {
        failureClass: failure.failureClass,
        generation: failure.generation,
        threadId: failure.threadId || null,
        turnId: failure.turnId || null,
      },
      outcomeUnknown: false,
    });
  }

  async _cleanupTerminal(run, originalError = null) {
    if (!run.terminal) return;
    const generation = run.ctx.generation;
    const state = run.ctx.childState;
    const originalCurrent = () => Number.isSafeInteger(generation) && generation === this.generation
      && state && state === this.currentChildState && state.generation === generation
      && state.child === this.child && !state.failed && !state.exited && !this.childExited && this.child;
    const identity = run.ctx.processIdentity;
    const observeIdentity = () => validCleanupIdentity(identity)
      ? this.readProcessIdentityImpl(identity.pid) : null;
    const before = observeIdentity();
    if (!originalCurrent() || (validCleanupIdentity(before) && !sameCleanupIdentity(identity, before))) {
      const error = new CodexAppServerError('Background terminal cleanup could not run on the original Codex App Server generation', {
        failureClass: 'background_terminal_cleanup_failed',
        generation,
        threadId: run.threadId,
        turnId: run.turnId,
        outcomeUnknown: false,
      });
      throw this._recordCleanupFailure(cleanupError(error, originalError, run));
    }
    try {
      const result = await this._request('thread/backgroundTerminals/clean', { threadId: run.threadId }, {
        timeoutMs: this.backgroundTerminalCleanupTimeoutMs,
      });
      if (!originalCurrent()) {
        throw new CodexAppServerError('Background terminal cleanup completed after the original Codex App Server generation changed', {
          failureClass: 'background_terminal_cleanup_failed', generation, threadId: run.threadId, turnId: run.turnId,
        });
      }
      const after = observeIdentity();
      if (validCleanupIdentity(after) && !sameCleanupIdentity(identity, after)) {
        throw new CodexAppServerError('Background terminal cleanup completed after the original process identity changed', {
          failureClass: 'background_terminal_cleanup_failed', generation, threadId: run.threadId, turnId: run.turnId,
        });
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new CodexAppServerError('Codex App Server returned an invalid background terminal cleanup response', {
          failureClass: 'background_terminal_cleanup_failed',
          generation,
          threadId: run.threadId,
          turnId: run.turnId,
        });
      }
      if (identity?.pid === state.child.pid && sameCleanupIdentity(identity, state.identity)
        && sameCleanupIdentity(identity, before) && sameCleanupIdentity(identity, after)
        && typeof run.threadId === 'string' && run.threadId.length > 0
        && typeof run.turnId === 'string' && run.turnId.length > 0) {
        run.ctx.cleanupReceipt = {
          version: 1, method: 'thread/backgroundTerminals/clean',
          scope: 'provider-managed-background-terminals', completion: 'confirmed',
          generation, processIdentity: { ...identity }, threadId: run.threadId, turnId: run.turnId,
        };
      }
    } catch (cause) {
      if (cause?.failureClass === 'background_terminal_cleanup_failed' && cause.generation === generation) {
        throw this._recordCleanupFailure(cleanupError(cause, originalError, run));
      }
      const error = new CodexAppServerError(`Background terminal cleanup failed: ${cause?.message || String(cause)}`, {
        failureClass: 'background_terminal_cleanup_failed',
        generation,
        threadId: run.threadId,
        turnId: run.turnId,
        cleanupCause: cloneError(cause),
      });
      throw this._recordCleanupFailure(cleanupError(error, originalError, run));
    }
  }

  _recordCleanupFailure(error) {
    if (error.generation === this.generation) this.backgroundTerminalCleanupFailure = error;
    return error;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.loadedThreads.clear();
    this.threadExecutionPolicies.clear();
    this.reader?.close();
    this.sleepCancel?.();
    this.supState = 'stopped';
    this._failAll(new CodexAppServerError('Codex App Server client closed', { failureClass: 'closed' }));
    this.childExited = true;
    this.resolveChildExit?.();
    this.resolveChildExit = null;
    const state = this.currentChildState;
    if (state) {
      if (state.exitWait?.timer) this.clock.clearTimeout(state.exitWait.timer);
      if (state.exitWait) { state.exitWait.timer = null; state.exitWait.resolve(); }
      state.resolveExit?.();
      state.resolveExit = null;
    }
    this._terminateProcess();
    this.child = null;
  }

  getVersion() {
    return this.appServerVersion;
  }

  getCodexHome() {
    return this.codexHome;
  }

  // Runs one standalone command in the server sandbox (no thread, no turn); buffered result.
  async execCommand({ command, cwd, sandboxPolicy: policy, permissionProfile = null, env = null, timeoutMs = 30000 } = {}) {
    if (!Array.isArray(command) || !command.length) throw new TypeError('command must be a non-empty array');
    if (policy && permissionProfile) throw new TypeError('sandboxPolicy and permissionProfile cannot be combined');
    await this.start();
    return this._request('command/exec', {
      command,
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      ...(policy ? { sandboxPolicy: policy } : {}),
      ...(permissionProfile ? { permissionProfile } : {}),
      timeoutMs,
    }, { timeoutMs: timeoutMs + 5000 });
  }

  _request(method, params, { signal, timeoutMs = this.requestTimeoutMs, onSending, onWriteError } = {}) {
    if (!this.child || this.closed || this.exitError) {
      return Promise.reject(this.exitError || new CodexAppServerError('Codex App Server is not running', { failureClass: this.closed ? 'closed' : 'process_exit' }));
    }
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.pending.get(id) === request) this.pending.delete(id);
        callback(value);
      };
      const request = {
        method,
        generation,
        threadId: typeof params?.threadId === 'string' ? params.threadId : null,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      const onAbort = () => request.reject(abortError());
      timer = this.clock.setTimeout(() => {
        if (settled) return;
        const error = new CodexAppServerError(`Codex App Server request timed out: ${method}`, {
          method,
          id,
          failureClass: method === 'initialize' ? 'spawn_failed' : 'rpc_timeout',
          generation,
        });
        if (method === 'turn/start') {
          const run = this.runs.get(params.threadId);
          if (run && run.ctx.generation === generation) {
            // The turn may have started: the child (and its group) must be gone before we report.
            error.outcomeUnknown = true;
            error.failureClass = 'turn_start_unknown';
            run.failSafeError = error;
            request.reject(error);
            this._failAll(error);
            this._terminateProcess('turn_start_unknown', generation);
            return;
          }
        }
        request.reject(error);
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, request);
      try {
        onSending?.(generation);
        this._write({ id, method, params });
      } catch (error) {
        onWriteError?.(error);
        request.reject(error);
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
      this._failAndTerminate(new CodexAppServerError('Codex App Server sent invalid JSONL', { cause: error, failureClass: 'process_exit' }));
      return;
    }

    if (Object.hasOwn(message, 'id')) {
      if (message.method && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) {
        this._declineServerRequest(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        if (pending.method === 'turn/start') {
          const run = this.runs.get(pending.threadId);
          if (run && run.ctx.generation === pending.generation) run.ctx.turnStartRejected = true;
        }
        pending.reject(new CodexAppServerError(message.error.message || 'Codex App Server RPC failed', {
          failureClass: pending.method === 'initialize' ? 'spawn_failed' : 'request_rejected',
          generation: pending.generation,
          rpcResponse: true,
          rpcCode: message.error.code,
          rpcData: message.error.data,
        }));
      } else pending.resolve(message.result || {});
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
        this.clock.clearTimeout(run.interruptTimer);
        this._emit(run, message);
        run.resolveTerminal?.(run.terminal);
      }
      return;
    }

    if (message.method === 'thread/tokenUsage/updated' && params.threadId && params.tokenUsage?.total) {
      this.threadTotals.set(params.threadId, params.tokenUsage.total);
      const owner = this.runs.get(params.threadId);
      if (owner && (!owner.turnId || owner.turnId === params.turnId)) {
        owner.lastTotal = params.tokenUsage.total;
        // `last` is the most recent model request: its input is the current context size.
        owner.lastRequest = params.tokenUsage.last || null;
        owner.contextWindow = Number.isFinite(params.tokenUsage.modelContextWindow) ? params.tokenUsage.modelContextWindow : null;
      }
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
      return;
    }
    this._dispatchNotification(message);
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
      const generation = run.ctx.generation;
      const onTimeout = () => {
        if (generation !== this.generation || this.runs.get(run.threadId) !== run || run.terminal) return;
        remainingMs -= Math.min(remainingMs, MAX_TIMER_DELAY_MS);
        if (remainingMs > 0) {
          timer = this.clock.setTimeout(onTimeout, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
          timer.unref?.();
          return;
        }
        const error = new CodexAppServerError('Timed out waiting for Codex turn completion', {
          threadId: run.threadId,
          turnId: run.turnId,
          outcomeUnknown: true,
          failureClass: 'turn_timeout',
          generation: this.generation,
        });
        run.failSafeError = error;
        this._interruptRun(run);
        this._failAll(error);
        this._terminateProcess('turn_timeout', generation);
      };
      timer = this.clock.setTimeout(onTimeout, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      timer.unref?.();
      const finish = run.resolveTerminal;
      run.resolveTerminal = (value) => { this.clock.clearTimeout(timer); finish(value); };
      const cleanup = () => this.clock.clearTimeout(timer);
      run.rejectTerminal = (error) => { cleanup(); reject(error); };
    });
  }

  _interruptRun(run) {
    if (run.ctx.generation !== this.generation) return;
    if (!run.turnId || run.terminal || run.interruptSent) return;
    run.interruptSent = true;
    this._request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
    if (run.abortRequested) {
      // Wait a bounded time for the interrupt to be confirmed by turn/completed. If it is not,
      // terminate the shared child: this also interrupts every other concurrent turn on it (they
      // surface as outcomeUnknown; read-only ones are harmless) but proves this turn cannot mutate.
      const generation = run.ctx.generation;
      run.interruptTimer = this.clock.setTimeout(() => {
        if (generation !== this.generation || this.runs.get(run.threadId) !== run) return;
        if (run.terminal) return;
        run.failSafeError = abortError({ threadId: run.threadId, turnId: run.turnId, outcomeUnknown: true, failureClass: 'interrupt_unconfirmed', generation: this.generation });
        this._failAll(run.failSafeError);
        this._terminateProcess('interrupt_unconfirmed', generation);
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
      own = exitAt != null && this.clock.now() - exitAt < OWN_GROUP_EXIT_WINDOW_MS;
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

  _delayedKill(child, identity, termination = null, generation = termination?.generation ?? this.childStates.get(child)?.generation) {
    const state = this.childStates.get(child);
    const exitAt = this.childExitTimes.get(child) ?? null;
    if (this._signalOwnGroup(identity, 'SIGKILL', { child, exitAt })) return;
    if (!identity || typeof identity.pid !== 'number') return;
    let survivors = [];
    try { survivors = this.listGroupMembersImpl(identity.pgid); } catch (_) { /* diagnostics only */ }
    const at = new Date(this.clock.now()).toISOString();
    // The record is shared with the errors of the runs this termination failed (their copies
    // hold the same object), so they learn what outlived it.
    const record = termination || { identity, survivors: [], at, generation };
    record.survivors = survivors;
    record.at = at;
    if (state && generation === this.generation && state === this.currentChildState) this.lastTermination = record;
  }

  _terminateProcess(failureClass = null, generation = this.generation) {
    const child = this.child;
    const state = child && this.childStates.get(child);
    if (!child || !state || state.generation !== generation || !this._isCurrentChild(child, generation)) return;
    if (!this.closed && failureClass && CHARGED_CLASSES.has(failureClass)) {
      if (!state.failed) this._failAll(new CodexAppServerError(`Codex App Server generation failed: ${failureClass}`, { failureClass, generation }));
      this._beginExitWait(child, generation, state.identity);
    }
    if (this.terminatedChildren.has(child)) return;
    if (typeof child.pid !== 'number' && (child.exitCode != null || child.killed)) return;
    this.terminatedChildren.add(child);
    const identity = state.identity;
    const termination = { identity, survivors: [], at: new Date(this.clock.now()).toISOString(), generation };
    state.termination = termination;
    this.activeTermination = termination;
    this.lastTermination = null;
    this._pushEvent('terminated', failureClass || this.exitError?.failureClass || null, null, null, generation);
    for (const run of this.runs.values()) {
      if (run.ctx.generation !== generation) continue;
      const error = run.failSafeError || run.failedWith;
      if (error && error.outcomeUnknown) error.termination = termination;
    }
    if (!state.exited) this._signalOwnGroup(identity, 'SIGTERM', { child, exitAt: this.childExitTimes.get(child) ?? null });
    this.clock.clearTimeout(state.forceKillTimer);
    // Not cleared on child exit: grandchildren in the group may outlive the leader.
    state.forceKillTimer = this.clock.setTimeout(() => this._delayedKill(child, identity, termination, generation), 1_000);
    state.forceKillTimer.unref?.();
  }

  // A process failure ends its generation and prevents reuse even when no turn is active.
  _failAndTerminate(error) {
    error.generation ??= this.generation;
    this._failAll(error);
    this._terminateProcess(error.failureClass, error.generation);
  }

  // Each run gets its own error: outcomeUnknown only when it sent turn/start and saw no terminal event.
  _runError(run, base) {
    if (!run.failedWith) {
      const own = cloneError(base);
      own.outcomeUnknown = run.ctx.turnStartSent === true && run.ctx.turnStartRejected !== true && !run.terminal;
      if (own.outcomeUnknown && run.ctx.childState?.termination && !own.termination) own.termination = run.ctx.childState.termination;
      run.failedWith = own;
    }
    return run.failedWith;
  }

  _failAll(error) {
    error.generation ??= this.generation;
    const generation = error.generation;
    if (generation !== this.generation) return;
    const state = this.currentChildState;
    if (state && state.generation === generation && state.failed && error.failureClass !== 'closed') return;
    if (error.failureClass !== 'closed' && this.failedGeneration === generation) return;
    if (error.failureClass !== 'closed') {
      this.failedGeneration = generation;
      if (state && state.generation === generation) {
        state.failed = true;
        state.failure = error;
      }
    }
    this._charge(error.failureClass);
    this.exitError = error;
    this.loadedThreads.clear();
    this.threadExecutionPolicies.clear();
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      const run = pending.threadId ? this.runs.get(pending.threadId) : null;
      if (run && run.ctx.generation === generation) {
        pending.reject(this._runError(run, error));
      } else {
        const own = cloneError(error);
        own.outcomeUnknown = false;
        pending.reject(own);
      }
    }
    for (const run of this.runs.values()) {
      if (run.ctx.generation !== generation) continue;
      run.failedWith ||= run.failSafeError || this._runError(run, error);
      run.rejectTerminal?.(run.failSafeError || run.failedWith);
    }
  }
}

function abortError(details = {}) {
  const error = new Error('Codex turn aborted');
  error.name = 'AbortError';
  Object.assign(error, details);
  return error;
}

function cleanupError(error, originalError, run) {
  error.originalTurnOutcome = {
    status: run.status,
    terminal: Boolean(run.terminal),
    failureClass: originalError?.failureClass || (originalError?.name === 'AbortError' ? 'aborted' : null),
    message: originalError?.message || null,
  };
  // The turn terminal can be known while its background processes remain live.
  // Keep that distinction in metadata while blocking writer settlement.
  error.outcomeUnknown = originalError?.outcomeUnknown === true || run.ctx.turnStartSent === true;
  if (originalError) error.originalError = cloneError(originalError);
  return error;
}

function validCleanupIdentity(identity) {
  return Number.isSafeInteger(identity?.pid) && identity.pid > 1
    && Number.isSafeInteger(identity.pgid) && identity.pgid > 1
    && typeof identity.startTime === 'string' && /^[0-9]+$/.test(identity.startTime);
}

function sameCleanupIdentity(a, b) {
  return validCleanupIdentity(a) && validCleanupIdentity(b)
    && a.pid === b.pid && a.pgid === b.pgid && a.startTime === b.startTime;
}

function executionOf(ctx) {
  return {
    processIdentity: ctx.processIdentity,
    generation: ctx.generation,
    threadId: ctx.threadId,
    turnId: ctx.run?.turnId || ctx.turnId,
    turnStartSent: ctx.turnStartSent,
    turnStartRejected: ctx.turnStartRejected === true,
    turnTerminal: Boolean(ctx.run?.terminal),
    ...(ctx.cleanupReceipt ? { cleanupReceipt: ctx.cleanupReceipt } : {}),
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

function legacyNativeWorkspaceWrite(permissionMode) {
  return permissionMode?.mode === 'inherit' && permissionMode.profileApi === false
    && permissionMode.sandboxMode === 'workspace-write' && !permissionMode.writerProfile;
}

function assertFullAccessPermissionMode(requested, permissionMode) {
  if (requested === 'full-access' && permissionMode?.mode !== 'full-access') {
    const reason = permissionMode?.reason || 'full_access_policy_unavailable';
    throw new CodexAppServerError(`Owner full-access execution is unavailable (${reason})`, {
      failureClass: 'request_rejected', code: 'full_access_unavailable',
    });
  }
}

function scopedExecutionPolicyDigest(scoped) {
  return scoped.executionPermissions === 'full-access'
    ? stableDigest({ permissions: DANGER_FULL_ACCESS_PROFILE, approvalPolicy: 'never', approvalsReviewer: 'user' })
    : stableDigest(scopedVerifierSandboxPolicy(scoped.scratchRoot));
}

function sandboxPolicy(sandbox) {
  const normalized = normalizeSandbox(sandbox);
  if (normalized === 'read-only') return { type: 'readOnly' };
  if (normalized === 'danger-full-access') return { type: 'dangerFullAccess' };
  return { type: 'workspaceWrite' };
}

function laneSandboxPolicy({ workspacePath, networkAccess = false } = {}) {
  if (!workspacePath) throw new TypeError('workspacePath is required');
  return { type: 'workspaceWrite', writableRoots: [workspacePath], networkAccess: Boolean(networkAccess), excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function sanitizeAccount(account) {
  if (!account || typeof account !== 'object') return null;
  const safe = {};
  for (const key of ['type', 'email', 'planType', 'usesCodexManagedCredentials']) {
    if (Object.hasOwn(account, key)) safe[key] = account[key];
  }
  return safe;
}

module.exports = { CodexAppServer, CodexAppServerError, classifyFailure, laneSandboxPolicy };
