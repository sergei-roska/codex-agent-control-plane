// --- M2: DIRECT TICKET DETAIL (GET /tickets/:id, revisions, events; Edit and Cancel commands) ---
const TR_EVENT_LIMIT = 200;
const TR_REF_LABELS = [
  { key: 'jiraIssues', label: 'Jira issues' },
  { key: 'jiraParents', label: 'Jira parents / epic' },
  { key: 'confluence', label: 'Confluence' },
  { key: 'figma', label: 'Figma' },
  { key: 'links', label: 'Other links' }
];

// viewRevisionId is null while the current revision is shown.
// cmds holds one retry-safe command slot per action; busy disables the action buttons while one is in flight.
const tr = { ticketId: null, detail: null, events: null, eventsError: null, viewRevisionId: null, viewRevision: null, cmds: {}, busy: false, pollSig: null, loadSeq: 0,
  source: null, sourceError: null, sourceLoading: false, sourceHistory: [], sourceHistoryError: null, sourceHistoryBefore: null, sourceHistoryLoading: false,
  submitError: '', loadFailed: false,
  sourceSnapshot: null, sourceSnapshotId: null, sourceSnapshotLoading: false, sourceMessage: '', sourceBusy: false, sourceCmds: {} };

function isTicketRecordOpen() {
  const modal = document.getElementById('modal-ticket-record');
  return Boolean(tr.ticketId && modal && modal.classList.contains('open'));
}

function trText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  return el;
}

function trClear(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = '';
  return el;
}

function closeTicketRecord() {
  tr.ticketId = null;
  tr.loadSeq += 1;
  trrReset();
  const modal = document.getElementById('modal-ticket-record');
  if (modal) modal.classList.remove('open');
  if (typeof saveDashboardNavigation === 'function') saveDashboardNavigation();
}

function openTicketRecord(ticketId) {
  const modal = document.getElementById('modal-ticket-record');
  if (!modal) return;
  tr.ticketId = ticketId;
  tr.detail = null;
  tr.events = null;
  tr.eventsError = null;
  tr.viewRevisionId = null;
  tr.viewRevision = null;
  tr.cmds = {};
  tr.submitError = '';
  tr.busy = false;
  tr.pollSig = null;
  tr.loadFailed = false;
  trrReset();
  tr.source = null; tr.sourceError = null; tr.sourceLoading = true;
  tr.sourceHistory = []; tr.sourceHistoryError = null; tr.sourceHistoryBefore = null; tr.sourceHistoryLoading = false;
  tr.sourceSnapshot = null; tr.sourceSnapshotId = null; tr.sourceSnapshotLoading = false; tr.sourceMessage = ''; tr.sourceBusy = false; tr.sourceCmds = {};
  trText('tr-title', 'Loading...');
  trText('tr-note', 'Loading ticket...');
  trText('tr-action-error', '');
  trClear('tr-actions');
  modal.classList.add('open');
  if (typeof saveDashboardNavigation === 'function') saveDashboardNavigation();
  loadTicketRecord();
}

async function loadTicketRecord() {
  const ticketId = tr.ticketId;
  if (!ticketId) return;
  const seq = ++tr.loadSeq;
  const base = '/tickets/' + encodeURIComponent(ticketId);
  const settled = await Promise.allSettled([
    apiGet(base),
    apiGet(base + '/events', { params: { limit: TR_EVENT_LIMIT } })
  ]);
  if (seq !== tr.loadSeq || ticketId !== tr.ticketId) return;
  const [detail, events] = settled;
  if (detail.status === 'rejected') {
    tr.loadFailed = true;
    trApplyLock();
    trText('tr-title', 'Ticket unavailable');
    trText('tr-note', detail.reason && detail.reason.status === 404
      ? 'This ticket no longer exists: ' + detail.reason.message
      : 'Could not load the ticket: ' + (detail.reason && detail.reason.message));
    return;
  }
  tr.loadFailed = false;
  tr.detail = detail.value;
  tr.viewRevisionId = null;
  tr.viewRevision = null;
  tr.events = events.status === 'fulfilled' && Array.isArray(events.value.events) ? events.value.events : null;
  tr.eventsError = events.status === 'rejected' ? events.reason.message : null;
  tr.pollSig = null;
  renderTicketRecord();
  if (tr.detail && tr.detail.ticket && tr.detail.ticket.source === 'jira') loadTicketSource(ticketId, seq);
  else { tr.sourceLoading = false; renderRecordSource(); }
  await trrFetchRun(ticketId, seq);
}

// Mutating controls inside the ticket modal. Read-only buttons (tabs, revisions, copy, load more) stay live.
const TR_MUTATING_SELECTOR = '#tr-actions button, #tr-source-actions button, #tr-run-head button, #tr-run-decisions button, #tr-run-delivery button';

// A reason string while protected actions must not be offered on data that could not be refreshed.
function trLockReason() {
  if (typeof Conn !== 'undefined' && Conn.status !== 'connected') {
    return (Conn.status === 'unpaired' ? 'Session is not paired' : 'Orchestrator is not connected') + '; ticket data may be stale. Actions are disabled.';
  }
  if (tr.loadFailed) return 'The ticket could not be refreshed. Actions are disabled until it reloads.';
  return '';
}

