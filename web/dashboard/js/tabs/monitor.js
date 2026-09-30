// --- MONITOR CONSOLE TAB ---
function renderLogs() {
  const container = document.getElementById('monitor-logs');
  if (!container) return;

  const typeFilterSelect = document.getElementById('monitor-type-filter');
  const roleFilterSelect = document.getElementById('monitor-role-filter');
  const levelFilterSelect = document.getElementById('monitor-level-filter');
  const typeFilter = typeFilterSelect ? typeFilterSelect.value : 'all';
  const roleFilter = roleFilterSelect ? roleFilterSelect.value : 'all';
  const levelFilter = levelFilterSelect ? levelFilterSelect.value : 'all';

  const filteredLogs = state.logs.filter(l => {
    const logType = l.type || (l.role === 'system' ? 'system' : 'agent');
    const matchType = typeFilter === 'all' || logType === typeFilter;
    const matchRole = roleFilter === 'all' || l.role === roleFilter;
    const matchLevel = levelFilter === 'all' || l.level === levelFilter;
    return matchType && matchRole && matchLevel;
  });

  container.innerHTML = filteredLogs.map(l => {
    const isSystem = (l.type === 'system' || l.role === 'system');
    const roleName = isSystem
      ? 'SYSTEM'
      : ((typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[l.role]) ? ROLE_NAMES[l.role] : l.role);
    const typeBadge = isSystem
      ? '<span class="log-type-badge system">SYS</span>'
      : '<span class="log-type-badge agent">AGT</span>';

    return `
      <div class="log-line ${isSystem ? 'system-log' : ''}">
        <span class="log-time">${l.time}</span>
        ${typeBadge}
        <span class="log-role ${isSystem ? 'role-system' : ''}" title="${l.role}">[${roleName}]</span>
        <span class="log-ticket">${l.ticket}</span>
        <span class="log-msg ${l.level}">${l.msg}</span>
      </div>
    `;
  }).join('');
}

function initMonitorEvents() {
  const monitorTypeFilter = document.getElementById('monitor-type-filter');
  const monitorRoleFilter = document.getElementById('monitor-role-filter');
  const monitorLevelFilter = document.getElementById('monitor-level-filter');
  const btnClearLogs = document.getElementById('btn-clear-logs');

  if (monitorTypeFilter) monitorTypeFilter.addEventListener('change', renderLogs);
  if (monitorRoleFilter) monitorRoleFilter.addEventListener('change', renderLogs);
  if (monitorLevelFilter) monitorLevelFilter.addEventListener('change', renderLogs);
  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', () => {
      state.logs = [];
      renderLogs();
    });
  }
}
