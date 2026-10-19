'use strict';

const crypto = require('node:crypto');
const { canonicalRoleId } = require('./role-names');

const MAX_OBSERVATIONS = 24;
const MAX_EPISODES = 24;
const MAX_BATCH_KEYS = 12;
const MAX_TEXT = 300;
const WARNING_AFTER = 3;
// Second guard: the same review or investigation of the same checkpoint and target recurring with no
// implementation in between, whatever the report text says.
const RECURRENCE_PAUSE_AFTER = 3;
const MAX_RECURRENCE = 24;
const RECURRENCE_CLASSES = Object.freeze({
  verifier: 'verify',
  auditor: 'audit',
  explorer: 'investigate',
  scout: 'investigate',
  architect: 'investigate',
});

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function normalizeEvidenceText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b(?:assignment|attempt|task|run|thread|context)[-_ ]?id\s*[:=]?\s*[a-z0-9:_-]+/g, '<id>')
    .replace(/\b\d{4}-\d\d-\d\d(?:t\d\d:\d\d:\d\d(?:\.\d+)?z?)?\b/gi, '<time>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIntent(value) {
  return normalizeEvidenceText(value);
}

function sortedStrings(values, limit = 20) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => boundedText(value)))].sort().slice(0, limit);
}

function completeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map(normalizeEvidenceText))].sort();
}

function completePaths(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().replace(/\\/g, '/')))].sort();
}

