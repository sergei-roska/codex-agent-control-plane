
    function setGoal(text) {
      document.getElementById('taskGoal').value = text;
      document.getElementById('taskGoal').focus();
    }
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

    // ---- Project binding: each tab is bound to one project (?project=<id>)
    let projectList = [];
    let currentProjectId = null;

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
    }

    function setSession(id) {
      currentSessionId = id;
      sessionData = null;
      pendingTurn = null;
      renderSignature = '';
      setSessionParam(id);
      renderTranscript();
      updateTeamLeds();
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
      const yes = textEl('button', 'btn btn-danger-outline btn-sm', 'Yes');
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
        document.getElementById('serverPill').style.borderColor = 'var(--border-subtle)';
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
          pill.style.borderColor = 'rgba(16, 185, 129, 0.4)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
        } else if (data.status === 'starting') {
          dot.classList.add('starting');
          text.innerText = 'Starting process...';
          pill.style.borderColor = 'rgba(245, 158, 11, 0.4)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
        } else {
          text.innerText = 'Server stopped';
          pill.style.borderColor = 'var(--border-subtle)';
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

    // ---- Composer and session controls
    function updateComposer() {
      const goalEl = document.getElementById('taskGoal');
      const sendBtn = document.getElementById('sendBtn');
      const newBtn = document.getElementById('newSessionBtn');
      const hint = document.getElementById('composerHint');
      const last = lastTurn();
      const lastTerminal = !!last && isTerminalState(last.state);

      goalEl.placeholder = currentSessionId
        ? 'Reply in this session'
        : 'Describe the goal, for example: Analyze the project and fix validation error in src/...';

      let hintText = '';
      if (!currentProjectId) hintText = 'Add or select a project first.';
      else if (!serverRunning) hintText = 'Start the orchestrator to send messages.';
      else if (sending || pendingTurn) hintText = 'Lead is working on your message...';
      else if (last && isPausedState(last.state)) hintText = 'Lead is paused: answer through the decision card above.';
      else if (last && !lastTerminal) hintText = 'Lead is working: wait for the answer before sending another message.';

      const locked = hintText !== '';
      goalEl.disabled = locked;
      sendBtn.disabled = locked;
      hint.textContent = hintText;
      hint.classList.toggle('hidden', !locked);
      newBtn.disabled = !(currentSessionId && lastTerminal && !sending && !pendingTurn);
      document.getElementById('activeTaskIdDisplay').textContent = currentSessionId
        ? 'session ' + currentSessionId.slice(0, 8)
        : 'no session';
    }

    function newSession() {
      setSession(null);
      autoOpenLatest = false;
      document.getElementById('decisionCard').classList.add('hidden');
      document.getElementById('sendError').classList.add('hidden');
      updateComposer();
      document.getElementById('taskGoal').focus();
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
        sum.title = a.summary;
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
          obj.title = String(w.objective);
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
        body = 'Paused: waiting for a human decision.\n\n' + extractParts(t.status?.message?.parts);
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
          argvEl.title = argv;
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
      else if (isPausedState(state)) label.textContent = 'Status: human decision required (paused)';
      else if (state === 'TASK_STATE_COMPLETED' || state === 3) {
        label.textContent = 'Status: COMPLETED SUCCESSFULLY';
        const disposition = last.artifacts?.at(-1)?.metadata?.acceptance?.disposition;
        badge.className = 'acceptance-pill ' + (disposition === 'accepted' ? 'acceptance-accepted'
          : disposition === 'rejected' ? 'acceptance-rejected' : 'acceptance-none');
        if (disposition || checks.length === 0) badge.textContent = acceptanceLabel(disposition);
      } else if (state === 'TASK_STATE_FAILED' || state === 4) label.textContent = 'Status: FAILED';
      else label.textContent = 'Status: ' + state;
    }

    function updateDecisionCard() {
      const card = document.getElementById('decisionCard');
      const last = lastTurn();
      if (!last || !isPausedState(last.state) || sending) {
        card.classList.add('hidden');
        return;
      }
      const pause = last.metadata?.pause || {};
      card.classList.remove('hidden');
      const promptText = pause.kind === 'error'
        ? 'Lead paused due to an error: ' + (pause.message || 'Error') + '\nSend a message to retry the step.'
        : (pause.question || pause.message || 'Waiting for response');
      document.getElementById('decisionQuestion').textContent = promptText;
      document.getElementById('decisionId').value = pause.decisionId || '';
      const optContainer = document.getElementById('decisionOptionsList');
      optContainer.textContent = '';
      (pause.options || []).forEach(opt => {
        const pill = textEl('span', 'option-pill', opt.id + ': ' + opt.description);
        pill.onclick = () => selectOption(opt.id);
        optContainer.appendChild(pill);
      });
    }

    function renderTranscript() {
      const transcript = document.getElementById('transcript');
      const turns = (sessionData && sessionData.turns) || [];
      const lastTurnRow = turns[turns.length - 1];
      const working = Boolean(lastTurnRow)
        && (lastTurnRow.leadTask.state === 'TASK_STATE_WORKING' || lastTurnRow.leadTask.state === 2);
      const tick = working ? Math.floor(Date.now() / 5000) : 0;
      const signature = JSON.stringify([currentSessionId, sessionData, pendingTurn && pendingTurn.goal, tick]);
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
        badge.style.cssText = 'background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3);';
        badge.textContent = 'In Progress';
      } else if (isPausedState(state)) {
        badge.className = 'acceptance-pill';
        badge.style.cssText = 'background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3);';
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
            const delBtn = textEl('button', 'btn btn-danger-outline btn-sm', 'Delete');
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

    async function sendMessage() {
      const goal = document.getElementById('taskGoal').value.trim();
      if (!goal) return showNotice('sendError', 'Enter a message!');


      const last = lastTurn();
      const payload = { goal };
      if (currentSessionId) {
        if (!last || !isTerminalState(last.state)) return;
        payload.continueFrom = last.id;
      } else {
        setSession(newContextId());
        payload.contextId = currentSessionId;
      }
      pendingTurn = { goal, baseTurns: sessionData ? sessionData.turns.length : 0 };
      document.getElementById('taskGoal').value = '';
      await executeA2A(payload);
    }

    async function submitDecision() {
      const last = lastTurn();
      if (!last) return;
      const decisionId = document.getElementById('decisionId').value;
      const choice = document.getElementById('decisionChoice').value.trim();
      const answer = document.getElementById('decisionAnswer').value.trim();

      document.getElementById('decisionAnswer').value = '';
      document.getElementById('decisionChoice').value = '';
      await executeA2A({
        goal: answer || choice || 'Approved',
        taskId: last.id,
        decision: decisionId,
        choice: choice || undefined
      });
    }

    function selectOption(id) {
      document.getElementById('decisionChoice').value = id;
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
        const activate = textEl('button', 'terminal-btn', 'Activate');
        activate.addEventListener('click', function () {
          accountsApi('POST', '/api/accounts/' + (isSystem ? 'system' : encodeURIComponent(account.name)) + '/activate')
            .then(function () { fetchAccounts(false); })
            .catch(function (e) { showAccountsError(e.message); });
        });
        actions.appendChild(activate);
      }
      if (!isSystem && !account.active) {
        const remove = textEl('button', 'terminal-btn', 'Remove');
        remove.addEventListener('click', function () {
          actions.textContent = '';
          actions.appendChild(textEl('span', 'limit-reset', 'Remove?'));
          const yes = textEl('button', 'terminal-btn', 'Yes');
          yes.addEventListener('click', function () {
            yes.disabled = true;
            accountsApi('DELETE', '/api/accounts/' + encodeURIComponent(account.name))
              .then(function () { fetchAccounts(false); })
              .catch(function (e) { showAccountsError(e.message); fetchAccounts(false); });
          });
          const no = textEl('button', 'terminal-btn', 'No');
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
      const btn = textEl('button', 'terminal-btn', 'Add account');
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
      const browser = textEl('button', 'terminal-btn', 'Sign in with browser');
      const device = textEl('button', 'terminal-btn', 'Use device code');
      const cancel = textEl('button', 'terminal-btn', 'Cancel');
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
      const cancel = textEl('button', 'terminal-btn', 'Cancel');
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

    function addAboutRow(list, agent, isLead, editable) {
      const row = document.createElement('div');
      row.className = 'about-role';
      row.dataset.role = canonicalRoleId(agent.name);
      if (editable) {
        row.classList.add('is-editable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', 'Edit ' + (agent.displayName || roleDisplayName(agent.name)) + ' settings');
        row.addEventListener('click', function () { openRoleModal(agent, isLead, row); });
        row.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openRoleModal(agent, isLead, row);
          }
        });
      }
      const head = document.createElement('div');
      head.className = 'about-role-head';
      const led = document.createElement('span');
      led.className = 'agent-led';
      led.setAttribute('role', 'img');
      led.title = 'idle';
      led.setAttribute('aria-label', 'idle');
      head.appendChild(led);
      const name = document.createElement('span');
      name.className = 'about-role-name';
      name.textContent = agent.displayName || roleDisplayName(agent.name);
      head.appendChild(name);
      const id = document.createElement('span');
      id.className = 'about-role-id';
      id.textContent = canonicalRoleId(agent.name);
      head.appendChild(id);
      if (isLead) {
        const lead = document.createElement('span');
        lead.className = 'about-badge';
        lead.textContent = 'lead';
        head.appendChild(lead);
      }
      const write = agent.sandbox === 'workspace-write';
      const badge = document.createElement('span');
      badge.className = 'about-badge' + (write ? ' write' : '');
      badge.textContent = write ? 'write' : 'read';
      head.appendChild(badge);
      const model = document.createElement('span');
      model.className = 'about-model';
      model.textContent = agent.model + ' · ' + agent.effort;
      head.appendChild(model);
      if (agent.override) {
        const over = document.createElement('span');
        over.className = 'about-badge override';
        over.textContent = 'override';
        head.appendChild(over);
      }
      row.appendChild(head);
      const desc = document.createElement('div');
      desc.className = 'about-desc';
      desc.textContent = agent.description;
      row.appendChild(desc);
      const tools = agent.tools || {};
      const extra = [];
      if (tools.mcpServers && tools.mcpServers.length > 0) extra.push('MCP: ' + tools.mcpServers.join(', '));
      if (tools.skills) extra.push('skills');
      if (extra.length > 0) {
        const line = document.createElement('div');
        line.className = 'about-extra';
        line.textContent = extra.join(' · ');
        row.appendChild(line);
      }
      list.appendChild(row);
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
        const on = activeRoles.has(row.dataset.role);
        led.classList.toggle('is-active', on);
        const label = on ? 'active' : 'idle';
        led.title = label;
        led.setAttribute('aria-label', label);
      });
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
        teamData = projectId ? data : null;
        errEl.classList.add('hidden');
        const list = document.getElementById('aboutTeamList');
        list.textContent = '';
        addAboutRow(list, data.lead, true, Boolean(projectId));
        data.roles.forEach(function (r) { addAboutRow(list, r, false, Boolean(projectId)); });
        updateTeamLeds();
        document.getElementById('aboutTeamSummary').textContent = 'Team (' + (data.roles.length + 1) + ' agents)';
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

    function openRoleModal(agent, isLead, opener) {
      if (!currentProjectId || !teamData) return;
      roleModalAgent = agent;
      roleModalOpener = opener || null;
      const defaults = agent.defaults || { model: agent.model, effort: agent.effort };
      const override = agent.override || {};
      document.getElementById('roleModalTitle').textContent =
        (agent.displayName || roleDisplayName(agent.name)) + ' (' + canonicalRoleId(agent.name) + (isLead ? ', lead' : '') + ')';
      fillRoleSelect(document.getElementById('roleModel'), defaults.model, teamData.models || [], override.model || '');
      fillRoleSelect(document.getElementById('roleEffort'), defaults.effort, EFFORT_CHOICES, override.effort || '');
      document.getElementById('roleRules').value = override.extraRules || '';
      updateRoleRulesCounter();
      setRoleModalError('');
      setRoleModalBusy(false);
      document.getElementById('roleModal').classList.remove('hidden');
      document.getElementById('roleModel').focus();
    }

    function closeRoleModal() {
      document.getElementById('roleModal').classList.add('hidden');
      roleModalAgent = null;
      if (roleModalOpener && document.body.contains(roleModalOpener)) roleModalOpener.focus();
      roleModalOpener = null;
    }

    function roleOverrideUrl() {
      return projectUrl('/roles/' + encodeURIComponent(canonicalRoleId(roleModalAgent.name)) + '/override');
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

    setInterval(function () { if (!accountLoginId) fetchAccounts(false); }, 30000);
    fetchAccounts();
  
