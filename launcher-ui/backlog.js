'use strict';
(function () {
  const selector = document.getElementById('backlogObjective');
  const status = document.getElementById('backlogStatus');
  const rows = document.getElementById('backlogRows');
  const next = document.getElementById('backlogNext');
  const home = document.getElementById('backlogHome');
  const refreshButton = document.getElementById('backlogRefresh');
  let projectId = null;
  let sessionId = null;
  let selectedObjectiveId = null;
  let cursor = '';
  let selectionGeneration = 0;
  let requestGeneration = 0;
  let objectiveRequestGeneration = 0;
  let pageBusy = false;
  let objectiveList = [];
  let messageSequence = 0;
  const steeringRecords = new Map();
  let activeSteeringKey = null;
  let activeSteeringRecord = null;
  let loadedPages = 0;
  const MAX_LOADED_PAGES = 10;

  function el(id) { return document.getElementById(id); }
  function text(id, value) { el(id).textContent = value == null ? 'Unknown' : String(value); }
  function currentLocation() {
    const params = new URLSearchParams(window.location.search);
    return { projectId: params.get('project'), sessionId: params.get('session') };
  }
  function clearView(message) {
    rows.textContent = '';
    rows.appendChild(emptyRow(message));
    ['readyCount', 'blockedCount', 'unknownCount', 'activeCount', 'projectActiveCount'].forEach(id => text(id, '-'));
    text('configuredCapacity', 'Unknown'); text('effectiveCapacity', 'Unknown');
    text('plannerSummary', 'Unknown'); text('inboxSummary', 'Unknown');
    loadedPages = 0;
    renderReasonGroup('idleKnown', [], 'No known blocker reported.');
    renderReasonGroup('idleUnknown', [], 'Unknown.');
    el('roleOccupancy').textContent = 'Unknown';
  }
  function emptyRow(message) {
    const row = document.createElement('tr');
    const cell = document.createElement('td'); cell.colSpan = 6; cell.textContent = message; row.appendChild(cell);
    return row;
  }
  function appendTask(task) {
    const row = document.createElement('tr');
    const why = [];
    if (task.blockedReason) why.push(task.blockedReason.replace(/_/g, ' '));
    (task.dependencyReasons || []).forEach(dep => why.push('Dependency ' + dep.predecessorId + (dep.kind ? ' (' + dep.kind + ')' : '') + ': ' + (dep.state || 'unknown') + '. ' + (dep.reason || dep.detail || 'Acceptance evidence unavailable.')));
    if (Array.isArray(task.resourceClaims) && task.resourceClaims.length) why.push('Resource claims: ' + task.resourceClaims.join(', ') + ' (runtime conflict policy unknown)');
    if (!why.length && task.readiness === 'ready') why.push('Dependencies have persisted trusted success evidence. Runtime admission may still block this task.');
    if (!why.length && (task.state === 'active' || task.state === 'running' || task.readiness === 'active')) why.push('A persisted claim owns this task.');
    const attempts = (task.attempts || []).map(attempt => {
      const fields = [attempt.attemptId, attempt.state, attempt.threadId && ('thread ' + attempt.threadId), attempt.contextId && ('provider context ' + attempt.contextId), attempt.selectedSettingsKnown ? 'settings pinned' : 'settings unknown', attempt.tokenUsage ? 'token usage recorded' : 'token usage unknown'];
      const waits = attempt.waits || {};
      const timing = (value) => typeof value === 'number' && Number.isFinite(value) ? value + ' ms' : 'Unknown';
      fields.push('Backlog creation to first claim (includes dependency and control wait): ' + timing(waits.backlogMs));
      fields.push('Writer admission acquisition: ' + timing(waits.writerMs));
      fields.push('Provider startup to turn start: ' + timing(waits.providerMs));
      fields.push('Terminal to durable settlement (includes checks and publication): ' + timing(waits.settlementMs));
      return fields.filter(Boolean).join(' / ');
    });
    const taskLabel = task.title && task.title !== task.taskId ? task.title + '\n' + task.taskId : task.taskId;
    [taskLabel, task.state, task.readiness, task.role, why.join('\n') || 'No known blocker', attempts.join('\n') || 'No attempts'].forEach(value => {
      const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
    });
    rows.appendChild(row);
  }
  function renderReasonGroup(id, items, emptyMessage) {
    const root = el(id);
    root.textContent = '';
    const heading = document.createElement('h3'); heading.textContent = id === 'idleKnown' ? 'Known' : 'Unknown'; root.appendChild(heading);
    if (!items.length) { const p = document.createElement('p'); p.textContent = emptyMessage; root.appendChild(p); return; }
    const list = document.createElement('ul');
    items.forEach(item => { const li = document.createElement('li'); li.textContent = item.detail || item.reason.replace(/_/g, ' '); list.appendChild(li); });
    root.appendChild(list);
  }
  function renderCapacity(data) {
    const capacity = data.capacity;
    if (!capacity) { text('projectActiveCount', 'Unknown'); text('configuredCapacity', 'Unknown'); text('effectiveCapacity', 'Unknown'); el('roleOccupancy').textContent = 'Unknown'; return; }
    text('projectActiveCount', capacity.projectActive);
    text('configuredCapacity', capacity.configuredWorkerLimit == null ? 'Unknown' : String(capacity.configuredWorkerLimit) + ' configured slots');
    text('effectiveCapacity', capacity.effectiveRuntimeLimit == null ? 'Unknown' : String(capacity.effectiveRuntimeLimit));
    const roles = Object.entries(capacity.byRole || {});
    if (!roles.length) { el('roleOccupancy').textContent = 'No role capacity data.'; return; }
    const list = document.createElement('ul');
    roles.forEach(([role, count]) => {
      const item = document.createElement('li');
      item.textContent = role + ': ' + count.active + ' project claims / ' + (count.configuredLimit == null ? 'unknown' : count.configuredLimit + ' configured slots');
      list.appendChild(item);
    });
    el('roleOccupancy').textContent = ''; el('roleOccupancy').appendChild(list);
  }
  function render(data, reset) {
    text('readyCount', data.counts.ready); text('blockedCount', data.counts.blocked);
    text('unknownCount', data.counts.unknown);
    text('activeCount', data.counts.active); renderCapacity(data);
    const planner = data.planner;
    text('plannerSummary', planner?.available ? ((planner.inFlight ? 'Active' : planner.activeTurn ? 'Unknown turn' : 'Idle') + ' for session ' + planner.sessionId + '; objective attribution unavailable') : 'Unknown');
    text('inboxSummary', data.inbox?.available ? (data.inbox.wakeup ? 'Work pending' : 'Clear') : 'Unknown');
    renderReasonGroup('idleKnown', data.idleReasons?.known || [], 'No known blocker reported.');
    renderReasonGroup('idleUnknown', data.idleReasons?.unknown || [], 'No unknown causes reported.');
    if (reset) rows.textContent = '';
    if (data.tasks.length) data.tasks.forEach(appendTask);
    else if (reset) rows.appendChild(emptyRow('No tasks in this page.'));
    cursor = data.nextCursor || '';
    next.disabled = !cursor || loadedPages >= MAX_LOADED_PAGES;
  }
  function steeringUrl(project, objective, session) {
    const url = new URL('/api/projects/' + encodeURIComponent(project) + '/delivery/control', window.location.origin);
    url.searchParams.set('objectiveId', objective);
    url.searchParams.set('sessionId', session);
    return url.pathname + url.search;
  }
  function steeringScopeKey(project, session, objective) { return JSON.stringify([project, session, objective]); }
  function getSteeringRecord(key) {
    if (!steeringRecords.has(key)) steeringRecords.set(key, {
      key, draft: '', retryBody: null, pending: false, status: 'Owner steering is available for an active concurrent objective.',
      reply: '', control: null, controlGeneration: 0, controlPending: false, controlMessage: '',
    });
    return steeringRecords.get(key);
  }
  function activateSteeringScope() {
    const key = projectId && sessionId && selectedObjectiveId ? steeringScopeKey(projectId, sessionId, selectedObjectiveId) : null;
    activeSteeringKey = key;
    activeSteeringRecord = key ? getSteeringRecord(key) : null;
    const record = activeSteeringRecord;
    el('steeringText').value = record ? record.draft : '';
    el('steeringStatus').textContent = record ? record.status : 'Select an active concurrent objective to message its lead.';
    el('steeringReply').textContent = record ? record.reply : '';
    renderControl(record);
  }
  function isActiveSteeringScope(key) { return key !== null && key === activeSteeringKey; }
  function renderControl(record) {
    if (!record) {
      el('steeringSend').disabled = true;
      el('ownerPause').disabled = true;
      el('ownerResume').disabled = true;
      el('ownerCancel').disabled = true;
      el('ownerControlStatus').textContent = 'Select an active concurrent objective to pause, resume, or cancel it.';
      return;
    }
    if (record !== activeSteeringRecord) return;
    const control = record && record.control;
    const controlState = control && control.revisions ? control : null;
    const disposition = controlState?.disposition;
    const controllerAvailable = controlState?.controller?.state === 'available' && controlState.controller.running === true;
    const pauseable = ['planning', 'executing', 'recovering', 'waiting_budget', 'waiting_owner', 'blocked_technical'].includes(disposition);
    el('ownerPause').disabled = !controllerAvailable || !pauseable || record.controlPending;
    el('ownerResume').disabled = !controllerAvailable || disposition !== 'paused_owner' || record.controlPending;
    const cancelable = ['planning', 'executing', 'recovering', 'waiting_budget', 'waiting_owner', 'blocked_technical', 'paused_owner'].includes(disposition);
    el('ownerCancel').disabled = !controllerAvailable || !cancelable || record.controlPending;
    const durableControlText = disposition === 'paused_owner' ? 'Objective is paused by the owner.'
      : disposition === 'draining' ? 'Cancellation is draining; downstream effects are still being reconciled.'
      : disposition === 'canceled' ? 'Objective is canceled.'
        : ['accepted', 'partial'].includes(disposition) ? 'Objective is complete.'
          : disposition ? 'Objective control: ' + disposition.replace(/_/g, ' ') + '.'
            : 'Current objective control is unavailable.';
    el('ownerControlStatus').textContent = record.controlPending ? 'Applying owner control...'
      : [record.controlMessage, durableControlText].filter(Boolean).join(' ');
    const send = el('steeringSend');
    const active = controlState && ['planning', 'executing', 'recovering'].includes(controlState.disposition);
    send.disabled = !active || record.pending || !(record.retryBody || record.draft.trim());
    if (!active) {
      record.status = control?.reason === 'project_stopped'
        ? 'Steering is disabled while the project server is stopped.'
        : control?.reason === 'owner_control_unavailable' || control?.reason === 'delivery_control_unavailable'
          ? 'Owner steering is unavailable for this project.'
          : 'Steering is available only for an active concurrent delivery objective.';
    } else {
      const inbox = control.inbox || [];
      const latest = inbox.find(item => item.messageId === (record.retryBody && record.retryBody.messageId)) || inbox[0];
      if (!record.pending && latest) record.status = latest.state === 'received'
        ? 'Latest message: received (received, not yet applied).'
        : 'Latest message: ' + latest.state + '.';
      else if (!record.pending && !latest && !record.retryBody) record.status = 'No owner message has been sent. Current delivery revisions are ready.';
      if (latest && latest.result && latest.result.text) record.reply = String(latest.result.text).slice(0, 500);
      else if (!latest && !record.pending) record.reply = '';
    }
    if (record) {
      if (!record.pending && control && !controlState) {
        record.status = control.reason === 'project_stopped'
          ? 'Steering is disabled while the project server is stopped.'
          : control.reason === 'owner_control_unavailable' || control.reason === 'delivery_control_unavailable'
            ? 'Owner steering is unavailable for this project.'
            : 'Steering is available only for an active concurrent delivery objective.';
      }
      if (record === activeSteeringRecord) {
        el('steeringStatus').textContent = record.pending ? 'Sending message...' : record.status;
        el('steeringReply').textContent = record.reply;
      }
    }
  }
  async function loadControl(record = activeSteeringRecord, key = activeSteeringKey) {
    if (!record || !key) return;
    const token = ++record.controlGeneration;
    const [project, session, objective] = JSON.parse(key);
    if (isActiveSteeringScope(key)) el('steeringStatus').textContent = 'Checking owner steering availability...';
    try {
      const response = await fetch(steeringUrl(project, objective, session));
      const data = await response.json();
      if (token !== record.controlGeneration) return;
      record.control = response.ok ? data : { available: false, reason: 'owner_control_unavailable' };
      renderControl(record);
    } catch (_) {
      if (token !== record.controlGeneration) return;
      record.control = { available: false, reason: 'owner_control_unavailable' };
      renderControl(record);
    }
  }
  function steeringAckMatches(ack, body) {
    return ack && ack.engine === 'concurrent-v1' && ack.runId === body.runId && ack.projectId === body.projectId
      && ack.sessionId === body.sessionId && ack.objectiveId === body.objectiveId && ack.messageId === body.messageId
      && ack.acknowledged === true && ['received', 'applied', 'blocked'].includes(ack.state);
  }
  function ownerControlAckMatches(ack, body, action) {
    if (action === 'cancel') return ack && ack.engine === 'concurrent-v1' && ack.runId === body.runId
      && ack.projectId === body.projectId && ack.sessionId === body.sessionId && ack.objectiveId === body.objectiveId
      && ack.action === 'cancel' && ack.acknowledged === true
      && ((ack.state === 'requested' && ack.disposition === 'draining') || (ack.state === 'applied' && ack.disposition === 'canceled'))
      && ['draining', 'canceled'].includes(ack.disposition) && Number.isSafeInteger(ack.revisions?.controlRevision)
      && ack.revisions.controlRevision > body.expectedControlRevision;
    const expectedDisposition = action === 'pause' ? 'paused_owner' : 'executing';
    return ack && ack.engine === 'concurrent-v1' && ack.runId === body.runId && ack.projectId === body.projectId
      && ack.sessionId === body.sessionId && ack.objectiveId === body.objectiveId && ack.action === action
      && ack.acknowledged === true && ack.state === 'applied' && ack.disposition === expectedDisposition
      && Number.isSafeInteger(ack.revisions?.controlRevision)
      && ack.revisions.controlRevision > body.expectedControlRevision;
  }
  async function changeOwnerControl(action) {
    const record = activeSteeringRecord;
    const key = activeSteeringKey;
    if (!record || record.controlPending || !record.control?.revisions) return;
    const snapshot = record.control;
    const body = { runId: snapshot.runId, projectId: snapshot.projectId, sessionId: snapshot.sessionId,
      objectiveId: snapshot.objectiveId, expectedControlRevision: snapshot.revisions.controlRevision };
    record.controlPending = true;
    record.controlMessage = '';
    renderControl(record);
    try {
      const response = await fetch('/api/projects/' + encodeURIComponent(body.projectId) + '/delivery/control/' + action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      record.controlPending = false;
      if (response.status === 409) {
        record.controlMessage = 'Delivery changed. Current control status was refreshed; check it before another action.';
        renderControl(record);
        await loadControl(record, key);
        return;
      }
      if (!response.ok || !ownerControlAckMatches(result, body, action)) {
        record.controlMessage = 'Owner control outcome is unknown. Durable status was refreshed; check it before another action.';
        renderControl(record);
        await loadControl(record, key);
        return;
      }
      record.controlMessage = action === 'cancel'
        ? result.disposition === 'canceled' ? 'Cancellation completed at control revision ' + result.revisions.controlRevision + '.'
          : 'Cancellation requested at control revision ' + result.revisions.controlRevision + '; downstream effects are still being reconciled.'
        : (action === 'pause' ? 'Pause' : 'Resume') + ' applied at control revision ' + result.revisions.controlRevision + '.';
      record.control = result;
      renderControl(record);
      await loadControl(record, key);
    } catch (_) {
      record.controlPending = false;
      record.controlMessage = 'Owner control outcome is unknown. Durable status was refreshed; check it before another action.';
      renderControl(record);
      await loadControl(record, key);
    }
  }
  async function sendSteering(event) {
    event.preventDefault();
    const record = activeSteeringRecord;
    const key = activeSteeringKey;
    if (!record || record.pending) return;
    record.draft = el('steeringText').value;
    if (!record.retryBody) {
      const snapshot = record.control;
      if (!snapshot || !snapshot.revisions || !record.draft.trim()) return;
      messageSequence += 1;
      const [project, session, objective] = JSON.parse(key);
      record.retryBody = { runId: snapshot.runId, projectId: project, sessionId: session, objectiveId: objective,
        messageId: 'web-' + Date.now() + '-' + messageSequence, text: record.draft.trim(),
        expectedPlanRevision: snapshot.revisions.planRevision, expectedGoalRevision: snapshot.revisions.goalRevision,
        expectedControlRevision: snapshot.revisions.controlRevision };
    }
    const body = { ...record.retryBody };
    const project = body.projectId;
    record.pending = true;
    renderControl(record);
    try {
      const response = await fetch('/api/projects/' + encodeURIComponent(project) + '/delivery/steer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      record.pending = false;
      if (response.status === 409) {
        record.status = 'Delivery changed. Your draft is kept; refresh status before retrying.';
        record.retryBody = null;
        renderControl(record);
        await loadControl(record, key);
        return;
      }
      if (!response.ok) {
        record.status = result.error || 'Message status is unknown. Retry will reuse the original request.';
        renderControl(record);
        return;
      }
      if (!steeringAckMatches(result, body)) {
        record.status = 'Message acknowledgement could not be verified. Retry will reuse the original request.';
        renderControl(record);
        return;
      }
      record.status = result.state === 'received'
        ? 'Message received by the owner inbox. It has not necessarily been applied.'
        : 'Message status: ' + result.state + '.';
      if (record.draft === body.text) {
        record.draft = '';
        if (record === activeSteeringRecord) el('steeringText').value = '';
      }
      record.retryBody = null;
      renderControl(record);
      await loadControl(record, key);
    } catch (_) {
      record.pending = false;
      record.status = 'Message status is unknown. Retry will reuse the original request.';
      renderControl(record);
    }
  }
  async function loadPage(reset) {
    if (!projectId || !selectedObjectiveId) return;
    if (pageBusy && !reset) return;
    const token = ++requestGeneration;
    const selection = selectionGeneration;
    const requestedProject = projectId;
    const requestedSession = sessionId;
    const requestedObjective = selectedObjectiveId;
    const requestedCursor = reset ? '' : cursor;
    pageBusy = true;
    if (reset) { cursor = ''; loadedPages = 0; next.disabled = true; rows.textContent = ''; }
    status.textContent = 'Refreshing read-only delivery state...';
    const url = new URL('/api/projects/' + encodeURIComponent(requestedProject) + '/delivery/backlog', window.location.origin);
    url.searchParams.set('objectiveId', requestedObjective);
    if (requestedSession) url.searchParams.set('sessionId', requestedSession);
    if (requestedCursor) url.searchParams.set('afterCursor', requestedCursor);
    try {
      const response = await fetch(url.pathname + url.search);
      const data = await response.json();
      const locationNow = currentLocation();
      if (token !== requestGeneration || selection !== selectionGeneration || requestedProject !== projectId || requestedSession !== sessionId
        || requestedProject !== locationNow.projectId || requestedSession !== locationNow.sessionId || requestedObjective !== selectedObjectiveId) return;
      if (!response.ok) throw new Error(data.error || 'Delivery state unavailable');
      render(data, reset);
      loadedPages = reset ? 1 : loadedPages + 1;
      next.disabled = !cursor || loadedPages >= MAX_LOADED_PAGES;
      status.textContent = data.available ? (cursor && loadedPages >= MAX_LOADED_PAGES ? 'Read-only delivery state refreshed; showing the first ' + MAX_LOADED_PAGES + ' loaded pages.' : 'Read-only delivery state for selected objective; refreshed just now.') : 'Delivery state unavailable: ' + (data.unavailableReason || 'unknown').replace(/_/g, ' ') + '.';
      return true;
    } catch (error) {
      if (token === requestGeneration && selection === selectionGeneration) status.textContent = error.message;
      return false;
    } finally { if (token === requestGeneration) pageBusy = false; }
  }
  async function refreshLoadedPages() {
    const depth = Math.min(Math.max(loadedPages, 1), MAX_LOADED_PAGES);
    const selection = selectionGeneration;
    const objective = selectedObjectiveId;
    if (!await loadPage(true)) return;
    for (let page = 1; page < depth && cursor; page += 1) {
      if (selection !== selectionGeneration || objective !== selectedObjectiveId) return;
      if (!await loadPage(false)) return;
    }
  }
  async function refreshObjectives({ preserve = true } = {}) {
    const location = currentLocation();
    if (location.projectId !== projectId || location.sessionId !== sessionId) {
      projectId = location.projectId; sessionId = location.sessionId;
      selectionGeneration += 1; requestGeneration += 1; cursor = ''; pageBusy = false;
      selectedObjectiveId = null; objectiveList = [];
      activateSteeringScope();
      clearView('Select a delivery objective.');
    }
    const homeUrl = new URL('/', window.location.origin);
    if (projectId) homeUrl.searchParams.set('project', projectId);
    if (sessionId) homeUrl.searchParams.set('session', sessionId);
    home.href = homeUrl.pathname + homeUrl.search;
    if (!projectId) { selector.disabled = true; status.textContent = 'Select a project in the control plane first.'; selector.textContent = ''; selector.appendChild(optionWithValue('No project selected', '')); return; }
    const requestedProject = projectId;
    const requestedSession = sessionId;
    const token = ++objectiveRequestGeneration;
    const selection = selectionGeneration;
    const url = new URL('/api/projects/' + encodeURIComponent(requestedProject) + '/delivery/objectives', window.location.origin);
    if (requestedSession) url.searchParams.set('sessionId', requestedSession);
    try {
      const response = await fetch(url.pathname + url.search);
      const data = await response.json();
      const locationNow = currentLocation();
      if (token !== objectiveRequestGeneration || selection !== selectionGeneration || requestedProject !== projectId || requestedSession !== sessionId
        || requestedProject !== locationNow.projectId || requestedSession !== locationNow.sessionId) return;
      if (!response.ok) throw new Error(data.error || 'Objectives unavailable');
      objectiveList = data.objectives || [];
      const previous = preserve ? selectedObjectiveId : null;
      const selected = objectiveList.some(item => item.objectiveId === previous) ? previous : (objectiveList[0]?.objectiveId || null);
      const changed = selected !== selectedObjectiveId;
      if (changed) { selectedObjectiveId = selected; selectionGeneration += 1; requestGeneration += 1; cursor = ''; }
      selector.textContent = '';
      objectiveList.forEach(item => {
        const option = document.createElement('option'); option.value = item.objectiveId;
        option.textContent = (item.sessionId ? 'Session ' + item.sessionId + ' / ' : '') + item.disposition + ' / objective ' + item.objectiveId.slice(-8);
        selector.appendChild(option);
      });
      if (!objectiveList.length) {
        selector.disabled = true; selector.appendChild(optionWithValue('No objectives available', ''));
        selectedObjectiveId = null; selectionGeneration += 1; requestGeneration += 1; activateSteeringScope(); clearView('No delivery objectives are available for this selection.');
        status.textContent = data.available ? 'No delivery objectives are available for this project/session.' : 'Concurrent delivery data is unavailable.';
        return;
      }
      selector.disabled = false; selector.value = selectedObjectiveId;
      if (changed) { activateSteeringScope(); await loadPage(true); await loadControl(); }
      else if (selectedObjectiveId) { await refreshLoadedPages(); await loadControl(); }
    } catch (error) {
      if (token === objectiveRequestGeneration && selection === selectionGeneration) status.textContent = error.message;
    }
  }
  function optionWithValue(label, value) { const option = document.createElement('option'); option.textContent = label; option.value = value; return option; }
  selector.addEventListener('change', () => {
    selectedObjectiveId = selector.value || null;
    selectionGeneration += 1; requestGeneration += 1; cursor = '';
    activateSteeringScope();
    clearView('Loading selected objective...');
    loadPage(true);
    loadControl();
  });
  el('steeringText').addEventListener('input', () => {
    if (activeSteeringRecord) activeSteeringRecord.draft = el('steeringText').value;
    renderControl(activeSteeringRecord);
  });
  el('steeringForm').addEventListener('submit', sendSteering);
  el('ownerPause').addEventListener('click', () => changeOwnerControl('pause'));
  el('ownerResume').addEventListener('click', () => changeOwnerControl('resume'));
  el('ownerCancel').addEventListener('click', () => changeOwnerControl('cancel'));
  next.addEventListener('click', () => loadPage(false));
  refreshButton.addEventListener('click', () => refreshObjectives());
  window.addEventListener('popstate', () => refreshObjectives({ preserve: false }));
  refreshObjectives({ preserve: false });
  window.setInterval(() => refreshObjectives(), 5000);
})();
