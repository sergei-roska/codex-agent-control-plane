'use strict';

// Read-only projections for the dashboard: the current situation of a session (from the lead's
// LangGraph checkpoint, thread id = lead task id) and the git status of a project directory.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { BaseCheckpointSaver } = require('@langchain/langgraph-checkpoint');
const { parseWorkerReport } = require('./contracts');
const { sessionLeadTaskIds } = require('./launcher-sessions');

// The default serde of the checkpoint saver used by the lead graph (type "json").
const SERDE = new BaseCheckpointSaver().serde;

const TERMINAL_PHASE = {
  TASK_STATE_COMPLETED: 'done',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_REJECTED: 'failed',
};
const NODE_PHASE = {
  intake: 'planning',
  decide: 'planning',
  dispatch: 'working',
  collect: 'working',
  continue_limited: 'working',
  verify: 'verifying',
  review_check: 'verifying',
  reconcile: 'verifying',
  accept: 'verifying',
  human_input: 'waiting_owner',
  budget_pause: 'budget_pause',
};
const PROGRESS_LABEL = { integrated_change: 'Integrated change', decision_resolved: 'Decision resolved', check_passed: 'Check passed' };
const PROGRESS_SHOWN = 10;
const FILES_SHOWN = 100;
const NEXT_STEPS_MAX = 1500;
const NEXT_WORK = /^\W*(next work|next steps?|remaining work|follow-?ups?)\b/i;
const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

const isString = (value) => typeof value === 'string';
function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

// Phase of the session. A checkpointed node wins over the A2A state for a budget pause and for a
// human request, because both arrive as INPUT_REQUIRED. Unknown combinations are null, never guessed.
function phaseOf(state, node) {
  if (TERMINAL_PHASE[state]) return TERMINAL_PHASE[state];
  if (node === 'budget_pause') return 'budget_pause';
  if (node === 'human_input' || state === 'TASK_STATE_INPUT_REQUIRED') return 'waiting_owner';
  return NODE_PHASE[node] ?? null;
}

// The node scheduled next is the branch channel with the highest version in the latest checkpoint.
function nodeOf(channelVersions) {
  let node = null;
  let best = -1;
  for (const [channel, version] of Object.entries(channelVersions || {})) {
    if (!channel.startsWith('branch:to:') || typeof version !== 'number' || version <= best) continue;
    best = version;
    node = channel.slice('branch:to:'.length);
  }
  return node;
}

// The final text paragraph that starts with a next-work label (same rule as the run digest).
function nextStepsOf(text) {
  if (!isString(text)) return null;
  const paragraph = text.split(/\n\s*\n/).map((part) => part.trim()).find((part) => NEXT_WORK.test(part));
  return paragraph ? clip(paragraph, NEXT_STEPS_MAX) : null;
}

function progressText(entry) {
  const label = PROGRESS_LABEL[entry?.kind] || String(entry?.kind ?? 'Progress');
  const round = Number.isInteger(entry?.round) ? ` (round ${entry.round})` : '';
  return `${label}${round}: ${isString(entry?.detail) ? entry.detail : ''}`;
}


function liveRow(db, key) {
  if (!key || !hasTable(db, 'live_activity')) return null;
  return db.prepare('SELECT started_at, updated_at, ended_at FROM live_activity WHERE key = ?').get(key) || null;
}

// Latest checkpoint of a lead thread (decoded) plus, when needed, the first one for startedAt.
async function latestCheckpoint(db, threadId) {
  if (!hasTable(db, 'checkpoints')) return null;
  const row = db.prepare(
    "SELECT type, checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1"
  ).get(threadId);
  if (!row) return null;
  const checkpoint = await SERDE.loadsTyped(row.type, row.checkpoint);
  return {
    values: checkpoint.channel_values || {},
    node: nodeOf(checkpoint.channel_versions),
    ts: isString(checkpoint.ts) ? checkpoint.ts : null,
  };
}

async function firstCheckpointTs(db, threadId) {
  const row = db.prepare(
    "SELECT type, checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id ASC LIMIT 1"
  ).get(threadId);
  if (!row) return null;
  const checkpoint = await SERDE.loadsTyped(row.type, row.checkpoint);
  return isString(checkpoint.ts) ? checkpoint.ts : null;
}

