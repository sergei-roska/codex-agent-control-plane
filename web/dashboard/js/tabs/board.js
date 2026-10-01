// --- BOARD TAB (READ-ONLY KANBAN OVER /api/dashboard/v1/cards) ---
const BOARD_COLUMNS = ['backlog', 'pending', 'in_progress', 'needs_attention', 'closed'];
const BOARD_MAX_CARDS = 500;
const BOARD_PAGE_SIZE = 100;
const BOARD_SEARCH_DEBOUNCE_MS = 300;

const boardData = {
  loaded: false,
  cards: [],
  counts: null,
  roleCounts: {},
  total: 0,
  truncated: false,
  roles: [],
  activePack: null,
  context: null
};

// Drag actions a card may advertise (card.dragActions) and the board column each one is dropped on.
const BOARD_DROP_TARGETS = {
  submit: { column: 'pending', path: '/submit', confirm: 'Submit this ticket to Intake?\n\nThe PM will read the ticket and the repository (read-only) and may ask you clarifying questions before planning. While a run is active the ticket cannot be edited.' },
  return_to_backlog: { column: 'backlog', path: '/return-to-backlog', confirm: 'Return this ticket to Backlog?\n\nAn active run is stopped. File changes already made in the checkout are kept. Revisions, attachments and run history are kept. A staged revision becomes the current requirement.' }
};

let boardDrag = null;
let boardSearchTimer = null;
let boardLastSignature = null;

// Roles come from GET /roles: delivery roles carry a publicId (requested specialties use it), all carry a runtimeId.
function roleDisplayNameFor(roleId) {
  const r = boardData.roles.find(x => x.runtimeId === roleId) || boardData.roles.find(x => x.publicId === roleId);
  return r && r.displayName ? r.displayName : roleId;
}

// Roles offered as board filters and lanes: the active pack's public roles, plus legacy roles that
// appear on loaded cards. Repair executors are attempts of another role, not roles of their own.
function boardFilterRoles() {
  const used = new Set();
  boardData.cards.forEach(c => {
    if (c.primaryRole) used.add(c.primaryRole);
    (c.participatingRoles || []).forEach(id => used.add(id));
  });
  return boardData.roles.filter(r => r.kind !== 'repair' && (r.kind !== 'legacy' || used.has(r.runtimeId)));
}

function boardFilters() {
  const search = document.getElementById('board-search');
  const role = document.getElementById('board-role-filter');
  return {
    q: search ? search.value.trim() : '',
    role: role && role.value !== 'all' ? role.value : ''
  };
}

async function refreshBoard(signal) {
  const filters = boardFilters();
  if (!boardData.context) {
    boardData.context = await apiGet('/context', { signal });
  }
  // Refreshed every tick: activeAttempts drives the sidebar activity dots.
  const rolesRes = await apiGet('/roles', { signal });
  boardData.roles = Array.isArray(rolesRes.roles) ? rolesRes.roles : [];
  boardData.activePack = rolesRes.activePack || null;
  let cards = [];
  let cursor = null;
  let last = null;
  do {
    last = await apiGet('/cards', {
      signal,
      params: { limit: BOARD_PAGE_SIZE, q: filters.q, role: filters.role, cursor }
    });
    cards = cards.concat(last.cards || []);
    cursor = last.nextCursor || null;
  } while (cursor && cards.length < BOARD_MAX_CARDS);
  if (signal && signal.aborted) return;

  const counts = last.counts || {};
  const total = BOARD_COLUMNS.reduce((sum, c) => sum + (isNumber(counts[c]) ? counts[c] : 0), 0);
  boardData.cards = cards.slice(0, BOARD_MAX_CARDS);
  boardData.counts = counts;
  boardData.roleCounts = last.roleCounts || {};
  boardData.total = total;
  boardData.truncated = Boolean(cursor) || boardData.cards.length < total;
  boardData.loaded = true;
  renderHeaderContext();
  updateNewTicketButton();
  renderRoleFilterOptions();
  renderSidebarRoles();
  renderBoard();
  await refreshPipelinesIfVisible(signal);
}

function renderRoleFilterOptions() {
  const select = document.getElementById('board-role-filter');
  if (!select) return;
  const filterRoles = boardFilterRoles();
  const signature = filterRoles.map(r => r.runtimeId + '|' + r.displayName).join(',');
  if (select.dataset.signature === signature) return;
  const current = select.value;
  select.textContent = '';
  select.appendChild(h('option', { text: 'All Roles', attrs: { value: 'all' } }));
  filterRoles.forEach(r => {
    select.appendChild(h('option', { text: r.displayName || r.runtimeId, attrs: { value: r.runtimeId } }));
  });
  select.dataset.signature = signature;
  select.value = filterRoles.some(r => r.runtimeId === current) ? current : 'all';
}

