// --- TICKET DETAIL MODAL (READ-ONLY, /api/dashboard/v1/cards/:id/*) ---
const DETAIL_EVENT_PAGE = 500;
const DETAIL_EVENT_MAX_PAGES = 4;

// Every mutation control is shown disabled; the server says why via unavailableActions.
const DETAIL_ACTIONS = [
  { key: 'pause', label: 'Pause' },
  { key: 'resume', label: 'Resume' },
  { key: 'stop', label: 'Stop' },
  { key: 'cancel', label: 'Cancel' },
  { key: 'edit', label: 'Edit' },
  { key: 'return_to_backlog', label: 'Return to backlog' },
  { key: 'review', label: 'Review' },
  { key: 'commit', label: 'Commit' },
  { key: 'push', label: 'Push' }
];

const ticketModal = { cardId: null, data: null, signature: null };

function isTicketModalOpen() {
  const modal = document.getElementById('modal-ticket-detail');
  return Boolean(ticketModal.cardId && modal && modal.classList.contains('open'));
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  return el;
}

function clearEl(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = '';
  return el;
}

function showSection(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

function normalizeActionName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]+/g, '_');
}

function openTicketDetailModal(cardId) {
  const modal = document.getElementById('modal-ticket-detail');
  if (!modal) return;
  ticketModal.cardId = cardId;
  ticketModal.data = null;
  ticketModal.signature = null;

  // Always open on Overview.
  modal.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.subtab === 'm1-overview'));
  modal.querySelectorAll('.sub-tab-pane').forEach(p => p.classList.toggle('active', p.id === 'm1-overview'));

  setText('m1-title', 'Loading...');
  setText('m1-status-badge', '');
  setText('m1-load-note', 'Loading execution detail...');
  showSection('m1-load-note', true);
  ['m1-overview', 'm1-runlog', 'm1-attempts', 'm1-metrics'].forEach(id => {
    const pane = document.getElementById(id);
    if (pane) pane.classList.add('detail-stale');
  });
  renderDetailActions(null);
  modal.classList.add('open');
  Poller.trigger();
}

async function fetchAllEvents(cardId, signal) {
  let events = [];
  let after = null;
  for (let page = 0; page < DETAIL_EVENT_MAX_PAGES; page += 1) {
    const res = await apiGet('/cards/' + encodeURIComponent(cardId) + '/events', {
      signal, params: { limit: DETAIL_EVENT_PAGE, after }
    });
    const batch = Array.isArray(res.events) ? res.events : [];
    events = events.concat(batch);
    if (batch.length < DETAIL_EVENT_PAGE || res.nextAfter === null || res.nextAfter === undefined) break;
    after = res.nextAfter;
  }
  return events;
}

// Called from the poller while the modal is open (and once right after open).
async function refreshTicketDetail(signal) {
  if (!isTicketModalOpen()) return;
  const cardId = ticketModal.cardId;
  const base = '/cards/' + encodeURIComponent(cardId);
  const settled = await Promise.allSettled([
    apiGet(base, { signal }),
    apiGet(base + '/attempts', { signal }),
    apiGet(base + '/usage', { signal }),
    fetchAllEvents(cardId, signal)
  ]);
  if (signal && signal.aborted) return;
  if (cardId !== ticketModal.cardId) return;

  const [card, attempts, usage, events] = settled;
  if (card.status === 'rejected') {
    const err = card.reason;
    if (err instanceof ApiError && err.status === 404) {
      setText('m1-title', 'Execution not found');
      setText('m1-load-note', 'This execution no longer exists: ' + err.message);
      showSection('m1-load-note', true);
      return;
    }
    throw err;
  }
  const data = {
    detail: card.value,
    attempts: attempts.status === 'fulfilled' ? (attempts.value.attempts || []) : null,
    attemptsError: attempts.status === 'rejected' ? attempts.reason.message : null,
    usage: usage.status === 'fulfilled' ? usage.value : null,
    usageError: usage.status === 'rejected' ? usage.reason.message : null,
    events: events.status === 'fulfilled' ? events.value : null,
    eventsError: events.status === 'rejected' ? events.reason.message : null
  };
  const signature = JSON.stringify([data, Math.floor(Date.now() / 60000)]);
  if (signature === ticketModal.signature) return;
  ticketModal.signature = signature;
  ticketModal.data = data;
  renderTicketDetail(data);
}