function trApplyLock() {
  if (typeof document === 'undefined') return;
  const reason = trLockReason();
  let note = document.getElementById('tr-lock-note');
  if (!note && reason) {
    const anchor = document.getElementById('tr-note');
    if (anchor && anchor.parentNode) {
      note = document.createElement('div');
      note.id = 'tr-lock-note';
      note.className = 'detail-note';
      note.setAttribute('role', 'status');
      anchor.parentNode.insertBefore(note, anchor.nextSibling);
    }
  }
  if (note) {
    if (note.textContent !== reason) note.textContent = reason;
    note.style.display = reason ? '' : 'none';
  }
  document.querySelectorAll(TR_MUTATING_SELECTOR).forEach(btn => {
    const data = btn.dataset;
    if (reason) {
      if (data.trLocked !== '1') {
        data.trLocked = '1';
        data.trWasDisabled = btn.disabled ? '1' : '';
        data.trTitle = btn.title || '';
      }
      if (!btn.disabled) btn.disabled = true;
      if (btn.getAttribute('aria-disabled') !== 'true') btn.setAttribute('aria-disabled', 'true');
      if (btn.title !== reason) btn.title = reason;
    } else if (data.trLocked === '1') {
      data.trLocked = '';
      btn.disabled = data.trWasDisabled === '1';
      if (!btn.disabled) btn.removeAttribute('aria-disabled');
      btn.title = data.trTitle || '';
    }
  });
}

// Renders rebuild the buttons, so the lock is re-applied to whatever the modal contains.
(function initTicketRecordLock() {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
  const modal = document.getElementById('modal-ticket-record');
  if (modal) new MutationObserver(() => trApplyLock()).observe(modal, { childList: true, subtree: true });
})();

function trSourceSummary() {
  if (!tr.source) return null;
  return tr.source.source && typeof tr.source.source === 'object' ? tr.source.source : tr.source;
}

async function loadTicketSource(ticketId, seq) {
  if (!ticketId || seq !== tr.loadSeq) return;
  tr.sourceLoading = true;
  renderRecordSource();
  const base = '/tickets/' + encodeURIComponent(ticketId);
  const settled = await Promise.allSettled([
    apiGet(base + '/source'),
    apiGet(base + '/source/history', { params: { limit: 50 } })
  ]);
  if (seq !== tr.loadSeq || ticketId !== tr.ticketId) return;
  const [source, history] = settled;
  tr.sourceLoading = false;
  if (source.status === 'fulfilled') { tr.source = source.value; tr.sourceError = null; }
  else if (source.reason && source.reason.status === 404) { tr.source = null; tr.sourceError = null; }
  else { tr.source = null; tr.sourceError = 'Source details are unavailable.'; }
  if (history.status === 'fulfilled') {
    tr.sourceHistory = Array.isArray(history.value && history.value.snapshots) ? history.value.snapshots : [];
    tr.sourceHistoryBefore = history.value && history.value.nextBeforeOrdinal;
    tr.sourceHistoryError = null;
  } else if (history.reason && history.reason.status === 404) {
    tr.sourceHistory = []; tr.sourceHistoryBefore = null; tr.sourceHistoryError = null;
  } else tr.sourceHistoryError = 'Source history is unavailable.';
  const summary = trSourceSummary();
  if (!tr.sourceSnapshotId && summary) tr.sourceSnapshotId = summary.latestAvailableSnapshotId || summary.latestSnapshotId || null;
  renderRecordSource();
}

function trSourceCommandId(slot, payload) {
  const sig = JSON.stringify(payload);
  const held = tr.sourceCmds[slot];
  if (!held || held.sig !== sig) tr.sourceCmds[slot] = { sig, commandId: newCommandId() };
  return tr.sourceCmds[slot].commandId;
}

async function refreshTicketSource() {
  const ticketId = tr.ticketId;
  const seq = tr.loadSeq;
  const ticket = tr.detail && tr.detail.ticket;
  if (!ticketId || !ticket || tr.sourceBusy) return;
  const payload = { expectedVersion: ticket.version };
  const body = Object.assign({ commandId: trSourceCommandId('refresh', payload) }, payload);
  tr.sourceBusy = true; tr.sourceMessage = 'Refreshing source context...';
  renderRecordSource();
  let refreshApplied = false;
  try {
    const result = await apiPost('/tickets/' + encodeURIComponent(ticketId) + '/source/refresh', body);
    if (ticketId !== tr.ticketId || seq !== tr.loadSeq) return;
    delete tr.sourceCmds.refresh;
    if (result && result.ticket && tr.detail) tr.detail.ticket = result.ticket;
    if (result && result.source) tr.source = result.source;
    const refreshed = result && result.source && result.source.source ? result.source.source : (result && result.source);
    if (result && result.applied === true) { refreshApplied = true; tr.sourceMessage = 'The refreshed source was applied to a new internal ticket revision.'; }
    else if (refreshed && refreshed.rootAvailable === false) tr.sourceMessage = refreshed.latestAvailableSnapshotId
      ? 'The latest source retrieval is unavailable. The last successful snapshot and current Intake evidence remain preserved.'
      : 'The Jira issue could not be retrieved. No source revision was applied; the current internal ticket revision remains active.';
    else if (refreshed && (refreshed.pending || refreshed.pendingSnapshotId)) tr.sourceMessage = 'New source context is saved as pending. Any active run keeps its pinned input.';
    else if (result && result.changed === false) tr.sourceMessage = 'Source content is unchanged. The current internal ticket revision remains active.';
    else tr.sourceMessage = 'Source refresh completed. Internal ticket status remains separate from Jira.';
    tr.sourceSnapshot = null;
    tr.sourceSnapshotId = null;
    await loadTicketSource(ticketId, tr.loadSeq);
  } catch (err) {
    if (ticketId !== tr.ticketId || seq !== tr.loadSeq) return;
    const code = err && err.code;
    const messages = {
      not_configured: 'Atlassian access is not configured on the orchestrator.',
      reconnect_required: 'Reconnect Atlassian from Connections, then retry the refresh.',
      source_unavailable: 'The Jira source is unavailable. The last successful snapshot remains available.',
      source_root_unavailable: 'The Jira issue could not be retrieved. The last successful snapshot remains available.',
      stale_version: 'This ticket changed. Its current version is reloading before you retry.'
    };
    tr.sourceMessage = err && err.status === 0 ? 'Could not reach the orchestrator. Retry the same refresh to safely replay it.' : (messages[code] || 'Source refresh failed. The last saved source remains available.');
    if (code === 'stale_version') { tr.sourceBusy = false; loadTicketRecord(); }
  }
  if (ticketId !== tr.ticketId || seq !== tr.loadSeq) return;
  tr.sourceBusy = false;
  renderRecordSource();
  renderRecordActions(tr.detail);
  if (refreshApplied && ticketId === tr.ticketId && seq === tr.loadSeq) {
    await loadTicketRecord();
    if (typeof Poller !== 'undefined') Poller.trigger();
  }
}

