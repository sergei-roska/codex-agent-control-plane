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
  context: null
};

let boardSearchTimer = null;
let boardLastSignature = null;

function roleDisplayNameFor(roleId) {
  const r = boardData.roles.find(x => x.id === roleId);
  return r && r.displayName ? r.displayName : roleId;
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
  if (!boardData.roles.length) {
    const res = await apiGet('/roles', { signal });
    boardData.roles = Array.isArray(res.roles) ? res.roles : [];
  }
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
}

function renderRoleFilterOptions() {
  const select = document.getElementById('board-role-filter');
  if (!select) return;
  const signature = boardData.roles.map(r => r.id + '|' + r.displayName).join(',');
  if (select.dataset.signature === signature) return;
  const current = select.value;
  select.textContent = '';
  select.appendChild(h('option', { text: 'All Roles', attrs: { value: 'all' } }));
  boardData.roles.forEach(r => {
    select.appendChild(h('option', { text: r.displayName || r.id, attrs: { value: r.id } }));
  });
  select.dataset.signature = signature;
  select.value = boardData.roles.some(r => r.id === current) ? current : 'all';
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

  const meta = h('div', { class: 'ticket-meta' }, [
    h('span', { class: 'badge badge-status ' + (closed ? 'cancelled' : 'backlog'), text: card.displayStatus || (closed ? 'Cancelled' : 'Draft') })
  ]);
  if (card.priority) meta.appendChild(h('span', { class: 'badge', text: 'Priority: ' + card.priority }));
  el.appendChild(meta);

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
    const lanes = boardData.roles.map(r => ({ id: r.id, name: r.displayName || r.id, cards: [] }));
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

function applyBoardFilters() {
  boardLastSignature = null;
  Poller.trigger();
}

function initBoardEvents() {
  const btnStatus = document.getElementById('btn-view-status');
  const btnRole = document.getElementById('btn-view-role');
  const boardSearch = document.getElementById('board-search');
  const boardRoleFilter = document.getElementById('board-role-filter');

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
