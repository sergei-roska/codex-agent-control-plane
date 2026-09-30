// --- MAIN APPLICATION BOOTSTRAP ---
// One poll tick refreshes the board and, when open, the ticket detail modal.
async function pollTick(signal) {
  const jobs = [refreshBoard(signal)];
  if (isTicketModalOpen()) jobs.push(refreshTicketDetail(signal));
  if (isTicketRecordOpen()) jobs.push(refreshTicketRecordPoll(signal));
  await Promise.all(jobs);
}

async function initApp() {
  // Preview tabs (Monitor) still use the prototype role list.
  const monitorRoleFilter = document.getElementById('monitor-role-filter');
  ROLES.forEach(role => {
    const roleDisplayName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[role]) ? ROLE_NAMES[role] : role;
    if (monitorRoleFilter) monitorRoleFilter.appendChild(h('option', { text: roleDisplayName, attrs: { value: role } }));
  });

  // Global close modal triggers
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      const targetModal = document.getElementById(el.dataset.close);
      if (targetModal) targetModal.classList.remove('open');
    });
  });

  // Initialize subsystem event handlers
  initTheme();
  initSidebarEvents();
  initTabRouting();
  initBoardEvents();
  initMonitorEvents();
  initDocsEvents();
  initTicketDetailEvents();
  initNewTicketButton();
  initTicketRecordEvents();
  initApprovalEvents();
  initProviderModalEvents();
  initBattlepassEvents();

  // Preview tabs render fixture data; Board and Sidebar render from the API.
  renderSidebarRoles();
  renderBoard();
  renderPipelines();
  renderLogs();
  renderDecisionsAndEscalations();
  renderDocs();
  renderConnections();

  Conn.subscribe(renderConnectionState);
  await exchangePairingCode();
  Poller.start(pollTick);
}

window.addEventListener('DOMContentLoaded', initApp);
