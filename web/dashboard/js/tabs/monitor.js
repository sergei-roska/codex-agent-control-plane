// --- MONITOR CONSOLE TAB ---
var monitorView = {
  loaded: false,
  available: null,
  error: null,
  events: [],
  filters: {},
  clearedThrough: 0,
  category: 'all',
  severity: 'all',
  role: 'all'
};

function monitorProvidedValues(filter) {
  if (!filter || filter.available !== true || !Array.isArray(filter.values)) return [];
  return filter.values.filter(function (value) { return typeof value === 'string'; });
}

function monitorVisibleEvents() {
  var visible = monitorView.events.filter(function (event) {
    var sequence = Number(event && event.sequence);
    return Number.isFinite(sequence) && sequence > monitorView.clearedThrough;
  });
  var categories = monitorProvidedValues(monitorView.filters.category);
  if (categories.indexOf(monitorView.category) !== -1) {
    visible = visible.filter(function (event) { return event.category === monitorView.category; });
  }
  var severities = monitorProvidedValues(monitorView.filters.severity);
  if (severities.indexOf(monitorView.severity) !== -1) {
    visible = visible.filter(function (event) { return event.level === monitorView.severity; });
  }
  var roles = monitorProvidedValues(monitorView.filters.role);
  if (roles.indexOf(monitorView.role) !== -1) {
    visible = visible.filter(function (event) { return event.role === monitorView.role; });
  }
  return visible;
}

function applyMonitorSnapshot(body) {
  if (!body || body.available !== true) {
    monitorView.available = false;
    monitorView.error = (body && body.reason) || 'Event journal is unavailable';
  } else {
    monitorView.available = true;
    monitorView.events = Array.isArray(body.events) ? body.events : [];
    monitorView.filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
    monitorView.error = null;
  }
  monitorView.loaded = true;
  renderLogs();
}

function clearMonitorBuffer() {
  var watermark = monitorView.clearedThrough;
  monitorView.events.forEach(function (event) {
    var sequence = Number(event && event.sequence);
    if (Number.isInteger(sequence) && sequence > watermark) watermark = sequence;
  });
  monitorView.clearedThrough = watermark;
  renderLogs();
}

function monitorDisplay(value, fallback) {
  return value ? String(value) : fallback;
}

function rebuildFilterOptions(select, signature, options, disabled, selected) {
  if (!select) return;
  if (select.dataset.signature === signature) {
    select.disabled = disabled;
    if (selected !== undefined) select.value = selected;
    return;
  }
  select.dataset.signature = signature;
  select.setAttribute('data-signature', signature);
  select.textContent = '';
  options.forEach(function (option) {
    select.appendChild(h('option', { text: option.text, attrs: { value: option.value } }));
  });
  select.disabled = disabled;
  if (selected !== undefined) select.value = selected;
}

function rebuildMonitorFilters() {
  var typeFilter = document.getElementById('monitor-type-filter');
  var roleFilter = document.getElementById('monitor-role-filter');
  var levelFilter = document.getElementById('monitor-level-filter');
  var categories = monitorProvidedValues(monitorView.filters.category);
  var severities = monitorProvidedValues(monitorView.filters.severity);
  var roles = monitorProvidedValues(monitorView.filters.role);
  var typeOptions = [{ value: 'all', text: 'All categories' }].concat(categories.map(function (value) {
    return { value: value, text: value };
  }));
  var typeSelected = categories.indexOf(monitorView.category) !== -1 ? monitorView.category : 'all';
  rebuildFilterOptions(typeFilter, categories.join('\n'), typeOptions, categories.length === 0, typeSelected);

  var levelPlaceholder = severities.length ? 'All levels' : 'Severity unavailable';
  var levelOptions = [{ value: 'all', text: levelPlaceholder }].concat(severities.map(function (value) {
    return { value: value, text: value };
  }));
  var levelSelected = severities.indexOf(monitorView.severity) !== -1 ? monitorView.severity : 'all';
  rebuildFilterOptions(levelFilter, severities.join('\n'), levelOptions, severities.length === 0, levelSelected);

  var rolePlaceholder = roles.length ? 'All roles' : 'Role filter unavailable';
  var roleOptions = [{ value: 'all', text: rolePlaceholder }].concat(roles.map(function (value) {
    return { value: value, text: value };
  }));
  var roleSelected = roles.indexOf(monitorView.role) !== -1 ? monitorView.role : 'all';
  rebuildFilterOptions(roleFilter, roles.join('\n'), roleOptions, roles.length === 0, roleSelected);
}

