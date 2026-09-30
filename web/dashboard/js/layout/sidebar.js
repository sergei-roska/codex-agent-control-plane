// --- SIDEBAR ROLES & CONTROLS ---
function renderSidebarRoles() {
  const container = document.getElementById('roles-list-container');
  if (!container) return;

  container.innerHTML = ROLES.map(role => {
    const counts = getRoleTicketCounts(role);
    const lastModel = getLastModelAttempt(role);
    const isChecked = state.roleSessions[role] ? 'checked' : '';
    const icon = ROLE_ICONS[role] || '&#x1F916;';
    const roleDisplayName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[role]) ? ROLE_NAMES[role] : role;

    return `
      <div class="role-card" data-role="${role}" title="Role: ${roleDisplayName} (${role}) - ${counts.backlog} Backlog, ${counts.pending} Pending, ${counts.active} Active">
        <div class="role-card-header">
          <div class="role-card-title-group">
            <span class="role-icon">${icon}</span>
            <span class="role-name role-name-full">${roleDisplayName}</span>
          </div>
          <label class="switch" title="Toggle session routing inclusion">
            <input type="checkbox" data-role="${role}" class="role-toggle" ${isChecked}>
            <span class="slider"></span>
          </label>
        </div>
        <div class="role-counters">
          <span class="count-chip count-backlog" title="Backlog: ${counts.backlog}">${counts.backlog}B</span>
          <span class="count-chip count-pending" title="Pending: ${counts.pending}">${counts.pending}P</span>
          <span class="count-chip count-active active-count" title="Active: ${counts.active}">${counts.active}A</span>
          <span class="count-chip count-attention attention-count" title="Needs Attention: ${counts.attention}">${counts.attention}!</span>
          <span class="count-chip count-closed" title="Closed: ${counts.closed}">${counts.closed}C</span>
        </div>
        <div class="role-last-model" title="${lastModel}">${lastModel}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.role-toggle').forEach(el => {
    el.addEventListener('change', (e) => {
      const role = e.target.dataset.role;
      state.roleSessions[role] = e.target.checked;
    });
  });

  // Clicking role card in collapsed state filters the board by that role
  container.querySelectorAll('.role-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) return;
      const role = card.dataset.role;
      const boardFilter = document.getElementById('board-role-filter');
      if (boardFilter) {
        boardFilter.value = role;
        renderBoard();
      }
    });
  });
}

function initSidebarEvents() {
  const sidebar = document.getElementById('main-sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const menuToggleBtn = document.getElementById('btn-menu-toggle');
  const closeSidebarBtn = document.getElementById('btn-close-sidebar');
  const brandIconBtn = document.getElementById('btn-toggle-sidebar-collapse');

  if (brandIconBtn && sidebar) {
    brandIconBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sidebar.classList.toggle('collapsed');
    });
  }

  function openSidebar() {
    if (sidebar) sidebar.classList.add('open');
    if (sidebarOverlay) sidebarOverlay.classList.add('active');
  }

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (sidebarOverlay) sidebarOverlay.classList.remove('active');
  }

  if (menuToggleBtn) menuToggleBtn.addEventListener('click', openSidebar);
  if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', closeSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
}