function createDirectTicketCard(card) {
  const closed = card.boardColumn === 'closed' || String(card.displayStatus || '').toLowerCase() === 'cancelled';
  const ticketId = card.ticketId || card.cardId;
  const el = h('div', {
    class: 'ticket-card direct-ticket',
    attrs: { 'data-id': card.cardId, tabindex: '0', role: 'button' },
    title: card.title || ''
  });
  const header = h('div', { class: 'ticket-header' }, [
    h('span', { class: 'ticket-id', text: '#' + String(ticketId).replace(/^tkt_/, '').slice(0, 8), title: String(ticketId) })
  ]);
  if (isNumber(card.revisionOrdinal)) {
    header.appendChild(h('span', { class: 'badge', text: 'r' + card.revisionOrdinal, title: 'Revision ' + card.revisionOrdinal }));
  }
  el.appendChild(header);
  el.appendChild(h('div', { class: 'ticket-title', text: card.title || '(untitled)' }));

  const status = card.ticketStatus;
  const meta = h('div', { class: 'ticket-meta' }, [
    h('span', {
      class: 'badge badge-status ' + ticketStatusClass(status),
      text: ticketStatusLabel(status), title: 'Ticket status: ' + status
    })
  ]);
  if (card.phase && card.phase !== 'settled' && (status === 'pending' || status === 'in_progress')) {
    meta.appendChild(h('span', { class: 'badge', text: 'Phase: ' + runPhaseLabel(card.phase), title: card.phase }));
  }
  if (card.disposition) {
    const di = dispositionInfo(card.disposition, card.classification);
    meta.appendChild(h('span', { class: 'badge badge-accept tone-' + di.tone, text: 'Checks: ' + di.label, title: 'Acceptance disposition: ' + card.disposition }));
  }
  if (card.priority) meta.appendChild(h('span', { class: 'badge', text: 'Priority: ' + card.priority }));
  el.appendChild(meta);
  if (card.waitReason) el.appendChild(h('div', { class: 'ticket-wait', text: 'Waiting: ' + (card.waitMessage || waitReasonLabel(card.waitReason)), title: card.waitReason }));

  const extra = h('div', { class: 'ticket-meta' });
  if (card.requestedSpecialty) {
    extra.appendChild(h('span', {
      class: 'badge badge-role', text: 'Requested: ' + roleDisplayNameFor(card.requestedSpecialty),
      title: 'Preference only - the PM coordinates who works on it'
    }));
  }
  if (isNumber(card.attachmentCount) && card.attachmentCount > 0) {
    extra.appendChild(h('span', { class: 'badge', text: card.attachmentCount + (card.attachmentCount === 1 ? ' attachment' : ' attachments') }));
  }
  if (extra.childNodes.length) el.appendChild(extra);

  el.appendChild(h('div', {
    class: 'ticket-time', text: 'Updated ' + formatRelative(card.updatedAt), title: formatAbsTime(card.updatedAt)
  }));

  const dragActions = Array.isArray(card.dragActions) ? card.dragActions.filter(a => BOARD_DROP_TARGETS[a]) : [];
  if (dragActions.length) {
    el.setAttribute('draggable', 'true');
    el.classList.add('draggable');
    el.title = (card.title || '') + ' (drag to move; the ticket actions also work from the card)';
    el.addEventListener('dragstart', (e) => {
      boardDrag = { ticketId, cardId: card.cardId, actions: dragActions };
      el.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(ticketId));
      }
      boardSetDragError('');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      boardDrag = null;
      boardClearDropMarks();
    });
  }

  const open = () => openTicketRecord(ticketId);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return el;
}

