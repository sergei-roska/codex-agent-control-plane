// --- HEADER & TAB ROUTING ---
const DASHBOARD_NAVIGATION_KEY = 'codex.dashboard.navigation.v1';
const DASHBOARD_TAB_IDS = new Set([
  'tab-board', 'tab-pipelines', 'tab-monitor', 'tab-decisions', 'tab-docs', 'tab-connections'
]);

function isValidNavigationId(type, id) {
  if (typeof id !== 'string' || id.length > 512) return false;
  if (type === 'ticket') return /^tkt_[A-Za-z0-9_-]{8,64}$/.test(id);
  if (type === 'card') return /^lr_[A-Za-z0-9_-]{1,508}$/.test(id);
  return false;
}

function parseDashboardNavigation(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return { tab: 'tab-board', modal: null };
  try {
    const value = JSON.parse(raw);
    const tab = value && DASHBOARD_TAB_IDS.has(value.tab) ? value.tab : 'tab-board';
    const modal = value && value.modal;
    if (modal && (modal.type === 'ticket' || modal.type === 'card') && isValidNavigationId(modal.type, modal.id)) {
      return { tab, modal: { type: modal.type, id: modal.id } };
    }
    return { tab, modal: null };
  } catch (_) {
    return { tab: 'tab-board', modal: null };
  }
}

function readDashboardNavigation() {
  try {
    return parseDashboardNavigation(sessionStorage.getItem(DASHBOARD_NAVIGATION_KEY));
  } catch (_) {
    return { tab: 'tab-board', modal: null };
  }
}

function saveDashboardNavigation() {
  const navigation = { tab: DASHBOARD_TAB_IDS.has(state.activeTab) ? state.activeTab : 'tab-board', modal: null };
  if (typeof isTicketRecordOpen === 'function' && isTicketRecordOpen() && typeof tr !== 'undefined') {
    if (isValidNavigationId('ticket', tr.ticketId)) navigation.modal = { type: 'ticket', id: tr.ticketId };
  } else if (typeof isTicketModalOpen === 'function' && isTicketModalOpen() && typeof ticketModal !== 'undefined') {
    if (isValidNavigationId('card', ticketModal.cardId)) navigation.modal = { type: 'card', id: ticketModal.cardId };
  }
  try {
    sessionStorage.setItem(DASHBOARD_NAVIGATION_KEY, JSON.stringify(navigation));
  } catch (_) { /* Storage may be unavailable in private browsing contexts. */ }
}

function activateDashboardTab(tabId) {
  if (!DASHBOARD_TAB_IDS.has(tabId)) return false;
  const button = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
  const targetPane = document.getElementById(tabId);
  if (!button || !targetPane) return false;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  button.classList.add('active');
  targetPane.classList.add('active');
  state.activeTab = tabId;
  return true;
}

async function restoreDashboardNavigation() {
  const navigation = readDashboardNavigation();
  if (navigation.tab !== 'tab-board') activateDashboardTab(navigation.tab);
  if (!navigation.modal) return;
  try {
    if (navigation.modal.type === 'ticket') {
      await apiGet('/tickets/' + encodeURIComponent(navigation.modal.id));
      openTicketRecord(navigation.modal.id);
    } else {
      await apiGet('/cards/' + encodeURIComponent(navigation.modal.id));
      openTicketDetailModal(navigation.modal.id);
    }
  } catch (_) {
    saveDashboardNavigation();
  }
}

function initTabRouting() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!activateDashboardTab(btn.dataset.tab)) return;
      saveDashboardNavigation();
    });
  });
}