async function loadOlderSourceHistory() {
  const ticketId = tr.ticketId;
  const seq = tr.loadSeq;
  const before = tr.sourceHistoryBefore;
  if (!ticketId || !before || tr.sourceHistoryLoading) return;
  tr.sourceHistoryLoading = true; renderRecordSource();
  try {
    const result = await apiGet('/tickets/' + encodeURIComponent(ticketId) + '/source/history', { params: { beforeOrdinal: before, limit: 50 } });
    if (ticketId !== tr.ticketId || seq !== tr.loadSeq) return;
    if (result && Array.isArray(result.snapshots)) tr.sourceHistory = tr.sourceHistory.concat(result.snapshots);
    tr.sourceHistoryBefore = result && result.nextBeforeOrdinal;
    tr.sourceHistoryError = null;
  } catch (_) { if (ticketId === tr.ticketId && seq === tr.loadSeq) tr.sourceHistoryError = 'Could not load older source history.'; }
  if (ticketId !== tr.ticketId || seq !== tr.loadSeq) return;
  tr.sourceHistoryLoading = false; renderRecordSource();
}

function trSafeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch (_) { return null; }
}

async function loadSourceSnapshot(snapshotId) {
  const ticketId = tr.ticketId;
  const seq = tr.loadSeq;
  if (!ticketId || !snapshotId || tr.sourceSnapshotLoading) return;
  tr.sourceSnapshotLoading = true; tr.sourceSnapshotId = snapshotId; tr.sourceSnapshot = null; renderRecordSource();
  try {
    const result = await apiGet('/tickets/' + encodeURIComponent(ticketId) + '/source/snapshots/' + encodeURIComponent(snapshotId));
    if (ticketId !== tr.ticketId || seq !== tr.loadSeq) return;
    tr.sourceSnapshot = result && result.snapshot ? result.snapshot : result;
  } catch (_) { if (ticketId === tr.ticketId && seq === tr.loadSeq) tr.sourceMessage = 'Could not load the selected saved source snapshot.'; }
  if (ticketId !== tr.ticketId || seq !== tr.loadSeq) return;
  tr.sourceSnapshotLoading = false; renderRecordSource();
}