function monitorStatusText(visible) {
  if (!monitorView.loaded) return 'Loading correlated events...';
  if (monitorView.available !== true) {
    var error = monitorView.error || 'Event journal is unavailable';
    if (!visible.length) return 'Events unavailable: ' + error;
    return 'Events unavailable: ' + error + '. Showing the last successful snapshot.';
  }
  if (visible.length) return '';
  if (monitorView.clearedThrough > 0 && monitorView.events.length) {
    return 'Log view cleared. Durable journal records are unchanged.';
  }
  if (monitorView.events.length) return 'No events match the current filters.';
  return 'No correlated events yet.';
}

function renderLogs() {
  var container = document.getElementById('monitor-logs');
  var status = document.getElementById('monitor-status');
  var visible = monitorVisibleEvents();
  if (status) status.textContent = monitorStatusText(visible);
  if (container) {
    container.textContent = '';
    visible.forEach(function (event) {
      var rawTime = event.timestamp == null ? '' : String(event.timestamp);
      var timeText = typeof formatAbsTime === 'function' ? formatAbsTime(event.timestamp) : rawTime;
      container.appendChild(h('div', { class: 'log-line' }, [
        h('span', { class: 'log-time', text: timeText, attrs: { 'data-timestamp': rawTime } }),
        h('span', { class: 'log-type-badge', text: monitorDisplay(event.category, 'unavailable') }),
        h('span', { class: 'log-role', text: event.role ? '[' + event.role + ']' : '[unavailable]' }),
        h('span', { class: 'log-ticket', text: monitorDisplay(event.ticketId, 'unavailable') }),
        h('span', { class: 'log-level', text: monitorDisplay(event.level, 'unavailable') }),
        h('span', { class: 'log-msg', text: monitorDisplay(event.message, 'unavailable') })
      ]));
    });
  }
  rebuildMonitorFilters();
}

async function refreshMonitorIfVisible(signal) {
  if (typeof state === 'undefined' || state.activeTab !== 'tab-monitor') return;
  try {
    var body = await apiGet('/monitor', { signal: signal, params: { limit: 200 } });
    applyMonitorSnapshot(body);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    monitorView.loaded = true;
    monitorView.available = false;
    monitorView.error = (err && err.message) || 'Event journal is unavailable';
    renderLogs();
    throw err;
  }
}

function initMonitorEvents() {
  var typeFilter = document.getElementById('monitor-type-filter');
  var roleFilter = document.getElementById('monitor-role-filter');
  var levelFilter = document.getElementById('monitor-level-filter');
  var btnClearLogs = document.getElementById('btn-clear-logs');

  if (typeFilter) {
    typeFilter.addEventListener('change', function () {
      monitorView.category = typeFilter.value;
      renderLogs();
    });
  }
  if (roleFilter) {
    roleFilter.addEventListener('change', function () {
      monitorView.role = roleFilter.value;
      renderLogs();
    });
  }
  if (levelFilter) {
    levelFilter.addEventListener('change', function () {
      monitorView.severity = levelFilter.value;
      renderLogs();
    });
  }
  if (btnClearLogs) btnClearLogs.addEventListener('click', clearMonitorBuffer);

  var tabButtons = document.querySelectorAll('[data-tab="tab-monitor"], [data-tab=tab-monitor]');
  for (var i = 0; i < tabButtons.length; i += 1) {
    tabButtons[i].addEventListener('click', function () {
      if (typeof Poller !== 'undefined' && Poller && typeof Poller.trigger === 'function') Poller.trigger();
    });
  }
  renderLogs();
}
