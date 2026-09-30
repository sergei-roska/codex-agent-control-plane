// --- MAIN APPLICATION BOOTSTRAP ---
function initApp() {
  const roleFilter = document.getElementById('board-role-filter');
  const monitorRoleFilter = document.getElementById('monitor-role-filter');
  const ticketRoleSelect = document.getElementById('ticket-role');

  ROLES.forEach(role => {
    const roleDisplayName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[role]) ? ROLE_NAMES[role] : role;
    if (roleFilter) roleFilter.innerHTML += `<option value="${role}">${roleDisplayName}</option>`;
    if (monitorRoleFilter) monitorRoleFilter.innerHTML += `<option value="${role}">${roleDisplayName}</option>`;
    if (ticketRoleSelect) ticketRoleSelect.innerHTML += `<option value="${role}">${roleDisplayName}</option>`;
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
  initTicketCreateEvents();
  initApprovalEvents();
  initProviderModalEvents();
  initBattlepassEvents();

  // Initial renders
  renderSidebarRoles();
  renderBoard();
  renderPipelines();
  renderLogs();
  renderDecisionsAndEscalations();
  renderDocs();
  renderConnections();
}

window.addEventListener('DOMContentLoaded', initApp);
