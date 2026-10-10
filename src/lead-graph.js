'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  Annotation, StateGraph, START, END, interrupt,
} = require('@langchain/langgraph');
const { Role: A2ARole, TaskState } = require('@a2a-js/sdk');
const {
  DECISION_SCHEMA, WORKER_REPORT_CONTRACT, validateDecision, BoundaryViolation, parseWorkerReport, classifyCodexError, executionGroups,
} = require('./contracts');
const {
  runAcceptance, assessWithoutChecks, unrunAcceptance, validateAgentChecks, AGENT_CHECK_TOOLS, currentPins, repinChecks, describePinChanges,
} = require('./acceptance');
const { assignmentId: makeAssignmentId, attemptId: makeAttemptId, deterministicContextId } = require('./durable-store');
const { loadSkillCatalog, findSkillCandidates, resolveSkillSelection } = require('./skill-catalog');
const { canonicalRoleId, getRole, roleDisplayName } = require('./role-names');

const DEFAULT_RECONCILE_WAIT_MS = 30_000;
const MAX_OUTCOME_TEXT_CHARS = 12_000;
const MAX_STATUS_TEXT_CHARS = 2_000;
const MAX_REPORT_CHARS = 100_000;
// Lead projection caps (docs/evidence-artifact-contract.md, "Lead projection").
const MAX_VIOLATION_PATHS = 50;
const MAX_PROMPT_OUTCOMES_CHARS = 60_000;
// SES-01: context size (input of the last model request) above which the session starts a new lead thread.
const DEFAULT_LEAD_ROLLOVER_TOKENS = 150_000;
const ROLLOVER_WINDOW_FRACTION = 0.6;
const DELTA_REMINDER = 'The rules, roles, and output format from the start of this thread still apply. Return only one JSON object matching the supplied schema. Give workers exact paths with line ranges and established facts in inputs/evidence; do not read large files yourself, dispatch an explorer for broad reading.';
const TEXT_PROJECTION_HEAD = 6000;
const TEXT_PROJECTION_TAIL = 2000;
const TEXT_EVIDENCE_THRESHOLD = TEXT_PROJECTION_HEAD + TEXT_PROJECTION_TAIL;
const DIGEST_SUMMARY_CHARS = 300;
const REPORT_CAPS = { filesChanged: 100, filesInspected: 20, risks: 20, checks: 20, scopeExpansion: 20 };
const REPORT_ITEM_CHARS = 500;
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const CANCELED_TEXT = 'Canceled after all active A2A tasks were confirmed stopped.';
const REPORT_CONTRACT_LINE = `Reply with a single JSON object matching the ${WORKER_REPORT_CONTRACT} report schema `
  + '(outcome, summary, filesChanged, filesInspected, checks, risks, scopeExpansion, decisionRequest). '
  + 'Use outcome needs_decision with a decisionRequest only after checking the evidence yourself.';

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
// `onOversize({ artifactTexts, joined, parseText, completed })` is called with the uncut texts when
// any exceeds MAX_REPORT_CHARS; the extras it returns are merged into the result.
function assignmentResult(task, { onOversize } = {}) {
  const status = task?.status;
  const statusMessage = extractTextParts(status?.message?.parts).slice(0, MAX_STATUS_TEXT_CHARS);
  const sourceArtifacts = (task?.artifacts || []).slice(0, 20);
  const artifactTexts = sourceArtifacts.map((artifact) => extractTextParts(artifact.parts));
  const artifacts = sourceArtifacts.map((artifact, index) => ({
    name: artifact.name || '',
    description: artifact.description || '',
    text: artifactTexts[index].slice(0, MAX_REPORT_CHARS),
    metadata: artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : null,
  }));
  const history = (task?.history || []).slice(-5).map((message) => extractTextParts(message.parts).slice(0, MAX_STATUS_TEXT_CHARS)).filter(Boolean);
  const joined = artifactTexts.filter(Boolean).join('\n');
  const text = joined || statusMessage || history.at(-1) || '';
  const failureKind = status?.message?.metadata?.failureKind;
  const writerExecution = artifacts.map((artifact) => artifact.metadata?.writerExecution).find((entry) => entry && typeof entry === 'object')
    || (status?.message?.metadata?.writerExecution && typeof status.message.metadata.writerExecution === 'object' ? status.message.metadata.writerExecution : null);
  const effects = status?.message?.metadata?.effects;
  // The thread data of a finished turn: failure metadata, else the result artifact's metadata.
  const continuation = status?.message?.metadata?.continuation
    ?? artifacts.map((artifact) => artifact.metadata?.continuation).find((entry) => entry && typeof entry === 'object');
  const stateName = taskStateName(status?.state);
  const extras = typeof onOversize === 'function' && (artifactTexts.some((value) => value.length > MAX_REPORT_CHARS) || text.length > MAX_REPORT_CHARS)
    ? onOversize({ artifactTexts, joined: text, parseText: artifactTexts[0] || text, completed: stateName === 'TASK_STATE_COMPLETED', lanePath: lanePathOf(writerExecution) })
    : null;
  return {
    taskId: task?.id || null,
    contextId: task?.contextId || null,
    status: stateName,
    statusMessage,
    artifacts,
    history,
    text: text.slice(0, MAX_REPORT_CHARS),
    ...(typeof failureKind === 'string' ? { failureKind } : {}),
    ...(writerExecution ? { writerExecution } : {}),
    ...(typeof effects === 'string' ? { effects } : {}),
    ...(continuation && typeof continuation === 'object' && !Array.isArray(continuation) ? { continuation } : {}),
    ...(extras || {}),
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
function readPinned({ roles, leadRole, workspace, skillCatalog }) {
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
    skills: [...(skillCatalog || new Map()).values()].map(({ id, sha256: hash }) => ({ id, sha256: hash }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// Per-role profile hash pinned into each attempt's boundary contract.
function roleProfileSha256(role) {
  return sha256(JSON.stringify([role.name, role.sandbox, role.model, role.effort, role.instructions || '']));
}

const BOUNDARY_CONTRACT_ID = 'boundary-contract/v1';

function settlementRecord(predicate, result, code, detail, { advisory = false, evidence = [] } = {}) {
  return { predicate, result, code, boundary: 'settlement', detail: String(detail).slice(0, 500), evidence, advisory };
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
  const priorSkills = new Map((previous.skills || []).map((entry) => [entry.id, entry.sha256]));
  const currentSkills = new Map((current.skills || []).map((entry) => [entry.id, entry.sha256]));
  for (const [id, hash] of currentSkills) {
    if (!priorSkills.has(id)) notes.push(`Skill ${id} was added since the run started.`);
    else if (priorSkills.get(id) !== hash) notes.push(`Skill ${id} changed since the run started.`);
  }
  for (const id of priorSkills.keys()) if (!currentSkills.has(id)) notes.push(`Skill ${id} was removed since the run started.`);
  return notes;
}

// A writer lane that never reached the shared workspace: no execution row and not integrated.
function isUnintegratedLane(writerExecution) {
  return Boolean(writerExecution) && !writerExecution.executionId && writerExecution.lane?.state === 'not_integrated';
}

function lanePathOf(writerExecution) {
  const value = writerExecution?.lane?.workspacePath;
  return typeof value === 'string' && value ? value.replace(/\/+$/, '') : null;
}

// lanePath: worker-reported paths may be prefixed with the lane's workspace path instead of the shared one.
function normalizeRel(file, workspace, lanePath = null) {
  let value = String(file).replace(/\\/g, '/');
  if (lanePath && value.startsWith(`${lanePath}/`)) value = value.slice(lanePath.length + 1);
  else if (workspace && value.startsWith(`${workspace}/`)) value = value.slice(workspace.length + 1);
  return path.posix.normalize(value).replace(/^\.\//, '');
}

// Paths outside allowedFiles (exact file or directory prefix).
function outsideAllowed(files, allowedFiles, workspace, lanePath = null) {
  const allowed = allowedFiles.map((file) => normalizeRel(file, workspace).replace(/\/+$/, ''));
  return files.filter((file) => {
    const rel = normalizeRel(file, workspace, lanePath);
    return !allowed.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
  });
}

// Reported filesChanged outside allowedFiles.
function scopeViolations(report, allowedFiles, workspace, lanePath = null) {
  if (!report) return [];
  return outsideAllowed(report.filesChanged, allowedFiles, workspace, lanePath);
}

// Caps a path list; reports the cut through `omitted` and returns the total as `count`.
function capPaths(list, field, omitted) {
  const total = list.length;
  if (total <= MAX_VIOLATION_PATHS) return { paths: list, count: total };
  omitted.push({ field, kept: MAX_VIOLATION_PATHS, total });
  return { paths: list.slice(0, MAX_VIOLATION_PATHS), count: total };
}

// Deterministic projection of a valid report with the rule-2 caps; the input is not modified.
function projectReport(report, omitted) {
  const out = { ...report };
  for (const [field, cap] of Object.entries(REPORT_CAPS)) {
    const list = Array.isArray(report[field]) ? report[field] : [];
    if (list.length > cap) omitted.push({ field, kept: cap, total: list.length });
    out[field] = list.slice(0, cap);
  }
  const trim = (items, field, key) => {
    let longest = 0;
    const next = items.map((item) => {
      const value = key ? item[key] : item;
      if (typeof value !== 'string' || value.length <= REPORT_ITEM_CHARS) return item;
      longest = Math.max(longest, value.length);
      return key ? { ...item, [key]: value.slice(0, REPORT_ITEM_CHARS) } : value.slice(0, REPORT_ITEM_CHARS);
    });
    // kept is the per-item char cap and total the longest original item.
    if (longest > 0) omitted.push({ field, kept: REPORT_ITEM_CHARS, total: longest });
    return next;
  };
  out.risks = trim(out.risks, 'risks[]', null);
  out.checks = trim(out.checks, 'checks[].detail', 'detail');
  out.scopeExpansion = trim(out.scopeExpansion, 'scopeExpansion[].reason', 'reason');
  return out;
}

// First 6000 and last 2000 chars around a marker line; short text is returned unchanged.
function projectText(text, evidenceId, omitted) {
  if (text.length <= TEXT_EVIDENCE_THRESHOLD) return text;
  omitted.push({ field: 'text', kept: TEXT_EVIDENCE_THRESHOLD, total: text.length });
  const gone = text.length - TEXT_EVIDENCE_THRESHOLD;
  const marker = `\n[... ${gone} chars omitted${evidenceId ? `; evidence ${evidenceId}` : ''}]\n`;
  return text.slice(0, TEXT_PROJECTION_HEAD) + marker + text.slice(-TEXT_PROJECTION_TAIL);
}

/**
 * Bounded view of one parsed worker result. Scope violations come from the full report; the report
 * and the failure text are projected. ctx = { fullText, allowedFiles, workspace, textRef, store(kind,
 * mediaType, content, summary) -> { ref, error } }. Returns the projected parts plus evidence refs.
 */
function analyzeWorker(parsed, ctx) {
  const omitted = [];
  const evidence = ctx.textRef ? [ctx.textRef] : [];
  const errors = ctx.textRef?.error ? [ctx.textRef.error] : [];
  const keep = ({ ref, error }) => { if (ref) evidence.push(ref); if (error) errors.push(error); };
  let report = null;
  let violations = { paths: [], count: 0 };
  let text;
  if (parsed.report) {
    const full = scopeViolations(parsed.report, ctx.allowedFiles, ctx.workspace, ctx.lanePath || null);
    violations = capPaths(full, 'scopeViolations', omitted);
    report = projectReport(parsed.report, omitted);
    if (omitted.length > 0 && !ctx.textRef) {
      const json = JSON.stringify(parsed.report);
      keep(ctx.store('worker_result_text', 'application/json', json,
        `Full worker report (${json.length} chars); the lead prompt carries a capped projection.`));
    }
  } else {
    const full = ctx.fullText || '';
    let id = ctx.textRef?.id || null;
    if (full.length > TEXT_EVIDENCE_THRESHOLD && !ctx.textRef) {
      const stored = ctx.store('worker_result_text', 'text/plain; charset=utf-8', full,
        `Worker result text without a valid report (${full.length} chars); the lead prompt carries the first ${TEXT_PROJECTION_HEAD} and last ${TEXT_PROJECTION_TAIL} chars.`);
      keep(stored);
      id = stored.ref?.id || null;
    }
    text = projectText(full, id, omitted);
  }
  return {
    report, reportError: parsed.error, ...(text !== undefined ? { text } : {}),
    scopeViolations: violations.paths, scopeViolationCount: violations.count, omitted, evidence,
    ...(errors.length > 0 ? { evidenceError: errors[0] } : {}),
  };
}

// Diagnostics that no projection or digest may drop (contract rule 5).
// Compact lane view for the lead: why changes were not integrated and where the lane is kept.
function laneSummary(lane) {
  const cap = (list) => (Array.isArray(list) ? list.slice(0, MAX_VIOLATION_PATHS) : []);
  return {
    state: lane.state ?? null,
    reason: lane.reason ?? null,
    conflicts: cap(lane.conflicts),
    scopeViolations: cap(lane.scopeViolations),
    unsafePaths: cap(lane.unsafePaths),
    path: lane.path ?? null,
  };
}

function outcomeDiagnostics(outcome) {
  const changed = Array.isArray(outcome.writerExecution?.delta?.changedPaths) ? outcome.writerExecution.delta.changedPaths : [];
  return {
    status: outcome.status ?? null,
    failureKind: outcome.failureKind ?? null,
    reportError: outcome.reportError ?? null,
    scopeViolations: outcome.scopeViolations || [],
    scopeViolationCount: outcome.scopeViolationCount ?? (outcome.scopeViolations || []).length,
    attestedScopeViolations: outcome.attestedScopeViolations || [],
    attestedScopeViolationCount: outcome.attestedScopeViolationCount ?? (outcome.attestedScopeViolations || []).length,
    attestedDeltaKnown: outcome.attestedDeltaKnown === true,
    writerExecutionState: outcome.writerExecution?.state ?? null,
    writerDeltaKnown: outcome.writerExecution?.delta?.known ?? null,
    changedPathCount: outcome.writerExecution?.delta?.changedPathCount ?? changed.length,
    changedPaths: changed.slice(0, MAX_VIOLATION_PATHS),
    effects: outcome.effects ?? null,
    ...(outcome.lane ? { lane: outcome.lane } : {}),
    failure: outcome.failure ?? null,
  };
}

function outcomeDigest(outcome, { compact = false } = {}) {
  const diagnostics = outcomeDiagnostics(outcome);
  if (compact) {
    // Last resort: paths shrink to a handful, every status field and count stays.
    for (const field of ['scopeViolations', 'attestedScopeViolations', 'changedPaths']) diagnostics[field] = diagnostics[field].slice(0, 5);
    if (diagnostics.lane) {
      diagnostics.lane = { ...diagnostics.lane };
      for (const field of ['conflicts', 'scopeViolations', 'unsafePaths']) diagnostics.lane[field] = diagnostics.lane[field].slice(0, 5);
    }
    if (typeof diagnostics.reportError === 'string') diagnostics.reportError = diagnostics.reportError.slice(0, 300);
  }
  return {
    digest: true,
    assignmentId: outcome.assignmentId ?? null,
    attemptId: outcome.attemptId ?? null,
    role: outcome.role ?? null,
    status: outcome.status ?? outcome.state ?? null,
    outcome: outcome.report?.outcome ?? null,
    summary: String(outcome.report?.summary ?? outcome.text ?? '').slice(0, DIGEST_SUMMARY_CHARS),
    diagnostics,
    boundary: (outcome.boundary?.results || []).map(({ predicate, result, code }) => ({ predicate, result, code })),
    evidence: (outcome.evidence || []).map((ref) => ref.id),
  };
}

function elisionEntry(outcome) {
  const codes = (outcome.boundary?.results || []).filter((entry) => entry.advisory !== true).map((entry) => entry.code);
  return {
    elided: true,
    assignmentId: outcome.assignmentId ?? null,
    attemptId: outcome.attemptId ?? null,
    role: outcome.role ?? null,
    status: outcome.status ?? outcome.state ?? null,
    violationCodes: [...new Set(codes.filter((code) => typeof code === 'string'))],
  };
}

// Outcome JSON for the lead prompt: newest outcomes in full while they fit, older ones as digests.
function boundedOutcomes(outcomes, limit = MAX_PROMPT_OUTCOMES_CHARS) {
  const size = (value) => JSON.stringify(value).length + 1;
  if (size(outcomes) + 1 <= limit) return outcomes;
  const picked = new Array(outcomes.length);
  let used = 200; // headroom for the elision note
  // Reconciliation outcomes are small and always kept in full.
  outcomes.forEach((outcome, index) => { if (outcome.kind === 'reconciliation') { picked[index] = outcome; used += size(outcome); } });
  const unfit = [];
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    if (picked[index]) continue;
    const full = outcomes[index];
    const candidates = [() => full, () => outcomeDigest(full), () => outcomeDigest(full, { compact: true })];
    // Only the newest outcome may stay full when it fits; once one is digested, older ones are digests.
    const start = picked.slice(index + 1).some((entry) => entry?.digest) ? 1 : 0;
    const fit = candidates.slice(start).map((make) => make()).find((candidate) => used + size(candidate) <= limit);
    if (fit) { picked[index] = fit; used += size(fit); } else { unfit.push(index); }
  }
  // Outcomes that do not fit even as compact digests shrink to an elision entry (identity, status,
  // blocking violation codes); only when those do not fit either does a bare count remain.
  let elided = 0;
  for (const index of unfit) {
    const entry = elisionEntry(outcomes[index]);
    if (used + size(entry) <= limit) { picked[index] = entry; used += size(entry); } else { elided += 1; }
  }
  const result = picked.filter(Boolean);
  if (elided > 0) result.unshift({ digest: true, elided, note: 'Older outcomes were elided to fit the prompt bound.' });
  return result;
}

// A writer outcome is settled when the server proved the execution ended or nothing ran.
function isSettledWriter(result) {
  const state = result?.writerExecution?.state;
  // The lane comes from the artifact's writerExecution, so a COMPLETED task (no status message) counts too.
  return state === 'released' || state === 'reconciled' || result?.effects === 'none' || isUnintegratedLane(result?.writerExecution);
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
  const hint = value?.resetsAt ? ` The usage window may reset around ${value.resetsAt} (a hint only).` : '';
  return `Waiting for Codex usage budget (${value?.source || 'unknown'} turn hit a usage limit).${hint} Send a message to this task to resume once budget is available.`;
}

// ------------------------------------------------------------ the graph

const MAX_AUTO_REJECTIONS = 2;
const MAX_CONTINUATIONS = 2;
const MAX_ESCALATION_QUESTION_CHARS = 3000;
// LL-1: owner choices when the lead finishes without reaching the goal or the round limit is reached.
const ESCALATION_OPTIONS = [
  { id: 'continue', description: 'Continue: another bounded attempt, with your answer as a note to the lead' },
  { id: 'accept_as_is', description: 'Accept as is: finish now with the current result (acceptance still runs)' },
  { id: 'change_goal', description: 'Change goal: your answer replaces the goal, with a fresh round budget' },
];
const ESCALATION_CHOICES = ESCALATION_OPTIONS.map((option) => option.id);
// LL-6: automatic round extensions never take the limit past this cap; beyond it the owner decides.
const ROUND_CAP = 18;
const GOAL_INVESTIGATION_ROUNDS = 3;
const MAX_PROGRESS_ENTRIES = 50;
const OWNER_ONLY_RULE = 'Owner-only decisions are a closed list (humanInput.reason): paid_resources (spending money or paid resources beyond the run), credentials_or_access (credentials and access grants), external_write (publishing or writing to external systems), irreversible_operation, and prd_requirement_change (removing or weakening a requirement the PRD states). Interpreting the PRD, fixing evidence tooling, choosing an implementation, and expanding file scope are your decisions after investigation.';
const INVESTIGATION_RULE = 'An investigation is a finished read-only outcome (explorer, auditor, scout, or architect) with a valid report from a round after the blocker first appeared (after the latest related open worker decision; for a repeated unmet-goal finish, after the first one); cite its assignmentId in humanInput.evidenceChecked or relatedDecisionIds (in final for a finish).';
// LL-6 check_changed review: a read-only reviewer judges a changed pinned check against the PRD.
const REVIEW_ROLES = ['auditor', 'architect', 'explorer', 'scout'];
const CHECK_CHANGE_OPTIONS = [
  { id: 'approve_change', description: 'Approve: the PRD requirement changes; the changed check is re-pinned' },
  { id: 'keep_requirement', description: 'Keep the requirement: the changed check fails and the lead fixes the cause' },
];
const CHECK_RULE = `acceptanceChecks entries are { id, argv, timeoutMs } (at most 10, timeoutMs null for the default); argv[0] is a script path inside the workspace or one of ${AGENT_CHECK_TOOLS.join(', ')}; bash and sh need a workspace script as argv[1]; inline code (-c, -e, --eval, -p) and echo, true, false, test, [, yes are refused.`;
const PATH_RULE = "allowedFiles entries are repository-relative paths or directory prefixes without '.', '..', globs, or a leading '/'; read-only roles may use [].";
const RULE_REMINDERS = {
  'assignment.paths': PATH_RULE,
  'assignment.writer_scope': 'Writable roles require explicit allowedFiles; read-only roles may use [].',
  'decision.parse': 'Return only one JSON object matching the supplied schema.',
  'decision.envelope': 'The JSON must contain exactly action, assignments, final, resolutions, humanInput, goalAchieved, and acceptanceChecks, with unused fields empty or null. A dispatch needs 1 to 4 assignments. If there is nothing to dispatch, use finish or request_human_input instead of an empty dispatch.',
  'decision.goal': 'finish requires goalAchieved true or false: true only when the goal is met, false with the blockers named in final. Use null for dispatch and request_human_input.',
  'decision.investigate_first': `Investigate first: dispatch a read-only explorer or auditor with the concrete question about the blocker before asking the owner. ${INVESTIGATION_RULE} ${OWNER_ONLY_RULE}`,
  'decision.acceptance_checks': `${CHECK_RULE} Use null to propose nothing.`,
  'decision.resolutions': 'Resolve every open worker decision in resolutions, or list it in humanInput.relatedDecisionIds when it is owner-only; a dispatch of only read-only roles may leave them open while you investigate them.',
  'assignment.shape': 'Each assignment needs exactly role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, stopConditions, skills, wave, and continueFrom; role must be an available role id.',
  'assignment.continue_from': 'continueFrom is null or the assignmentId of a finished outcome of this run with the same role; each such id may be used by one assignment of a decision.',
  'assignment.wave': 'wave is an integer >= 1 or null; consecutive assignments with the same wave run concurrently, and writers in one wave need pairwise disjoint allowedFiles; use null for sequential steps.',
  'assignment.skills': 'Select at most 5 unique skill IDs from the trusted listed skill IDs; use [] when none apply.',
  'assignment.role_ladder': 'Respect the role ladder: recovery-engineer follows an engineer attempt, senior-engineer follows recovery-engineer, and architect needs prior evidence and one narrow decision.',
  'dispatch.writer_unresolved': 'Do not dispatch writable roles while writer outcomes are unresolved; use read-only roles.',
};

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
  // LL-1: rounds granted by the owner on top of maxRounds, and a goal that replaces state.goal.
  extraRounds: last(() => 0),
  goalOverride: last(() => null),
  // LL-6: the first unmet-goal finish ({ round, final }), budget extensions, and progress per round.
  goalInvestigation: last(() => null),
  roundExtensions: last(() => []),
  progress: last(() => []),
  // A decide that must run again without a dispatch (the first unmet-goal finish).
  redecide: last(() => false),
  // LL-6 check_changed review: the pending review and the verdicts given.
  checkReview: last(() => null),
  checkReviews: last(() => []),
  budget: last(() => null),
  unresolvedWriters: last(() => []),
  contract: last(() => ({ requiredChecks: [] })),
  acceptanceAttempts: last(() => 0),
  acceptanceRuns: last(() => 0),
  acceptance: last(() => null),
  status: last(() => null),
  text: last(() => ''),
  result: last(() => null),
  rejections: last(() => []),
  consecutiveRejections: last(() => 0),
  retryDecide: last(() => false),
  // SES-01: the session (A2A contextId), the owner's raw new message of a follow-up run, and what
  // the lead thread in `threadId` has already been shown (outcome count, goal text). Old
  // checkpoints read the defaults: no session, so the lead behaves as before.
  contextId: last(() => null),
  newRequest: last(() => null),
  leadSeenOutcomes: last(() => 0),
  leadSeenGoal: last(() => null),
  // Usage-limited attempts of the latest batch that can be continued after the budget resume (BUD-2).
  continuable: last(() => []),
});

/**
 * deps = {
 *   appServer, roles, leadRole, workspace, maxRounds, journal, pollIntervalMs,
 *   runtimeFor(runId) -> { signal, onEvent, resumed },   // per-run, never checkpointed
 *   clientFor(roleName) -> A2A client, authOptions() -> request options,
 *   cancelUntilConfirmed(client, taskId, contextId) -> terminal task,
 *   emit(onEvent, event), checkpointer?,
 *   admission?: WriterAdmission, reconcileWaitMs?: number,
 *   sessionThreads?: SessionThreads, sessionDigest?({ contextId, runId, runIds, state }) -> string, rolloverTokens?: number,
 *   parallelWriters?: boolean, usageLedger?: UsageLedger, activityStore?: ActivityStore, evidenceStore?: EvidenceStore, runCheckImpl?, snapshot?,
 * }
 * Returns the compiled graph when deps.checkpointer is given, else the StateGraph.
 */
function buildLeadGraph(deps) {
  const {
    appServer, roles, leadRole, workspace, maxRounds, journal, pollIntervalMs,
  } = deps;
  const skillCatalog = deps.skillCatalog || loadSkillCatalog();
  const { admission } = deps;
  const reconcileWaitMs = Number.isFinite(deps.reconcileWaitMs) ? deps.reconcileWaitMs : DEFAULT_RECONCILE_WAIT_MS;

  // Threshold: the explicit setting, else 60% of the known context window, else the default.
  const rolloverThreshold = (contextWindow) => (Number.isFinite(deps.rolloverTokens) ? deps.rolloverTokens
    : Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow * ROLLOVER_WINDOW_FRACTION : DEFAULT_LEAD_ROLLOVER_TOKENS);
  const runtimeOf = (config) => deps.runtimeFor(config?.configurable?.thread_id) || {};
  const requestOptions = (signal) => ({ ...(signal ? { signal } : {}), ...deps.authOptions() });

  // Evidence writes never fail a run: a store error becomes { ref: null, error }.
  function putEvidence(input) {
    if (!deps.evidenceStore) return { ref: null, error: null };
    try {
      return { ref: deps.evidenceStore.put(input), error: null };
    } catch (error) {
      return { ref: null, error: error?.code || error?.message || 'evidence_error' };
    }
  }

  const allowedFilesOf = (item) => item.contract?.allowedFiles || item.assignment.allowedFiles;

  // LL-1: the owner extends the budget by maxRounds per continue or change_goal.
  const roundLimit = (state) => maxRounds + (state.extraRounds || 0);

  // LL-1: a human-decision pause raised by the server, not by the lead. `final` is the text an
  // accept_as_is finishes with; it stays out of the pause value.
  function escalate(state, kind, question, final) {
    return {
      humanCount: state.humanCount + 1,
      humanRequest: {
        decisionId: `${state.runId}:h${state.humanCount + 1}`,
        escalation: kind,
        reason: kind,
        question: question.slice(0, MAX_ESCALATION_QUESTION_CHARS),
        options: ESCALATION_OPTIONS.map((option) => ({ ...option })),
        recommendation: 'continue',
        evidenceChecked: [],
        independentWork: '',
        relatedDecisionIds: [],
        final,
      },
    };
  }

  // LL-4: an agent proposal as a pinned contract; a bad proposal is a rejected decision.
  function agentChecksContract(checks) {
    try {
      return validateAgentChecks(checks, { workspace });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new BoundaryViolation('decision.acceptance_checks', 'acceptance_checks_invalid', error.message);
    }
  }

  // LL-6: the round of an assignment (or review) id `${runId}:r<round>:a<index>`, or null.
  const roundOf = (id) => {
    const match = /:r(\d+):(?:a|review)\d+(?::c\d+)?$/.exec(String(id ?? ''));
    return match ? Number(match[1]) : null;
  };

  // LL-6: finished read-only outcomes with a valid report, the evidence an escalation must cite.
  const investigationsOf = (state) => state.outcomes
    .filter((outcome) => !outcome.kind && outcome.sandbox === 'read-only' && outcome.status === 'TASK_STATE_COMPLETED' && outcome.report && roundOf(outcome.assignmentId) !== null)
    .map((outcome) => ({ assignmentId: outcome.assignmentId, round: roundOf(outcome.assignmentId) }));

  const addProgress = (state, entries) => [...(state.progress || []), ...entries].slice(-MAX_PROGRESS_ENTRIES);

  // LL-6 progress: a writer whose non-empty delta reached the shared workspace.
  function integratedChange(outcome) {
    const execution = outcome.writerExecution;
    if (outcome.sandbox === 'read-only' || !execution || isUnintegratedLane(execution) || execution.lane?.state === 'not_integrated') return false;
    const count = execution.delta?.changedPathCount ?? (Array.isArray(execution.delta?.changedPaths) ? execution.delta.changedPaths.length : 0);
    return count > 0 && (execution.state === 'released' || execution.state === 'reconciled' || execution.lane?.state === 'integrated');
  }

  function reviewRole() {
    for (const id of REVIEW_ROLES) {
      const role = getRole(roles, id);
      if (role?.sandbox === 'read-only') return role;
    }
    return null;
  }

  // Splits text into strings that fit a brief array entry.
  const chunks = (text, size = 2800) => {
    const out = [];
    for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
    return out;
  };

  /**
   * LL-6 check_changed: one read-only review assignment for the checks whose pinned scripts changed. It runs
   * inside the current round (no lead round) and its verdict decides re-pin (preserve) or failure (weaken).
   */
  function startReview(state, acceptance) {
    const changedIds = new Set((acceptance.checks || []).filter((check) => check?.error === 'check_changed').map((check) => check.id));
    const role = changedIds.size > 0 ? reviewRole() : null;
    if (!role) return null;
    const checks = (state.contract?.requiredChecks || []).filter((check) => changedIds.has(check.id));
    const assignmentId = `${state.runId}:r${state.round}:review${(state.checkReviews || []).length + 1}`;
    const attemptId = makeAttemptId(assignmentId);
    const inputs = [];
    for (const check of checks) {
      inputs.push(`Pinned acceptance check "${check.id}": argv ${JSON.stringify(check.argv)}`);
      for (const change of describePinChanges(check, workspace)) {
        inputs.push(`${change.path}: pinned sha256 ${change.pinnedSha256}, current ${change.currentSha256 || 'deleted'}. ${change.note}`);
        if (change.diff) inputs.push(...chunks(change.diff));
      }
    }
    inputs.push(`Run goal (context): ${(state.goalOverride || state.goal).slice(0, 1500)}`);
    const ids = checks.map((check) => check.id).join(', ');
    const assignment = {
      role: role.name,
      objective: `Independent read-only review of changed pinned acceptance check(s) ${ids}: the files behind them changed after they were pinned. Find the requirement each check enforces in the project's PRD (or its release or gate documents) and judge whether the change preserves it (for example, measuring from real output instead of hard-coded numbers) or weakens it (for example, lower thresholds, skipped cases, or a hard-coded pass). Do not edit files. Reply with outcome completed and decisionRequest null; the first line of summary must be exactly "VERDICT: preserve" or "VERDICT: weaken", followed by the PRD requirement and your evidence. Add a line "PRD_CHANGE_REQUIRED: <reason>" only if the PRD requirement itself must change.`,
      allowedFiles: [],
      inputs: inputs.slice(0, 20),
      evidence: [`Acceptance issue check_changed for ${ids} (pinned sha256 differs from the current content).`],
      acceptanceCriteria: ['The first summary line is VERDICT: preserve or VERDICT: weaken', 'The verdict names the PRD requirement and cites the changed lines'],
      checks: ['Compare the change with the PRD requirement the check enforces'],
      stopConditions: ['Do not edit any file', 'Stop after giving the verdict'],
      skills: [],
      wave: null,
      skillPins: [],
    };
    const item = {
      runId: state.runId,
      assignmentId,
      attemptId,
      contextId: deterministicContextId(attemptId),
      role: role.name,
      sandbox: role.sandbox,
      assignment,
      group: 0,
      contract: {
        id: BOUNDARY_CONTRACT_ID, reportContract: 'worker-report/v1', allowedFiles: [], sandbox: role.sandbox, roleProfileSha256: roleProfileSha256(role), skillPins: [],
      },
      state: 'pending',
      taskId: null,
      result: null,
    };
    return {
      checkReview: {
        assignmentId, round: state.round, final: state.text, checks: checks.map((check) => ({ id: check.id, pins: currentPins(check, workspace) })),
      },
      batch: { round: state.round, parallel: true, review: true, items: [item] },
    };
  }

  // An unparseable review (no valid completed report, no single verdict line) counts as weaken.
  function parseVerdict(outcome) {
    const report = outcome?.report;
    if (!report || report.outcome !== 'completed' || report.decisionRequest) return { verdict: 'weaken', prdChange: null, parsed: false };
    const summary = String(report.summary || '');
    const verdicts = [...new Set([...summary.matchAll(/^\s*VERDICT:\s*(preserve|weaken)\s*\.?\s*$/gim)].map((match) => match[1].toLowerCase()))];
    if (verdicts.length !== 1) return { verdict: 'weaken', prdChange: null, parsed: false };
    const prd = /^\s*PRD_CHANGE_REQUIRED:\s*(\S.*)$/im.exec(summary);
    return { verdict: verdicts[0], prdChange: verdicts[0] === 'weaken' && prd ? prd[1].trim().slice(0, 1000) : null, parsed: true };
  }

  function workerStore(item) {
    return (kind, mediaType, content, summary) => putEvidence({
      runId: item.runId,
      attemptId: item.attemptId,
      taskId: item.taskId || null,
      kind,
      mediaType,
      content,
      summary: summary.slice(0, 2000),
      source: { producer: 'lead_graph', role: canonicalRoleId(item.role) },
    });
  }

  // Rule 1: an oversize artifact is stored uncut and parsed whole before the result is cut for the journal.
  function oversizeHook(item) {
    return ({ artifactTexts, joined, parseText, completed, lanePath = null }) => {
      const store = workerStore(item);
      const refs = [];
      const errors = [];
      const stored = new Map();
      for (const value of [...artifactTexts, joined]) {
        if (value.length <= MAX_REPORT_CHARS || stored.has(value)) continue;
        const outcome = store('worker_result_text', 'text/plain; charset=utf-8', value,
          `Worker result text, ${value.length} chars; the journal keeps the first ${MAX_REPORT_CHARS}.`);
        stored.set(value, outcome.ref);
        if (outcome.ref) refs.push(outcome.ref);
        if (outcome.error) errors.push(outcome.error);
      }
      const parsed = completed ? parseWorkerReport(parseText) : { report: null, error: null };
      const reportAnalysis = analyzeWorker(parsed, {
        fullText: joined, allowedFiles: allowedFilesOf(item), workspace, store, textRef: stored.get(parseText) || stored.get(joined) || null, lanePath,
      });
      // The refs (including the parse source) already live on the analysis or the result; keep one list.
      const evidence = [...refs, ...reportAnalysis.evidence.filter((ref) => !refs.some((known) => known.id === ref.id))];
      const failure = errors[0] || reportAnalysis.evidenceError;
      const { evidence: _refs, evidenceError: _error, ...analysis } = reportAnalysis;
      return { reportAnalysis: analysis, ...(evidence.length > 0 ? { evidence } : {}), ...(failure ? { evidenceError: failure } : {}) };
    };
  }

  const receiveResult = (task, item) => assignmentResult(task, { onOversize: oversizeHook({ ...item, taskId: task?.id || item.taskId }) });

  // A direct message reply has no artifacts; its text is the parse source.
  function oversizeMessage(item, text) {
    return text.length > MAX_REPORT_CHARS ? oversizeHook(item)({ artifactTexts: [], joined: text, parseText: text, completed: true }) : {};
  }

  function outcomeSummary(item) {
    const result = item.result;
    const completed = result.status === 'TASK_STATE_COMPLETED';
    // Settlement uses the attempt's own pinned allowedFiles; items from old checkpoints are legacy.
    const allowedFiles = allowedFilesOf(item);
    let analysis = result.reportAnalysis;
    let evidence = [...(result.evidence || [])];
    let evidenceError = result.evidenceError || null;
    if (analysis) {
      analysis = { ...analysis, omitted: [...(analysis.omitted || [])] };
    } else {
      const parsed = completed ? parseWorkerReport(result.artifacts?.[0]?.text || result.text) : { report: null, error: null };
      analysis = analyzeWorker(parsed, { fullText: result.text || '', allowedFiles, workspace, textRef: null, store: workerStore(item), lanePath: lanePathOf(result.writerExecution) });
      evidence = analysis.evidence;
      evidenceError = analysis.evidenceError || evidenceError;
    }
    const omitted = analysis.omitted;
    const violations = analysis.scopeViolations;
    const violationCount = analysis.scopeViolationCount ?? violations.length;
    let writerExecution = result.writerExecution || null;
    const attestedDelta = writerExecution?.delta || null;
    const attestedPaths = Array.isArray(attestedDelta?.changedPaths) ? attestedDelta.changedPaths : [];
    const attested = capPaths(outsideAllowed(attestedPaths, allowedFiles, workspace), 'attestedScopeViolations', omitted);
    const attestedViolations = attested.paths;
    if (attestedPaths.length > MAX_VIOLATION_PATHS) {
      omitted.push({ field: 'writerExecution.delta.changedPaths', kept: MAX_VIOLATION_PATHS, total: attestedPaths.length });
      writerExecution = { ...writerExecution, delta: { ...attestedDelta, changedPaths: attestedPaths.slice(0, MAX_VIOLATION_PATHS), changedPathCount: attestedPaths.length } };
    }
    const writer = item.sandbox !== 'read-only';
    const lane = writerExecution?.lane || null;
    const unintegrated = isUnintegratedLane(writerExecution);
    const ran = writerExecution != null && result.effects !== 'none' && !unintegrated;
    const results = [];
    if (completed && !analysis.report) {
      results.push(settlementRecord('settle.report_valid', 'FAIL', 'report_invalid', analysis.reportError || 'The worker did not return a valid report.', { advisory: !writer }));
    }
    if (violationCount > 0) {
      results.push(settlementRecord('settle.reported_scope', 'FAIL', 'reported_scope_violation', `Reported files outside allowedFiles: ${violations.join(', ')}`, { advisory: !writer || lane?.state === 'not_integrated' }));
    }
    if (lane?.reason === 'lane_scope_refused') {
      const refused = Array.isArray(lane.scopeViolations) ? lane.scopeViolations.slice(0, MAX_VIOLATION_PATHS) : [];
      results.push(settlementRecord('settle.lane_scope', 'FAIL', 'lane_scope_refused', `The lane patch was refused and nothing was integrated${refused.length > 0 ? `; paths outside allowedFiles: ${refused.join(', ')}` : ''}.`));
    }
    if (attested.count > 0) {
      results.push(settlementRecord('settle.attested_scope', 'FAIL', 'attested_scope_violation', `Changed files outside allowedFiles: ${attestedViolations.join(', ')}`));
    } else if (writer && ran && attestedDelta?.known !== true) {
      results.push(settlementRecord('settle.attested_scope', 'UNKNOWN', 'delta_unknown', 'The writer ran but its workspace delta is unknown.'));
    }
    if (writer && !isSettledWriter(result)) {
      results.push(settlementRecord('settle.writer_settled', 'UNKNOWN', 'writer_unresolved', 'The writer execution is not proven ended.', {
        evidence: writerExecution?.executionId ? [`writer_executions:${writerExecution.executionId}`] : [],
      }));
    }
    if (writer && analysis.report && ['failed', 'blocked'].includes(analysis.report.outcome)) {
      results.push(settlementRecord('settle.report_outcome', 'FAIL', 'writer_reported_failure', `The writer reported outcome ${analysis.report.outcome}.`, { advisory: true }));
    }
    return {
      assignmentId: item.assignmentId,
      attemptId: item.attemptId,
      role: canonicalRoleId(item.role),
      roleName: roleDisplayName(item.role),
      objective: String(item.assignment?.objective ?? '').slice(0, DIGEST_SUMMARY_CHARS),
      skills: (item.assignment?.skillPins || []).map(({ id, sha256: hash }) => ({ id, sha256: hash })),
      sandbox: item.sandbox,
      taskId: result.taskId || item.taskId || null,
      status: result.status,
      report: analysis.report,
      reportError: analysis.reportError,
      ...(Array.isArray(analysis.report?.normalizations) && analysis.report.normalizations.length > 0
        ? { normalizations: analysis.report.normalizations.map((entry) => `${entry.field}: ${entry.action}`) } : {}),
      ...(analysis.report ? {} : { text: analysis.text ?? '' }),
      failureKind: result.failureKind || null,
      ...(result.continuation ? { continuation: result.continuation } : {}),
      scopeViolations: violations,
      ...(violationCount > violations.length ? { scopeViolationCount: violationCount } : {}),
      writerExecution,
      ...(lane ? { lane: laneSummary(lane) } : {}),
      effects: result.effects || null,
      attestedScopeViolations: attestedViolations,
      ...(attested.count > attestedViolations.length ? { attestedScopeViolationCount: attested.count } : {}),
      attestedDeltaKnown: attestedDelta?.known === true,
      ...(item.contract ? { contract: item.contract } : {}),
      boundary: { contract: item.contract ? BOUNDARY_CONTRACT_ID : 'legacy', results },
      ...(result.failure ? { failure: result.failure } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(omitted.length > 0 ? { projection: { omitted } } : {}),
      ...(evidenceError ? { evidenceError } : {}),
    };
  }

  const roundsLine = (state) => {
    const extensions = (state.roundExtensions || []).length === 0 ? ''
      : ` Budget extensions: ${state.roundExtensions.map((entry) => `+${entry.rounds} at round ${entry.round} (${entry.by}${entry.reason ? `: ${entry.reason}` : ''})`).join('; ')}.`;
    return `Dispatch rounds already used: ${state.round}/${roundLimit(state)}. A dispatch decision consumes one round.${extensions}`;
  };

  const checksLine = (state) => {
    const pinnedChecks = state.contract?.requiredChecks || [];
    if (state.contract?.invalid) return 'Acceptance checks: the owner contract of this run is invalid; acceptanceChecks proposals are ignored.';
    if (pinnedChecks.length > 0) {
      return `Pinned acceptance checks (source ${state.contract.source || 'owner'}; they run at finish; acceptanceChecks proposals are ignored and only the owner can change them):\n${JSON.stringify(pinnedChecks.map(({ id, argv }) => ({ id, argv })))}`;
    }
    return 'Acceptance checks: none are pinned yet; propose them in acceptanceChecks (see the rules below).';
  };

  const openDecisionsSection = (state) => 'Open worker decisions (resolve each in resolutions, or list it in humanInput.relatedDecisionIds when owner-only; a dispatch of only read-only roles may keep them open while you investigate):\n' + JSON.stringify(state.openDecisions.map(({ id, role, request }) => ({ id, role, request })));

  // Optional notes shared by the full and the delta prompt (acceptance, goal investigation, human answers, rejection).
  function stateNotes(state) {
    const sections = [];
    if (state.acceptance?.disposition === 'rejected' && state.acceptanceAttempts > 0 && !state.status) {
      const issues = (state.acceptance.issues || []).map((issue) => `${issue.code}: ${issue.detail}`);
      sections.push(`Acceptance note: the deterministic acceptance run for your finish decision was rejected (disposition ${state.acceptance.disposition}). You may dispatch fixes within the round limits, then finish again; a second rejection ends the run as rejected. Your final text never changes the disposition.\nIssues:\n${issues.map((line) => `- ${line}`).join('\n')}`);
    }
    if (state.goalInvestigation) {
      sections.push(`Goal investigation (requested in round ${state.goalInvestigation.round}): your finish with goalAchieved false named these blockers:\n${state.goalInvestigation.final}\nInvestigate the root cause of each one (explorer or auditor with the concrete question) or fix it. A later finish with goalAchieved false pauses for the owner only when final cites the assignmentId of a read-only investigation finished after round ${state.goalInvestigation.round} and states why each remaining blocker is owner-only, with evidence.`);
    }
    if (state.humanAnswers.length > 0) sections.push('Human answers (authoritative):\n' + JSON.stringify(state.humanAnswers));
    if (state.retryDecide && state.rejections?.length > 0) {
      const violations = state.rejections.at(-1).violations || [];
      const reminders = [...new Set(violations.map((entry) => RULE_REMINDERS[entry.predicate]).filter(Boolean))];
      sections.push(['Rejected decision: your previous decision failed validation and nothing was executed. Return a corrected decision.',
        ...violations.map((entry) => `- ${entry.predicate} ${entry.code}: ${entry.detail}`),
        ...reminders].join('\n'));
    }
    return sections;
  }

  const outcomesForPrompt = (outcomes) => boundedOutcomes(outcomes.map(({ objective: _objective, continuation: _continuation, ...outcome }) => outcome));

  // SES-01: the lead thread already holds the rules and roles; send only what is new since its last turn.
  function deltaPrompt(state, extras) {
    const sections = [DELTA_REMINDER];
    if (extras.goalChanged) {
      if (state.goalOverride) sections.push(`The owner changed the goal during this run (authoritative; it replaces the earlier goal):\n${state.goalOverride}`);
      else if (state.newRequest) sections.push(`New message from the owner (authoritative; the earlier conversation in this thread is background):\n${state.newRequest}`);
      else sections.push(`New goal from the owner (authoritative):\n${state.goal}`);
    }
    sections.push(roundsLine(state), checksLine(state));
    if (extras.notes.length > 0) sections.push('Notes:\n' + extras.notes.map((note) => `- ${note}`).join('\n'));
    if (extras.goalChanged) sections.push(`Available skill candidates (choose 0-5 relevant IDs for each assignment; no skill is required for unrelated work):\n${JSON.stringify(extras.skillCandidates)}`);
    sections.push(openDecisionsSection(state));
    sections.push(...stateNotes(state));
    const fresh = state.outcomes.slice(extras.seenOutcomes);
    if (fresh.length > 0) sections.push('Worker outcomes since your last turn (including failures):\n' + JSON.stringify(outcomesForPrompt(fresh)));
    sections.push(DELTA_REMINDER);
    return sections.join('\n\n');
  }

  function decisionPrompt(state, extras) {
    return extras.delta ? deltaPrompt(state, extras) : fullPrompt(state, extras);
  }

  function fullPrompt(state, extras) {
    const goal = state.goalOverride
      ? [`Goal (changed by the owner during this run; authoritative, it replaces the original goal):\n${state.goalOverride}`, `Original goal (background only):\n${state.goal}`]
      : [`User goal:\n${state.goal}`];
    const sections = [
      'Plan and coordinate the requested work as the read-only team lead. Return only JSON matching the supplied schema.',
      'The lead must not edit files. Delegate all changes through the A2A role agents.',
      ...goal,
      roundsLine(state),
      checksLine(state),
      'Available roles:\n' + JSON.stringify([...roles.values()].map(({ name, displayName, description, sandbox, model, effort }) => ({ id: canonicalRoleId(name), name: displayName || roleDisplayName(name), description, sandbox, model, effort }))),
      `Available skill candidates (choose 0-5 relevant IDs for each assignment; no skill is required for unrelated work):\n${JSON.stringify(extras.skillCandidates)}`,
      `Available skill IDs and names (trusted selectable IDs):\n${JSON.stringify(extras.skillNames)}`,
      'The candidate descriptions are lexical hints. You may select any listed skill ID based on semantic relevance to the task, even when it was not in the candidate shortlist.',
    ];
    if (extras.sessionDigest) sections.splice(1 + goal.length + 1, 0, `Session so far (this lead thread is new; the earlier conversation of this session is summarized here, background only):\n${extras.sessionDigest}`);
    if (extras.notes.length > 0) sections.push('Notes:\n' + extras.notes.map((note) => `- ${note}`).join('\n'));
    sections.push(openDecisionsSection(state));
    sections.push(...stateNotes(state));
    // The objective is kept for the run digest only; the bounded prompt stays as before.
    sections.push('Prior worker outcomes (including failures):\n' + JSON.stringify(outcomesForPrompt(state.outcomes)));
    sections.push([
      'Every assignment must include role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, stopConditions, skills, wave, and continueFrom (null unless continuing a worker). Set assignment.role to one of the available roles id values; their name values are human labels. Select 0-5 unique skills from the trusted listed skill IDs; use [] when none apply. Writable roles require one or more explicit safe relative allowedFiles; read-only roles may use allowedFiles []. allowedFiles entries are exact paths or directory prefixes; globs are not supported. Keep each brief bounded with at most 20 items per array field (use directory prefixes instead of long file lists).',
      'Briefing rules: in each assignment inputs and evidence, give exact file paths with line ranges and the facts already established, so workers do not re-explore; reuse explorer findings by quoting the relevant paths and ranges. Do not read large files yourself: read at most a few narrow ranges and dispatch an explorer for broad reading.',
      deps.parallelWriters
        ? 'Waves: assignment.wave is an integer >= 1 or null. Consecutive assignments sharing the same wave run concurrently. Writers in one wave each work in an isolated copy of the workspace made from the same starting state and do not see each other\'s changes; their changes are integrated into the shared workspace as each finishes. A later wave (or a null-wave assignment after them), for example a verifier, sees the integrated result. Writers in one wave must own disjoint allowedFiles. Use null for strictly sequential steps.'
        : 'Waves: assignment.wave may be used to group read-only work that runs concurrently. Writers always run one at a time in array order regardless of wave. Use null otherwise.',
      'The JSON must contain action (dispatch, finish, or request_human_input), assignments, final, resolutions, humanInput, goalAchieved, and acceptanceChecks. Use empty arrays, an empty string, or null for unused fields.',
      'Repair and debugging assignments should use directory prefixes that cover the module and its tests, not single files. When a worker reports scopeExpansion or asks for a scope decision, prefer re-dispatching with continueFrom set to that outcome\'s assignmentId (same role) and the expanded allowedFiles over a fresh assignment: the worker continues its own thread instead of re-discovering its context.',
      'Worker decision requests are open decisions: resolve each one yourself (resolutions: decisionId, choice, rationale), investigating first when the evidence does not settle it; list one in humanInput.relatedDecisionIds only when it is an owner-only decision. Never leave one unanswered. Worker reports are self-reported; check scopeViolations and reportError.',
      `Investigate first: never ask the owner what investigation can answer; the owner has no one to ask either. ${OWNER_ONLY_RULE}`,
      `request_human_input is accepted only for an owner-only decision and only after an investigation of that blocker: ${INVESTIGATION_RULE} Give options, a recommendation, the evidence checked, and the independent work that can proceed.`,
      'A blocker that persists is a reason to investigate its root cause (an explorer or auditor with the concrete question), not to escalate.',
      `goalAchieved: on finish set it honestly, true only when the goal is met; false names the blockers in final. The first finish with false does not end the run: you get ${GOAL_INVESTIGATION_ROUNDS} extra rounds to investigate the root cause of each blocker or fix it. A later finish with false pauses for the owner only when final cites a read-only investigation finished since then and states why each remaining blocker is owner-only, with evidence. Use null for dispatch and request_human_input.`,
      `Round budget: when the last two rounds made progress (an integrated change, a newly passing acceptance check, or a resolved worker decision), the budget grows by ${maxRounds} rounds automatically, up to ${ROUND_CAP} rounds; beyond that the owner decides.`,
      `acceptanceChecks: while no checks are pinned, propose 1-10 deterministic checks derived from the project's PRD, release or gate documents and its test commands; the first valid proposal is pinned for the run and runs at finish in a sandbox with a read-only workspace and no network. ${CHECK_RULE} Otherwise use null. A check that cannot pass is a blocker to investigate; only an owner-only cause is escalated. A changed pinned check script is reviewed by a read-only auditor against the PRD: preserved requirements are re-pinned, weakened ones keep failing.`,
      ...(deps.parallelWriters ? ['A writer outcome can be not_integrated (the lane field gives the reason and the lane path, which is kept): its changes never reached the shared workspace. You may re-dispatch with corrected allowedFiles, or resolve a conflict with a follow-up assignment.'] : []),
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
    const current = readPinned({ roles, leadRole, workspace, skillCatalog });
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
    const update = { redecide: false };
    if (runtime.resumed) {
      runtime.resumed = false;
      notes.push('This run was resumed after an interruption (restart, pause, or usage limit). A previous lead turn may have been repeated. Outcomes marked interrupted or outcome_unknown have unknown workspace effects.');
      const current = readPinned({ roles, leadRole, workspace, skillCatalog });
      notes.push(...instructionChanges(state.pinned, current));
      update.pinned = current;
      // A resume is new human intent: the automatic-retry allowance starts over.
      update.consecutiveRejections = 0;
      update.retryDecide = false;
    }
    const priorRejections = update.consecutiveRejections ?? (state.consecutiveRejections || 0);

    const priorSkillContext = state.outcomes.map((outcome) => ({
      role: outcome.role,
      summary: (outcome.report?.summary || outcome.text || outcome.reportError || '').slice(0, 300),
    })).slice(-12);
    const skillCandidates = findSkillCandidates(skillCatalog, [state.goal, ...priorSkillContext.map((item) => item.summary)].join('\n'), { limit: 12 });
    const skillNames = [...skillCatalog.values()].map(({ id, name }) => ({ id, name }));
    const candidateIds = skillNames.map(({ id }) => id);
    // SES-01: one lead thread per session. A rejection retry keeps the current thread; otherwise the
    // session thread is resumed when it is in the current Codex home and still small enough.
    const contextId = runtime.contextId ?? state.contextId ?? null;
    const sessions = contextId ? deps.sessionThreads : null;
    const codexHome = appServer.getCodexHome?.() ?? null;
    const session = sessions ? sessions.get(contextId) : null;
    let threadId = null;
    let rolledOver = false;
    if (state.retryDecide && state.threadId) threadId = state.threadId;
    else if (session?.threadId) {
      if (session.codexHome === codexHome && (session.lastInputTokens == null || session.lastInputTokens <= rolloverThreshold(session.contextWindow))) threadId = session.threadId;
      else rolledOver = true;
    }
    const goalKey = state.goalOverride || state.goal;
    const turnInputs = async (resumeThreadId) => {
      // What the lead thread already saw: nothing unless it is this run's own thread.
      const sameThread = Boolean(resumeThreadId) && resumeThreadId === state.threadId;
      const delta = Boolean(sessions) && Boolean(resumeThreadId);
      const sessionDigest = delta || !session?.threadId || !deps.sessionDigest ? '' : await deps.sessionDigest({ contextId, runId: state.runId, runIds: session.runIds, state });
      const seenGoal = sameThread ? state.leadSeenGoal : null;
      return decisionPrompt(state, {
        notes, skillCandidates, skillNames, delta, sessionDigest,
        seenOutcomes: sameThread ? (state.leadSeenOutcomes || 0) : 0,
        goalChanged: seenGoal !== goalKey,
      });
    };
    let leadResult;
    const activity = deps.activityStore?.begin({ key: `lead:${state.runId}`, runId: state.runId, role: 'coordinator' });
    let activityOutcome = 'failed';
    const runLead = async (resumeThreadId) => appServer.run({
      role: leadRole,
      cwd: workspace,
      input: await turnInputs(resumeThreadId),
      ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
      outputSchema: DECISION_SCHEMA,
      signal,
      ...(activity ? { onEvent: (event) => activity.observe(event) } : {}),
    });
    try {
      try {
        leadResult = await runLead(threadId);
      } catch (error) {
        // A rejected resume (thread gone or unusable) starts a new thread with the full prompt; nothing ran.
        if (!threadId || signal?.aborted || error?.name === 'AbortError' || error?.failureClass !== 'request_rejected' || error?.outcomeUnknown === true) throw error;
        threadId = null;
        rolledOver = Boolean(sessions);
        leadResult = await runLead(null);
      }
      activityOutcome = String(leadResult?.status ?? 'completed');
    } catch (error) {
      activityOutcome = signal?.aborted ? 'canceled' : 'failed';
      const kind = error?.name === 'AbortError' && signal?.aborted ? 'aborted' : classifyCodexError(error) === 'usage_limit' ? 'usage_limit' : 'error';
      if (error?.usage || error?.execution) recordLeadTurn(state, error, kind);
      if (kind === 'aborted') return { ...update, status: 'canceled', text: CANCELED_TEXT };
      if (kind === 'usage_limit') return { ...update, budget: { source: 'lead' } };
      throw error;
    } finally {
      activity?.end(activityOutcome);
    }
    update.threadId = leadResult.threadId || state.threadId;
    // The thread has now seen this turn's goal and outcomes (a new thread got them in its full prompt).
    update.leadSeenOutcomes = state.outcomes.length;
    update.leadSeenGoal = goalKey;
    recordLeadTurn(state, leadResult, leadResult.status || 'completed');
    if (sessions && update.threadId) {
      try {
        const contextTokens = leadResult.usage?.contextTokens;
        const contextWindow = leadResult.usage?.contextWindow;
        sessions.upsert({
          contextId,
          threadId: update.threadId,
          codexHome,
          lastInputTokens: Number.isFinite(contextTokens) ? contextTokens : null,
          contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
          runId: state.runId,
          rolledOver,
        });
      } catch (_) { /* Session bookkeeping never breaks a run. */ }
    }

    let decision;
    let agentContract = null;
    let proposal = null;
    // LL-4: proposals are honored only while the run has no owner checks and none are pinned.
    const proposalsOpen = !state.contract?.invalid && (state.contract?.requiredChecks || []).length === 0;
    try {
      decision = parseDecision(leadResult.text);
      if (Array.isArray(decision.assignments)) {
        for (const assignment of decision.assignments) {
          if (!assignment || typeof assignment !== 'object') continue;
          for (const field of ['allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions']) {
            if (Array.isArray(assignment[field]) && assignment[field].length > 20) {
              assignment[field] = assignment[field].slice(0, 20);
            }
          }
          if (Array.isArray(assignment.allowedFiles)) {
            assignment.allowedFiles = assignment.allowedFiles.map((file) => (typeof file === 'string' && file.length > 1 ? file.replace(/\/+$/, '') : file));
            // A read-only role needs no write scope: a bare dot means "no files", not the repository.
            if (getRole(roles, assignment.role)?.sandbox === 'read-only') {
              assignment.allowedFiles = assignment.allowedFiles.filter((file) => file !== '.' && file !== './');
            }
          }
        }
      }
      validateDecision(decision, {
        roles,
        attemptedRoles: new Set(state.attemptedRoles),
        outcomeCount: state.outcomes.length,
        unresolvedWriterCount: state.unresolvedWriters.length,
        openDecisionIds: new Set(state.openDecisions.map((entry) => entry.id)),
        continuable: new Map(state.outcomes.filter((outcome) => !outcome.kind && outcome.assignmentId).map((outcome) => [outcome.assignmentId, outcome.role])),
        skillCatalog,
        skillCandidateIds: candidateIds,
        // LL-6 investigate first.
        investigations: investigationsOf(state),
        openDecisionRounds: new Map(state.openDecisions.map((entry) => [entry.id, roundOf(entry.assignmentId) ?? 0])),
        goalInvestigationRound: state.goalInvestigation ? state.goalInvestigation.round : null,
      });
      proposal = Array.isArray(decision.acceptanceChecks) && decision.acceptanceChecks.length > 0 ? decision.acceptanceChecks : null;
      if (proposal && proposalsOpen) agentContract = agentChecksContract(proposal);
    } catch (error) {
      if (!(error instanceof BoundaryViolation)) throw error;
      const consecutive = priorRejections + 1;
      deps.emit(runtime.onEvent, {
        type: 'decision_rejected',
        round: state.round + 1,
        violations: error.violations.map(({ predicate, code, detail }) => ({ predicate, code, detail })),
      });
      if (consecutive > MAX_AUTO_REJECTIONS) {
        const codes = [...new Set([...(state.retryDecide ? (state.rejections.at(-1)?.violations || []) : []), ...error.violations].map((entry) => entry.code))];
        throw new Error(`Lead decision rejected ${consecutive} times in a row (${codes.join(', ')}): ${error.message}`, { cause: error });
      }
      return {
        ...update,
        rejections: [...(state.rejections || []), { round: state.round + 1, at: new Date().toISOString(), violations: error.violations }].slice(-5),
        consecutiveRejections: consecutive,
        retryDecide: true,
      };
    }
    update.consecutiveRejections = 0;
    update.retryDecide = false;
    deps.emit(runtime.onEvent, { type: 'decision', round: state.round + 1, action: decision.action });
    if (agentContract) {
      // Pinned in graph state (checkpointed with this step); the server mirrors it into task metadata.
      update.contract = agentContract;
      deps.emit(runtime.onEvent, { type: 'acceptance_contract', round: state.round + 1, contract: agentContract });
    } else if (proposal) {
      runtime.pendingNotes = [...(runtime.pendingNotes || []), 'Your acceptanceChecks proposal was ignored: the acceptance checks of this run are already pinned and only the owner can change them.'];
    }

    const resolved = new Map(decision.resolutions.map((entry) => [entry.decisionId, entry]));
    update.openDecisions = state.openDecisions.filter((entry) => !resolved.has(entry.id));
    update.closedDecisions = [...state.closedDecisions, ...decision.resolutions.map((entry) => ({ id: entry.decisionId, by: 'lead', choice: entry.choice }))];
    if (decision.resolutions.length > 0) {
      update.progress = addProgress(state, [{ round: state.round, kind: 'decision_resolved', detail: decision.resolutions.map((entry) => entry.decisionId).join(', ') }]);
    }

    if (decision.action === 'finish') {
      const final = decision.final.trim();
      if (decision.goalAchieved === false) {
        // LL-6: the first unmet-goal finish is not a pause: the lead investigates the blockers with extra rounds.
        if (!state.goalInvestigation) {
          return {
            ...update,
            goalInvestigation: { round: state.round, final: final.slice(0, MAX_ESCALATION_QUESTION_CHARS) },
            extraRounds: (state.extraRounds || 0) + GOAL_INVESTIGATION_ROUNDS,
            roundExtensions: [...(state.roundExtensions || []), { round: state.round, by: 'goal_investigation', rounds: GOAL_INVESTIGATION_ROUNDS }],
            redecide: true,
          };
        }
        // A later one passed validation with a cited investigation: the owner decides how to go on.
        return { ...update, ...escalate(state, 'goal_not_achieved', final, final) };
      }
      return { ...update, status: 'completed', text: final };
    }
    if (decision.action === 'request_human_input') {
      const decisionId = `${state.runId}:h${state.humanCount + 1}`;
      return { ...update, humanCount: state.humanCount + 1, humanRequest: { decisionId, ...decision.humanInput } };
    }
    const limit = roundLimit(state);
    if (state.round >= limit) {
      // LL-6: progress in the last two rounds (state.round - 1 and state.round, this decision's resolutions
      // included) extends the budget by maxRounds automatically, but never past ROUND_CAP.
      const recent = (update.progress || state.progress || []).filter((entry) => entry.round >= state.round - 1);
      if (recent.length === 0 || limit >= ROUND_CAP) {
        const question = `Dispatch round limit reached: ${state.round} of ${limit} rounds used and the lead has not finished${limit >= ROUND_CAP ? ` (automatic extensions stop at ${ROUND_CAP} rounds)` : ' and the last two rounds made no progress'}. Continue with another ${maxRounds} rounds, accept the current result as is, or change the goal?`;
        return { ...update, ...escalate(state, 'round_limit', question, `Stopped after reaching the limit of ${limit} dispatch rounds.`) };
      }
      const grant = Math.min(limit + maxRounds, ROUND_CAP) - limit;
      update.extraRounds = (state.extraRounds || 0) + grant;
      update.roundExtensions = [...(state.roundExtensions || []), {
        round: state.round, by: 'auto', rounds: grant, reason: [...new Set(recent.map((entry) => entry.kind))].join(', '),
      }];
    }
    const pendingAssignments = decision.assignments.map((assignment) => {
      const selected = resolveSkillSelection(skillCatalog, assignment.skills || []);
      return { ...assignment, skills: selected.map(({ id }) => id), skillPins: selected.map(({ id, sha256: hash }) => ({ id, sha256: hash })) };
    });
    return { ...update, pendingAssignments };
  }

  function parseDecision(text) {
    if (typeof text !== 'string' || !text.trim()) throw new BoundaryViolation('decision.parse', 'decision_empty', 'Lead returned an empty decision');
    let decision;
    try {
      decision = JSON.parse(text);
    } catch (error) {
      const failure = new BoundaryViolation('decision.parse', 'decision_not_json', 'Lead decision was not valid JSON');
      failure.cause = error;
      throw failure;
    }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new BoundaryViolation('decision.parse', 'decision_not_object', 'Lead decision must be a JSON object');
    }
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
    try {
      journal.recordFinished(item.attemptId, result);
    } catch (error) {
      if (error?.code !== 'journal_transition_refused') throw error;
      // Replay of an attempt that is already finished with a different result: the journal is the truth.
      const stored = journal.get(item.attemptId);
      if (stored?.state !== 'finished') throw error;
      return { ...item, state: 'finished', taskId: stored.taskId || item.taskId, result: stored.result };
    }
    return { ...item, state: 'finished', taskId: result.taskId || item.taskId, result };
  }

  // A refused submitted-transition on an attempt that moved on (replay) is a no-op; a conflicting task id is surfaced.
  function markSubmitted(attemptId, taskId) {
    try {
      journal.recordSubmitted(attemptId, taskId);
    } catch (error) {
      if (error?.code !== 'journal_transition_refused') throw error;
      const stored = journal.get(attemptId);
      if (stored?.state === 'finished' || (stored?.state === 'submitted' && stored.taskId === taskId)) return;
      throw error;
    }
  }

  async function submitItem(item, signal) {
    const role = getRole(roles, item.role);
    const client = await deps.clientFor(item.role);
    const row = journal.get(item.attemptId);
    if (row?.state === 'finished') return { ...item, state: 'finished', taskId: row.taskId, result: row.result };
    if (row?.state === 'submitted') return { ...item, state: 'submitted', taskId: row.taskId };

    if (signal?.aborted) return item;
    // A dispatched assignment is pinned before checkpointing. Never update its hash on resume.
    const skillIds = item.assignment?.skills || [];
    const skillPins = item.assignment?.skillPins || [];
    if (!row) resolveSkillSelection(skillCatalog, skillIds, { pins: skillPins });

    if (!row) {
      journal.recordSubmitting({
        attemptId: item.attemptId,
        runId: item.runId,
        assignmentId: item.assignmentId,
        role: item.role,
        sandbox: item.sandbox,
        contextId: item.contextId,
        objectiveSha256: sha256(String(item.assignment?.objective ?? '')),
      });
    } else {
      // Journal says "submitting": the send may or may not have reached the server.
      const found = await findTask(client, item.contextId, signal);
      if (found) {
        markSubmitted(item.attemptId, found.id);
        return { ...item, state: 'submitted', taskId: found.id };
      }
      if (item.sandbox !== 'read-only') {
        return finishItem(item, syntheticResult('outcome_unknown', `Submission of ${roleDisplayName(item.role)} was interrupted and no A2A task exists for it; it was not re-sent because the role can write. Workspace effects are unknown.`, { contextId: item.contextId }));
      }
    }

    const { continueFrom: _continueFrom, ...assignmentFields } = item.assignment || {};
    const text = JSON.stringify({
      ...assignmentFields,
      assignmentId: item.assignmentId,
      workspace,
      reportContract: REPORT_CONTRACT_LINE,
      ...(item.continuation ? { continuation: item.continuation } : {}),
    });
    let submitted;
    try {
      submitted = await abortable(client.sendMessage({
        message: {
          messageId: `${item.attemptId}:msg`,
          contextId: item.contextId,
          role: A2ARole.ROLE_USER,
          parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain' }],
          metadata: {},
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
        markSubmitted(item.attemptId, found.id);
        return { ...item, state: 'submitted', taskId: found.id };
      }
      if (item.sandbox !== 'read-only') {
        const lookup = reconcileFailed ? 'the A2A task lookup also failed' : 'the immediate A2A task lookup found no task';
        return finishItem(item, syntheticResult('outcome_unknown', `Submission of ${roleDisplayName(item.role)} failed (${errorText(error)}) and ${lookup}; a task may be accepted later, so workspace effects are unknown.`, {
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
        return finishItem(item, syntheticResult('outcome_unknown', `A2A role ${roleDisplayName(item.role)} returned no task ID; it may have accepted the writable task, so workspace effects are unknown.`, { contextId: item.contextId }));
      }
      if (submitted?.message) {
        const messageText = extractTextParts(submitted.message.parts);
        return finishItem(item, { ...syntheticResult('TASK_STATE_COMPLETED', ''), contextId: item.contextId, text: messageText.slice(0, MAX_REPORT_CHARS), ...oversizeMessage(item, messageText) });
      }
      return finishItem(item, syntheticResult('dispatch_error', `A2A role ${roleDisplayName(item.role)} did not return a task ID`, { contextId: item.contextId }));
    }
    markSubmitted(item.attemptId, task.id);
    if (isTaskFinished(task)) return finishItem({ ...item, taskId: task.id }, receiveResult(task, item));
    return { ...item, state: 'submitted', taskId: task.id };
  }

  async function dispatch(state, config) {
    const { signal } = runtimeOf(config);
    let batch = state.batch;
    const update = {};
    if (!batch) {
      const round = state.round + 1;
      const parallel = state.pendingAssignments.every((assignment) => getRole(roles, assignment.role).sandbox === 'read-only');
      const groupOf = new Map();
      executionGroups(state.pendingAssignments).forEach((members, groupIndex) => members.forEach((index) => groupOf.set(index, groupIndex)));
      batch = {
        round,
        parallel,
        items: state.pendingAssignments.map((assignment, index) => {
          const skillPins = assignment.skillPins || [];
          resolveSkillSelection(skillCatalog, assignment.skills || [], { pins: skillPins });
          const assignmentId = makeAssignmentId(state.runId, round, index);
          const attemptId = makeAttemptId(assignmentId);
          const role = getRole(roles, assignment.role);
          // LL-5: continue the thread of an earlier outcome with the new (usually expanded) scope.
          const origin = assignment.continueFrom ? state.outcomes.find((outcome) => !outcome.kind && outcome.assignmentId === assignment.continueFrom) : null;
          return {
            runId: state.runId,
            assignmentId,
            attemptId,
            contextId: deterministicContextId(attemptId),
            role: assignment.role,
            sandbox: role.sandbox,
            assignment,
            ...(origin ? {
              continuation: {
                ofAttemptId: origin.attemptId,
                threadId: origin.continuation?.threadId ?? null,
                laneId: origin.continuation?.laneId ?? null,
                codexHome: origin.continuation?.codexHome ?? null,
                reason: 'scope',
              },
            } : {}),
            group: groupOf.get(index),
            contract: {
              id: BOUNDARY_CONTRACT_ID,
              reportContract: 'worker-report/v1',
              allowedFiles: [...(assignment.allowedFiles || [])],
              sandbox: role.sandbox,
              roleProfileSha256: roleProfileSha256(role),
              skillPins: skillPins.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
            },
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
            });
          }
          return finishItem(item, {
            ...syntheticResult('skipped_unresolved_writer', 'Not submitted: an earlier writer in this batch has an unresolved outcome, so the workspace may still change.', { contextId: item.contextId }),
            effects: 'none',
          });
        }),
      };
    }
    // Group dispatch (parallelWriters): the lowest group with pending items, once earlier groups are finished.
    // Batches checkpointed without item groups keep the serial or parallel behavior of batch.parallel.
    const grouped = Boolean(deps.parallelWriters) && !batch.parallel && batch.items.every((item) => Number.isInteger(item.group));
    let targets;
    if (batch.parallel) targets = batch.items.filter((item) => item.state === 'pending');
    else if (grouped) {
      const pendingGroups = batch.items.filter((item) => item.state === 'pending').map((item) => item.group);
      const next = pendingGroups.length > 0 ? Math.min(...pendingGroups) : null;
      const earlierDone = batch.items.every((item) => item.group >= next || item.state === 'finished');
      targets = next !== null && earlierDone ? batch.items.filter((item) => item.state === 'pending' && item.group === next) : [];
    } else targets = batch.items.filter((item) => item.state === 'pending').slice(0, 1);
    if (state.unresolvedWriters.length > 0 && targets.some((item) => item.sandbox !== 'read-only')) {
      throw new Error(`Writable dispatch refused: ${state.unresolvedWriters.length} writer outcome(s) are unresolved`);
    }
    // An abort during submit leaves the item submitted with an unknown task so collect can cancel it.
    const settled = await Promise.allSettled(targets.map((item) => submitItem(item, signal).catch((error) => {
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
    const stored = journal.get(item.attemptId);
    if (stored?.state === 'finished') return { ...item, state: 'finished', taskId: stored.taskId || item.taskId, result: stored.result };
    const client = await deps.clientFor(item.role);
    let taskId = item.taskId;
    try {
      throwIfAborted(signal);
      if (!taskId) {
        const found = await findTask(client, item.contextId, signal);
        if (!found) return finishItem(item, syntheticResult('outcome_unknown', 'No A2A task exists for this assignment.', { contextId: item.contextId }));
        taskId = found.id;
        markSubmitted(item.attemptId, taskId);
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
      return finishItem({ ...item, taskId }, receiveResult(task, item));
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        const stopped = await deps.cancelUntilConfirmed(client, taskId, item.contextId);
        const result = receiveResult(stopped, item);
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
        allowedFiles: Array.isArray(item.contract?.allowedFiles) ? item.contract.allowedFiles
          : (Array.isArray(item.assignment?.allowedFiles) ? item.assignment.allowedFiles : []),
        ...(item.contract ? { contract: item.contract } : {}),
        cause: item.result.status === 'outcome_unknown' ? 'outcome_unknown'
          : (item.result.failureKind || (item.result.writerExecution?.state ? `writer_${item.result.writerExecution.state}` : 'no_writer_execution')),
      });
    }
    const limited = summaries.some((outcome) => outcome.failureKind === 'usage_limit');
    // BUD-2: cut-off attempts that carry a continuation are continued after the budget resume.
    const continuable = finished
      .filter((item) => item.result?.failureKind === 'usage_limit' && item.result.continuation)
      .map((item) => ({
        item: {
          runId: item.runId,
          assignmentId: item.assignmentId,
          attemptId: item.attemptId,
          role: item.role,
          sandbox: item.sandbox,
          assignment: item.assignment,
          ...(item.contract ? { contract: item.contract } : {}),
        },
        continuation: item.result.continuation,
      }));
    const changes = summaries.filter((outcome) => integratedChange(outcome));
    return {
      outcomes: [...state.outcomes, ...summaries],
      ...(changes.length > 0 ? { progress: addProgress(state, changes.map((outcome) => ({ round: state.batch.round, kind: 'integrated_change', detail: outcome.assignmentId }))) } : {}),
      openDecisions: open,
      unresolvedWriters,
      batch: null,
      continuable,
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
      reason,
    });
    try {
      let row = entry.contextId ? admission.findByContextId(entry.contextId) : null;
      if (!row) {
        if (!entry.contextId) return unresolved('no_context_id');
        const fenced = admission.fence(entry.contextId, 'lead_reconcile');
        row = fenced?.execution || null;
        if (!row && admission.findAnyByContextId) {
          // An execution row stored under another workspace path still means the writer may have run.
          const other = admission.findAnyByContextId(entry.contextId);
          if (other) return { ...base, state: 'legacy_unverified', changedPaths: [], deltaKnown: false, reason: 'execution_in_other_workspace' };
        }
        if (!row) {
          // This call's fence insert proves the context can never run; a pre-existing fence with a task proves nothing.
          if (entry.taskId && fenced?.inserted !== true) return { ...base, state: 'legacy_unverified', changedPaths: [], deltaKnown: false, reason: 'no_execution_record' };
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
          const entry = state.unresolvedWriters[index];
          const allowed = entry.allowedFiles;
          const violations = Array.isArray(allowed) ? outsideAllowed(result.changedPaths, allowed, workspace) : [];
          const records = [];
          if (violations.length > 0) {
            records.push(settlementRecord('settle.attested_scope', 'FAIL', 'attested_scope_violation', `Changed files outside allowedFiles: ${violations.slice(0, MAX_VIOLATION_PATHS).join(', ')}`));
          } else if (result.deltaKnown !== true) {
            records.push(settlementRecord('settle.attested_scope', 'UNKNOWN', 'delta_unknown', 'The writer ran but its workspace delta is unknown.'));
          }
          if (result.state === 'legacy_unverified') {
            records.push(settlementRecord('settle.writer_settled', 'UNKNOWN', 'writer_unresolved', `The writer execution cannot be proven ended: ${result.reason}.`));
          }
          // Violations are computed on the full list; only the stored lists are capped.
          const changed = result.changedPaths || [];
          const cut = changed.length > MAX_VIOLATION_PATHS;
          const cutViolations = violations.length > MAX_VIOLATION_PATHS;
          return {
            ...result,
            changedPaths: cut ? changed.slice(0, MAX_VIOLATION_PATHS) : changed,
            ...(cut ? { changedPathCount: changed.length } : {}),
            attestedScopeViolations: cutViolations ? violations.slice(0, MAX_VIOLATION_PATHS) : violations,
            ...(cutViolations ? { attestedScopeViolationCount: violations.length } : {}),
            ...(entry.contract ? { contract: entry.contract } : {}),
            boundary: { contract: entry.contract ? BOUNDARY_CONTRACT_ID : 'legacy', results: records },
          };
        });
        for (const result of attested) deps.emit(runtime.onEvent, { type: 'reconciliation', round: state.round, ...result });
        const changed = attested.filter((result) => result.state === 'reconciled' && (result.changedPathCount ?? result.changedPaths.length) > 0);
        return {
          outcomes: [...state.outcomes, ...attested],
          unresolvedWriters: [],
          ...(changed.length > 0 ? { progress: addProgress(state, changed.map((result) => ({ round: state.round, kind: 'integrated_change', detail: result.attemptId }))) } : {}),
        };
      }
      const value = { kind: 'writer_unresolved', attempts: stuck.map((result) => ({ attemptId: result.attemptId, role: result.role, reason: result.reason })) };
      value.message = pauseMessage(value);
      interrupt(value);
    }
  }

  // BUD-2: after a budget resume, continue each cut-off attempt (at most MAX_CONTINUATIONS per original
  // assignment) before the lead re-plans. No lead turn, no new round: the batch re-enters dispatch.
  async function continueLimited(state, config) {
    const candidates = state.continuable || [];
    if (candidates.length === 0) return {};
    const runtime = runtimeOf(config);
    if (runtime.signal?.aborted) return { status: 'canceled', text: CANCELED_TEXT, continuable: [] };
    const items = [];
    for (const { item: origin, continuation } of candidates) {
      const match = /^(.*):c(\d+)$/.exec(origin.assignmentId);
      const original = match ? match[1] : origin.assignmentId;
      const count = match ? Number(match[2]) : 0;
      if (count >= MAX_CONTINUATIONS) continue;
      const assignmentId = `${original}:c${count + 1}`;
      const attemptId = makeAttemptId(assignmentId);
      items.push({
        runId: origin.runId,
        assignmentId,
        attemptId,
        contextId: deterministicContextId(attemptId),
        role: origin.role,
        sandbox: origin.sandbox,
        assignment: origin.assignment,
        group: 0,
        ...(origin.contract ? { contract: origin.contract } : {}),
        continuation: {
          ofAttemptId: origin.attemptId,
          threadId: continuation.threadId ?? null,
          laneId: continuation.laneId ?? null,
          codexHome: continuation.codexHome ?? null,
        },
        state: 'pending',
        taskId: null,
        result: null,
      });
    }
    if (items.length === 0) return { continuable: [] };
    const parallel = items.every((item) => item.sandbox === 'read-only');
    return { continuable: [], batch: { round: state.round, parallel, continuation: true, items } };
  }

  async function humanInput(state, config) {
    const request = state.humanRequest;
    const { final: _final, review: _review, ...shown } = request;
    const answer = interrupt({ kind: 'human_decision', ...shown });
    if (request.escalation === 'check_changed') return resolveCheckChange(state, request, answer, runtimeOf(config));
    if (request.escalation) return resolveEscalation(state, request, answer);
    // relatedDecisionIds may also cite an investigation (LL-6); only open decisions are closed.
    const related = new Set((request.relatedDecisionIds || []).filter((id) => state.openDecisions.some((entry) => entry.id === id)));
    return {
      humanAnswers: [...state.humanAnswers, {
        decisionId: request.decisionId,
        answer: answer.answer,
        ...(answer.choice ? { choice: answer.choice } : {}),
      }],
      openDecisions: state.openDecisions.filter((entry) => !related.has(entry.id)),
      closedDecisions: [...state.closedDecisions, ...[...related].map((id) => ({ id, by: 'human', choice: answer.choice || '' }))],
      ...(related.size > 0 ? { progress: addProgress(state, [{ round: state.round, kind: 'decision_resolved', detail: [...related].join(', ') }]) } : {}),
      humanRequest: null,
    };
  }

  // LL-1 resume: an answer without a known choice is the recommended continue, with the answer as a note.
  function resolveEscalation(state, request, answer) {
    const choice = ESCALATION_CHOICES.includes(answer.choice) ? answer.choice : 'continue';
    const update = {
      humanAnswers: [...state.humanAnswers, { decisionId: request.decisionId, answer: answer.answer, choice }],
      humanRequest: null,
    };
    if (choice === 'accept_as_is') return { ...update, status: 'completed', text: request.final };
    const extraRounds = (state.extraRounds || 0) + maxRounds;
    const roundExtensions = [...(state.roundExtensions || []), { round: state.round, by: 'owner', rounds: maxRounds }];
    if (choice === 'change_goal') return { ...update, extraRounds, roundExtensions, goalOverride: String(answer.answer).trim() };
    return { ...update, extraRounds, roundExtensions };
  }

  // LL-6: verdict on a changed pinned check. preserve re-pins the reviewed content and records who
  // approved it; weaken records the verdict so the check fails for exactly that content. Both rerun acceptance.
  function applyCheckVerdict(state, review, verdict, approvedBy, runtime) {
    const record = { assignmentId: review.assignmentId, round: review.round, checks: review.checks, verdict, by: approvedBy };
    const update = {
      checkReview: null,
      checkReviews: [...(state.checkReviews || []), record],
      status: 'completed',
      text: review.final,
    };
    if (verdict !== 'preserve') return update;
    const contract = repinChecks(state.contract, review.checks);
    deps.emit(runtime.onEvent, { type: 'acceptance_contract', round: state.round, contract, approvedBy });
    return { ...update, contract };
  }

  // LL-6: only the owner may change a PRD requirement; anything but an explicit approval keeps it.
  function resolveCheckChange(state, request, answer, runtime) {
    const choice = answer.choice === 'approve_change' ? 'approve_change' : 'keep_requirement';
    const by = `owner (decision ${request.decisionId})`;
    return {
      ...applyCheckVerdict(state, request.review, choice === 'approve_change' ? 'preserve' : 'weaken', by, runtime),
      humanAnswers: [...state.humanAnswers, { decisionId: request.decisionId, answer: answer.answer, choice }],
      humanRequest: null,
    };
  }

  // LL-6: the reviewer's verdict on a check_changed issue. Part of the run: no lead turn, no round.
  async function reviewCheck(state, config) {
    const runtime = runtimeOf(config);
    const review = state.checkReview;
    // The latest attempt of the review (a usage-limited review continues as <id>:c<n>).
    const outcome = state.outcomes.filter((entry) => !entry.kind && (entry.assignmentId === review.assignmentId || String(entry.assignmentId).startsWith(`${review.assignmentId}:c`))).at(-1) || null;
    const { verdict, prdChange, parsed } = parseVerdict(outcome);
    // A decision request of the reviewer is not a decision for the lead.
    const openDecisions = state.openDecisions.filter((entry) => entry.assignmentId !== review.assignmentId && !String(entry.assignmentId).startsWith(`${review.assignmentId}:c`));
    const by = `${outcome?.role || 'reviewer'} review ${review.assignmentId}${parsed ? '' : ' (no parseable verdict)'}`;
    if (!prdChange) return { ...applyCheckVerdict(state, review, verdict, by, runtime), openDecisions };
    const ids = review.checks.map((check) => check.id).join(', ');
    const question = `The reviewer (${review.assignmentId}) concluded that the PRD requirement behind pinned acceptance check(s) ${ids} must change: ${prdChange} Approve the changed check (it is re-pinned), or keep the requirement (the check fails and the lead fixes the cause)?`;
    return {
      openDecisions,
      checkReview: null,
      humanCount: state.humanCount + 1,
      humanRequest: {
        decisionId: `${state.runId}:h${state.humanCount + 1}`,
        escalation: 'check_changed',
        reason: 'prd_requirement_change',
        question: question.slice(0, MAX_ESCALATION_QUESTION_CHARS),
        options: CHECK_CHANGE_OPTIONS.map((option) => ({ ...option })),
        recommendation: 'keep_requirement',
        evidenceChecked: [review.assignmentId],
        independentWork: '',
        relatedDecisionIds: [],
        final: review.final,
        review,
      },
    };
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
      // A lane that never reached the shared workspace cannot have attested or reported scope violations.
      const unintegrated = !later && isUnintegratedLane(outcome.writerExecution);
      return {
        attemptId: outcome.attemptId,
        role: outcome.role,
        // A reconciled execution row proves the writer ran even when its task carried no writerExecution.
        ran: (outcome.writerExecution != null && outcome.effects !== 'none' && !unintegrated) || later?.state === 'reconciled' || later?.state === 'legacy_unverified',
        completed: outcome.status === 'TASK_STATE_COMPLETED',
        reportValid: outcome.report != null,
        reportOutcome: outcome.report?.outcome || null,
        reportedScopeViolations: outcome.writerExecution?.lane?.state === 'not_integrated' ? [] : (outcome.scopeViolations || []),
        attestedScopeViolations: unintegrated ? [] : later ? (later.attestedScopeViolations || []) : (outcome.attestedScopeViolations || []),
        deltaKnown: later ? later.deltaKnown === true : outcome.attestedDeltaKnown === true,
      };
    });
  }

  async function assess(state, signal) {
    const writers = acceptanceWriters(state);
    const unresolvedWriterCount = state.unresolvedWriters.length;
    const snapshot = deps.snapshot;
    const checks = state.contract?.requiredChecks || [];
    if (state.contract?.invalid) {
      return unrunAcceptance('contract_invalid', state.contract.invalid.detail || 'The stored acceptance contract is invalid.');
    }
    if (checks.length === 0) {
      return assessWithoutChecks({ workspace, writers, unresolvedWriterCount, ...(snapshot ? { snapshot } : {}) });
    }
    return runAcceptance({
      workspace,
      runId: state.runId,
      attempt: (state.acceptanceRuns || 0) + 1,
      contract: state.contract,
      writers,
      unresolvedWriterCount,
      admission: deps.admission,
      runCheckImpl: deps.runCheckImpl,
      // Agent-proposed checks run only through the App Server sandbox.
      appServer,
      // LL-6: changes a review judged as weakening fail without a new review.
      weakened: (state.checkReviews || []).filter((entry) => entry.verdict === 'weaken')
        .flatMap((entry) => entry.checks.map((check) => ({ checkId: check.id, pins: check.pins, by: entry.by }))),
      ...(deps.evidenceStore ? { evidenceStore: deps.evidenceStore } : {}),
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
      acceptance = unrunAcceptance('acceptance_error', errorText(error), (state.contract?.requiredChecks || []).map((check) => check.id));
    }
    deps.emit(runtime.onEvent, { type: 'acceptance', round: state.round, disposition: acceptance.disposition, reasons: acceptance.reasons });
    const runs = { acceptance, acceptanceRuns: (state.acceptanceRuns || 0) + 1 };
    // LL-6 progress: a check that passes now and did not pass in the previous acceptance run.
    const before = new Set((state.acceptance?.checks || []).filter((check) => check?.result === 'passed').map((check) => check.id));
    const newlyPassing = state.acceptance ? (acceptance.checks || []).filter((check) => check?.result === 'passed' && !before.has(check.id)).map((check) => check.id) : [];
    if (newlyPassing.length > 0) runs.progress = addProgress(state, [{ round: state.round, kind: 'check_passed', detail: newlyPassing.join(', ') }]);
    // LL-6: a changed pinned check goes to an independent read-only review first; the run is not finished yet.
    const review = startReview(state, acceptance);
    if (review) return { ...runs, ...review, status: null };
    if (acceptance.disposition === 'rejected' && state.acceptanceAttempts < 1) {
      return { ...runs, acceptanceAttempts: state.acceptanceAttempts + 1, status: null, text: '' };
    }
    return runs;
  }

  async function finish(state) {
    let acceptance = state.acceptance;
    if (!acceptance) {
      // Canceled, max_rounds or failed before any acceptance run: report what is known without running checks.
      const checks = state.contract?.requiredChecks || [];
      if (state.contract?.invalid) {
        acceptance = unrunAcceptance('contract_invalid', state.contract.invalid.detail || 'The stored acceptance contract is invalid.');
      } else if (checks.length > 0) {
        acceptance = unrunAcceptance('acceptance_not_run', 'The run ended before the required checks were run.', checks.map((check) => check.id));
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
        text: state.text,
        rounds: state.round,
        assignments: state.outcomes,
        acceptance,
      },
    };
  }

  const afterDecide = (state) => {
    if (state.status === 'completed') return 'accept';
    if (state.status) return 'finish';
    if (state.budget) return 'budget_pause';
    if (state.humanRequest) return 'human_input';
    if (state.retryDecide || state.redecide) return 'decide';
    return 'dispatch';
  };
  const afterAccept = (state) => {
    if (state.status) return 'finish';
    return state.batch ? 'dispatch' : 'decide';
  };
  const afterReviewCheck = (state) => (state.humanRequest ? 'human_input' : 'accept');
  const afterHumanInput = (state) => (state.status === 'completed' ? 'accept' : 'decide');
  const afterCollect = (state) => {
    if (state.status === 'canceled') return 'verify';
    if (state.batch.items.some((item) => item.state === 'pending')) return 'dispatch';
    return 'verify';
  };
  const afterVerify = (state) => {
    if (state.status === 'canceled') return 'finish';
    if (state.unresolvedWriters.length > 0) return 'reconcile';
    if (state.budget) return 'budget_pause';
    if (state.checkReview) return 'review_check';
    return 'decide';
  };
  const afterReconcile = (state) => (state.budget ? 'budget_pause' : 'decide');
  const afterContinueLimited = (state) => {
    if (state.status) return 'finish';
    if (state.batch) return 'dispatch';
    return state.checkReview ? 'review_check' : 'decide';
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
    .addNode('continue_limited', continueLimited)
    .addNode('accept', accept)
    .addNode('review_check', reviewCheck)
    .addNode('finish', finish)
    .addEdge(START, 'intake')
    .addEdge('intake', 'decide')
    .addConditionalEdges('decide', afterDecide, ['finish', 'accept', 'budget_pause', 'human_input', 'dispatch', 'decide'])
    .addConditionalEdges('accept', afterAccept, ['finish', 'decide', 'dispatch'])
    .addConditionalEdges('review_check', afterReviewCheck, ['accept', 'human_input'])
    .addEdge('dispatch', 'collect')
    .addConditionalEdges('collect', afterCollect, ['dispatch', 'verify'])
    .addConditionalEdges('verify', afterVerify, ['finish', 'reconcile', 'budget_pause', 'review_check', 'decide'])
    .addConditionalEdges('reconcile', afterReconcile, ['budget_pause', 'decide'])
    .addConditionalEdges('human_input', afterHumanInput, ['accept', 'decide'])
    .addEdge('budget_pause', 'continue_limited')
    .addConditionalEdges('continue_limited', afterContinueLimited, ['finish', 'dispatch', 'review_check', 'decide'])
    .addEdge('finish', END);

  return deps.checkpointer ? graph.compile({ checkpointer: deps.checkpointer }) : graph;
}

module.exports = {
  buildLeadGraph,
  boundedOutcomes,
  analyzeWorker,
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
