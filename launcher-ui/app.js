
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

    async function addProject() {
      const input = document.getElementById('projectPathInput');
      const projectPath = input.value.trim();
      if (!projectPath) return alert('Specify project path!');
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
        alert('Failed to add project: ' + err.message);
      }
    }

    async function removeProject() {
      const cur = currentProject();
      if (!cur) return;
      if (!confirm('Remove project from the list?\n' + cur.path + '\n(Files and task history stay on disk.)')) return;
      try {
        const res = await fetch(projectUrl(''), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to remove project');
        await refreshProjects();
      } catch (err) {
        alert('Failed to remove project: ' + err.message);
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

    function leadBubble(turn) {
      const t = turn.leadTask;
      const workers = turn.workers || [];
      const state = t.state;
      const bubble = document.createElement('div');
      bubble.className = 'bubble bubble-lead';
      const head = document.createElement('div');
      head.className = 'bubble-head';
      head.appendChild(textEl('span', '', 'Lead'));
      let body = '';

      if (state === 'TASK_STATE_WORKING' || state === 2) {
        head.appendChild(textEl('span', '', 'working'));
        body = 'Lead analyzes the goal, creates assignments, and coordinates specialists...';
        if (workers.length) {
          body += '\n\nRound specialists:\n' + workers.map(w => '  [' + w.state + '] ' + w.role).join('\n');
        }
      } else if (isPausedState(state)) {
        head.appendChild(textEl('span', '', 'paused'));
        bubble.classList.add('bubble-paused');
        body = 'Paused: waiting for a human decision.\n\n' + extractParts(t.status?.message?.parts);
      } else if (state === 'TASK_STATE_COMPLETED' || state === 3) {
        const artifact = t.artifacts?.at(-1);
        head.appendChild(textEl('span', '', acceptanceLabel(artifact?.metadata?.acceptance?.disposition)));
        body = extractParts(artifact?.parts) || extractParts(t.status?.message?.parts) || 'Completed without additional text.';
      } else if (state === 'TASK_STATE_FAILED' || state === 4) {
        head.appendChild(textEl('span', '', 'failed'));
        bubble.classList.add('bubble-failed');
        body = 'Task failed with an error:\n\n' + extractParts(t.status?.message?.parts);
      } else {
        head.appendChild(textEl('span', '', String(state)));
        body = extractParts(t.status?.message?.parts);
      }
      bubble.appendChild(head);
      bubble.appendChild(textEl('div', '', body));
      return bubble;
    }

    function updateStatusBar() {
      const label = document.getElementById('taskStatusLabel');
      const badge = document.getElementById('acceptanceBadge');
      const last = lastTurn();
      badge.className = 'acceptance-pill acceptance-none';
      badge.textContent = 'no checks';
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
        badge.textContent = acceptanceLabel(disposition);
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
      const signature = JSON.stringify([currentSessionId, sessionData, pendingTurn && pendingTurn.goal]);
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
            delBtn.addEventListener('click', () => deleteSessionItem(s.contextId, s.goal));
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

    async function deleteSessionItem(contextId, goalText) {
      if (!confirm('Delete the whole session from the database?\n"' + goalText + '"')) return;
      try {
        const res = await fetch(projectUrl('/sessions/' + encodeURIComponent(contextId)), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete session');
        if (currentSessionId === contextId) setSession(null);
        loadSessions();
        openHistoryModal();
      } catch (err) {
        alert('Failed to delete: ' + err.message);
      }
    }

    async function startServer() {
      if (!currentProjectId) return alert('Add or select a project first!');

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
        alert('Failed to stop: ' + err.message);
      }
      refreshProjects();
      setTimeout(updateStatus, 500);
    }

    async function sendMessage() {
      const goal = document.getElementById('taskGoal').value.trim();
      if (!goal) return alert('Enter a message!');


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
      if (!currentProjectId) return alert('Add or select a project first!');
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

    async function fetchLimits(force = false) {
      try {
        const res = await fetch('/api/limits' + (force ? '?force=1' : ''));
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success) return;

        if (data.email) {
          document.getElementById('accountEmail').innerText = data.email;
        }
        if (data.planType) {
          document.getElementById('planTypeBadge').innerText = data.planType;
          document.getElementById('accountType').innerText = data.planType;
        }

        if (data.primary) {
          const used = data.primary.usedPercent !== undefined ? data.primary.usedPercent : 0;
          const bar = document.getElementById('fiveHourBar');
          bar.style.width = Math.min(used, 100) + '%';
          bar.className = 'progress-bar-fill' + (used > 85 ? ' danger' : used > 60 ? ' warning' : '');
          document.getElementById('fiveHourVal').innerText = used + '%';

          if (data.primary.resetsAt) {
            const date = new Date(data.primary.resetsAt * 1000);
            document.getElementById('fiveHourReset').innerText = 'Resets at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + formatResetCountdown(data.primary.resetsAt);
          }
        }

        if (data.secondary) {
          const used = data.secondary.usedPercent !== undefined ? data.secondary.usedPercent : 0;
          const bar = document.getElementById('weeklyBar');
          bar.style.width = Math.min(used, 100) + '%';
          bar.className = 'progress-bar-fill' + (used > 85 ? ' danger' : used > 60 ? ' warning' : '');
          document.getElementById('weeklyVal').innerText = used + '%';

          if (data.secondary.resetsAt) {
            const date = new Date(data.secondary.resetsAt * 1000);
            document.getElementById('weeklyReset').innerText = 'Resets: ' + date.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + formatResetCountdown(data.secondary.resetsAt);
          }
        }
      } catch (_) {}
    }

    setInterval(updateStatus, 1000);
    setInterval(refreshProjects, 3000);
    refreshProjects();

    function addAboutRow(list, agent, isLead) {
      const row = document.createElement('div');
      row.className = 'about-role';
      const head = document.createElement('div');
      head.className = 'about-role-head';
      const name = document.createElement('span');
      name.className = 'about-role-name';
      name.textContent = agent.name;
      head.appendChild(name);
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

    async function loadTeam() {
      const errEl = document.getElementById('aboutTeamError');
      try {
        const res = await fetch('/api/team');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        const list = document.getElementById('aboutTeamList');
        list.textContent = '';
        addAboutRow(list, data.lead, true);
        data.roles.forEach(function (r) { addAboutRow(list, r, false); });
        document.getElementById('aboutTeamSummary').textContent = 'Team (' + (data.roles.length + 1) + ' agents)';
      } catch (e) {
        errEl.textContent = 'Failed to load team: ' + e.message;
        errEl.classList.remove('hidden');
      }
    }
    loadTeam();

    setInterval(fetchLimits, 30000);
    fetchLimits();
  
