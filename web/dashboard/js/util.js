// --- DOM + FORMAT HELPERS (server strings are untrusted: always textContent) ---
function h(tag, opts, children) {
  const node = document.createElement(tag);
  const o = opts || {};
  if (o.class) node.className = o.class;
  if (o.text !== undefined && o.text !== null) node.textContent = String(o.text);
  if (o.title) node.title = o.title;
  if (o.attrs) Object.keys(o.attrs).forEach(k => node.setAttribute(k, o.attrs[k]));
  if (o.on) Object.keys(o.on).forEach(k => node.addEventListener(k, o.on[k]));
  (children || []).forEach(c => { if (c) node.appendChild(c); });
  return node;
}

function cssToken(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[^A-Za-z0-9_-]/g, '_');
}

function formatAbsTime(iso) {
  if (!iso) return 'unavailable';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function formatClock(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleTimeString();
}

function formatRelative(iso) {
  if (!iso) return 'unknown';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 48) return hr + 'h ago';
  return Math.round(hr / 24) + 'd ago';
}

function shortTaskId(card) {
  const id = card && card.runtimeTaskRef && card.runtimeTaskRef.taskId;
  return id ? String(id).slice(0, 8) : 'unknown';
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Unknown values render as "unavailable", never as 0.
function formatMaybeNumber(v) {
  return isNumber(v) ? v.toLocaleString() : 'unavailable';
}

function formatMaybeDuration(ms) {
  if (!isNumber(ms)) return 'unavailable';
  if (ms < 1000) return ms + ' ms';
  const s = ms / 1000;
  if (s < 120) return s.toFixed(1) + ' s';
  return (s / 60).toFixed(1) + ' min';
}

// --- M3: ticket/run vocabulary shared by the board and the ticket detail ---
const TICKET_STATUS_LABELS = {
  backlog: 'Draft', pending: 'Pending', in_progress: 'In progress', paused: 'Needs attention',
  waiting_human: 'Needs attention', blocked: 'Needs attention', done: 'Done', cancelled: 'Cancelled'
};
const WAIT_REASON_LABELS = {
  human_decision: 'Waiting for your decision', human_review: 'Waiting for your review', budget: 'Budget limit reached', auth_required: 'Sign in to Codex',
  restart: 'Interrupted by a restart', dependency: 'Prerequisite not met', execution_error: 'Execution error',
  writer_unresolved: 'Unresolved writer state', operator_pause: 'Paused by operator', run_stopped: 'Run stopped'
};
const RUN_PHASE_LABELS = {
  queued: 'Queued', intake: 'Intake', awaiting_answer: 'Awaiting your answer', branch: 'Branch',
  engineering: 'Engineering', candidate: 'Candidate', settled: 'Settled'
};

// Unknown stored statuses keep their raw text and read as needing attention; never coerced to done.
function ticketStatusLabel(status) {
  if (!status) return 'Unknown';
  return TICKET_STATUS_LABELS[status] || String(status);
}

function ticketStatusClass(status) {
  return TICKET_STATUS_LABELS[status] ? cssToken(status) : 'blocked';
}

// Why a ticket in the Needs attention column is there. Input: { status, waitReason, phase }
// (a board card passes ticketStatus; a ticket passes status). Returns null for unknown combinations
// so the caller keeps the generic presentation.
const ATTENTION_PROBLEM_REASONS = ['execution_error', 'writer_unresolved', 'dependency', 'run_stopped'];
const ATTENTION_PAUSE_REASONS = ['budget', 'auth_required', 'restart', 'operator_pause'];
const ATTENTION_PRESENTATION = {
  review: { label: 'Ready for review', cls: 'attn-review' },
  answer: { label: 'Needs your answer', cls: 'attn-answer' },
  paused: { label: 'Paused', cls: 'attn-paused' },
  problem: { label: 'Blocked', cls: 'attn-problem' }
};

function attentionKind(ticket) {
  const t = ticket || {};
  const status = t.status || t.ticketStatus;
  const reason = t.waitReason || '';
  // An interrupted run leaves its ticket blocked; a pause reason still reads as a pause.
  if (status === 'blocked') return ATTENTION_PAUSE_REASONS.includes(reason) ? 'paused' : 'problem';
  if (status === 'paused') return ATTENTION_PROBLEM_REASONS.includes(reason) ? 'problem' : 'paused';
  if (status === 'waiting_human') {
    if (reason === 'human_review') return 'review';
    if (ATTENTION_PROBLEM_REASONS.includes(reason)) return 'problem';
    if (ATTENTION_PAUSE_REASONS.includes(reason)) return 'paused';
    if (!reason || reason === 'human_decision' || reason === 'intake_clarification' || t.phase === 'awaiting_answer') return 'answer';
  }
  return null;
}

function attentionPresentation(ticket) {
  const kind = attentionKind(ticket);
  return kind ? ATTENTION_PRESENTATION[kind] : null;
}

function waitReasonLabel(reason) {
  if (!reason) return '';
  return WAIT_REASON_LABELS[reason] || String(reason);
}

function runPhaseLabel(phase) {
  if (!phase) return '';
  return RUN_PHASE_LABELS[phase] || String(phase);
}

// tone: ok (green) only for accepted, or not_required on a read-only audit plan.
function dispositionInfo(disposition, classification) {
  const d = String(disposition === null || disposition === undefined ? '' : disposition);
  if (d === 'accepted') return { label: 'Accepted', tone: 'ok', passing: true };
  if (d === 'not_required') {
    return classification === 'audit'
      ? { label: 'Not required (read-only audit)', tone: 'ok', passing: true }
      : { label: 'Not required', tone: 'neutral', passing: false };
  }
  if (d === 'rejected') return { label: 'Rejected', tone: 'bad', passing: false };
  if (d === 'unverifiable' || d === 'unverified') return { label: 'Unverified', tone: 'warn', passing: false };
  return { label: d || 'Unknown', tone: 'warn', passing: false };
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : 'unknown';
}
