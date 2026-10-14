
    function clearLogs() {
      document.getElementById('serverLogsBody').innerText = '';
    }

    // Ctrl+Enter sends the message
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const btn = document.getElementById('sendBtn');
        if (!btn.disabled) sendMessage();
      }
    });

    let serverRunning = false;

    // ---- Session state: a session is one A2A contextId; the open one is bound to the tab (?session=<contextId>)
    let currentSessionId = null;
    let sessionData = null;       // last transcript received from the launcher
    let pendingTurn = null;       // { goal, baseTurns } until the sent message shows up as a turn
    let sending = false;
    let autoOpenLatest = false;
    let renderSignature = '';
    let initialSessionParam = new URLSearchParams(window.location.search).get('session');

    // ---- Tooltips: one shared element; every [data-tooltip] trigger uses it (event delegation).
    // data-tooltip-if-truncated: shown only while the trigger's text is cut off (ellipsis or line clamp).
    const uiTip = document.getElementById('uiTooltip');
    let uiTipTrigger = null;
    let uiTipTimer = 0;

    function setTooltip(el, text, ifTruncated) {
      el.dataset.tooltip = text;
      if (ifTruncated) el.setAttribute('data-tooltip-if-truncated', '');
      else el.removeAttribute('data-tooltip-if-truncated');
    }

    function tooltipNeeded(el) {
      if (!el.dataset.tooltip) return false;
      if (!el.hasAttribute('data-tooltip-if-truncated')) return true;
      return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    }

    // Above the trigger, centered; below it when there is no room above; kept 8px inside the viewport.
    function positionUiTooltip(trigger) {
      const gap = 8;
      const r = trigger.getBoundingClientRect();
      const w = uiTip.offsetWidth;
      const h = uiTip.offsetHeight;
      let top = r.top - h - gap;
      if (top < 8) top = r.bottom + gap;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
      uiTip.style.top = top + 'px';
      uiTip.style.left = left + 'px';
    }

    function showUiTooltip(trigger) {
      clearTimeout(uiTipTimer);
      if (!trigger.isConnected || !tooltipNeeded(trigger)) return;
      uiTipTrigger = trigger;
      uiTip.textContent = trigger.dataset.tooltip;
      positionUiTooltip(trigger);
      uiTip.classList.add('is-visible');
      trigger.setAttribute('aria-describedby', 'uiTooltip');
    }

    function hideUiTooltip() {
      clearTimeout(uiTipTimer);
      if (uiTipTrigger) uiTipTrigger.removeAttribute('aria-describedby');
      uiTipTrigger = null;
      uiTip.classList.remove('is-visible');
    }

    function tooltipTriggerOf(target) {
      return target instanceof Element ? target.closest('[data-tooltip]') : null;
    }

    document.addEventListener('mouseover', function (ev) {
      const trigger = tooltipTriggerOf(ev.target);
      if (!trigger) {
        clearTimeout(uiTipTimer);
        if (uiTipTrigger && !uiTipTrigger.contains(ev.target)) hideUiTooltip();
        return;
      }
      if (trigger === uiTipTrigger) return;
      hideUiTooltip();
      uiTipTimer = setTimeout(function () { showUiTooltip(trigger); }, 250);
    });

    document.addEventListener('mouseout', function (ev) {
      const trigger = tooltipTriggerOf(ev.target);
      if (!trigger || (ev.relatedTarget && trigger.contains(ev.relatedTarget))) return;
      clearTimeout(uiTipTimer);
      if (trigger === uiTipTrigger) hideUiTooltip();
    });

    // Keyboard focus shows the tooltip at once; mouse focus is covered by the hover delay.
    document.addEventListener('focusin', function (ev) {
      const trigger = tooltipTriggerOf(ev.target);
      if (trigger && trigger.matches(':focus-visible')) showUiTooltip(trigger);
    });
    document.addEventListener('focusout', function (ev) {
      if (ev.target === uiTipTrigger) hideUiTooltip();
    });
    document.addEventListener('mousedown', hideUiTooltip);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') hideUiTooltip();
    });
    window.addEventListener('scroll', hideUiTooltip, true);

    // ---- Project binding: each tab is bound to one project (?project=<id>)
    let projectList = [];
    let currentProjectId = null;
    // Token usage of the open session for the team band (contract: GET .../sessions/:contextId/usage)
    let sessionUsage = null;      // last response for usageKey; null when unavailable (404, no endpoint)
    let usageKey = '';
    let usageFetchAt = 0;
    let usageToken = 0;
    let usageSawTerminal = false;

    // Session situation panel (SIT-3): SIT-1 situation of the open session, SIT-2 git status of the project.
    const SITUATION_STEPS = [
      { phase: 'planning', label: 'Planning' },
      { phase: 'working', label: 'Working' },
      { phase: 'verifying', label: 'Verifying' },
      { phase: 'done', label: 'Done' }
    ];
    const SITUATION_NODE_PHASE = {
      intake: 'planning', decide: 'planning',
      dispatch: 'working', collect: 'working', system_repair: 'working', system_pause: 'working',
      verify: 'verifying', review_check: 'verifying', reconcile: 'verifying', accept: 'verifying'
    };
    const SITUATION_PHASE_LABELS = {
      planning: 'Planning', working: 'Working', verifying: 'Verifying', waiting_owner: 'Waiting for you',
      budget_pause: 'Budget pause', done: 'Done', failed: 'Failed', canceled: 'Canceled',
      pausing: 'Pausing', paused: 'Paused', system_repair: 'System repair', system_wait: 'Technical wait'
    };
    const SITUATION_COLLAPSED_KEY = 'launcher.situationCollapsed';
    let situationCollapsed = readSituationCollapsed();
    let situation = null;            // SIT-1 body for situationKey; null when unavailable
    let situationKey = '';
    let situationFetchAt = 0;
    let situationToken = 0;
    let situationSignature = '';
    let gitStatus = null;            // SIT-2 body for gitKey; null when unavailable
    let gitKey = '';
    let gitFetchAt = 0;
    let gitToken = 0;
    const situationOpen = new Set(); // expanded file lists, by row key
    applySituationCollapsed();

    // Scout asks (SIT-5): kept per project and session (newest last), mirrored in sessionStorage.
    const ASK_STORE_PREFIX = 'launcher.asks.';
    const ASK_POLL_MS = 1500;
    const ASK_KEEP = 10;
    const asksByKey = new Map();
    let scoutChoice = null;      // null = automatic; 'lead' or 'scout' when the owner picked one
    let leadWasActive = false;
    let askSending = false;
    let pauseBusy = false;       // owner pause request in flight (PAUSE-01)

    function projectUrl(suffix) {
      return '/api/projects/' + encodeURIComponent(currentProjectId) + suffix;
    }

    function currentProject() {
      return projectList.find(p => p.id === currentProjectId) || null;
    }

    function statusMarker(status) {
      if (status === 'running') return '[running]';
      if (status === 'starting') return '[starting]';
      return '[stopped]';
    }

    // Readable project name for the session title; the raw name stays in the title attribute.
    function displayProjectName(name) {
      return String(name)
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(^|\s)(\S)/g, (m, sep, ch) => sep + ch.toUpperCase());
    }

    function renderProjectBar() {
      const select = document.getElementById('projectSelect');
      const meta = document.getElementById('projectMeta');
      const removeBtn = document.getElementById('removeProjectBtn');
      select.textContent = '';
      projectList.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + ' ' + statusMarker(p.status);
        select.appendChild(opt);
      });
      const cur = currentProject();
      if (cur) {
        select.value = cur.id;
        meta.textContent = cur.path + ' | port ' + cur.port;
        removeBtn.disabled = cur.status !== 'stopped';
      } else {
        meta.textContent = projectList.length ? '' : 'No projects yet. Add a project path below.';
        removeBtn.disabled = true;
      }
      select.disabled = projectList.length === 0;
      const sessionName = document.getElementById('sessionProjectName');
      sessionName.textContent = cur ? displayProjectName(cur.name) : 'No project';
      sessionName.classList.toggle('is-empty', !cur);
      setTooltip(sessionName, cur ? cur.name : '', true);
      document.title = (cur ? cur.name : 'No project') + ' - Codex Control Plane';
    }

    function pickInitialProject() {
      const wanted = new URLSearchParams(window.location.search).get('project');
      if (wanted && projectList.some(p => p.id === wanted)) return wanted;
      let best = null;
      projectList.forEach(p => {
        if (p.lastUsedAt && (!best || p.lastUsedAt > best.lastUsedAt)) best = p;
      });
      if (best) return best.id;
      return projectList.length ? projectList[0].id : null;
    }


    function newContextId() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      const b = window.crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }

    function setSessionParam(id) {
      try {
        const url = new URL(window.location.href);
        if (id) url.searchParams.set('session', id);
        else url.searchParams.delete('session');
        history.replaceState(null, '', url);
      } catch (_) {}
      syncPerformanceNavLink();
    }

    function syncPerformanceNavLink() {
      const link = document.getElementById('performanceNavLink');
      if (!link) return;
      const url = new URL('/ui/performance.html', window.location.origin);
      const current = new URLSearchParams(window.location.search);
      ['project', 'session'].forEach(function (key) {
        const value = current.get(key);
        if (value) url.searchParams.set(key, value);
      });
      link.href = url.pathname + url.search;
    }

    function setSession(id) {
      currentSessionId = id;
      sessionData = null;
      pendingTurn = null;
      renderSignature = '';
      setSessionParam(id);
      usageSawTerminal = false;
      renderTranscript();
      updateTeamLeds();
      refreshSessionUsage(true);
      refreshSituation(true);
      refreshGitStatus(false);
    }

    function resetSessionView() {
      sending = false;
      document.getElementById('sendError').classList.add('hidden');
      document.getElementById('decisionOptionsList').textContent = '';
      document.getElementById('decisionId').value = '';
      document.getElementById('serverLogsBody').textContent = '';
      const badge = document.getElementById('historyCountBadge');
      if (badge) badge.textContent = '0';
      setSession(null);
    }

    function selectProject(id) {
      const changed = id !== currentProjectId;
      currentProjectId = id;
      try {
        const url = new URL(window.location.href);
        if (id) url.searchParams.set('project', id);
        else url.searchParams.delete('project');
        history.replaceState(null, '', url);
      } catch (_) {}
      syncPerformanceNavLink();
      if (changed) {
        resetSessionView();
        if (initialSessionParam) setSession(initialSessionParam);
        initialSessionParam = null;
        autoOpenLatest = !currentSessionId;
        loadSessions();
        loadTeam();
      }
      renderProjectBar();
      updateStatus();
    }

    async function refreshProjects() {
      try {
        const res = await fetch('/api/projects');
        if (!res.ok) return;
        const data = await res.json();
        projectList = data.projects || [];
        if (!currentProjectId || !currentProject()) {
          selectProject(pickInitialProject());
        } else {
          renderProjectBar();
        }
        // The team card is editable only while the project server is stopped: follow its status.
        const cur = currentProject();
        if (cur && teamData && (cur.status !== 'stopped') !== teamData.running) loadTeam();
      } catch (_) {}
    }

    function onProjectSelectChange() {
      selectProject(document.getElementById('projectSelect').value || null);
    }

    function logLine(text) {
      const logs = document.getElementById('serverLogsBody');
      logs.textContent += text;
      logs.scrollTop = logs.scrollHeight;
    }

    const noticeTimers = {};
    function showNotice(elId, text) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden');
      clearTimeout(noticeTimers[elId]);
      noticeTimers[elId] = setTimeout(function () { el.classList.add('hidden'); }, 6000);
    }

    // Inline "<question> Yes / No" confirmation shown in place of the given controls.
    function inlineConfirm(container, question, onYes, onNo) {
      const saved = Array.from(container.childNodes);
      container.textContent = '';
      container.appendChild(textEl('span', 'limit-reset', question));
      const yes = textEl('button', 'btn btn-danger btn-sm', 'Yes');
      yes.addEventListener('click', function () { yes.disabled = true; onYes(); });
      const no = textEl('button', 'btn btn-secondary btn-sm', 'No');
      no.addEventListener('click', function () {
        container.textContent = '';
        saved.forEach(function (n) { container.appendChild(n); });
        if (onNo) onNo();
      });
      container.appendChild(yes);
      container.appendChild(no);
    }

    async function addProject() {
      const input = document.getElementById('projectPathInput');
      const projectPath = input.value.trim();
      if (!projectPath) return showNotice('projectNotice', 'Specify project path!');
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectPath })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add project');
        await refreshProjects();
        selectProject(data.project.id);
      } catch (err) {
        showNotice('projectNotice', 'Failed to add project: ' + err.message);
      }
    }

    function removeProject() {
      const cur = currentProject();
      if (!cur) return;
      const row = document.getElementById('removeProjectBtn').parentNode;
      inlineConfirm(row, 'Remove from list? (files stay on disk)', doRemoveProject);
    }

    async function doRemoveProject() {
      try {
        const res = await fetch(projectUrl(''), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to remove project');
        await refreshProjects();
      } catch (err) {
        showNotice('projectNotice', 'Failed to remove project: ' + err.message);
      }
    }

    async function updateStatus() {
      const pid = currentProjectId;
      if (!pid) {
        document.getElementById('serverDot').className = 'status-dot';
        document.getElementById('serverStatusText').textContent = 'No project selected';
        document.getElementById('serverPill').style.borderColor = 'var(--border-hairline)';
        document.getElementById('startBtn').disabled = true;
        document.getElementById('stopBtn').disabled = true;
        serverRunning = false;
        updateComposer();
        return;
      }
      try {
        const res = await fetch(projectUrl('/status'));
        const data = await res.json();
        if (pid !== currentProjectId) return;
        if (!res.ok) throw new Error(data.error || 'status failed');

        const dot = document.getElementById('serverDot');
        const text = document.getElementById('serverStatusText');
        const pill = document.getElementById('serverPill');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');

        dot.className = 'status-dot';
        serverRunning = data.status === 'running';

        if (data.status === 'running') {
          dot.classList.add('active');
          text.innerText = 'Orchestrator active';
          pill.style.borderColor = 'var(--success-border)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
        } else if (data.status === 'starting') {
          dot.classList.add('starting');
          text.innerText = 'Starting process...';
          pill.style.borderColor = 'var(--warning-border)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
        } else {
          text.innerText = 'Server stopped';
          pill.style.borderColor = 'var(--border-hairline)';
          startBtn.disabled = false;
          stopBtn.disabled = true;
        }
        updateComposer();

        const logsBody = document.getElementById('serverLogsBody');
        if (data.logs && data.logs.length) {
          logsBody.innerText = data.logs.join('');
          logsBody.scrollTop = logsBody.scrollHeight;
        }

        await pollSession();
        pollAsks();
        const known = currentProject();
        if (known && known.status !== data.status) refreshProjects();
      } catch (_) {}
    }

    function isTerminalState(state) {
      return state === 'TASK_STATE_COMPLETED' || state === 3
        || state === 'TASK_STATE_FAILED' || state === 4
        || state === 'TASK_STATE_CANCELED' || state === 5
        || state === 'TASK_STATE_REJECTED' || state === 7;
    }

    function isPausedState(state) {
      return state === 'TASK_STATE_INPUT_REQUIRED' || state === 6;
    }

    function lastTurn() {
      const turns = sessionData && sessionData.turns;
      return turns && turns.length ? turns[turns.length - 1].leadTask : null;
    }

    function canStartNewSession() {
      if (!currentSessionId || !sessionData || sending || pendingTurn || askSending || pauseBusy) return false;
      const last = lastTurn();
      if (isTerminalState(last && last.state)) return true;
      if (!isPausedState(last && last.state)) return false;
      const sit = situationKey === situationScope() ? situation : null;
      return !!sit && sit.phase === 'paused' && (sit.pauseKind === 'owner_pause' || sit.pauseKind === 'stopped')
        && sit.leadTaskId === last.id
        && !situationBatch(sit).some(function (item) { return item.state === 'running'; });
    }

    // ---- Composer and session controls
    function updateComposer() {
      const goalEl = document.getElementById('taskGoal');
      const sendBtn = document.getElementById('sendBtn');
      const newBtn = document.getElementById('newSessionBtn');
      const hint = document.getElementById('composerHint');
      const last = lastTurn();
      const lastTerminal = !!last && isTerminalState(last.state);

      const active = leadActive();
      if (active !== leadWasActive) {
        leadWasActive = active;
        if (scoutChoice === 'lead') scoutChoice = null;
      }
      const scoutMode = askMode() === 'scout';

      const ownerPaused = ownerPhase() === 'paused';
      if (scoutMode) goalEl.placeholder = 'Ask the scout about the project...';
      else if (ownerPaused) {
        goalEl.placeholder = pauseKindNow() === 'stopped'
          ? 'Stopped - send a message or press Resume to continue'
          : 'Paused - send a message or press Resume to continue';
      }
      else {
        goalEl.placeholder = currentSessionId
          ? 'Reply in this session'
          : 'Describe the goal, for example: Analyze the project and fix validation error in src/...';
      }

      let hintText = '';
      let locked = false;
      if (!currentProjectId) { hintText = 'Add or select a project first.'; locked = true; }
      else if (!serverRunning) { hintText = 'Start the orchestrator to send messages.'; locked = true; }
      else if (scoutMode) {
        if (askSending) { hintText = 'Sending to the scout...'; locked = true; }
        else if (active) hintText = 'Lead is working: your questions go to the scout.';
      }
      else if (sending || pendingTurn) { hintText = 'Lead is working on your message...'; locked = true; }
      else if (!ownerPaused && last && isPausedState(last.state)) {
        const pause = last.metadata?.pause || {};
        hintText = pause.kind === 'system_repair'
          ? 'System repair is waiting for a technical condition. No owner answer is needed.'
          : 'Lead is paused: answer through the decision card above.';
        locked = true;
      }
      else if (last && !lastTerminal) { hintText = 'Lead is working: wait for the answer before sending another message.'; locked = true; }

      goalEl.disabled = locked;
      sendBtn.disabled = locked;
      document.getElementById('sendLabel').textContent = scoutMode ? 'Ask' : 'Send';
      hint.textContent = hintText;
      hint.classList.toggle('hidden', hintText === '');
      document.getElementById('composerBox').classList.toggle('is-scout', scoutMode);
      const leadBtn = document.getElementById('modeLeadBtn');
      const scoutBtn = document.getElementById('modeScoutBtn');
      const scoutOk = serverRunning && !!currentProjectId;
      leadBtn.setAttribute('aria-pressed', String(!scoutMode));
      scoutBtn.setAttribute('aria-pressed', String(scoutMode));
      scoutBtn.setAttribute('aria-disabled', String(!scoutOk));
      scoutBtn.classList.toggle('is-disabled', !scoutOk);
      if (scoutOk) delete scoutBtn.dataset.tooltip;
      else setTooltip(scoutBtn, 'Start the project server to ask the scout', false);
      newBtn.disabled = !canStartNewSession();
      updatePauseButton();
      document.getElementById('activeTaskIdDisplay').textContent = currentSessionId
        ? 'session ' + currentSessionId.slice(0, 8)
        : 'no session';
    }

    function newSession() {
      if (!canStartNewSession()) return false;
      setSession(null);
      autoOpenLatest = false;
      decisionCardKey = '';
      selectedDecisionOption = '';
      decisionOptionIds = [];
      document.getElementById('decisionCard').classList.add('hidden');
      document.getElementById('decisionOptionsList').textContent = '';
      document.getElementById('decisionId').value = '';
      document.getElementById('decisionIdText').textContent = '';
      document.getElementById('decisionAnswer').value = '';
      document.getElementById('sendError').classList.add('hidden');
      updateComposer();
      document.getElementById('taskGoal').focus();
      return true;
    }

    // ---- Transcript
    function textEl(tag, className, text) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      el.textContent = text;
      return el;
    }

    const ROLE_DISPLAY_NAMES = {
      'orch-lead': 'Team Coordinator', coordinator: 'Team Coordinator',
      'orch-explorer': 'Code Explorer', explorer: 'Code Explorer',
      'orch-builder': 'Software Engineer', engineer: 'Software Engineer',
      'orch-verifier': 'Quality Engineer', verifier: 'Quality Engineer',
      'orch-auditor': 'Code Auditor', auditor: 'Code Auditor',
      'orch-repair-xhigh': 'Recovery Engineer', 'recovery-engineer': 'Recovery Engineer',
      'orch-repair-sol': 'Senior Engineer', 'senior-engineer': 'Senior Engineer',
      'orch-architect': 'Systems Architect', architect: 'Systems Architect',
      'orch-scout': 'Quick Scout', scout: 'Quick Scout'
    };
    const LEGACY_ROLE_IDS = {
      'orch-lead': 'coordinator', 'orch-explorer': 'explorer', 'orch-builder': 'engineer',
      'orch-verifier': 'verifier', 'orch-auditor': 'auditor',
      'orch-repair-xhigh': 'recovery-engineer', 'orch-repair-sol': 'senior-engineer',
      'orch-architect': 'architect', 'orch-scout': 'scout'
    };

    function roleDisplayName(id) {
      return ROLE_DISPLAY_NAMES[id] || (id.startsWith('orch-') ? id.slice(5) : id);
    }

    function canonicalRoleId(id) {
      return LEGACY_ROLE_IDS[id] || (id.startsWith('orch-') ? id.slice(5) : id);
    }

    function userBubbles(transcript, goal, lastInstruction) {
      if (goal) transcript.appendChild(textEl('div', 'bubble bubble-user', goal));
      if (lastInstruction && lastInstruction !== goal) {
        transcript.appendChild(textEl('div', 'bubble bubble-followup', 'Follow-up: ' + lastInstruction));
      }
    }

    function acceptanceLabel(disposition) {
      if (disposition === 'accepted') return 'Acceptance: Passed';
      if (disposition === 'rejected') return 'Acceptance: Rejected';
      return 'Acceptance: ' + (disposition || 'n/a');
    }

    const PHASE_LABELS = {
      starting: 'starting', thinking: 'thinking', command: 'running', editing: 'editing',
      tool: 'tool call', reporting: 'writing report', done: 'done'
    };

    function phaseLabel(phase) {
      return PHASE_LABELS[phase] || String(phase || '');
    }

    function fmtSpan(ms) {
      const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    function spanBetween(from, to) {
      const a = typeof from === 'number' ? from : Date.parse(from);
      const b = typeof to === 'number' ? to : Date.parse(to);
      return fmtSpan(b - a);
    }

    function isActiveWorker(w) {
      return w.state === 'submitting' || w.state === 'submitted';
    }

    function activityDetail(a) {
      let text = phaseLabel(a.phase);
      if (a.summary) text += ': ' + a.summary;
      return text;
    }

    const openRounds = new Set();

    function taskStateKind(state) {
      if (state === 'TASK_STATE_WORKING' || state === 2) return 'working';
      if (isPausedState(state)) return 'paused';
      if (state === 'TASK_STATE_COMPLETED' || state === 3) return 'completed';
      if (state === 'TASK_STATE_FAILED' || state === 4 || state === 'TASK_STATE_REJECTED' || state === 7) return 'failed';
      if (state === 'TASK_STATE_CANCELED' || state === 5) return 'canceled';
      return 'unknown';
    }

    function statePill(kind, label) {
      const pill = document.createElement('span');
      pill.className = 'pill pill-' + kind;
      if (kind === 'working' || kind === 'running') pill.appendChild(textEl('span', 'pulse-dot', ''));
      pill.appendChild(document.createTextNode(label));
      return pill;
    }

    function workerStatus(w) {
      if (isActiveWorker(w)) return { kind: 'running', label: 'running' };
      const k = taskStateKind(w.taskState);
      if (k === 'completed') return { kind: 'done', label: 'done' };
      if (k === 'failed') return { kind: 'failed', label: 'failed' };
      if (k === 'canceled') return { kind: 'canceled', label: 'canceled' };
      return { kind: 'finished', label: 'finished' };
    }

    function workerDuration(w, now) {
      const a = w.activity || null;
      const startedAt = (a && a.startedAt) || w.created_at;
      return isActiveWorker(w)
        ? spanBetween(startedAt, now)
        : spanBetween(startedAt, (a && a.endedAt) || w.updated_at);
    }

    function activityLines(row, a, now) {
      const line = document.createElement('div');
      line.className = 'act-line';
      line.appendChild(textEl('span', 'phase-chip phase-' + (PHASE_LABELS[a.phase] ? a.phase : 'starting'), phaseLabel(a.phase)));
      if (a.summary) {
        const sum = textEl('span', 'act-summary', a.summary);
        setTooltip(sum, a.summary, true);
        line.appendChild(sum);
      }
      row.appendChild(line);
      const meta = document.createElement('div');
      meta.className = 'act-meta';
      meta.appendChild(textEl('span', 'act-counts', (a.commands || 0) + ' commands | ' + (a.fileChanges || 0) + ' edits'));
      const idle = (now - Date.parse(a.updatedAt)) / 1000;
      const level = idle > 180 ? ' idle-red' : idle >= 60 ? ' idle-amber' : '';
      meta.appendChild(textEl('span', 'act-idle' + level, 'last event ' + spanBetween(a.updatedAt, now) + ' ago'));
      row.appendChild(meta);
    }

    function workerRow(w, now) {
      const active = isActiveWorker(w);
      const st = workerStatus(w);
      const row = document.createElement('div');
      row.className = 'w-row' + (active ? ' w-active' : ' w-finished');
      row.appendChild(statePill(st.kind, st.label));
      row.appendChild(textEl('span', 'w-name', roleDisplayName(w.role)));
      row.appendChild(textEl('span', 'w-dur', workerDuration(w, now)));
      if (active) {
        if (w.objective) {
          const obj = textEl('div', 'w-task', String(w.objective));
          setTooltip(obj, String(w.objective), true);
          row.appendChild(obj);
        }
        if (w.activity) activityLines(row, w.activity, now);
      }
      return row;
    }

    function leadActivityRow(la, now) {
      const row = document.createElement('div');
      row.className = 'w-row w-active';
      row.appendChild(statePill('running', 'running'));
      row.appendChild(textEl('span', 'w-name', 'Lead'));
      row.appendChild(textEl('span', 'w-dur', spanBetween(la.startedAt, now)));
      activityLines(row, la, now);
      return row;
    }

    function roundSummary(label, group) {
      const counts = { done: 0, failed: 0, canceled: 0, finished: 0, running: 0 };
      group.forEach(w => { counts[workerStatus(w).kind]++; });
      const parts = [];
      ['done', 'failed', 'canceled', 'finished', 'running'].forEach(k => {
        if (counts[k]) parts.push(counts[k] + ' ' + k);
      });
      return label + ': ' + parts.join(', ');
    }

    function roundGroups(workers) {
      const byRound = new Map();
      workers.forEach(w => {
        const key = Number.isInteger(w.round) ? w.round : null;
        if (!byRound.has(key)) byRound.set(key, []);
        byRound.get(key).push(w);
      });
      const keys = [...byRound.keys()].filter(k => k !== null).sort((x, y) => x - y);
      if (byRound.has(null)) keys.push(null);
      return keys.map(k => ({ key: k, label: k === null ? 'Other' : 'Round ' + k, workers: byRound.get(k) }));
    }

    function workingBody(turn, now) {
      const workers = turn.workers || [];
      const wrap = document.createElement('div');
      wrap.className = 'lead-body';
      wrap.appendChild(textEl('div', 'lead-intro', 'Lead analyzes the goal, creates assignments, and coordinates specialists...'));
      const la = turn.leadActivity;
      if (la && !la.endedAt && !workers.some(isActiveWorker)) wrap.appendChild(leadActivityRow(la, now));
      const groups = roundGroups(workers);
      groups.forEach((g, i) => {
        const rows = document.createElement('div');
        rows.className = 'w-rows';
        g.workers.forEach(w => rows.appendChild(workerRow(w, now)));
        const isNewest = i === groups.length - 1;
        if (isNewest) {
          const box = document.createElement('div');
          box.className = 'round-group';
          box.appendChild(textEl('div', 'round-head', g.label));
          box.appendChild(rows);
          wrap.appendChild(box);
          return;
        }
        const details = document.createElement('details');
        details.className = 'round-group';
        const memo = turn.leadTask.id + '#' + g.key;
        details.open = openRounds.has(memo);
        details.addEventListener('toggle', () => {
          if (details.open) openRounds.add(memo); else openRounds.delete(memo);
        });
        details.appendChild(textEl('summary', 'round-head', roundSummary(g.label, g.workers)));
        details.appendChild(rows);
        wrap.appendChild(details);
      });
      return wrap;
    }

    function leadBubble(turn) {
      const t = turn.leadTask;
      const state = t.state;
      const now = Date.now();
      const kind = taskStateKind(state);
      const bubble = document.createElement('div');
      bubble.className = 'bubble bubble-lead';
      const head = document.createElement('div');
      head.className = 'bubble-head';
      head.appendChild(textEl('span', '', 'Lead'));
      let body = '';
      let bodyEl = null;

      if (kind === 'working') {
        head.appendChild(statePill('working', 'working'));
        bodyEl = workingBody(turn, now);
      } else if (kind === 'paused') {
        head.appendChild(statePill('paused', 'paused'));
        bubble.classList.add('bubble-paused');
        body = t.metadata?.pause?.kind === 'system_repair'
          ? 'Technical system repair wait. See the Situation panel for status and available next steps.'
          : 'Paused: waiting for a human decision.\n\n' + extractParts(t.status?.message?.parts);
      } else if (kind === 'completed') {
        const artifact = t.artifacts?.at(-1);
        head.appendChild(statePill('completed', acceptanceLabel(artifact?.metadata?.acceptance?.disposition)));
        body = extractParts(artifact?.parts) || extractParts(t.status?.message?.parts) || 'Completed without additional text.';
      } else if (kind === 'failed') {
        head.appendChild(statePill('failed', 'failed'));
        bubble.classList.add('bubble-failed');
        body = 'Task failed with an error:\n\n' + extractParts(t.status?.message?.parts);
      } else if (kind === 'canceled') {
        head.appendChild(statePill('canceled', 'canceled'));
        body = extractParts(t.status?.message?.parts);
      } else {
        head.appendChild(statePill('canceled', 'ended'));
        body = extractParts(t.status?.message?.parts);
      }
      bubble.appendChild(head);
      bubble.appendChild(bodyEl || textEl('div', 'lead-text', body));
      return bubble;
    }

    function updateStatusBar() {
      const label = document.getElementById('taskStatusLabel');
      const badge = document.getElementById('acceptanceBadge');
      const last = lastTurn();
      badge.className = 'acceptance-pill acceptance-none';
      badge.textContent = 'no checks';
      const checksEl = document.getElementById('acceptanceChecks');
      const contract = last?.metadata?.acceptanceContract;
      const checks = Array.isArray(contract?.requiredChecks) ? contract.requiredChecks : [];
      checksEl.replaceChildren();
      checksEl.classList.toggle('hidden', checks.length === 0);
      if (checks.length > 0) {
        badge.textContent = checks.length + (checks.length === 1 ? ' check' : ' checks');
        checksEl.appendChild(textEl('div', 'acceptance-checks-source',
          'Acceptance checks, ' + (contract.source === 'agent' ? 'proposed by the lead' : 'set by you')));
        for (const check of checks) {
          const argv = Array.isArray(check.argv) ? check.argv.join(' ') : '';
          const row = document.createElement('div');
          row.className = 'acceptance-check-row';
          row.appendChild(textEl('span', 'acceptance-check-id', String(check.id ?? '')));
          const argvEl = textEl('span', 'acceptance-check-argv', argv);
          setTooltip(argvEl, argv, true);
          row.appendChild(argvEl);
          checksEl.appendChild(row);
        }
      }
      if (!last) {
        label.textContent = pendingTurn ? 'Status: task in progress...' : 'Status: waiting to start';
        return;
      }
      const state = last.state;
      if (state === 'TASK_STATE_WORKING' || state === 2) label.textContent = 'Status: task in progress...';
      else if (isPausedState(state)) {
        label.textContent = last.metadata?.pause?.kind === 'system_repair'
          ? 'Status: system repair is waiting (paused)'
          : 'Status: human decision required (paused)';
      }
      else if (state === 'TASK_STATE_COMPLETED' || state === 3) {
        label.textContent = 'Status: COMPLETED SUCCESSFULLY';
        const disposition = last.artifacts?.at(-1)?.metadata?.acceptance?.disposition;
        badge.className = 'acceptance-pill ' + (disposition === 'accepted' ? 'acceptance-accepted'
          : disposition === 'rejected' ? 'acceptance-rejected' : 'acceptance-none');
        if (disposition || checks.length === 0) badge.textContent = acceptanceLabel(disposition);
      } else if (state === 'TASK_STATE_FAILED' || state === 4) label.textContent = 'Status: FAILED';
      else label.textContent = 'Status: ' + state;
    }

    // Labels for the reasons (humanInput.reason) and escalation kinds a pause can carry.
    const DECISION_LABELS = {
      paid_resources: 'Paid resources',
      credentials_or_access: 'Credentials or access',
      external_write: 'External write',
      irreversible_operation: 'Irreversible operation',
      prd_requirement_change: 'PRD requirement change',
      infeasible_requirement: 'Infeasible requirement',
      round_limit: 'Round limit reached',
      goal_not_achieved: 'Goal not achieved',
      loop_detected: 'Repeated work detected',
      check_changed: 'Acceptance check changed',
      error: 'Error'
    };
    let decisionCardKey = '';
    let decisionOptionIds = [];
    let selectedDecisionOption = '';

    function decisionLabel(key) {
      return Object.prototype.hasOwnProperty.call(DECISION_LABELS, key) ? DECISION_LABELS[key] : key;
    }

    // Rebuilt only when the pause changes, so a selection survives the transcript polling.
    function renderDecisionCard(pause) {
      const isError = pause.kind === 'error';
      const reasonKey = isError ? 'error' : (pause.escalation || pause.reason || '');
      document.getElementById('decisionReasonRow').classList.toggle('hidden', !reasonKey);
      document.getElementById('decisionReason').textContent = reasonKey ? decisionLabel(reasonKey) : '';
      const question = isError
        ? 'Lead paused due to an error: ' + (pause.message || 'Error') + '\nSend a message to retry the step.'
        : (pause.question || pause.message || 'Waiting for response');
      document.getElementById('decisionQuestion').textContent = question;
      document.getElementById('decisionId').value = pause.decisionId || '';
      document.getElementById('decisionIdText').textContent = pause.decisionId || '';
      document.getElementById('decisionIdRow').classList.toggle('hidden', !pause.decisionId);

      const options = Array.isArray(pause.options) ? pause.options : [];
      decisionOptionIds = options.map(opt => opt.id);
      document.getElementById('decisionOptionsBlock').classList.toggle('hidden', options.length === 0);
      const optContainer = document.getElementById('decisionOptionsList');
      optContainer.textContent = '';
      options.forEach(opt => {
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'decisionOption';
        input.value = opt.id;
        input.addEventListener('change', () => selectOption(opt.id));
        const head = document.createElement('span');
        head.className = 'decision-option-head';
        head.appendChild(textEl('code', 'decision-option-id', opt.id));
        if (opt.id === pause.recommendation) head.appendChild(textEl('span', 'decision-recommended', 'Recommended'));
        const body = document.createElement('span');
        body.className = 'decision-option-body';
        body.appendChild(head);
        body.appendChild(textEl('span', 'decision-option-text', opt.description || ''));
        const label = document.createElement('label');
        label.className = 'decision-option';
        label.appendChild(input);
        label.appendChild(body);
        optContainer.appendChild(label);
      });

      const independent = typeof pause.independentWork === 'string' ? pause.independentWork.trim() : '';
      document.getElementById('decisionIndependentRow').classList.toggle('hidden', !independent);
      document.getElementById('decisionIndependent').textContent = independent;

      const evidence = Array.isArray(pause.evidenceChecked) ? pause.evidenceChecked : [];
      const details = document.getElementById('decisionEvidence');
      details.classList.toggle('hidden', evidence.length === 0);
      details.open = false;
      document.getElementById('decisionEvidenceCount').textContent = String(evidence.length);
      const evidenceList = document.getElementById('decisionEvidenceList');
      evidenceList.textContent = '';
      evidence.forEach(item => evidenceList.appendChild(textEl('li', '', String(item))));
    }

    // The option pick is the only way to choose; with options, submit waits for one.
    function updateDecisionControls() {
      document.querySelectorAll('#decisionOptionsList .decision-option').forEach(label => {
        const input = label.querySelector('input');
        input.checked = input.value === selectedDecisionOption;
        label.classList.toggle('selected', input.checked);
      });
      document.getElementById('decisionSubmit').disabled = decisionOptionIds.length > 0 && !selectedDecisionOption;
    }

    function updateDecisionCard() {
      const card = document.getElementById('decisionCard');
      const last = lastTurn();
      if (!last || !isPausedState(last.state) || sending) {
        card.classList.add('hidden');
        decisionCardKey = '';
        return;
      }
      const pause = last.metadata?.pause || {};
      if (pause.kind === 'system_repair') {
        card.classList.add('hidden');
        decisionCardKey = '';
        return;
      }
      card.classList.remove('hidden');
      const key = JSON.stringify([last.id, pause.kind || '', pause.decisionId || '', pause.question || '', pause.message || '']);
      if (key !== decisionCardKey) {
        decisionCardKey = key;
        selectedDecisionOption = '';
        renderDecisionCard(pause);
      }
      updateDecisionControls();
    }

    function renderTranscript() {
      const transcript = document.getElementById('transcript');
      const turns = (sessionData && sessionData.turns) || [];
      const lastTurnRow = turns[turns.length - 1];
      const working = Boolean(lastTurnRow)
        && (lastTurnRow.leadTask.state === 'TASK_STATE_WORKING' || lastTurnRow.leadTask.state === 2);
      const tick = working ? Math.floor(Date.now() / 5000) : 0;
      const asks = loadAsks(currentAskKey());
      const askView = asks.map(function (a) { return [a.askId, a.state, a.answer, a.error, a.cancelRequested, a.finishedAt]; });
      const signature = JSON.stringify([currentSessionId, sessionData, pendingTurn && pendingTurn.goal, tick, askView]);
      updateStatusBar();
      updateDecisionCard();
      updateComposer();
      if (signature === renderSignature) return;
      const firstPaint = renderSignature === '' || !transcript.firstChild;
      const stickToBottom = firstPaint
        || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
      const keepTop = transcript.scrollTop;
      renderSignature = signature;

      transcript.textContent = '';
      turns.forEach(turn => {
        userBubbles(transcript, turn.leadTask.goal, turn.leadTask.lastInstruction);
        transcript.appendChild(leadBubble(turn));
      });
      if (pendingTurn && turns.length <= pendingTurn.baseTurns) {
        userBubbles(transcript, pendingTurn.goal, '');
        const wait = document.createElement('div');
        wait.className = 'bubble bubble-lead';
        wait.appendChild(textEl('div', '', 'Dispatching to the Lead...'));
        transcript.appendChild(wait);
      }
      const askKeyNow = currentAskKey();
      asks.forEach(function (ask) { transcript.appendChild(scoutAskNode(ask, askKeyNow)); });
      if (!transcript.firstChild) {
        transcript.appendChild(textEl('div', 'transcript-empty',
          'Send a message to start a session. Specialist reports and the final verdict will appear here.'));
      }
      transcript.scrollTop = stickToBottom ? transcript.scrollHeight : keepTop;
    }

    async function pollSession() {
      const pid = currentProjectId;
      const sid = currentSessionId;
      if (!pid || !sid) return;
      tickSituationElapsed();
      try {
        const res = await fetch(projectUrl('/sessions/' + encodeURIComponent(sid)));
        if (pid !== currentProjectId || sid !== currentSessionId) return;
        if (res.status === 404) {
          // A brand-new session has no row until the lead task is created.
          if (!pendingTurn && !sending) setSession(null);
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (pid !== currentProjectId || sid !== currentSessionId) return;
        sessionData = data;
        if (pendingTurn && data.turns.length > pendingTurn.baseTurns) pendingTurn = null;
        const last = lastTurn();
        const finished = !!last && isTerminalState(last.state);
        const justFinished = finished && !usageSawTerminal;
        usageSawTerminal = finished;
        refreshSessionUsage(justFinished);
        refreshSituation(justFinished);
        refreshGitStatus(justFinished);
        renderTranscript();
        updateTeamLeds();
      } catch (_) {}
    }

    async function loadSessions() {
      const pid = currentProjectId;
      if (!pid) return;
      try {
        const res = await fetch(projectUrl('/sessions'));
        if (!res.ok) return;
        const data = await res.json();
        if (pid !== currentProjectId) return;
        const sessions = data.sessions || [];
        const badge = document.getElementById('historyCountBadge');
        if (badge) badge.textContent = sessions.length;
        if (autoOpenLatest && !currentSessionId && sessions.length) {
          autoOpenLatest = false;
          setSession(sessions[0].contextId);
          pollSession();
        }
      } catch (_) {}
    }

    // ---- History modal: one row per session
    function stateBadge(state) {
      const badge = document.createElement('span');
      badge.className = 'acceptance-pill acceptance-none';
      badge.textContent = String(state);
      if (state === 'TASK_STATE_WORKING' || state === 2) {
        badge.className = 'acceptance-pill';
        badge.style.cssText = 'background: var(--accent-soft); color: var(--accent-text); border: 1px solid var(--accent-border);';
        badge.textContent = 'In Progress';
      } else if (isPausedState(state)) {
        badge.className = 'acceptance-pill';
        badge.style.cssText = 'background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border);';
        badge.textContent = 'Awaiting Decision';
      } else if (state === 'TASK_STATE_COMPLETED' || state === 3) {
        badge.className = 'acceptance-pill acceptance-accepted';
        badge.textContent = 'Success';
      } else if (state === 'TASK_STATE_FAILED' || state === 4) {
        badge.className = 'acceptance-pill acceptance-rejected';
        badge.textContent = 'Failed';
      }
      return badge;
    }

    async function openHistoryModal() {
      const modal = document.getElementById('historyModal');
      const container = document.getElementById('historyListContainer');
      modal.classList.remove('hidden');
      container.textContent = '';
      container.appendChild(textEl('div', '', 'Loading sessions...')).style.cssText = 'text-align: center; color: var(--text-dim); padding: 20px;';

      try {
        const res = await fetch(projectUrl('/sessions'));
        if (!res.ok) throw new Error('Failed to load sessions');
        const data = await res.json();
        const sessions = data.sessions || [];
        container.textContent = '';
        const badge = document.getElementById('historyCountBadge');
        if (badge) badge.textContent = sessions.length;

        if (sessions.length === 0) {
          container.appendChild(textEl('div', '', 'No sessions yet. Sent messages will appear here.')).style.cssText = 'text-align: center; color: var(--text-dim); padding: 30px;';
          return;
        }

        sessions.forEach(s => {
          const item = document.createElement('div');
          item.className = 'history-item';

          const header = document.createElement('div');
          header.className = 'history-item-header';
          const badgeWrap = document.createElement('span');
          badgeWrap.appendChild(stateBadge(s.state));
          header.appendChild(badgeWrap);
          header.appendChild(textEl('span', '', s.updatedAt ? new Date(s.updatedAt).toLocaleString('en-US') : ''));
          item.appendChild(header);

          item.appendChild(textEl('div', 'history-item-goal', s.goal));

          const meta = document.createElement('div');
          meta.className = 'history-item-meta';
          meta.appendChild(textEl('span', '', 'Turns: ' + s.turns));
          meta.appendChild(textEl('span', '', 'Acceptance: ' + (s.disposition || 'n/a')));
          meta.appendChild(textEl('span', '', 'ID: ' + s.contextId.slice(0, 8) + '...'));
          item.appendChild(meta);

          const actions = document.createElement('div');
          actions.className = 'history-item-actions';
          if (isTerminalState(s.state)) {
            const delBtn = textEl('button', 'btn btn-danger btn-sm', 'Delete');
            delBtn.addEventListener('click', () => deleteSessionItem(s.contextId, actions));
            actions.appendChild(delBtn);
          }
          const openBtn = textEl('button', 'btn btn-secondary btn-sm', 'Open');
          openBtn.addEventListener('click', () => openSession(s.contextId));
          actions.appendChild(openBtn);
          item.appendChild(actions);
          container.appendChild(item);
        });
      } catch (err) {
        container.textContent = '';
        container.appendChild(textEl('div', '', 'Failed to load sessions: ' + err.message)).style.cssText = 'color: var(--danger); text-align: center; padding: 20px;';
      }
    }

    function closeHistoryModal() {
      document.getElementById('historyModal').classList.add('hidden');
    }

    function openSession(contextId) {
      closeHistoryModal();
      autoOpenLatest = false;
      setSession(contextId);
      pollSession();
    }

    function deleteSessionItem(contextId, actions) {
      inlineConfirm(actions, 'Delete session?', function () { doDeleteSession(contextId); });
    }

    async function doDeleteSession(contextId) {
      try {
        const res = await fetch(projectUrl('/sessions/' + encodeURIComponent(contextId)), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete session');
        if (currentSessionId === contextId) setSession(null);
        loadSessions();
        openHistoryModal();
      } catch (err) {
        showNotice('historyNotice', 'Failed to delete: ' + err.message);
      }
    }

    async function startServer() {
      if (!currentProjectId) return showNotice('projectNotice', 'Add or select a project first!');

      const startBtn = document.getElementById('startBtn');
      const text = document.getElementById('serverStatusText');
      const dot = document.getElementById('serverDot');
      const logs = document.getElementById('serverLogsBody');

      startBtn.disabled = true;
      dot.className = 'status-dot starting';
      text.innerText = 'Starting process...';
      logs.innerText = '[LAUNCHER] Initializing server startup...\n';

      try {
        const res = await fetch(projectUrl('/start'), { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) {
          logLine('[ERROR] ' + (data.message || data.error || 'Failed to start server') + '\n');
        }
      } catch (err) {
        logLine('[NETWORK ERROR] No connection to launcher: ' + err.message + '\n');
      }
      refreshProjects();
      setTimeout(updateStatus, 800);
    }

    async function stopServer() {
      if (!currentProjectId) return;
      const stopBtn = document.getElementById('stopBtn');
      const text = document.getElementById('serverStatusText');
      stopBtn.disabled = true;
      text.innerText = 'Stopping...';

      try {
        const res = await fetch(projectUrl('/stop'), { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) {
          if (res.status === 409) {
            logLine('[LAUNCHER] Cannot stop: this orchestrator was not started by this launcher (or its process is gone). Stop it manually.\n');
          } else {
            logLine('[ERROR] ' + (data.error || 'Failed to stop server') + '\n');
          }
        }
      } catch (err) {
        showNotice('projectNotice', 'Failed to stop: ' + err.message);
      }
      refreshProjects();
      setTimeout(updateStatus, 500);
    }

    // ---- Owner pause (PAUSE-01). POST .../pause, .../pause/cancel, .../resume. The state is the SIT-1 phase:
    // 'pausing' while running workers finish their turn, 'paused' once the lead is parked.
    function ownerPhase() {
      const sit = situationKey === situationScope() ? situation : null;
      return sit ? sit.phase : null;
    }

    // Phase 'paused' covers an owner pause and a resumable Stop; a missing pauseKind is an owner pause.
    function pauseKindOf(sit) {
      return sit && sit.pauseKind === 'stopped' ? 'stopped' : 'owner_pause';
    }

    function pauseKindNow() {
      return pauseKindOf(situationKey === situationScope() ? situation : null);
    }

    function pauseLeadPhase(phase) {
      return phase === 'planning' || phase === 'working' || phase === 'verifying' || phase === 'system_repair';
    }

    async function postPauseControl(path, body, label) {
      if (pauseBusy) return false;
      const pid = currentProjectId;
      pauseBusy = true;
      updatePauseButton();
      let res = null;
      let data = {};
      try {
        res = await fetch(projectUrl(path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        });
        data = await res.json().catch(function () { return {}; });
      } catch (_) {
        res = null;
      }
      pauseBusy = false;
      if (pid !== currentProjectId) return false;
      if (res && res.ok && data.success !== false) {
        situationFetchAt = 0;
        refreshSituation(true);
        pollSession();
        return true;
      }
      let text = label + ' failed.';
      if (res && res.status === 404) text = label + ' is not available on this launcher yet.';
      else if (data && typeof data.error === 'string' && data.error) text = data.error;
      showNotice('sendError', text);
      updatePauseButton();
      return false;
    }

    function onPauseButton() {
      const phase = ownerPhase();
      if (phase === 'pausing') return postPauseControl('/pause/cancel', {}, 'Cancel pause');
      if (!serverRunning || !currentSessionId || !pauseLeadPhase(phase)) return false;
      return postPauseControl('/pause', {}, 'Pause');
    }

    function resumeSession() {
      if (!currentSessionId || ownerPhase() !== 'paused') return false;
      return postPauseControl('/resume', { sessionContextId: currentSessionId }, 'Resume');
    }

    function updatePauseButton() {
      const btn = document.getElementById('pauseBtn');
      const phase = ownerPhase();
      const sit = situationKey === situationScope() ? situation : null;
      let text = 'Pause';
      let tip = 'Pause after the running workers finish their turn.';
      let enabled = false;
      if (!currentProjectId || !serverRunning) tip = 'Start the project server to pause.';
      else if (!currentSessionId) tip = 'Open a session to pause its lead.';
      else if (phase === 'pausing') {
        const running = sit ? situationBatch(sit).filter(function (a) { return a.state === 'running'; }).length : 0;
        text = running ? 'Pausing... (' + running + ' running)' : 'Pausing...';
        tip = 'Waiting for running workers to finish their turn. Click to cancel.';
        enabled = true;
      } else if (pauseLeadPhase(phase)) {
        enabled = true;
      } else if (phase === 'paused') {
        tip = pauseKindNow() === 'stopped'
          ? 'Stopped. Press Resume in the situation panel to continue.'
          : 'Paused. Press Resume in the situation panel to continue.';
      } else {
        tip = 'Pause is available while the lead works.';
      }
      enabled = enabled && !pauseBusy;
      document.getElementById('pauseLabel').textContent = text;
      document.getElementById('pauseDot').classList.toggle('hidden', phase !== 'pausing');
      btn.setAttribute('aria-disabled', String(!enabled));
      btn.classList.toggle('is-disabled', !enabled);
      btn.classList.toggle('is-pausing', phase === 'pausing');
      setTooltip(btn, tip, false);
    }

    async function sendMessage() {
      if (askMode() === 'scout') return sendScoutAsk();
      const goal = document.getElementById('taskGoal').value.trim();
      if (!goal) return showNotice('sendError', 'Enter a message!');


      const last = lastTurn();
      const payload = { goal };
      if (currentSessionId) {
        if (ownerPhase() === 'paused' && last && isPausedState(last.state)) {
          // The message continues the owner-paused lead task, as a decision answer does.
          payload.taskId = last.id;
        } else {
          if (!last || !isTerminalState(last.state)) return;
          payload.continueFrom = last.id;
        }
      } else {
        setSession(newContextId());
        payload.contextId = currentSessionId;
      }
      if (payload.taskId === undefined) {
        pendingTurn = { goal, baseTurns: sessionData ? sessionData.turns.length : 0 };
      }
      document.getElementById('taskGoal').value = '';
      await executeA2A(payload);
    }

    async function submitDecision() {
      const last = lastTurn();
      if (!last) return;
      const choice = selectedDecisionOption;
      if (decisionOptionIds.length > 0 && !choice) return;
      const decisionId = document.getElementById('decisionId').value;
      const answer = document.getElementById('decisionAnswer').value.trim();

      document.getElementById('decisionAnswer').value = '';
      selectedDecisionOption = '';
      decisionCardKey = '';
      await executeA2A({
        goal: answer || choice || 'Approved',
        taskId: last.id,
        decision: decisionId,
        choice: choice || undefined
      });
    }

    function selectOption(id) {
      selectedDecisionOption = id;
      updateDecisionControls();
    }

    // The request returns when the lead run ends; the transcript is driven by polling meanwhile.
    async function executeA2A(payload) {
      if (!currentProjectId) return showNotice('sendError', 'Add or select a project first!');
      const pid = currentProjectId;
      const sid = currentSessionId;
      const errorEl = document.getElementById('sendError');
      errorEl.classList.add('hidden');
      sending = true;
      renderTranscript();

      try {
        const res = await fetch(projectUrl('/task/send'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (pid !== currentProjectId) return;
        if (!data.success) throw new Error(data.error);
      } catch (err) {
        if (pid === currentProjectId) {
          errorEl.textContent = 'Send failed: ' + err.message;
          errorEl.classList.remove('hidden');
          if (payload.taskId === undefined) {
            document.getElementById('taskGoal').value = payload.goal;
          }
        }
      } finally {
        if (pid === currentProjectId) {
          sending = false;
          if (sid === currentSessionId) {
            await pollSession();
            // The message never became a turn: drop the optimistic bubble.
            if (pendingTurn && (!sessionData || sessionData.turns.length <= pendingTurn.baseTurns)) pendingTurn = null;
            if (!sessionData) setSession(null);
            else renderTranscript();
          }
          loadSessions();
        }
      }
    }

    function extractParts(parts) {
      if (!Array.isArray(parts)) return '';
      return parts.map(p => p.content?.$case === 'text' ? p.content.value : (p.text || '')).filter(Boolean).join('\n');
    }

    function formatResetCountdown(resetsAt) {
      const remainingMinutes = Math.floor(Math.max(0, resetsAt * 1000 - Date.now()) / 60000);
      const hours = Math.floor(remainingMinutes / 60);
      const minutes = remainingMinutes % 60;
      return '(' + hours + 'h ' + minutes + 'm)';
    }

    // ---- Accounts card
    let accountLoginTimer = null;
    let accountLoginId = null;

    function accountsApi(method, url, body) {
      return fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(async function (res) {
        let data = {};
        try { data = await res.json(); } catch (_) {}
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    }

    function showAccountsError(message) {
      const el = document.getElementById('accountsError');
      el.textContent = message || '';
      el.classList.toggle('hidden', !message);
    }

    function limitBlock(name, windowData, isWeekly) {
      const item = document.createElement('div');
      item.className = 'limit-item';
      const info = document.createElement('div');
      info.className = 'limit-info';
      info.appendChild(textEl('span', 'limit-name', name));
      const value = textEl('span', 'limit-value', '--');
      info.appendChild(value);
      item.appendChild(info);
      const bg = document.createElement('div');
      bg.className = 'progress-bar-bg';
      const fill = document.createElement('div');
      fill.className = 'progress-bar-fill';
      fill.style.width = '0%';
      bg.appendChild(fill);
      item.appendChild(bg);
      const reset = textEl('div', 'limit-reset', 'Reset: n/a');
      item.appendChild(reset);
      if (windowData) {
        const used = windowData.usedPercent !== undefined ? windowData.usedPercent : 0;
        const remaining = Math.max(0, Math.min(100, 100 - used));
        fill.style.width = remaining + '%';
        fill.className = 'progress-bar-fill' + (remaining < 15 ? ' danger' : remaining < 40 ? ' warning' : '');
        value.textContent = remaining + '% left';
        if (windowData.resetsAt) {
          const date = new Date(windowData.resetsAt * 1000);
          reset.textContent = isWeekly
            ? 'Resets: ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + formatResetCountdown(windowData.resetsAt)
            : 'Resets at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + formatResetCountdown(windowData.resetsAt);
        }
      }
      return item;
    }

    function accountBlock(account, isSystem) {
      const block = document.createElement('div');
      block.className = 'account-block' + (account.active ? ' active' : '');
      const head = document.createElement('div');
      head.className = 'account-head';
      const title = isSystem ? 'System account' : account.name;
      head.appendChild(textEl('span', 'account-name', title + (account.email ? ' - ' + account.email : '')));
      if (account.planType) head.appendChild(textEl('span', 'account-plan', account.planType));
      if (account.active) head.appendChild(textEl('span', 'account-active', 'active'));
      block.appendChild(head);
      if (account.error) block.appendChild(textEl('div', 'limit-reset', 'Limits unavailable: ' + account.error));
      block.appendChild(limitBlock('5-hour limit (5h)', account.primary, false));
      block.appendChild(limitBlock('Weekly limit (Weekly)', account.secondary, true));

      const actions = document.createElement('div');
      actions.className = 'account-actions';
      if (!account.active) {
        const activate = textEl('button', 'btn btn-ghost btn-xs', 'Activate');
        activate.addEventListener('click', function () {
          accountsApi('POST', '/api/accounts/' + (isSystem ? 'system' : encodeURIComponent(account.name)) + '/activate')
            .then(function () { fetchAccounts(false); })
            .catch(function (e) { showAccountsError(e.message); });
        });
        actions.appendChild(activate);
      }
      if (!isSystem && !account.active) {
        const remove = textEl('button', 'btn btn-ghost btn-xs', 'Remove');
        remove.addEventListener('click', function () {
          actions.textContent = '';
          actions.appendChild(textEl('span', 'limit-reset', 'Remove?'));
          const yes = textEl('button', 'btn btn-danger btn-xs', 'Yes');
          yes.addEventListener('click', function () {
            yes.disabled = true;
            accountsApi('DELETE', '/api/accounts/' + encodeURIComponent(account.name))
              .then(function () { fetchAccounts(false); })
              .catch(function (e) { showAccountsError(e.message); fetchAccounts(false); });
          });
          const no = textEl('button', 'btn btn-ghost btn-xs', 'No');
          no.addEventListener('click', function () { fetchAccounts(false); });
          actions.appendChild(yes);
          actions.appendChild(no);
        });
        actions.appendChild(remove);
      }
      block.appendChild(actions);
      return block;
    }

    function renderAccounts(data) {
      const list = document.getElementById('accountsList');
      list.textContent = '';
      list.appendChild(accountBlock(data.system, true));
      data.profiles.forEach(function (p) { list.appendChild(accountBlock(p, false)); });
      document.getElementById('autoSwitchToggle').checked = !!data.autoSwitch;
    }

    async function fetchAccounts(force = false) {
      try {
        const data = await accountsApi('GET', '/api/accounts' + (force ? '?force=1' : ''));
        showAccountsError('');
        renderAccounts(data);
      } catch (e) {
        showAccountsError('Failed to load accounts: ' + e.message);
      }
    }

    function stopAccountLoginPolling() {
      if (accountLoginTimer) clearInterval(accountLoginTimer);
      accountLoginTimer = null;
      accountLoginId = null;
    }

    function resetAddArea() {
      stopAccountLoginPolling();
      const area = document.getElementById('accountAddArea');
      area.textContent = '';
      const btn = textEl('button', 'btn btn-ghost btn-xs', 'Add account');
      btn.insertAdjacentHTML('afterbegin', '<svg class="icon"><use href="#i-plus"/></svg> ');
      btn.id = 'accountAddBtn';
      btn.addEventListener('click', openAddRow);
      area.appendChild(btn);
    }

    function openAddRow() {
      const area = document.getElementById('accountAddArea');
      area.textContent = '';
      const row = document.createElement('div');
      row.className = 'account-add-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'accountNameInput';
      input.placeholder = 'name (a-z, 0-9, -)';
      input.maxLength = 32;
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Account name');
      row.appendChild(input);
      const browser = textEl('button', 'btn btn-secondary btn-xs', 'Sign in with browser');
      const device = textEl('button', 'btn btn-secondary btn-xs', 'Use device code');
      const cancel = textEl('button', 'btn btn-ghost btn-xs', 'Cancel');
      browser.addEventListener('click', function () { startAccountLogin(input.value.trim(), 'browser'); });
      device.addEventListener('click', function () { startAccountLogin(input.value.trim(), 'device'); });
      cancel.addEventListener('click', resetAddArea);
      row.appendChild(browser);
      row.appendChild(device);
      row.appendChild(cancel);
      area.appendChild(row);
      input.focus();
    }

    async function startAccountLogin(name, method) {
      const area = document.getElementById('accountAddArea');
      let started;
      try {
        started = await accountsApi('POST', '/api/accounts', { name: name, method: method });
      } catch (e) {
        showAccountsError(e.message);
        return;
      }
      showAccountsError('');
      area.textContent = '';
      const box = document.createElement('div');
      box.className = 'account-login';
      if (started.authUrl) {
        const link = textEl('a', 'account-link', 'Open login page');
        link.href = started.authUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        box.appendChild(link);
      } else {
        const link = textEl('a', 'account-link', started.verificationUrl || '');
        link.href = started.verificationUrl || '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        box.appendChild(link);
        box.appendChild(textEl('span', 'account-code', 'Code: ' + (started.userCode || '')));
      }
      const state = textEl('span', 'limit-reset', 'Waiting for sign-in...');
      box.appendChild(state);
      const cancel = textEl('button', 'btn btn-ghost btn-xs', 'Cancel');
      cancel.addEventListener('click', function () {
        const id = accountLoginId;
        resetAddArea();
        if (id) accountsApi('POST', '/api/accounts/login/' + encodeURIComponent(id) + '/cancel').catch(function () {});
      });
      box.appendChild(cancel);
      area.appendChild(box);

      accountLoginId = started.loginId;
      accountLoginTimer = setInterval(async function () {
        const id = accountLoginId;
        if (!id) return;
        try {
          const st = await accountsApi('GET', '/api/accounts/login/' + encodeURIComponent(id));
          if (id !== accountLoginId || st.status === 'pending') return;
          resetAddArea();
          if (st.status === 'completed') fetchAccounts(true);
          else showAccountsError('Login ' + st.status + (st.error ? ': ' + st.error : ''));
        } catch (e) {
          state.textContent = 'Status check failed: ' + e.message;
        }
      }, 2000);
    }

    document.getElementById('accountsRefreshBtn').addEventListener('click', function () { fetchAccounts(true); });
    document.getElementById('accountAddBtn').addEventListener('click', openAddRow);
    document.getElementById('autoSwitchToggle').addEventListener('change', function (ev) {
      const box = ev.target;
      accountsApi('POST', '/api/accounts/auto-switch', { enabled: box.checked })
        .then(function () { showAccountsError(''); })
        .catch(function (e) { box.checked = !box.checked; showAccountsError(e.message); });
    });

    setInterval(updateStatus, 1000);
    setInterval(refreshProjects, 3000);
    refreshProjects();

    function addAboutRow(list, agent, isLead, editable, scope) {
      const row = document.createElement('div');
      row.className = 'about-role' + (isLead ? ' is-lead' : '');
      row.dataset.role = canonicalRoleId(agent.name);
      row.dataset.roleKey = agent.name;
      row.dataset.scope = scope || 'project';
      const displayName = agent.displayName || roleDisplayName(agent.name);
      const tools = agent.tools || {};
      const extra = [];
      if (tools.mcpServers && tools.mcpServers.length > 0) extra.push('MCP: ' + tools.mcpServers.join(', '));
      if (tools.skills) extra.push('skills');
      if (extra.length) setTooltip(row, extra.join('; '), false);
      if (editable) {
        row.classList.add('is-editable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', 'Edit ' + displayName + ' settings');
        row.addEventListener('click', function () { openRoleModal(agent, isLead, row, scope || 'project'); });
        row.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openRoleModal(agent, isLead, row, scope || 'project');
          }
        });
      }
      const head = document.createElement('div');
      head.className = 'about-role-head';
      const led = document.createElement('span');
      led.className = 'agent-led';
      led.setAttribute('role', 'img');
      setTooltip(led, 'idle', false);
      led.setAttribute('aria-label', 'idle');
      head.appendChild(led);
      head.appendChild(textEl('span', 'about-role-name', displayName));
      const roleId = textEl('span', 'about-role-id', canonicalRoleId(agent.name));
      setTooltip(roleId, canonicalRoleId(agent.name), true);
      head.appendChild(roleId);
      if (isLead) head.appendChild(textEl('span', 'about-badge', 'lead'));
      if (agent.pendingRestart) head.appendChild(textEl('span', 'about-badge', 'restart required'));
      const write = agent.sandbox === 'workspace-write';
      head.appendChild(textEl('span', 'about-badge' + (write ? ' write' : ''), write ? 'write' : 'read'));
      row.appendChild(head);
      if (agent.description) {
        const desc = textEl('div', 'about-desc', agent.description);
        setTooltip(desc, agent.description, true);
        row.appendChild(desc);
      }
      const override = agent.override || {};
      const chips = document.createElement('div');
      chips.className = 'about-chips';
      const displayedModel = agent.configuredModel || agent.model;
      const displayedEffort = agent.configuredEffort || agent.effort;
      const model = textEl('span', 'about-chip' + (override.model != null || (agent.pendingRestart && agent.configuredModel) ? ' is-override' : ''), displayedModel || '-');
      const effort = textEl('span', 'about-chip' + (override.effort != null || (agent.pendingRestart && agent.configuredEffort) ? ' is-override' : ''), displayedEffort || '-');
      if (override.model != null) setTooltip(model, 'Overridden for this project', false);
      if (override.effort != null) setTooltip(effort, 'Overridden for this project', false);
      if (agent.pendingRestart) {
        setTooltip(model, 'Saved system settings; restart the launcher to apply', false);
        setTooltip(effort, 'Saved system settings; restart the launcher to apply', false);
      }
      chips.appendChild(model);
      chips.appendChild(effort);
      row.appendChild(chips);
      const tokens = document.createElement('div');
      tokens.className = 'role-tokens hidden';
      tokens.appendChild(textEl('span', 'role-tokens-total is-placeholder', '-'));
      tokens.appendChild(textEl('span', 'role-tokens-split', ''));
      row.appendChild(tokens);
      list.appendChild(row);
    }

    // LED state of one role row: 'idle' before intake (no turns in the shown session),
    // otherwise 'active' while the role works in the latest turn, else 'available'.
    function teamLedState(hasTurns, roleActive) {
      if (!hasTurns) return 'idle';
      return roleActive ? 'active' : 'available';
    }

    // Light the LED of each agent that is active in the latest turn of the shown session.
    function updateTeamLeds() {
      const list = document.getElementById('aboutTeamList');
      if (!list) return;
      const turns = (sessionData && sessionData.turns) || [];
      const turn = currentSessionId && turns.length ? turns[turns.length - 1] : null;
      const state = turn && turn.leadTask && turn.leadTask.state;
      const working = state === 'TASK_STATE_WORKING' || state === 2;
      const activeRoles = new Set();
      let anyWorker = false;
      if (working) {
        (turn.workers || []).forEach(function (w) {
          if (w.state === 'submitting' || w.state === 'submitted') {
            anyWorker = true;
            activeRoles.add(canonicalRoleId(w.role));
          }
        });
        if (!anyWorker) activeRoles.add('coordinator');
      }
      list.querySelectorAll('.about-role').forEach(function (row) {
        const led = row.querySelector('.agent-led');
        if (!led) return;
        const state = teamLedState(Boolean(turn), activeRoles.has(row.dataset.role));
        led.classList.toggle('is-active', state === 'active');
        led.classList.toggle('is-available', state === 'available');
        const label = state;
        setTooltip(led, label, false);
        led.setAttribute('aria-label', label);
      });
    }

    // ---- Team band: token usage of the open session, per role
    // Compact token count: 812, 1.2k, 12.3k, 123k, 1.24M, 1.2B; null shows as n/a.
    function trimZeros(value, digits) {
      const s = value.toFixed(digits);
      return s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
    }

    function formatTokenCount(n) {
      if (n === null || n === undefined) return 'n/a';
      if (n < 1000) return String(n);
      if (n < 999500) return trimZeros(n / 1000, n < 100000 ? 1 : 0) + 'k';
      if (n < 999500000) return trimZeros(n / 1000000, n < 10000000 ? 2 : (n < 100000000 ? 1 : 0)) + 'M';
      return trimZeros(n / 1000000000, 2) + 'B';
    }

    // "-" when the session has no usage rows for the entry, "n/a" when rows exist without token data.
    function tokenTotalLabel(entry) {
      if (!entry || !entry.attempts) return '-';
      return formatTokenCount(entry.totalTokens);
    }

    function tokenSplitLabel(entry) {
      if (!entry || !entry.attempts || entry.totalTokens === null || entry.totalTokens === undefined) return '';
      return 'in ' + formatTokenCount(entry.inputTokens) + ' / cached ' + formatTokenCount(entry.cachedInputTokens)
        + ' / out ' + formatTokenCount(entry.outputTokens);
    }

    // The ledger role is the raw role name (the lead is "coordinator"); the canonical id is the fallback.
    function roleUsageEntry(row) {
      const byRole = (sessionUsage && sessionUsage.byRole) || {};
      return byRole[row.dataset.roleKey] || byRole[row.dataset.role] || null;
    }

    function renderTeamTokens() {
      const hasSession = Boolean(currentProjectId && currentSessionId);
      document.getElementById('teamTokens').classList.toggle('hidden', !hasSession);
      const total = sessionUsage ? sessionUsage.total : null;
      document.getElementById('teamTokenTotal').textContent = sessionUsage ? tokenTotalLabel(total) : '-';
      document.getElementById('teamTokenSplit').textContent = tokenSplitLabel(total);
      document.querySelectorAll('#aboutTeamList .about-role').forEach(function (row) {
        const block = row.querySelector('.role-tokens');
        if (!block) return;
        // The system agent keeps its own ledger: its usage comes from the team descriptor, not the session.
        const system = row.dataset.scope === 'system';
        const systemUsage = system && teamData && teamData.systemAgent ? teamData.systemAgent.usage : null;
        const entry = system ? (systemUsage || null) : (sessionUsage ? roleUsageEntry(row) : null);
        block.classList.toggle('hidden', system ? !systemUsage : !hasSession);
        const label = system || sessionUsage ? tokenTotalLabel(entry) : '-';
        const totalEl = block.querySelector('.role-tokens-total');
        totalEl.textContent = label;
        totalEl.classList.toggle('is-placeholder', label === '-' || label === 'n/a');
        block.querySelector('.role-tokens-split').textContent = tokenSplitLabel(entry);
      });
    }

    // Forced on a session change and when a task of the session finishes; while the project
    // server runs, at most once per 10 seconds. Stale responses are ignored.
    async function refreshSessionUsage(force) {
      const pid = currentProjectId;
      const sid = currentSessionId;
      const key = pid && sid ? pid + '/' + sid : '';
      if (key !== usageKey) {
        usageKey = key;
        sessionUsage = null;
        usageFetchAt = 0;
        force = true;
      }
      if (!key) {
        renderTeamTokens();
        return;
      }
      const now = Date.now();
      if (!force && (!serverRunning || now - usageFetchAt < 10000)) return;
      usageFetchAt = now;
      const token = ++usageToken;
      let next = null;
      try {
        const res = await fetch(projectUrl('/sessions/' + encodeURIComponent(sid) + '/usage'));
        if (res.ok) next = await res.json();
      } catch (_) {}
      if (token !== usageToken || pid !== currentProjectId || sid !== currentSessionId) return;
      sessionUsage = next;
      renderTeamTokens();
    }

    // ---- Session situation panel (SIT-3). Read-only contracts: GET .../sessions/:contextId/situation (SIT-1)
    // and GET .../git-status (SIT-2). While the lead is active the situation is fetched at most every 2 seconds;
    // otherwise once at the session switch and when a turn finishes. Git status: at most every 10 seconds and
    // on turn finish. A 404 or a failed request shows a quiet line, never an error. Stale responses are dropped.
    function readSituationCollapsed() {
      try { return localStorage.getItem(SITUATION_COLLAPSED_KEY) === '1'; } catch (_) { return false; }
    }

    function writeSituationCollapsed(value) {
      try { localStorage.setItem(SITUATION_COLLAPSED_KEY, value ? '1' : '0'); } catch (_) {}
    }

    function applySituationCollapsed() {
      document.getElementById('situationPanel').classList.toggle('is-collapsed', situationCollapsed);
      document.getElementById('situationToggle').setAttribute('aria-expanded', String(!situationCollapsed));
    }

    function toggleSituationPanel() {
      situationCollapsed = !situationCollapsed;
      writeSituationCollapsed(situationCollapsed);
      applySituationCollapsed();
    }

    function situationScope() {
      return currentProjectId && currentSessionId ? currentProjectId + '/' + currentSessionId : '';
    }

    // The lead works or waits for the owner: the latest turn is not terminal yet, or a dispatch is pending.
    function leadActive() {
      if (pendingTurn) return true;
      const last = lastTurn();
      return !!last && !isTerminalState(last.state);
    }

    async function refreshSituation(force) {
      const pid = currentProjectId;
      const sid = currentSessionId;
      const key = situationScope();
      if (key !== situationKey) {
        situationKey = key;
        situation = null;
        situationFetchAt = 0;
        force = true;
        renderSituationPanel();
      }
      if (!key) return;
      const now = Date.now();
      if (!force && (!leadActive() || now - situationFetchAt < 2000)) return;
      situationFetchAt = now;
      const token = ++situationToken;
      let next = null;
      try {
        const res = await fetch(projectUrl('/sessions/' + encodeURIComponent(sid) + '/situation'));
        if (res.ok) next = await res.json();
      } catch (_) {}
      if (token !== situationToken || pid !== currentProjectId || sid !== currentSessionId) return;
      situation = next;
      renderSituationPanel();
    }

    async function refreshGitStatus(force) {
      const pid = currentProjectId;
      if (pid !== gitKey) {
        gitKey = pid || '';
        gitStatus = null;
        gitFetchAt = 0;
        force = true;
      }
      if (!pid || !currentSessionId) return;
      const now = Date.now();
      if (!force && now - gitFetchAt < 10000) return;
      gitFetchAt = now;
      const token = ++gitToken;
      let next = null;
      try {
        const res = await fetch(projectUrl('/git-status'));
        if (res.ok) next = await res.json();
      } catch (_) {}
      if (token !== gitToken || pid !== currentProjectId) return;
      gitStatus = next;
      renderSituationPanel();
    }

    function iconEl(id) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + id);
      svg.appendChild(use);
      return svg;
    }

    function startedMs(value) {
      const t = typeof value === 'number' ? value : Date.parse(value);
      return Number.isFinite(t) ? t : null;
    }

    function situationBatch(sit) {
      return Array.isArray(sit.batch) ? sit.batch.filter(function (a) { return a && typeof a === 'object'; }) : [];
    }

    function situationStepIndex(sit) {
      const direct = SITUATION_STEPS.findIndex(function (s) { return s.phase === sit.phase; });
      if (direct >= 0) return direct;
      if (sit.phase === 'waiting_owner' || sit.phase === 'budget_pause' || sit.phase === 'system_repair' || sit.phase === 'system_wait') {
        const mapped = SITUATION_NODE_PHASE[sit.node];
        return SITUATION_STEPS.findIndex(function (s) { return s.phase === mapped; });
      }
      // A pause keeps the step the lead was in: its node, or Working when the batch has assignments.
      if (sit.phase === 'pausing' || sit.phase === 'paused') {
        const mapped = SITUATION_STEPS.findIndex(function (s) { return s.phase === SITUATION_NODE_PHASE[sit.node]; });
        if (mapped >= 0) return mapped;
        return situationBatch(sit).length ? 1 : -1;
      }
      return -1;
    }

    // Last step the turn entered: its node's phase, or Working once the batch has assignments.
    function situationReachedIndex(sit) {
      const mapped = SITUATION_STEPS.findIndex(function (s) { return s.phase === SITUATION_NODE_PHASE[sit.node]; });
      const reached = situationBatch(sit).length ? 1 : -1;
      return Math.max(mapped, reached);
    }

    function situationSummaryText(sit) {
      const label = sit.phase === 'paused' && pauseKindOf(sit) === 'stopped'
        ? 'Stopped' : SITUATION_PHASE_LABELS[sit.phase] || String(sit.phase || '');
      return Number.isFinite(sit.round) ? label + ', round ' + sit.round : label;
    }

    function situationBlock(title) {
      const block = document.createElement('div');
      block.className = 'situation-block';
      block.appendChild(textEl('div', 'situation-block-title', title));
      return block;
    }

    function situationTrack(sit) {
      const wrap = document.createElement('div');
      wrap.className = 'situation-track';
      const list = document.createElement('ol');
      list.className = 'situation-steps';
      // A failed or canceled turn has no current step: the steps it entered keep their checks.
      const stopped = sit.phase === 'failed' || sit.phase === 'canceled';
      const reached = situationReachedIndex(sit);
      const current = stopped ? -1 : situationStepIndex(sit);
      SITUATION_STEPS.forEach(function (step, i) {
        const item = document.createElement('li');
        item.className = 'situation-step';
        const passed = stopped ? i <= reached : i < current;
        if (i === current) {
          item.classList.add('is-current');
          item.setAttribute('aria-current', 'step');
        } else if (passed) {
          item.classList.add('is-done');
          item.appendChild(iconEl('i-check'));
        }
        item.appendChild(textEl('span', '', step.label));
        list.appendChild(item);
      });
      wrap.appendChild(list);
      if (sit.phase === 'waiting_owner') wrap.appendChild(textEl('span', 'situation-side is-waiting', 'Waiting for you'));
      if (sit.phase === 'budget_pause') {
        const side = textEl('span', 'situation-side is-budget', 'Budget pause');
        side.prepend(iconEl('i-pause'));
        wrap.appendChild(side);
      }
      if (sit.phase === 'system_repair') wrap.appendChild(textEl('span', 'situation-side is-pausing', 'Chuck Norris is repairing the control plane'));
      if (sit.phase === 'system_wait') wrap.appendChild(textEl('span', 'situation-side is-budget', 'Technical wait - no owner answer needed'));
      if (sit.phase === 'pausing') wrap.appendChild(textEl('span', 'situation-side is-pausing', 'Pausing'));
      if (sit.phase === 'paused') {
        wrap.appendChild(pauseKindOf(sit) === 'stopped'
          ? textEl('span', 'situation-side is-stopped', 'Stopped')
          : textEl('span', 'situation-side is-paused', 'Paused'));
      }
      if (sit.phase === 'failed') wrap.appendChild(textEl('span', 'situation-side is-failed', 'Failed'));
      if (sit.phase === 'canceled') wrap.appendChild(textEl('span', 'situation-side is-canceled', 'Canceled'));
      return wrap;
    }

    function situationMeta(sit) {
      const parts = [];
      if (Number.isFinite(sit.round)) parts.push('Round ' + sit.round);
      if (sit.budget && typeof sit.budget === 'object') {
        parts.push(sit.budget.source ? 'usage limit (' + sit.budget.source + ')' : 'usage limit');
      }
      return parts.length ? textEl('div', 'situation-meta', parts.join(', ')) : null;
    }

    function situationNow(sit) {
      const running = situationBatch(sit).filter(function (a) { return a.state === 'running'; });
      if (!running.length) return null;
      const block = situationBlock('Now');
      running.forEach(function (a) {
        const row = document.createElement('div');
        row.className = 'situation-row';
        row.appendChild(textEl('span', 'agent-led is-active', ''));
        row.appendChild(textEl('span', 'situation-role', roleDisplayName(String(a.role || ''))));
        const objective = String(a.objective || '');
        const objectiveEl = textEl('span', 'situation-objective', objective);
        setTooltip(objectiveEl, objective, true);
        row.appendChild(objectiveEl);
        const elapsed = textEl('span', 'situation-elapsed', '');
        const started = startedMs(a.startedAt);
        if (started !== null) elapsed.dataset.started = String(started);
        row.appendChild(elapsed);
        block.appendChild(row);
      });
      return block;
    }

    function situationFileList(key, summaryText, rows) {
      const box = document.createElement('details');
      box.className = 'situation-files';
      box.open = situationOpen.has(key);
      box.addEventListener('toggle', function () {
        if (box.open) situationOpen.add(key);
        else situationOpen.delete(key);
      });
      box.appendChild(textEl('summary', '', summaryText));
      const list = document.createElement('ul');
      list.className = 'situation-file-list';
      rows.forEach(function (row) {
        const item = document.createElement('li');
        if (row.status !== undefined) item.appendChild(textEl('span', 'situation-file-status', row.status));
        const path = textEl('span', 'situation-file-path', row.path);
        setTooltip(path, row.path, true);
        item.appendChild(path);
        list.appendChild(item);
      });
      box.appendChild(list);
      return box;
    }

    function situationDone(sit) {
      const finished = situationBatch(sit).filter(function (a) { return a.state === 'done' || a.state === 'failed'; });
      if (!finished.length) return null;
      const block = situationBlock('Done this turn');
      finished.forEach(function (a, i) {
        const row = document.createElement('div');
        row.className = 'situation-row situation-done';
        const head = document.createElement('div');
        head.className = 'situation-done-head';
        head.appendChild(textEl('span', 'situation-role', roleDisplayName(String(a.role || ''))));
        if (a.state === 'failed') head.appendChild(textEl('span', 'pill pill-failed', 'failed'));
        row.appendChild(head);
        const summary = String(a.summary || '');
        if (summary) {
          const line = textEl('div', 'situation-summary-line', summary);
          setTooltip(line, summary, true);
          row.appendChild(line);
        } else {
          row.appendChild(textEl('div', 'situation-summary-line situation-muted', 'No report'));
        }
        const files = Array.isArray(a.filesChanged) ? a.filesChanged.map(String) : [];
        if (files.length) {
          const count = files.length + (files.length === 1 ? ' file' : ' files');
          row.appendChild(situationFileList('done:' + String(a.assignmentId || i), count,
            files.map(function (path) { return { path: path }; })));
        }
        block.appendChild(row);
      });
      return block;
    }

    function situationFiles(git) {
      if (!git) return null;
      const files = Array.isArray(git.files) ? git.files : [];
      const stat = git.diffstat || {};
      const block = situationBlock('Changed files');
      if (!files.length && !stat.files) {
        block.appendChild(textEl('div', 'situation-meta', 'Working tree clean'));
        return block;
      }
      // Status "??" is untracked; the diffstat covers tracked files only.
      const untracked = files.filter(function (f) { return f.status === '??'; }).length;
      const tracked = files.length - untracked;
      const parts = [];
      if (tracked) parts.push(tracked + ' modified (+' + (stat.insertions || 0) + ' -' + (stat.deletions || 0) + ')');
      if (untracked) parts.push(untracked + ' untracked');
      block.appendChild(textEl('div', 'situation-diffstat', files.length + ' changed: ' + parts.join(', ')));
      if (files.length) {
        const count = files.length + (files.length === 1 ? ' file' : ' files');
        block.appendChild(situationFileList('git', 'Show ' + count, files.map(function (f) {
          return { status: String(f.status || ''), path: String(f.path || '') };
        })));
      }
      return block;
    }

    function situationAcceptance(sit) {
      const acc = sit.acceptance;
      if (!acc || typeof acc !== 'object') return null;
      const block = situationBlock('Acceptance');
      block.appendChild(textEl('div', 'situation-meta', String(acc.status || 'unknown')));
      (Array.isArray(acc.checks) ? acc.checks : []).forEach(function (check) {
        if (!check || typeof check !== 'object') return;
        const row = document.createElement('div');
        row.className = 'situation-row';
        row.appendChild(textEl('span', 'situation-objective', String(check.name || '')));
        row.appendChild(textEl('span', 'situation-elapsed', String(check.status || '')));
        block.appendChild(row);
      });
      return block;
    }

    function situationSystemRepair(sit) {
      const repair = sit.systemRepair;
      if (!repair || typeof repair !== 'object') return null;
      const labels = {
        pending: 'Repair is running', completed: 'Repair report received', restart_required: 'Repair needs a control-plane restart',
        blocked: 'Repair is blocked', unavailable: 'Repair service unavailable', unknown: 'Repair status unknown',
        waiting_for_budget: 'Repair is waiting for budget', budget: 'Repair is waiting for budget', recheck_limit: 'Repair recheck limit reached'
      };
      const block = situationBlock('Chuck Norris system repair');
      block.appendChild(textEl('div', 'situation-meta', labels[repair.status] || 'Repair status unknown'));
      if (repair.incidentId) block.appendChild(textEl('div', 'situation-meta', 'Incident: ' + String(repair.incidentId)));
      const reason = typeof repair.reason === 'string' ? repair.reason.replace(/_/g, ' ') : '';
      if (reason) block.appendChild(textEl('div', 'situation-meta', 'Reason: ' + reason));
      if (repair.status === 'restart_required') {
        block.appendChild(textEl('div', 'situation-meta', 'The control plane must restart and prove the loaded repair before another check can run.'));
      } else if (repair.status === 'budget') {
        block.appendChild(textEl('div', 'situation-meta', 'Wait for the system agent budget to recover before retrying.'));
      } else if (repair.status === 'recheck_limit') {
        block.appendChild(textEl('div', 'situation-meta', 'The system repair recheck limit has been reached.'));
      }
      if (canRetrySystemRepair(sit)) {
        const action = repair.status === 'restart_required' ? 'Check repair after restart' : 'Retry system repair';
        const retry = textEl('button', 'btn btn-secondary btn-sm', action);
        retry.type = 'button';
        retry.addEventListener('click', retrySystemRepair);
        block.appendChild(retry);
      }
      return block;
    }

    function canRetrySystemRepair(sit) {
      const last = lastTurn();
      const repair = sit && sit.systemRepair;
      if (!repair || sit.phase !== 'system_wait' || sit.pauseKind || !last || last.id !== sit.leadTaskId
        || !isPausedState(last.state) || last.metadata?.pause?.kind !== 'system_repair' || sending || pendingTurn) return false;
      if (repair.status === 'restart_required') return true;
      if (repair.status === 'unavailable') return repair.reason !== 'authentication_required';
      if (repair.status !== 'unknown') return false;
      if (!repair.reason) return true;
      return new Set([
        'aborted_before_dispatch', 'aborted_before_send', 'ambiguous_writable_submission_not_resent',
        'cancellation_unconfirmed', 'journaled_task_unavailable', 'send_result_unknown',
        'submission_lookup_failed', 'task_id_missing_after_send', 'task_poll_failed',
      ]).has(repair.reason);
    }

    function retrySystemRepair() {
      const sit = situationKey === situationScope() ? situation : null;
      const last = lastTurn();
      if (!canRetrySystemRepair(sit) || !currentProjectId || !currentSessionId || !last) return false;
      return executeA2A({ goal: 'Retry system repair', taskId: last.id });
    }

    function situationStop(sit) {
      const finished = sit.phase === 'done' || sit.phase === 'failed' || sit.phase === 'canceled';
      const text = typeof sit.nextSteps === 'string' ? sit.nextSteps.trim() : '';
      if (!finished || !text) return null;
      const block = situationBlock('Where we stopped');
      block.appendChild(textEl('div', 'situation-next', text));
      return block;
    }

    // Rebuilds the body only when the data changes; the elapsed times tick through tickSituationElapsed.
    function renderSituationPanel() {
      const panel = document.getElementById('situationPanel');
      const scope = situationScope();
      const visible = !!scope && (!!sessionData || !!pendingTurn);
      panel.classList.toggle('hidden', !visible);
      const sit = visible && situationKey === scope ? situation : null;
      // The old status bar repeats the panel; it stays only as the fallback while the situation is unavailable.
      document.getElementById('taskMetaBar').classList.toggle('hidden', !!sit);
      if (!visible) {
        situationSignature = '';
        return;
      }
      const git = gitKey === currentProjectId && gitStatus && gitStatus.available ? gitStatus : null;
      const signature = JSON.stringify([scope, sit, git]);
      if (signature !== situationSignature) {
        situationSignature = signature;
        const blocks = [];
        if (sit) blocks.push(situationTrack(sit), situationMeta(sit), situationNow(sit), situationDone(sit), situationSystemRepair(sit), situationAcceptance(sit));
        blocks.push(situationFiles(git));
        if (sit) blocks.push(situationStop(sit));
        const content = document.getElementById('situationContent');
        content.replaceChildren(...blocks.filter(Boolean));
        content.classList.toggle('hidden', content.childElementCount === 0);
        document.getElementById('situationUnavailable').classList.toggle('hidden', !!sit);
        document.getElementById('situationSummary').textContent = sit ? situationSummaryText(sit) : '';
      }
      const resumeBtn = document.getElementById('situationResume');
      resumeBtn.classList.toggle('hidden', !sit || sit.phase !== 'paused' || !currentSessionId);
      if (sit && sit.phase === 'paused' && pauseKindOf(sit) === 'stopped') setTooltip(resumeBtn, 'Continue the run that was stopped', false);
      else delete resumeBtn.dataset.tooltip;
      tickSituationElapsed();
      updateComposer();
    }

    function tickSituationElapsed() {
      const now = Date.now();
      document.querySelectorAll('#situationContent .situation-elapsed[data-started]').forEach(function (el) {
        el.textContent = fmtSpan(now - Number(el.dataset.started));
      });
    }

    // ---- Scout asks (SIT-5). POST .../ask, GET and DELETE .../ask/:askId. Local to this page: they are not
    // part of the lead's session. Running asks are polled every 1.5 seconds; stale responses are dropped.
    function askKey(pid, sid) {
      return pid + '/' + (sid || '-');
    }

    function currentAskKey() {
      return askKey(currentProjectId, currentSessionId);
    }

    function makeAsk(fields) {
      return Object.assign({
        answer: null, error: null, finishedAt: null,
        inFlight: false, polledAt: 0, cancelRequested: false
      }, fields);
    }

    function loadAsks(key) {
      if (!asksByKey.has(key)) {
        let list = [];
        try {
          const parsed = JSON.parse(sessionStorage.getItem(ASK_STORE_PREFIX + key) || '[]');
          if (Array.isArray(parsed)) {
            list = parsed.filter(function (a) { return a && typeof a.askId === 'string'; }).map(makeAsk);
          }
        } catch (_) {}
        asksByKey.set(key, list);
      }
      return asksByKey.get(key);
    }

    function saveAsks(key) {
      const list = asksByKey.get(key) || [];
      try {
        sessionStorage.setItem(ASK_STORE_PREFIX + key, JSON.stringify(list.map(function (a) {
          return {
            askId: a.askId, projectId: a.projectId, sessionId: a.sessionId, question: a.question,
            state: a.state, answer: a.answer, error: a.error, startedAt: a.startedAt, finishedAt: a.finishedAt
          };
        })));
      } catch (_) {}
    }

    function addAsk(key, ask) {
      const list = loadAsks(key);
      list.push(ask);
      if (list.length > ASK_KEEP) list.splice(0, list.length - ASK_KEEP);
      saveAsks(key);
    }

    function askFailureText(res, data) {
      if (res.status === 404) return 'Scout is not available on this launcher yet.';
      if (data && typeof data.error === 'string' && data.error) return data.error;
      return res.status === 409 ? 'The scout is busy or the project server is stopped.' : 'Scout request failed.';
    }

    // Mode: the owner's pick wins; otherwise Scout while the lead works, Lead when idle.
    function askMode() {
      const scoutOk = serverRunning && !!currentProjectId;
      if (scoutChoice === 'scout') return scoutOk ? 'scout' : 'lead';
      if (scoutChoice === 'lead') return 'lead';
      // A parked owner pause is not work: the composer stays in Lead mode for the continue message.
      return scoutOk && leadActive() && ownerPhase() !== 'paused' ? 'scout' : 'lead';
    }

    function setAskMode(mode) {
      if (mode === 'scout' && !(serverRunning && currentProjectId)) return;
      scoutChoice = mode === 'scout' ? 'scout' : 'lead';
      updateComposer();
    }

    async function sendScoutAsk() {
      const pid = currentProjectId;
      const input = document.getElementById('taskGoal');
      const question = input.value.trim();
      if (!pid || askSending) return;
      if (!question) return showNotice('sendError', 'Enter a question for the scout!');
      const sid = currentSessionId;
      const key = askKey(pid, sid);
      const body = { question: question };
      if (sid) body.sessionContextId = sid;
      askSending = true;
      updateComposer();
      let res = null;
      let data = {};
      try {
        res = await fetch('/api/projects/' + encodeURIComponent(pid) + '/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        data = await res.json().catch(function () { return {}; });
      } catch (_) {}
      askSending = false;
      if (res && res.ok && data && typeof data.askId === 'string') {
        addAsk(key, makeAsk({ askId: data.askId, projectId: pid, sessionId: sid, question: question, state: 'running', startedAt: Date.now() }));
        if (key === currentAskKey()) input.value = '';
        renderTranscript();
      } else {
        showNotice('sendError', res ? askFailureText(res, data) : 'Scout request failed.');
      }
      updateComposer();
    }

    function applyAskBody(ask, body) {
      if (typeof body.state === 'string') ask.state = body.state;
      ask.answer = typeof body.answer === 'string' ? body.answer : null;
      ask.error = typeof body.error === 'string' && body.error ? body.error : null;
      const started = startedMs(body.startedAt);
      if (started !== null) ask.startedAt = started;
      ask.finishedAt = startedMs(body.finishedAt);
    }

    function pollAsks() {
      tickAskElapsed();
      const now = Date.now();
      asksByKey.forEach(function (list, key) {
        list.forEach(function (ask) {
          if (ask.state !== 'running' || ask.inFlight || now - ask.polledAt < ASK_POLL_MS) return;
          ask.inFlight = true;
          ask.polledAt = now;
          fetch('/api/projects/' + encodeURIComponent(ask.projectId) + '/ask/' + encodeURIComponent(ask.askId))
            .then(function (res) {
              if (res.status === 404) return { state: 'failed', error: 'The server no longer knows this scout ask.' };
              return res.ok ? res.json() : null;
            })
            .then(function (body) {
              // An ask dropped from the list meanwhile is stale: ignore its answer.
              if (body && list.indexOf(ask) !== -1) applyAskBody(ask, body);
            })
            .catch(function () {})
            .then(function () {
              ask.inFlight = false;
              if (ask.state !== 'running') saveAsks(key);
              if (key === currentAskKey()) renderTranscript();
            });
        });
      });
    }

    async function cancelScoutAsk(key, askId) {
      const ask = (asksByKey.get(key) || []).find(function (a) { return a.askId === askId; });
      if (!ask || ask.state !== 'running' || ask.cancelRequested) return;
      ask.cancelRequested = true;
      renderTranscript();
      let res = null;
      try {
        res = await fetch('/api/projects/' + encodeURIComponent(ask.projectId) + '/ask/' + encodeURIComponent(askId), { method: 'DELETE' });
      } catch (_) {}
      if (!res || !res.ok) {
        ask.cancelRequested = false;
        showNotice('sendError', 'Could not cancel the scout ask.');
        renderTranscript();
        return;
      }
      ask.polledAt = 0;
      pollAsks();
    }

    function tickAskElapsed() {
      const now = Date.now();
      document.querySelectorAll('#transcript .ask-elapsed[data-started]').forEach(function (el) {
        el.textContent = fmtSpan(now - Number(el.dataset.started));
      });
    }

    const ASK_STATE_PILLS = {
      running: ['running', 'running'], done: ['done', 'answered'], failed: ['failed', 'failed'],
      canceled: ['canceled', 'canceled'], timeout: ['canceled', 'timeout']
    };

    // Answer text keeps its line breaks; file:line citations are set in mono.
    function scoutAnswerNode(answer) {
      const box = textEl('div', 'scout-answer', '');
      const text = answer || 'The scout returned no answer.';
      if (!answer) {
        box.textContent = text;
        return box;
      }
      const re = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?/g;
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
        box.appendChild(textEl('code', 'scout-cite', m[0]));
        last = m.index + m[0].length;
      }
      if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
      return box;
    }

    function scoutAskNode(ask, key) {
      const wrap = document.createElement('div');
      wrap.className = 'scout-ask';

      const question = document.createElement('div');
      question.className = 'bubble bubble-user scout-question';
      question.appendChild(textEl('div', 'scout-to', 'To scout'));
      question.appendChild(textEl('div', '', ask.question));
      wrap.appendChild(question);

      const bubble = document.createElement('div');
      bubble.className = 'scout-bubble is-' + ask.state;
      const head = document.createElement('div');
      head.className = 'scout-head';
      head.appendChild(iconEl('i-compass'));
      head.appendChild(textEl('span', 'scout-label', 'Scout'));
      const pill = ASK_STATE_PILLS[ask.state] || ['canceled', String(ask.state || '')];
      head.appendChild(statePill(pill[0], pill[1]));
      bubble.appendChild(head);

      const started = startedMs(ask.startedAt);
      if (ask.state === 'running') {
        const row = document.createElement('div');
        row.className = 'scout-running';
        row.appendChild(textEl('span', 'scout-muted', 'Reading the project...'));
        const elapsed = textEl('span', 'scout-meta ask-elapsed', '');
        if (started !== null) {
          elapsed.dataset.started = String(started);
          elapsed.textContent = fmtSpan(Date.now() - started);
        }
        row.appendChild(elapsed);
        if (ask.cancelRequested) {
          row.appendChild(textEl('span', 'scout-muted', 'Canceling...'));
        } else {
          const cancel = textEl('button', 'btn btn-ghost btn-xs', 'Cancel');
          cancel.type = 'button';
          cancel.addEventListener('click', function () { cancelScoutAsk(key, ask.askId); });
          row.appendChild(cancel);
        }
        bubble.appendChild(row);
      } else if (ask.state === 'done') {
        bubble.appendChild(scoutAnswerNode(ask.answer));
        const finished = ask.finishedAt;
        if (started !== null && finished !== null && finished >= started) {
          bubble.appendChild(textEl('div', 'scout-meta', 'Answered in ' + fmtSpan(finished - started)));
        }
      } else {
        const fallback = ask.state === 'timeout' ? 'The scout did not answer in time.'
          : ask.state === 'canceled' ? 'Canceled.' : 'The scout failed.';
        bubble.appendChild(textEl('div', ask.state === 'failed' ? 'scout-error' : 'scout-muted', ask.error || fallback));
      }
      wrap.appendChild(bubble);
      return wrap;
    }

    // The team card shows the roles of the selected project with its overrides; without a project, the profiles.
    let teamData = null;
    let teamLoadToken = 0;
    async function loadTeam() {
      const errEl = document.getElementById('aboutTeamError');
      const token = ++teamLoadToken;
      const projectId = currentProjectId;
      try {
        const res = await fetch(projectId ? projectUrl('/team') : '/api/team');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        if (token !== teamLoadToken) return;
        teamData = data;
        errEl.classList.add('hidden');
        // Roles are read when the project server starts, so they are editable only while it is stopped.
        const editable = Boolean(projectId) && data.running !== true;
        const note = document.getElementById('aboutTeamNote');
        note.textContent = 'Stop the project server to change roles';
        note.classList.toggle('hidden', !(projectId && data.running === true));
        const list = document.getElementById('aboutTeamList');
        hideUiTooltip();
        list.textContent = '';
        addAboutRow(list, data.lead, true, editable);
        data.roles.forEach(function (r) { addAboutRow(list, r, false, editable); });
        // The system agent is global: its row stays editable whenever no project server is running.
        if (data.systemAgent) addAboutRow(list, data.systemAgent, false, data.running !== true, 'system');
        updateTeamLeds();
        renderTeamTokens();
        document.getElementById('aboutTeamLabel').textContent = 'Team (' + (data.roles.length + 1 + (data.systemAgent ? 1 : 0)) + ' agents)';
        if (data.warning) {
          errEl.textContent = data.warning;
          errEl.classList.remove('hidden');
        }
      } catch (e) {
        if (token !== teamLoadToken) return;
        errEl.textContent = 'Failed to load team: ' + e.message;
        errEl.classList.remove('hidden');
      }
    }

    // ---- Role override modal (per project)
    const RULES_MAX = 4000;
    const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh'];
    let roleModalAgent = null;
    let roleModalProjectId = null;
    let roleModalScope = 'project';
    let roleModalOpener = null;
    let roleModalBusy = false;

    function fillRoleSelect(select, defaultValue, values, current) {
      select.textContent = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Default (' + defaultValue + ')';
      select.appendChild(def);
      const list = values.slice();
      if (current && list.indexOf(current) === -1) list.push(current);
      list.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
      });
      select.value = current || '';
    }

    function setRoleModalError(message) {
      const el = document.getElementById('roleModalError');
      el.textContent = message || '';
      el.classList.toggle('hidden', !message);
    }

    function updateRoleRulesCounter() {
      const len = document.getElementById('roleRules').value.length;
      const el = document.getElementById('roleRulesCounter');
      el.textContent = len + ' / ' + RULES_MAX;
      el.classList.toggle('is-over', len > RULES_MAX);
    }

    function setRoleModalBusy(busy) {
      roleModalBusy = busy;
      document.getElementById('roleSaveBtn').disabled = busy;
      document.getElementById('roleResetBtn').disabled = busy;
    }

    function openRoleModal(agent, isLead, opener, scope) {
      const systemScope = scope === 'system';
      if (systemScope ? (!agent || (teamData && teamData.running === true)) : (!currentProjectId || !teamData || teamData.running === true)) return;
      roleModalAgent = agent;
      roleModalProjectId = systemScope ? null : currentProjectId;
      roleModalScope = systemScope ? 'system' : 'project';
      roleModalOpener = opener || null;
      const defaults = agent.defaults || { model: agent.model, effort: agent.effort };
      const override = systemScope
        ? { model: agent.configuredModel || agent.model, effort: agent.configuredEffort || agent.effort }
        : (agent.override || {});
      document.getElementById('roleModalTitle').textContent =
        (agent.displayName || roleDisplayName(agent.name)) + ' (' + canonicalRoleId(agent.name) + (isLead ? ', lead' : '') + ')';
      fillRoleSelect(document.getElementById('roleModel'), defaults.model, (teamData && teamData.models) || [], override.model || '');
      fillRoleSelect(document.getElementById('roleEffort'), defaults.effort, EFFORT_CHOICES, override.effort || '');
      document.getElementById('roleRules').value = systemScope ? '' : (override.extraRules || '');
      document.getElementById('roleRules').closest('.role-field').classList.toggle('hidden', systemScope);
      document.querySelector('#roleForm .role-modal-note').textContent = systemScope
        ? (agent.pendingRestart
          ? 'Saved global settings are pending. Restart the launcher to apply them.'
          : 'Global system settings apply after the launcher restarts.')
        : 'Applies when the project server starts.';
      updateRoleRulesCounter();
      setRoleModalError('');
      setRoleModalBusy(false);
      document.getElementById('roleModal').classList.remove('hidden');
      document.getElementById('roleModel').focus();
    }

    function closeRoleModal() {
      document.getElementById('roleModal').classList.add('hidden');
      roleModalAgent = null;
      roleModalProjectId = null;
      roleModalScope = 'project';
      if (roleModalOpener && document.body.contains(roleModalOpener)) roleModalOpener.focus();
      roleModalOpener = null;
    }

    function roleOverrideUrl() {
      if (roleModalScope === 'system') return '/api/system-agent/settings';
      return '/api/projects/' + encodeURIComponent(roleModalProjectId) + '/roles/' + encodeURIComponent(canonicalRoleId(roleModalAgent.name)) + '/override';
    }

    async function sendRoleOverride(method, body) {
      if (!roleModalAgent || roleModalBusy) return;
      setRoleModalError('');
      setRoleModalBusy(true);
      try {
        await accountsApi(method, roleOverrideUrl(), body);
        closeRoleModal();
        await loadTeam();
      } catch (e) {
        setRoleModalError(e.message);
        setRoleModalBusy(false);
      }
    }

    function saveRoleOverride() {
      if (roleModalScope === 'system') {
        return sendRoleOverride('PUT', {
          model: document.getElementById('roleModel').value || roleModalAgent.defaults.model,
          effort: document.getElementById('roleEffort').value || roleModalAgent.defaults.effort
        });
      }
      const rules = document.getElementById('roleRules').value;
      if (rules.length > RULES_MAX) return setRoleModalError('Extra rules are limited to ' + RULES_MAX + ' characters');
      sendRoleOverride('PUT', {
        model: document.getElementById('roleModel').value || null,
        effort: document.getElementById('roleEffort').value || null,
        extraRules: rules.trim() || null
      });
    }

    function resetRoleOverride() {
      sendRoleOverride('DELETE');
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !document.getElementById('roleModal').classList.contains('hidden')) closeRoleModal();
    });

    loadTeam();
    syncPerformanceNavLink();

    setInterval(function () { if (!accountLoginId) fetchAccounts(false); }, 30000);
    fetchAccounts();
  