function renderTicketDetail(data) {
  const detail = data.detail;
  const card = detail.card || {};
  ['m1-overview', 'm1-runlog', 'm1-attempts', 'm1-metrics'].forEach(id => {
    const pane = document.getElementById(id);
    if (pane) pane.classList.remove('detail-stale');
  });
  setText('m1-load-note', '');
  showSection('m1-load-note', false);

  const isStandalone = card.cardKind === 'standalone_execution';
  setText('m1-title', '#' + shortTaskId(card) + (isStandalone ? ' (standalone execution)' : ''));
  const badge = document.getElementById('m1-status-badge');
  if (badge) {
    badge.className = 'badge badge-status ' + cssToken(card.executionStatus);
    badge.textContent = card.displayStatus || card.rawState || 'unknown';
  }
  setText('m1-ticket-title', card.title || '(untitled)');

  renderDetailMessages(detail.userMessages);
  renderDetailBlockText('m1-status-message-wrapper', 'm1-status-message', detail.statusMessage);
  renderDetailPause(detail.pause);
  renderDetailAcceptance(card.acceptance);
  const hasResult = typeof detail.resultText === 'string' && detail.resultText !== '';
  showSection('m1-result-wrapper', hasResult);
  setText('m1-result', hasResult ? detail.resultText : '');

  setText('m1-kind-text', isStandalone ? 'Standalone execution' : 'Legacy lead run');
  setText('m1-task-text', card.runtimeTaskRef ? card.runtimeTaskRef.taskId : 'unknown');
  setText('m1-raw-state', card.rawState || 'unknown');
  setText('m1-wait-text', card.waitReason || 'none');
  const roleBox = clearEl('m1-role-text');
  (card.participatingRoles || []).forEach(r => {
    roleBox.appendChild(h('span', { class: 'badge badge-role' + (r === card.primaryRole ? ' primary' : ''), text: roleDisplayNameFor(r), title: r }));
  });
  if (!roleBox.childNodes.length) roleBox.textContent = 'none';
  setText('m1-attempt-count', isNumber(card.attemptCount) ? String(card.attemptCount) : 'unavailable');
  setText('m1-human-review', 'unknown');
  setText('m1-created-text', formatAbsTime(card.createdAt));
  setText('m1-updated-text', formatAbsTime(card.updatedAt));

  renderDetailUnavailable(detail.unavailableActions);
  renderDetailActions(detail.unavailableActions);
  renderDetailEvents(data);
  renderDetailAttempts(data, isStandalone);
  renderDetailUsage(data);
}

function renderDetailMessages(messages) {
  const box = clearEl('m1-messages');
  if (!box) return;
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) {
    box.appendChild(h('div', { class: 'detail-empty', text: 'No user messages recorded.' }));
    return;
  }
  list.forEach(m => {
    box.appendChild(h('div', { class: 'detail-message' }, [
      h('div', { class: 'detail-message-time', text: m.at ? formatAbsTime(m.at) : 'time unavailable' }),
      h('div', { class: 'detail-message-text', text: m.text || '' })
    ]));
  });
}

function renderDetailBlockText(wrapperId, bodyId, text) {
  const has = typeof text === 'string' && text !== '';
  showSection(wrapperId, has);
  setText(bodyId, has ? text : '');
}

function renderDetailPause(pause) {
  const has = pause && typeof pause === 'object' && Object.keys(pause).length > 0;
  showSection('m1-pause-wrapper', Boolean(has));
  const box = clearEl('m1-pause');
  if (!has || !box) return;
  Object.keys(pause).forEach(key => {
    const value = pause[key];
    const text = (value !== null && typeof value === 'object') ? JSON.stringify(value) : String(value);
    box.appendChild(h('div', { class: 'kv-row' }, [
      h('span', { class: 'kv-key', text: key }),
      h('span', { class: 'kv-value', text: text })
    ]));
  });
}

function renderDetailAcceptance(acceptance) {
  showSection('m1-acceptance-wrapper', Boolean(acceptance));
  const box = clearEl('m1-acceptance');
  if (!acceptance || !box) return;
  box.appendChild(h('span', {
    class: 'badge badge-accept ' + cssToken(acceptance.disposition),
    text: acceptance.disposition || 'unknown'
  }));
  const reasons = Array.isArray(acceptance.reasons) ? acceptance.reasons : [];
  if (reasons.length) {
    const ul = h('ul', { class: 'detail-list' });
    reasons.forEach(r => ul.appendChild(h('li', { text: typeof r === 'string' ? r : JSON.stringify(r) })));
    box.appendChild(ul);
  }
}

