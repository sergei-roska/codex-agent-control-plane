// --- BOARD TAB (KANBAN & ROLE SWIMLANES) ---
function createTicketCardHTML(ticket) {
  const roleName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[ticket.role]) ? ROLE_NAMES[ticket.role] : ticket.role;
  return `
    <div class="ticket-card" data-id="${ticket.id}" draggable="true">
      <div class="ticket-header">
        <span class="ticket-id">${ticket.id}</span>
        <span class="badge badge-role" title="${ticket.role}">${roleName}</span>
      </div>
      <div class="ticket-title">${ticket.title}</div>
      <div class="ticket-meta">
        <span class="badge badge-status ${ticket.status}">${ticket.status}</span>
        ${formatModelChip(ticket)}
      </div>
    </div>
  `;
}

function setupDragAndDrop() {
  const cards = document.querySelectorAll('.ticket-card[draggable="true"]');
  const columns = document.querySelectorAll('#status-view-container .board-column');

  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.style.opacity = '0.5';
    });

    card.addEventListener('dragend', () => {
      card.style.opacity = '1';
    });
  });

  columns.forEach(column => {
    column.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      column.classList.add('drag-over');
    });

    column.addEventListener('dragleave', (e) => {
      if (!column.contains(e.relatedTarget)) {
        column.classList.remove('drag-over');
      }
    });

    column.addEventListener('drop', (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');
      const ticketId = e.dataTransfer.getData('text/plain');
      const targetCol = column.dataset.col;
      const ticket = state.tickets.find(t => t.id === ticketId);

      if (ticket && targetCol) {
        const statusMap = {
          backlog: 'backlog',
          pending: 'pending',
          in_progress: 'in_progress',
          needs_attention: 'waiting_human',
          closed: 'done'
        };

        const newStatus = statusMap[targetCol] || targetCol;
        if (ticket.status !== newStatus) {
          const oldStatus = ticket.status;
          ticket.status = newStatus;
          if (!ticket.runLog) ticket.runLog = [];
          ticket.runLog.push(`${new Date().toLocaleTimeString()} - Moved by Operator from [${oldStatus}] to [${targetCol}] column.`);
          renderSidebarRoles();
          renderBoard();
        }
      }
    });
  });
}

function renderBoard() {
  const searchInput = document.getElementById('board-search');
  const roleFilterSelect = document.getElementById('board-role-filter');
  const searchQuery = (searchInput ? searchInput.value : '').toLowerCase();
  const roleFilter = roleFilterSelect ? roleFilterSelect.value : 'all';

  const filteredTickets = state.tickets.filter(t => {
    const matchSearch = t.title.toLowerCase().includes(searchQuery) || t.id.toLowerCase().includes(searchQuery);
    const matchRole = roleFilter === 'all' || t.role === roleFilter;
    return matchSearch && matchRole;
  });

  if (state.boardView === 'status') {
    const statusContainer = document.getElementById('status-view-container');
    const roleContainer = document.getElementById('role-view-container');
    if (statusContainer) statusContainer.style.display = 'grid';
    if (roleContainer) roleContainer.style.display = 'none';

    const cols = { backlog: [], pending: [], in_progress: [], needs_attention: [], closed: [] };
    filteredTickets.forEach(t => {
      const grp = getStatusGroup(t.status);
      if (cols[grp]) cols[grp].push(t);
      else cols.backlog.push(t);
    });

    Object.keys(cols).forEach(colKey => {
      const countEl = document.getElementById(`count-${colKey}`);
      const cardsEl = document.getElementById(`cards-${colKey}`);
      if (countEl) countEl.textContent = cols[colKey].length;

      if (cardsEl) {
        if (cols[colKey].length === 0) {
          cardsEl.innerHTML = `<div class="empty-state">No tickets</div>`;
        } else {
          cardsEl.innerHTML = cols[colKey].map(t => createTicketCardHTML(t)).join('');
        }
      }
    });

    setupDragAndDrop();
  } else {
    const statusContainer = document.getElementById('status-view-container');
    const roleContainer = document.getElementById('role-view-container');
    if (statusContainer) statusContainer.style.display = 'none';
    if (roleContainer) {
      roleContainer.style.display = 'flex';
      roleContainer.innerHTML = ROLES.map(role => {
        const ticketsForRole = filteredTickets.filter(t => t.role === role);
        const roleDisplayName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[role]) ? ROLE_NAMES[role] : role;
        const icon = (typeof ROLE_ICONS !== 'undefined' && ROLE_ICONS[role]) ? ROLE_ICONS[role] : '';
        return `
          <div class="role-lane">
            <div class="role-lane-header">
              <span class="role-name" style="font-size: 14px; display:inline-flex; align-items:center; gap:6px;">
                <span>${icon}</span>
                <span>${roleDisplayName}</span>
              </span>
              <span class="column-count">${ticketsForRole.length} tickets</span>
            </div>
            <div class="role-lane-cards">
              ${ticketsForRole.length > 0 
                ? ticketsForRole.map(t => createTicketCardHTML(t)).join('')
                : '<div class="empty-state">No tickets assigned</div>'}
            </div>
          </div>
        `;
      }).join('');
    }
  }

  document.querySelectorAll('.ticket-card').forEach(card => {
    card.addEventListener('click', () => {
      const ticketId = card.dataset.id;
      const ticket = state.tickets.find(t => t.id === ticketId);
      if (!ticket) return;
      if (ticket.status === 'backlog' || ticket.status === 'new') {
        openTicketEditModal(ticketId);
      } else {
        openTicketDetailModal(ticketId);
      }
    });
  });
}

function initBoardEvents() {
  const btnStatus = document.getElementById('btn-view-status');
  const btnRole = document.getElementById('btn-view-role');
  const boardSearch = document.getElementById('board-search');
  const boardRoleFilter = document.getElementById('board-role-filter');

  if (btnStatus) {
    btnStatus.addEventListener('click', () => {
      state.boardView = 'status';
      btnStatus.classList.add('active');
      if (btnRole) btnRole.classList.remove('active');
      renderBoard();
    });
  }

  if (btnRole) {
    btnRole.addEventListener('click', () => {
      state.boardView = 'role';
      btnRole.classList.add('active');
      if (btnStatus) btnStatus.classList.remove('active');
      renderBoard();
    });
  }

  if (boardSearch) boardSearch.addEventListener('input', renderBoard);
  if (boardRoleFilter) boardRoleFilter.addEventListener('change', renderBoard);
}
