// --- M6 Atlassian OAuth callback handoff ---
// The opaque receipt is kept only in this page's memory. Remove the fragment before
// any API request or other application work can expose it to navigation history.
let pendingAtlassianOAuthHandle = null;
let pendingAtlassianOAuthError = false;
{
  const fragment = location.hash || '';
  const success = /^#atlassian-oauth=([A-Za-z0-9_-]{20,200})$/.exec(fragment);
  const failure = /^#atlassian-oauth-error=failed$/.test(fragment);
  if (success || failure) {
    pendingAtlassianOAuthHandle = success ? success[1] : null;
    pendingAtlassianOAuthError = failure;
    window.pendingAtlassianOAuthHandle = pendingAtlassianOAuthHandle;
    history.replaceState(null, '', location.pathname + location.search);
  }
}

async function completePendingAtlassianOAuth() {
  if (!pendingAtlassianOAuthHandle || typeof completeAtlassianCallback !== 'function') return true;
  try {
    const consumed = await completeAtlassianCallback(pendingAtlassianOAuthHandle);
    if (consumed) {
      pendingAtlassianOAuthHandle = null;
      window.pendingAtlassianOAuthHandle = null;
    }
    return consumed;
  } catch (_) {
    return false;
  }
}
window.completePendingAtlassianOAuth = completePendingAtlassianOAuth;
function clearPendingAtlassianOAuth() {
  pendingAtlassianOAuthHandle = null;
  window.pendingAtlassianOAuthHandle = null;
}
window.clearPendingAtlassianOAuth = clearPendingAtlassianOAuth;

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
  if (pendingAtlassianOAuthError && typeof setAtlassianCallbackError === 'function') {
    setAtlassianCallbackError('Atlassian authorization was not completed. Start again from Connections.');
    pendingAtlassianOAuthError = false;
  }

  Conn.subscribe(renderConnectionState);
  await exchangePairingCode();
  if (pendingAtlassianOAuthHandle) await completePendingAtlassianOAuth();
  Poller.start(pollTick);
}

window.addEventListener('DOMContentLoaded', initApp);