function renderDetailUnavailable(list) {
  const ul = clearEl('m1-unavailable-list');
  if (!ul) return;
  const items = Array.isArray(list) ? list : [];
  if (!items.length) {
    ul.appendChild(h('li', { class: 'detail-empty', text: 'None reported.' }));
    return;
  }
  items.forEach(a => {
    ul.appendChild(h('li', { text: (a.action || 'action') + ': ' + (a.reason || 'unavailable') + (a.milestone ? ' (' + a.milestone + ')' : '') }));
  });
}

function renderDetailActions(unavailable) {
  const box = clearEl('m1-action-buttons');
  if (!box) return;
  const entries = (Array.isArray(unavailable) ? unavailable : []).map(a => ({ name: String(a.action), raw: a }));
  const used = new Set();
  const makeButton = (label, entry) => {
    const reason = entry
      ? (entry.raw.reason || 'Unavailable') + (entry.raw.milestone ? ' (' + entry.raw.milestone + ')' : '')
      : 'Not available: the dashboard is read-only in this milestone';
    const btn = h('button', {
      class: 'btn btn-secondary', title: reason,
      attrs: { type: 'button', disabled: 'disabled', 'aria-disabled': 'true' }
    }, [h('span', { text: label })]);
    if (entry && entry.raw.milestone) btn.appendChild(h('span', { class: 'btn-milestone', text: ' ' + entry.raw.milestone }));
    box.appendChild(btn);
  };
  DETAIL_ACTIONS.forEach(def => {
    const entry = entries.find(e => e.name === def.key);
    if (entry) used.add(entry);
    makeButton(def.label, entry);
  });
  entries.filter(e => !used.has(e)).forEach(e => makeButton(String(e.raw.action || 'action'), e));
}

function describePayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return Object.keys(payload).map(k => {
    const v = payload[k];
    let t = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
    if (t.length > 200) t = t.slice(0, 200) + '...';
    return k + '=' + t;
  }).join('  ');
}

function renderDetailEvents(data) {
  const box = clearEl('m1-runlog-list');
  if (!box) return;
  if (data.events === null) {
    box.appendChild(h('div', { class: 'detail-empty', text: 'Events unavailable: ' + data.eventsError }));
    return;
  }
  if (!data.events.length) {
    box.appendChild(h('div', { class: 'detail-empty', text: 'No events recorded. Events are diagnostic and only exist for activity since the journal was enabled.' }));
    return;
  }
  data.events.forEach(ev => {
    const who = [ev.role, ev.attemptId ? 'attempt ' + String(ev.attemptId).slice(0, 8) : null].filter(Boolean).join(' / ');
    box.appendChild(h('div', { class: 'event-row' }, [
      h('span', { class: 'event-time', text: formatAbsTime(ev.occurredAt) }),
      h('span', { class: 'event-type', text: ev.type || 'event' }),
      h('span', { class: 'event-who', text: who }),
      h('span', { class: 'event-payload', text: describePayload(ev.payload) })
    ]));
  });
}

function renderDetailAttempts(data, isStandalone) {
  const body = clearEl('m1-attempts-body');
  if (!body) return;
  const fullRow = (text) => body.appendChild(h('tr', {}, [h('td', { text, attrs: { colspan: '7' }, class: 'detail-empty' })]));
  if (data.attempts === null) { fullRow('Attempts unavailable: ' + data.attemptsError); return; }
  if (!data.attempts.length) {
    fullRow(isStandalone ? 'Not applicable: a standalone execution is a single task.' : 'No attempts recorded.');
    return;
  }
  data.attempts.forEach(a => {
    const cell = (v) => h('td', { text: v === null || v === undefined || v === '' ? 'unavailable' : v });
    body.appendChild(h('tr', {}, [
      h('td', { text: roleDisplayNameFor(a.role), title: a.role || '' }),
      cell(a.sandbox), cell(a.journalState), cell(a.taskState), cell(a.outcome),
      h('td', { text: formatAbsTime(a.createdAt) }),
      h('td', { text: formatAbsTime(a.updatedAt) })
    ]));
  });
}

function tokenField(tokens, key) {
  return tokens && typeof tokens === 'object' ? tokens[key] : null;
}