function createTicketCard(card) {
  if (card.cardKind === 'ticket') return createDirectTicketCard(card);
  const isStandalone = card.cardKind === 'standalone_execution';
  const el = h('div', {
    class: 'ticket-card' + (isStandalone ? ' standalone' : ''),
    attrs: { 'data-id': card.cardId, tabindex: '0', role: 'button' },
    title: card.title || ''
  });

  const header = h('div', { class: 'ticket-header' }, [
    h('span', { class: 'ticket-id', text: '#' + shortTaskId(card), title: card.runtimeTaskRef ? card.runtimeTaskRef.taskId : '' })
  ]);
  if (isStandalone) {
    header.appendChild(h('span', { class: 'badge badge-standalone', text: 'Standalone execution' }));
  }
  el.appendChild(header);

  el.appendChild(h('div', { class: 'ticket-title', text: card.title || '(untitled)' }));

  const meta = h('div', { class: 'ticket-meta' }, [
    h('span', { class: 'badge badge-status ' + cssToken(card.executionStatus), text: card.displayStatus || card.rawState || 'unknown' })
  ]);
  if (card.acceptance && card.acceptance.disposition) {
    meta.appendChild(h('span', {
      class: 'badge badge-accept ' + cssToken(card.acceptance.disposition),
      text: 'Acceptance: ' + card.acceptance.disposition
    }));
  }
  el.appendChild(meta);

  if (card.waitReason) {
    el.appendChild(h('div', { class: 'ticket-wait', text: 'Waiting: ' + card.waitReason }));
  }

  const roles = Array.isArray(card.participatingRoles) ? card.participatingRoles : [];
  if (roles.length) {
    el.appendChild(h('div', { class: 'ticket-roles' }, roles.map(r =>
      h('span', { class: 'badge badge-role' + (r === card.primaryRole ? ' primary' : ''), text: roleDisplayNameFor(r), title: r })
    )));
  }

  el.appendChild(h('div', {
    class: 'ticket-time',
    text: 'Updated ' + formatRelative(card.updatedAt),
    title: formatAbsTime(card.updatedAt)
  }));

  const open = () => openTicketDetailModal(card.cardId);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return el;
}

function fillCardList(container, cards, emptyText) {
  container.textContent = '';
  if (!cards.length) {
    container.appendChild(h('div', { class: 'empty-state', text: emptyText }));
    return;
  }
  cards.forEach(c => container.appendChild(createTicketCard(c)));
}

function renderBoardStatusLine() {
  const el = document.getElementById('board-status');
  if (!el) return;
  if (!boardData.loaded) { el.textContent = 'Loading...'; return; }
  if (boardData.truncated) {
    el.textContent = 'Showing ' + boardData.cards.length + ' of ' + boardData.total
      + ' cards (display limit ' + BOARD_MAX_CARDS + '). Narrow the search or role filter to see the rest.';
  } else {
    el.textContent = boardData.total + (boardData.total === 1 ? ' card' : ' cards');
  }
}

function renderBoard() {
  const statusContainer = document.getElementById('status-view-container');
  const roleContainer = document.getElementById('role-view-container');
  if (!statusContainer || !roleContainer) return;
  if (boardDrag) return;

  const signature = JSON.stringify([state.boardView, boardData.loaded, boardData.cards, boardData.counts,
    boardData.roles, boardData.total, boardData.truncated, Math.floor(Date.now() / 60000)]);
  if (signature === boardLastSignature) return;
  boardLastSignature = signature;

  renderBoardStatusLine();

  if (state.boardView === 'status') {
    statusContainer.style.display = 'grid';
    roleContainer.style.display = 'none';
    BOARD_COLUMNS.forEach(col => {
      const countEl = document.getElementById('count-' + col);
      const cardsEl = document.getElementById('cards-' + col);
      const colCards = boardData.cards.filter(c => (BOARD_COLUMNS.includes(c.boardColumn) ? c.boardColumn : 'backlog') === col);
      if (countEl) {
        const n = boardData.counts && isNumber(boardData.counts[col]) ? boardData.counts[col] : colCards.length;
        countEl.textContent = n;
      }
      if (cardsEl) {
        const scroll = cardsEl.scrollTop;
        fillCardList(cardsEl, colCards, 'No cards');
        cardsEl.scrollTop = scroll;
      }
    });
  } else {
    statusContainer.style.display = 'none';
    roleContainer.style.display = 'flex';
    const scroll = roleContainer.scrollTop;
    roleContainer.textContent = '';
    const lanes = boardFilterRoles().map(r => ({ id: r.runtimeId, name: r.displayName || r.runtimeId, cards: [] }));
    const unassigned = { id: null, name: 'No primary role', cards: [] };
    boardData.cards.forEach(c => {
      const lane = lanes.find(l => l.id === c.primaryRole);
      (lane || unassigned).cards.push(c);
    });
    if (unassigned.cards.length) lanes.push(unassigned);
    lanes.forEach(lane => {
      const list = h('div', { class: 'role-lane-cards' });
      fillCardList(list, lane.cards, 'No cards');
      roleContainer.appendChild(h('div', { class: 'role-lane' }, [
        h('div', { class: 'role-lane-header' }, [
          h('span', { class: 'role-name', text: lane.name, attrs: { style: 'font-size: 14px;' } }),
          h('span', { class: 'column-count', text: lane.cards.length + (boardData.truncated ? ' loaded' : (lane.cards.length === 1 ? ' card' : ' cards')) })
        ]),
        list
      ]));
    });
    roleContainer.scrollTop = scroll;
  }
}

