(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const params = new URLSearchParams(window.location.search);
  const state = {
    projects: [], sessions: [], projectId: params.get('project') || '', sessionId: params.get('session') || '',
    snapshot: null, usage: null, session: null, controller: null, requestId: 0, timer: 0, visibleTaskCount: 50, chartTasks: []
  };

  function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function fmt(value) { return value === null || value === undefined || !Number.isFinite(Number(value)) ? 'Unknown' : Number(value).toLocaleString('en-US'); }
  function duration(value) {
    const n = finite(value);
    if (n === null) return 'Unknown';
    if (n < 1000) return Math.round(n) + ' ms';
    const seconds = Math.round(n / 1000);
    if (seconds < 60) return seconds + ' s';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours) return hours + 'h ' + mins + 'm ' + secs + 's';
    return Math.floor(seconds / 60) + 'm ' + secs + 's';
  }
  function taskState(value) {
    if (value === null || value === undefined || value === '') return 'Unknown';
    const raw = String(value).replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, ' ');
    if (/^2$/.test(raw)) return 'Working';
    if (/^3$/.test(raw)) return 'Completed';
    if (/^4$/.test(raw)) return 'Failed';
    if (/^(completed|complete|success|done)$/.test(raw)) return 'Completed';
    if (/^(failed|failure|error)$/.test(raw)) return 'Failed';
    if (/^(canceled|cancelled)$/.test(raw)) return 'Canceled';
    if (/^(working|running|active|in progress)$/.test(raw)) return 'Working';
    if (raw === 'submitting') return 'Submitting';
    if (raw === 'submitted') return 'Submitted';
    if (raw === 'starting') return 'Starting';
    return raw.replace(/(^|\s)(\S)/g, function (_, sep, ch) { return sep + ch.toUpperCase(); });
  }
  function concise(value, maxLength) {
    const text = String(value == null ? '' : value).trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3).trimEnd() + '...';
  }
  function roleLabel(value) {
    return String(value || 'Unknown role').replace(/[-_]+/g, ' ').replace(/(^|\s)(\S)/g, function (_, sep, ch) { return sep + ch.toUpperCase(); });
  }
  function taskLabel(task) {
    if (/^(lead|coordinator)$/i.test(task.role)) return 'Coordinator / Run';
    if (task.round !== undefined && task.round !== null) return 'Round ' + task.round + ' / ' + task.role;
    return task.role;
  }
  function svgNode(tag, attrs, value) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function metricDetails(task, metric, amount) {
    const ids = [task.taskId && 'task ' + task.taskId, task.assignmentId && 'assignment ' + task.assignmentId].filter(Boolean).join(', ');
    if (metric === 'tokens') return taskLabel(task) + ': ' + fmt(amount) + ' known tokens' + (task.unknownTokenRows ? ', ' + task.unknownTokenRows + ' contributions unknown' : '') + (ids ? '; ' + ids : '') + '; input ' + fmt(task.inputTokens) + ', cached input ' + fmt(task.cachedInputTokens) + ', output ' + fmt(task.outputTokens);
    return taskLabel(task) + ': ' + duration(amount) + (task.unknownTimeRows ? ', ' + task.unknownTimeRows + ' contributions unknown' : '') + (ids ? '; ' + ids : '');
  }
  function renderMetricChart(containerId, coverageId, tasks, metric) {
    const tokenChart = metric === 'tokens';
    const amountOf = function (task) { return tokenChart ? task.totalTokens : task.elapsedMs; };
    const known = tasks.filter(function (task) { return amountOf(task) !== null; }).sort(function (a, b) { return amountOf(b) - amountOf(a); });
    const partialCount = known.filter(function (task) { return tokenChart ? task.unknownTokenRows > 0 : task.unknownTimeRows > 0; }).length;
    const unknownCount = tasks.length - known.length;
    const container = $(containerId);
    if (!known.length) {
      container.innerHTML = '<div class="empty-chart">No known per-task ' + (tokenChart ? 'token totals' : 'working times') + ' are available.</div>';
      $(coverageId).textContent = tasks.length ? 'All ' + tasks.length + ' tasks have unknown ' + (tokenChart ? 'token totals.' : 'working time.') : 'No task rows are recorded.';
      return;
    }
    const visible = known.slice(0, 12);
    const max = Math.max(1, ...visible.map(amountOf));
    const chartValue = function (task) {
      const amount = amountOf(task);
      if (!tokenChart) return duration(amount) + (task.unknownTimeRows ? '+' : '');
      const full = fmt(amount);
      const compact = full.length > 9 ? amount >= 1000000 ? (amount / 1000000).toFixed(1) + 'm' : (amount / 1000).toFixed(1) + 'k' : full;
      return compact + (task.unknownTokenRows ? '+' : '');
    };
    const valueWidth = Math.max(tokenChart ? 80 : 110, ...visible.map(function (task) { return chartValue(task).length * 8.5 + 12; }));
    const rowHeight = 38;
    const width = Math.max(200, Math.floor(container.clientWidth || 760));
    const trackX = Math.max(110, Math.min(250, Math.round(width * 0.32)));
    const trackWidth = Math.max(32, width - trackX - valueWidth - 14);
    const valueX = width - 6;
    const labelMax = Math.max(11, Math.floor((trackX - 16) / 8));
    const height = 20 + visible.length * rowHeight;
    const prefix = tokenChart ? 'token' : 'time';
    const patternId = prefix + 'PartialPattern';
    const svg = svgNode('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-labelledby': containerId + 'Title ' + containerId + 'Description', preserveAspectRatio: 'xMinYMin meet' });
    const title = svgNode('title', { id: containerId + 'Title' }, tokenChart ? 'Top tasks by known token use' : 'Top tasks by recorded working time');
    const desc = svgNode('desc', { id: containerId + 'Description' }, 'Horizontal bars scaled to the largest displayed value. Focus a row for exact metrics and coverage.');
    const defs = svgNode('defs');
    const pattern = svgNode('pattern', { id: patternId, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.appendChild(svgNode('rect', { width: 8, height: 8, fill: tokenChart ? '#564c9f' : '#27695f' }));
    pattern.appendChild(svgNode('rect', { width: 3, height: 8, fill: tokenChart ? '#b0a6ff' : '#8ce0d1' }));
    defs.appendChild(pattern);
    svg.appendChild(title);
    svg.appendChild(desc);
    svg.appendChild(defs);
    visible.forEach(function (task, index) {
      const amount = amountOf(task);
      const y = 18 + index * rowHeight;
      const details = metricDetails(task, metric, amount);
      const row = svgNode('g', { class: 'chart-row', tabindex: '0', role: 'img', 'aria-label': details });
      row.appendChild(svgNode('title', {}, details));
      row.appendChild(svgNode('text', { x: 10, y: y + 16, class: 'chart-label' }, concise(taskLabel(task), labelMax)));
      row.appendChild(svgNode('rect', { x: trackX, y: y, width: trackWidth, height: 15, rx: 4, class: 'chart-track' }));
      const bar = svgNode('rect', { x: trackX, y: y, width: amount === 0 ? 0 : Math.max(1, amount / max * trackWidth), height: 15, rx: 4, class: (tokenChart ? 'chart-bar-token' : 'chart-bar-time') + ((tokenChart ? task.unknownTokenRows : task.unknownTimeRows) ? ' chart-partial' : '') });
      if ((tokenChart && task.unknownTokenRows) || (!tokenChart && task.unknownTimeRows)) bar.setAttribute('style', 'fill: url(#' + patternId + ')');
      row.appendChild(bar);
      row.appendChild(svgNode('text', { x: valueX, y: y + 15, class: 'chart-value', 'text-anchor': 'end' }, chartValue(task)));
      svg.appendChild(row);
    });
    container.textContent = '';
    container.appendChild(svg);
    const knownText = 'Showing top ' + visible.length + ' of ' + known.length + ' known task ' + (tokenChart ? 'token totals' : 'working times');
    const coverage = partialCount ? '; ' + partialCount + ' partial' : '';
    const missing = unknownCount ? '; ' + unknownCount + ' unknown' : '';
    $(coverageId).textContent = knownText + coverage + missing + '. ' + (tokenChart ? 'Partial bars show known tokens only.' : 'Durations can overlap and are not end-to-end wall time.');
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function setMessage(text, isError) {
    const el = $('pageMessage');
    el.textContent = text;
    el.classList.toggle('is-error', Boolean(isError));
    el.classList.remove('hidden');
    $('dashboard').classList.add('hidden');
  }
  function updateQuery() {
    const url = new URL(window.location.href);
    if (state.projectId) url.searchParams.set('project', state.projectId);
    else url.searchParams.delete('project');
    if (state.sessionId) url.searchParams.set('session', state.sessionId);
    else url.searchParams.delete('session');
    history.replaceState(null, '', url);
    const link = new URL('/', window.location.origin);
    if (state.projectId) link.searchParams.set('project', state.projectId);
    if (state.sessionId) link.searchParams.set('session', state.sessionId);
    $('controlNavLink').href = link.pathname + link.search;
    $('homeNavLink').href = link.pathname + link.search;
  }
  function addOption(select, value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  function setRefreshStatus(text) { $('refreshStatus').textContent = text; }
  function dateValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const result = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  function normalizeTask(task) {
    const inputTokens = finite(task.inputTokens);
    const outputTokens = finite(task.outputTokens);
    const explicitTotal = finite(task.totalTokens);
    const totalTokens = explicitTotal !== null ? explicitTotal : inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
    const elapsedMs = finite(task.elapsedMs);
    const reportedUnknownTokens = finite(task.unknownTokenRows);
    const reportedUnknownTime = finite(task.unknownTimeRows);
    return {
      taskId: task.taskId || task.task_id || null,
      assignmentId: task.assignmentId || task.assignment_id || null,
      round: task.round,
      role: roleLabel(task.role),
      totalTokens: totalTokens,
      inputTokens: inputTokens,
      cachedInputTokens: finite(task.cachedInputTokens),
      outputTokens: outputTokens,
      elapsedMs: elapsedMs,
      state: taskState(task.state || task.taskState),
      unknownTokenRows: reportedUnknownTokens !== null ? reportedUnknownTokens : totalTokens === null ? 1 : 0,
      unknownTimeRows: reportedUnknownTime !== null ? reportedUnknownTime : elapsedMs === null ? 1 : 0,
      timingKind: 'measured'
    };
  }
  function lifecycleTasks() {
    const tasks = [];
    const turns = state.session && Array.isArray(state.session.turns) ? state.session.turns : [];
    turns.forEach(function (turn) {
      const lead = turn.leadTask;
      if (lead) {
        const metadata = lead.metadata || {};
        const start = dateValue(metadata.dispatchCreatedAt || metadata.createdAt || metadata.created_at || lead.createdAt || lead.created_at);
        const end = dateValue(lead.updatedAt || lead.updated_at);
        tasks.push({
          taskId: lead.id || null, assignmentId: null, round: null, role: 'lead', totalTokens: null,
          inputTokens: null, cachedInputTokens: null, outputTokens: null,
          elapsedMs: start !== null && end !== null ? Math.max(0, end - start) : null,
          state: taskState(lead.state), timingKind: 'lifecycle', unknownTokenRows: 0, unknownTimeRows: start !== null && end !== null ? 0 : 1
        });
      }
      (turn.workers || []).forEach(function (worker) {
        const start = dateValue(worker.created_at || worker.createdAt);
        const end = dateValue(worker.updated_at || worker.updatedAt);
        tasks.push({
          taskId: worker.task_id || null, assignmentId: worker.assignment_id || null, round: worker.round,
          role: roleLabel(worker.role), totalTokens: null, inputTokens: null,
          cachedInputTokens: null, outputTokens: null,
          elapsedMs: start !== null && end !== null ? Math.max(0, end - start) : null,
          state: taskState(worker.taskState || worker.state), timingKind: 'lifecycle', unknownTokenRows: 0, unknownTimeRows: start !== null && end !== null ? 0 : 1
        });
      });
    });
    return tasks;
  }
  function render(snapshot) {
    const tasks = snapshot ? (Array.isArray(snapshot.tasks) ? snapshot.tasks.map(normalizeTask) : []) : lifecycleTasks();
    state.chartTasks = tasks;
    $('pageMessage').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    const total = snapshot && snapshot.total ? snapshot.total : state.usage && state.usage.total || null;
    const taskTokens = tasks.map(function (task) { return task.totalTokens; }).filter(function (value) { return value !== null; });
    const taskTokenSum = taskTokens.reduce(function (sum, value) { return sum + value; }, 0);
    const totalTokens = total && finite(total.totalTokens) !== null ? finite(total.totalTokens) : taskTokens.length ? taskTokenSum : null;
    const knownTimes = tasks.map(function (task) { return task.elapsedMs; }).filter(function (value) { return value !== null; });
    const workTotal = knownTimes.reduce(function (sum, value) { return sum + value; }, 0);
    const partialTokenRows = tasks.reduce(function (sum, task) { return sum + task.unknownTokenRows; }, 0);
    const unattributedUsageRows = snapshot ? 0 : finite(state.usage && state.usage.unknownCount) || 0;
    const unknownTokenRows = partialTokenRows + unattributedUsageRows;
    const unknownTimeRows = tasks.reduce(function (sum, task) { return sum + task.unknownTimeRows; }, 0);
    $('tokenTotal').textContent = totalTokens === null ? 'Unknown' : fmt(totalTokens) + (unknownTokenRows ? '+' : '');
    const tokenParts = [];
    if (total && finite(total.inputTokens) !== null) tokenParts.push('Input ' + fmt(total.inputTokens));
    if (total && finite(total.cachedInputTokens) !== null) tokenParts.push('Cached ' + fmt(total.cachedInputTokens));
    if (total && finite(total.outputTokens) !== null) tokenParts.push('Output ' + fmt(total.outputTokens));
    if (total && finite(total.attempts) !== null) tokenParts.push(fmt(total.attempts) + ' attempts');
    if (partialTokenRows) tokenParts.push(partialTokenRows + ' task token contribution(s) unknown');
    if (unattributedUsageRows) tokenParts.push(unattributedUsageRows + ' unattributed usage row(s)');
    $('tokenDetail').textContent = tokenParts.join(' | ') || (snapshot ? 'Token detail unavailable' : 'Session-level usage total');
    $('timeTotal').textContent = knownTimes.length ? duration(workTotal) + (unknownTimeRows ? '+' : '') : 'Unknown';
    $('timeDetail').textContent = snapshot
      ? knownTimes.length + '/' + tasks.length + ' tasks measured' + (unknownTimeRows ? '; ' + unknownTimeRows + ' task contribution(s) unknown' : '') + '; spans may overlap'
      : knownTimes.length + '/' + tasks.length + ' lifecycle spans known; these are not model latency';
    renderMetricChart('taskTokenChart', 'taskTokenCoverage', tasks, 'tokens');
    renderMetricChart('taskTimeChart', 'taskTimeCoverage', tasks, 'time');

    if (!tasks.length) {
      $('taskRows').innerHTML = '<tr><td colspan="4">No task or assignment rows are recorded.</td></tr>';
    } else {
      const ordered = tasks.slice().sort(function (a, b) {
        const aActive = /active|working|running|progress|submitted|submitting|starting/i.test(String(a.state));
        const bActive = /active|working|running|progress|submitted|submitting|starting/i.test(String(b.state));
        if (aActive !== bActive) return aActive ? -1 : 1;
        return (b.elapsedMs || 0) - (a.elapsedMs || 0);
      });
      const visible = ordered.slice(0, state.visibleTaskCount);
      $('taskRows').innerHTML = visible.map(function (task) {
        const name = taskLabel(task);
        const references = [task.taskId && 'Task ' + task.taskId, task.assignmentId && 'Assignment ' + task.assignmentId].filter(Boolean);
        const reference = references.length ? references.join(' | ') : '';
        const timingTitle = task.timingKind === 'lifecycle' ? 'dispatch-created to journal-updated lifecycle span, not model latency' : 'recorded execution time, including tools and startup when present';
        const tokenTitle = task.totalTokens === null ? 'Per-task token data unavailable from this endpoint' : 'Input ' + fmt(task.inputTokens) + ', cached input ' + fmt(task.cachedInputTokens) + ', output ' + fmt(task.outputTokens) + (task.unknownTokenRows ? '; ' + task.unknownTokenRows + ' contribution(s) unknown' : '');
        const tokenValue = task.totalTokens === null ? 'Unknown' : fmt(task.totalTokens) + (task.unknownTokenRows ? '+' : '');
        const timeValue = task.elapsedMs === null ? 'Unknown' : duration(task.elapsedMs) + (task.unknownTimeRows ? '+' : '');
        const tokenNote = task.totalTokens === null ? '<small>Unavailable</small>' : task.unknownTokenRows ? '<small>Partial; ' + esc(task.unknownTokenRows) + ' unknown</small>' : '';
        const timeNote = task.unknownTimeRows ? '<small>Partial; ' + esc(task.unknownTimeRows) + ' unknown</small>' : '';
        return '<tr title="' + esc(reference) + '"><td><strong>' + esc(name) + '</strong>' + (reference ? '<small>' + esc(concise(reference, 100)) + '</small>' : '') + '</td><td title="' + esc(tokenTitle) + '">' + esc(tokenValue) + tokenNote + '</td><td title="' + esc(timingTitle) + '">' + esc(timeValue) + timeNote + '</td><td>' + esc(task.state) + '</td></tr>';
      }).join('');
    }
    $('rowCount').textContent = tasks.length ? 'Showing ' + Math.min(state.visibleTaskCount, tasks.length) + ' of ' + tasks.length + ' tasks' : '';
    $('loadMoreButton').classList.toggle('hidden', tasks.length <= state.visibleTaskCount);
    if (snapshot) {
      $('tableNote').textContent = 'Snapshot generated ' + (snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : 'at an unknown time') + '. Task elapsed time includes tools and startup when present; total task time may overlap.';
    } else {
      $('tableNote').textContent = 'Legacy fallback: task token values are unknown because the live usage endpoint only reports session and role totals.' + (finite(state.usage && state.usage.unknownCount) ? ' ' + state.usage.unknownCount + ' usage row(s) are unattributed; session token total is partial.' : '') + ' Working time uses dispatch-created to journal-updated lifecycle spans.';
    }
  }

  async function requestJson(url, signal, noStore) {
    const response = await fetch(url, { signal: signal, cache: noStore ? 'no-store' : 'default' });
    if (!response.ok) throw new Error('Request failed (' + response.status + ')');
    return response.json();
  }
  async function loadProjects() {
    setMessage('Loading projects...');
    try {
      const data = await requestJson('/api/projects');
      state.projects = Array.isArray(data.projects) ? data.projects : [];
      const select = $('projectSelect');
      select.textContent = '';
      state.projects.forEach(function (project) { addOption(select, project.id, project.name || project.id); });
      if (!state.projects.length) {
        addOption(select, '', 'No projects available');
        select.disabled = true;
        $('sessionSelect').disabled = true;
        setMessage('No projects are available. Add a project in the control plane first.');
        return;
      }
      const requested = state.projects.find(function (project) { return project.id === state.projectId; });
      const recent = state.projects.find(function (project) { return project.lastUsedAt; });
      state.projectId = (requested || recent || state.projects[0]).id;
      select.value = state.projectId;
      updateQuery();
      await loadSessions();
    } catch (error) {
      setMessage('Could not load projects: ' + error.message, true);
      setRefreshStatus('Project list unavailable');
    }
  }
  async function loadSessions() {
    if (!state.projectId) return;
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const projectId = state.projectId;
    const requestId = ++state.requestId;
    const data = await requestJson('/api/projects/' + encodeURIComponent(projectId) + '/sessions', controller.signal);
    if (requestId !== state.requestId || projectId !== state.projectId) return;
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const select = $('sessionSelect');
    select.textContent = '';
    state.sessions.forEach(function (session) {
      const title = session.goal ? concise(session.goal, 96) : 'Session ' + String(session.contextId || '').slice(0, 8);
      const updated = session.updatedAt ? ' | ' + new Date(session.updatedAt).toLocaleString() : '';
      addOption(select, session.contextId, title + updated);
    });
    if (!state.sessions.length) {
      addOption(select, '', 'No sessions available');
      select.disabled = true;
      state.sessionId = '';
      updateQuery();
      setMessage('No sessions are recorded for this project yet.');
      setRefreshStatus('Updated ' + new Date().toLocaleTimeString());
      return;
    }
    select.disabled = false;
    const requested = state.sessions.find(function (session) { return session.contextId === state.sessionId; });
    state.sessionId = (requested || state.sessions[0]).contextId;
    select.value = state.sessionId;
    updateQuery();
    await refreshData();
  }
  async function refreshData() {
    if (!state.projectId || !state.sessionId) { setMessage('Select a project and session to view performance.'); return; }
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const requestId = ++state.requestId;
    const projectId = state.projectId;
    const sessionId = state.sessionId;
    setRefreshStatus('Refreshing...');
    setMessage('Loading session performance...');
    const base = '/api/projects/' + encodeURIComponent(projectId) + '/sessions/' + encodeURIComponent(sessionId);
    const snapshotUrl = '/ui/metrics/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(sessionId) + '.json';
    try {
      const snapshot = await requestJson(snapshotUrl, controller.signal, true);
      if (requestId !== state.requestId || projectId !== state.projectId || sessionId !== state.sessionId) return;
      if (snapshot.schema !== 'task-metrics/v1' || snapshot.contextId !== sessionId) throw new Error('Task metrics snapshot does not match this session');
      state.snapshot = snapshot;
      state.usage = null;
      state.session = null;
      render(snapshot);
      setRefreshStatus('Updated ' + new Date().toLocaleTimeString());
      return;
    } catch (snapshotError) {
      if (controller.signal.aborted || requestId !== state.requestId) return;
      state.snapshot = null;
    }
    const results = await Promise.allSettled([
      requestJson(base + '/usage', controller.signal),
      requestJson(base, controller.signal)
    ]);
    if (requestId !== state.requestId || projectId !== state.projectId || sessionId !== state.sessionId) return;
    state.usage = results[0].status === 'fulfilled' ? results[0].value : null;
    state.session = results[1].status === 'fulfilled' ? results[1].value : null;
    if (!state.usage && !state.session) {
      setMessage('Could not load session data. Try refreshing.', true);
      setRefreshStatus('Refresh failed');
      return;
    }
    render(null);
    if (!state.usage || !state.session) {
      $('pageMessage').textContent = 'Partial data: ' + (!state.usage ? 'token totals are unavailable; ' : '') + (!state.session ? 'task lifecycle data is unavailable.' : '');
      $('pageMessage').classList.remove('hidden');
    }
    setRefreshStatus('Updated ' + new Date().toLocaleTimeString());
  }

  $('projectSelect').addEventListener('change', async function () {
    state.projectId = $('projectSelect').value;
    const selectedProjectId = state.projectId;
    state.sessionId = '';
    state.visibleTaskCount = 50;
    state.snapshot = state.usage = state.session = null;
    if (state.controller) state.controller.abort();
    updateQuery();
    try { await loadSessions(); } catch (error) {
      if (state.projectId !== selectedProjectId) return;
      setMessage('Could not load sessions: ' + error.message, true);
      setRefreshStatus('Session list unavailable');
    }
  });
  $('sessionSelect').addEventListener('change', function () {
    state.sessionId = $('sessionSelect').value;
    state.visibleTaskCount = 50;
    updateQuery();
    refreshData();
  });
  $('refreshButton').addEventListener('click', function () { refreshData(); });
  $('loadMoreButton').addEventListener('click', function () { state.visibleTaskCount += 50; render(state.snapshot); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearInterval(state.timer); state.timer = 0; }
    else { refreshData(); startTimer(); }
  });
  if (typeof window.addEventListener === 'function') window.addEventListener('resize', function () {
    if (!state.chartTasks.length || $('dashboard').classList.contains('hidden')) return;
    renderMetricChart('taskTokenChart', 'taskTokenCoverage', state.chartTasks, 'tokens');
    renderMetricChart('taskTimeChart', 'taskTimeCoverage', state.chartTasks, 'time');
  });
  function startTimer() {
    clearInterval(state.timer);
    if (!document.hidden) state.timer = setInterval(function () { if (!document.hidden) refreshData(); }, 30000);
  }

  updateQuery();
  loadProjects().then(startTimer).catch(function (error) { setMessage(error.message, true); });
}());