function reportEvidenceIdentity(report, { role = 'unknown' } = {}) {
  if (!report || typeof report !== 'object') return null;
  const research = ['explorer', 'scout', 'architect'].includes(String(role).toLowerCase());
  const checks = (Array.isArray(report.checks) ? report.checks : []).map((check) => ({
    command: normalizeEvidenceText(check.command),
    result: String(check.result || 'unknown').toLowerCase(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const inspected = completePaths(report.filesInspected);
  const identityFor = (reportFailed) => {
    const findings = reportFailed ? [] : completeStrings(report.risks);
    const researchSummary = !reportFailed && research
      ? completeStrings(String(report.summary || '').split(/[.!?\n]+/).filter((sentence) => /(?:\/|\.[a-z]{1,8}\b|\b\d+\b|\b(?:error|exports?|returns?|requires?|contains?|calls?|sets?|reads?|writes?)\b)/i.test(sentence)
        && !/^\s*(?:i |we )?(?:made progress|completed|investigated|reviewed|checked|explored)\b/i.test(sentence)))
      : [];
    if (inspected.length === 0 && checks.length === 0 && findings.length === 0 && researchSummary.length === 0) return null;
    return sha256({ inspected, checks, findings, researchSummary });
  };
  return {
    success: identityFor(false),
    failed: identityFor(true),
  };
}

// Recurrence key: (checkpoint or objective, role class, target identity). Report text and file lists
// are deliberately not part of it. Writable roles have no class: they are implementation, not recurrence.
function recurrenceOf({ item, outcome, role, contentIdentity }) {
  const roleClass = RECURRENCE_CLASSES[canonicalRoleId(role)] || null;
  if (!roleClass) return null;
  const assignment = item.assignment || {};
  const objectiveKey = `objective:${sha256(normalizeIntent(assignment.objective || outcome.objective)).slice(0, 24)}`;
  const declared = typeof assignment.review?.checkpointId === 'string' && assignment.review.checkpointId
    ? assignment.review.checkpointId : null;
  // Plain research has no checkpoint: repeated explorer rounds stay with the evidence-identity guard.
  if (!declared && roleClass === 'investigate') return null;
  const checkpoint = declared || objectiveKey;
  const captured = item.reviewTarget?.known === true && typeof item.reviewTarget.identity === 'string'
    ? item.reviewTarget.identity : null;
  const target = captured || (typeof contentIdentity === 'string' ? contentIdentity : null) || objectiveKey;
  return {
    key: sha256({ checkpoint, roleClass, target }),
    roleClass,
    checkpoint: boundedText(checkpoint),
  };
}

function makeObservation({ item = {}, outcome = {}, contentIdentity = null, implemented = false } = {}) {
  const assignment = item.assignment || {};
  const report = outcome.report || {};
  const role = String(outcome.role || item.role || 'unknown').toLowerCase();
  const allowedFiles = completePaths(item.contract?.allowedFiles || assignment.allowedFiles);
  const review = assignment.review || {};
  const checksRequested = completeStrings(assignment.checks);
  const failureCodes = sortedStrings([
    ...(outcome.boundary?.results || []).filter((entry) => entry.result !== 'PASS').map((entry) => entry.code),
    outcome.failureKind,
    outcome.failure?.code,
    ['rejected', 'failed', 'stale', 'inconclusive'].includes(String(outcome.reviewResult?.status || '').toLowerCase())
      ? `review_${String(outcome.reviewResult.status).toLowerCase()}` : null,
  ]).map((code) => code.toLowerCase());
  const rejectedReview = ['rejected', 'failed', 'stale', 'inconclusive'].includes(String(outcome.reviewResult?.status || '').toLowerCase());
  const failed = failureCodes.length > 0 || rejectedReview
    || ['failed', 'blocked'].includes(String(report.outcome || '').toLowerCase());
  const reportIdentities = outcome.loopEvidenceIdentity && typeof outcome.loopEvidenceIdentity === 'object'
    ? outcome.loopEvidenceIdentity
    : reportEvidenceIdentity(report, { role, failed });
  const reportIdentity = reportIdentities && typeof reportIdentities === 'object'
    ? reportIdentities[failed ? 'failed' : 'success'] || null
    : (!failed && typeof reportIdentities === 'string' ? reportIdentities : null);
  const work = review.kind ? {
    role,
    allowedFiles,
    review: {
      kind: review.kind,
      checkpointId: typeof review.checkpointId === 'string' ? review.checkpointId : null,
      paths: completePaths(review.paths),
    },
  } : {
    role,
    intent: failed ? null : normalizeIntent(assignment.objective || outcome.objective),
    allowedFiles,
    checksRequested,
    review: { kind: null, paths: completePaths(review.paths) },
  };
  const evidence = {
    reportIdentity,
    reviewStatus: outcome.reviewResult?.status || null,
    reviewVerdict: outcome.reviewResult?.verdict || null,
    outcome: report.outcome || outcome.status || 'unknown',
    failureCodes,
    contentIdentity: typeof contentIdentity === 'string' ? contentIdentity : null,
    contentKnown: typeof contentIdentity === 'string',
  };
  const workKey = sha256(work);
  const evidenceKey = sha256(evidence);
  const description = `${role}: ${work.intent || 'same scoped work'}${failureCodes.length ? ` (${failureCodes.join(', ')})` : ''}`.slice(0, MAX_TEXT);
  return {
    workKey,
    evidenceKey,
    description,
    assignmentId: outcome.assignmentId || item.assignmentId || null,
    attemptId: outcome.attemptId || item.attemptId || null,
    recurrence: recurrenceOf({ item, outcome, role, contentIdentity }),
    implemented: implemented === true,
    unknown: !reportIdentity && !evidence.contentKnown && !evidence.contentIdentity,
  };
}

function emptyLoopGuard() {
  return { observations: [], episodes: [], warnings: [], warning: null, lastRound: null };
}

// Counts rounds per recurrence key. A batch that integrated a change resets every count (the target
// moved); the same batch's reviews then count from one.
function advanceRecurrence(previous, round, observations) {
  const batch = Array.isArray(observations) ? observations.filter((entry) => entry && typeof entry === 'object') : [];
  let entries = batch.some((entry) => entry.implemented === true) ? []
    : (Array.isArray(previous) ? previous.slice(-MAX_RECURRENCE).map((entry) => ({
      ...entry,
      rounds: Array.isArray(entry.rounds) ? [...entry.rounds] : [],
      references: Array.isArray(entry.references) ? [...entry.references] : [],
    })) : []);
  const keyed = new Map();
  for (const entry of batch.slice(0, MAX_BATCH_KEYS)) {
    const recurrence = entry.recurrence;
    if (recurrence && typeof recurrence.key === 'string' && !keyed.has(recurrence.key)) keyed.set(recurrence.key, entry);
  }
  let pause = null;
  for (const [key, entry] of keyed) {
    let record = entries.find((candidate) => candidate.key === key);
    if (!record) {
      record = { key, roleClass: entry.recurrence.roleClass, checkpoint: entry.recurrence.checkpoint, count: 0, rounds: [], references: [] };
      entries.push(record);
    }
    record.count = Math.min(record.count + 1, 999999);
    record.rounds = [...record.rounds, round].slice(-10);
    if (entry.assignmentId || entry.attemptId) record.references = [...record.references, entry.attemptId || entry.assignmentId].slice(-10);
    if (record.count >= RECURRENCE_PAUSE_AFTER && !pause) {
      pause = {
        recurrence: true,
        description: `${record.roleClass} of ${record.checkpoint}`,
        attempts: record.count,
        rounds: [...record.rounds],
        checkpoint: record.checkpoint,
        roleClass: record.roleClass,
        references: record.references.map((reference) => ({ attemptId: reference })),
      };
    }
  }
  entries = entries.slice(-MAX_RECURRENCE);
  return { entries, pause };
}

function observeLoopGuard(previous, round, observations) {
  const state = previous && typeof previous === 'object' ? previous : emptyLoopGuard();
  const history = Array.isArray(state.observations) ? state.observations.slice(-MAX_OBSERVATIONS) : [];
  const episodes = Array.isArray(state.episodes) ? state.episodes.slice(-MAX_EPISODES).map((entry) => ({
    ...entry,
    attempts: Array.isArray(entry.attempts) ? [...entry.attempts] : [],
  })) : [];
  if (!Number.isInteger(round) || round < 1 || state.lastRound === round) return state;

  const keys = [...new Map((Array.isArray(observations) ? observations : [])
    .filter((entry) => entry && typeof entry.workKey === 'string' && typeof entry.evidenceKey === 'string')
    .slice(0, MAX_BATCH_KEYS)
    .map((entry) => [`${entry.workKey}:${entry.evidenceKey}`, entry])).values()];
  let warnings = Array.isArray(state.warnings) ? state.warnings.slice(-MAX_EPISODES)
    : (state.warning ? [state.warning] : []);
  const knownEvidence = new Map();
  for (const episode of episodes) {
    if (!knownEvidence.has(episode.workKey)) knownEvidence.set(episode.workKey, new Set());
    knownEvidence.get(episode.workKey).add(episode.evidenceKey);
  }
  const novelWorkKeys = new Set(keys
    .filter((entry) => !knownEvidence.get(entry.workKey)?.has(entry.evidenceKey))
    .map((entry) => entry.workKey));
  warnings = warnings.filter((entry) => !novelWorkKeys.has(entry.workKey));
  const priorWarningKeys = new Set(warnings.map((entry) => `${entry.workKey}:${entry.evidenceKey}`));
  let pause = null;
  const nextEpisodes = [...episodes];
  for (const entry of keys) {
    let episode = nextEpisodes.find((candidate) => candidate.workKey === entry.workKey && candidate.evidenceKey === entry.evidenceKey);
    const seenEvidence = new Set(nextEpisodes.filter((candidate) => candidate.workKey === entry.workKey).map((candidate) => candidate.evidenceKey));
    if (!seenEvidence.has(entry.evidenceKey)) {
      warnings = warnings.filter((candidate) => candidate.workKey !== entry.workKey);
      episode = null;
    }
    if (!episode) {
      episode = { workKey: entry.workKey, evidenceKey: entry.evidenceKey, count: 0, description: entry.description || 'same scoped work', warned: false, attempts: [] };
      nextEpisodes.push(episode);
    }
    episode.count = Math.min(episode.count + 1, 999999);
    episode.description = entry.description || episode.description;
    if (entry.assignmentId || entry.attemptId) episode.attempts = [...episode.attempts, {
      assignmentId: entry.assignmentId || null,
      attemptId: entry.attemptId || null,
      round,
    }].slice(-3);
    const warningKey = `${entry.workKey}:${entry.evidenceKey}`;
    const activeWarning = warnings.some((candidate) => candidate.workKey === entry.workKey && candidate.evidenceKey === entry.evidenceKey);
    const hasNovelEvidenceThisRound = novelWorkKeys.has(entry.workKey);
    const wasWarned = !hasNovelEvidenceThisRound && priorWarningKeys.has(warningKey) && activeWarning && episode.warned === true;
    if (wasWarned && episode.count > WARNING_AFTER) {
      pause = {
        description: episode.description,
        attempts: episode.count,
        unchangedEvidence: true,
        references: episode.attempts,
      };
    } else if (!hasNovelEvidenceThisRound && episode.count >= WARNING_AFTER && !activeWarning) {
      episode.warned = true;
      warnings.push({
        workKey: entry.workKey,
        evidenceKey: entry.evidenceKey,
        description: episode.description,
        attempts: episode.count,
        unchangedEvidence: true,
        references: episode.attempts,
      });
      warnings = warnings.slice(-MAX_EPISODES);
    }
  }
  const normalizedEpisodes = nextEpisodes.slice(-MAX_EPISODES).map((entry) => ({ ...entry }));
  const recurrence = advanceRecurrence(state.recurrence, round, observations);
  if (!pause) pause = recurrence.pause;
  return {
    observations: [...history, {
      round,
      keys: keys.map(({ workKey, evidenceKey, assignmentId, attemptId }) => ({ workKey, evidenceKey, assignmentId, attemptId })),
    }].slice(-MAX_OBSERVATIONS),
    episodes: normalizedEpisodes,
    warnings,
    warning: warnings[0] || null,
    recurrence: recurrence.entries,
    lastRound: round,
    ...(pause ? { pause } : {}),
  };
}

function resetLoopGuard() {
  return emptyLoopGuard();
}

function warningText(warning) {
  if (!warning) return '';
  const warnings = Array.isArray(warning) ? warning
    : Array.isArray(warning.warnings) ? warning.warnings
      : warning.warning && typeof warning.warning === 'object' ? [warning.warning]
        : [warning];
  return warnings.filter((entry) => entry && typeof entry.description === 'string').map((entry) => {
    const references = (entry.references || []).map((item) => item.attemptId || item.assignmentId).filter(Boolean).join(', ');
    return `Loop warning: the same scoped work repeated ${entry.attempts} times with unchanged evidence: ${entry.description}${references ? ` (attempts: ${references})` : ''}. Choose a concrete different hypothesis or method, or use the existing findings; another unchanged recurrence will pause the run.`;
  }).join('\n');
}

module.exports = {
  MAX_OBSERVATIONS,
  MAX_EPISODES,
  MAX_BATCH_KEYS,
  WARNING_AFTER,
  RECURRENCE_PAUSE_AFTER,
  emptyLoopGuard,
  makeObservation,
  reportEvidenceIdentity,
  observeLoopGuard,
  resetLoopGuard,
  warningText,
};