function setBoardView(view) {
  state.boardView = view;
  const btnStatus = document.getElementById('btn-view-status');
  const btnRole = document.getElementById('btn-view-role');
  if (btnStatus) btnStatus.classList.toggle('active', view === 'status');
  if (btnRole) btnRole.classList.toggle('active', view === 'role');
  boardLastSignature = null;
  renderBoard();
}

function boardSetDragError(message) {
  let el = document.getElementById('board-drag-error');
  if (!el) {
    const status = document.getElementById('board-status');
    if (!status || !status.parentNode) return;
    el = h('div', { class: 'tf-field-error board-drag-error', attrs: { id: 'board-drag-error', role: 'alert' } });
    status.parentNode.insertBefore(el, status.nextSibling);
  }
  el.textContent = message || '';
}

function boardClearDropMarks() {
  document.querySelectorAll('.board-column.drop-ok, .board-column.drop-bad').forEach(c => c.classList.remove('drop-ok', 'drop-bad'));
}

// The board always shows the last backend state: after any drop (valid or not) it is rebuilt from boardData.
function boardRevert() {
  boardLastSignature = null;
  renderBoard();
  Poller.trigger();
}

function boardDropAction(drag, column) {
  return drag.actions.find(a => BOARD_DROP_TARGETS[a].column === column) || null;
}

async function boardHandleDrop(drag, column) {
  const action = boardDropAction(drag, column);
  if (!action) {
    boardSetDragError('That move is not allowed. Only Pending (submit) and Backlog (return to backlog) accept a drop, and only when the ticket allows it.');
    boardRevert();
    return;
  }
  const target = BOARD_DROP_TARGETS[action];
  if (!window.confirm(target.confirm)) { boardRevert(); return; }
  const base = '/tickets/' + encodeURIComponent(drag.ticketId);
  try {
    // Cards carry no ticket version, so read the current one; the server still rejects a stale move.
    const detail = await apiGet(base);
    const version = detail && detail.ticket ? detail.ticket.version : null;
    if (!isNumber(version)) throw new ApiError(0, 'bad_response', 'The ticket version is unavailable');
    await apiPost(base + target.path, { commandId: newCommandId(), expectedVersion: version });
    boardSetDragError('');
  } catch (err) {
    boardSetDragError('Move rejected: ' + (err && err.message ? err.message : 'request failed') + (err && err.code ? ' (' + err.code + ')' : ''));
  }
  boardRevert();
}

function initBoardDragDrop() {
  const container = document.getElementById('status-view-container');
  if (!container) return;
  const columnOf = (e) => e.target && e.target.closest ? e.target.closest('.board-column') : null;
  container.addEventListener('dragover', (e) => {
    const col = columnOf(e);
    if (!col || !boardDrag) return;
    e.preventDefault();
    // Every column accepts the drop so the browser fires `drop`; the handler rejects disallowed targets with a message.
    const ok = Boolean(boardDropAction(boardDrag, col.dataset.col));
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    boardClearDropMarks();
    col.classList.add(ok ? 'drop-ok' : 'drop-bad');
  });
  container.addEventListener('dragleave', (e) => {
    const col = columnOf(e);
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop-ok', 'drop-bad');
  });
  container.addEventListener('drop', (e) => {
    const col = columnOf(e);
    if (!col || !boardDrag) return;
    e.preventDefault();
    boardClearDropMarks();
    const drag = boardDrag;
    boardDrag = null;
    boardHandleDrop(drag, col.dataset.col);
  });
}

function applyBoardFilters() {
  boardLastSignature = null;
  Poller.trigger();
}

function initBoardEvents() {
  const btnStatus = document.getElementById('btn-view-status');
  const btnRole = document.getElementById('btn-view-role');
  const boardSearch = document.getElementById('board-search');
  const boardRoleFilter = document.getElementById('board-role-filter');

  initBoardDragDrop();
  if (btnStatus) btnStatus.addEventListener('click', () => setBoardView('status'));
  if (btnRole) btnRole.addEventListener('click', () => setBoardView('role'));

  if (boardSearch) {
    boardSearch.addEventListener('input', () => {
      clearTimeout(boardSearchTimer);
      boardSearchTimer = setTimeout(applyBoardFilters, BOARD_SEARCH_DEBOUNCE_MS);
    });
  }
  if (boardRoleFilter) boardRoleFilter.addEventListener('change', applyBoardFilters);
}