function renderRecordSource() {
  const section = document.getElementById('tr-source-section');
  const summaryBox = trClear('tr-source-summary');
  const actions = trClear('tr-source-actions');
  const historyBox = trClear('tr-source-history');
  const snapshotBox = trClear('tr-source-snapshot');
  const source = trSourceSummary();
  const ticket = tr.detail && tr.detail.ticket;
  const kind = source && source.sourceKind;
  trText('tr-source-kind', kind === 'jira' ? 'Jira' : (kind === 'confluence' ? 'Confluence' : 'Direct request'));
  trText('tr-source-tracking', source ? 'Internal ticket only; completion does not update Jira' : 'internal');
  if (section) section.hidden = !source && !tr.sourceLoading && !tr.sourceError;
  if (!section) return;
  if (tr.sourceLoading) { summaryBox.appendChild(h('div', { class: 'detail-empty', text: 'Loading linked source status...' })); return; }
  if (tr.sourceError) { summaryBox.appendChild(h('div', { class: 'detail-empty', text: tr.sourceError })); return; }
  if (!source) return;
  const identity = [source.sourceKind, source.originId, source.externalId].filter(Boolean).join(' / ');
  const pending = source.pendingSnapshotId || (source.pending ? 'pending' : 'none');
  const applied = source.appliedSnapshotId || 'none';
  const lines = [
    ['Immutable source identity', identity || 'unavailable'],
    ['Display key', source.displayKey || 'none'],
    ['Source revision', source.sourceRevision || 'unavailable'],
    ['Retrieved', formatAbsTime(source.fetchedAt)],
    ['Root available', source.rootAvailable === true ? 'yes' : (source.rootAvailable === false ? 'no' : 'unknown')],
    ['Latest snapshot', source.latestSnapshotId || 'none'],
    ['Last successful snapshot', source.latestAvailableSnapshotId || 'none'],
    ['Applied snapshot', applied],
    ['Pending snapshot', pending]
  ];
  const meta = h('div', { class: 'tr-source-meta' });
  lines.forEach(([label, value]) => meta.appendChild(h('div', {}, [h('strong', { text: label + ': ' }), h('span', { text: String(value) })])));
  summaryBox.appendChild(meta);
  if (source.pending || source.pendingSnapshotId) summaryBox.appendChild(h('div', { class: 'tr-source-warning', text: 'A newer source snapshot is pending. Any active run keeps the source input pinned to its saved revision.' }));
  if (source.rootAvailable === false) summaryBox.appendChild(h('div', { class: 'tr-source-warning', text: source.latestAvailableSnapshotId
    ? 'The latest Jira retrieval failed. The last successful snapshot remains preserved as prior Intake evidence.'
    : 'The Jira root could not be retrieved; this source cannot provide usable Intake context.' }));
  if (ticket) actions.appendChild(h('button', { class: 'btn btn-secondary', text: tr.sourceBusy ? 'Refreshing...' : 'Refresh Source', attrs: { type: 'button' } }));
  const refresh = actions && actions.lastChild;
  if (refresh) { refresh.disabled = Boolean(tr.sourceBusy || tr.busy || !isNumber(ticket.version)); refresh.addEventListener('click', refreshTicketSource); }
  if (tr.sourceMessage) trText('tr-source-message', tr.sourceMessage); else trText('tr-source-message', '');

  if (tr.sourceHistoryError) historyBox.appendChild(h('div', { class: 'detail-empty', text: tr.sourceHistoryError }));
  if (tr.sourceHistory.length) {
    const select = h('select', { class: 'select-input', attrs: { 'aria-label': 'Saved source snapshot', 'aria-describedby': 'tr-source-history-help' } });
    tr.sourceHistory.forEach(item => {
      const label = 'Snapshot ' + item.ordinal + (item.displayKey ? ' - ' + item.displayKey : '') + ' - ' + formatAbsTime(item.fetchedAt) + (item.rootAvailable ? '' : ' - root unavailable');
      const option = h('option', { text: label, attrs: { value: item.snapshotId } });
      if (item.snapshotId === tr.sourceSnapshotId) option.selected = true;
      select.appendChild(option);
    });
    const view = h('button', { class: 'btn btn-secondary', text: tr.sourceSnapshotLoading ? 'Loading snapshot...' : 'View saved source context', attrs: { type: 'button' } });
    view.disabled = Boolean(tr.sourceSnapshotLoading);
    view.addEventListener('click', () => loadSourceSnapshot(select.value));
    historyBox.appendChild(h('div', { class: 'form-hint', attrs: { id: 'tr-source-history-help' }, text: 'Choose a previously saved Jira source snapshot to inspect its retrieved context. Viewing it does not refresh the source.' }));
    const row = h('div', { class: 'tr-source-history-row' }, [select, view]);
    historyBox.appendChild(row);
  } else if (!tr.sourceHistoryError) historyBox.appendChild(h('div', { class: 'detail-empty', text: 'No source snapshots are recorded.' }));
  if (tr.sourceHistoryBefore) {
    const more = h('button', { class: 'btn btn-secondary', text: tr.sourceHistoryLoading ? 'Loading...' : 'Load older snapshots', attrs: { type: 'button' } });
    more.disabled = Boolean(tr.sourceHistoryLoading);
    more.addEventListener('click', loadOlderSourceHistory);
    historyBox.appendChild(more);
  }
  if (tr.sourceSnapshotLoading) { snapshotBox.appendChild(h('div', { class: 'detail-empty', text: 'Loading selected source snapshot...' })); return; }
  if (tr.sourceSnapshot) trRenderSourceSnapshot(snapshotBox, tr.sourceSnapshot);
}

