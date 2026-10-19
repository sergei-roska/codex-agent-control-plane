'use strict';

// The partial-result ledger: when the lead finishes with goalAchieved false it may list every
// checkpoint with an honest status instead of a free-text blocker list.

const LEDGER_STATUSES = ['accepted', 'blocked', 'not_started'];
const MAX_LEDGER_ENTRIES = 40;
const MAX_LEDGER_ID = 160;
const MAX_LEDGER_REASON = 1000;
const MAX_LEDGER_EVIDENCE = 10;
const MAX_LEDGER_EVIDENCE_CHARS = 300;
// Acceptance dispositions that mean the run's own checks or gates did not pass.
const FAILED_DISPOSITIONS = ['rejected', 'unverifiable'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Normalize a lead-supplied ledger. Returns { ledger } (null for no ledger) or { error }.
 * Rules: unique ids; accepted needs evidence; blocked and not_started need a reason; at least one
 * entry is not accepted (a fully accepted ledger is goalAchieved true, not a partial result).
 */
function normalizeLedger(value) {
  if (value === null || value === undefined) return { ledger: null };
  if (!Array.isArray(value)) return { error: 'checkpoints must be an array or null' };
  if (value.length === 0) return { ledger: null };
  if (value.length > MAX_LEDGER_ENTRIES) return { error: `checkpoints may list at most ${MAX_LEDGER_ENTRIES} entries` };
  const seen = new Set();
  const ledger = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return { error: 'Each checkpoint must be an object with id, status, reason, and evidence' };
    const keys = Object.keys(entry);
    if (keys.length !== 4 || !['id', 'status', 'reason', 'evidence'].every((key) => keys.includes(key))) {
      return { error: 'Each checkpoint must contain exactly id, status, reason, and evidence' };
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id || id.length > MAX_LEDGER_ID) return { error: `checkpoint id must be a non-empty string of at most ${MAX_LEDGER_ID} characters` };
    if (seen.has(id)) return { error: `checkpoint ${id} is listed twice` };
    seen.add(id);
    if (!LEDGER_STATUSES.includes(entry.status)) return { error: `checkpoint ${id} status must be one of ${LEDGER_STATUSES.join(', ')}` };
    if (typeof entry.reason !== 'string' || entry.reason.length > MAX_LEDGER_REASON) return { error: `checkpoint ${id} reason must be a string of at most ${MAX_LEDGER_REASON} characters` };
    if (!Array.isArray(entry.evidence) || entry.evidence.length > MAX_LEDGER_EVIDENCE
      || entry.evidence.some((item) => typeof item !== 'string' || item.length > MAX_LEDGER_EVIDENCE_CHARS)) {
      return { error: `checkpoint ${id} evidence must be an array of at most ${MAX_LEDGER_EVIDENCE} short strings` };
    }
    const reason = entry.reason.trim();
    const evidence = entry.evidence.map((item) => item.trim()).filter(Boolean);
    if (entry.status === 'accepted' && evidence.length === 0) return { error: `accepted checkpoint ${id} needs evidence (for example an assignmentId or a check id)` };
    if (entry.status !== 'accepted' && !reason) return { error: `${entry.status} checkpoint ${id} needs a reason` };
    ledger.push({ id, status: entry.status, reason, evidence });
  }
  if (ledger.every((entry) => entry.status === 'accepted')) {
    return { error: 'A partial ledger needs at least one blocked or not_started checkpoint; when every checkpoint is accepted, finish with goalAchieved true' };
  }
  return { ledger };
}

/** Checkpoint ids a partial finish does not need review receipts for. */
function unreviewedIds(ledger) {
  return new Set((Array.isArray(ledger) ? ledger : []).filter((entry) => entry.status !== 'accepted').map((entry) => entry.id));
}

/**
 * The ledger as reported at the end of the run. Checkpoints the owner deferred are blocked whatever
 * the lead said, and a run whose acceptance did not pass never reports an accepted checkpoint.
 */
function finalizeLedger(ledger, { blocked = [], acceptance = null } = {}) {
  const byId = new Map();
  for (const entry of Array.isArray(ledger) ? ledger : []) byId.set(entry.id, { ...entry, evidence: [...entry.evidence] });
  for (const block of blocked) {
    const prior = byId.get(block.checkpointId);
    byId.set(block.checkpointId, {
      id: block.checkpointId,
      status: 'blocked',
      reason: block.reason,
      evidence: prior?.evidence?.length ? prior.evidence : [block.decisionId].filter(Boolean),
    });
  }
  // A pending review gate comes from checkpoints the ledger reports as not accepted, so it does not
  // take back the accepted ones (they passed the gate when the finish was admitted).
  const blocking = (Array.isArray(acceptance?.issues) ? acceptance.issues : []).filter((issue) => issue && issue.advisory !== true && issue.result !== 'PASS');
  const onlyReviewGate = blocking.length > 0 && blocking.every((issue) => issue.code === 'review_gate_pending');
  const failed = FAILED_DISPOSITIONS.includes(acceptance?.disposition) && !onlyReviewGate;
  return [...byId.values()].map((entry) => {
    if (!failed || entry.status !== 'accepted') return entry;
    const detail = `acceptance ${acceptance.disposition}: this checkpoint cannot be reported as accepted`;
    return { ...entry, status: 'blocked', reason: entry.reason ? `${detail}; lead's reason: ${entry.reason}` : detail };
  });
}

/** Text block for the A2A result. */
function formatLedger(ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0) return '';
  const count = (status) => ledger.filter((entry) => entry.status === status).length;
  const lines = [`Partial result: ${count('accepted')} accepted, ${count('blocked')} blocked, ${count('not_started')} not started (goal not achieved)`];
  for (const entry of ledger) {
    const evidence = entry.evidence.length > 0 ? ` [evidence: ${entry.evidence.join(', ')}]` : '';
    lines.push(`- ${entry.id}: ${entry.status}${entry.reason ? ` - ${entry.reason}` : ''}${evidence}`);
  }
  return lines.join('\n');
}

module.exports = {
  LEDGER_STATUSES,
  MAX_LEDGER_ENTRIES,
  MAX_LEDGER_ID,
  MAX_LEDGER_REASON,
  MAX_LEDGER_EVIDENCE,
  FAILED_DISPOSITIONS,
  normalizeLedger,
  unreviewedIds,
  finalizeLedger,
  formatLedger,
};
