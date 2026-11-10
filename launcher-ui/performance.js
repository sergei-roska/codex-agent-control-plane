(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const params = new URLSearchParams(window.location.search);
  const state = {
    prices: null,
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
    if (task.taskCount) return task.role + (task.taskCount > 1 ? ' (' + task.taskCount + ' tasks)' : '');
    if (task.round !== undefined && task.round !== null) return 'Round ' + task.round + ' / ' + task.role;
    return task.role;
  }
  function aggregateByRole(tasks) {
    const groups = new Map();
    tasks.forEach(function (task) {
      const role = /^(lead|coordinator)$/i.test(task.role) ? 'Coordinator' : task.role;
      let g = groups.get(role);
      if (!g) {
        g = { taskId: null, assignmentId: null, round: null, role: role, taskCount: 0, totalTokens: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, elapsedMs: null, unknownTokenRows: 0, unknownTimeRows: 0, timingKind: 'measured', lifecycleOnly: true, states: new Map(), models: {} };
        groups.set(role, g);
      }
      const add = function (key, value) { if (value !== null && value !== undefined) g[key] = (g[key] || 0) + value; };
      g.taskCount += 1;
      Object.keys(task.models || {}).forEach(function (name) {
        const m = g.models[name] || (g.models[name] = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
        ['inputTokens', 'cachedInputTokens', 'outputTokens'].forEach(function (key) { m[key] += finite(task.models[name][key]) || 0; });
      });
      g.states.set(task.state, (g.states.get(task.state) || 0) + 1);
      add('totalTokens', task.totalTokens); add('inputTokens', task.inputTokens);
      add('cachedInputTokens', task.cachedInputTokens); add('outputTokens', task.outputTokens);
      add('elapsedMs', task.elapsedMs);
      g.unknownTokenRows += task.unknownTokenRows;
      g.unknownTimeRows += task.unknownTimeRows;
      if (task.elapsedMs !== null && task.timingKind !== 'lifecycle') g.lifecycleOnly = false;
    });
    return Array.from(groups.values()).map(function (g) {
      g.timingKind = g.lifecycleOnly ? 'lifecycle' : 'measured';
      g.state = g.states.size === 1 ? Array.from(g.states.keys())[0] : Array.from(g.states.entries()).map(function (e) { return e[1] + ' ' + e[0]; }).join(', ');
      return g;
    });
  }
  function roleCost(models) {
    const names = Object.keys(models || {});
    if (!names.length) return { cost: null, unpriced: [] };
    let cost = 0;
    const unpriced = [];
    names.forEach(function (name) {
      const price = state.prices && state.prices.models && state.prices.models[name];
      if (!price) { unpriced.push(name); return; }
      const m = models[name];
      const fresh = Math.max(m.inputTokens - m.cachedInputTokens, 0);
      cost += (fresh * price.inputPerMTok + m.cachedInputTokens * price.cachedInputPerMTok + m.outputTokens * price.outputPerMTok) / 1e6;
    });
    return { cost: unpriced.length === names.length ? null : cost, unpriced: unpriced };
  }
  function money(value) {
    return value === null ? 'Unknown' : '$' + (value < 1 ? value.toFixed(4) : value.toFixed(2));
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
    const source = task.timingKind === 'lifecycle' ? 'dispatch lifecycle span, not model latency' : 'recorded execution time';
    return taskLabel(task) + ': ' + duration(amount) + ' (' + source + ')' + (task.unknownTimeRows ? ', ' + task.unknownTimeRows + ' contributions unknown' : '') + (ids ? '; ' + ids : '');
  }
  function timeProvenance(tasks) {
    const known = tasks.filter(function (task) { return task.elapsedMs !== null; });
    return {
      measured: known.filter(function (task) { return task.timingKind !== 'lifecycle'; }).length,
      lifecycle: known.filter(function (task) { return task.timingKind === 'lifecycle'; }).length,
      unknown: tasks.length - known.length,
      unknownContributions: tasks.reduce(function (sum, task) { return sum + task.unknownTimeRows; }, 0)
    };
  }
  function timeProvenanceText(counts, total) {
    return counts.measured + ' measured, ' + counts.lifecycle + ' lifecycle spans, ' + counts.unknown + ' unknown / ' + total + ' tasks';
  }
  function timeSourceNote(counts) {
    const sources = [];
    if (counts.measured) sources.push(counts.measured + ' measured execution ' + (counts.measured === 1 ? 'duration' : 'durations') + ', including tools and startup when present');
    if (counts.lifecycle) sources.push(counts.lifecycle + ' dispatch-created to journal-updated lifecycle ' + (counts.lifecycle === 1 ? 'span' : 'spans') + ', not model latency');
    if (counts.unknown) sources.push(counts.unknown + ' task ' + (counts.unknown === 1 ? 'duration' : 'durations') + ' unknown');
    return (sources.length ? 'Time values: ' + sources.join('; ') + '. ' : 'No task durations are known. ')
      + 'Task durations may overlap.';
  }
  function renderMetricChart(containerId, coverageId, tasks, metric) {
    const tokenChart = metric === 'tokens';
    tasks = aggregateByRole(tasks);
    const timing = tokenChart ? null : timeProvenance(tasks);
    const amountOf = function (task) { return tokenChart ? task.totalTokens : task.elapsedMs; };
    const known = tasks.filter(function (task) { return amountOf(task) !== null; }).sort(function (a, b) { return amountOf(b) - amountOf(a); });
    const partialCount = known.filter(function (task) { return tokenChart ? task.unknownTokenRows > 0 : task.unknownTimeRows > 0; }).length;
    const unknownCount = tasks.length - known.length;
    const container = $(containerId);
    if (!known.length) {
      container.innerHTML = '<div class="empty-chart">No known per-role ' + (tokenChart ? 'token totals' : 'working times') + ' are available.</div>';
      $(coverageId).textContent = tasks.length
        ? tokenChart ? 'All ' + tasks.length + ' roles have unknown token totals.' : timeProvenanceText(timing, tasks.length) + '. '
          + (timing.unknownContributions ? timing.unknownContributions + ' timing contribution(s) unknown. ' : '')
          + 'Lifecycle spans are not model latency.'
        : 'No task rows are recorded.';
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
    const title = svgNode('title', { id: containerId + 'Title' }, tokenChart ? 'Roles by known token use' : 'Roles by recorded working time');
    const desc = svgNode('desc', { id: containerId + 'Description' }, tokenChart
      ? 'Horizontal bars scaled to the largest displayed value. Focus a row for exact metrics and coverage.'
      : 'Horizontal bars scale recorded durations. Rows identify measured execution time or lifecycle spans; lifecycle spans are not model latency.');
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
    const knownText = 'Showing top ' + visible.length + ' of ' + known.length + ' known role ' + (tokenChart ? 'token totals' : 'durations');
    const coverage = partialCount ? '; ' + partialCount + ' partial' : '';
    const missing = unknownCount ? '; ' + unknownCount + ' unknown' : '';
    const timeSources = tokenChart ? '' : '; ' + timing.measured + ' measured; ' + timing.lifecycle + ' lifecycle spans';
    const timeNote = tokenChart ? 'Partial bars show known tokens only.'
      : (timing.lifecycle ? 'Lifecycle spans are not model latency. ' : '')
        + (timing.measured ? 'Measured execution durations include tools and startup when present. ' : '')
        + 'Durations can overlap and are not end-to-end wall time.';
    $(coverageId).textContent = knownText + timeSources + coverage + missing + '. ' + timeNote;
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
    const tokens = task.tokens && typeof task.tokens === 'object' ? task.tokens : task;
    const tokenField = function (field, legacy) {
      if (task[field] !== undefined) return task[field];
      if (task[legacy] !== undefined) return task[legacy];
      if (tokens[field] !== undefined) return tokens[field];
      return tokens[legacy];
    };
    const inputTokens = finite(tokenField('inputTokens', 'input_tokens'));
    const outputTokens = finite(tokenField('outputTokens', 'output_tokens'));
    const explicitTotal = finite(tokenField('totalTokens', 'total_tokens'));
    const totalTokens = explicitTotal !== null ? explicitTotal : inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
    const elapsedMs = finite(task.elapsedMs);
    const reportedUnknownTokens = finite(task.unknownTokenRows);
    const reportedUnknownTime = finite(task.unknownTimeRows);
    return {
      taskId: task.taskId || task.task_id || null,
      assignmentId: task.assignmentId || task.assignment_id || null,
      round: task.round,
      models: task.models && typeof task.models === 'object' ? task.models : {},
      role: roleLabel(task.role),
      totalTokens: totalTokens,
      inputTokens: inputTokens,
      cachedInputTokens: finite(tokenField('cachedInputTokens', 'cached_input_tokens')),
      outputTokens: outputTokens,
      elapsedMs: elapsedMs,
      state: taskState(task.state || task.taskState),
      unknownTokenRows: reportedUnknownTokens !== null ? reportedUnknownTokens : totalTokens === null ? 1 : 0,
      unknownTimeRows: reportedUnknownTime !== null ? reportedUnknownTime : elapsedMs === null ? 1 : 0,
      timingKind: task.timingKind === 'lifecycle' ? 'lifecycle' : 'measured'
    };
  }
  function liveTokenTasks(performance) {
    if (!performance || performance.schema !== 'session-performance/v1' || !Array.isArray(performance.attempts)) return null;
    const groups = new Map();
    let unattributedUsageRows = 0;
    performance.attempts.forEach(function (attempt) {
      const taskId = attempt.kind === 'lead_turn' ? attempt.runId || attempt.taskId : attempt.taskId;
      const assignmentId = attempt.assignmentId || null;
      if (!taskId && !assignmentId) {
        unattributedUsageRows += 1;
        return;
      }
      const key = assignmentId ? JSON.stringify(['assignment', assignmentId]) : JSON.stringify(['task', taskId || null]);
      if (!groups.has(key)) groups.set(key, {
        taskId: taskId || null, assignmentId: assignmentId, round: attempt.round,
        role: attempt.role, models: {}, input: [], cached: [], output: [], totals: [], elapsed: [], entryIds: [], attempts: 0, known: 0, timed: 0
      });
      const group = groups.get(key);
      if (!group.taskId && taskId) group.taskId = taskId;
      if (typeof attempt.entryId === 'string') group.entryIds.push(attempt.entryId);
      group.attempts += 1;
      const tokens = attempt.tokens || {};
      if (attempt.model) {
        const m = group.models[attempt.model] || (group.models[attempt.model] = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
        ['inputTokens', 'cachedInputTokens', 'outputTokens'].forEach(function (key) { if (finite(tokens[key]) !== null) m[key] += tokens[key]; });
      }
      if (finite(attempt.elapsedMs) !== null) {
        group.elapsed.push(attempt.elapsedMs);
        group.timed += 1;
      }
      for (const [value, field] of [[tokens.inputTokens, 'input'], [tokens.cachedInputTokens, 'cached'], [tokens.outputTokens, 'output']]) {
        if (finite(value) !== null) group[field].push(value);
      }
      const total = finite(tokens.totalTokens) !== null ? tokens.totalTokens
        : finite(tokens.inputTokens) !== null && finite(tokens.outputTokens) !== null
          ? tokens.inputTokens + tokens.outputTokens : null;
      if (total !== null) { group.totals.push(total); group.known += 1; }
    });
    const sum = function (values) { return values.length ? values.reduce(function (total, value) { return total + value; }, 0) : null; };
    const tasks = [...groups.values()].map(function (group) { return {
      taskId: group.taskId, assignmentId: group.assignmentId, round: group.round, role: group.role,
      totalTokens: sum(group.totals), inputTokens: sum(group.input), cachedInputTokens: sum(group.cached),
      outputTokens: sum(group.output), unknownTokenRows: group.attempts - group.known,
      elapsedMs: sum(group.elapsed), unknownTimeRows: group.attempts - group.timed,
      entryIds: group.entryIds, attempts: group.attempts, models: group.models
    }; });
    return { tasks: tasks, unattributedUsageRows: unattributedUsageRows };
  }
  function liveCoversPersistedTask(snapshotTask, liveTask) {
    if (!Array.isArray(snapshotTask.entryIds) || !snapshotTask.entryIds.length || !Array.isArray(liveTask.entryIds)) return false;
    const liveIds = new Set(liveTask.entryIds);
    return snapshotTask.entryIds.every(function (entryId) { return typeof entryId === 'string' && liveIds.has(entryId); });
  }
  function taskHasKnownTokens(task) {
    const tokens = normalizeTask(task);
    return [tokens.totalTokens, tokens.inputTokens, tokens.cachedInputTokens, tokens.outputTokens].some(function (value) { return finite(value) !== null; });
  }
  function missingAttemptCount(snapshotTask, liveTask) {
    const expected = finite(snapshotTask.attempts);
    return expected === null ? 0 : Math.max(0, expected - liveTask.attempts);
  }
  function liveCoversPersistedSession(snapshot, live, usage) {
    const snapshotTasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    if (!snapshotTasks.length || live.unattributedUsageRows) return false;
    const liveByKey = new Map(live.tasks.map(function (task) { return [JSON.stringify([
      task.assignmentId ? 'assignment' : 'task', task.assignmentId || task.taskId || null
    ]), task]; }));
    if (liveByKey.size !== snapshotTasks.length) return false;
    for (const task of snapshotTasks) {
      const key = task.assignmentId || task.assignment_id
        ? JSON.stringify(['assignment', task.assignmentId || task.assignment_id])
        : JSON.stringify(['task', task.taskId || task.task_id || null]);
      const liveTask = liveByKey.get(key);
      if (!liveTask || !liveCoversPersistedTask(task, liveTask)) return false;
      if (!Array.isArray(task.entryIds) || !Array.isArray(liveTask.entryIds)
        || task.entryIds.length !== liveTask.entryIds.length
        || new Set(task.entryIds).size !== task.entryIds.length
        || new Set(liveTask.entryIds).size !== liveTask.entryIds.length) return false;
      const expectedAttempts = finite(task.attempts);
      if (expectedAttempts !== null && expectedAttempts !== liveTask.attempts) return false;
    }
    const snapshotAttempts = finite(snapshot.total && snapshot.total.attempts);
    const liveAttempts = finite(usage && usage.total && usage.total.attempts);
    return snapshotAttempts === null || liveAttempts === null || snapshotAttempts === liveAttempts;
  }
  function mergeLiveTokenData(snapshot, usage) {
    const live = liveTokenTasks(usage && usage.performance);
    if (!live) return snapshot;
    const merged = Object.assign({}, snapshot, { tasks: (snapshot.tasks || []).map(function (task) { return Object.assign({}, task); }) });
    const keyOf = function (task) {
      const assignmentId = task.assignmentId || task.assignment_id || null;
      return assignmentId
        ? JSON.stringify(['assignment', assignmentId])
        : JSON.stringify(['task', task.taskId || task.task_id || null]);
    };
    const byKey = new Map(merged.tasks.map(function (task) { return [keyOf(task), task]; }));
    live.tasks.forEach(function (task) {
      const key = keyOf(task);
      let target = byKey.get(key);
      if (!target) {
        target = Object.assign({ state: null, timingKind: 'measured' }, task);
        merged.tasks.push(target);
        byKey.set(key, target);
      } else {
        const complete = liveCoversPersistedTask(target, task);
        const missingAttempts = missingAttemptCount(target, task);
        if (!taskHasKnownTokens(target) || complete) {
          target.totalTokens = task.totalTokens;
          target.inputTokens = task.inputTokens;
          target.cachedInputTokens = task.cachedInputTokens;
          target.outputTokens = task.outputTokens;
          target.models = task.models;
          target.unknownTokenRows = task.unknownTokenRows + missingAttempts;
        }
        const hasPersistedMeasuredTime = finite(target.elapsedMs) !== null && target.timingKind !== 'lifecycle';
        const canUpgradeLifecycle = target.timingKind === 'lifecycle';
        if ((!hasPersistedMeasuredTime || complete || canUpgradeLifecycle) && finite(task.elapsedMs) !== null) {
          target.elapsedMs = task.elapsedMs;
          target.unknownTimeRows = task.unknownTimeRows + missingAttempts;
          target.timingKind = 'measured';
        } else if (!hasPersistedMeasuredTime && !canUpgradeLifecycle) {
          target.unknownTimeRows = task.unknownTimeRows + missingAttempts;
          target.timingKind = 'measured';
        }
      }
    });
    if (usage && usage.total) {
      merged.total = Object.assign({}, merged.total);
      const tokenFields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
      const knownSnapshotAggregate = tokenFields.some(function (field) { return finite(merged.total[field]) !== null; });
      const completeCoverage = liveCoversPersistedSession(snapshot, live, usage);
      if (!knownSnapshotAggregate || completeCoverage) {
        for (const field of tokenFields) merged.total[field] = finite(usage.total[field]) !== null ? usage.total[field] : null;
      }
      if ((completeCoverage || finite(merged.total.attempts) === null) && finite(usage.total.attempts) !== null) {
        merged.total.attempts = usage.total.attempts;
      }
      if (completeCoverage || (!knownSnapshotAggregate && finite(snapshot.unattributedUsageRows) === null)) {
        merged.unattributedUsageRows = live.unattributedUsageRows;
      }
    }
    return merged;
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
    const unattributedUsageRows = snapshot ? finite(snapshot.unattributedUsageRows) || 0 : finite(state.usage && state.usage.unknownCount) || 0;
    const unknownTokenRows = partialTokenRows + unattributedUsageRows;
    const unknownTimeRows = tasks.reduce(function (sum, task) { return sum + task.unknownTimeRows; }, 0);
    const timing = timeProvenance(tasks);
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
    $('timeDetail').textContent = timeProvenanceText(timing, tasks.length)
      + (unknownTimeRows ? '; ' + unknownTimeRows + ' timing contribution(s) unknown' : '')
      + (timing.lifecycle ? '; lifecycle spans are not model latency' : '')
      + (timing.measured ? '; measured durations include tools and startup when present' : '')
      + (knownTimes.length ? '; spans may overlap' : '');
    renderMetricChart('taskTokenChart', 'taskTokenCoverage', tasks, 'tokens');
    renderMetricChart('taskTimeChart', 'taskTimeCoverage', tasks, 'time');

    if (!tasks.length) {
      $('taskRows').innerHTML = '<tr><td colspan="8">No task or assignment rows are recorded.</td></tr>';
    } else {
      const roles = aggregateByRole(tasks);
      const ordered = roles.slice().sort(function (a, b) {
        const aActive = /active|working|running|progress|submitted|submitting|starting/i.test(String(a.state));
        const bActive = /active|working|running|progress|submitted|submitting|starting/i.test(String(b.state));
        if (aActive !== bActive) return aActive ? -1 : 1;
        return (b.elapsedMs || 0) - (a.elapsedMs || 0);
      });
      const visible = ordered.slice(0, state.visibleTaskCount);
      $('taskRows').innerHTML = visible.map(function (task) {
        const timingTitle = task.timingKind === 'lifecycle' ? 'dispatch-created to journal-updated lifecycle span, not model latency' : 'recorded execution time, including tools and startup when present';
        const partial = task.unknownTokenRows ? '<small>Partial; ' + esc(task.unknownTokenRows) + ' unknown</small>' : '';
        const timeValue = task.elapsedMs === null ? 'Unknown' : duration(task.elapsedMs) + (task.unknownTimeRows ? '+' : '');
        const priced = roleCost(task.models);
        const models = Object.keys(task.models || {}).join(', ');
        const costNote = priced.unpriced.length ? '<small>No price: ' + esc(priced.unpriced.join(', ')) + '</small>' : models ? '<small>' + esc(models) + '</small>' : '';
        const num = function (v) { return esc(fmt(v)); };
        return '<tr><td><strong>' + esc(task.role) + '</strong><small>' + esc(task.taskCount + (task.taskCount === 1 ? ' task' : ' tasks')) + '</small></td>'
          + '<td class="num">' + num(task.inputTokens) + '</td><td class="num">' + num(task.cachedInputTokens) + '</td><td class="num">' + num(task.outputTokens) + '</td>'
          + '<td class="num">' + esc(task.totalTokens === null ? 'Unknown' : fmt(task.totalTokens) + (task.unknownTokenRows ? '+' : '')) + partial + '</td>'
          + '<td class="num" title="' + esc(timingTitle) + '">' + esc(timeValue) + '</td>'
          + '<td class="num">' + esc(money(priced.cost)) + (task.unknownTokenRows && priced.cost !== null ? '+' : '') + costNote + '</td>'
          + '<td>' + esc(task.state) + '</td></tr>';
      }).join('');
    }
    const roleCount = aggregateByRole(tasks).length;
    $('rowCount').textContent = tasks.length ? 'Showing ' + Math.min(state.visibleTaskCount, roleCount) + ' of ' + roleCount + ' roles (' + tasks.length + ' tasks)' : '';
    $('loadMoreButton').classList.toggle('hidden', roleCount <= state.visibleTaskCount);
    const timestamp = snapshot && snapshot.generatedAt
      ? 'Performance data generated ' + new Date(snapshot.generatedAt).toLocaleString() + '. '
      : '';
    const legacyTokens = !snapshot && state.usage && !state.usage.performance
      ? 'Legacy token fallback provides session and role totals only. ' : '';
    const allRoles = aggregateByRole(tasks);
    let totalCost = 0, anyCost = false;
    allRoles.forEach(function (r) { const c = roleCost(r.models); if (c.cost !== null) { totalCost += c.cost; anyCost = true; } });
    const costNote = anyCost ? 'Estimated OpenAI API cost (standard rates, not subscription spend): ' + money(totalCost) + '. ' : '';
    $('tableNote').textContent = costNote + timestamp + legacyTokens + timeSourceNote(timing);
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
    if (!state.prices) {
      try { state.prices = await requestJson('/ui/model-prices.json', controller.signal); } catch (error) { state.prices = { models: {} }; }
    }
    setMessage('Loading session performance...');
    const base = '/api/projects/' + encodeURIComponent(projectId) + '/sessions/' + encodeURIComponent(sessionId);
    const snapshotUrl = '/ui/metrics/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(sessionId) + '.json';
    let detailedUsageRequest;
    try {
      detailedUsageRequest = requestJson(base + '/usage?details=performance', controller.signal);
      const results = await Promise.allSettled([
        requestJson(snapshotUrl, controller.signal, true),
        detailedUsageRequest
      ]);
      if (requestId !== state.requestId || projectId !== state.projectId || sessionId !== state.sessionId) return;
      const snapshotResult = results[0];
      const usageResult = results[1];
      const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
      const usage = usageResult.status === 'fulfilled' ? usageResult.value : null;
      if (snapshot.schema !== 'task-metrics/v1' || snapshot.contextId !== sessionId) throw new Error('Task metrics snapshot does not match this session');
      state.snapshot = mergeLiveTokenData(snapshot, usage);
      state.usage = usage;
      state.session = null;
      render(state.snapshot);
      setRefreshStatus('Updated ' + new Date().toLocaleTimeString());
      return;
    } catch (snapshotError) {
      if (controller.signal.aborted || requestId !== state.requestId) return;
      state.snapshot = null;
    }
    const results = await Promise.allSettled([
      detailedUsageRequest || requestJson(base + '/usage?details=performance', controller.signal),
      requestJson(base, controller.signal)
    ]);
    if (requestId !== state.requestId || projectId !== state.projectId || sessionId !== state.sessionId) return;
    const usage = results[0].status === 'fulfilled' ? results[0].value : null;
    state.usage = usage;
    state.session = results[1].status === 'fulfilled' ? results[1].value : null;
    if (usage && usage.performance && usage.performance.schema === 'session-performance/v1') {
      state.snapshot = mergeLiveTokenData({
        schema: 'task-metrics/v1', generatedAt: usage.performance.generatedAt, contextId: sessionId,
        total: usage.total, tasks: lifecycleTasks()
      }, usage);
      render(state.snapshot);
      if (!state.session) {
        $('pageMessage').textContent = 'Partial data: task lifecycle data is unavailable.';
        $('pageMessage').classList.remove('hidden');
      }
      setRefreshStatus('Updated ' + new Date().toLocaleTimeString());
      return;
    }
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
