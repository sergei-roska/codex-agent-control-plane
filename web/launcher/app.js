(() => {
  'use strict';

  const API = {
    status: '/api/launcher/status',
    start: '/api/launcher/start',
    stop: '/api/launcher/stop',
    open: '/api/launcher/open',
  };
  const VALID_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);
  const POLL_INTERVAL_MS = 2000;
  const token = document.querySelector('meta[name="launcher-token"]')?.content || '';
  const elements = {
    connection: document.getElementById('connection'),
    connectionLabel: document.getElementById('connection-label'),
    form: document.getElementById('start-form'),
    projectPath: document.getElementById('project-path'),
    recentRow: document.getElementById('recent-row'),
    recentProjects: document.getElementById('recent-projects'),
    port: document.getElementById('port'),
    start: document.getElementById('start-button'),
    statePill: document.getElementById('state-pill'),
    empty: document.getElementById('empty-state'),
    emptyTitle: document.getElementById('empty-title'),
    emptyDescription: document.getElementById('empty-description'),
    details: document.getElementById('server-details'),
    project: document.getElementById('detail-project'),
    path: document.getElementById('detail-path'),
    ref: document.getElementById('detail-ref'),
    portValue: document.getElementById('detail-port'),
    actions: document.getElementById('server-actions'),
    open: document.getElementById('open-button'),
    stop: document.getElementById('stop-button'),
    stopHelp: document.getElementById('stop-help'),
    feedback: document.getElementById('feedback'),
  };

  let connected = false;
  let actionInProgress = false;
  let currentState = 'unknown';
  let currentSession = null;
  let feedbackSource = '';
  let lastOperationalFeedback = { message: '', isError: false };
  let polling = false;

  function setFeedback(message = '', isError = false, source = 'operation') {
    // Pairing tokens must never appear in page text, even if a server error echoes a URL.
    const safeMessage = String(message).replace(/#pair=[A-Za-z0-9_-]+/g, '#pair=[hidden]');
    if (source === 'offline') {
      if (feedbackSource !== 'offline') {
        lastOperationalFeedback = {
          message: elements.feedback.textContent,
          isError: elements.feedback.classList.contains('is-error'),
        };
      }
    } else {
      lastOperationalFeedback = { message: safeMessage, isError };
    }
    elements.feedback.textContent = safeMessage;
    elements.feedback.classList.toggle('is-error', isError);
    feedbackSource = safeMessage ? source : '';
  }

  function errorMessage(error, fallback) {
    const message = error?.error?.message;
    return typeof message === 'string' && message.trim() ? message.trim() : fallback;
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        'X-Launcher-Token': token,
        ...options.headers,
      },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = new Error(errorMessage(body, `Request failed (${response.status}).`));
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function setConnected(value) {
    const wasConnected = connected;
    connected = value;
    elements.connection.classList.toggle('is-online', value);
    elements.connection.classList.toggle('is-offline', !value);
    elements.connectionLabel.textContent = value ? 'Launcher online' : 'Launcher offline';
    if (value && !wasConnected && feedbackSource === 'offline') {
      setFeedback(lastOperationalFeedback.message, lastOperationalFeedback.isError);
    }
    renderControls();
  }

  function setStatePill(state, offline = false) {
    const label = offline ? 'Offline' : state === 'unknown' ? 'Checking' : state;
    elements.statePill.textContent = label;
    elements.statePill.className = 'state-pill';
    if (offline || state === 'error') elements.statePill.classList.add('state-error');
    else if (state === 'running') elements.statePill.classList.add('state-running');
    else if (state === 'starting' || state === 'stopping') elements.statePill.classList.add('state-busy');
  }

  function showTransientState(state) {
    if (state === 'starting') {
      elements.empty.hidden = false;
      elements.details.hidden = true;
      elements.emptyTitle.textContent = 'Starting project server';
      elements.emptyDescription.textContent = 'The dashboard will open when ready.';
    } else if (state === 'stopping' && !currentSession?.projectPath) {
      elements.empty.hidden = false;
      elements.details.hidden = true;
      elements.emptyTitle.textContent = 'Stopping project server';
      elements.emptyDescription.textContent = 'Waiting for the server to stop.';
    }
  }

  function projectName(session) {
    if (typeof session?.projectName === 'string' && session.projectName) return session.projectName;
    if (typeof session?.projectPath !== 'string' || !session.projectPath) return '-';
    return session.projectPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || session.projectPath;
  }

  function renderRecentProjects(projects) {
    if (!Array.isArray(projects)) return;
    const currentValue = elements.recentProjects.value;
    while (elements.recentProjects.options.length > 1) elements.recentProjects.remove(1);
    for (const project of projects) {
      if (!project || typeof project.path !== 'string' || !project.path.trim()) continue;
      const option = document.createElement('option');
      option.value = project.path;
      const name = typeof project.name === 'string' && project.name.trim()
        ? project.name.trim()
        : projectName({ projectPath: project.path });
      option.textContent = `${name} - ${project.path}`;
      elements.recentProjects.append(option);
    }
    elements.recentRow.hidden = elements.recentProjects.options.length <= 1;
    if ([...elements.recentProjects.options].some((option) => option.value === currentValue)) {
      elements.recentProjects.value = currentValue;
    }
  }

  function renderSession(session) {
    currentSession = session;
    const state = VALID_STATES.has(session?.status) ? session.status : 'error';
    currentState = state;
    setStatePill(state);
    const hasSession = Boolean(session?.projectPath) && state !== 'stopped';
    const canStop = session?.canStop === true;
    elements.empty.hidden = hasSession;
    elements.details.hidden = !hasSession;
    elements.actions.hidden = state !== 'running' && !canStop;
    elements.open.hidden = state !== 'running';
    elements.stop.hidden = !canStop && state !== 'running';
    elements.stopHelp.hidden = !canStop && state !== 'running';
    if (!hasSession) {
      if (state === 'stopped') {
        elements.emptyTitle.textContent = 'No project server is running.';
        elements.emptyDescription.textContent = 'Choose a folder above to start.';
      } else if (state === 'starting') {
        elements.emptyTitle.textContent = 'Server is starting';
        elements.emptyDescription.textContent = 'Waiting for the project server.';
      } else if (state === 'stopping') {
        elements.emptyTitle.textContent = 'Server is stopping';
        elements.emptyDescription.textContent = 'Waiting for the project server to stop.';
      } else if (state === 'error') {
        elements.emptyTitle.textContent = 'Server could not start';
        elements.emptyDescription.textContent = 'Check the launcher status for details.';
      } else {
        elements.emptyTitle.textContent = 'Server is unavailable';
        elements.emptyDescription.textContent = 'Check the launcher status for details.';
      }
    }

    if (hasSession) {
      elements.project.textContent = projectName(session);
      elements.path.textContent = session.projectPath;
      elements.ref.textContent = typeof session.baseRef === 'string' && session.baseRef ? session.baseRef : '-';
      elements.portValue.textContent = session.port ? String(session.port) : '-';
    }

    if (state === 'error' && session?.error) setFeedback(session.error, true);
    renderControls();
  }

  function renderControls() {
    const pendingState = currentState === 'starting' || currentState === 'stopping';
    const canStop = currentSession?.canStop === true || currentState === 'running';
    const disabled = !connected || actionInProgress || pendingState;
    elements.projectPath.disabled = disabled || canStop;
    elements.recentProjects.disabled = disabled || canStop;
    elements.port.disabled = disabled || canStop;
    elements.start.disabled = disabled || canStop || !['stopped', 'error', 'unknown'].includes(currentState);
    elements.open.disabled = disabled || currentState !== 'running';
    elements.stop.disabled = disabled || !canStop;
  }

  function validateStatus(data) {
    if (!data || typeof data !== 'object' || !VALID_STATES.has(data.status)) {
      throw new Error('The launcher returned an invalid status response.');
    }
    return data;
  }

  async function refreshStatus() {
    if (polling || actionInProgress) return;
    polling = true;
    try {
      const data = validateStatus(await request(API.status));
      setConnected(true);
      renderRecentProjects(data.recentProjects);
      renderSession(data);
    } catch (error) {
      setConnected(false);
      setStatePill('unknown', true);
      elements.empty.hidden = false;
      elements.emptyTitle.textContent = 'Server status unavailable';
      elements.emptyDescription.textContent = 'Cannot reach the launcher.';
      elements.details.hidden = true;
      elements.actions.hidden = true;
      elements.stopHelp.hidden = true;
      setFeedback(error.message || 'Could not reach the launcher. Start it and reload this page.', true, 'offline');
    } finally {
      polling = false;
    }
  }

  function dashboardLocation(pairingUrl) {
    let target;
    try {
      target = new URL(pairingUrl);
    } catch {
      throw new Error('The launcher did not return a valid dashboard link.');
    }
    const activePort = Number(currentSession?.port);
    const targetPort = Number(target.port || '80');
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname)
      || target.username || target.password || target.pathname !== '/dashboard/'
      || !/^#pair=[A-Za-z0-9_-]{1,128}$/.test(target.hash)
      || !Number.isInteger(activePort) || targetPort !== activePort) {
      throw new Error('The launcher returned an unsafe dashboard link.');
    }
    return target.href;
  }

  function openPendingTab(pendingTab, pairingUrl) {
    const location = dashboardLocation(pairingUrl);
    if (pendingTab) {
      pendingTab.location.replace(location);
      return true;
    }
    return false;
  }

  function openBlankTab() {
    try {
      return window.open('about:blank', '_blank');
    } catch {
      return null;
    }
  }

  function setBusy(value) {
    actionInProgress = value;
    renderControls();
  }

  async function startServer(event) {
    event.preventDefault();
    if (!connected || actionInProgress) return;
    const projectPath = elements.projectPath.value.trim();
    const portValue = Number(elements.port.value);
    if (!projectPath) {
      setFeedback('Enter a project folder path.', true);
      elements.projectPath.focus();
      return;
    }
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
      setFeedback('Enter a port from 1 to 65535.', true);
      elements.port.focus();
      return;
    }

    // Reserve a tab during the trusted click so popup blockers do not lose the pairing flow.
    const pendingTab = openBlankTab();
    currentState = 'starting';
    setStatePill(currentState);
    showTransientState(currentState);
    setFeedback('Starting the server...');
    setBusy(true);
    try {
      const result = validateStatus(await request(API.start, {
        method: 'POST',
        body: JSON.stringify({ projectPath, port: portValue }),
      }));
      setConnected(true);
      renderRecentProjects(result.recentProjects);
      renderSession(result);
      if (result.status === 'running' && result.pairingUrl) {
        if (!openPendingTab(pendingTab, result.pairingUrl)) {
          setFeedback('Server started. Use Open dashboard to sign in to this browser.');
        } else {
          setFeedback('Server started. Dashboard is opening in a new tab.');
        }
      } else if (result.status === 'error') {
        if (pendingTab) pendingTab.close();
        setFeedback(result.error || 'The server could not be started.', true);
      } else {
        if (pendingTab) pendingTab.close();
        setFeedback(result.status === 'starting' ? 'Server is starting...' : 'Server status updated.');
      }
    } catch (error) {
      if (pendingTab) pendingTab.close();
      setFeedback(error.message || 'Could not start the server.', true);
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }

  async function openDashboard() {
    if (!connected || actionInProgress || currentState !== 'running') return;
    const pendingTab = openBlankTab();
    setBusy(true);
    setFeedback('Preparing a dashboard sign-in...');
    try {
      const result = await request(API.open, { method: 'POST' });
      const opened = openPendingTab(pendingTab, result?.pairingUrl);
      setFeedback(opened
        ? 'Dashboard is opening in a new tab.'
        : 'Allow pop-ups for this local page, then choose Open dashboard again.');
      if (!opened) setFeedback('Allow pop-ups for this local page, then choose Open dashboard again.', true);
    } catch (error) {
      if (pendingTab) pendingTab.close();
      setFeedback(error.message || 'Could not prepare the dashboard sign-in.', true);
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }

  async function stopServer() {
    if (!connected || actionInProgress
      || (currentState !== 'running' && currentSession?.canStop !== true)) return;
    currentState = 'stopping';
    setStatePill(currentState);
    showTransientState(currentState);
    setBusy(true);
    setFeedback('Stopping the server...');
    try {
      const result = validateStatus(await request(API.stop, { method: 'POST' }));
      setConnected(true);
      renderRecentProjects(result.recentProjects);
      renderSession(result);
      if (result.status === 'error') setFeedback(result.error || 'The server did not stop cleanly.', true);
      else setFeedback(result.status === 'stopped' ? 'Server stopped.' : 'Server is stopping...');
    } catch (error) {
      setFeedback(error.message || 'Could not stop the server.', true);
    } finally {
      setBusy(false);
      refreshStatus();
    }
  }

  elements.form.addEventListener('submit', startServer);
  elements.recentProjects.addEventListener('change', () => {
    if (elements.recentProjects.value) elements.projectPath.value = elements.recentProjects.value;
  });
  elements.open.addEventListener('click', openDashboard);
  elements.stop.addEventListener('click', stopServer);
  refreshStatus();
  window.setInterval(refreshStatus, POLL_INTERVAL_MS);
})();
