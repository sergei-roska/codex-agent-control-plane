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
const tr = { ticketId: null, detail: null, events: null, eventsError: null, viewRevisionId: null, viewRevision: null, cmds: {}, busy: false, pollSig: null, loadSeq: 0 };

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
  tr.busy = false;
  tr.pollSig = null;
  trrReset();
  trText('tr-title', 'Loading...');
  trText('tr-note', 'Loading ticket...');
  trText('tr-action-error', '');
  trClear('tr-actions');
  modal.classList.add('open');
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
    trText('tr-title', 'Ticket unavailable');
    trText('tr-note', detail.reason && detail.reason.status === 404
      ? 'This ticket no longer exists: ' + detail.reason.message
      : 'Could not load the ticket: ' + (detail.reason && detail.reason.message));
    return;
  }
  tr.detail = detail.value;
  tr.viewRevisionId = null;
  tr.viewRevision = null;
  tr.events = events.status === 'fulfilled' && Array.isArray(events.value.events) ? events.value.events : null;
  tr.eventsError = events.status === 'rejected' ? events.reason.message : null;
  tr.pollSig = null;
  renderTicketRecord();
  await trrFetchRun(ticketId, seq);
}

// Poller hook while the modal is open: refresh ticket, events and run; re-render only on change.
async function refreshTicketRecordPoll(signal) {
  if (!isTicketRecordOpen() || tr.busy) return;
  const ticketId = tr.ticketId;
  const seq = tr.loadSeq;
  const base = '/tickets/' + encodeURIComponent(ticketId);
  let detail;
  try { detail = await apiGet(base, { signal }); } catch (err) { if (err && err.name === 'AbortError') throw err; return; }
  if (seq !== tr.loadSeq || ticketId !== tr.ticketId) return;
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
  badge.className = 'badge badge-status ' + ticketStatusClass(status);
  badge.textContent = ticketStatusLabel(status);
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

  renderRecordCriteria(shown.criteria);
  renderRecordReferences(shown.references);
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
  const submitAvailable = available.includes('submit');
  addButton('edit', 'Edit', available.includes('edit'), reasonFor('edit'), openEditFromRecord, false);
  if (submitAvailable) {
    addButton('submit', d.ticket.status === 'blocked' ? 'Submit new run' : 'Submit to Intake', true, '', submitTicketFromRecord, false);
  } else if (d.ticket.status === 'backlog' || unavailable.some(u => actionName(u) === 'submit')) {
    addButton('submit', 'Submit to Intake', false, reasonFor('submit'), null, false);
  }
  addButton('cancel', 'Cancel ticket', available.includes('cancel'), reasonFor('cancel'), cancelTicketFromRecord, true);
  unavailable.forEach(u => {
    const key = actionName(u);
    if (key === 'edit' || key === 'cancel' || key === 'submit' || !key) return;
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

async function cancelTicketFromRecord() {
  const d = tr.detail;
  if (!d) return;
  if (!window.confirm('Cancel this ticket? Its revisions, attachments and run history are kept, but it cannot be edited or run afterwards.')) return;
  trText('tr-action-error', '');
  await sendTicketCommand('cancel', '/cancel', {}, (m) => trText('tr-action-error', m));
}

async function submitTicketFromRecord() {
  const d = tr.detail;
  if (!d) return;
  if (!window.confirm('Submit this ticket to Intake?\n\nThe PM will read the ticket and the repository (read-only) and may ask you clarifying questions before planning. While a run is active the ticket cannot be edited.')) return;
  trText('tr-action-error', '');
  await sendTicketCommand('submit', '/submit', {}, (m) => trText('tr-action-error', m));
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