function trRenderSourceSnapshot(box, snapshot) {
  const bundle = snapshot && snapshot.bundle ? snapshot.bundle : snapshot;
  const docs = Array.isArray(bundle && bundle.documents) ? bundle.documents : [];
  const warnings = Array.isArray(bundle && bundle.warnings) ? bundle.warnings : [];
  box.appendChild(h('div', { class: 'tr-source-meta' }, [h('strong', { text: 'Saved provenance and retrieved context' })]));
  if (!docs.length) box.appendChild(h('div', { class: 'detail-empty', text: 'This snapshot contains no retrieved documents.' }));
  let remaining = 200000;
  docs.forEach(doc => {
    const identity = [doc.sourceKind, doc.originId, doc.externalId].filter(Boolean).join(' / ');
    const card = h('div', { class: 'tr-source-doc' }, [
      h('div', { class: 'tr-source-doc-title', text: doc.title || '(untitled source)' }),
      h('div', { class: 'tr-source-meta' }, [
        h('span', { text: 'Identity: ' + (identity || 'unavailable') }),
        h('span', { text: 'Availability: ' + (doc.availability || 'unknown') + (doc.truncation ? ' (truncated)' : '') }),
        h('span', { text: 'Display key: ' + (doc.displayKey || 'none') }),
        h('span', { text: 'Source revision: ' + (doc.sourceRevision || 'unavailable') })
      ])
    ]);
    const link = trSafeSourceUrl(doc.url);
    if (link) card.appendChild(h('a', { class: 'tr-source-link', text: 'Open source in Atlassian', attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' } }));
    const text = typeof doc.text === 'string' ? doc.text : '';
    const allowance = Math.max(0, Math.min(30000, remaining));
    if (text && allowance) {
      const shown = text.slice(0, allowance);
      remaining -= shown.length;
      card.appendChild(h('pre', { class: 'detail-block detail-pre', text: shown + (shown.length < text.length ? '\n[Context display limit reached; the saved snapshot remains unchanged.]' : '') }));
    }
    if (doc.availability && doc.availability !== 'available') card.appendChild(h('div', { class: 'tr-source-warning', text: 'This linked item was not retrieved: ' + doc.availability }));
    if (doc.truncation) card.appendChild(h('div', { class: 'tr-source-warning', text: 'Retrieved text was truncated at the configured source limit.' }));
    if (Array.isArray(doc.links) && doc.links.length) card.appendChild(h('div', { class: 'provider-sub', text: doc.links.length + ' typed links recorded; linked content appears as its own document when retrieved.' }));
    box.appendChild(card);
  });
  warnings.slice(0, 100).forEach(warning => box.appendChild(h('div', { class: 'tr-source-warning', text: 'Warning: ' + String(warning && (warning.message || warning.code) || 'source warning') })));
  if (warnings.length > 100) box.appendChild(h('div', { class: 'tr-source-warning', text: 'Additional source warnings were omitted from this view.' }));
}

// Poller hook while the modal is open: refresh ticket, events and run; re-render only on change.
async function refreshTicketRecordPoll(signal) {
  if (!isTicketRecordOpen() || tr.busy) return;
  // A ticket that never loaded is retried as a full load once the orchestrator answers again.
  if (tr.loadFailed && !tr.detail) { await loadTicketRecord(); return; }
  const ticketId = tr.ticketId;
  const seq = tr.loadSeq;
  const base = '/tickets/' + encodeURIComponent(ticketId);
  let detail;
  try { detail = await apiGet(base, { signal }); } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    if (seq === tr.loadSeq && ticketId === tr.ticketId) { tr.loadFailed = true; trApplyLock(); }
    return;
  }
  if (seq !== tr.loadSeq || ticketId !== tr.ticketId) return;
  if (tr.loadFailed) { tr.loadFailed = false; tr.pollSig = null; }
  const summary = trrSelectedRun(detail).run;
  const settled = await Promise.allSettled([
    apiGet(base + '/events', { signal, params: { limit: TR_EVENT_LIMIT } }),
    summary ? apiGet('/runs/' + encodeURIComponent(summary.runId), { signal }) : Promise.resolve(null)
  ]);
  if (signal && signal.aborted) return;
  if (seq !== tr.loadSeq || ticketId !== tr.ticketId || tr.busy) return;
  const [events, run] = settled;
  const sig = JSON.stringify([detail, events.status === 'fulfilled' ? events.value : null, run.status === 'fulfilled' ? run.value : null]);
  if (sig === tr.pollSig) return;
  tr.pollSig = sig;
  tr.detail = detail;
  if (events.status === 'fulfilled' && Array.isArray(events.value.events)) { tr.events = events.value.events; tr.eventsError = null; }
  if (run.status === 'fulfilled' && run.value && summary) { trr.data = run.value; trr.dataRunId = summary.runId; trr.error = null; }
  else if (run.status === 'rejected' && summary) { trr.error = run.reason && run.reason.message ? run.reason.message : 'Could not load the run'; }
  renderTicketRecord();
}

async function viewRevision(revisionId) {
  const d = tr.detail;
  if (!d) return;
  if (revisionId === d.ticket.currentRevisionId || revisionId === (d.revision && d.revision.revisionId)) {
    tr.viewRevisionId = null;
    tr.viewRevision = null;
    renderTicketRecord();
    return;
  }
  const ticketId = tr.ticketId;
  try {
    const res = await apiGet('/tickets/' + encodeURIComponent(ticketId) + '/revisions/' + encodeURIComponent(revisionId));
    if (ticketId !== tr.ticketId) return;
    const rev = res && res.revision ? res.revision : res;
    if (res && res.revision && !rev.artifacts && res.artifacts) rev.artifacts = res.artifacts;
    tr.viewRevisionId = revisionId;
    tr.viewRevision = rev;
    trText('tr-action-error', '');
    renderTicketRecord();
  } catch (err) {
    trText('tr-action-error', 'Could not load that revision: ' + err.message);
  }
}

// Friendly text for M7 error codes; any other error shows the server message plus its code.
const TR_ERROR_TEXT = {
  candidate_changed: 'The checkout changed since this candidate was reviewed. Nothing was recorded. The candidate must be reviewed again.',
  rework_exhausted: 'The limit of 3 rework runs for this revision is reached. Another correction request is not possible.'
};

function actionName(a) {
  return typeof a === 'string' ? a : String((a && (a.action || a.name)) || '');
}

function renderTicketRecord() {
  const d = tr.detail;
  if (!d) return;
  const ticket = d.ticket || {};
  const current = d.revision || {};
  const shown = tr.viewRevision || current;
  const viewingOld = Boolean(tr.viewRevision);
  const status = ticket.status || 'backlog';

  trText('tr-title', shown.title || ticket.title || '(untitled)');
  trText('tr-note', '');
  const badge = document.getElementById('tr-status-badge');
  const headRun = d.activeRun || (Array.isArray(d.runs) ? d.runs[0] : null) || {};
  const attn = attentionPresentation({ status, waitReason: headRun.waitReason, phase: headRun.phase });
  badge.className = 'badge badge-status ' + ticketStatusClass(status) + (attn ? ' ' + attn.cls : '');
  badge.textContent = attn ? attn.label : ticketStatusLabel(status);
  badge.title = 'Ticket status: ' + status;
  trText('tr-revision-badge', isNumber(shown.ordinal) ? 'r' + shown.ordinal : '');

  const banner = document.getElementById('tr-old-banner');
  banner.style.display = viewingOld ? 'flex' : 'none';
  if (viewingOld) {
    trText('tr-old-text', 'Viewing older revision r' + shown.ordinal + ' (' + formatAbsTime(shown.createdAt) + '). The current revision is r' + current.ordinal + '.');
  }

  trText('tr-ticket-title', shown.title || '(untitled)');
  const desc = document.getElementById('tr-description');
  desc.textContent = shown.description ? shown.description : '';
  if (!shown.description) desc.appendChild(h('span', { class: 'detail-empty', text: 'No description.' }));

  renderStagedNotice(d);
  renderRecordCriteria(shown.criteria);
  renderRecordReferences(shown.references);
  renderRecordSource();
  renderRecordAttachments(shown, d.artifacts);
  renderRecordEvents();

  trText('tr-priority', shown.priority || ticket.priority || 'unknown');
  trText('tr-specialty', shown.requestedSpecialty ? roleDisplayNameFor(shown.requestedSpecialty) + ' (preference only)' : 'No preference');
  trText('tr-version', isNumber(ticket.version) ? String(ticket.version) : 'unknown');
  trText('tr-rev-created', formatAbsTime(shown.createdAt));
  trText('tr-created', formatAbsTime(ticket.createdAt));
  trText('tr-updated', formatAbsTime(ticket.updatedAt));
  renderRevisionHistory(d, shown);
  renderRunPanel();
  renderRecordActions(d);
}

function renderRecordCriteria(criteria) {
  const box = trClear('tr-criteria');
  const list = Array.isArray(criteria) ? criteria : [];
  if (!list.length) { box.appendChild(h('span', { class: 'detail-empty', text: 'No acceptance criteria.' })); return; }
  const ul = h('ul', { class: 'detail-list' });
  list.forEach(c => ul.appendChild(h('li', { text: c })));
  box.appendChild(ul);
}

function renderRecordReferences(references) {
  const box = trClear('tr-references');
  const refs = references && typeof references === 'object' ? references : {};
  let any = false;
  TR_REF_LABELS.forEach(def => {
    const items = Array.isArray(refs[def.key]) ? refs[def.key] : [];
    if (!items.length) return;
    any = true;
    const group = h('div', { class: 'tr-ref-group' }, [h('div', { class: 'kv-key', text: def.label })]);
    items.forEach(item => {
      const value = referenceValue(item);
      const availability = item && typeof item === 'object' ? item.availability : 'not_retrieved';
      group.appendChild(h('div', { class: 'tr-ref-item' }, [
        h('span', { text: value }),
        h('span', { class: 'tr-marker', text: availability === 'not_retrieved' || !availability ? 'not retrieved' : String(availability) })
      ]));
    });
    box.appendChild(group);
  });
  if (!any) box.appendChild(h('span', { class: 'detail-empty', text: 'No references.' }));
}

function renderRecordAttachments(rev, detailArtifacts) {
  const box = trClear('tr-attachments');
  const pool = (Array.isArray(rev.artifacts) ? rev.artifacts : []).concat(Array.isArray(detailArtifacts) ? detailArtifacts : []);
  const ids = Array.isArray(rev.artifactIds) ? rev.artifactIds : pool.map(m => m.artifactId);
  if (!ids.length) { box.appendChild(h('span', { class: 'detail-empty', text: 'No attachments.' })); return; }
  ids.forEach(id => {
    const meta = pool.find(m => m && m.artifactId === id);
    const row = h('div', { class: 'tr-att' });
    if (!meta) {
      row.appendChild(h('span', { text: String(id) }));
      row.appendChild(h('span', { class: 'tr-marker', text: 'metadata unavailable' }));
    } else {
      const href = API_BASE + '/artifacts/' + encodeURIComponent(id) + '/content';
      row.appendChild(h('a', {
        class: 'tr-att-link', text: meta.displayName || id,
        attrs: { href, download: meta.displayName || '', rel: 'noopener' }
      }));
      row.appendChild(h('span', { class: 'tr-marker', text: [formatBytes(meta.size), meta.mediaType].filter(Boolean).join(' | ') }));
      row.appendChild(h('span', { class: 'tr-marker', text: extractionWording(meta.extraction) }));
    }
    box.appendChild(row);
  });
}

function renderRecordEvents() {
  const box = trClear('tr-events');
  if (tr.events === null) {
    box.appendChild(h('div', { class: 'detail-empty', text: 'Events unavailable' + (tr.eventsError ? ': ' + tr.eventsError : '.') }));
    return;
  }
  if (!tr.events.length) { box.appendChild(h('div', { class: 'detail-empty', text: 'No events recorded.' })); return; }
  tr.events.forEach(ev => {
    box.appendChild(h('div', { class: 'event-row' }, [
      h('span', { class: 'event-time', text: formatAbsTime(ev.occurredAt) }),
      h('span', { class: 'event-type', text: ev.type || 'event' }),
      h('span', { class: 'event-payload', text: describePayload(ev.payload) })
    ]));
  });
}

function renderRevisionHistory(d, shown) {
  const box = trClear('tr-revisions');
  const revs = (Array.isArray(d.revisions) ? d.revisions : []).slice().sort((a, b) => b.ordinal - a.ordinal);
  const currentId = d.ticket.currentRevisionId || (d.revision && d.revision.revisionId);
  revs.forEach(r => {
    const isCurrent = r.revisionId === currentId;
    const btn = h('button', {
      class: 'btn btn-secondary tr-rev-btn' + (shown.revisionId === r.revisionId ? ' active' : ''),
      text: 'r' + r.ordinal + (isCurrent ? ' (current)' : '') + ' - ' + formatAbsTime(r.createdAt),
      attrs: { type: 'button', 'aria-label': 'View revision ' + r.ordinal }
    });
    btn.addEventListener('click', () => viewRevision(r.revisionId));
    box.appendChild(btn);
  });
  if (!revs.length) box.appendChild(h('span', { class: 'detail-empty', text: 'No revisions.' }));
}

// Operator controls driven by availableActions. Each entry: label and the handler; a control is shown
// enabled only when the server lists it, and disabled with the server reason when it is in unavailableActions.
const TR_CONTROLS = [
  { key: 'pause', label: 'Pause', danger: false },
  { key: 'resume', label: 'Resume', danger: false },
  { key: 'stop', label: 'Stop run', danger: true },
  { key: 'return_to_backlog', label: 'Return to Backlog', danger: false }
];
// Actions rendered by the run panel (review) and the delivery panel instead of the action bar.
const TR_PANEL_ACTIONS = ['accept', 'corrections', 'commit', 'push', 'release_repository'];

function trControlRunId(d) {
  if (d.activeRun && d.activeRun.runId) return d.activeRun.runId;
  const runs = Array.isArray(d.runs) ? d.runs : [];
  return runs[0] && runs[0].runId ? runs[0].runId : null;
}

function renderStagedNotice(d) {
  const el = document.getElementById('tr-staged-notice');
  if (!el) return;
  const staged = d.stagedRevision;
  el.style.display = staged ? 'flex' : 'none';
  el.textContent = '';
  if (!staged) return;
  el.appendChild(h('span', {
    text: 'A revised requirement is staged' + (isNumber(staged.ordinal) ? ' (r' + staged.ordinal + ')' : '')
      + '; it applies when the ticket returns to backlog or is resubmitted.'
  }));
}

function renderRecordActions(d) {
  const box = trClear('tr-actions');
  const available = (Array.isArray(d.availableActions) ? d.availableActions : []).map(actionName);
  const unavailable = Array.isArray(d.unavailableActions) ? d.unavailableActions : [];
  const cancelled = d.ticket.status === 'cancelled';
  const hideReview = trrReviewBannerShown();

  const addButton = (key, label, enabled, reason, handler, danger) => {
    const btn = h('button', {
      class: 'btn ' + (danger ? 'btn-danger' : 'btn-secondary'),
      title: enabled ? '' : reason,
      attrs: { type: 'button', 'data-action': key }
    }, [h('span', { text: label })]);
    if (!enabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.appendChild(h('span', { class: 'btn-milestone', text: reason }));
    } else {
      if (tr.busy) btn.disabled = true;
      btn.addEventListener('click', handler);
    }
    box.appendChild(btn);
  };
  const reasonFor = (key) => {
    const u = unavailable.find(x => actionName(x) === key);
    if (!u) return cancelled ? 'Not available for a cancelled ticket' : 'Not available';
    const reason = u.reason || 'Unavailable';
    const milestone = u.milestone ? (reason.includes(u.milestone) ? '' : ' (' + u.milestone + ')') : '';
    return reason + milestone;
  };
  const listed = (key) => available.includes(key) || unavailable.some(u => actionName(u) === key);
  const submitAvailable = available.includes('submit');
  const reviseKey = unavailable.some(u => actionName(u) === 'revise') ? 'revise' : 'edit';
  addButton('edit', 'Edit', available.includes('edit') || available.includes('revise'), reasonFor(reviseKey), openEditFromRecord, false);
  if (submitAvailable) {
    addButton('submit', d.ticket.status === 'blocked' ? 'Submit new run' : 'Submit to Intake', true, '', submitTicketFromRecord, false);
  } else if (d.ticket.status === 'backlog' || unavailable.some(u => actionName(u) === 'submit')) {
    addButton('submit', 'Submit to Intake', false, reasonFor('submit'), null, false);
  }
  if (tr.submitError) box.appendChild(h('div', { class: 'tf-field-error', text: tr.submitError, attrs: { role: 'alert' } }));
  TR_CONTROLS.forEach(c => {
    if (!listed(c.key)) return;
    addButton(c.key, c.label, available.includes(c.key), reasonFor(c.key), () => runTicketControl(c.key), c.danger);
  });
  addButton('cancel', 'Cancel ticket', available.includes('cancel'), reasonFor('cancel'), cancelTicketFromRecord, true);
  const handled = ['edit', 'revise', 'cancel', 'submit'].concat(TR_CONTROLS.map(c => c.key), TR_PANEL_ACTIONS);
  unavailable.forEach(u => {
    const key = actionName(u);
    if (!key || handled.includes(key)) return;
    if (hideReview && /accept|correction|rework/.test(key)) return;
    const label = key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    addButton(key, label, false, reasonFor(key));
  });
}

function openEditFromRecord() {
  if (!tr.detail) return;
  openTicketForm({ mode: 'edit', detail: tr.detail });
}

// Sends one guarded command. The commandId is reused for the same version and payload, so a retry after a
// network failure cannot apply the command twice. Resolves true on success; onError receives the message.
async function sendTicketCommand(slot, path, extra, onError) {
  const d = tr.detail;
  const ticketId = tr.ticketId;
  if (!d || !ticketId) return false;
  const version = d.ticket.version;
  const sig = JSON.stringify(extra || {});
  const cur = tr.cmds[slot];
  if (!cur || cur.version !== version || cur.sig !== sig) tr.cmds[slot] = { version, sig, commandId: newCommandId() };
  const body = Object.assign({ commandId: tr.cmds[slot].commandId, expectedVersion: version }, extra || {});
  tr.busy = true;
  renderRecordActions(d);
  try {
    await apiPost('/tickets/' + encodeURIComponent(ticketId) + path, body);
    delete tr.cmds[slot];
    tr.busy = false;
    Poller.trigger();
    if (ticketId === tr.ticketId) await loadTicketRecord();
    return true;
  } catch (err) {
    tr.busy = false;
    if (ticketId !== tr.ticketId) return false;
    let message;
    let reload = false;
    if (err instanceof ApiError && err.status === 0) {
      message = 'Cannot reach the orchestrator. Try again; the same request will not be applied twice.';
    } else if (err instanceof ApiError && err.code === 'stale_version') {
      delete tr.cmds[slot];
      reload = true;
      message = 'This ticket changed since you opened it. The latest version is shown; repeat the action if still wanted.';
    } else if (err instanceof ApiError && err.code === 'stale_decision') {
      delete tr.cmds[slot];
      reload = true;
      message = 'This question is no longer current (already answered or replaced). The latest state is shown.';
    } else if (err instanceof ApiError && TR_ERROR_TEXT[err.code]) {
      delete tr.cmds[slot];
      reload = true;
      message = TR_ERROR_TEXT[err.code];
    } else {
      delete tr.cmds[slot];
      message = (err && err.message ? err.message : 'Request failed') + (err && err.code ? ' (' + err.code + ')' : '');
    }
    if (reload) await loadTicketRecord();
    if (ticketId !== tr.ticketId) return false;
    onError(message);
    renderTicketRecord();
    return false;
  }
}

const TR_CONTROL_SPECS = {
  pause: { path: '/pause', run: true },
  resume: { path: '/resume', run: true },
  stop: { path: '/stop', run: true, confirm: 'Stop this run?\n\nActive work is interrupted and the run ends as stopped. File changes already made in the checkout are kept, not reverted, and the run evidence is retained. The ticket becomes blocked; you can submit a new run.' },
  return_to_backlog: { path: '/return-to-backlog', run: false }
};

// Pause, Resume, Stop and Return to Backlog. Pause/Resume/Stop name the run they act on.
async function runTicketControl(key) {
  const d = tr.detail;
  const spec = TR_CONTROL_SPECS[key];
  if (!d || !spec) return;
  const extra = {};
  if (spec.run) {
    const runId = trControlRunId(d);
    if (!runId) { trText('tr-action-error', 'This ticket has no run to act on.'); return; }
    extra.runId = runId;
  }
  if (spec.confirm && !window.confirm(spec.confirm)) return;
  trText('tr-action-error', '');
  await sendTicketCommand(key, spec.path, extra, (m) => trText('tr-action-error', m));
}

async function cancelTicketFromRecord() {
  const d = tr.detail;
  if (!d) return;
  if (!window.confirm('Cancel this ticket? An active run is stopped. File changes already made in the checkout are kept. Revisions, attachments and run history are kept, but the ticket cannot be edited or run afterwards.')) return;
  trText('tr-action-error', '');
  await sendTicketCommand('cancel', '/cancel', {}, (m) => trText('tr-action-error', m));
}

async function submitTicketFromRecord() {
  const d = tr.detail;
  if (!d) return;
  tr.submitError = '';
  trText('tr-action-error', '');
  await sendTicketCommand('submit', '/submit', {}, (m) => { tr.submitError = m; trText('tr-action-error', m); });
}

function initTicketRecordEvents() {
  const modal = document.getElementById('modal-ticket-record');
  if (!modal) return;
  document.getElementById('btn-ticket-record-close').addEventListener('click', closeTicketRecord);
  document.getElementById('tr-back-current').addEventListener('click', () => {
    tr.viewRevisionId = null;
    tr.viewRevision = null;
    renderTicketRecord();
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) closeTicketRecord(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isTicketRecordOpen() && !isFormOpen()) closeTicketRecord();
  });
}
