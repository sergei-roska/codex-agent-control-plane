// --- SIDEBAR ROLES (read-only, from /roles and cards.roleCounts; no switches) ---
const GENERIC_ROLE_ICON = '\u{1F916}';

function renderSidebarRoles() {
  const container = document.getElementById('roles-list-container');
  if (!container) return;
  container.textContent = '';

  // The active pack's public roles, coordinator first (API order); repair executors are not roles.
  const packId = boardData.activePack && boardData.activePack.packId;
  const roles = boardData.roles.filter(r => r.kind !== 'repair' && (!packId || r.pack === packId));
  if (!roles.length) {
    container.appendChild(h('div', { class: 'empty-state', text: boardData.loaded ? 'No roles configured' : 'Loading roles...' }));
    return;
  }

  const active = document.getElementById('board-role-filter');
  const activeRole = active ? active.value : 'all';

  roles.forEach(role => {
    const count = isNumber(boardData.roleCounts[role.runtimeId]) ? boardData.roleCounts[role.runtimeId] : 0;
    const busy = isNumber(role.activeAttempts) && role.activeAttempts > 0;
    const config = [role.model, role.effort, role.serviceTier].filter(Boolean).join(' - ');
    const card = h('div', {
      class: 'role-card' + (activeRole === role.runtimeId ? ' selected' : ''),
      attrs: { 'data-role': role.runtimeId, tabindex: '0', role: 'button' },
      title: count + ' executions involve this role. Click to filter the board.'
    }, [
      h('div', { class: 'role-card-header' }, [
        h('div', { class: 'role-card-title-group' }, [
          h('span', { class: 'role-icon', text: GENERIC_ROLE_ICON }),
          h('span', { class: 'role-name role-name-full', text: role.displayName || role.runtimeId }),
          busy ? h('span', {
            class: 'activity-dot', attrs: { role: 'img', 'aria-label': 'Active' },
            title: role.activeAttempts + (role.activeAttempts === 1 ? ' attempt running' : ' attempts running')
          }) : null
        ]),
        h('span', { class: 'count-chip', text: count, title: 'Executions involving this role' })
      ]),
      h('div', { class: 'role-counters' }, [
        h('span', { class: 'count-chip', text: role.kind || 'role' }),
        h('span', { class: 'count-chip', text: role.sandbox || 'sandbox unknown' })
      ])
    ]);
    if (config) card.appendChild(h('div', { class: 'role-last-model', text: config, title: config }));

    const toggleFilter = () => {
      const filter = document.getElementById('board-role-filter');
      if (!filter) return;
      filter.value = filter.value === role.runtimeId ? 'all' : role.runtimeId;
      applyBoardFilters();
      renderSidebarRoles();
    };
    card.addEventListener('click', toggleFilter);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFilter(); }
    });
    container.appendChild(card);
  });
}

function renderHeaderContext() {
  const ctx = boardData.context;
  const project = ctx && ctx.project;
  if (!project) return;
  const title = document.getElementById('header-title');
  if (title && project.displayName) {
    title.textContent = project.displayName;
    title.title = project.workspace || '';
  }
  if (project.displayName) document.title = project.displayName + ' | Role-Agent Console';
}

// Connection state drives the sidebar session line and the header status pill.
let lastRenderedConnStatus = null;
function renderConnectionState(conn) {
  const previous = lastRenderedConnStatus;
  lastRenderedConnStatus = conn.status;
  const labels = {
    connecting: 'Connecting...',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    unpaired: 'Not paired'
  };
  const clock = formatClock(conn.lastSuccessAt);
  let headerText = labels[conn.status];
  if (conn.status === 'connected' && clock) headerText += ' - snapshot ' + clock;
  if (conn.status === 'reconnecting') headerText += clock ? ' - last snapshot ' + clock : ' - no snapshot yet';

  const pill = document.getElementById('conn-status');
  if (pill) {
    pill.textContent = headerText;
    pill.className = 'conn-status conn-' + conn.status;
  }
  const sessionText = document.getElementById('session-status-text');
  if (sessionText) sessionText.textContent = 'Session: ' + labels[conn.status].toLowerCase();
  const dot = document.getElementById('session-status-dot');
  if (dot) dot.className = 'status-dot conn-' + conn.status;

  // Views that keep showing the last snapshot must say so, and protected controls must not stay live.
  if (typeof renderBoard === 'function') renderBoard();
  if (typeof trApplyLock === 'function') trApplyLock();
  // The Connections tab only loads on activation; refresh it once when the orchestrator comes back.
  if (conn.status === 'connected' && (previous === 'reconnecting' || previous === 'unpaired')) {
    const pane = document.getElementById('tab-connections');
    if (pane && pane.classList.contains('active') && typeof loadConnections === 'function') loadConnections();
  }
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