function renderDetailUsage(data) {
  const note = clearEl('m1-usage-coverage');
  const body = clearEl('m1-metrics-role-body');
  const fields = ['m1-metric-tokens', 'm1-metric-cache', 'm1-metric-turns', 'm1-metric-elapsed'];
  const subs = ['m1-metric-tokens-sub', 'm1-metric-cache-sub', 'm1-metric-turns-sub', 'm1-metric-elapsed-sub'];
  if (data.usage === null) {
    fields.forEach(id => setText(id, 'unavailable'));
    subs.forEach(id => setText(id, ''));
    if (note) note.textContent = 'Usage unavailable: ' + data.usageError;
    return;
  }
  const usage = data.usage;
  const totals = usage.totals || {};
  const cov = usage.coverage || {};
  if (note) {
    note.textContent = 'Coverage: ' + (cov.status || 'unknown')
      + (isNumber(cov.rows) ? ' (' + cov.rows + ' usage rows; tokens known for ' + (isNumber(cov.tokensKnownRows) ? cov.tokensKnownRows : '?') + ')' : '');
  }
  const tk = totals.tokens;
  setText('m1-metric-tokens', formatMaybeNumber(tokenField(tk, 'totalTokens')));
  const missing = isNumber(cov.attemptsWithoutUsage) && cov.attemptsWithoutUsage > 0 ? cov.attemptsWithoutUsage : 0;
  const tokensPartial = cov.status !== 'complete' || missing > 0;
  setText('m1-metric-tokens-sub', 'in ' + formatMaybeNumber(tokenField(tk, 'inputTokens')) + ' / out ' + formatMaybeNumber(tokenField(tk, 'outputTokens'))
    + (tokensPartial ? ' (partial' + (missing ? ': ' + missing + (missing === 1 ? ' attempt' : ' attempts') + ' without usage' : '') + ')' : ''));
  setText('m1-metric-cache', formatMaybeNumber(tokenField(tk, 'cachedInputTokens')));
  setText('m1-metric-cache-sub', totals.tokensPartial ? 'partial: some rows unknown' : 'cached input tokens');
  setText('m1-metric-turns', formatMaybeNumber(totals.turns));
  setText('m1-metric-turns-sub', totals.turnsPartial ? 'partial: some rows unknown' : 'model turns');
  setText('m1-metric-elapsed', formatMaybeDuration(totals.elapsedMs));
  setText('m1-metric-elapsed-sub', totals.elapsedMsPartial ? 'partial: some rows unknown' : 'summed runtime');

  const byRole = usage.byRole && typeof usage.byRole === 'object' ? usage.byRole : {};
  const roleIds = Object.keys(byRole);
  if (!roleIds.length) {
    body.appendChild(h('tr', {}, [h('td', { text: 'No usage rows recorded.', attrs: { colspan: '8' }, class: 'detail-empty' })]));
    return;
  }
  const num = (v) => h('td', { text: formatMaybeNumber(v), attrs: { style: 'text-align: right;' } });
  roleIds.forEach(roleId => {
    const s = byRole[roleId] || {};
    const models = Array.isArray(s.models) && s.models.length ? s.models.join(', ') : 'unavailable';
    body.appendChild(h('tr', {}, [
      h('td', { text: roleDisplayNameFor(roleId), title: roleId }),
      h('td', { text: models }),
      num(tokenField(s.tokens, 'inputTokens')),
      num(tokenField(s.tokens, 'cachedInputTokens')),
      num(tokenField(s.tokens, 'outputTokens')),
      num(tokenField(s.tokens, 'totalTokens')),
      num(s.turns),
      h('td', { text: formatMaybeDuration(s.elapsedMs), attrs: { style: 'text-align: right;' } })
    ]));
  });
}

function initTicketDetailEvents() {
  // Sub-tab switching
  document.querySelectorAll('#modal-ticket-detail .sub-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.modal-body');
      if (!container) return;
      container.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.sub-tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const targetSubPane = document.getElementById(btn.dataset.subtab);
      if (targetSubPane) targetSubPane.classList.add('active');
    });
  });

  // Closing the modal stops its extra requests (the poller only refreshes an open modal).
  const modal = document.getElementById('modal-ticket-detail');
  document.querySelectorAll('[data-close="modal-ticket-detail"]').forEach(el => {
    el.addEventListener('click', () => { ticketModal.cardId = null; });
  });
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { modal.classList.remove('open'); ticketModal.cardId = null; }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isTicketModalOpen()) {
      modal.classList.remove('open');
      ticketModal.cardId = null;
    }
  });
}
