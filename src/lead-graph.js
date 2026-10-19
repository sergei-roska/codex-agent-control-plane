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
  checkDecisionRecordsShape, safeRelativePath,
} = require('./contracts');
const {
  runAcceptance, assessWithoutChecks, unrunAcceptance, validateAgentChecks, AGENT_CHECK_TOOLS, currentPins, repinChecks, describePinChanges,
} = require('./acceptance');
const { assignmentId: makeAssignmentId, attemptId: makeAttemptId, deterministicContextId } = require('./durable-store');
const { loadSkillCatalog, findSkillCandidates, resolveSkillSelection } = require('./skill-catalog');
const { loadMcpCatalog, findMcpToolCandidates, mcpToolPins } = require('./mcp-catalog');
const { withConnectors, resolveManagedToolSelection: resolveMcpToolSelection } = require('./connector-catalog');
const {
  AUT03_SKILL_ID, AUT03_SKILL_SHA256, expectedLeadSkillContext,
  resolveLeadSelectedSkills, sameLeadSkillContext,
} = require('./aut03-lead-skill');
const { canonicalRoleId, getRole, roleDisplayName } = require('./role-names');
const { InMemoryStagingLog } = require('./staging-log');
const {
  POLICY_ID, isGatedReview, sameReviewScope, computeReviewTarget, reviewResult,
} = require('./review-policy');
const {
  makeObservation, observeLoopGuard, resetLoopGuard, reportEvidenceIdentity, warningText,
} = require('./loop-guard');
const { unreviewedIds, finalizeLedger } = require('./partial-ledger');

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
const PATH_RULE = "allowedFiles entries are repository-relative paths or directory prefixes without '.', '..', globs, absolute paths, or a leading '/'; writable roles need 1-20 entries, read-only roles may use []. Each assignment list has at most 20 entries and each string is at most 3000 characters. Skills are limited to 5 IDs.";
const ASSIGNMENT_SCOPE_RULE = 'Use exact role IDs shown in Available roles, not display labels. Every writable role, including orch-verifier, requires explicit allowedFiles even when it only inspects files or runs checks. allowedFiles grants write permission; it does not require edits. For a verifier, choose a bounded set of existing test/check files or the narrowest existing test/check directory supported by workspace evidence. Do not use [] or guess/expand paths; dispatch a read-only explorer first if those paths are unknown. The verifier may inspect the declared review paths but can only write within allowedFiles.';
const DELTA_REMINDER = `The rules, roles, and output format from the start of this thread still apply. Return only one JSON object matching the supplied schema. ${ASSIGNMENT_SCOPE_RULE} ${PATH_RULE} Give workers exact paths with line ranges and established facts in inputs/evidence; do not read large files yourself, dispatch an explorer for broad reading.`;
const TEXT_PROJECTION_HEAD = 6000;
const TEXT_PROJECTION_TAIL = 2000;
const TEXT_EVIDENCE_THRESHOLD = TEXT_PROJECTION_HEAD + TEXT_PROJECTION_TAIL;
const DIGEST_SUMMARY_CHARS = 300;
const REPORT_CAPS = { filesChanged: 100, filesInspected: 20, risks: 20, checks: 20, scopeExpansion: 20 };
const REPORT_ITEM_CHARS = 500;
const REVIEW_RECOVERY_VERSION = 1;
const MAX_REVIEW_RECOVERY_CHECKPOINTS = 40;
const MAX_REVIEW_RECOVERY_GENERATIONS = 2;
// An explicit owner choice may add exactly one recovery generation to a checkpoint stopped at the cap.
const OWNER_RECOVERY_GRANT_CHOICE = 'supported_controller_replan';
const OWNER_RECOVERY_GRANT_GENERATIONS = 1;
const MAX_OWNER_GRANT_ANSWER_CHARS = 2000;
const MAX_REVIEW_HANDOFF_INPUTS = 20;
const MAX_REVIEW_HANDOFF_INPUT_CHARS = 3000;
const MAX_REVIEW_HANDOFF_CHARS = 55_000;
const MAX_REVIEW_HANDOFF_EVIDENCE_CHARS = 12_000;
const REVIEW_HANDOFF_PART_CHARS = 2950;
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const CANCELED_TEXT = 'Canceled after all active A2A tasks were confirmed stopped.';
const REPORT_CONTRACT_LINE = `Reply with a single JSON object matching the ${WORKER_REPORT_CONTRACT} report schema `
  + '(outcome, summary, filesChanged, filesInspected, checks, risks, scopeExpansion, decisionRequest). '
  + 'Use outcome needs_decision with a decisionRequest only after checking the evidence yourself.';
