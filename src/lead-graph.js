'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  Annotation, StateGraph, START, END, interrupt,
} = require('@langchain/langgraph');
const { Role: A2ARole, TaskState } = require('@a2a-js/sdk');
const {
  DECISION_SCHEMA, WORKER_REPORT_CONTRACT, LEGACY_REPAIR_CHAINS, validateDecision, parseWorkerReport, classifyCodexError,
} = require('./contracts');
const { stageRoleMatches } = require('./plan-validator');
const { runAcceptance, assessWithoutChecks } = require('./acceptance');
const {
  routingOf, isSatisfied, requiredStageIds, evaluateImplementDelta,
} = require('./route-runtime');
const { assignmentId: makeAssignmentId, attemptId: makeAttemptId, deterministicContextId } = require('./durable-store');

const DEFAULT_RECONCILE_WAIT_MS = 30_000;
const MAX_OUTCOME_TEXT_CHARS = 12_000;
const MAX_STATUS_TEXT_CHARS = 2_000;
const MAX_REPORT_CHARS = 100_000;
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const REPORT_SUCCESS_OUTCOME = 'completed';
const PLAN_MAX_ROUNDS_CAP = 16;
const PLAN_MIN_ROUNDS = 6;
const PLAN_VIOLATION_LIMIT = 2;
const CANCELED_TEXT = 'Canceled after all active A2A tasks were confirmed stopped.';
const REPORT_CONTRACT_LINE = `Reply with a single JSON object matching the ${WORKER_REPORT_CONTRACT} report schema `
  + '(outcome, summary, filesChanged, filesInspected, checks, risks, scopeExpansion, decisionRequest). '
  + 'Use outcome needs_decision with a decisionRequest only after checking the evidence yourself; '
  + 'its recommendation must be exactly the id of one of its options.';

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
const STATE_NAMES = new Map(Object.entries(TaskState).map(([name, value]) => [value, name]));

// ------------------------------------------------------------- helpers

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
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