// Changed files of a worker: the engine-measured delta of its writer execution when one was
// measured (known), else the worker's own report.filesChanged (self-reported).
function changedFilesOf(db, taskId, report) {
  if (taskId && hasTable(db, 'writer_executions')) {
    const row = db.prepare('SELECT delta_json FROM writer_executions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId);
    let delta = null;
    try { delta = row?.delta_json ? JSON.parse(row.delta_json) : null; } catch (_) { delta = null; }
    if (delta?.known === true && Array.isArray(delta.changedPaths)) return delta.changedPaths.filter(isString).slice(0, FILES_SHOWN);
  }
  return Array.isArray(report?.filesChanged) ? report.filesChanged.filter(isString).slice(0, FILES_SHOWN) : [];
}

function itemView(db, { assignmentId, role, objective, state, report, taskId }) {
  const live = liveRow(db, taskId);
  return {
    assignmentId: assignmentId ?? null,
    role: role ?? null,
    objective: isString(objective) ? objective : null,
    state,
    summary: isString(report?.summary) ? report.summary : null,
    filesChanged: changedFilesOf(db, taskId, report),
    startedAt: live?.started_at ?? null,
    finishedAt: live?.ended_at ?? null,
  };
}

function batchItemOf(item, db) {
  const result = item?.result || null;
  // Same rule as the lead's outcome summary: only a completed worker has a report to read.
  const report = result && result.status === 'TASK_STATE_COMPLETED'
    ? parseWorkerReport(result.artifacts?.[0]?.text || result.text).report
    : null;
  let state = 'running';
  if (item?.state === 'pending') state = 'pending';
  else if (item?.state === 'finished') state = result?.status === 'TASK_STATE_COMPLETED' ? 'done' : 'failed';
  return itemView(db, {
    assignmentId: item?.assignmentId,
    role: item?.role,
    objective: item?.assignment?.objective,
    state,
    report,
    taskId: item?.taskId,
  });
}

const roundOf = (assignmentId) => {
  const match = /:r(\d+):/.exec(String(assignmentId || ''));
  return match ? Number(match[1]) : null;
};

// Outcomes of the most recent round, for a turn whose batch has already closed. Reconciliation and
// elided entries are not worker results and are skipped.
function lastRoundOutcomes(outcomes) {
  const entries = (Array.isArray(outcomes) ? outcomes : [])
    .filter((entry) => entry && !entry.kind && !entry.elided && roundOf(entry.assignmentId) !== null);
  if (entries.length === 0) return [];
  const last = Math.max(...entries.map((entry) => roundOf(entry.assignmentId)));
  return entries.filter((entry) => roundOf(entry.assignmentId) === last);
}

function outcomeItemOf(outcome, db) {
  return itemView(db, {
    assignmentId: outcome.assignmentId,
    role: outcome.role,
    objective: outcome.objective,
    state: outcome.status === 'TASK_STATE_COMPLETED' ? 'done' : 'failed',
    report: outcome.report && typeof outcome.report === 'object' ? outcome.report : null,
    taskId: outcome.taskId,
  });
}

// The pause the lead task is parked on, from the task metadata the server published when it parked
// (cleared on resume). Null unless the task is INPUT_REQUIRED with a pause object.
function parkedPause(row) {
  if (row?.status_state !== 'TASK_STATE_INPUT_REQUIRED' || !isString(row.metadata)) return null;
  try {
    const pause = JSON.parse(row.metadata)?.pause;
    return pause && typeof pause === 'object' && isString(pause.kind) ? pause : null;
  } catch (_) {
    return null;
  }
}

// Pauses the owner caused and can lift with a plain continue: a soft pause and a Stop (STOP-01).
const OWNER_PAUSE_KINDS = new Set(['owner_pause', 'stopped']);

// The lead task of a session (the latest turn) when it is parked on an owner pause or stop; else null.
function ownerPausedLead(db, contextId) {
  const leadIds = sessionLeadTaskIds(db, contextId);
  if (leadIds.length === 0) return null;
  const row = db.prepare('SELECT id, context_id, status_state, metadata FROM tasks WHERE id = ?').get(leadIds[leadIds.length - 1]);
  return OWNER_PAUSE_KINDS.has(parkedPause(row)?.kind) ? { taskId: row.id, contextId: row.context_id || contextId } : null;
}

// Projection of the session's current situation; null when the session does not exist.
// Reads only; the caller owns the database handle and keeps it open across the await.
// pauseRequestedRuns: lead task ids the project server reports with a pending owner pause request.
async function buildSituation(db, contextId, { pauseRequestedRuns = [] } = {}) {
  const leadIds = sessionLeadTaskIds(db, contextId);
  if (leadIds.length === 0) return null;
  const leadTaskId = leadIds[leadIds.length - 1];
  const lead = db.prepare('SELECT status_state, metadata FROM tasks WHERE id = ?').get(leadTaskId);
  const state = lead?.status_state ?? null;
  const checkpoint = await latestCheckpoint(db, leadTaskId);
  const values = checkpoint?.values || {};
  const node = checkpoint?.node ?? null;
  let phase = phaseOf(state, node);
  const pauseRequested = pauseRequestedRuns.includes(leadTaskId);
  // A request is "pausing" until the run parks; a parked owner pause or stop is "paused" whatever node it stopped at.
  if (OWNER_PAUSE_KINDS.has(parkedPause(lead)?.kind)) phase = 'paused';
  else if (pauseRequested && (phase === 'planning' || phase === 'working' || phase === 'verifying')) phase = 'pausing';
  const activity = liveRow(db, `lead:${leadTaskId}`);
  let startedAt = activity?.started_at ?? null;
  if (!startedAt && checkpoint) startedAt = await firstCheckpointTs(db, leadTaskId);
  const acceptance = values.acceptance && typeof values.acceptance === 'object' ? values.acceptance : null;
  return {
    contextId,
    leadTaskId,
    state,
    node,
    phase,
    round: Number.isInteger(values.round) ? values.round : null,
    budget: values.budget && typeof values.budget === 'object' ? { ...values.budget } : null,
    startedAt,
    updatedAt: activity?.updated_at ?? checkpoint?.ts ?? null,
    // A closed batch (null) leaves the finished turn's last round in the checkpoint outcomes.
    batch: values.batch?.items
      ? (Array.isArray(values.batch.items) ? values.batch.items : []).map((item) => batchItemOf(item, db))
      : lastRoundOutcomes(values.outcomes).map((outcome) => outcomeItemOf(outcome, db)),
    openDecisions: (Array.isArray(values.openDecisions) ? values.openDecisions : []).map((entry) => ({
      id: entry?.id ?? null,
      summary: isString(entry?.request?.question) ? entry.request.question : null,
    })),
    progress: (Array.isArray(values.progress) ? values.progress : []).slice(-PROGRESS_SHOWN).map((entry) => ({
      at: null,
      text: progressText(entry),
    })),
    acceptance: acceptance ? {
      status: acceptance.disposition ?? null,
      checks: (Array.isArray(acceptance.checks) ? acceptance.checks : []).map((check) => ({
        name: check?.id ?? null,
        status: check?.result ?? null,
      })),
    } : null,
    nextSteps: phase === 'done' ? nextStepsOf(values.result?.text ?? values.text) : null,
  };
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const options = {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      // Read-only: a status refresh must not take or write the index lock.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    };
    execFile('git', args, options, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

// `git status --porcelain=v1 -z`: "XY path" entries; a rename or copy is followed by its origin path.
function parsePorcelain(text) {
  const parts = text.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push({ path: entry.slice(3), status: code.trim() });
    if (code[0] === 'R' || code[0] === 'C') i += 1;
  }
  return files;
}

function parseShortstat(text) {
  const count = (pattern) => {
    const match = pattern.exec(text);
    return match ? Number(match[1]) : 0;
  };
  return {
    files: count(/(\d+) files? changed/),
    insertions: count(/(\d+) insertions?\(\+\)/),
    deletions: count(/(\d+) deletions?\(-\)/),
  };
}

// Git status of a project directory. A directory that is not a repository gives available false.
// A timeout or a missing git binary rejects, so the route can answer with an error status.
async function gitStatus(cwd) {
  if (!isString(cwd) || !fs.existsSync(cwd)) return { available: false };
  try {
    const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.trim() !== 'true') return { available: false };
  } catch (error) {
    if (error.code === 128) return { available: false };
    throw error;
  }
  const branch = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
  const head = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null;
  const files = parsePorcelain(await git(cwd, ['status', '--porcelain=v1', '-z']));
  // Without a commit there is no HEAD to diff against.
  const diffstat = head ? parseShortstat(await git(cwd, ['diff', '--shortstat', 'HEAD'])) : null;
  return { available: true, branch, head, files, diffstat };
}

module.exports = { buildSituation, ownerPausedLead, gitStatus, phaseOf, nodeOf, nextStepsOf, parsePorcelain, parseShortstat };