const ACCEPTANCE_AUDIT_REPORT_LINE = 'For an acceptance audit, the summary first line must be exactly VERDICT: pass, VERDICT: fail, or VERDICT: inconclusive, with no added text or punctuation. '
  + 'The checks array records only required checks actually performed or explicit validation of cited prior evidence; each detail says what was actually validated. Never describe reused tests as freshly executed. '
  + 'Put supplemental diagnostic commands, forbidden or unrun excluded tests, and reused verifier evidence in risks with a command/result or evidence reference and its limitation. '
  + 'Keep assigned failed or unrun checks in checks; they prevent acceptance. Do not invent runs.';

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
  const serviceBoundary = status?.message?.metadata?.boundary;
  const serviceBoundaryResults = Array.isArray(serviceBoundary?.results) ? serviceBoundary.results.slice(0, 10).map((entry) => ({
    predicate: typeof entry?.predicate === 'string' ? entry.predicate.slice(0, 80) : null,
    code: typeof entry?.code === 'string' ? entry.code.slice(0, 80) : null,
    result: typeof entry?.result === 'string' ? entry.result.slice(0, 32) : null,
  })) : [];
  const writerExecution = artifacts.map((artifact) => artifact.metadata?.writerExecution).find((entry) => entry && typeof entry === 'object')
    || (status?.message?.metadata?.writerExecution && typeof status.message.metadata.writerExecution === 'object' ? status.message.metadata.writerExecution : null);
  const effects = status?.message?.metadata?.effects;
  // The thread data of a finished turn: failure metadata, else the result artifact's metadata.
  const continuation = status?.message?.metadata?.continuation
    ?? artifacts.map((artifact) => artifact.metadata?.continuation).find((entry) => entry && typeof entry === 'object');
  const metadataValues = (field) => [
    ...artifacts.map((artifact) => artifact.metadata?.[field]),
    status?.message?.metadata?.[field],
  ].filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  const coverageValues = metadataValues('reviewCoverage');
  const reviewValues = metadataValues('review');
  const reviewCoverage = coverageValues.length > 0 ? {
    targetKnown: coverageValues.every((entry) => entry.targetKnown === true || entry.known === true),
    stable: coverageValues.every((entry) => entry.stable === true),
    identityPresent: coverageValues.every((entry) => typeof entry.targetIdentity === 'string' && entry.targetIdentity.length > 0)
      && new Set(coverageValues.map((entry) => entry.targetIdentity)).size === 1,
    status: coverageValues.find((entry) => typeof entry.status === 'string' && entry.status !== 'accepted')?.status?.slice(0, 64)
      || coverageValues.find((entry) => typeof entry.status === 'string')?.status?.slice(0, 64) || null,
    reason: coverageValues.find((entry) => typeof entry.reason === 'string' && entry.reason)?.reason?.slice(0, 300) || null,
  } : null;
  const consistentField = (field, max) => {
    const values = reviewValues.map((entry) => entry[field]);
    if (values.length === 0 || values.some((value) => typeof value !== 'string') || new Set(values).size !== 1) return null;
    return values[0].slice(0, max);
  };
  const reviewResultMetadata = reviewValues.length > 0 ? {
    policyId: consistentField('policyId', 64),
    kind: consistentField('kind', 64),
    checkpointId: consistentField('checkpointId', 128),
    status: reviewValues.find((entry) => typeof entry.status === 'string' && entry.status !== 'accepted')?.status?.slice(0, 64)
      || consistentField('status', 64),
    accepted: reviewValues.every((entry) => entry.accepted === true),
    valid: reviewValues.every((entry) => entry.valid === true),
    verdict: consistentField('verdict', 64),
    reason: reviewValues.find((entry) => typeof entry.reason === 'string' && entry.reason)?.reason?.slice(0, 300) || null,
  } : null;
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
    ...(serviceBoundaryResults.length > 0 ? { serviceBoundary: { results: serviceBoundaryResults } } : {}),
    ...(continuation && typeof continuation === 'object' && !Array.isArray(continuation) ? { continuation } : {}),
    ...(reviewCoverage ? { reviewCoverage } : {}),
    ...(reviewResultMetadata ? { reviewResult: reviewResultMetadata } : {}),
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
function readPinned({ roles, leadRole, workspace, skillCatalog, mcpCatalog }) {
  const rules = [...roles.values()].map((role) => [role.name, role.sandbox, role.model, role.effort, role.instructions || '', role.tools?.mcpServers || [], role.tools?.skills === true])
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
    mcpTools: [...(mcpCatalog || new Map()).values()].map(({ id, sha256: hash }) => ({ id, sha256: hash }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// Per-role profile hash pinned into each attempt's boundary contract.
function roleProfileSha256(role) {
  return sha256(JSON.stringify([role.name, role.sandbox, role.model, role.effort, role.instructions || '', role.tools?.mcpServers || [], role.tools?.skills === true]));
}

function legacyRoleProfileHashesWithoutMcp(role) {
  const profile = [role.name, role.sandbox, role.model, role.effort, role.instructions || ''];
  const hashes = new Set([sha256(JSON.stringify([...profile, role.tools?.skills === true]))]);
  if (role.tools?.skills !== true) hashes.add(sha256(JSON.stringify(profile)));
  return hashes;
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

function isTestCheckPath(file, workspace) {
  const relative = normalizeRel(file, workspace);
  const parts = relative.split('/').filter(Boolean);
  const testDirectory = parts.some((part) => /^(?:__tests__|__checks__|test|tests|spec|specs|check|checks)$/i.test(part));
  const name = parts.at(-1) || '';
  const testFile = /\.(?:test|spec)\.[^./]+$/i.test(name) || /(?:^|[._-])(?:test|check|spec)(?:[._-]|$)/i.test(name);
  return testDirectory || testFile;
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
  let loopEvidenceIdentity = null;
  if (parsed.report) {
    loopEvidenceIdentity = reportEvidenceIdentity(parsed.report, { role: canonicalRoleId(ctx.role) });
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
    ...(loopEvidenceIdentity ? { loopEvidenceIdentity } : {}),
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

const OWNER_PAUSE_MESSAGE = 'Paused by the owner';
const STOPPED_MESSAGE = 'Stopped by the owner';
const MAX_AUTO_REJECTIONS = 2;
const MAX_CONTINUATIONS = 2;
const MAX_ESCALATION_QUESTION_CHARS = 3000;
// LL-1: owner choices when the lead finishes without reaching the goal or the round limit is reached.
const ESCALATION_OPTIONS = [
  { id: 'continue', description: 'Continue: another attempt using this run\'s configured round allowance, with your answer as a note to the lead' },
  { id: 'accept_as_is', description: 'Accept as is: finish now with the current result (acceptance still runs)' },
  { id: 'change_goal', description: 'Change goal: your answer replaces the goal, with a fresh round budget' },
];
const ESCALATION_CHOICES = ESCALATION_OPTIONS.map((option) => option.id);
// B2: an owner answer with one of these option ids to an infeasible_requirement or credentials_or_access request
// takes the cited checkpoints out of the run.
const CHECKPOINT_BLOCK_REASONS = ['infeasible_requirement', 'credentials_or_access'];
const CHECKPOINT_BLOCK_CHOICES = ['defer', 'outside_run'];
const MAX_PROGRESS_ENTRIES = 50;
const OWNER_ONLY_RULE = 'Owner-only decisions are a closed list (humanInput.reason): paid_resources (spending money or paid resources beyond the run), credentials_or_access (credentials and access grants), external_write (publishing or writing to external systems), irreversible_operation, prd_requirement_change (removing or weakening a requirement the PRD states), and infeasible_requirement (an investigation proved that a requirement cannot be met because a dependency or the environment lacks a capability; cite the exact version or setting and the evidence; options must include substitute evidence, changing the dependency or environment, and deferring the requirement). Interpreting the PRD, choosing an implementation, and expanding file scope are your decisions after investigation. Fixing evidence tooling means collecting or presenting evidence the platform already provides; building a substitute for a capability the platform lacks is scope expansion that needs the owner. For infeasible_requirement and credentials_or_access name the option that defers the work "defer" and the option that says the owner will do it outside this run "outside_run"; either answer blocks the review checkpoints you cite by checkpointId or by assignmentId in evidenceChecked and ends reviewer dispatch for them.';
const INVESTIGATION_RULE = 'An investigation is a finished read-only outcome (explorer first; use auditor only for a concrete risk-boundary question, or scout/architect when appropriate) with a valid report from a round after the blocker first appeared (after the latest related open worker decision; for a repeated unmet-goal finish, after the first one); cite its assignmentId in humanInput.evidenceChecked or relatedDecisionIds (in final for a finish).';
// LL-6 check_changed review: a read-only reviewer judges a changed pinned check against the PRD.
const REVIEW_ROLES = ['auditor', 'architect', 'explorer', 'scout'];
const CHECK_CHANGE_OPTIONS = [
  { id: 'approve_change', description: 'Approve: the PRD requirement changes; the changed check is re-pinned' },
  { id: 'keep_requirement', description: 'Keep the requirement: the changed check fails and the lead fixes the cause' },
];
const CHECK_RULE = `acceptanceChecks entries are { id, argv, timeoutMs } (at most 10, timeoutMs null for the default); argv[0] is a script path inside the workspace or one of ${AGENT_CHECK_TOOLS.join(', ')}; bash and sh need a workspace script as argv[1]; inline code (-c, -e, --eval, -p) and echo, true, false, test, [, yes are refused.`;
const RULE_REMINDERS = {
  'assignment.paths': PATH_RULE,
  'assignment.writer_scope': `${ASSIGNMENT_SCOPE_RULE} ${PATH_RULE}`,
  'decision.parse': 'Return only one JSON object matching the supplied schema.',
  'decision.envelope': 'The JSON must contain exactly action, assignments, final, resolutions, humanInput, goalAchieved, acceptanceChecks, records, and checkpoints, with unused fields empty or null. A dispatch needs 1 to 4 assignments. If there is nothing to dispatch, use finish or request_human_input instead of an empty dispatch.',
  'decision.goal': 'finish requires goalAchieved true or false: true only when the goal is met, false with the blockers named in final. Use null for dispatch and request_human_input.',
  'decision.partial': 'checkpoints is null or a ledger of {id, status, reason, evidence} entries with status accepted (evidence required), blocked, or not_started (reason required); at least one entry is not accepted, ids are unique, and a ledger needs finish with goalAchieved false.',
  'decision.checkpoint_blocked': 'The owner deferred this checkpoint or took its remaining work outside the run. Dispatch no more verifier or auditor work for it; when every remaining checkpoint is accepted or blocked, finish with goalAchieved false and the checkpoints ledger.',
  'decision.investigate_first': `Investigate first: dispatch a read-only explorer first; use auditor only for a concrete risk-boundary question. ${INVESTIGATION_RULE} ${OWNER_ONLY_RULE}`,
  'decision.acceptance_checks': `${CHECK_RULE} Use null to propose nothing.`,
  'decision.resolutions': 'Resolve every open worker decision in resolutions, or list it in humanInput.relatedDecisionIds when it is owner-only; a dispatch of only read-only roles may leave them open while you investigate them.',
  'assignment.shape': 'Each assignment needs exactly role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, stopConditions, skills, mcpTools, wave, continueFrom, and review; role must be an available role id.',
  'assignment.review': 'Use review:null for unrelated read-only or non-material administrative/document work. Material implementation declares {kind, checkpointId, reason, paths, evidenceIds, prerequisiteFor}, using prerequisiteFor:[] by default. Verifier and auditor must cite the same checkpoint, scope, reason, evidence IDs, and prerequisiteFor. A new gated verifier may link the exact complete set of pending critical checkpoint IDs; its matching auditor repeats the list. Routine material work needs verifier evidence; critical work needs verifier then auditor evidence.',
  'decision.review_gate': 'A required review receipt is missing, failed, stale, or has unknown target identity. Dispatch the verifier first; for critical work dispatch the auditor after a passing verifier. A single new gated verifier may cross pending critical gates only when it links their exact complete ID set and has no co-dispatched writer; its auditor repeats that link. All original and new critical checkpoints still need current-target verifier and auditor receipts before finish. Repair may continue under the same checkpoint; unrelated writers wait for critical audit completion.',
  'assignment.continue_from': 'continueFrom is null or the assignmentId of a finished outcome of this run with the same role; each such id may be used by one assignment of a decision.',
  'assignment.wave': 'wave is an integer >= 1 or null; consecutive assignments with the same wave run concurrently, and writers in one wave need pairwise disjoint allowedFiles. Reviewers cannot share a wave with writers; run verifier before auditor in successive execution groups of the same decision when possible.',
  'assignment.skills': 'Select at most 5 unique skill IDs from the trusted listed skill IDs; use [] when none apply.',
  'assignment.mcp_tools': 'Select the minimum useful MCP tool IDs for the exact task. Use [] by default and never exceed 5 unique IDs. Only select IDs listed in the trusted MCP catalog; live Drupal tools can return sensitive data, and drupal-db-ops includes settings.php execution.',
  'dispatch.mcp_tool_pins': 'The selected MCP tool catalog changed after planning. Re-read the current catalog and select tools again before dispatch.',
  'assignment.role_ladder': 'Respect the role ladder: recovery-engineer follows an engineer attempt, senior-engineer follows recovery-engineer, and architect needs prior evidence and one narrow decision.',
  'dispatch.writer_unresolved': 'Do not dispatch writable roles while writer outcomes are unresolved; use read-only roles.',
};

const last = (initial) => Annotation({ reducer: (_, next) => next, default: initial });

const LeadState = Annotation.Root({
  goal: last(() => ''),
  runId: last(() => ''),
  pinned: last(() => null),
  leadSkillContext: last(() => null),
  threadId: last(() => null),
  round: last(() => 0),
  attemptedRoles: last(() => []),
  outcomes: last(() => []),
  pendingAssignments: last(() => null),
  reviewObligations: last(() => []),
  reviewRecovery: last(() => ({ version: REVIEW_RECOVERY_VERSION, checkpoints: [] })),
  batch: last(() => null),
  openDecisions: last(() => []),
  closedDecisions: last(() => []),
  humanRequest: last(() => null),
  // Legacy-resume only: checkpoints written before the system repair route was removed carry this key.
  systemRequest: last(() => null),
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
  // The partial-result ledger of a finish with goalAchieved false ({ checkpoints }), and the checkpoints
  // the owner deferred or took outside the run ([{ checkpointId, reason, decisionId, round }]).
  partial: last(() => null),
  blockedCheckpoints: last(() => []),
  acceptanceRuns: last(() => 0),
  acceptance: last(() => null),
  status: last(() => null),
  // STOP-01: the run was canceled by a shutdown stop and finish must park it (see canceledUpdate).
  parkOnStop: last(() => false),
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
  // LL-8: bounded checkpointed observations and the current repeated-work episode.
  loopGuard: last(() => null),
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
 *   aut03TrialRunIds?: Set<string>, aut03LeadSkillEnabled?: boolean, aut03SkillPin?: { id, sha256 },
 *   parallelWriters?: boolean, usageLedger?: UsageLedger, activityStore?: ActivityStore, evidenceStore?: EvidenceStore, runCheckImpl?, snapshot?,
 *   acceptanceScratch?: { env: string[], baseDir: string } (owner setting),
 *   stagingLog?: StagingLog,
 * }
 * Returns the compiled graph when deps.checkpointer is given, else the StateGraph.
 */
function buildLeadGraph(deps) {
  const {
    appServer, roles, leadRole, workspace, maxRounds, journal, pollIntervalMs,
  } = deps;
  const skillCatalog = deps.skillCatalog || loadSkillCatalog();
  const mcpCatalog = withConnectors(deps.mcpCatalog || loadMcpCatalog());
  const trialRunIds = deps.aut03TrialRunIds instanceof Set ? deps.aut03TrialRunIds : new Set();
  const aut03LeadSkillEnabled = deps.aut03LeadSkillEnabled === true;
  const skillPin = deps.aut03SkillPin || { id: AUT03_SKILL_ID, sha256: AUT03_SKILL_SHA256 };
  const { admission } = deps;
  const stagingLog = deps.stagingLog || new InMemoryStagingLog();
  const reconcileWaitMs = Number.isFinite(deps.reconcileWaitMs) ? deps.reconcileWaitMs : DEFAULT_RECONCILE_WAIT_MS;

  // Threshold: the explicit setting, else 60% of the known context window, else the default.
  const rolloverThreshold = (contextWindow) => (Number.isFinite(deps.rolloverTokens) ? deps.rolloverTokens
    : Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow * ROLLOVER_WINDOW_FRACTION : DEFAULT_LEAD_ROLLOVER_TOKENS);
  const runtimeOf = (config) => deps.runtimeFor(config?.configurable?.thread_id) || {};
  const requestOptions = (signal) => ({ ...(signal ? { signal } : {}), ...deps.authOptions() });

  function recordStage(type, event) {
    const base = { type, ...event };
    const eventId = `stage:v1:${sha256(JSON.stringify(base))}`;
    return stagingLog.record({ eventId, ...base });
  }

  // A grant exists only on a checkpoint that was at the cap and moved exactly one generation past it.
  function validOwnerGrant(entry) {
    const grant = entry.ownerGrant;
    if (grant === undefined || grant === null) return entry.generation <= MAX_REVIEW_RECOVERY_GENERATIONS;
    return typeof grant === 'object' && !Array.isArray(grant)
      && typeof grant.decisionId === 'string' && grant.decisionId.length > 0 && grant.decisionId.length <= 256
      && grant.choice === OWNER_RECOVERY_GRANT_CHOICE
      && typeof grant.answer === 'string' && grant.answer.length <= MAX_OWNER_GRANT_ANSWER_CHARS
      && typeof grant.grantedAt === 'string' && Number.isFinite(Date.parse(grant.grantedAt))
      && grant.generationBefore === MAX_REVIEW_RECOVERY_GENERATIONS
      && entry.generation === grant.generationBefore + OWNER_RECOVERY_GRANT_GENERATIONS;
  }

  const recoveryGenerationCap = (entry) => MAX_REVIEW_RECOVERY_GENERATIONS
    + (entry.ownerGrant ? OWNER_RECOVERY_GRANT_GENERATIONS : 0);

  function validReviewRecovery(value) {
    const validTemplate = (role, template) => template && typeof template === 'object' && !Array.isArray(template)
      && canonicalRoleId(template.role) === role
      && Array.isArray(template.allowedFiles) && template.allowedFiles.length <= 20
      && template.allowedFiles.every((file) => typeof file === 'string' && file.length > 0 && file.length <= 3000)
      && Array.isArray(template.skills) && template.skills.length <= 5
      && template.skills.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
      && Array.isArray(template.skillPins) && template.skillPins.length <= 5
      && template.skillPins.every((pin) => pin && typeof pin.id === 'string' && typeof pin.sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(pin.sha256))
      && (template.mcpTools === undefined || (Array.isArray(template.mcpTools) && template.mcpTools.length <= 5
        && template.mcpTools.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)))
      && (template.mcpToolPins === undefined || (Array.isArray(template.mcpToolPins) && template.mcpToolPins.length <= 5
        && template.mcpToolPins.every((pin) => pin && typeof pin.id === 'string' && typeof pin.sha256 === 'string'
          && /^[a-f0-9]{64}$/.test(pin.sha256))))
      && typeof template.roleProfileSha256 === 'string' && /^[a-f0-9]{64}$/.test(template.roleProfileSha256);
    return Boolean(value && value.version === REVIEW_RECOVERY_VERSION && Array.isArray(value.checkpoints)
      && value.checkpoints.length <= MAX_REVIEW_RECOVERY_CHECKPOINTS
      && new Set(value.checkpoints.map((entry) => entry?.checkpointId)).size === value.checkpoints.length
      && value.checkpoints.every((entry) => entry && entry.version === REVIEW_RECOVERY_VERSION
        && typeof entry.checkpointId === 'string' && entry.checkpointId.length > 0 && entry.checkpointId.length <= 160
        && typeof entry.contextHash === 'string' && /^[a-f0-9]{64}$/.test(entry.contextHash)
        && Number.isInteger(entry.generation) && entry.generation >= 0
        && validOwnerGrant(entry)
        && (entry.blockedReason === undefined || entry.blockedReason === null
          || (typeof entry.blockedReason === 'string' && entry.blockedReason.length > 0 && entry.blockedReason.length <= 128))
        && (entry.lastRecoveryTarget === null || (typeof entry.lastRecoveryTarget === 'string' && entry.lastRecoveryTarget.length <= 256))
        && (entry.sourceAssignmentId === null || (typeof entry.sourceAssignmentId === 'string' && entry.sourceAssignmentId.length <= 256))
        && (entry.sourceAttemptId === null || (typeof entry.sourceAttemptId === 'string' && entry.sourceAttemptId.length <= 256))
        && ['idle', 'verifier_pending', 'auditor_pending', 'complete', 'replan_required'].includes(entry.phase)
        && entry.templates && typeof entry.templates === 'object' && !Array.isArray(entry.templates)
        && Object.keys(entry.templates).every((role) => ['verifier', 'auditor'].includes(role)
          && validTemplate(role, entry.templates[role]))));
  }

  function reviewContextHash(review) {
    return sha256(JSON.stringify({
      kind: review.kind,
      checkpointId: review.checkpointId,
      reason: review.reason,
      paths: [...review.paths].sort(),
      evidenceIds: [...review.evidenceIds].sort(),
      prerequisiteFor: [...(review.prerequisiteFor || [])].sort(),
    }));
  }

  function captureReviewRecoveryTemplates(previous, assignments) {
    if (!validReviewRecovery(previous)) return previous;
    const checkpoints = previous.checkpoints.map((entry) => ({ ...entry, templates: { ...entry.templates } }));
    for (const assignment of assignments) {
      const role = canonicalRoleId(assignment.role);
      if (!['verifier', 'auditor'].includes(role) || !assignment.review
        || (!isGatedReview(assignment.review) && assignment.review.kind !== 'routine')) continue;
      const profile = getRole(roles, assignment.role);
      if (!profile) continue;
      const contextHash = reviewContextHash(assignment.review);
      let entry = checkpoints.find((candidate) => candidate.checkpointId === assignment.review.checkpointId);
      if (!entry) {
        if (checkpoints.length >= MAX_REVIEW_RECOVERY_CHECKPOINTS) continue;
        entry = {
          version: REVIEW_RECOVERY_VERSION,
          checkpointId: assignment.review.checkpointId,
          contextHash,
          generation: 0,
          lastRecoveryTarget: null,
          phase: 'idle',
          blockedReason: null,
          sourceAssignmentId: null,
          sourceAttemptId: null,
          templates: {},
        };
        checkpoints.push(entry);
      }
      if (entry.contextHash !== contextHash) continue;
      entry.templates[role] = {
        role: assignment.role,
        allowedFiles: [...(assignment.allowedFiles || [])],
        skills: [...(assignment.skills || [])],
        skillPins: (assignment.skillPins || []).map(({ id, sha256: hash }) => ({ id, sha256: hash })),
        mcpTools: [...(assignment.mcpTools || [])],
        mcpToolPins: (assignment.mcpToolPins || []).map(({ id, sha256: hash }) => ({ id, sha256: hash })),
        roleProfileSha256: roleProfileSha256(profile),
      };
    }
    for (const assignment of assignments) {
      const review = assignment.review;
      if (canonicalRoleId(assignment.role) !== 'verifier' || !isGatedReview(review)) continue;
      const entry = checkpoints.find((candidate) => candidate.checkpointId === review.checkpointId);
      if (!entry || entry.contextHash !== reviewContextHash(review) || entry.templates.auditor) continue;
      const auditor = [...roles.values()].find((profile) => canonicalRoleId(profile.name) === 'auditor' && profile.sandbox === 'read-only');
      if (!auditor) continue;
      entry.templates.auditor = {
        role: auditor.name,
        allowedFiles: [],
        skills: [],
        skillPins: [],
        mcpTools: [],
        mcpToolPins: [],
        roleProfileSha256: roleProfileSha256(auditor),
      };
    }
    return { version: REVIEW_RECOVERY_VERSION, checkpoints };
  }

  function recoveryAssignment(state, entry, obligation, roleName) {
    const template = entry?.templates?.[roleName];
    const review = obligation?.review;
    const mcpTools = Array.isArray(template?.mcpTools) ? template.mcpTools : [];
    const mcpPins = Array.isArray(template?.mcpToolPins) ? template.mcpToolPins : [];
    if (!validReviewRecovery(state.reviewRecovery) || !template || !review
      || entry.contextHash !== reviewContextHash(review)
      || canonicalRoleId(template.role) !== roleName
      || !Array.isArray(template.allowedFiles) || !Array.isArray(template.skills)
      || !Array.isArray(template.skillPins) || template.skills.length > 5
      || mcpTools.length > 5 || mcpPins.length > 5
      || template.allowedFiles.some((file) => !safeRelativePath(file))
      || !Array.isArray(review.paths) || !Array.isArray(review.evidenceIds)) return null;
    const profile = getRole(roles, template.role);
    if (!profile) return null;
    const currentProfileMatches = roleProfileSha256(profile) === template.roleProfileSha256;
    const allowedMcpServers = profile.tools?.mcpServers;
    const legacyMcpPolicyIsSafe = allowedMcpServers === undefined
      || (Array.isArray(allowedMcpServers)
        && allowedMcpServers.every((name) => typeof name === 'string' && mcpCatalog.servers.has(name)));
    const toolFreeLegacyProfileMatches = template.skills.length === 0 && template.skillPins.length === 0
      && mcpTools.length === 0 && mcpPins.length === 0
      && legacyMcpPolicyIsSafe
      && legacyRoleProfileHashesWithoutMcp(profile).has(template.roleProfileSha256);
    if (!currentProfileMatches && !toolFreeLegacyProfileMatches) return null;
    if (roleName === 'verifier') {
      if (profile.sandbox === 'read-only' || template.allowedFiles.length === 0 || template.allowedFiles.length > 20
        || template.allowedFiles.some((file) => typeof file !== 'string' || !isTestCheckPath(file, workspace))) return null;
    } else if (profile.sandbox !== 'read-only' || template.allowedFiles.length !== 0) return null;
    try {
      resolveSkillSelection(skillCatalog, template.skills, { pins: template.skillPins });
      resolveMcpToolSelection(mcpCatalog, mcpTools, {
        pins: mcpPins,
        allowedServers: profile.tools?.mcpServers || [],
      });
    } catch (_) {
      return null;
    }
    return {
      role: template.role,
      objective: `Review the current workspace for checkpoint ${review.checkpointId}. The candidate changed after a prior review; use only the current target and stored checkpoint scope.`,
      allowedFiles: [...template.allowedFiles],
      inputs: [`Checkpoint: ${review.checkpointId}`],
      evidence: [...review.evidenceIds],
      acceptanceCriteria: [`Complete the ${roleName} review for the exact stored checkpoint context.`],
      checks: roleName === 'verifier' ? ['Run the relevant checks within the stored verifier scope.'] : ['Evaluate the current target and report a verdict.'],
      stopConditions: ['Stop if the current target, stored checkpoint context, or allowed scope is unavailable.'],
      skills: [...template.skills],
      skillPins: template.skillPins.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
      mcpTools: [...mcpTools],
      mcpToolPins: mcpPins.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
      wave: null,
      continueFrom: null,
      review: {
        kind: review.kind,
        checkpointId: review.checkpointId,
        reason: review.reason,
        paths: [...review.paths],
        evidenceIds: [...review.evidenceIds],
        prerequisiteFor: [...(review.prerequisiteFor || [])],
      },
      _reviewRecovery: { version: REVIEW_RECOVERY_VERSION, checkpointId: review.checkpointId, generation: entry.generation, role: roleName },
    };
  }

  function freshVerifierHandoff(obligation, target, recovery, verifierItem) {
    const review = obligation?.review;
    if (!target?.known || !review || canonicalRoleId(verifierItem?.role) !== 'verifier'
      || !obligationMatches(obligation, verifierItem.assignment?.review)) {
      return { error: 'fresh_verifier_context_unavailable' };
    }
    const receipt = latestReceiptEntry(obligation, 'verifier', target)?.receipt;
    if (receipt?.status !== 'accepted' || receipt.assignmentId !== verifierItem.assignmentId
      || receipt.attemptId !== verifierItem.attemptId || receipt.targetIdentity !== target.identity) {
      return { error: 'fresh_verifier_receipt_unavailable' };
    }
    const summary = verifierItem.reviewSummary || outcomeSummary(verifierItem);
    if (summary.status !== 'TASK_STATE_COMPLETED' || !summary.report || summary.report.outcome !== 'completed'
      || summary.report.decisionRequest || summary.reviewResult?.status !== 'accepted'
      || summary.reviewResult.accepted !== true || summary.reviewResult.valid !== true) {
      return { error: 'fresh_verifier_report_unavailable' };
    }

    const evidence = [];
    let evidenceChars = 0;
    for (const id of review.evidenceIds) {
      if (!/^ev_[0-9a-f]{32}$/.test(id)) {
        evidence.push({ id, storage: 'workspace_or_external_reference' });
        continue;
      }
      if (!deps.evidenceStore?.getRef || !deps.evidenceStore?.read) {
        evidence.push({ id, storage: 'evidence_store_unavailable' });
        continue;
      }
      try {
        const ref = deps.evidenceStore.getRef(id, { runId: verifierItem.runId });
        const remaining = Math.max(0, MAX_REVIEW_HANDOFF_EVIDENCE_CHARS - evidenceChars);
        const length = ref.stored ? Math.min(ref.storedBytes, remaining) : 0;
        const content = length > 0
          ? deps.evidenceStore.read(id, { runId: verifierItem.runId, length }).bytes.toString('utf8')
          : null;
        evidenceChars += content?.length || 0;
        evidence.push({
          id,
          storage: ref.stored ? (length === ref.storedBytes ? 'stored' : 'stored_truncated_for_handoff') : ref.error || 'payload_unavailable',
          kind: ref.kind,
          mediaType: ref.mediaType,
          summary: ref.summary,
          originalBytes: ref.originalBytes,
          storedBytes: ref.storedBytes,
          sha256: ref.sha256,
          originalSha256: ref.originalSha256,
          truncated: ref.truncated || length < ref.storedBytes,
          ...(content === null ? {} : { content }),
        });
      } catch (error) {
        evidence.push({ id, storage: error?.code || 'evidence_read_failed' });
      }
    }

    const handoff = {
      contract: 'fresh-review-handoff/v1',
      reviewContext: review,
      targetIdentity: target.identity,
      verifierReceipt: {
        role: 'verifier',
        checkpointId: review.checkpointId,
        generation: recovery?.generation ?? null,
        contextHash: recovery?.contextHash ?? reviewContextHash(review),
        status: receipt.status,
        assignmentId: receipt.assignmentId,
        attemptId: receipt.attemptId,
        targetIdentity: receipt.targetIdentity,
      },
      verifierReport: summary.report,
      citedEvidence: evidence,
    };
    const serialized = JSON.stringify(handoff);
    if (serialized.length > MAX_REVIEW_HANDOFF_CHARS) return { error: 'fresh_verifier_handoff_exceeds_limit' };

    const characters = Array.from(serialized);
    const chunks = [];
    let chunk = '';
    for (const character of characters) {
      if (chunk.length + character.length > REVIEW_HANDOFF_PART_CHARS && chunk) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += character;
    }
    if (chunk) chunks.push(chunk);
    if (chunks.length === 0) return { error: 'fresh_verifier_handoff_empty' };
    return {
      inputs: chunks.map((part, index) => {
        const prefix = `FRESH_REVIEW_HANDOFF/v1 ${index + 1}/${chunks.length}: `;
        return `${prefix}${part}`;
      }),
      instruction: 'Reconstruct the FRESH_REVIEW_HANDOFF/v1 JSON by concatenating its input parts in order. It contains the immutable stored review context, exact accepted fresh verifier receipt and report, and cited evidence payloads when available. Treat payloads as source data, inspect the current target independently, and reach your own verdict.',
    };
  }

  function attachFreshVerifierHandoff(assignment, obligation, target, recovery, verifierItem) {
    if (!assignment) return { assignment: null, error: 'validated_auditor_template_unavailable' };
    const handoff = freshVerifierHandoff(obligation, target, recovery, verifierItem);
    if (handoff.error) return { assignment: null, error: handoff.error };
    const inputs = [...assignment.inputs, ...handoff.inputs];
    const acceptanceCriteria = [...assignment.acceptanceCriteria, handoff.instruction];
    if (inputs.length > MAX_REVIEW_HANDOFF_INPUTS
      || inputs.some((input) => input.length > MAX_REVIEW_HANDOFF_INPUT_CHARS)
      || acceptanceCriteria.length > MAX_REVIEW_HANDOFF_INPUTS
      || acceptanceCriteria.some((criterion) => criterion.length > MAX_REVIEW_HANDOFF_INPUT_CHARS)) {
      return { assignment: null, error: 'fresh_verifier_handoff_exceeds_assignment_limits' };
    }
    return { assignment: { ...assignment, inputs, acceptanceCriteria }, error: null };
  }

  function planAutomaticReviewRecovery(state, batch, obligations, unresolvedWriters, runtime, config) {
    const original = state.reviewRecovery;
    if (!validReviewRecovery(original)) {
      for (const item of batch.items) {
        if (item.reviewSkipped && ['stale_review_continuation', 'stale_review_target'].includes(item.result?.status)) {
          recordStage('review_recovery', {
            runId: state.runId,
            assignmentId: item.assignmentId,
            attemptId: item.attemptId,
            role: canonicalRoleId(item.role),
            status: 'blocked',
            payload: { policyId: POLICY_ID, checkpointId: item.assignment?.review?.checkpointId || null, reason: 'recovery_state_invalid' },
          });
        }
      }
      return { recovery: original, pendingAssignments: null };
    }
    const checkpoints = original.checkpoints.map((entry) => ({ ...entry, templates: { ...entry.templates } }));
    const recovery = { version: REVIEW_RECOVERY_VERSION, checkpoints };
    let pendingAssignments = null;
    const findObligation = (checkpointId) => obligations.find((entry) => entry.checkpointId === checkpointId);
    const findRecovery = (checkpointId) => checkpoints.find((entry) => entry.checkpointId === checkpointId);
    const blocked = (entry, reason) => {
      entry.phase = 'replan_required';
      entry.blockedReason = reason;
      recordStage('review_recovery', {
        runId: state.runId,
        assignmentId: entry.sourceAssignmentId,
        attemptId: entry.sourceAttemptId,
        role: null,
        status: 'blocked',
        payload: { policyId: POLICY_ID, checkpointId: entry.checkpointId, generation: entry.generation, reason },
      });
    };
    const admissionBlock = () => {
      if (state.status) return 'run_status_set';
      if (state.budget) return 'budget_gate_active';
      if (ownerPauseRequested(config)) return 'owner_pause_requested';
      if (runtime.signal?.aborted) return 'run_canceled';
      if (batch.items.some((item) => item.result?.failureKind === 'usage_limit')) return 'worker_usage_limit';
      if (unresolvedWriters.length > 0) return 'writer_unresolved';
      const limit = roundLimit(state);
      if (limit !== null && state.round >= limit) return 'dispatch_round_limit';
      return null;
    };

    for (const item of batch.items) {
      const marker = item.reviewRecovery;
      if (!marker || marker.version !== REVIEW_RECOVERY_VERSION) continue;
      const entry = findRecovery(marker.checkpointId);
      const obligation = findObligation(marker.checkpointId);
      if (!entry || !obligation || !obligationMatches(obligation, obligation.review)
        || marker.generation !== entry.generation || marker.role !== canonicalRoleId(item.role)) continue;
      if (ownerBlockedIds(state).has(marker.checkpointId)) {
        blocked(entry, 'checkpoint_blocked_by_owner');
        continue;
      }
      const target = targetForReview({ ...state, reviewObligations: obligations }, obligation.review);
      if (marker.role === 'verifier' && entry.phase === 'verifier_pending') {
        if (item.result?.failureKind === 'usage_limit' && item.result.continuation) continue;
        const verifierReceipt = latestReceiptEntry(obligation, 'verifier', target)?.receipt;
        const freshVerifierAccepted = verifierReceipt?.status === 'accepted'
          && verifierReceipt.assignmentId === item.assignmentId && verifierReceipt.attemptId === item.attemptId;
        if (!target.known || !freshVerifierAccepted) {
          blocked(entry, target.known ? 'fresh_verifier_not_accepted' : 'current_target_unknown');
          continue;
        }
        if (!isGatedReview(obligation.review)) {
          entry.phase = 'complete';
          continue;
        }
        const auditor = recoveryAssignment({ ...state, reviewRecovery: recovery }, entry, obligation, 'auditor');
        const handoff = attachFreshVerifierHandoff(auditor, obligation, target, entry, item);
        if (!handoff.assignment) {
          blocked(entry, handoff.error);
          continue;
        }
        entry.phase = 'auditor_pending';
        pendingAssignments = [handoff.assignment];
        recordStage('review_recovery', {
          runId: state.runId,
          assignmentId: entry.sourceAssignmentId,
          attemptId: entry.sourceAttemptId,
          role: 'auditor',
          target: target.identity,
          status: 'auditor_queued',
          payload: { policyId: POLICY_ID, checkpointId: entry.checkpointId, generation: entry.generation },
        });
        break;
      }
      if (marker.role === 'auditor' && entry.phase === 'auditor_pending') {
        if (item.result?.failureKind === 'usage_limit' && item.result.continuation) continue;
        const receipt = latestReceiptEntry(obligation, 'auditor', target);
        if (target.known && receipt?.receipt.status === 'accepted'
          && receipt.receipt.assignmentId === item.assignmentId && receipt.receipt.attemptId === item.attemptId) {
          entry.phase = 'complete';
          entry.blockedReason = null;
        }
        else blocked(entry, target.known ? 'fresh_auditor_not_accepted' : 'current_target_unknown');
      }
    }

    for (const item of batch.items) {
      const review = item.assignment?.review;
      const entry = review && findRecovery(review.checkpointId);
      const obligation = review && findObligation(review.checkpointId);
      if (!review || item.reviewRecovery || canonicalRoleId(item.role) !== 'verifier'
        || entry?.phase !== 'replan_required'
        || !['fresh_verifier_not_accepted', 'fresh_auditor_not_accepted'].includes(entry.blockedReason)
        || !obligation || !obligationMatches(obligation, review)
        || entry.contextHash !== reviewContextHash(review) || item.reviewSkipped || item.reviewReused) continue;
      const target = targetForReview({ ...state, reviewObligations: obligations }, obligation.review);
      const receipt = latestReceiptEntry(obligation, 'verifier', target);
      if (!target.known || receipt?.receipt.status !== 'accepted'
        || receipt.receipt.assignmentId !== item.assignmentId || receipt.receipt.attemptId !== item.attemptId) continue;
      const bundledAuditor = batch.items.find((candidate) => candidate.state === 'finished'
        && !candidate.reviewSkipped && !candidate.reviewRecovery
        && canonicalRoleId(candidate.role) === 'auditor'
        && obligationMatches(obligation, candidate.assignment?.review)
        && Number.isInteger(candidate.group) && Number.isInteger(item.group)
        && candidate.group > item.group);
      if (bundledAuditor) {
        const auditReceipt = latestReceiptEntry(obligation, 'auditor', target)?.receipt;
        if (auditReceipt?.status === 'accepted' && auditReceipt.assignmentId === bundledAuditor.assignmentId
          && auditReceipt.attemptId === bundledAuditor.attemptId) {
          entry.phase = 'complete';
          entry.blockedReason = null;
        } else blocked(entry, 'fresh_auditor_not_accepted');
        continue;
      }
      const auditor = recoveryAssignment({ ...state, reviewRecovery: recovery }, entry, obligation, 'auditor');
      const handoff = attachFreshVerifierHandoff(auditor, obligation, target, entry, item);
      if (!handoff.assignment) {
        blocked(entry, handoff.error);
        continue;
      }
      entry.phase = 'auditor_pending';
      pendingAssignments = [handoff.assignment];
      recordStage('review_recovery', {
        runId: state.runId,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        role: 'auditor',
        target: target.identity,
        status: 'auditor_queued',
        payload: { policyId: POLICY_ID, checkpointId: entry.checkpointId, generation: entry.generation, trigger: 'fresh_verifier_accepted' },
      });
      break;
    }

    const admissionFailure = admissionBlock();
    if (pendingAssignments && admissionFailure) {
      const entry = findRecovery(pendingAssignments[0]._reviewRecovery.checkpointId);
      if (entry) blocked(entry, admissionFailure);
      pendingAssignments = null;
    }
    if (pendingAssignments || admissionFailure) {
      return { recovery, pendingAssignments };
    }

    for (const item of batch.items) {
      const review = item.assignment?.review;
      const role = canonicalRoleId(item.role);
      if (!review || !['verifier', 'auditor'].includes(role) || review.kind === 'pinned_check') continue;
      const resultStatus = item.result?.status;
      const receipt = obligations.find((entry) => entry.checkpointId === review.checkpointId)?.receipts
        ?.findLast((entry) => entry.attemptId === item.attemptId && entry.role === role) || null;
      const stalePreflight = item.reviewSkipped
        && ['stale_review_continuation', 'stale_review_target'].includes(resultStatus);
      const staleReceipt = receipt?.status === 'stale' && receipt.reason === 'review_target_changed_during_review';
      const serviceReview = item.reviewSummary?.reviewResult || outcomeSummary(item).reviewResult;
      const serviceCoverage = item.reviewSummary?.reviewCoverage || outcomeSummary(item).reviewCoverage;
      const trustedEndpointRejection = item.result?.failureKind === 'request_invalid'
        && item.result?.effects === 'none'
        && item.result?.serviceBoundary?.results?.some((entry) => entry.code === 'review_origin_stale')
        && serviceReview?.policyId === POLICY_ID
        && serviceReview.kind === review.kind
        && serviceReview.checkpointId === review.checkpointId
        && serviceReview.status === 'rejected'
        && serviceReview.accepted === false
        && serviceReview.valid === false
        && serviceReview.reason === 'review_origin_stale';
      const targetChangeReason = role === 'verifier' ? 'verifier_target_changed_during_review' : 'review_target_changed';
      const trustedUnstableReview = serviceReview?.policyId === POLICY_ID
        && serviceReview.kind === review.kind
        && serviceReview.checkpointId === review.checkpointId
        && ((serviceReview.status === 'inconclusive' && serviceReview.valid === false)
          || (serviceReview.status === 'accepted' && serviceReview.valid === true && serviceReview.accepted === true))
        && (serviceReview.reason === targetChangeReason || serviceCoverage?.reason === targetChangeReason)
        && serviceCoverage?.targetKnown === true
        && serviceCoverage.identityPresent === true
        && serviceCoverage.stable === false;
      if (!stalePreflight && !staleReceipt && !trustedEndpointRejection && !trustedUnstableReview) continue;
      const obligation = findObligation(review.checkpointId);
      const entry = findRecovery(review.checkpointId);
      if (!obligation || !obligationMatches(obligation, review) || !entry
        || entry.contextHash !== reviewContextHash(obligation.review)) continue;
      const gate = currentGateState({ ...state, reviewObligations: obligations, reviewRecovery: recovery }, obligation);
      if (trustedUnstableReview && role === 'verifier' && gate.verifier) continue;
      const captured = item.reviewTarget;
      const current = targetForReview({ ...state, reviewObligations: obligations }, obligation.review);
      if (!captured?.known || !current.known || (!(trustedEndpointRejection || trustedUnstableReview) && captured.identity === current.identity)
        || (trustedUnstableReview && captured.identity === current.identity)) {
        blocked(entry, !captured?.known || !current.known ? 'origin_or_current_target_unknown' : 'stale_signal_without_target_change');
        continue;
      }
      if (entry.generation >= recoveryGenerationCap(entry) || entry.lastRecoveryTarget === current.identity) {
        blocked(entry, entry.generation >= recoveryGenerationCap(entry) ? 'recovery_generation_limit' : 'repeated_stale_target');
        continue;
      }
      if ((obligation.pendingAssignmentIds || []).length > 0) {
        blocked(entry, 'checkpoint_writer_pending');
        continue;
      }
      const admissionFailure = admissionBlock();
      if (admissionFailure) {
        blocked(entry, admissionFailure);
        continue;
      }
      const generation = entry.generation + 1;
      const candidate = { ...entry, generation, lastRecoveryTarget: current.identity, phase: 'verifier_pending' };
      candidate.blockedReason = null;
      const nextRecovery = {
        version: REVIEW_RECOVERY_VERSION,
        checkpoints: checkpoints.map((value) => value.checkpointId === entry.checkpointId ? candidate : value),
      };
      const verifier = recoveryAssignment({ ...state, reviewRecovery: nextRecovery }, candidate, obligation, 'verifier');
      if (!verifier) {
        blocked(entry, 'validated_verifier_template_unavailable');
        continue;
      }
      candidate.sourceAssignmentId = item.assignmentId;
      candidate.sourceAttemptId = item.attemptId;
      pendingAssignments = [verifier];
      recordStage('review_recovery', {
        runId: state.runId,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        role: 'verifier',
        target: current.identity,
        status: 'verifier_queued',
        payload: {
          policyId: POLICY_ID,
          checkpointId: entry.checkpointId,
          generation,
          trigger: stalePreflight ? resultStatus : staleReceipt ? 'stale_review_receipt' : 'review_origin_stale',
        },
      });
      return { recovery: nextRecovery, pendingAssignments };
    }
    return { recovery, pendingAssignments: null };
  }

  // Owner grant: one extra recovery generation for a checkpoint stopped at recovery_generation_limit.
  // It starts a fresh recovery plan (verifier first, then the auditor); no earlier receipt is reused.
  function applyOwnerRecoveryGrant(state, request, answer) {
    const decisionId = request.decisionId;
    const limited = validReviewRecovery(state.reviewRecovery)
      ? state.reviewRecovery.checkpoints.filter((entry) => entry.blockedReason === 'recovery_generation_limit') : [];
    if (request.reason !== 'infeasible_requirement' && limited.length === 0) return null;
    const reject = (reason, checkpointId = null) => {
      recordStage('review_recovery', {
        runId: state.runId,
        assignmentId: null,
        attemptId: null,
        role: null,
        status: 'owner_grant_rejected',
        payload: { policyId: POLICY_ID, decisionId, checkpointId, reason },
      });
      return null;
    };
    if (!validReviewRecovery(state.reviewRecovery)) return reject('recovery_state_invalid');
    const eligible = limited.filter((entry) => entry.phase === 'replan_required'
      && entry.generation === MAX_REVIEW_RECOVERY_GENERATIONS && !entry.ownerGrant);
    if (eligible.length === 0) {
      return reject(limited.some((entry) => entry.ownerGrant) ? 'owner_grant_already_used' : 'no_checkpoint_at_limit');
    }
    if (eligible.length > 1) return reject('ambiguous_checkpoint');
    const entry = eligible[0];
    const obligation = (state.reviewObligations || []).find((value) => value.checkpointId === entry.checkpointId);
    if (!obligation || !obligationMatches(obligation, obligation.review)
      || entry.contextHash !== reviewContextHash(obligation.review)) return reject('checkpoint_context_unavailable', entry.checkpointId);
    const limit = roundLimit(state);
    if (state.status || state.budget || (state.unresolvedWriters || []).length > 0
      || (obligation.pendingAssignmentIds || []).length > 0 || unfinishedCheckpointWriter(state.batch, entry.checkpointId)) {
      return reject('checkpoint_writer_pending', entry.checkpointId);
    }
    if (limit !== null && state.round >= limit) return reject('dispatch_round_limit', entry.checkpointId);
    const current = targetForReview({ ...state, reviewObligations: state.reviewObligations }, obligation.review);
    if (!current.known) return reject('current_target_unknown', entry.checkpointId);
    const candidate = {
      ...entry,
      generation: entry.generation + OWNER_RECOVERY_GRANT_GENERATIONS,
      lastRecoveryTarget: current.identity,
      phase: 'verifier_pending',
      blockedReason: null,
      ownerGrant: {
        decisionId,
        choice: OWNER_RECOVERY_GRANT_CHOICE,
        answer: String(answer.answer ?? '').slice(0, MAX_OWNER_GRANT_ANSWER_CHARS),
        grantedAt: new Date().toISOString(),
        generationBefore: entry.generation,
      },
    };
    const nextRecovery = {
      version: REVIEW_RECOVERY_VERSION,
      checkpoints: state.reviewRecovery.checkpoints.map((value) => value.checkpointId === entry.checkpointId ? candidate : value),
    };
    if (!validReviewRecovery(nextRecovery)) return reject('recovery_state_invalid', entry.checkpointId);
    const verifier = recoveryAssignment({ ...state, reviewRecovery: nextRecovery }, candidate, obligation, 'verifier');
    if (!verifier) return reject('validated_verifier_template_unavailable', entry.checkpointId);
    recordStage('review_recovery', {
      runId: state.runId,
      assignmentId: entry.sourceAssignmentId,
      attemptId: entry.sourceAttemptId,
      role: null,
      status: 'owner_grant_applied',
      payload: {
        policyId: POLICY_ID,
        decisionId,
        checkpointId: entry.checkpointId,
        generationBefore: entry.generation,
        generation: candidate.generation,
      },
    });
    recordStage('review_recovery', {
      runId: state.runId,
      assignmentId: entry.sourceAssignmentId,
      attemptId: entry.sourceAttemptId,
      role: 'verifier',
      target: current.identity,
      status: 'verifier_queued',
      payload: { policyId: POLICY_ID, checkpointId: entry.checkpointId, generation: candidate.generation, trigger: 'owner_recovery_grant' },
    });
    return { reviewRecovery: nextRecovery, pendingAssignments: [verifier] };
  }

  // True when the last owner answer started a granted recovery plan that is waiting to be dispatched.
  function ownerGrantDispatchPending(state) {
    const answer = (state.humanAnswers || []).at(-1);
    const marker = state.pendingAssignments?.[0]?._reviewRecovery;
    if (!answer || !marker || !validReviewRecovery(state.reviewRecovery)) return false;
    const entry = state.reviewRecovery.checkpoints.find((value) => value.checkpointId === marker.checkpointId);
    return entry?.ownerGrant?.decisionId === answer.decisionId && entry.phase === 'verifier_pending'
      && marker.generation === entry.generation;
  }

  function targetForReview(state, review) {
    return computeReviewTarget({
      workspace,
      review,
      runId: state.runId,
      goal: state.goalOverride || state.goal,
      checks: state.contract?.requiredChecks || [],
    });
  }

  function activeObligation(state, review) {
    return (state.reviewObligations || []).find((entry) => entry.checkpointId === review?.checkpointId) || null;
  }

  function obligationMatches(obligation, review) {
    return Boolean(obligation && sameReviewScope(obligation.review, review));
  }

  function hasActiveReviewerScope(state, roleId, review) {
    const role = canonicalRoleId(roleId);
    if (!['verifier', 'auditor'].includes(role)
      || !(isGatedReview(review) || review?.kind === 'routine')) return false;
    return obligationMatches(activeObligation(state, review), review);
  }

  function latestReceiptEntry(obligation, role, target) {
    if (!obligation || !target?.known) return null;
    const receipts = obligation.receipts || [];
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const receipt = receipts[index];
      if (receipt.role !== role || receipt.targetIdentity !== target.identity) continue;
      return { receipt, index };
    }
    return null;
  }

  function trustedReceiptOutcome(obligation, receipt, role, state, batch = null) {
    if (!receipt?.assignmentId || !receipt?.attemptId) return false;
    const item = [...(batch?.items || []), ...(state?.batch?.items || [])].findLast((entry) => entry.state === 'finished'
      && entry.assignmentId === receipt.assignmentId
      && entry.attemptId === receipt.attemptId
      && canonicalRoleId(entry.role) === role);
    const outcome = item
      ? (item.reviewSummary || outcomeSummary(item))
      : (state?.outcomes || []).findLast((entry) => !entry.kind
      && entry.assignmentId === receipt.assignmentId
      && entry.attemptId === receipt.attemptId
      && canonicalRoleId(entry.role) === role);
    if (!outcome) return false;
    const evidence = reviewResult(outcome, role, obligation.review);
    return evidence.valid === true && evidence.status === 'accepted'
      && (role !== 'auditor' || evidence.verdict === 'pass');
  }

  function receiptReuseAllowed(obligation, entry, role, state, batch = null) {
    if (!entry || (obligation.pendingAssignmentIds || []).length > 0) return false;
    const guard = obligation.repairReuseGuard;
    if (guard) {
      if (guard.version !== 1 || !Number.isInteger(guard.receiptFloor) || guard.receiptFloor < 0
        || guard.contextHash !== reviewContextHash(obligation.review)
        || guard.phase === 'pending' || !['unchanged', 'fresh_required'].includes(guard.phase)) return false;
      if (entry.index < guard.receiptFloor) return false;
    }
    return trustedReceiptOutcome(obligation, entry.receipt, role, state, batch);
  }

  function sameBatchVerifierItem(obligation, target, state, batch, auditorItem) {
    const recoveryValid = validReviewRecovery(state?.reviewRecovery);
    const recoveryCheckpoint = recoveryValid
      ? state.reviewRecovery.checkpoints.find((entry) => entry.checkpointId === obligation?.checkpointId) : null;
    const contextHash = reviewContextHash(obligation.review);
    const recoveryContextMismatch = Boolean(recoveryCheckpoint && recoveryCheckpoint.contextHash !== contextHash);
    const recovery = recoveryCheckpoint && !recoveryContextMismatch ? recoveryCheckpoint : null;
    const recoveryReplanAllowed = recovery?.phase === 'replan_required'
      && ['fresh_verifier_not_accepted', 'fresh_auditor_not_accepted'].includes(recovery.blockedReason);
    const ordinaryHandoffAllowed = recoveryValid && !recoveryContextMismatch
      && (!recovery || !['verifier_pending', 'auditor_pending', 'replan_required'].includes(recovery.phase));
    if (!target?.known || !recoveryValid || recoveryContextMismatch
      || (!ordinaryHandoffAllowed && !recoveryReplanAllowed)
      || !auditorItem || canonicalRoleId(auditorItem.role) !== 'auditor'
      || !obligationMatches(obligation, auditorItem.assignment?.review)
      || !Number.isInteger(auditorItem.group)) return null;
    for (const item of batch?.items || []) {
      if (item === auditorItem || item.state !== 'finished' || item.reviewSkipped
        || item.reviewRecovery || canonicalRoleId(item.role) !== 'verifier'
        || !obligationMatches(obligation, item.assignment?.review)
        || !Number.isInteger(item.group) || item.group >= auditorItem.group) continue;
      const receipt = latestReceiptEntry(obligation, 'verifier', target)?.receipt;
      if (receipt?.status === 'accepted' && receipt.assignmentId === item.assignmentId
        && receipt.attemptId === item.attemptId) return item;
    }
    return null;
  }

  function sameBatchVerifierReceipt(obligation, target, state, batch, auditorItem) {
    const item = sameBatchVerifierItem(obligation, target, state, batch, auditorItem);
    return item ? latestReceiptEntry(obligation, 'verifier', target)?.receipt || null : null;
  }

  // Keep verifier history, but do not reuse it after a matching same-target audit fails to accept it.
  function rejectedVerifierReceipt(obligation, target) {
    const entry = latestReceiptEntry(obligation, 'verifier', target);
    if (!entry || entry.receipt.status !== 'accepted') return null;
    const receipts = obligation.receipts || [];
    for (let index = receipts.length - 1; index > entry.index; index -= 1) {
      const receipt = receipts[index];
      if (receipt.role !== 'auditor' || receipt.targetIdentity !== target.identity || receipt.status === 'stale') continue;
      if (receipt.continuationPending === true) continue;
      if (receipt.status === 'accepted' && receipt.verdict === 'pass') return null;
      return receipt;
    }
    return null;
  }

  function matchingReceipt(obligation, role, target, state, batch, auditorItem) {
    const recovery = validReviewRecovery(state?.reviewRecovery)
      ? state.reviewRecovery.checkpoints.find((entry) => entry.checkpointId === obligation?.checkpointId
        && entry.contextHash === reviewContextHash(obligation.review)) : null;
    const sameBatchVerifier = role === 'verifier'
      ? sameBatchVerifierReceipt(obligation, target, state, batch, auditorItem) : null;
    if (['verifier_pending', 'replan_required'].includes(recovery?.phase) && !sameBatchVerifier) return null;
    if (role === 'auditor' && recovery?.phase === 'auditor_pending') return null;
    const entry = latestReceiptEntry(obligation, role, target);
    if (!entry || entry.receipt.status !== 'accepted') return null;
    if (role === 'verifier' && rejectedVerifierReceipt(obligation, target)) return null;
    if (!receiptReuseAllowed(obligation, entry, role, state, batch)) return null;
    return entry.receipt;
  }

  function currentGateState(state, obligation) {
    const review = obligation?.review;
    if (!review) return { target: null, verifier: null, auditor: null };
    const target = targetForReview(state, review);
    return {
      target,
      verifier: matchingReceipt(obligation, 'verifier', target, state),
      auditor: matchingReceipt(obligation, 'auditor', target, state),
    };
  }

  function unfinishedCheckpointWriter(batch, checkpointId) {
    return (batch?.items || []).some((candidate) => {
      const tracksCheckpoint = candidate.assignment?.review?.checkpointId === checkpointId
        || candidate.assignment?.repair?.checkpointIds?.includes(checkpointId)
        || candidate.repairCapture?.some((capture) => capture.checkpointId === checkpointId);
      return tracksCheckpoint && (candidate.state !== 'finished' || !isSettledWriter(candidate.result))
        && getRole(roles, candidate.role)?.sandbox !== 'read-only'
        && canonicalRoleId(candidate.role) !== 'verifier';
    });
  }

  // Checkpoints the owner deferred or took outside the run: no reviewer is dispatched for them.
  const ownerBlockedIds = (state) => new Set((state.blockedCheckpoints || []).map((entry) => entry.checkpointId));

  function incompleteCriticalCheckpointIds(state) {
    const deferred = ownerBlockedIds(state);
    return (state.reviewObligations || []).filter((obligation) => {
      if (!isGatedReview(obligation.review) || deferred.has(obligation.checkpointId)) return false;
      const gate = currentGateState(state, obligation);
      return (obligation.pendingAssignmentIds || []).length > 0 || !gate.verifier || !gate.auditor;
    }).map((obligation) => obligation.checkpointId).sort();
  }

  function isPrerequisiteVerifier(state, assignment, assignments) {
    const review = assignment?.review;
    const linked = review?.prerequisiteFor || [];
    if (canonicalRoleId(assignment?.role) !== 'verifier' || !isGatedReview(review)
      || linked.length === 0 || assignment.repair) return false;
    if (assignments.some((entry) => entry !== assignment
      && getRole(roles, entry.role)?.sandbox !== 'read-only')) return false;
    const newLinkedScopes = assignments.filter((entry) => (entry.review?.prerequisiteFor || []).length > 0
      && !activeObligation(state, entry.review));
    if (newLinkedScopes.length < 1 || newLinkedScopes.length > 2
      || (state.reviewObligations || []).some((entry) => entry.checkpointId === review.checkpointId)) return false;
    const linkedAuditors = newLinkedScopes.filter((entry) => entry !== assignment);
    if (linkedAuditors.length > 1 || linkedAuditors.some((entry) => canonicalRoleId(entry.role) !== 'auditor'
      || !sameReviewScope(entry.review, review))) return false;
    const expected = incompleteCriticalCheckpointIds(state);
    const actual = [...linked].sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) return false;
    return targetForReview(state, review).known;
  }

  // A partial finish does not need review receipts for the checkpoints its ledger reports as blocked or not
  // started (including the ones the owner deferred); an accepted checkpoint keeps its gate.
  function ledgerExemption(state, ledger) {
    return new Set([...unreviewedIds(ledger), ...(ledger ? ownerBlockedIds(state) : [])]);
  }

  function gateFailure(state, { forFinish = false, assignments = [], exempt = null } = {}) {
    const deferred = ownerBlockedIds(state);
    const skipped = (checkpointId) => (forFinish ? Boolean(exempt?.has(checkpointId)) : deferred.has(checkpointId));
    const obligations = (state.reviewObligations || []).filter((entry) => isGatedReview(entry.review) && !skipped(entry.checkpointId));
    for (const obligation of obligations) {
      const gate = currentGateState(state, obligation);
      const pending = (obligation.pendingAssignmentIds || []).length > 0;
      const complete = !pending && Boolean(gate.verifier && gate.auditor);
      if (!forFinish && !complete) {
        const unrelatedWriter = assignments.find((assignment) => {
          const isWritable = getRole(roles, assignment.role)?.sandbox !== 'read-only';
          const repairScope = assignment.repair?.checkpointIds || [];
          return isWritable && !hasActiveReviewerScope(state, assignment.role, assignment.review)
            && !isPrerequisiteVerifier(state, assignment, assignments)
            && assignment.review?.checkpointId !== obligation.checkpointId
            && !repairScope.includes(obligation.checkpointId);
        });
        if (unrelatedWriter) {
          return `Critical review checkpoint ${obligation.checkpointId} remains pending; writable assignments must stay under that checkpoint until its audit is accepted`;
        }
      }
      if (!forFinish) continue;
      if (pending) return `Review checkpoint ${obligation.checkpointId} still has an assignment whose effects are not integrated`;
      if (!gate.verifier) return `Review checkpoint ${obligation.checkpointId} needs a passing verifier receipt for the current target`;
      if (!gate.auditor) return `Critical review checkpoint ${obligation.checkpointId} needs a passing auditor receipt for the current target`;
    }
    const ordinary = (state.reviewObligations || []).filter((entry) => entry.review?.kind === 'routine' && !skipped(entry.checkpointId));
    if (forFinish) {
      for (const obligation of ordinary) {
        if ((obligation.pendingAssignmentIds || []).length > 0) {
          return `Review checkpoint ${obligation.checkpointId} still has an assignment whose effects are not integrated`;
        }
        const gate = currentGateState(state, obligation);
        if (!gate.verifier) return `Routine review checkpoint ${obligation.checkpointId} needs a passing verifier receipt for the current target`;
      }
    }
    return null;
  }

  function enforceReviewAcceptance(state, acceptance) {
    const ledger = state.status === 'completed' ? state.partial?.checkpoints : null;
    const failure = gateFailure(state, { forFinish: true, exempt: ledger ? ledgerExemption(state, ledger) : null });
    if (!failure) return acceptance;
    const issue = {
      code: 'review_gate_pending',
      detail: String(failure).slice(0, 500),
      predicate: 'accept.review_gate',
      result: 'UNKNOWN',
      boundary: 'acceptance',
      advisory: false,
      evidence: [],
    };
    return {
      ...acceptance,
      disposition: 'unverifiable',
      reasons: [...(acceptance.reasons || []), issue],
      issues: [...(acceptance.issues || []), issue],
    };
  }

  function reviewObligationsForDispatch(state, assignments, round) {
    const next = [...(state.reviewObligations || [])];
    assignments.forEach((assignment, index) => {
      const review = assignment.review;
      const assignmentId = makeAssignmentId(state.runId, round, index);
      const target = review ? targetForReview(state, review) : null;
      recordStage('assignment_selected', {
        runId: state.runId,
        assignmentId,
        role: canonicalRoleId(assignment.role),
        target: target?.identity || null,
        status: 'selected',
        payload: {
          policyId: POLICY_ID,
          objective: String(assignment.objective || '').slice(0, 500),
          review: review ? {
            kind: review.kind,
            checkpointId: review.checkpointId,
            reason: review.reason,
            paths: review.paths,
            evidenceIds: review.evidenceIds,
            prerequisiteFor: review.prerequisiteFor || [],
            targetKnown: target.known,
            targetReason: target.reason,
          } : null,
          repair: assignment.repair ? {
            checkpointIds: assignment.repair.checkpointIds,
            targets: assignment.repair.checkpointIds.map((checkpointId) => {
              const obligation = (state.reviewObligations || []).find((entry) => entry.checkpointId === checkpointId);
              const captured = obligation?.review ? targetForReview(state, obligation.review) : null;
              return { checkpointId, targetKnown: Boolean(captured?.known), target: captured?.identity || null };
            }),
          } : null,
        },
      });
      if (assignment.repair) {
        for (const checkpointId of assignment.repair.checkpointIds) {
          const position = next.findIndex((entry) => entry.checkpointId === checkpointId);
          if (position < 0) continue;
          const obligation = next[position];
          const pendingAssignmentIds = [...(obligation.pendingAssignmentIds || [])];
          if (!pendingAssignmentIds.includes(assignmentId)) pendingAssignmentIds.push(assignmentId);
          const target = obligation.review ? targetForReview(state, obligation.review) : null;
          const previousGuard = obligation.repairReuseGuard;
          const priorFloor = previousGuard?.version === 1 && Number.isInteger(previousGuard.receiptFloor)
            && previousGuard.receiptFloor >= 0
            ? previousGuard.receiptFloor
            : previousGuard ? (obligation.receipts || []).length : 0;
          const receiptFloor = previousGuard?.phase === 'pending'
            ? Math.max(priorFloor, (obligation.receipts || []).length) : priorFloor;
          next[position] = {
            ...obligation,
            pendingAssignmentIds,
            repairReuseGuard: {
              version: 1,
              phase: 'pending',
              assignmentId,
              contextHash: reviewContextHash(obligation.review),
              targetIdentity: target?.known ? target.identity : null,
              receiptFloor,
            },
          };
        }
        return;
      }
      if (!review || (!isGatedReview(review) && review.kind !== 'routine')) return;
      let position = next.findIndex((entry) => entry.checkpointId === review.checkpointId);
      const prior = position < 0 ? null : next[position];
      const isCodeVerifier = canonicalRoleId(assignment.role) === 'verifier';
      const isAuditor = canonicalRoleId(assignment.role) === 'auditor';
      const pendingAssignmentIds = [...(obligationMatches(prior, review) ? prior.pendingAssignmentIds || [] : [])];
      if (!isCodeVerifier && !isAuditor && getRole(roles, assignment.role)?.sandbox !== 'read-only') {
        if (!pendingAssignmentIds.includes(assignmentId)) pendingAssignmentIds.push(assignmentId);
      }
      const entry = {
        checkpointId: review.checkpointId,
        review,
        targetIdentity: obligationMatches(prior, review) ? prior.targetIdentity || null : null,
        pendingAssignmentIds,
        receipts: obligationMatches(prior, review) ? [...(prior.receipts || [])] : [...(prior?.receipts || [])],
        ...(obligationMatches(prior, review) && prior.repairReuseGuard ? { repairReuseGuard: prior.repairReuseGuard } : {}),
      };
      if (position < 0) next.push(entry);
      else next[position] = entry;
      recordStage('review_selected', {
        runId: state.runId,
        assignmentId,
        role: canonicalRoleId(assignment.role),
        target: target.identity,
        status: review.kind,
        payload: {
          policyId: POLICY_ID,
          checkpointId: review.checkpointId,
          reason: review.reason,
          paths: review.paths,
          evidenceIds: review.evidenceIds,
          targetKnown: target.known,
          targetReason: target.reason,
          phase: 'dispatch_planned',
        },
      });
    });
    return next;
  }

  function logGateReuse(state, obligations) {
    for (const obligation of obligations) {
      const gate = currentGateState(state, obligation);
      for (const [role, receipt] of [['verifier', gate.verifier], ['auditor', gate.auditor]]) {
        if (!receipt) continue;
        recordStage('review_evidence_reused', {
          runId: state.runId,
          assignmentId: receipt.assignmentId,
          attemptId: receipt.attemptId,
          role,
          target: gate.target.identity,
          status: 'reused',
          payload: { policyId: POLICY_ID, checkpointId: obligation.checkpointId, receiptStatus: receipt.status },
        });
      }
    }
  }

  function recordSemanticRecords(state, records) {
    const eventTypes = {
      problem: 'problem_recorded',
      remedy: 'remedy_recorded',
      architecture: 'architecture_decision',
      verification: 'verification_recorded',
      decision: 'decision_recorded',
    };
    for (const entry of records || []) {
      recordStage(eventTypes[entry.kind], {
        runId: state.runId,
        problemId: entry.kind === 'problem' ? entry.id : (entry.relatedIds[0] || null),
        decisionId: entry.kind === 'decision' || entry.kind === 'architecture' ? entry.id : null,
        status: entry.status,
        payload: {
          id: entry.id,
          kind: entry.kind,
          summary: entry.summary,
          evidenceIds: entry.evidenceIds,
          relatedIds: entry.relatedIds,
          adrPath: entry.adrPath,
        },
      });
    }
  }

  function knownProblemIdsForDecision(records) {
    const checked = checkDecisionRecordsShape(records === undefined ? [] : records);
    const ids = new Set(checked.filter((entry) => entry.kind === 'problem').map((entry) => entry.id));
    const relatedIds = new Set(checked.filter((entry) => ['remedy', 'verification'].includes(entry.kind))
      .flatMap((entry) => entry.relatedIds).filter((problemId) => !ids.has(problemId)));
    for (const problemId of relatedIds) {
      const history = stagingLog.list({ problemId, type: 'problem_recorded', limit: 1 });
      if (history.some((event) => event.problemId === problemId || event.payload?.id === problemId)) ids.add(problemId);
    }
    return [...ids];
  }

  function recordLeadResolutions(state, resolutions) {
    for (const entry of resolutions || []) {
      recordStage('worker_decision_resolved', {
        runId: state.runId,
        decisionId: entry.decisionId,
        status: 'resolved',
        payload: { choice: entry.choice, rationale: entry.rationale.slice(0, 1000) },
      });
    }
  }

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

  // LL-8: null means the caller requested unlimited dispatch rounds. Legacy grants remain readable.
  const roundLimit = (state) => Number.isInteger(maxRounds) ? maxRounds + (state.extraRounds || 0) : null;

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

  // Short account of where the rounds went, for the round-limit pause.
  function roundSummary(state) {
    const byRole = new Map();
    for (const outcome of state.outcomes || []) {
      if (outcome.kind || !outcome.role) continue;
      byRole.set(outcome.role, (byRole.get(outcome.role) || 0) + 1);
    }
    const roles = [...byRole].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(', ');
    const changes = (state.progress || []).filter((entry) => entry.kind === 'integrated_change');
    const lastChange = changes.length > 0 ? `the last integrated change was in round ${changes.at(-1).round}` : 'no integrated change is recorded';
    return `Summary: ${byRole.size > 0 ? `dispatches by role (${roles})` : 'no dispatch outcomes'}; ${changes.length} integrated change(s), ${lastChange}.`;
  }

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
    const ids = checks.map((check) => check.id).join(', ');
    const review = {
      kind: 'pinned_check',
      checkpointId: `pinned-check:${sha256(ids).slice(0, 24)}`,
      reason: `Pinned acceptance check scripts changed: ${ids}`,
      paths: [...new Set(checks.flatMap((check) => (check.pins || []).map((pin) => pin.path)))],
      evidenceIds: checks.map((check) => check.id),
    };
    const target = targetForReview(state, review);
    const assignmentId = `${state.runId}:r${state.round}:review${(state.checkReviews || []).length + 1}`;
    const attemptId = makeAttemptId(assignmentId);
    recordStage('review_selected', {
      runId: state.runId,
      assignmentId,
      attemptId,
      role: canonicalRoleId(role.name),
      target: target.identity,
      status: review.kind,
      payload: {
        policyId: POLICY_ID,
        reason: review.reason,
        paths: review.paths,
        evidenceIds: review.evidenceIds,
        targetKnown: target.known,
        targetReason: target.reason,
        phase: 'pinned_check_changed',
      },
    });
    const inputs = [];
    for (const check of checks) {
      inputs.push(`Pinned acceptance check "${check.id}": argv ${JSON.stringify(check.argv)}`);
      for (const change of describePinChanges(check, workspace)) {
        inputs.push(`${change.path}: pinned sha256 ${change.pinnedSha256}, current ${change.currentSha256 || 'deleted'}. ${change.note}`);
        if (change.diff) inputs.push(...chunks(change.diff));
      }
    }
    inputs.push(`Run goal (context): ${(state.goalOverride || state.goal).slice(0, 1500)}`);
    const assignment = {
      role: role.name,
      objective: `Independent read-only review of changed pinned acceptance check(s) ${ids}: the files behind them changed after they were pinned. Find the requirement each check enforces in the project's PRD (or its release or gate documents) and judge whether the change preserves it (for example, measuring from real output instead of hard-coded numbers) or weakens it (for example, lower thresholds, skipped cases, or a hard-coded pass). Do not edit files. Reply with outcome completed and decisionRequest null; the first line of summary must be exactly "VERDICT: preserve" or "VERDICT: weaken", followed by the PRD requirement and your evidence. Add a line "PRD_CHANGE_REQUIRED: <reason>" only if the PRD requirement itself must change.`,
      allowedFiles: [],
      inputs: inputs.slice(0, 20),
      evidence: [`Acceptance issue check_changed for ${ids} (pinned sha256 differs from the current content).`],
      acceptanceCriteria: ['The first summary line is VERDICT: preserve or VERDICT: weaken', 'The verdict names the PRD requirement and cites the changed lines'],
      checks: ['Compare the change with the PRD requirement the check enforces'],
      stopConditions: ['Do not edit any file', 'Stop after giving the verdict'],
      review,
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
      reviewTarget: { known: target.known, identity: target.identity, reason: target.reason },
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
        assignmentId, round: state.round, final: state.text, review, reviewTarget: { known: target.known, identity: target.identity, reason: target.reason },
        checks: checks.map((check) => ({ id: check.id, pins: currentPins(check, workspace) })),
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
        role: item.role, failed: !completed,
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
      analysis = analyzeWorker(parsed, {
        fullText: result.text || '', allowedFiles, workspace, textRef: null, store: workerStore(item),
        lanePath: lanePathOf(result.writerExecution), role: item.role, failed: !completed || Boolean(result.failureKind),
      });
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
      ...(typeof item.assignment?.review?.checkpointId === 'string' && item.assignment.review.checkpointId ? { checkpointId: item.assignment.review.checkpointId } : {}),
      skills: (item.assignment?.skillPins || []).map(({ id, sha256: hash }) => ({ id, sha256: hash })),
      sandbox: item.sandbox,
      taskId: result.taskId || item.taskId || null,
      status: result.status,
      report: analysis.report,
      ...(analysis.loopEvidenceIdentity ? { loopEvidenceIdentity: analysis.loopEvidenceIdentity } : {}),
      reportError: analysis.reportError,
      ...(Array.isArray(analysis.report?.normalizations) && analysis.report.normalizations.length > 0
        ? { normalizations: analysis.report.normalizations.map((entry) => `${entry.field}: ${entry.action}`) } : {}),
      ...(analysis.report ? {} : { text: analysis.text ?? '' }),
      failureKind: result.failureKind || null,
      ...(result.continuation ? { continuation: result.continuation } : {}),
      ...(result.serviceBoundary ? { serviceBoundary: result.serviceBoundary } : {}),
      ...(result.reviewCoverage ? { reviewCoverage: result.reviewCoverage } : {}),
      ...(result.reviewResult ? { reviewResult: result.reviewResult } : {}),
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

  function logicalAssignmentId(id) {
    return String(id || '').replace(/:c\d+$/, '');
  }

  function stageWorkerOutcome(item, summary) {
    const report = summary.report;
    const failures = (summary.boundary?.results || []).filter((entry) => entry.result !== 'PASS');
    recordStage('worker_result', {
      runId: item.runId,
      assignmentId: item.assignmentId,
      attemptId: item.attemptId,
      role: canonicalRoleId(item.role),
      decisionId: report?.decisionRequest ? item.attemptId : null,
      target: item.reviewTarget?.identity || null,
      status: summary.status || 'unknown',
      payload: {
        checkpointId: item.assignment?.review?.checkpointId || null,
        outcome: report?.outcome || null,
        failureKind: summary.failureKind || null,
        summary: String(report?.summary || '').slice(0, 500),
        filesChanged: (report?.filesChanged || []).slice(0, 30),
        filesInspected: (report?.filesInspected || []).slice(0, 30),
        checks: (report?.checks || []).map((check) => ({
          commandSha256: sha256(String(check.command || '')),
          result: check.result,
          detail: String(check.detail || '').slice(0, 300),
        })),
        boundaryFailures: failures.map((entry) => ({ code: entry.code, result: entry.result, detail: entry.detail })).slice(0, 20),
        evidenceIds: (summary.evidence || []).map((entry) => entry.id).filter(Boolean).slice(0, 30),
        ...(summary.reviewCoverage ? { reviewCoverage: summary.reviewCoverage } : {}),
      },
    });
    for (const [index, finding] of (report?.risks || []).entries()) {
      recordStage('worker_finding', {
        runId: item.runId,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        role: canonicalRoleId(item.role),
        target: item.reviewTarget?.identity || null,
        status: 'reported',
        payload: { checkpointId: item.assignment?.review?.checkpointId || null, findingIndex: index, summary: String(finding).slice(0, 500) },
      });
    }
    for (const [index, check] of (report?.checks || []).entries()) {
      if (check.result === 'passed') continue;
      recordStage('worker_check_failed', {
        runId: item.runId,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        role: canonicalRoleId(item.role),
        target: item.reviewTarget?.identity || null,
        status: check.result,
        payload: { checkpointId: item.assignment?.review?.checkpointId || null, checkIndex: index, commandSha256: sha256(String(check.command || '')), detail: String(check.detail || '').slice(0, 500) },
      });
    }
    if (report?.decisionRequest) {
      recordStage('worker_decision_opened', {
        runId: item.runId,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        role: canonicalRoleId(item.role),
        decisionId: item.attemptId,
        status: 'open',
        payload: { question: String(report.decisionRequest.question || '').slice(0, 500), options: report.decisionRequest.options.map(({ id }) => id) },
      });
    }
  }

  function integrateFinishedGroup(state, batch) {
    const obligations = [...(state.reviewObligations || [])];
    const items = batch.items.map((original) => {
      if (original.state !== 'finished' || original.stagingProcessed) return original;
      const summary = original.reviewSummary || outcomeSummary(original);
      stageWorkerOutcome(original, summary);
      if (original.repairCapture) {
        for (const captured of original.repairCapture) {
          const position = obligations.findIndex((entry) => entry.checkpointId === captured.checkpointId);
          if (position < 0) continue;
          const obligation = obligations[position];
          const guard = obligation.repairReuseGuard;
          const guardMatches = guard?.version === 1 && guard.phase === 'pending'
            && logicalAssignmentId(guard.assignmentId) === logicalAssignmentId(original.assignmentId);
          const target = obligation.review ? targetForReview({ ...state, reviewObligations: obligations }, obligation.review) : null;
          const execution = summary.writerExecution;
          const delta = execution?.delta;
          const changedPaths = Array.isArray(delta?.changedPaths) ? delta.changedPaths : null;
          const changedPathCount = delta?.changedPathCount ?? changedPaths?.length;
          const deltaComplete = delta?.known === true && summary.attestedDeltaKnown === true
            && changedPaths !== null && Number.isInteger(changedPathCount) && changedPathCount >= 0
            && changedPathCount === changedPaths.length;
          const noScopeViolations = (summary.scopeViolations || []).length === 0
            && (summary.attestedScopeViolations || []).length === 0
            && (summary.scopeViolationCount ?? 0) === 0
            && (summary.attestedScopeViolationCount ?? 0) === 0;
          const unchangedContext = Boolean(captured.review && obligation.review
            && reviewContextHash(captured.review) === guard?.contextHash
            && reviewContextHash(obligation.review) === guard?.contextHash
            && sameReviewScope(captured.review, obligation.review));
          const unchangedTarget = Boolean(captured.targetKnown && captured.targetIdentity
            && captured.targetIdentity === guard?.targetIdentity
            && target?.known && target.identity === captured.targetIdentity);
          const settledIntegratedEffects = Boolean(execution?.executionId
            && ['released', 'reconciled'].includes(execution.state)
            && !isUnintegratedLane(execution));
          const attestedEmptyLane = Boolean(execution?.state === null && !execution.executionId
            && execution.lane?.state === 'not_integrated'
            && execution.lane.reason === 'no_changes'
            && delta?.source === 'lane_collection'
            && delta?.headChanged === false
            && deltaComplete && changedPaths.length === 0 && delta.changedPathCount === 0);
          const settledAttestedEffects = Boolean((settledIntegratedEffects || attestedEmptyLane)
            && deltaComplete && noScopeViolations);
          const repairEvidenceUnchanged = unchangedContext && unchangedTarget && settledAttestedEffects;
          const unchanged = guardMatches && repairEvidenceUnchanged;
          const priorFloor = guard?.version === 1 && Number.isInteger(guard.receiptFloor) && guard.receiptFloor >= 0
            ? guard.receiptFloor : (obligation.receipts || []).length;
          const receiptFloor = repairEvidenceUnchanged ? priorFloor : Math.max(priorFloor, (obligation.receipts || []).length);
          obligations[position] = {
            ...obligation,
            pendingAssignmentIds: (obligation.pendingAssignmentIds || [])
              .filter((id) => logicalAssignmentId(id) !== logicalAssignmentId(original.assignmentId)),
            ...(guardMatches ? {
              repairReuseGuard: {
                version: 1,
                phase: unchanged ? 'unchanged' : 'fresh_required',
                assignmentId: original.assignmentId,
                contextHash: guard.contextHash,
                targetIdentity: captured.targetIdentity || null,
                receiptFloor,
              },
            } : guard?.version === 1 && guard.phase === 'pending' ? {
              repairReuseGuard: { ...guard, receiptFloor },
            } : {}),
          };
        }
      }
      const review = original.assignment?.review;
      if (review && (isGatedReview(review) || review.kind === 'routine')) {
        const position = obligations.findIndex((entry) => entry.checkpointId === review.checkpointId);
        if (position >= 0 && sameReviewScope(obligations[position].review, review)) {
          const obligation = obligations[position];
          const role = canonicalRoleId(original.role);
          const target = targetForReview(state, review);
          const pendingAssignmentIds = (obligation.pendingAssignmentIds || []).filter((id) => logicalAssignmentId(id) !== logicalAssignmentId(original.assignmentId));
          let receipts = [...(obligation.receipts || [])];
          if (['verifier', 'auditor'].includes(role) && !original.reviewSkipped && !original.reviewReused) {
            const captured = original.reviewTarget || null;
            const evidence = reviewResult({
              status: summary.status,
              report: summary.report,
              boundary: summary.boundary,
              sandbox: summary.sandbox,
              writerExecution: summary.writerExecution,
              reviewCoverage: summary.reviewCoverage,
              scopeViolations: summary.scopeViolations,
              attestedScopeViolations: summary.attestedScopeViolations,
            }, role, review);
            const delta = summary.writerExecution?.delta;
            const changedPaths = Array.isArray(delta?.changedPaths) ? delta.changedPaths : [];
            const verifierTestWrite = role === 'verifier'
              && summary.sandbox !== 'read-only'
              && delta?.known === true
              && changedPaths.length > 0
              && (original.assignment?.allowedFiles || []).length > 0
              && original.assignment.allowedFiles.every((file) => isTestCheckPath(file, workspace))
              && changedPaths.every((file) => isTestCheckPath(file, workspace))
              && (delta.changedPathCount ?? changedPaths.length) === changedPaths.length
              && ['released', 'reconciled'].includes(summary.writerExecution?.state)
              && !isUnintegratedLane(summary.writerExecution)
              && summary.attestedDeltaKnown === true
              && (summary.scopeViolations || []).length === 0
              && (summary.attestedScopeViolations || []).length === 0
              && outsideAllowed(changedPaths, original.assignment?.allowedFiles || [], workspace).length === 0;
            const coverageUnknown = !summary.reviewCoverage || (
              summary.reviewCoverage.targetKnown !== true
              || summary.reviewCoverage.identityPresent !== true
              || ['unknown', 'unstable', 'inconclusive'].includes(summary.reviewCoverage.status)
              || (summary.reviewCoverage.stable !== true && (role === 'auditor' || !verifierTestWrite))
            );
            const serviceReview = summary.reviewResult || null;
            const serviceReviewRejected = !serviceReview || (
              serviceReview.policyId !== POLICY_ID
              || serviceReview.kind !== review.kind
              || serviceReview.checkpointId !== review.checkpointId
              || serviceReview.status !== 'accepted'
              || serviceReview.accepted !== true
              || serviceReview.valid !== true
              || (role === 'auditor' && serviceReview.verdict !== 'pass')
            );
            let status = 'failed';
            let reason = evidence.reason;
            if (coverageUnknown) {
              status = 'inconclusive';
              reason = summary.reviewCoverage?.reason || 'role_service_review_coverage_unknown';
            } else if (serviceReviewRejected) {
              status = serviceReview?.status === 'stale' ? 'stale' : 'failed';
              reason = serviceReview?.reason || 'role_service_review_rejected';
            } else if (!captured?.known || !target.known) {
              status = 'inconclusive';
              reason = captured?.reason || target.reason || 'review_target_unknown';
            } else if (captured.identity !== target.identity && !verifierTestWrite) {
              status = 'stale';
              reason = 'review_target_changed_during_review';
            } else if (evidence.valid) {
              status = 'accepted';
              reason = null;
            }
            const receipt = {
              assignmentId: original.assignmentId,
              attemptId: original.attemptId,
              role,
              status,
              targetIdentity: target.known ? target.identity : null,
              verdict: evidence.verdict,
              reason,
              ...(role === 'auditor' && summary.failureKind === 'usage_limit' && summary.continuation
                ? { continuationPending: true } : {}),
            };
            receipts.push(receipt);
            recordStage('review_result', {
              runId: original.runId,
              assignmentId: original.assignmentId,
              attemptId: original.attemptId,
              role,
              target: receipt.targetIdentity,
              status,
              payload: {
                policyId: POLICY_ID,
                checkpointId: review.checkpointId,
                targetKnown: Boolean(captured?.known && target.known),
                currentTargetMatches: Boolean(captured?.known && target.known && captured.identity === target.identity),
                verifierTestWrite: Boolean(verifierTestWrite),
                serviceReviewStatus: serviceReview?.status || null,
                serviceReviewAccepted: serviceReview?.accepted ?? null,
                verdict: evidence.verdict,
                reason,
                reportOutcome: summary.report?.outcome || null,
              },
            });
          }
          obligations[position] = {
            ...obligation,
            targetIdentity: target.known ? target.identity : null,
            pendingAssignmentIds,
            receipts,
          };
        }
      }
      return {
        ...original,
        stagingProcessed: true,
        reviewSummary: summary,
      };
    });
    return { batch: { ...batch, items }, reviewObligations: obligations };
  }

  const roundsLine = (state) => {
    if (roundLimit(state) === null) return `Dispatch rounds already used: ${state.round}. Dispatch rounds are unlimited; the count is for ordering only.`;
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

  function reviewObligationProjection(state) {
    const recoveryValid = validReviewRecovery(state.reviewRecovery);
    const unresolved = (state.unresolvedWriters || []).length > 0;
    const entries = (state.reviewObligations || []).map((obligation) => {
      const gate = currentGateState(state, obligation);
      const verifierRejection = rejectedVerifierReceipt(obligation, gate.target);
      const review = {
        kind: obligation.review.kind,
        checkpointId: obligation.review.checkpointId,
        reason: obligation.review.reason,
        paths: obligation.review.paths,
        evidenceIds: obligation.review.evidenceIds,
        prerequisiteFor: obligation.review.prerequisiteFor || [],
      };
      const recoveryEntry = recoveryValid
        ? state.reviewRecovery.checkpoints.find((value) => value.checkpointId === obligation.checkpointId) : null;
      const reviewEntry = {
        checkpointId: obligation.checkpointId,
        review,
        recovery: recoveryValid
          ? (recoveryEntry ? { generation: recoveryEntry.generation, phase: recoveryEntry.phase, blockedReason: recoveryEntry.blockedReason || null } : null)
          : { stateValid: false, phase: 'replan_required', blockedReason: 'recovery_state_invalid' },
        targetKnown: gate.target?.known === true,
        pendingAssignments: obligation.pendingAssignmentIds || [],
        verifier: gate.verifier?.assignmentId || null,
        verifierRefreshRequired: Boolean(verifierRejection),
        verifierRejectedBy: verifierRejection?.assignmentId || null,
        auditor: gate.auditor?.assignmentId || null,
      };
      const targetKnown = gate.target?.known === true;
      const pendingIds = obligation.pendingAssignmentIds || [];
      const batchWriterPending = unfinishedCheckpointWriter(state.batch, obligation.checkpointId);
      const pendingWriter = pendingIds.length > 0 || batchWriterPending;
      let nextStep;
      let reason;
      if (!recoveryValid || recoveryEntry?.phase === 'replan_required') {
        nextStep = 'recovery_blocked';
        reason = recoveryEntry?.blockedReason || 'recovery_state_invalid';
      } else if (unresolved) {
        nextStep = 'reconcile_unknown';
        reason = 'writer_effects_unresolved';
      } else if (pendingWriter) {
        nextStep = 'wait_writer';
        reason = 'checkpoint_writer_pending';
      } else if (!targetKnown) {
        nextStep = 'reconcile_unknown';
        reason = gate.target?.reason || 'target_identity_unknown';
      } else if (!gate.verifier) {
        nextStep = 'obtain_verifier';
        reason = verifierRejection ? 'verifier_refresh_required' : 'current_verifier_missing';
      } else if (isGatedReview(obligation.review) && !gate.auditor) {
        nextStep = 'obtain_auditor';
        reason = 'current_auditor_missing';
      } else {
        nextStep = 'checkpoint_complete';
        reason = null;
      }
      return {
        reviewEntry,
        nextStep: {
          checkpointId: String(obligation.checkpointId || '').slice(0, 160),
          nextStep,
          ...(reason ? { reason: String(reason).slice(0, 128) } : {}),
          targetKnown,
          pendingWriterCount: Math.max(pendingIds.length, batchWriterPending ? 1 : 0),
        },
      };
    });
    return {
      reviewEntries: entries.map((entry) => entry.reviewEntry),
      nextSteps: entries.slice(0, MAX_REVIEW_RECOVERY_CHECKPOINTS).map((entry) => entry.nextStep),
    };
  }

  function reviewObligationsSection(projection) {
    return `Checkpoint review obligations (a receipt counts only for current content, pins, policy, and run context; legacy outcomes without metadata are not receipts). If verifierRefreshRequired is true, a later matching auditor did not accept the verifier evidence on the unchanged target; dispatch a fresh verifier with the exact stored review context before another auditor. If recovery.phase is replan_required, honor recovery.blockedReason and do not repeat a stale continuation; use a normal explicit replan or stop when evidence is unavailable. Reuse each review object exactly as stored, including every array; do not reconstruct or alter its fields. Do not alter the checkpoint scope:\n${JSON.stringify(projection.reviewEntries)}`;
  }

  function nextStepSection(projection) {
    return `Deterministic checkpoint next steps (bounded scheduling advice only; this does not establish product or task completion):\n${JSON.stringify(projection.nextSteps)}`;
  }

  // Optional notes shared by the full and the delta prompt (acceptance, goal investigation, human answers, rejection).
  function stateNotes(state) {
    const sections = [];
    if (state.acceptance?.disposition === 'rejected' && state.acceptanceAttempts > 0 && !state.status) {
      const issues = (state.acceptance.issues || []).map((issue) => `${issue.code}: ${issue.detail}`);
      sections.push(`Acceptance note: the deterministic acceptance run for your finish decision was rejected (disposition ${state.acceptance.disposition}). You may dispatch fixes within the round limits, then finish again; a second rejection ends the run as rejected. Your final text never changes the disposition.\nIssues:\n${issues.map((line) => `- ${line}`).join('\n')}`);
    }
    if (state.goalInvestigation) {
      sections.push(`Goal investigation (requested in round ${state.goalInvestigation.round}): your finish with goalAchieved false named these blockers:\n${state.goalInvestigation.final}\nInvestigate the root cause of each one (explorer or auditor with the concrete question) or fix it. Dispatch rounds remain ${Number.isInteger(maxRounds) ? 'bounded by the configured caller limit' : 'unlimited'}; do not request extra rounds. A later finish with goalAchieved false pauses for the owner only when final cites the assignmentId of a read-only investigation finished after round ${state.goalInvestigation.round} and states why each remaining blocker is owner-only, with evidence.`);
    }
    if (state.humanAnswers.length > 0) sections.push('Human answers (authoritative):\n' + JSON.stringify(state.humanAnswers));
    if (state.retryDecide && state.rejections?.length > 0) {
      const violations = state.rejections.at(-1).violations || [];
      const reminders = [...new Set(violations.map((entry) => RULE_REMINDERS[entry.predicate]).filter(Boolean))];
      sections.push(['Rejected decision: your previous decision failed validation and nothing was executed. Return a corrected decision.',
        ...violations.map((entry) => `- ${entry.predicate} ${entry.code}: ${entry.detail}`),
        ...reminders].join('\n'));
    }
    const loopNote = warningText(state.loopGuard);
    if (loopNote) sections.push(loopNote);
    return sections;
  }

  const outcomesForPrompt = (outcomes) => boundedOutcomes(outcomes.map(({ objective: _objective, continuation: _continuation, loopEvidenceIdentity: _identity, ...outcome }) => outcome));

  // SES-01: the lead thread already holds the rules and roles; send only what is new since its last turn.
  function deltaPrompt(state, extras) {
    const sections = [DELTA_REMINDER];
    const reviewProjection = reviewObligationProjection(state);
    if (extras.goalChanged) {
      if (state.goalOverride) sections.push(`The owner changed the goal during this run (authoritative; it replaces the earlier goal):\n${state.goalOverride}`);
      else if (state.newRequest) sections.push(`New message from the owner (authoritative; the earlier conversation in this thread is background):\n${state.newRequest}`);
      else sections.push(`New goal from the owner (authoritative):\n${state.goal}`);
    }
    sections.push(roundsLine(state), checksLine(state));
    sections.push(reviewObligationsSection(reviewProjection));
    sections.push(nextStepSection(reviewProjection));
    if (extras.notes.length > 0) sections.push('Notes:\n' + extras.notes.map((note) => `- ${note}`).join('\n'));
    if (extras.goalChanged) {
      sections.push(`Available skill candidates (choose 0-5 relevant IDs for each assignment; no skill is required for unrelated work):\n${JSON.stringify(extras.skillCandidates)}`);
      sections.push(`Available MCP tool candidates (choose the minimum useful IDs; use [] when no MCP tool is needed; maximum 5 per assignment):\n${JSON.stringify(extras.mcpToolCandidates)}`);
    }
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
    const reviewProjection = reviewObligationProjection(state);
    const goal = state.goalOverride
      ? [`Goal (changed by the owner during this run; authoritative, it replaces the original goal):\n${state.goalOverride}`, `Original goal (background only):\n${state.goal}`]
      : [`User goal:\n${state.goal}`];
    const sections = [
      'Plan and coordinate the requested work as the read-only team lead. Return only JSON matching the supplied schema.',
      'The lead must not edit files. Delegate all changes through the A2A role agents.',
      ...goal,
      roundsLine(state),
      checksLine(state),
      reviewObligationsSection(reviewProjection),
      nextStepSection(reviewProjection),
      'Available roles:\n' + JSON.stringify([...roles.values()].map(({ name, displayName, description, sandbox, model, effort }) => ({ id: canonicalRoleId(name), name: displayName || roleDisplayName(name), description, sandbox, model, effort }))),
      `Available skill candidates (choose 0-5 relevant IDs for each assignment; no skill is required for unrelated work):\n${JSON.stringify(extras.skillCandidates)}`,
      `Available skill IDs and names (trusted selectable IDs):\n${JSON.stringify(extras.skillNames)}`,
      'The candidate descriptions are lexical hints. You may select any listed skill ID based on semantic relevance to the task, even when it was not in the candidate shortlist.',
      `Available MCP tool IDs and names (trusted selectable IDs):\n${JSON.stringify(extras.mcpToolNames)}`,
      `Available MCP tool candidates (select the minimum useful IDs; use [] when no MCP tool is needed; maximum 5 per assignment):\n${JSON.stringify(extras.mcpToolCandidates)}`,
      'MCP selection rule: use no tools by default; select only the smallest set that materially helps this assignment. drupal-static reads local project files. Other Drupal servers query live Drupal or a database and can return sensitive operational, configuration, permission, render, log, or state data. Select live tools only when the task specifically needs that live state. drupal-db-ops includes the target project settings.php to obtain DB credentials. These tools are read-oriented, but their results remain sensitive.',
      'MCP candidate descriptions are lexical hints. You may select any trusted listed MCP tool ID based on semantic relevance, even when it was not in the candidate shortlist.',
    ];
    if (extras.sessionDigest) sections.splice(1 + goal.length + 1, 0, `Session so far (this lead thread is new; the earlier conversation of this session is summarized here, background only):\n${extras.sessionDigest}`);
    if (extras.notes.length > 0) sections.push('Notes:\n' + extras.notes.map((note) => `- ${note}`).join('\n'));
    sections.push(openDecisionsSection(state));
    sections.push(...stateNotes(state));
    // The objective is kept for the run digest only; the bounded prompt stays as before.
    sections.push('Prior worker outcomes (including failures):\n' + JSON.stringify(outcomesForPrompt(state.outcomes)));
    sections.push([
      'Every assignment must include role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, stopConditions, skills, wave, continueFrom, review, and repair. Set repair:null for ordinary work. Use review:null for unrelated read-only work and non-material administrative or document-only changes. For material implementation set review to {kind,checkpointId,reason,paths,evidenceIds,prerequisiteFor}; use prerequisiteFor:[] by default. Use routine for ordinary material changes, risk_change for trust-boundary/security/authority/recovery/concurrency/migration/public-contract changes, performance for performance requirements, component_complete for an integrated independently usable component, investigation for diagnostic audit only, and owner_request for an explicit owner audit. Do not classify risk by filenames. Routine material changes need a verifier after integration; they do not trigger an auditor. Critical changes need a passing verifier first and then a bounded auditor before dependent writes or finish. Verifier and auditor must use the same kind, checkpointId, reason, paths, evidenceIds, and prerequisiteFor. A checkpoint review context is immutable: do not downgrade its kind or narrow its paths during repair or review; create a new checkpoint for a new scope. If other critical checkpoints are pending, one new gated verifier may include prerequisiteFor:[...] naming the exact complete set of currently incomplete critical checkpoint IDs (up to 20 unique IDs, each at most 160 characters); its matching auditor repeats the same list. This admits only that verifier scope: do not combine it with unrelated writers, do not dispatch multiple linked scopes, and wait to finish until every original and new checkpoint has its own current-target verifier and auditor receipt. If critical checkpoint gates block an authorized repair, one writable engineer, recovery-engineer, or senior-engineer may be dispatched alone with review:null and repair:{checkpointIds:[...]} naming the exact complete set of currently incomplete critical checkpoint IDs (up to 20 unique IDs, each at most 160 characters). Keep allowedFiles bounded. This repair scope only permits work on those checkpoint obligations; it does not permit unrelated writers, and it preserves each stored review context. Repair admission preserves prior receipt history and blocks its use while any listed checkpoint writer is pending or effects remain unsettled. After a repair, prior receipts are reusable only when the controller attests a known unchanged target, immutable review context, complete trusted effects with no scope violations, and unchanged captured target identity; otherwise obtain fresh current-target verifier and auditor evidence for every listed checkpoint before finish. Unknown targets block the write. The verifier and auditor may run in successive execution groups of one decision after verifier evidence is evaluated. An investigation never satisfies acceptance.',
      'Every assignment also needs mcpTools. Use [] by default and choose the minimum useful MCP tool IDs only when the task needs them. Never exceed five unique IDs. MCP server access is resolved from the role profile and narrowed to those exact tool names for this assignment.',
      `${ASSIGNMENT_SCOPE_RULE} ${PATH_RULE}`,
      'Record durable semantic lessons in records (max 20): {id,kind,status,summary,evidenceIds,relatedIds,adrPath}. Use stable IDs for problems/decisions, relate remedies and verification records to problem IDs, and keep proposed, accepted, implemented, and tested states distinct. Architecture records require a safe workspace-relative Markdown ADR path; all other records use adrPath:null. Use records:[] when there is nothing material to record. Do not claim a fix or verification that the evidence does not establish.',
      'Briefing rules: in each assignment inputs and evidence, give exact file paths with line ranges and the facts already established, so workers do not re-explore; reuse explorer findings by quoting the relevant paths and ranges. Do not read large files yourself: read at most a few narrow ranges and dispatch an explorer for broad reading.',
      deps.parallelWriters
        ? 'Waves: assignment.wave is an integer >= 1 or null. Consecutive assignments sharing the same wave run concurrently. Writers in one wave each work in an isolated copy of the workspace made from the same starting state and do not see each other\'s changes; their changes are integrated into the shared workspace as each finishes. A later wave (or a null-wave assignment after them), for example a verifier, sees the integrated result. Writers in one wave must own disjoint allowedFiles. Use null for strictly sequential steps.'
        : 'Waves: assignment.wave may be used to group read-only work that runs concurrently. Writers always run one at a time in array order regardless of wave. Use null otherwise.',
      'The JSON must contain action (dispatch, finish, or request_human_input), assignments, final, resolutions, humanInput, goalAchieved, acceptanceChecks, records, and checkpoints. Use empty arrays, an empty string, or null for unused fields.',
      'Repair and debugging assignments should use directory prefixes that cover the module and its tests, not single files. When a worker reports scopeExpansion or asks for a scope decision, prefer re-dispatching with continueFrom set to that outcome\'s assignmentId (same role) and the expanded allowedFiles over a fresh assignment: the worker continues its own thread instead of re-discovering its context.',
      'Worker decision requests are open decisions: resolve each one yourself (resolutions: decisionId, choice, rationale), investigating first when the evidence does not settle it; list one in humanInput.relatedDecisionIds only when it is an owner-only decision. Never leave one unanswered. Worker reports are self-reported; check scopeViolations and reportError.',
      `Investigate first: never ask the owner what investigation can answer; the owner has no one to ask either. ${OWNER_ONLY_RULE}`,
      `request_human_input is accepted only for an owner-only decision and only after an investigation of that blocker: ${INVESTIGATION_RULE} Give options, a recommendation, the evidence checked, and the independent work that can proceed.`,
      'A blocker that persists needs its root cause located (an explorer first; use an auditor only for a concrete risk-boundary question, or scout/architect when appropriate). Once an investigation locates it outside what the team may change (a missing capability of a dependency or the environment, or the requirement itself), stop investigating that blocker and escalate it.',
      `goalAchieved: on finish set it honestly, true only when the goal is met; false names the blockers in final. The first finish with false does not end the run: investigate the root cause of each blocker or fix it${Number.isInteger(maxRounds) ? ' within the caller-granted round allowance' : ' while dispatch rounds remain unlimited'}. A later finish with false pauses for the owner only when final cites a read-only investigation finished since then and states why each remaining blocker is owner-only, with evidence. Use null for dispatch and request_human_input. A finish with false may instead carry checkpoints, a ledger of {id, status, reason, evidence} (status accepted with evidence, blocked, or not_started, with a reason); it ends the run as a partial result without an owner pause. Use checkpoints null otherwise.`,
      ...(Number.isInteger(maxRounds) ? [`Dispatch rounds are capped at ${maxRounds} per caller-granted allowance. Reaching the cap pauses for the owner; only owner continue or change_goal grants another allowance.`] : ['Dispatch rounds are unlimited by default. A round number is for ordering only, not a spending authorization.']),
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
    const expectedSkillContext = expectedLeadSkillContext(state.runId, trialRunIds, aut03LeadSkillEnabled, skillPin);
    if (state.leadSkillContext && !sameLeadSkillContext(state.leadSkillContext, expectedSkillContext)) {
      throw new Error('AUT-03 lead skill run context changed; start a new run ID');
    }
    const current = readPinned({ roles, leadRole, workspace, skillCatalog, mcpCatalog });
    if (!state.pinned) return { pinned: current, leadSkillContext: expectedSkillContext };
    runtime.pendingNotes = [...(runtime.pendingNotes || []), ...instructionChanges(state.pinned, current)];
    return { pinned: current, leadSkillContext: expectedSkillContext };
  }

  // A canceled run ends at finish. STOP-01: when the abort was a shutdown stop (the signal reason says so)
  // the update also asks finish to park the run as resumable instead of ending it.
  const canceledUpdate = (signal, extra = {}) => ({
    ...extra,
    status: 'canceled',
    text: CANCELED_TEXT,
    parkOnStop: signal?.reason?.ownerStop === true,
  });

  // PAUSE-01: the owner asked for a soft stop. It is honored only at the boundaries that call this,
  // where no worker turn of this run is running and nothing has been mutated yet by the node.
  const ownerPauseRequested = (config) => {
    const runtime = runtimeOf(config);
    return runtime.pauseRequested === true && !runtime.signal?.aborted;
  };

  async function decide(state, config) {
    const runtime = runtimeOf(config);
    const { signal } = runtime;
    if (signal?.aborted) return canceledUpdate(signal);
    // Before notes are consumed or a dispatch is planned: everything before interrupt() re-runs on resume.
    if (ownerPauseRequested(config)) interrupt({ kind: 'owner_pause', message: OWNER_PAUSE_MESSAGE });

    const expectedSkillContext = expectedLeadSkillContext(state.runId, trialRunIds, aut03LeadSkillEnabled, skillPin);
    let leadSkillContext = state.leadSkillContext;
    if (!leadSkillContext) {
      if (runtime.resumed && expectedSkillContext.enabled) {
        throw new Error('AUT-03 lead skill run context is missing; start a new run ID');
      }
      leadSkillContext = expectedSkillContext;
    } else if (!sameLeadSkillContext(leadSkillContext, expectedSkillContext)) {
      throw new Error('AUT-03 lead skill run context changed; start a new run ID');
    }
    const selectedLeadSkills = resolveLeadSelectedSkills(leadSkillContext, skillCatalog);

    const notes = [...(runtime.pendingNotes || [])];
    runtime.pendingNotes = [];
    const update = { redecide: false };
    if (runtime.resumed) {
      runtime.resumed = false;
      notes.push('This run was resumed after an interruption (restart, pause, or usage limit). A previous lead turn may have been repeated. Outcomes marked interrupted or outcome_unknown have unknown workspace effects.');
      const current = readPinned({ roles, leadRole, workspace, skillCatalog, mcpCatalog });
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
    const skillCandidates = findSkillCandidates(skillCatalog, [state.goal, ...priorSkillContext.map((item) => item.summary)].join('\n'), { limit: 12, audience: 'worker' });
    const skillNames = [...skillCatalog.values()].filter((item) => (item.audience || 'worker') === 'worker').map(({ id, name }) => ({ id, name }));
    const candidateIds = skillNames.map(({ id }) => id);
    const mcpAllowedServers = [...new Set([...roles.values()].flatMap((role) => role.tools?.mcpServers || []))].sort();
    const mcpToolNames = [...mcpCatalog.values()].filter((item) => mcpAllowedServers.includes(item.configName))
      .map(({ id, name, configName, dataSensitivity }) => ({ id, name, server: configName, dataSensitivity }));
    const mcpToolCandidateIds = mcpToolNames.map(({ id }) => id);
    const mcpToolCandidates = findMcpToolCandidates(mcpCatalog,
      [state.goal, ...priorSkillContext.map((item) => item.summary)].join('\n'),
      { limit: 12, allowedServers: mcpAllowedServers });
    // SES-01: one lead thread per session. An in-run rejection retry keeps its current thread;
    // resumed runs re-check the persisted profile hash before reusing a session thread.
    const contextId = runtime.contextId ?? state.contextId ?? null;
    const sessions = contextId ? deps.sessionThreads : null;
    const codexHome = appServer.getCodexHome?.() ?? null;
    const session = sessions ? sessions.get(contextId) : null;
    // ROLE-01: the lead profile (project overrides included). A thread started under another profile keeps
    // the old instructions, so a changed hash rolls the session over to a new thread.
    const leadProfileSha256 = leadSkillContext.enabled
      ? sha256(JSON.stringify([roleProfileSha256(leadRole), { enabled: true, pin: leadSkillContext.pin }]))
      : roleProfileSha256(leadRole);
    let threadId = null;
    let rolledOver = false;
    const retrySameThread = update.retryDecide ?? state.retryDecide;
    if (retrySameThread && state.threadId) threadId = state.threadId;
    else if (session?.threadId) {
      const sameProfile = session.profileSha256 === leadProfileSha256
        || (!leadSkillContext.enabled && !session.profileSha256);
      if (sameProfile && session.codexHome === codexHome && (session.lastInputTokens == null || session.lastInputTokens <= rolloverThreshold(session.contextWindow))) threadId = session.threadId;
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
        notes, skillCandidates, skillNames, mcpToolCandidates, mcpToolNames, delta, sessionDigest,
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
      ...(selectedLeadSkills.length ? { selectedSkills: selectedLeadSkills } : {}),
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
      if (kind === 'aborted') return canceledUpdate(signal, update);
      if (kind === 'usage_limit') return { ...update, budget: { source: 'lead' } };
      throw error;
    } finally {
      activity?.end(activityOutcome);
    }
    update.leadSkillContext = leadSkillContext;
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
          profileSha256: leadProfileSha256,
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
        mcpToolCatalog: mcpCatalog,
        mcpToolCandidateIds,
        knownProblemIds: knownProblemIdsForDecision(decision.records),
        // LL-6 investigate first.
        investigations: investigationsOf(state),
        openDecisionRounds: new Map(state.openDecisions.map((entry) => [entry.id, roundOf(entry.assignmentId) ?? 0])),
        goalInvestigationRound: state.goalInvestigation ? state.goalInvestigation.round : null,
        incompleteCriticalCheckpointIds: incompleteCriticalCheckpointIds(state),
      });
      if (decision.action === 'finish') {
        const ledger = decision.goalAchieved === false ? decision.checkpoints : null;
        const blocked = gateFailure(state, { forFinish: true, exempt: ledger ? ledgerExemption(state, ledger) : null });
        if (blocked) throw new BoundaryViolation('decision.review_gate', 'review_receipt_missing', blocked);
      } else if (decision.action === 'dispatch') {
        const prerequisiteAssignments = decision.assignments.filter((assignment) => (assignment.review?.prerequisiteFor || []).length > 0
          && !activeObligation(state, assignment.review));
        const prerequisiteVerifiers = prerequisiteAssignments.filter((assignment) => canonicalRoleId(assignment.role) === 'verifier');
        if (prerequisiteAssignments.length > 0 && (prerequisiteVerifiers.length !== 1
          || !isPrerequisiteVerifier(state, prerequisiteVerifiers[0], decision.assignments))) {
          throw new BoundaryViolation('decision.review_gate', 'review_checkpoint_pending',
            'A prerequisite verifier must name the exact incomplete critical checkpoints, use a new gated checkpoint, and have a known target');
        }
        const deferred = ownerBlockedIds(state);
        const deferredReview = decision.assignments.find((assignment) => ['verifier', 'auditor'].includes(canonicalRoleId(assignment.role))
          && assignment.review && deferred.has(assignment.review.checkpointId));
        if (deferredReview) {
          const entry = state.blockedCheckpoints.find((value) => value.checkpointId === deferredReview.review.checkpointId);
          throw new BoundaryViolation('decision.checkpoint_blocked', 'checkpoint_blocked',
            `Checkpoint ${entry.checkpointId} is blocked (${entry.reason}); do not dispatch reviewers for it. When every remaining checkpoint is accepted or blocked, finish with the partial ledger.`);
        }
        const blocked = gateFailure(state, { assignments: decision.assignments });
        if (blocked) throw new BoundaryViolation('decision.review_gate', 'review_checkpoint_pending', blocked);
        for (const assignment of decision.assignments) {
          const prior = activeObligation(state, assignment.review);
          if (prior && !obligationMatches(prior, assignment.review)) {
            throw new BoundaryViolation('decision.review_gate', 'review_context_mismatch',
              `Checkpoint ${prior.checkpointId} already has a pending or completed review context; keep its kind, reason, paths, and evidence IDs unchanged or use a new checkpoint ID`);
          }
        }
        for (const assignment of decision.assignments) {
          if (canonicalRoleId(assignment.role) !== 'auditor' || !isGatedReview(assignment.review)) continue;
          const obligation = activeObligation(state, assignment.review);
          const priorReceipt = obligationMatches(obligation, assignment.review)
            ? matchingReceipt(obligation, 'verifier', targetForReview(state, assignment.review), state) : null;
          const earlierVerifier = decision.assignments.some((candidate, candidateIndex) => candidateIndex < decision.assignments.indexOf(assignment)
            && canonicalRoleId(candidate.role) === 'verifier' && sameReviewScope(candidate.review, assignment.review));
          if (!priorReceipt && !earlierVerifier) {
            throw new BoundaryViolation('decision.review_gate', 'verifier_receipt_missing',
              `Auditor checkpoint ${assignment.review.checkpointId} needs a passing current-target verifier receipt or an earlier verifier group in this decision`);
          }
        }
      }
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
        const question = `The lead decision failed validation ${consecutive} times in a row (${codes.join(', ')}): ${error.message}. Continue to replan with a note, change the goal, or accept the current result as is.`;
        return {
          ...update,
          rejections: [...(state.rejections || []), { round: state.round + 1, at: new Date().toISOString(), violations: error.violations }].slice(-5),
          consecutiveRejections: consecutive,
          retryDecide: false,
          ...escalate(state, 'loop_detected', question, 'The lead could not produce a valid decision after two correction reminders.'),
        };
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
    recordSemanticRecords(state, decision.records);
    recordLeadResolutions(state, decision.resolutions);
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
      const completeObligations = (state.reviewObligations || []).filter((entry) => {
        const gate = currentGateState(state, entry);
        return gate.verifier && (!isGatedReview(entry.review) || gate.auditor);
      });
      logGateReuse(state, completeObligations);
      const final = decision.final.trim();
      if (decision.goalAchieved === false && decision.checkpoints) {
        // A partial result: the lead's own ledger ends the run as completed with disposition partial.
        return { ...update, status: 'completed', text: final, partial: { checkpoints: decision.checkpoints, round: state.round } };
      }
      if (decision.goalAchieved === false) {
        // The first unmet-goal finish is not a pause: the lead investigates within the configured allowance.
        if (!state.goalInvestigation) {
          return {
            ...update,
            goalInvestigation: { round: state.round, final: final.slice(0, MAX_ESCALATION_QUESTION_CHARS) },
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
      recordStage('owner_decision_required', {
        runId: state.runId,
        decisionId,
        status: 'open',
        payload: {
          reason: decision.humanInput.reason,
          question: String(decision.humanInput.question || '').slice(0, 1000),
          recommendation: decision.humanInput.recommendation,
          relatedDecisionIds: decision.humanInput.relatedDecisionIds,
        },
      });
      return { ...update, humanCount: state.humanCount + 1, humanRequest: { decisionId, ...decision.humanInput } };
    }
    const limit = roundLimit(state);
    if (limit !== null && state.round >= limit) {
      const question = `Dispatch round limit reached: ${state.round} of ${limit} rounds used and the lead has not finished. ${roundSummary(state)} Continue with another ${maxRounds} rounds, accept the current result as is, or change the goal?`;
      return { ...update, ...escalate(state, 'round_limit', question, `Stopped after reaching the caller-configured limit of ${limit} dispatch rounds.`) };
    }
    const dispatchRound = state.round + 1;
    const dependsOnCompletedGate = decision.assignments.some((assignment) => {
      if (getRole(roles, assignment.role)?.sandbox === 'read-only') return false;
      return (state.reviewObligations || []).some((entry) => isGatedReview(entry.review)
        && entry.checkpointId !== assignment.review?.checkpointId);
    });
    if (dependsOnCompletedGate) {
      logGateReuse(state, (state.reviewObligations || []).filter((entry) => isGatedReview(entry.review)
        && currentGateState(state, entry).verifier && currentGateState(state, entry).auditor));
    }
    update.reviewObligations = reviewObligationsForDispatch(state, decision.assignments, dispatchRound);
    const pendingAssignments = decision.assignments.map((assignment) => {
      const selected = resolveSkillSelection(skillCatalog, assignment.skills || []);
      const role = getRole(roles, assignment.role);
      const selectedMcp = resolveMcpToolSelection(mcpCatalog, assignment.mcpTools || [], {
        allowedServers: role?.tools?.mcpServers || [],
      });
      const repairCapture = assignment.repair ? assignment.repair.checkpointIds.map((checkpointId) => {
        const obligation = (state.reviewObligations || []).find((entry) => entry.checkpointId === checkpointId);
        const target = obligation?.review ? targetForReview(state, obligation.review) : null;
        return {
          checkpointId,
          review: obligation?.review ? { ...obligation.review, paths: [...obligation.review.paths], evidenceIds: [...obligation.review.evidenceIds] } : null,
          targetKnown: Boolean(target?.known),
          targetIdentity: target?.identity || null,
        };
      }) : null;
      return {
        ...assignment,
        ...(repairCapture ? { _repairCapture: repairCapture } : {}),
        skills: selected.map(({ id }) => id),
        skillPins: selected.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
        mcpTools: selectedMcp.map(({ id }) => id),
        mcpToolPins: mcpToolPins(selectedMcp),
      };
    });
    update.reviewRecovery = captureReviewRecoveryTemplates(state.reviewRecovery, pendingAssignments);
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
    if (!row) {
      resolveSkillSelection(skillCatalog, skillIds, { pins: skillPins });
      resolveMcpToolSelection(mcpCatalog, item.assignment?.mcpTools || [], {
        pins: item.assignment?.mcpToolPins || [],
        allowedServers: role?.tools?.mcpServers || [],
      });
    }

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
    const reportContract = canonicalRoleId(item.role) === 'auditor' && isGatedReview(item.assignment?.review)
      && item.assignment?.review?.kind !== 'pinned_check'
      ? `${REPORT_CONTRACT_LINE} ${ACCEPTANCE_AUDIT_REPORT_LINE}`
      : REPORT_CONTRACT_LINE;
    const text = JSON.stringify({
      ...assignmentFields,
      assignmentId: item.assignmentId,
      workspace,
      reportContract,
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
          metadata: { runId: item.runId, assignmentId: item.assignmentId, attemptId: item.attemptId },
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] },
        metadata: { runId: item.runId, assignmentId: item.assignmentId, attemptId: item.attemptId },
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
    if (signal?.aborted) return canceledUpdate(signal);
    if (ownerPauseRequested(config)) interrupt({ kind: 'owner_pause', message: OWNER_PAUSE_MESSAGE });
    let batch = state.batch;
    const update = {};
    if (!batch) {
      const round = state.round + 1;
      const allReadOnly = state.pendingAssignments.every((assignment) => getRole(roles, assignment.role).sandbox === 'read-only');
      const hasReviewRole = state.pendingAssignments.some((assignment) => ['auditor', 'verifier'].includes(canonicalRoleId(assignment.role)));
      const hasExplicitWave = state.pendingAssignments.some((assignment) => assignment.wave !== null && assignment.wave !== undefined);
      const parallel = allReadOnly && !hasReviewRole && !hasExplicitWave;
      const groupOf = new Map();
      executionGroups(state.pendingAssignments).forEach((members, groupIndex) => members.forEach((index) => groupOf.set(index, groupIndex)));
      batch = {
        round,
        parallel,
        items: state.pendingAssignments.map((assignment, index) => {
          const skillPins = assignment.skillPins || [];
          resolveSkillSelection(skillCatalog, assignment.skills || [], { pins: skillPins });
          const mcpPins = assignment.mcpToolPins || [];
          resolveMcpToolSelection(mcpCatalog, assignment.mcpTools || [], {
            pins: mcpPins,
            allowedServers: getRole(roles, assignment.role)?.tools?.mcpServers || [],
          });
          const assignmentId = makeAssignmentId(state.runId, round, index);
          const attemptId = makeAttemptId(assignmentId);
          const role = getRole(roles, assignment.role);
          const { _repairCapture, _reviewRecovery, ...assignmentFields } = assignment;
          // LL-5: continue the thread of an earlier outcome with the new (usually expanded) scope.
          const origin = assignment.continueFrom ? state.outcomes.find((outcome) => !outcome.kind && outcome.assignmentId === assignment.continueFrom) : null;
          return {
            runId: state.runId,
            assignmentId,
            attemptId,
            contextId: deterministicContextId(attemptId),
            role: assignment.role,
            sandbox: role.sandbox,
            assignment: assignmentFields,
            ...(_repairCapture ? { repairCapture: _repairCapture } : {}),
            ...(_reviewRecovery ? { reviewRecovery: _reviewRecovery } : {}),
            ...(origin ? {
              continuation: {
                ofAttemptId: origin.attemptId,
                threadId: origin.continuation?.threadId ?? null,
                laneId: origin.continuation?.laneId ?? null,
                codexHome: origin.continuation?.codexHome ?? null,
                ...(Array.isArray(origin.continuation?.mcpToolPins) ? { mcpToolPins: origin.continuation.mcpToolPins } : {}),
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
              mcpToolPins: mcpPins.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
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

    if (batch.items.some((item) => item.state === 'finished' && !item.stagingProcessed)) {
      const integrated = integrateFinishedGroup({ ...state, reviewObligations: update.reviewObligations || state.reviewObligations }, batch);
      batch = integrated.batch;
      update.reviewObligations = integrated.reviewObligations;
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

    const obligations = update.reviewObligations || state.reviewObligations || [];
    const gateState = { ...state, reviewObligations: obligations };
    const latestItems = new Map(batch.items.map((item) => [item.assignmentId, item]));
    const runnable = [];
    const skip = (item, code, message, reason) => {
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
      recordStage('review_gate_skipped', {
        runId: item.runId,
        assignmentId: item.assignmentId,
        attemptId: item.attemptId,
        role: canonicalRoleId(item.role),
        target: item.reviewTarget?.identity || null,
        status: code,
        payload: { policyId: POLICY_ID, checkpointId: item.assignment?.review?.checkpointId || null, reason: String(reason || code).slice(0, 400) },
      });
      latestItems.set(item.assignmentId, finishItem({ ...item, reviewSkipped: true }, {
        ...syntheticResult(code, message, { contextId: item.contextId }),
        effects: 'none',
      }));
    };

    for (const original of targets) {
      let item = original;
      const review = item.assignment?.review || null;
      const role = canonicalRoleId(item.role);
      const isVerifier = role === 'verifier';
      const isAuditor = role === 'auditor';
      const tracked = review && (isGatedReview(review) || review.kind === 'routine');
      const scopedReviewer = hasActiveReviewerScope(gateState, role, review);
      const target = review ? targetForReview(gateState, review) : null;
      let repairPreflightFailure = null;
      if (item.assignment?.repair) {
        const ids = item.assignment.repair.checkpointIds || [];
        const captures = item.repairCapture || [];
        if (ids.length === 0 || captures.length !== ids.length
          || ids.some((id) => !captures.some((capture) => capture.checkpointId === id))) {
          repairPreflightFailure = 'repair_assignment_snapshot_missing';
        } else {
          for (const captured of captures) {
            const obligation = obligations.find((entry) => entry.checkpointId === captured.checkpointId);
            const current = obligation?.review ? targetForReview(gateState, obligation.review) : null;
            const contextMatches = Boolean(obligation && captured.review && sameReviewScope(obligation.review, captured.review));
            const targetMatches = Boolean(captured.targetKnown && captured.targetIdentity && current?.known
              && current.identity === captured.targetIdentity);
            recordStage('repair_target', {
              runId: item.runId,
              assignmentId: item.assignmentId,
              attemptId: item.attemptId,
              role,
              target: captured.targetIdentity,
              status: !contextMatches ? 'context_changed' : !targetMatches ? 'target_changed' : 'known',
              payload: {
                policyId: POLICY_ID,
                checkpointId: captured.checkpointId,
                targetKnown: Boolean(current?.known && captured.targetKnown),
                currentTargetMatches: targetMatches,
                contextMatches,
              },
            });
            if (!contextMatches || !targetMatches) {
              repairPreflightFailure = !contextMatches ? 'repair_context_changed' : 'repair_target_stale';
              break;
            }
          }
        }
      }
      if (review) {
        const captured = item.reviewTarget || (target ? { known: target.known, identity: target.identity, reason: target.reason } : null);
        item = { ...item, reviewTarget: captured };
        recordStage('review_target', {
          runId: item.runId,
          assignmentId: item.assignmentId,
          attemptId: item.attemptId,
          role,
          target: captured?.identity || null,
          status: !target?.known || !captured?.known ? 'unknown'
            : target.identity === captured.identity ? 'known' : 'stale',
          payload: {
            policyId: POLICY_ID,
            checkpointId: review.checkpointId,
            reason: target?.reason || captured?.reason || null,
            phase: item.continuation ? 'before_continuation' : 'before_submit',
            currentTargetMatches: Boolean(target?.known && captured?.known && target.identity === captured.identity),
          },
        });
      }

      let blocked = null;
      if (repairPreflightFailure) {
        blocked = { code: repairPreflightFailure, reason: 'The repair checkpoint context or captured current target is unavailable or changed; no write was submitted.' };
      }
      if (tracked && item.reviewTarget?.known && target?.known && item.reviewTarget.identity !== target.identity) {
        blocked = item.continuation
          ? { code: 'stale_review_continuation', reason: 'The review target changed while the prior role turn was usage-limited; start a fresh review of the current target.' }
          : { code: 'stale_review_target', reason: 'The review target changed after this assignment was checkpointed; start a fresh review of the current target.' };
      }
      if ((isVerifier || isAuditor) && state.unresolvedWriters.length > 0) {
        blocked ||= { code: 'skipped_unresolved_writer', reason: 'A writer outcome is unresolved; review cannot begin until its effects are settled.' };
      }
      if (!blocked && tracked && !target?.known) {
        blocked = { code: 'review_target_unknown', reason: target?.reason || 'The current review target identity is unavailable.' };
      }
      if (!blocked && tracked && isAuditor && review.kind !== 'pinned_check') {
        const obligation = activeObligation(gateState, review);
        const verifierReceipt = obligationMatches(obligation, review)
          ? matchingReceipt(obligation, 'verifier', target, gateState, batch, item) : null;
        const unfinishedWriter = (obligation?.pendingAssignmentIds || []).length > 0
          || unfinishedCheckpointWriter(batch, review.checkpointId);
        if (unfinishedWriter) blocked = { code: 'skipped_review_pending_writer', reason: 'A same-checkpoint writer has not finished and integrated.' };
        else if (!verifierReceipt) blocked = { code: 'skipped_verifier_gate', reason: 'No accepted verifier receipt covers the current target.' };
        if (!blocked && obligationMatches(obligation, review)) {
          const verifierItem = sameBatchVerifierItem(obligation, target, gateState, batch, item);
          if (verifierItem) {
            const recovery = validReviewRecovery(gateState.reviewRecovery)
              ? gateState.reviewRecovery.checkpoints.find((entry) => entry.checkpointId === review.checkpointId
                && entry.contextHash === reviewContextHash(obligation.review)) : null;
            const handoff = freshVerifierHandoff(obligation, target, recovery, verifierItem);
            if (handoff.error) {
              blocked = { code: 'fresh_verifier_handoff_unavailable', reason: `The fresh verifier receipt is accepted, but its bounded handoff to the matching auditor is unavailable (${handoff.error}).` };
            } else {
              const inputs = [...item.assignment.inputs, ...handoff.inputs];
              const acceptanceCriteria = [...item.assignment.acceptanceCriteria, handoff.instruction];
              if (inputs.length > MAX_REVIEW_HANDOFF_INPUTS
                || inputs.some((input) => input.length > MAX_REVIEW_HANDOFF_INPUT_CHARS)
                || acceptanceCriteria.length > MAX_REVIEW_HANDOFF_INPUTS
                || acceptanceCriteria.some((criterion) => criterion.length > MAX_REVIEW_HANDOFF_INPUT_CHARS)) {
                blocked = { code: 'fresh_verifier_handoff_unavailable', reason: 'The fresh verifier handoff exceeds the bounded auditor assignment limits.' };
              } else {
                item = { ...item, assignment: { ...item.assignment, inputs, acceptanceCriteria } };
              }
            }
          }
        }
      }
      if (!blocked && tracked && isVerifier) {
        const obligation = activeObligation(gateState, review);
        const unfinishedWriter = (obligation?.pendingAssignmentIds || []).length > 0
          || unfinishedCheckpointWriter(batch, review.checkpointId);
        if (unfinishedWriter) blocked = { code: 'skipped_review_pending_writer', reason: 'A same-checkpoint writer has not finished and integrated.' };
      }
      if (!blocked && item.sandbox !== 'read-only') {
        for (const obligation of obligations.filter((entry) => isGatedReview(entry.review) && !ownerBlockedIds(gateState).has(entry.checkpointId))) {
          const gate = currentGateState(gateState, obligation);
          const complete = (obligation.pendingAssignmentIds || []).length === 0 && gate.verifier && gate.auditor;
          const scopedRepair = item.repairCapture?.some((capture) => capture.checkpointId === obligation.checkpointId) === true;
          if (!complete && review?.checkpointId !== obligation.checkpointId && !scopedReviewer && !scopedRepair) {
            blocked = {
              code: 'skipped_critical_review_gate',
              reason: `Critical checkpoint ${obligation.checkpointId} still requires current verifier and auditor receipts.`,
            };
            break;
          }
        }
      }

      if (blocked) {
        skip(item, blocked.code, `Not submitted: ${blocked.reason}`, blocked.reason);
        continue;
      }

      if (tracked && (isVerifier || isAuditor)) {
        const obligation = activeObligation(gateState, review);
        const receipt = obligationMatches(obligation, review) ? matchingReceipt(obligation, role, target, gateState) : null;
        if (receipt) {
          recordStage('review_evidence_reused', {
            runId: item.runId,
            assignmentId: item.assignmentId,
            attemptId: item.attemptId,
            role,
            target: target.identity,
            status: 'reused',
            payload: { policyId: POLICY_ID, checkpointId: review.checkpointId, receiptStatus: receipt.status },
          });
          const row = journal.get(item.attemptId);
          if (!row) journal.recordSubmitting({
            attemptId: item.attemptId,
            runId: item.runId,
            assignmentId: item.assignmentId,
            role: item.role,
            sandbox: item.sandbox,
            contextId: item.contextId,
            objectiveSha256: sha256(String(item.assignment?.objective ?? '')),
          });
          latestItems.set(item.assignmentId, finishItem({ ...item, reviewReused: true }, {
            ...syntheticResult('review_receipt_reused', 'An accepted receipt already covers the current target.', { contextId: item.contextId }),
            effects: 'none',
          }));
          continue;
        }
      }
      runnable.push(item);
    }

    // An abort during submit leaves the item submitted with an unknown task so collect can cancel it.
    const settled = await Promise.allSettled(runnable.map((item) => submitItem(item, signal).catch((error) => {
      if (error?.name === 'AbortError') return { ...item, state: 'submitted', taskId: null };
      throw error;
    })));
    const failure = settled.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
    for (const entry of settled) latestItems.set(entry.value.assignmentId, entry.value);
    return { ...update, batch: { ...batch, items: batch.items.map((item) => latestItems.get(item.assignmentId) || item) } };
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
    return { batch, ...(runtime.signal?.aborted ? canceledUpdate(runtime.signal) : {}) };
  }

  async function verify(state, config) {
    const runtime = runtimeOf(config);
    const integrated = integrateFinishedGroup(state, state.batch);
    const batch = integrated.batch;
    const finished = batch.items.filter((item) => item.state === 'finished');
    const summaries = finished.map((item) => item.reviewSummary || outcomeSummary(item));
    const open = [...state.openDecisions];
    for (const outcome of summaries) {
      if (outcome.report?.outcome === 'needs_decision' && !open.some((entry) => entry.id === outcome.attemptId)) {
        open.push({ id: outcome.attemptId, role: outcome.role, assignmentId: outcome.assignmentId, request: outcome.report.decisionRequest });
      }
    }
    for (const outcome of summaries) deps.emit(runtime.onEvent, { type: 'assignment', round: batch.round, ...outcome });
    deps.emit(runtime.onEvent, { type: 'round', round: batch.round, outcomes: summaries });
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
          ...(item.reviewTarget ? { reviewTarget: item.reviewTarget } : {}),
          ...(item.reviewRecovery ? { reviewRecovery: item.reviewRecovery } : {}),
          ...(item.contract ? { contract: item.contract } : {}),
        },
        continuation: item.result.continuation,
      }));
    const batchSettled = batch.items.length > 0
      && batch.items.every((item) => item.state === 'finished')
      && batch.items.every((item) => item.sandbox === 'read-only' || isSettledWriter(item.result));
    let loopGuard = state.loopGuard || null;
    if (batchSettled && !limited && state.status !== 'canceled') {
      const observations = batch.items.map((item) => {
        const outcome = item.reviewSummary || outcomeSummary(item);
        let contentIdentity = null;
        const delta = outcome.writerExecution?.delta;
        const targetPaths = integratedChange(outcome) && delta?.known === true && outcome.attestedDeltaKnown === true
          && Array.isArray(delta.changedPaths) && delta.changedPaths.length > 0 && delta.changedPaths.length <= 20
          && (delta.changedPathCount ?? delta.changedPaths.length) === delta.changedPaths.length
          ? delta.changedPaths
          : (item.assignment?.review?.paths || []);
        if (targetPaths.length > 0 && targetPaths.length <= 20) {
          const target = computeReviewTarget({
            workspace,
            review: {
              kind: 'loop_target',
              checkpointId: `loop:${sha256([...targetPaths].sort().join('\n')).slice(0, 24)}`,
              reason: 'bounded scoped content identity',
              paths: [...new Set(targetPaths)].sort(),
              evidenceIds: [],
            },
            runId: state.runId,
            goal: state.goalOverride || state.goal,
          });
          if (target.known) contentIdentity = target.identity;
        }
        return makeObservation({ item, outcome, contentIdentity, implemented: integratedChange(outcome) });
      });
      loopGuard = observeLoopGuard(state.loopGuard, batch.round, observations);
    }
    const loopPause = loopGuard?.pause || null;
    const loopReferences = (loopPause?.references || []).map((entry) => entry.attemptId || entry.assignmentId).filter(Boolean).join(', ');
    if (loopGuard?.pause) {
      const { pause: _pause, ...persistedGuard } = loopGuard;
      loopGuard = persistedGuard;
    }
    const recoveryPlan = planAutomaticReviewRecovery(state, batch, integrated.reviewObligations, unresolvedWriters, runtime, config);
    const changes = summaries.filter((outcome) => integratedChange(outcome));
    return {
      outcomes: [...state.outcomes, ...summaries.map(({ loopEvidenceIdentity: _identity, ...outcome }) => outcome)],
      ...(changes.length > 0 ? { progress: addProgress(state, changes.map((outcome) => ({ round: batch.round, kind: 'integrated_change', detail: outcome.assignmentId }))) } : {}),
      openDecisions: open,
      unresolvedWriters,
      reviewObligations: integrated.reviewObligations,
      batch: null,
      continuable,
      reviewRecovery: recoveryPlan.recovery,
      ...(recoveryPlan.pendingAssignments ? { pendingAssignments: recoveryPlan.pendingAssignments } : {}),
      ...(loopGuard ? { loopGuard } : {}),
      ...(loopPause ? {
        ...(loopPause.recurrence
          ? escalate(state, 'loop_detected', `Repeated ${loopPause.roleClass} work paused: checkpoint ${loopPause.checkpoint} was reviewed or investigated ${loopPause.attempts} times on the same target in rounds ${loopPause.rounds.join(', ')} with no implementation in between${loopReferences ? ` (attempts: ${loopReferences})` : ''}. Continue with a different approach, change the goal, or accept the current result as is.`, `The same ${loopPause.roleClass} of checkpoint ${loopPause.checkpoint} recurred ${loopPause.attempts} times with no implementation in between.`)
          : escalate(state, 'loop_detected', `Repeated work paused after ${loopPause.attempts} completed rounds with unchanged evidence: ${loopPause.description}${loopReferences ? ` (attempts: ${loopReferences})` : ''}. Continue with a different approach, change the goal, or accept the current result as is.`, `The same scoped work repeated ${loopPause.attempts} times without relevant new evidence.`)),
      } : {}),
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
    if (runtime.signal?.aborted) return canceledUpdate(runtime.signal, { continuable: [] });
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
        ...(origin.reviewTarget ? { reviewTarget: origin.reviewTarget } : {}),
        ...(origin.reviewRecovery ? { reviewRecovery: origin.reviewRecovery } : {}),
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

  // Legacy resume only. The system repair route was removed, but a session parked at the old
  // system_pause node must still load and resume. Reaching this node discards the legacy request,
  // records one progress note, and continues with an ordinary lead turn. No new run routes here.
  async function systemPause(state) {
    return {
      systemRequest: null,
      progress: addProgress(state, [{
        round: state.round,
        kind: 'route_removed',
        detail: 'The system repair route was removed; the pending system repair request was discarded.',
      }]),
    };
  }

  async function humanInput(state, config) {
    const request = state.humanRequest;
    const { final: _final, review: _review, ...shown } = request;
    const answer = interrupt({ kind: 'human_decision', ...shown });
    if (request.escalation === 'check_changed') {
      const update = resolveCheckChange(state, request, answer, runtimeOf(config));
      recordStage('owner_decision_resolved', {
        runId: state.runId,
        decisionId: request.decisionId,
        status: answer.choice === 'approve_change' ? 'accepted' : 'rejected',
        payload: { reason: request.reason, choice: answer.choice === 'approve_change' ? 'approve_change' : 'keep_requirement' },
      });
      return update;
    }
    if (request.escalation) {
      const update = resolveEscalation(state, request, answer);
      recordStage('owner_decision_resolved', {
        runId: state.runId,
        decisionId: request.decisionId,
        status: answer.choice === 'accept_as_is' ? 'accepted' : 'resolved',
        payload: { reason: request.escalation, choice: ESCALATION_CHOICES.includes(answer.choice) ? answer.choice : 'continue' },
      });
      return update;
    }
    // relatedDecisionIds may also cite an investigation (LL-6); only open decisions are closed.
    const related = new Set((request.relatedDecisionIds || []).filter((id) => state.openDecisions.some((entry) => entry.id === id)));
    recordStage('owner_decision_resolved', {
      runId: state.runId,
      decisionId: request.decisionId,
      status: 'resolved',
      payload: { choice: answer.choice || 'continue', relatedDecisionIds: [...related] },
    });
    const grant = answer.choice === OWNER_RECOVERY_GRANT_CHOICE ? applyOwnerRecoveryGrant(state, request, answer) : null;
    const deferred = deferredCheckpoints(state, request, answer);
    return {
      ...(grant || {}),
      ...(deferred.length > 0 ? { blockedCheckpoints: [...(state.blockedCheckpoints || []), ...deferred].slice(-MAX_PROGRESS_ENTRIES) } : {}),
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

  // B2: checkpoints cited by an owner-only request that the owner answered with defer or outside_run. A
  // checkpoint is cited by its id (a known review checkpoint named in the request), through an outcome whose
  // assignmentId appears in relatedDecisionIds or evidenceChecked, or through the open worker decision it lists.
  function deferredCheckpoints(state, request, answer) {
    if (!CHECKPOINT_BLOCK_REASONS.includes(request.reason) || !CHECKPOINT_BLOCK_CHOICES.includes(answer.choice)) return [];
    const cited = [...(request.relatedDecisionIds || []), ...(request.evidenceChecked || []), request.question].filter((text) => typeof text === 'string').join('\n');
    const mentions = (id) => id && new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(cited);
    const checkpointIds = new Set();
    for (const outcome of state.outcomes) {
      if (!outcome.kind && outcome.checkpointId && mentions(logicalAssignmentId(outcome.assignmentId))) checkpointIds.add(outcome.checkpointId);
    }
    for (const obligation of state.reviewObligations || []) {
      if (mentions(obligation.checkpointId)) checkpointIds.add(obligation.checkpointId);
    }
    for (const decision of state.openDecisions) {
      if (!(request.relatedDecisionIds || []).includes(decision.id)) continue;
      for (const outcome of state.outcomes) {
        if (!outcome.kind && outcome.checkpointId && logicalAssignmentId(outcome.assignmentId) === logicalAssignmentId(decision.assignmentId)) checkpointIds.add(outcome.checkpointId);
      }
    }
    const known = ownerBlockedIds(state);
    const note = String(answer.answer || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return [...checkpointIds].filter((id) => !known.has(id)).map((checkpointId) => ({
      checkpointId,
      reason: `Owner answered "${answer.choice}" to ${request.reason} (${request.decisionId})${note ? `: ${note}` : ''}`,
      decisionId: request.decisionId,
      round: state.round,
    }));
  }

  // LL-1 resume: an answer without a known choice is the recommended continue, with the answer as a note.
  function resolveEscalation(state, request, answer) {
    const choice = ESCALATION_CHOICES.includes(answer.choice) ? answer.choice : 'continue';
    const update = {
      humanAnswers: [...state.humanAnswers, { decisionId: request.decisionId, answer: answer.answer, choice }],
      humanRequest: null,
    };
    if (choice === 'accept_as_is') return { ...update, status: 'completed', text: request.final };
    const budget = Number.isInteger(maxRounds) ? {
      extraRounds: (state.extraRounds || 0) + maxRounds,
      roundExtensions: [...(state.roundExtensions || []), { round: state.round, by: 'owner', rounds: maxRounds }],
    } : {};
    const loopReset = request.escalation === 'loop_detected' ? { loopGuard: resetLoopGuard() } : {};
    if (choice === 'change_goal') return { ...update, ...budget, ...loopReset, goalOverride: String(answer.answer).trim() };
    return { ...update, ...budget, ...loopReset };
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
    let { verdict, prdChange, parsed } = parseVerdict(outcome);
    const currentTarget = review.review ? targetForReview(state, review.review) : null;
    const coverage = outcome?.reviewCoverage || null;
    const serviceReview = outcome?.reviewResult || null;
    const serviceUnstable = !coverage || (coverage.targetKnown !== true || coverage.identityPresent !== true || coverage.stable !== true
      || ['unknown', 'unstable', 'inconclusive'].includes(coverage.status));
    const serviceRejected = !serviceReview || serviceReview.policyId !== POLICY_ID
      || serviceReview.kind !== review.review?.kind
      || serviceReview.checkpointId !== review.review?.checkpointId
      || serviceReview.valid !== true
      || !['preserve', 'weaken'].includes(serviceReview.verdict);
    const graphUnstable = !review.reviewTarget?.known || !currentTarget?.known
      || review.reviewTarget.identity !== currentTarget.identity;
    if (serviceUnstable || serviceRejected || graphUnstable) {
      verdict = 'weaken';
      prdChange = null;
      parsed = false;
    }
    recordStage('pinned_check_review_result', {
      runId: state.runId,
      assignmentId: review.assignmentId,
      attemptId: outcome?.attemptId || null,
      role: outcome?.role || 'auditor',
      target: review.reviewTarget?.identity || null,
      status: verdict,
      payload: {
        policyId: POLICY_ID,
        checkpointId: review.review?.checkpointId || null,
        targetKnown: Boolean(review.reviewTarget?.known && currentTarget?.known),
        targetStable: Boolean(review.reviewTarget?.known && currentTarget?.known && review.reviewTarget.identity === currentTarget.identity),
        serviceCoverageKnown: coverage ? coverage.targetKnown === true && coverage.identityPresent === true : null,
        serviceReviewValid: serviceReview?.valid === true,
        reason: serviceUnstable ? coverage?.reason || 'role_service_review_coverage_unknown'
          : serviceRejected ? serviceReview?.reason || 'pinned_check_service_review_rejected'
            : graphUnstable ? 'pinned_check_target_changed_or_unavailable' : null,
        parsed,
      },
    });
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

  // Between collect and verify every submitted worker turn is terminal. Nothing is cancelled here.
  async function ownerPause(state, config) {
    if (ownerPauseRequested(config)) interrupt({ kind: 'owner_pause', message: OWNER_PAUSE_MESSAGE });
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
      ...(deps.acceptanceScratch ? { acceptanceScratch: deps.acceptanceScratch } : {}),
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
    acceptance = enforceReviewAcceptance(state, acceptance);
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
      return { ...runs, acceptanceAttempts: state.acceptanceAttempts + 1, status: null, text: '', partial: null };
    }
    return runs;
  }

  async function finish(state) {
    // STOP-01: a shutdown stop (signal reason ownerStop) leaves a canceled run parked, not terminal.
    // Nothing else runs first: on resume this node re-runs from here and the run goes back to planning.
    if (state.status === 'canceled' && state.parkOnStop) {
      interrupt({ kind: 'stopped', message: STOPPED_MESSAGE });
      return { status: null, text: '', parkOnStop: false };
    }
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
    acceptance = enforceReviewAcceptance(state, acceptance);
    const partial = state.status === 'completed' && state.partial?.checkpoints
      ? finalizeLedger(state.partial.checkpoints, { blocked: state.blockedCheckpoints || [], acceptance }) : null;
    return {
      result: {
        runId: state.runId,
        status: state.status,
        text: state.text,
        rounds: state.round,
        assignments: state.outcomes,
        acceptance,
        ...(partial ? { disposition: 'partial', checkpoints: partial } : {}),
      },
    };
  }

  const afterDecide = (state, config) => {
    if (state.status === 'completed') return 'accept';
    if (state.status) return 'finish';
    if (state.budget) return 'budget_pause';
    if (state.humanRequest) return 'human_input';
    if (state.retryDecide || state.redecide) return 'decide';
    // A pause requested during the lead turn parks before anything is submitted; the plan is kept.
    return ownerPauseRequested(config) ? 'pause_before_dispatch' : 'dispatch';
  };
  const afterAccept = (state) => {
    if (state.status) return 'finish';
    return state.batch ? 'dispatch' : 'decide';
  };
  const afterReviewCheck = (state) => (state.humanRequest ? 'human_input' : 'accept');
  const afterHumanInput = (state) => {
    if (state.status === 'completed') return 'accept';
    return ownerGrantDispatchPending(state) ? 'dispatch' : 'decide';
  };
  // A legacy checkpoint parked at an owner pause with a system request continues through the legacy node.
  const afterLegacyPause = (state) => (state.systemRequest ? 'system_pause' : 'dispatch');
  const afterOwnerPause = (state) => (state.systemRequest ? 'system_pause'
    : state.pendingAssignments ? 'dispatch' : collectRoute(state));
  const collectRoute = (state) => {
    if (state.status === 'canceled') return 'verify';
    if (state.batch.items.some((item) => item.state === 'pending')) return 'dispatch';
    return 'verify';
  };
  const afterCollect = (state, config) => {
    if (state.status !== 'canceled' && ownerPauseRequested(config)) return 'owner_pause';
    return collectRoute(state);
  };
  const afterVerify = (state, config) => {
    if (state.status === 'canceled') return 'finish';
    if (state.unresolvedWriters.length > 0) return 'reconcile';
    if (state.budget) return 'budget_pause';
    if (state.humanRequest) return 'human_input';
    if (state.checkReview) return 'review_check';
    if (state.pendingAssignments) return ownerPauseRequested(config) ? 'pause_before_dispatch' : 'dispatch';
    return 'decide';
  };
  const afterReconcile = (state) => (state.budget ? 'budget_pause'
    : state.pendingAssignments && state.unresolvedWriters.length === 0 ? 'dispatch' : 'decide');
  // A normal finish always sets the result. A finish resumed from a stop has none: unresolved writers
  // are reconciled first (the canceled run skipped that), then the lead plans again.
  const afterFinish = (state) => {
    if (state.result) return END;
    return state.unresolvedWriters.length > 0 ? 'reconcile' : 'decide';
  };
  const afterContinueLimited = (state) => {
    if (state.status) return 'finish';
    if (state.batch) return 'dispatch';
    if (state.pendingAssignments) return 'dispatch';
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
    .addNode('system_pause', systemPause)
    .addNode('budget_pause', budgetPause)
    .addNode('owner_pause', ownerPause)
    .addNode('pause_before_dispatch', ownerPause)
    .addNode('continue_limited', continueLimited)
    .addNode('accept', accept)
    .addNode('review_check', reviewCheck)
    .addNode('finish', finish)
    .addEdge(START, 'intake')
    .addEdge('intake', 'decide')
    .addConditionalEdges('decide', afterDecide, ['finish', 'accept', 'budget_pause', 'human_input', 'dispatch', 'decide', 'pause_before_dispatch'])
    .addConditionalEdges('pause_before_dispatch', afterLegacyPause, ['system_pause', 'dispatch'])
    .addConditionalEdges('accept', afterAccept, ['finish', 'decide', 'dispatch'])
    .addConditionalEdges('review_check', afterReviewCheck, ['accept', 'human_input'])
    .addEdge('dispatch', 'collect')
    .addConditionalEdges('collect', afterCollect, ['dispatch', 'verify', 'owner_pause'])
    .addConditionalEdges('owner_pause', afterOwnerPause, ['system_pause', 'dispatch', 'verify'])
    .addConditionalEdges('verify', afterVerify, ['finish', 'reconcile', 'budget_pause', 'human_input', 'review_check', 'pause_before_dispatch', 'dispatch', 'decide'])
    .addConditionalEdges('reconcile', afterReconcile, ['budget_pause', 'dispatch', 'decide'])
    .addConditionalEdges('human_input', afterHumanInput, ['accept', 'decide', 'dispatch'])
    .addEdge('system_pause', 'decide')
    .addEdge('budget_pause', 'continue_limited')
    .addConditionalEdges('continue_limited', afterContinueLimited, ['finish', 'dispatch', 'review_check', 'decide'])
    .addConditionalEdges('finish', afterFinish, [END, 'reconcile', 'decide']);

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