function taskStateName(state) {
  if (typeof state === 'string') return state;
  return STATE_NAMES.get(state) || String(state ?? 'unknown');
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

function resultTask(result) {
  if (result?.task) return result.task;
  if (result?.id && result?.status) return result;
  return null;
}

function isNotFoundError(error) {
  return error?.name === 'TaskNotFoundError' || error?.code === -32001 || /task not found/i.test(error?.message || '');
}

function errorText(error) {
  return (error?.message || String(error)).slice(0, MAX_STATUS_TEXT_CHARS);
}

// Plain-JSON snapshot of an A2A task. Artifact text keeps enough room for a full worker report.
function assignmentResult(task) {
  const status = task?.status;
  const statusMessage = extractTextParts(status?.message?.parts).slice(0, MAX_STATUS_TEXT_CHARS);
  const artifacts = (task?.artifacts || []).slice(0, 20).map((artifact) => ({
    name: artifact.name || '',
    description: artifact.description || '',
    text: extractTextParts(artifact.parts).slice(0, MAX_REPORT_CHARS),
    metadata: artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : null,
  }));
  const history = (task?.history || []).slice(-5).map((message) => extractTextParts(message.parts).slice(0, MAX_STATUS_TEXT_CHARS)).filter(Boolean);
  const text = artifacts.map((artifact) => artifact.text).filter(Boolean).join('\n') || statusMessage || history.at(-1) || '';
  const failureKind = status?.message?.metadata?.failureKind;
  const writerExecution = artifacts.map((artifact) => artifact.metadata?.writerExecution).find((entry) => entry && typeof entry === 'object')
    || (status?.message?.metadata?.writerExecution && typeof status.message.metadata.writerExecution === 'object' ? status.message.metadata.writerExecution : null);
  const effects = status?.message?.metadata?.effects;
  return {
    taskId: task?.id || null,
    contextId: task?.contextId || null,
    status: taskStateName(status?.state),
    statusMessage,
    artifacts,
    history,
    text: text.slice(0, MAX_REPORT_CHARS),
    ...(typeof failureKind === 'string' ? { failureKind } : {}),
    ...(writerExecution ? { writerExecution } : {}),
    ...(typeof effects === 'string' ? { effects } : {}),
  };
}

function syntheticResult(status, text, extras = {}) {
  return {
    taskId: extras.taskId || null,
    contextId: extras.contextId || null,
    status,
    statusMessage: '',
    artifacts: [],
    history: [],
    text: String(text).slice(0, MAX_STATUS_TEXT_CHARS),
    ...(extras.failure ? { failure: extras.failure } : {}),
  };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Pinned run context: workspace, role/team rules, and project instruction files.
function readPinned({ roles, leadRole, workspace }) {
  const rules = [...roles.values()].map((role) => [role.name, role.sandbox, role.model, role.effort, role.instructions || ''])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const projectInstructions = [];
  for (const name of PROJECT_INSTRUCTION_FILES) {
    try {
      const file = path.join(workspace, name);
      if (fs.statSync(file).isFile()) projectInstructions.push({ path: name, sha256: sha256(fs.readFileSync(file, 'utf8')) });
    } catch (_) { /* Missing or unreadable files are simply not pinned. */ }
  }
  return {
    workspace,
    teamRulesSha256: sha256(JSON.stringify([rules, leadRole?.instructions || ''])),
    projectInstructions,
  };
}

function instructionChanges(previous, current) {
  const notes = [];
  if (!previous) return notes;
  if (previous.teamRulesSha256 !== current.teamRulesSha256) notes.push('Team role rules changed since the run started.');
  const before = new Map(previous.projectInstructions.map((entry) => [entry.path, entry.sha256]));
  const after = new Map(current.projectInstructions.map((entry) => [entry.path, entry.sha256]));
  for (const [name, hash] of after) {
    if (!before.has(name)) notes.push(`${name} was added since the run started.`);
    else if (before.get(name) !== hash) notes.push(`${name} changed since the run started. Re-read it before delegating.`);
  }
  for (const name of before.keys()) if (!after.has(name)) notes.push(`${name} was removed since the run started.`);
  return notes;
}

function normalizeRel(file, workspace) {
  let value = String(file).replace(/\\/g, '/');
  if (workspace && value.startsWith(`${workspace}/`)) value = value.slice(workspace.length + 1);
  return path.posix.normalize(value).replace(/^\.\//, '');
}

// Paths outside allowedFiles (exact file or directory prefix).
function outsideAllowed(files, allowedFiles, workspace) {
  const allowed = allowedFiles.map((file) => normalizeRel(file, workspace).replace(/\/+$/, ''));
  return files.filter((file) => {
    const rel = normalizeRel(file, workspace);
    return !allowed.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
  });
}

// ---- plan helpers (pure)

function planRoundLimit(plan, fallback) {
  if (!plan) return fallback;
  return Math.min(PLAN_MAX_ROUNDS_CAP, Math.max(PLAN_MIN_ROUNDS, 2 * plan.stages.length));
}

function stageStatusOf(state, stageId) {
  return state.stageStatuses?.[stageId]?.status || 'pending';
}

function eligibleStages(state) {
  return state.plan.stages.filter((stage) => !isSatisfied(stageStatusOf(state, stage.stageId))
    && stage.dependencies.every((dep) => isSatisfied(stageStatusOf(state, dep))));
}

// Effective result rows. `required` is reported only for a lean route, so other runs stay byte-identical.
function stageRows(state) {
  const routing = routingOf(state.plan);
  const required = new Set(requiredStageIds(state.plan, routing, state.routePromotion));
  return state.plan.stages.map((stage) => ({
    stageId: stage.stageId,
    status: stageStatusOf(state, stage.stageId),
    attemptIds: state.stageStatuses?.[stage.stageId]?.attemptIds || [],
    ...(routing.effective === 'lean' ? { required: required.has(stage.stageId) } : {}),
  }));
}

function routeResultOf(state) {
  if (!state.plan || routingOf(state.plan).effective !== 'lean') return null;
  const promotion = state.routePromotion;
  return {
    effective: 'lean',
    promoted: Boolean(promotion),
    reasons: promotion ? promotion.reasons : [],
    at: promotion ? promotion.at : null,
  };
}

function mergePromotion(current, reasons, at) {
  if (current || !Array.isArray(reasons) || reasons.length === 0) return null;
  return { reasons: [...new Set(reasons)], at };
}

// Stage success: a completed task whose valid worker report says outcome completed, with no scope violations.
function isStageSuccess(outcome) {
  return outcome.status === 'TASK_STATE_COMPLETED'
    && outcome.report?.outcome === REPORT_SUCCESS_OUTCOME
    // A self-reported list is advisory once the server has proven the writer's real delta.
    && ((outcome.scopeViolations || []).length === 0 || outcome.attestedDeltaKnown === true)
    && (outcome.attestedScopeViolations || []).length === 0;
}

// Reported filesChanged outside allowedFiles.
function scopeViolations(report, allowedFiles, workspace) {
  if (!report) return [];
  return outsideAllowed(report.filesChanged, allowedFiles, workspace);
}

// A writer outcome is settled when the server proved the execution ended or nothing ran.
function isSettledWriter(result) {
  const state = result?.writerExecution?.state;
  return state === 'released' || state === 'reconciled' || result?.effects === 'none';
}

function resetsAtHint(limits) {
  const found = [];
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (typeof value.resetsAt === 'number' || typeof value.resetsAt === 'string') {
      found.push({ resetsAt: value.resetsAt, used: typeof value.usedPercent === 'number' ? value.usedPercent : null });
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(limits, 0);
  const exhausted = found.filter((entry) => entry.used !== null && entry.used >= 100);
  if (exhausted.length === 0) return null;
  const toMs = (value) => (typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value));
  const latest = exhausted.map((entry) => toMs(entry.resetsAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return latest === undefined ? null : new Date(latest).toISOString();
}

function pauseMessage(value) {
  if (value?.kind === 'human_decision') {
    const options = (value.options || []).map((option) => `  - ${option.id}: ${option.description}`).join('\n');
    return [
      `Human decision needed (${value.reason}): ${value.question}`,
      `Options:\n${options}`,
      `Recommendation: ${value.recommendation}`,
      `Decision ID: ${value.decisionId}`,
      'Answer by sending a message to this task with your answer, optionally naming a choice (option id) and the decision ID.',
    ].join('\n');
  }
  if (value?.kind === 'writer_unresolved') {
    const lines = (value.attempts || []).map((attempt) => `  - ${attempt.attemptId} (${attempt.role}): ${attempt.reason}`).join('\n');
    return [
      'Earlier writer outcome(s) are unresolved: the server could not prove that the writer stopped, so the workspace may still change.',
      `Attempts:\n${lines}`,
      'Send any message to this task to resume once the earlier writer is proven stopped; the run reconciles again before the lead continues.',
    ].join('\n');
  }
  if (value?.kind === 'operator_pause') {
    return 'Paused by the operator. No new work is dispatched. Send a message to this task (or resume the run) to continue.';
  }
  const hint = value?.resetsAt ? ` The usage window may reset around ${value.resetsAt} (a hint only).` : '';
  return `Waiting for Codex usage budget (${value?.source || 'unknown'} turn hit a usage limit).${hint} Send a message to this task to resume once budget is available.`;
}

// ------------------------------------------------------------ the graph

const last = (initial) => Annotation({ reducer: (_, next) => next, default: initial });

const LeadState = Annotation.Root({
  goal: last(() => ''),
  runId: last(() => ''),
  pinned: last(() => null),
  threadId: last(() => null),
  round: last(() => 0),
  attemptedRoles: last(() => []),
  outcomes: last(() => []),
  pendingAssignments: last(() => null),
  batch: last(() => null),
  openDecisions: last(() => []),
  closedDecisions: last(() => []),
  humanRequest: last(() => null),
  humanAnswers: last(() => []),
  humanCount: last(() => 0),
  budget: last(() => null),
  unresolvedWriters: last(() => []),
  contract: last(() => ({ requiredChecks: [] })),
  plan: last(() => null),
  settings: last(() => null),
  stageStatuses: last(() => ({})),
  planViolations: last(() => 0),
  decisionViolations: last(() => 0),
  planRetry: last(() => false),
  acceptanceAttempts: last(() => 0),
  acceptance: last(() => null),
  // Monotonic: once a promotion is recorded it is never cleared or overwritten.
  routePromotion: Annotation({ reducer: (current, next) => current || next || null, default: () => null }),
  status: last(() => null),
  reason: last(() => null),
  text: last(() => ''),
  result: last(() => null),
});

/**
 * deps = {
 *   appServer, roles, leadRole, workspace, maxRounds, journal, pollIntervalMs,
 *   runtimeFor(runId) -> { signal, onEvent, resumed },   // per-run, never checkpointed
 *   clientFor(roleName) -> A2A client, authOptions() -> request options,
 *   cancelUntilConfirmed(client, taskId, contextId) -> terminal task,
 *   emit(onEvent, event), checkpointer?,
 *   admission?: WriterAdmission, reconcileWaitMs?: number,
 *   usageLedger?: UsageLedger, runCheckImpl?, snapshot?,
 *   operatorControl?(leadTaskId) -> null | 'pause' | 'stop',   // sync, side-effect free
 * }
 * Returns the compiled graph when deps.checkpointer is given, else the StateGraph.
 */
function buildLeadGraph(deps) {
  const {
    appServer, roles, leadRole, workspace, maxRounds, journal, pollIntervalMs,
  } = deps;
  const { admission } = deps;
  const repairChains = deps.repairChains || LEGACY_REPAIR_CHAINS;
  const hasRepairChain = (roleId) => Array.isArray(repairChains[roleId]) && repairChains[roleId].length > 0;
  // Pinned per-run settings for a runtime role, or null (legacy runs pin none).
  const settingsFor = (state, roleId) => (state.settings && state.settings[roleId]) || null;
  const withSettings = (role, entry) => (entry
    ? { ...role, model: entry.model, effort: entry.effort, ...(entry.serviceTier ? { serviceTier: entry.serviceTier } : {}) }
    : role);
  const reconcileWaitMs = Number.isFinite(deps.reconcileWaitMs) ? deps.reconcileWaitMs : DEFAULT_RECONCILE_WAIT_MS;

  // Operator hold: sync and side-effect free; lookup failures fail closed.
  const holdOf = (state) => {
    if (typeof deps.operatorControl !== 'function') return null;
    try {
      const control = deps.operatorControl(state.runId);
      return control === 'pause' || control === 'stop' ? control : null;
    } catch (_) {
      return 'pause';
    }
  };
  const toDecide = (state) => (holdOf(state) ? 'operator_hold' : 'decide');

  const runtimeOf = (config) => deps.runtimeFor(config?.configurable?.thread_id) || {};
  const requestOptions = (signal) => ({ ...(signal ? { signal } : {}), ...deps.authOptions() });

  function outcomeSummary(item) {
    const result = item.result;
    const parsed = result.status === 'TASK_STATE_COMPLETED' ? parseWorkerReport(result.artifacts?.[0]?.text || result.text) : { report: null, error: null };
    const violations = scopeViolations(parsed.report, item.assignment.allowedFiles, workspace);
    const writerExecution = result.writerExecution || null;
    const attestedDelta = writerExecution?.delta || null;
    const attestedPaths = Array.isArray(attestedDelta?.changedPaths) ? attestedDelta.changedPaths : [];
    return {
      assignmentId: item.assignmentId,
      attemptId: item.attemptId,
      role: item.role,
      sandbox: item.sandbox,
      taskId: result.taskId || item.taskId || null,
      status: result.status,
      report: parsed.report,
      reportError: parsed.error,
      ...(parsed.report ? {} : { text: (result.text || '').slice(0, MAX_OUTCOME_TEXT_CHARS) }),
      failureKind: result.failureKind || null,
      scopeViolations: violations,
      writerExecution,
      effects: result.effects || null,
      attestedScopeViolations: outsideAllowed(attestedPaths, item.assignment.allowedFiles, workspace),
      attestedDeltaKnown: attestedDelta?.known === true,
      ...(result.failure ? { failure: result.failure } : {}),
    };
  }

  function decisionPrompt(state, extras) {
    const openDecisions = state.openDecisions.map(({ id, role, request }) => ({ id, role, request }));
    const sections = [
      'Plan and coordinate the requested work as the read-only team lead. Return only JSON matching the supplied schema.',
      'The lead must not edit files. Delegate all changes through the A2A role agents.',
      `User goal:\n${state.goal}`,
      `Dispatch rounds already used: ${state.round}/${maxRounds}. A dispatch decision consumes one round.`,
      'Available roles:\n' + JSON.stringify([...roles.values()].map((role) => {
        const { name, description, sandbox, model, effort } = withSettings(role, settingsFor(state, role.name));
        return { name, description, sandbox, model, effort };
      })),
    ];
    if (state.plan) {
      const eligible = eligibleStages(state).map((stage) => stage.stageId);
      sections.push('Approved delivery plan (binding):\n' + JSON.stringify({
        classification: state.plan.classification,
        checkIds: state.plan.checkIds,
        stages: state.plan.stages.map((stage) => ({
          ...stage,
          status: stageStatusOf(state, stage.stageId),
          attemptIds: state.stageStatuses?.[stage.stageId]?.attemptIds || [],
        })),
      }));
      sections.push(`Next eligible stages: ${eligible.length > 0 ? eligible.join(', ') : 'none'}.`);
      sections.push('Plan rules: every assignment must set stageId to an eligible stage (dependencies succeeded, stage not yet succeeded), use that stage role (a repair executor from the stage role repair chain may retry an attempted stage, in chain order), and keep allowedFiles within the stage allowedFiles. You may finish only when every required stage has succeeded. A decision that breaks these rules is discarded and counts as a round; two in a row end the run as plan_violation.');
      const routing = routingOf(state.plan);
      if (routing.effective === 'lean') {
        const stageIds = (ids) => ids.join(', ') || 'none';
        const promotion = state.routePromotion;
        sections.push(`Route: lean. Skipped stages (do not dispatch): ${stageIds(routing.skipStageIds)}. Conditional stages (${stageIds(routing.conditionalStageIds)}) are required now: ${promotion ? `yes, the route was promoted (${promotion.reasons.join('; ')})` : 'no'}.`);
      }
    }
    if (extras.notes.length > 0) sections.push('Notes:\n' + extras.notes.map((note) => `- ${note}`).join('\n'));
    sections.push('Open worker decisions (each must be resolved in resolutions, or listed in humanInput.relatedDecisionIds):\n' + JSON.stringify(openDecisions));
    if (state.acceptance?.disposition === 'rejected' && state.acceptanceAttempts > 0 && !state.status) {
      const issues = (state.acceptance.issues || []).map((issue) => `${issue.code}: ${issue.detail}`);
      sections.push(`Acceptance note: the deterministic acceptance run for your finish decision was rejected (disposition ${state.acceptance.disposition}). You may dispatch fixes within the round limits, then finish again; a second rejection ends the run as rejected. Your final text never changes the disposition.\nIssues:\n${issues.map((line) => `- ${line}`).join('\n')}`);
    }
    if (state.humanAnswers.length > 0) sections.push('Human answers (authoritative):\n' + JSON.stringify(state.humanAnswers));
    sections.push('Prior worker outcomes (including failures):\n' + JSON.stringify(state.outcomes));
    sections.push([
      'Every assignment must include role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, stopConditions, and stageId'
        + (state.plan ? ' (the plan stage id).' : ' (use null; there is no plan).')
        + ' Writable roles require one or more explicit safe relative allowedFiles. Keep each brief bounded.',
      'The JSON must contain action (dispatch, finish, or request_human_input), assignments, final, resolutions, and humanInput. Use empty arrays, an empty string, or null for unused fields. Cross-field rules: dispatch needs 1 or more assignments, empty final, and null humanInput; finish needs no assignments, non-empty final, and null humanInput; request_human_input needs no assignments, empty final, and a humanInput object.',
      'Worker decision requests: resolve them yourself (resolutions: decisionId, choice, rationale) whenever the evidence supports a choice. Worker reports are self-reported; check scopeViolations and reportError.',
      'Use request_human_input only for missing_authority, irreversible_or_external, or product_choice, and only after investigating: give options, a recommendation, the evidence checked, and the independent work that can proceed.',
      'Writer reconciliation is mechanical: before you decide, the server reconciles every writable outcome whose effects were unknown and lists the result as an outcome of kind reconciliation, with the attested changedPaths. attestedScopeViolations are changes the server observed outside allowedFiles; a report filesChanged list is self-reported and advisory. A writable dispatch is refused while any writer outcome is unresolved. For a read-only role, dispatch_error means the submission could not be matched to a task at lookup time; such a role cannot have workspace write effects.',
    ].join('\n'));
    return sections.join('\n\n');
  }

  function recordLeadTurn(state, source, outcome) {
    if (!deps.usageLedger) return;
    try {
      const usage = source?.usage || null;
      const threadId = source?.threadId || source?.execution?.threadId || state.threadId || null;
      const turnId = source?.turnId || source?.execution?.turnId || null;
      const entryId = turnId
        ? `lead:${threadId || state.runId}:${turnId}`
        : `lead:${state.runId}:r${state.round}:${usage?.startedAt || new Date().toISOString()}`;
      deps.usageLedger.record({
        entryId,
        kind: 'lead_turn',
        runId: state.runId,
        role: leadRole?.name || 'lead',
        taskId: null,
        contextId: null,
        attemptId: null,
        model: usage?.model ?? null,
        effort: usage?.effort ?? null,
        requested: usage?.requested ?? null,
        reported: usage?.reported ?? null,
        startedAt: usage?.startedAt ?? null,
        elapsedMs: usage?.elapsedMs ?? null,
        turns: usage?.turns ?? null,
        modelRequests: usage?.modelRequests ?? null,
        retries: null,
        tokens: usage?.tokens ?? null,
        tokenSource: usage?.tokenSource ?? 'unavailable',
        cumulativeTotal: usage?.cumulativeTotal ?? null,
        appServerVersion: usage?.appServerVersion ?? null,
        outcome,
        permissionEvents: Array.isArray(source?.permissionEvents) ? source.permissionEvents : [],
      });
    } catch (_) { /* Usage recording never breaks a run. */ }
  }

  // ---- nodes

  async function intake(state, config) {
    const runtime = runtimeOf(config);
    if (!isNonEmptyString(state.goal)) throw new TypeError('goal must be a non-empty string');
    const current = readPinned({ roles, leadRole, workspace });
    if (!state.pinned) return { pinned: current };
    runtime.pendingNotes = [...(runtime.pendingNotes || []), ...instructionChanges(state.pinned, current)];
    return { pinned: current };
  }

  async function decide(state, config) {
    const runtime = runtimeOf(config);
    const { signal } = runtime;
    if (signal?.aborted) return { status: 'canceled', text: CANCELED_TEXT };

    const notes = [...(runtime.pendingNotes || [])];
    runtime.pendingNotes = [];
    const update = {};
    if (state.planRetry) update.planRetry = false;
    if (runtime.resumed) {
      runtime.resumed = false;
      notes.push('This run was resumed after an interruption (restart, pause, or usage limit). A previous lead turn may have been repeated. Outcomes marked interrupted or outcome_unknown have unknown workspace effects.');
      const current = readPinned({ roles, leadRole, workspace });
      notes.push(...instructionChanges(state.pinned, current));
      update.pinned = current;
    }

    let leadResult;
    try {
      leadResult = await appServer.run({
        role: withSettings(leadRole, settingsFor(state, leadRole?.name)),
        cwd: workspace,
        input: decisionPrompt(state, { notes }),
        ...(state.threadId ? { threadId: state.threadId } : {}),
        outputSchema: DECISION_SCHEMA,
        signal,
      });
    } catch (error) {
      const kind = error?.name === 'AbortError' && signal?.aborted ? 'aborted' : classifyCodexError(error) === 'usage_limit' ? 'usage_limit' : 'error';
      if (error?.usage || error?.execution) recordLeadTurn(state, error, kind);
      if (kind === 'aborted') return { ...update, status: 'canceled', text: CANCELED_TEXT };
      if (kind === 'usage_limit') return { ...update, budget: { source: 'lead' } };
      throw error;
    }
    update.threadId = leadResult.threadId || state.threadId;
    recordLeadTurn(state, leadResult, leadResult.status || 'completed');

    const roundLimit = planRoundLimit(state.plan, maxRounds);
    let decision;
    try {
      decision = parseDecision(leadResult.text);
      // A closed decision (answered by the human or resolved earlier) must not be resolved again; the earlier closure stays authoritative.
      if (Array.isArray(decision.resolutions)) {
        const closedIds = new Set(state.closedDecisions.map((entry) => entry.id));
        const ignored = decision.resolutions.filter((entry) => closedIds.has(entry?.decisionId)).map((entry) => entry.decisionId);
        if (ignored.length > 0) {
          decision.resolutions = decision.resolutions.filter((entry) => !closedIds.has(entry?.decisionId));
          deps.emit(runtime.onEvent, { type: 'resolution_ignored', round: state.round + 1, decisionIds: ignored });
          runtime.pendingNotes = [...(runtime.pendingNotes || []), ...ignored.map((id) => `Ignored resolution for already closed decision ${id}.`)];
        }
      }
      validateDecision(decision, {
        roles,
        attemptedRoles: new Set(state.attemptedRoles),
        outcomeCount: state.outcomes.length,
        unresolvedWriterCount: state.unresolvedWriters.length,
        openDecisionIds: new Set(state.openDecisions.map((entry) => entry.id)),
        repairChains,
      });
    } catch (error) {
      // The decision is discarded; resolutions in it are not applied. The lead gets the exact error and tries again.
      const count = state.decisionViolations + 1;
      const round = state.round + 1;
      deps.emit(runtime.onEvent, { type: 'decision_rejected', round, error: error.message });
      const base = { round, decisionViolations: count };
      if (count >= PLAN_VIOLATION_LIMIT) {
        return {
          ...update,
          ...base,
          status: 'plan_violation',
          text: `The lead returned ${count} consecutive invalid decisions: ${error.message}`,
        };
      }
      runtime.pendingNotes = [...(runtime.pendingNotes || []), `Your previous decision was rejected: ${error.message}. It was discarded and counts as a round. Resolve only the open decisions listed; resolutions for closed decisions are ignored. Return a decision that follows the schema rules.`];
      return { ...update, ...base, planRetry: true };
    }
    update.decisionViolations = 0;
    deps.emit(runtime.onEvent, { type: 'decision', round: state.round + 1, action: decision.action });

    if (state.plan && (decision.action === 'finish' || decision.action === 'dispatch')) {
      const violations = planViolationsOf(state, decision);
      if (violations.length > 0) {
        const count = state.planViolations + 1;
        const round = state.round + 1;
        deps.emit(runtime.onEvent, { type: 'plan_violation', round, violations });
        // The decision is discarded; resolutions in it are not applied.
        const base = { round, planViolations: count };
        if (count >= PLAN_VIOLATION_LIMIT) {
          return {
            ...update,
            ...base,
            status: 'plan_violation',
            text: `The lead broke the approved plan in ${count} consecutive decisions: ${violations.join('; ')}`,
          };
        }
        runtime.pendingNotes = [...(runtime.pendingNotes || []), `Plan violation, decision discarded (counts as a round): ${violations.join('; ')}. Follow the approved plan.`];
        return { ...update, ...base, planRetry: true };
      }
      update.planViolations = 0;
      if (decision.action === 'dispatch' && state.acceptance?.disposition === 'rejected') {
        // Repair after rejected acceptance: reopen each re-dispatched succeeded builder stage and its transitive dependents.
        const reopen = new Set();
        for (const assignment of decision.assignments) {
          const stage = state.plan.stages.find((entry) => entry.stageId === assignment.stageId);
          if (stage && hasRepairChain(stage.roleId) && stageStatusOf(state, stage.stageId) === 'succeeded') reopen.add(stage.stageId);
        }
        if (reopen.size > 0) {
          let grew = true;
          while (grew) {
            grew = false;
            for (const stage of state.plan.stages) {
              if (!reopen.has(stage.stageId) && stageStatusOf(state, stage.stageId) !== 'skipped' && stage.dependencies.some((dep) => reopen.has(dep))) {
                reopen.add(stage.stageId);
                grew = true;
              }
            }
          }
          const stageStatuses = { ...state.stageStatuses };
          for (const id of reopen) stageStatuses[id] = { status: 'pending', attemptIds: stageStatuses[id]?.attemptIds || [] };
          update.stageStatuses = stageStatuses;
        }
      }
    }

    const resolved = new Map(decision.resolutions.map((entry) => [entry.decisionId, entry]));
    update.openDecisions = state.openDecisions.filter((entry) => !resolved.has(entry.id));
    update.closedDecisions = [...state.closedDecisions, ...decision.resolutions.map((entry) => ({ id: entry.decisionId, by: 'lead', choice: entry.choice }))];

    if (decision.action === 'finish') return { ...update, status: 'completed', text: decision.final.trim() };
    if (decision.action === 'request_human_input') {
      const decisionId = `${state.runId}:h${state.humanCount + 1}`;
      return { ...update, humanCount: state.humanCount + 1, humanRequest: { decisionId, ...decision.humanInput } };
    }
    if (state.round >= roundLimit) {
      return {
        ...update,
        status: 'max_rounds',
        text: decision.final.trim() || `Stopped after reaching the limit of ${roundLimit} dispatch rounds.`,
      };
    }
    return { ...update, pendingAssignments: decision.assignments };
  }

  // Violations of the pinned plan by a validated decision; empty when it is allowed.
  function planViolationsOf(state, decision) {
    const problems = [];
    if (decision.action === 'finish') {
      const required = new Set(requiredStageIds(state.plan, routingOf(state.plan), state.routePromotion));
      const open = state.plan.stages.filter((stage) => required.has(stage.stageId) && stageStatusOf(state, stage.stageId) !== 'succeeded');
      if (open.length > 0) problems.push(`finish is not allowed until every required stage has succeeded (open: ${open.map((stage) => stage.stageId).join(', ')})`);
      return problems;
    }
    const seen = new Set();
    for (const assignment of decision.assignments) {
      const id = assignment.stageId;
      const stage = typeof id === 'string' ? state.plan.stages.find((entry) => entry.stageId === id) : null;
      if (!stage) {
        problems.push(`assignment for ${assignment.role} names no plan stage (stageId ${JSON.stringify(id ?? null)})`);
        continue;
      }
      if (seen.has(id)) problems.push(`stage ${id} is assigned more than once in one decision`);
      seen.add(id);
      const repairReopen = state.acceptance?.disposition === 'rejected' && hasRepairChain(stage.roleId);
      if (stageStatusOf(state, id) === 'skipped') problems.push(`stage ${id} is skipped by the route and must not be dispatched`);
      if (stageStatusOf(state, id) === 'succeeded' && !repairReopen) problems.push(`stage ${id} has already succeeded`);
      const unmet = stage.dependencies.filter((dep) => !isSatisfied(stageStatusOf(state, dep)));
      if (unmet.length > 0) problems.push(`stage ${id} is not eligible: dependencies not succeeded (${unmet.join(', ')})`);
      const attemptIds = new Set(state.stageStatuses?.[id]?.attemptIds || []);
      const attemptedRoles = new Set(state.outcomes.filter((outcome) => attemptIds.has(outcome.attemptId)).map((outcome) => outcome.role));
      if (!stageRoleMatches(stage, assignment.role, attemptedRoles, { repairChains })) problems.push(`stage ${id} requires role ${stage.roleId}, not ${assignment.role}`);
      const extra = outsideAllowed(assignment.allowedFiles, stage.allowedFiles, workspace);
      if (extra.length > 0) problems.push(`assignment for stage ${id} widens allowedFiles beyond the stage (${extra.join(', ')})`);
    }
    return problems;
  }

  function parseDecision(text) {
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

  async function findTask(client, contextId, signal) {
    const response = await client.listTasks({
      contextId,
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageSize: 100,
      pageToken: '',
      historyLength: 20,
      statusTimestampAfter: undefined,
    }, requestOptions(signal));
    return response?.tasks?.find((entry) => entry.contextId === contextId) || null;
  }

  function finishItem(item, result) {
    journal.recordFinished(item.attemptId, result);
    return { ...item, state: 'finished', taskId: result.taskId || item.taskId, result };
  }

  async function submitItem(item, signal, settings = null) {
    const role = roles.get(item.role);
    const client = await deps.clientFor(item.role);
    const row = journal.get(item.attemptId);
    if (row?.state === 'finished') return { ...item, state: 'finished', taskId: row.taskId, result: row.result };
    if (row?.state === 'submitted') return { ...item, state: 'submitted', taskId: row.taskId };

    if (signal?.aborted) return item;
    if (!row) {
      journal.recordSubmitting({
        attemptId: item.attemptId,
        runId: item.runId,
        assignmentId: item.assignmentId,
        role: item.role,
        sandbox: item.sandbox,
        contextId: item.contextId,
        objectiveSha256: sha256(String(item.assignment?.objective ?? '')),
        stageId: typeof item.assignment?.stageId === 'string' ? item.assignment.stageId : undefined,
      });
    } else {
      // Journal says "submitting": the send may or may not have reached the server.
      const found = await findTask(client, item.contextId, signal);
      if (found) {
        journal.recordSubmitted(item.attemptId, found.id);
        return { ...item, state: 'submitted', taskId: found.id };
      }
      if (item.sandbox !== 'read-only') {
        return finishItem(item, syntheticResult('outcome_unknown', `Submission of ${role.name} was interrupted and no A2A task exists for it; it was not re-sent because the role can write. Workspace effects are unknown.`, { contextId: item.contextId }));
      }
    }

    const pinned = settings && settings[item.role] ? settings[item.role] : null;
    const { stageId: _stageId, ...workerAssignment } = item.assignment;
    const text = JSON.stringify({
      ...workerAssignment,
      assignmentId: item.assignmentId,
      workspace,
      reportContract: REPORT_CONTRACT_LINE,
    });
    let submitted;
    try {
      submitted = await abortable(client.sendMessage({
        message: {
          messageId: `${item.attemptId}:msg`,
          contextId: item.contextId,
          role: A2ARole.ROLE_USER,
          parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain' }],
          metadata: pinned ? { effectiveSettings: { roleRuntimeId: item.role, model: pinned.model, effort: pinned.effort, serviceTier: pinned.serviceTier ?? null } } : {},
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] },
        metadata: {},
      }, requestOptions(signal)), signal);
    } catch (error) {
      // Leave the item submitted with an unknown task ID; collect cancels it by contextId.
      if (signal?.aborted || error?.name === 'AbortError') return { ...item, state: 'submitted', taskId: null };
      let found = null;
      let reconcileFailed = false;
      try { found = await findTask(client, item.contextId, signal); } catch (_) { reconcileFailed = true; }
      if (found) {
        journal.recordSubmitted(item.attemptId, found.id);
        return { ...item, state: 'submitted', taskId: found.id };
      }
      if (item.sandbox !== 'read-only') {
        const lookup = reconcileFailed ? 'the A2A task lookup also failed' : 'the immediate A2A task lookup found no task';
        return finishItem(item, syntheticResult('outcome_unknown', `Submission of ${role.name} failed (${errorText(error)}) and ${lookup}; a task may be accepted later, so workspace effects are unknown.`, {
          contextId: item.contextId, failure: { name: error?.name || 'Error', message: errorText(error) },
        }));
      }
      return finishItem(item, syntheticResult('dispatch_error', errorText(error), {
        contextId: item.contextId, failure: { name: error?.name || 'Error', message: errorText(error) },
      }));
    }

    const task = resultTask(submitted);
    if (!task) {
      if (item.sandbox !== 'read-only') {
        return finishItem(item, syntheticResult('outcome_unknown', `A2A role ${role.name} returned no task ID; it may have accepted the writable task, so workspace effects are unknown.`, { contextId: item.contextId }));
      }
      if (submitted?.message) return finishItem(item, { ...syntheticResult('TASK_STATE_COMPLETED', ''), contextId: item.contextId, text: extractTextParts(submitted.message.parts).slice(0, MAX_REPORT_CHARS) });
      return finishItem(item, syntheticResult('dispatch_error', `A2A role ${role.name} did not return a task ID`, { contextId: item.contextId }));
    }
    journal.recordSubmitted(item.attemptId, task.id);
    if (isTaskFinished(task)) return finishItem({ ...item, taskId: task.id }, assignmentResult(task));
    return { ...item, state: 'submitted', taskId: task.id };
  }

  async function dispatch(state, config) {
    const { signal } = runtimeOf(config);
    let batch = state.batch;
    const update = {};
    if (!batch) {
      const round = state.round + 1;
      const parallel = state.pendingAssignments.every((assignment) => roles.get(assignment.role).sandbox === 'read-only');
      batch = {
        round,
        parallel,
        items: state.pendingAssignments.map((assignment, index) => {
          const assignmentId = makeAssignmentId(state.runId, round, index);
          const attemptId = makeAttemptId(assignmentId);
          return {
            runId: state.runId,
            assignmentId,
            attemptId,
            contextId: deterministicContextId(attemptId),
            role: assignment.role,
            sandbox: roles.get(assignment.role).sandbox,
            assignment,
            state: 'pending',
            taskId: null,
            result: null,
          };
        }),
      };
      update.round = round;
      update.attemptedRoles = [...new Set([...state.attemptedRoles, ...state.pendingAssignments.map((assignment) => assignment.role)])];
      update.pendingAssignments = null;
    }

    // Serial batch: once a finished writer of this batch is not provably settled, no further writer
    // is submitted. Its workspace effects are unknown, so the rest are skipped and reconcile runs.
    if (!batch.parallel && batch.items.some((item) => item.state === 'finished' && item.sandbox !== 'read-only' && !isSettledWriter(item.result))) {
      batch = {
        ...batch,
        items: batch.items.map((item) => {
          if (item.state !== 'pending' || item.sandbox === 'read-only') return item;
          const row = journal.get(item.attemptId);
          if (!row) {
            journal.recordSubmitting({
              attemptId: item.attemptId,
              runId: item.runId,
              assignmentId: item.assignmentId,
              role: item.role,
              sandbox: item.sandbox,
              contextId: item.contextId,
              objectiveSha256: sha256(String(item.assignment?.objective ?? '')),
              stageId: typeof item.assignment?.stageId === 'string' ? item.assignment.stageId : undefined,
            });
          }
          return finishItem(item, {
            ...syntheticResult('skipped_unresolved_writer', 'Not submitted: an earlier writer in this batch has an unresolved outcome, so the workspace may still change.', { contextId: item.contextId }),
            effects: 'none',
          });
        }),
      };
    }
    // Operator hold: submit nothing. The batch (with its pending items) is kept so a resume continues it.
    if (holdOf(state)) return { ...update, batch };
    const targets = batch.parallel
      ? batch.items.filter((item) => item.state === 'pending')
      : batch.items.filter((item) => item.state === 'pending').slice(0, 1);
    if (state.unresolvedWriters.length > 0 && targets.some((item) => item.sandbox !== 'read-only')) {
      throw new Error(`Writable dispatch refused: ${state.unresolvedWriters.length} writer outcome(s) are unresolved`);
    }
    // An abort during submit leaves the item submitted with an unknown task so collect can cancel it.
    const settled = await Promise.allSettled(targets.map((item) => submitItem(item, signal, state.settings).catch((error) => {
      if (error?.name === 'AbortError') return { ...item, state: 'submitted', taskId: null };
      throw error;
    })));
    const failure = settled.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
    const byId = new Map(settled.map((entry) => [entry.value.assignmentId, entry.value]));
    return { ...update, batch: { ...batch, items: batch.items.map((item) => byId.get(item.assignmentId) || item) } };
  }

  async function pollItem(item, runtime) {
    const { signal } = runtime;
    const client = await deps.clientFor(item.role);
    let taskId = item.taskId;
    try {
      throwIfAborted(signal);
      if (!taskId) {
        const found = await findTask(client, item.contextId, signal);
        if (!found) return finishItem(item, syntheticResult('outcome_unknown', 'No A2A task exists for this assignment.', { contextId: item.contextId }));
        taskId = found.id;
        journal.recordSubmitted(item.attemptId, taskId);
      }
      let task;
      while (true) {
        throwIfAborted(signal);
        try {
          task = await abortable(client.getTask({ id: taskId, historyLength: 20 }, requestOptions(signal)), signal);
        } catch (error) {
          if (error?.name !== 'AbortError' && isNotFoundError(error)) task = null;
          else throw error;
        }
        if (!task) return finishItem({ ...item, taskId }, syntheticResult('outcome_unknown', `A2A task ${taskId} was not found.`, { taskId, contextId: item.contextId }));
        if (isTaskFinished(task)) break;
        await wait(pollIntervalMs, signal);
      }
      return finishItem({ ...item, taskId }, assignmentResult(task));
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        const stopped = await deps.cancelUntilConfirmed(client, taskId, item.contextId);
        const result = assignmentResult(stopped);
        return finishItem({ ...item, taskId }, { ...result, status: taskStateName(stopped?.status?.state) });
      }
      // Transient poll failures must not finalize the outcome: crash so the run stays resumable.
      throw error;
    }
  }

  async function collect(state, config) {
    const runtime = runtimeOf(config);
    const waiting = state.batch.items.filter((item) => item.state === 'submitted');
    const settled = await Promise.allSettled(waiting.map((item) => pollItem(item, runtime)));
    const failure = settled.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
    const byId = new Map(settled.map((entry) => [entry.value.assignmentId, entry.value]));
    const batch = { ...state.batch, items: state.batch.items.map((item) => byId.get(item.assignmentId) || item) };
    return { batch, ...(runtime.signal?.aborted ? { status: 'canceled', text: CANCELED_TEXT } : {}) };
  }

  // Delta check of a succeeded gate stage (lean route). Fails closed: any unknown input promotes.
  async function gateReasons(stage, outcome, delta, routing) {
    const trusted = delta && delta.known === true && delta.headChanged !== true && Array.isArray(delta.changedPaths);
    let lines = null;
    if (trusted && delta.changedPaths.length > 0 && typeof deps.deltaLines === 'function') {
      try { lines = await deps.deltaLines(delta.changedPaths); } catch (_) { lines = null; }
    }
    return evaluateImplementDelta({
      allowedFiles: stage.allowedFiles, delta, lines, report: outcome.report, limits: routing.limits,
    }).reasons;
  }

  async function verify(state, config) {
    const runtime = runtimeOf(config);
    const finished = state.batch.items.filter((item) => item.state === 'finished');
    const summaries = finished.map((item) => outcomeSummary(item));
    const open = [...state.openDecisions];
    for (const outcome of summaries) {
      if (outcome.report?.outcome === 'needs_decision' && !open.some((entry) => entry.id === outcome.attemptId)) {
        open.push({ id: outcome.attemptId, role: outcome.role, assignmentId: outcome.assignmentId, request: outcome.report.decisionRequest });
      }
    }
    for (const outcome of summaries) deps.emit(runtime.onEvent, { type: 'assignment', round: state.batch.round, ...outcome });
    deps.emit(runtime.onEvent, { type: 'round', round: state.batch.round, outcomes: summaries });
    const unresolvedWriters = [...state.unresolvedWriters];
    for (const item of finished) {
      if (item.sandbox === 'read-only' || isSettledWriter(item.result)) continue;
      if (unresolvedWriters.some((entry) => entry.attemptId === item.attemptId)) continue;
      unresolvedWriters.push({
        attemptId: item.attemptId,
        assignmentId: item.assignmentId,
        role: item.role,
        contextId: item.result.contextId || item.contextId || null,
        taskId: item.result.taskId || item.taskId || null,
        allowedFiles: Array.isArray(item.assignment?.allowedFiles) ? item.assignment.allowedFiles : [],
        cause: item.result.status === 'outcome_unknown' ? 'outcome_unknown'
          : (item.result.failureKind || (item.result.writerExecution?.state ? `writer_${item.result.writerExecution.state}` : 'no_writer_execution')),
      });
    }
    const limited = summaries.some((outcome) => outcome.failureKind === 'usage_limit');
    let stageUpdate = {};
    if (state.plan) {
      const stageStatuses = { ...state.stageStatuses };
      finished.forEach((item, index) => {
        const stageId = item.assignment?.stageId;
        if (typeof stageId !== 'string' || !state.plan.stages.some((stage) => stage.stageId === stageId)) return;
        const entry = stageStatuses[stageId] || { status: 'pending', attemptIds: [] };
        if (entry.status === 'skipped') return;
        const attemptIds = entry.attemptIds.includes(item.attemptId) ? entry.attemptIds : [...entry.attemptIds, item.attemptId];
        stageStatuses[stageId] = { status: isStageSuccess(summaries[index]) ? 'succeeded' : 'failed', attemptIds };
      });
      stageUpdate = { stageStatuses };
      const routing = routingOf(state.plan);
      if (routing.effective === 'lean' && !state.routePromotion) {
        const reasons = [];
        for (let index = 0; index < finished.length; index += 1) {
          const stageId = finished[index].assignment?.stageId;
          if (!routing.gateStageIds.includes(stageId)) continue;
          if (stageStatuses[stageId]?.status !== 'succeeded') reasons.push('stage_not_succeeded');
          else if (!unresolvedWriters.some((entry) => entry.attemptId === finished[index].attemptId)) {
            const stage = state.plan.stages.find((entry) => entry.stageId === stageId);
            reasons.push(...await gateReasons(stage, summaries[index], summaries[index].writerExecution?.delta || null, routing));
          }
        }
        const promotion = mergePromotion(state.routePromotion, reasons, 'implement');
        if (promotion) stageUpdate.routePromotion = promotion;
      }
    }
    return {
      ...stageUpdate,
      outcomes: [...state.outcomes, ...summaries],
      openDecisions: open,
      unresolvedWriters,
      batch: null,
      ...(limited ? { budget: { source: 'worker' } } : {}),
    };
  }

  // Deterministic settlement of one unresolved writer: no model, only admission facts.
  async function settleEntry(entry, signal) {
    const base = { kind: 'reconciliation', attemptId: entry.attemptId, assignmentId: entry.assignmentId, role: entry.role };
    const unresolved = (reason) => ({ ...base, state: 'unresolved', changedPaths: [], deltaKnown: false, reason });
    if (!admission) return unresolved('no_admission');
    const settledRow = (row, reason) => ({
      ...base,
      state: 'reconciled',
      changedPaths: Array.isArray(row.delta?.changedPaths) ? row.delta.changedPaths : [],
      deltaKnown: row.delta?.known === true,
      ...(row.delta?.headChanged === true ? { headChanged: true } : {}),
      reason,
    });
    try {
      let row = entry.contextId ? admission.findByContextId(entry.contextId) : null;
      if (!row) {
        if (!entry.contextId) return unresolved('no_context_id');
        row = admission.fence(entry.contextId, 'lead_reconcile')?.execution || null;
        if (!row) {
          // A task existed but no execution row does (checkpoint predates writer admission): the writer may have run.
          if (entry.taskId) return { ...base, state: 'legacy_unverified', changedPaths: [], deltaKnown: false, reason: 'no_execution_record' };
          return { ...base, state: 'never_executed', changedPaths: [], deltaKnown: true, reason: 'fenced_before_execution' };
        }
      }
      const deadline = Date.now() + reconcileWaitMs;
      for (;;) {
        throwIfAborted(signal);
        row = admission.get(row.executionId) || row;
        if (row.state === 'released' || row.state === 'reconciled') return settledRow(row, `execution ${row.state}`);
        if (row.state === 'unresolved') {
          const outcome = await admission.reconcile(row.executionId);
          const after = admission.get(row.executionId);
          if (after && (after.state === 'released' || after.state === 'reconciled')) return settledRow(after, 'reconciled by server');
          return unresolved(outcome?.reason || after?.reason || 'quiescence_unproven');
        }
        if (row.state !== 'active') return unresolved(`unexpected_state_${row.state}`);
        if (Date.now() >= deadline) return unresolved('still_active');
        await wait(pollIntervalMs, signal);
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return unresolved(`reconcile_error: ${errorText(error)}`);
    }
  }

  async function reconcile(state, config) {
    const runtime = runtimeOf(config);
    // Everything before interrupt() re-runs on resume; settling is idempotent and outcomes are returned once.
    for (;;) {
      const results = [];
      for (const entry of state.unresolvedWriters) results.push(await settleEntry(entry, runtime.signal));
      const stuck = results.filter((result) => result.state === 'unresolved');
      if (stuck.length === 0) {
        const attested = results.map((result, index) => {
          const allowed = state.unresolvedWriters[index].allowedFiles;
          return {
            ...result,
            attestedScopeViolations: Array.isArray(allowed) ? outsideAllowed(result.changedPaths, allowed, workspace) : [],
          };
        });
        for (const result of attested) deps.emit(runtime.onEvent, { type: 'reconciliation', round: state.round, ...result });
        const update = { outcomes: [...state.outcomes, ...attested], unresolvedWriters: [] };
        const routing = routingOf(state.plan);
        if (routing.effective === 'lean' && !state.routePromotion) {
          const reasons = [];
          for (const result of attested) {
            const stage = state.plan.stages.find((entry) => routing.gateStageIds.includes(entry.stageId)
              && state.stageStatuses?.[entry.stageId]?.status === 'succeeded'
              && (state.stageStatuses[entry.stageId].attemptIds || []).includes(result.attemptId));
            const original = stage && state.outcomes.find((outcome) => outcome.kind !== 'reconciliation' && outcome.attemptId === result.attemptId);
            if (!original) continue;
            const delta = { known: result.deltaKnown === true, headChanged: result.headChanged === true, changedPaths: result.changedPaths };
            reasons.push(...await gateReasons(stage, original, delta, routing));
          }
          const promotion = mergePromotion(state.routePromotion, reasons, 'implement');
          if (promotion) update.routePromotion = promotion;
        }
        return update;
      }
      const value = { kind: 'writer_unresolved', attempts: stuck.map((result) => ({ attemptId: result.attemptId, role: result.role, reason: result.reason })) };
      value.message = pauseMessage(value);
      interrupt(value);
    }
  }

  async function humanInput(state) {
    const request = state.humanRequest;
    const answer = interrupt({ kind: 'human_decision', ...request });
    const related = new Set(request.relatedDecisionIds || []);
    return {
      humanAnswers: [...state.humanAnswers, {
        decisionId: request.decisionId,
        answer: answer.answer,
        ...(answer.choice ? { choice: answer.choice } : {}),
      }],
      openDecisions: state.openDecisions.filter((entry) => !related.has(entry.id)),
      closedDecisions: [...state.closedDecisions, ...[...related].map((id) => ({ id, by: 'human', choice: answer.choice || '' }))],
      humanRequest: null,
    };
  }

  async function operatorHold(state) {
    const stop = () => ({ status: 'canceled', reason: 'operator_stop', text: CANCELED_TEXT });
    // Everything before interrupt() re-runs on resume, so it must stay side-effect free.
    if (holdOf(state) === 'stop') return stop();
    const value = { kind: 'operator_pause' };
    value.message = pauseMessage(value);
    interrupt(value);
    if (holdOf(state) === 'stop') return stop();
    return {};
  }

  async function budgetPause(state) {
    // Everything before interrupt() re-runs on resume, so it must stay side-effect free.
    let resetsAt = null;
    try { resetsAt = resetsAtHint(await appServer.readRateLimits?.()); } catch (_) { /* hint only */ }
    const value = { kind: 'waiting_for_budget', source: state.budget.source, resetsAt };
    value.message = pauseMessage(value);
    interrupt(value);
    return { budget: null };
  }

  // One entry per writable attempt; a reconciliation outcome overrides the original delta.
  function acceptanceWriters(state) {
    const reconciled = new Map();
    for (const outcome of state.outcomes) if (outcome.kind === 'reconciliation') reconciled.set(outcome.attemptId, outcome);
    return state.outcomes.filter((outcome) => outcome.kind !== 'reconciliation' && outcome.sandbox !== 'read-only').map((outcome) => {
      const later = reconciled.get(outcome.attemptId);
      return {
        attemptId: outcome.attemptId,
        role: outcome.role,
        // A reconciled execution row proves the writer ran even when its task carried no writerExecution.
        ran: (outcome.writerExecution != null && outcome.effects !== 'none') || later?.state === 'reconciled' || later?.state === 'legacy_unverified',
        completed: outcome.status === 'TASK_STATE_COMPLETED',
        reportValid: outcome.report != null,
        reportedScopeViolations: outcome.scopeViolations || [],
        attestedScopeViolations: later ? (later.attestedScopeViolations || []) : (outcome.attestedScopeViolations || []),
        deltaKnown: later ? later.deltaKnown === true : outcome.attestedDeltaKnown === true,
      };
    });
  }

  async function assess(state, signal) {
    const writers = acceptanceWriters(state);
    const unresolvedWriterCount = state.unresolvedWriters.length;
    const snapshot = deps.snapshot;
    const checks = state.contract?.requiredChecks || [];
    if (checks.length === 0) {
      return assessWithoutChecks({ workspace, writers, unresolvedWriterCount, ...(snapshot ? { snapshot } : {}) });
    }
    return runAcceptance({
      workspace,
      runId: state.runId,
      attempt: state.acceptanceAttempts + 1,
      contract: state.contract,
      writers,
      unresolvedWriterCount,
      admission: deps.admission,
      runCheckImpl: deps.runCheckImpl,
      signal,
      ...(snapshot ? { snapshot } : {}),
    });
  }

  // Deterministic acceptance of a finish decision. The lead's final text never changes the disposition.
  async function accept(state, config) {
    const runtime = runtimeOf(config);
    throwIfAborted(runtime.signal);
    let acceptance;
    try {
      acceptance = await assess(state, runtime.signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const detail = errorText(error);
      acceptance = {
        disposition: 'unverifiable',
        reasons: [{ code: 'acceptance_error', detail }],
        issues: [{ code: 'acceptance_error', detail }],
        candidate: { kind: null, head: null, fingerprint: null },
        candidateAfter: { fingerprint: null },
        checks: [],
        requiredCheckIds: (state.contract?.requiredChecks || []).map((check) => check.id),
        verifiedAt: new Date().toISOString(),
        admissionHeld: false,
      };
    }
    deps.emit(runtime.onEvent, { type: 'acceptance', round: state.round, disposition: acceptance.disposition, reasons: acceptance.reasons });
    const promotion = acceptance.disposition !== 'accepted' && routingOf(state.plan).effective === 'lean'
      ? mergePromotion(state.routePromotion, [`acceptance_${acceptance.disposition}`], 'accept')
      : null;
    const promoted = promotion ? { routePromotion: promotion } : {};
    if (acceptance.disposition === 'rejected' && state.acceptanceAttempts < 1) {
      return { acceptance, acceptanceAttempts: state.acceptanceAttempts + 1, status: null, text: '', ...promoted };
    }
    return { acceptance, ...promoted };
  }

  async function finish(state) {
    let acceptance = state.acceptance;
    if (!acceptance) {
      // Canceled, max_rounds or failed before any acceptance run: report what is known without running checks.
      const checks = state.contract?.requiredChecks || [];
      if (checks.length > 0) {
        const detail = 'The run ended before the required checks were run.';
        acceptance = {
          disposition: 'unverifiable',
          reasons: [{ code: 'acceptance_not_run', detail }],
          issues: [{ code: 'acceptance_not_run', detail }],
          candidate: { kind: null, head: null, fingerprint: null },
          candidateAfter: { fingerprint: null },
          checks: [],
          requiredCheckIds: checks.map((check) => check.id),
          verifiedAt: new Date().toISOString(),
          admissionHeld: false,
        };
      } else {
        acceptance = assessWithoutChecks({
          workspace,
          writers: acceptanceWriters(state),
          unresolvedWriterCount: state.unresolvedWriters.length,
          ...(deps.snapshot ? { snapshot: deps.snapshot } : {}),
        });
      }
    }
    return {
      result: {
        runId: state.runId,
        status: state.status,
        ...(state.reason ? { reason: state.reason } : {}),
        text: state.text,
        rounds: state.round,
        assignments: state.outcomes,
        acceptance,
        ...(state.plan ? { stages: stageRows(state) } : {}),
        ...(routeResultOf(state) ? { route: routeResultOf(state) } : {}),
      },
    };
  }

  const afterDecide = (state) => {
    if (state.status === 'completed') return holdOf(state) ? 'operator_hold' : 'accept';
    if (state.status) return 'finish';
    if (state.planRetry) return toDecide(state);
    if (state.budget) return 'budget_pause';
    if (state.humanRequest) return 'human_input';
    return 'dispatch';
  };
  const afterAccept = (state) => (state.status ? 'finish' : toDecide(state));
  const afterCollect = (state) => {
    if (state.status === 'canceled') return 'verify';
    if (state.batch.items.some((item) => item.state === 'pending')) return 'dispatch';
    return 'verify';
  };
  const afterVerify = (state) => {
    if (state.status === 'canceled') return 'finish';
    if (state.unresolvedWriters.length > 0) return 'reconcile';
    if (state.budget) return 'budget_pause';
    return toDecide(state);
  };
  const afterReconcile = (state) => (state.budget ? 'budget_pause' : toDecide(state));
  const afterIntake = (state) => toDecide(state);
  const afterBudgetPause = (state) => toDecide(state);
  const afterHumanInput = (state) => toDecide(state);
  // A held dispatch submitted nothing and left pending items behind: park instead of collecting.
  const afterDispatch = (state) => {
    const items = state.batch?.items || [];
    if (holdOf(state) && !items.some((item) => item.state === 'submitted') && items.some((item) => item.state === 'pending')) return 'operator_hold';
    return 'collect';
  };
  const afterOperatorHold = (state) => {
    // A stopped mid-batch run still verifies (and reconciles) the writers it already finished.
    if (state.status === 'canceled') return state.batch ? 'verify' : 'finish';
    if (holdOf(state)) return 'operator_hold';
    if (state.status === 'completed') return 'accept';
    if (state.status) return 'finish';
    if (state.batch?.items?.some((item) => item.state === 'pending')) return 'dispatch';
    return 'decide';
  };

  const graph = new StateGraph(LeadState)
    .addNode('intake', intake)
    .addNode('decide', decide)
    .addNode('dispatch', dispatch)
    .addNode('collect', collect)
    .addNode('verify', verify)
    .addNode('reconcile', reconcile)
    .addNode('human_input', humanInput)
    .addNode('budget_pause', budgetPause)
    .addNode('operator_hold', operatorHold)
    .addNode('accept', accept)
    .addNode('finish', finish)
    .addEdge(START, 'intake')
    .addConditionalEdges('intake', afterIntake, ['decide', 'operator_hold'])
    .addConditionalEdges('decide', afterDecide, ['finish', 'accept', 'decide', 'operator_hold', 'budget_pause', 'human_input', 'dispatch'])
    .addConditionalEdges('accept', afterAccept, ['finish', 'decide', 'operator_hold'])
    .addConditionalEdges('dispatch', afterDispatch, ['collect', 'operator_hold'])
    .addConditionalEdges('collect', afterCollect, ['dispatch', 'verify'])
    .addConditionalEdges('verify', afterVerify, ['finish', 'reconcile', 'budget_pause', 'decide', 'operator_hold'])
    .addConditionalEdges('reconcile', afterReconcile, ['budget_pause', 'decide', 'operator_hold'])
    .addConditionalEdges('human_input', afterHumanInput, ['decide', 'operator_hold'])
    .addConditionalEdges('budget_pause', afterBudgetPause, ['decide', 'operator_hold'])
    .addConditionalEdges('operator_hold', afterOperatorHold, ['finish', 'verify', 'dispatch', 'decide', 'operator_hold', 'accept'])
    .addEdge('finish', END);

  return deps.checkpointer ? graph.compile({ checkpointer: deps.checkpointer }) : graph;
}

module.exports = {
  buildLeadGraph,
  LeadState,
  CANCELED_TEXT,
  abortError,
  throwIfAborted,
  abortable,
  wait,
  isTerminalTask,
  isTaskFinished,
  taskStateName,
  pauseMessage,
};
