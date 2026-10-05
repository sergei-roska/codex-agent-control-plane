
    let currentTaskId = null;

    function setGoal(text) {
      document.getElementById('taskGoal').value = text;
      document.getElementById('taskGoal').focus();
    }
    function addCheck(cmd) {
      const el = document.getElementById('taskChecks');
      el.value = el.value ? el.value + ', ' + cmd : cmd;
    }
    function clearChecks() {
      document.getElementById('taskChecks').value = '';
    }
    function clearLogs() {
      document.getElementById('serverLogsBody').innerText = '';
    }

    // Ctrl+Enter for quick dispatch
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const btn = document.getElementById('dispatchBtn');
        if (!btn.disabled) dispatchTask();
      }
    });

    let serverRunning = false;
    let displayedTaskTerminal = false;

    function updateContinueBtn() {
      const btn = document.getElementById('continueBtn');
      if (displayedTaskTerminal && currentTaskId) {
        btn.classList.remove('hidden');
        btn.disabled = !serverRunning;
      } else {
        btn.classList.add('hidden');
        btn.disabled = true;
      }
    }

    async function updateStatus() {
      try {
        const res = await fetch('/api/server/status');
        const data = await res.json();

        const dot = document.getElementById('serverDot');
        const text = document.getElementById('serverStatusText');
        const pill = document.getElementById('serverPill');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        const dispatchBtn = document.getElementById('dispatchBtn');

        dot.className = 'status-dot';
        serverRunning = data.status === 'running';
        updateContinueBtn();

        if (data.status === 'running') {
          dot.classList.add('active');
          text.innerText = 'Orchestrator active';
          pill.style.borderColor = 'rgba(16, 185, 129, 0.4)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
          dispatchBtn.disabled = false;
        } else if (data.status === 'starting') {
          dot.classList.add('starting');
          text.innerText = 'Starting process...';
          pill.style.borderColor = 'rgba(245, 158, 11, 0.4)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
          dispatchBtn.disabled = true;
        } else {
          text.innerText = 'Server stopped';
          pill.style.borderColor = 'var(--border-subtle)';
          startBtn.disabled = false;
          stopBtn.disabled = true;
          dispatchBtn.disabled = true;
        }

        const logsBody = document.getElementById('serverLogsBody');
        if (data.logs && data.logs.length) {
          logsBody.innerText = data.logs.join('');
          logsBody.scrollTop = logsBody.scrollHeight;
        }

        if (data.status === 'running') {
          await syncActiveTask();
        }
        await fetchHistoryCount();
      } catch (_) {}
    }

    let viewingArchivedTaskId = null;
    let dismissedTaskId = null;

    function isActiveState(state) {
      return state === 'TASK_STATE_SUBMITTED' || state === 1
        || state === 'TASK_STATE_WORKING' || state === 2
        || state === 'TASK_STATE_INPUT_REQUIRED' || state === 6
        || state === 'TASK_STATE_AUTH_REQUIRED' || state === 8;
    }

    function isTerminalState(state) {
      return state === 'TASK_STATE_COMPLETED' || state === 3
        || state === 'TASK_STATE_FAILED' || state === 4
        || state === 'TASK_STATE_CANCELED' || state === 5
        || state === 'TASK_STATE_REJECTED' || state === 7;
    }

    async function syncActiveTask() {
      if (viewingArchivedTaskId) return;
      try {
        const res = await fetch('/api/tasks/latest');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.leadTask) return;
        if (dismissedTaskId && data.leadTask.id === dismissedTaskId && isTerminalState(data.leadTask.state)) return;
        if (!isTerminalState(data.leadTask.state) || data.leadTask.id !== dismissedTaskId) dismissedTaskId = null;
        renderTaskView(data.leadTask, data.workers || [], false);
      } catch (_) {}
    }

    function renderTaskView(leadTask, workers = [], isArchive = false) {
      if (!leadTask) return;

      currentTaskId = leadTask.id;
      document.getElementById('activeTaskIdDisplay').innerText = 'ID: ' + leadTask.id;
      displayedTaskTerminal = isTerminalState(leadTask.state);
      updateContinueBtn();
      const resetBadge = document.getElementById('acceptanceBadge');
      resetBadge.className = 'acceptance-pill acceptance-none';
      resetBadge.innerText = 'no checks';

      const goalBox = document.getElementById('activeTaskGoalBox');
      const goalTextEl = document.getElementById('activeTaskGoalText');
      const goalSubEl = document.getElementById('activeTaskSubText');
      const goalHeaderTitle = document.getElementById('activeGoalHeaderTitle');
      const deleteBtn = document.getElementById('deleteCurrentTaskBtn');
      const archiveBanner = document.getElementById('archiveViewingBanner');

      if (isArchive) {
        archiveBanner.classList.remove('hidden');
        goalHeaderTitle.innerText = 'Archived task / Goal:';
      } else {
        archiveBanner.classList.add('hidden');
        goalHeaderTitle.innerText = 'Current task / Goal:';
      }

      if (leadTask.goal) {
        goalTextEl.innerText = leadTask.goal;
        if (leadTask.lastInstruction && leadTask.lastInstruction !== leadTask.goal) {
          goalSubEl.innerText = 'Follow-up: ' + leadTask.lastInstruction;
          goalSubEl.classList.remove('hidden');
        } else {
          goalSubEl.classList.add('hidden');
        }
        if (leadTask.continuesFrom) {
          const prefix = 'continuation of ' + leadTask.continuesFrom.slice(0, 8) + '...';
          goalSubEl.innerText = goalSubEl.classList.contains('hidden') ? prefix : prefix + ' | ' + goalSubEl.innerText;
          goalSubEl.classList.remove('hidden');
        }
        goalBox.classList.remove('hidden');
      } else {
        goalBox.classList.add('hidden');
      }

      const state = leadTask.state;
      const isWorking = state === 'TASK_STATE_WORKING' || state === 2;
      const isInputRequired = state === 'TASK_STATE_INPUT_REQUIRED' || state === 6;
      const isCompleted = state === 'TASK_STATE_COMPLETED' || state === 3;
      const isFailed = state === 'TASK_STATE_FAILED' || state === 4;

      if (isCompleted || isFailed) {
        deleteBtn.classList.remove('hidden');
      } else {
        deleteBtn.classList.add('hidden');
      }

      const statusLabel = document.getElementById('taskStatusLabel');
      const out = document.getElementById('taskOutputArea');
      const dispatchBtn = document.getElementById('dispatchBtn');

      const goalBanner = leadTask.goal ? '🎯 Goal: ' + leadTask.goal + '\n\n' : '';

      if (isWorking) {
        statusLabel.innerText = 'Status: task in progress...';
        dispatchBtn.disabled = true;
        document.getElementById('decisionCard').classList.add('hidden');

        let workerStatusText = '';
        if (workers && workers.length) {
          workerStatusText = '\n\nRound specialists:\n' + workers.map(w => {
            const icon = w.state === 'finished' ? '✅' : w.state === 'submitted' ? '⏳' : '📋';
            return '  ' + icon + ' ' + w.role + ': ' + w.state;
          }).join('\n');
        }

        out.innerText = goalBanner + '>>> Task dispatched to Lead Orchestrator (LangGraph).\nLead analyzes goal, creates assignments, and coordinates specialists...' + workerStatusText;

      } else if (isInputRequired) {
        statusLabel.innerText = 'Status: human decision required (paused)';
        dispatchBtn.disabled = false;

        const pause = leadTask.metadata?.pause || {};
        document.getElementById('decisionCard').classList.remove('hidden');
        const isErrorPause = pause.kind === 'error';
        
        let promptText = isErrorPause
          ? 'Lead paused due to an error: ' + (pause.message || 'Error') + '\nSend a message to retry the step.'
          : (pause.question || pause.message || 'Waiting for response');
          
        document.getElementById('decisionQuestion').innerText = promptText;
        document.getElementById('decisionId').value = pause.decisionId || '';

        const optContainer = document.getElementById('decisionOptionsList');
        optContainer.innerHTML = '';
        if (pause.options && pause.options.length) {
          pause.options.forEach(opt => {
            const pill = document.createElement('span');
            pill.className = 'option-pill';
            pill.innerText = opt.id + ': ' + opt.description;
            pill.onclick = () => selectOption(opt.id);
            optContainer.appendChild(pill);
          });
        }

        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + '⚠️ TASK PAUSED\nLead is waiting for human decision before continuing.\n\n' + msgText;

      } else if (isCompleted) {
        statusLabel.innerText = 'Status: COMPLETED SUCCESSFULLY';
        dispatchBtn.disabled = false;
        document.getElementById('decisionCard').classList.add('hidden');

        const artifact = leadTask.artifacts?.at(-1);
        const artifactText = extractParts(artifact?.parts);
        const disposition = artifact?.metadata?.acceptance?.disposition;

        const accBadge = document.getElementById('acceptanceBadge');
        if (disposition === 'accepted') {
          accBadge.className = 'acceptance-pill acceptance-accepted';
          accBadge.innerText = 'Acceptance: Passed';
        } else if (disposition === 'rejected') {
          accBadge.className = 'acceptance-pill acceptance-rejected';
          accBadge.innerText = 'Acceptance: Rejected';
        } else {
          accBadge.className = 'acceptance-pill acceptance-none';
          accBadge.innerText = 'Acceptance: ' + (disposition || 'n/a');
        }

        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + '✅ WORK COMPLETED\n' + (artifactText || msgText || 'Completed without additional text.');

      } else if (isFailed) {
        statusLabel.innerText = 'Status: FAILED';
        dispatchBtn.disabled = false;
        document.getElementById('decisionCard').classList.add('hidden');
        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + '❌ Task failed with an error:\n\n' + msgText;
      } else {
        statusLabel.innerText = 'Status: ' + state;
        dispatchBtn.disabled = false;
        document.getElementById('decisionCard').classList.add('hidden');
        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + msgText;
      }
    }

    async function fetchHistoryCount() {
      try {
        const res = await fetch('/api/tasks/history');
        if (!res.ok) return;
        const data = await res.json();
        const badge = document.getElementById('historyCountBadge');
        if (badge && data.tasks) badge.innerText = data.tasks.length;
      } catch (_) {}
    }

    async function openHistoryModal() {
      const modal = document.getElementById('historyModal');
      const container = document.getElementById('historyListContainer');
      modal.classList.remove('hidden');
      container.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 20px;">Loading history...</div>';

      try {
        const res = await fetch('/api/tasks/history');
        if (!res.ok) throw new Error('Failed to load history');
        const data = await res.json();
        const tasks = data.tasks || [];

        if (tasks.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 30px;">History is empty. Dispatched tasks will appear here.</div>';
          return;
        }

        container.innerHTML = '';
        tasks.forEach(t => {
          const item = document.createElement('div');
          item.className = 'history-item';

          const isWorking = t.state === 'TASK_STATE_WORKING' || t.state === 2;
          const isInputReq = t.state === 'TASK_STATE_INPUT_REQUIRED' || t.state === 6;
          const isCompleted = t.state === 'TASK_STATE_COMPLETED' || t.state === 3;
          const isFailed = t.state === 'TASK_STATE_FAILED' || t.state === 4;

          let statusBadge = '<span class="acceptance-pill acceptance-none">' + escapeHtml(String(t.state)) + '</span>';
          if (isWorking) statusBadge = '<span class="acceptance-pill" style="background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3);">In Progress</span>';
          else if (isInputReq) statusBadge = '<span class="acceptance-pill" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3);">Awaiting Decision</span>';
          else if (isCompleted) statusBadge = '<span class="acceptance-pill acceptance-accepted">Success</span>';
          else if (isFailed) statusBadge = '<span class="acceptance-pill acceptance-rejected">Failed</span>';

          const dateStr = t.updatedAt ? new Date(t.updatedAt).toLocaleString('en-US') : '';
          const canDelete = isCompleted || isFailed;

          item.innerHTML = ''
            + '<div class="history-item-header">'
            + '  <span>' + statusBadge + '</span>'
            + '  <span>' + dateStr + '</span>'
            + '</div>'
            + '<div class="history-item-goal">' + escapeHtml(t.goal) + '</div>'
            + '<div class="history-item-meta">'
            + '  <span>ID: ' + t.id.slice(0, 8) + '...</span>'
            + '  <span>Specialists: ' + t.workerCount + '</span>'
            + '  <span>Acceptance: ' + (t.disposition || 'n/a') + '</span>'
            + (t.continuesFrom ? '  <span>continuation ' + escapeHtml(t.continuesFrom.slice(0, 8)) + '...</span>' : '')
            + '</div>'
            + '<div class="history-item-actions"></div>';

          const actions = item.querySelector('.history-item-actions');
          if (canDelete) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-danger-outline btn-sm';
            delBtn.textContent = '🗑 Delete';
            delBtn.addEventListener('click', () => deleteTaskItem(t.id, t.goal));
            actions.appendChild(delBtn);
          }
          const openBtn = document.createElement('button');
          openBtn.className = 'btn btn-secondary btn-sm';
          openBtn.textContent = '👁 Open';
          openBtn.addEventListener('click', () => selectArchivedTask(t.id));
          actions.appendChild(openBtn);
          container.appendChild(item);
        });

      } catch (err) {
        container.innerHTML = '<div style="color: var(--danger); text-align: center; padding: 20px;">Failed to load history: ' + escapeHtml(err.message) + '</div>';
      }
    }

    function closeHistoryModal() {
      document.getElementById('historyModal').classList.add('hidden');
    }

    async function selectArchivedTask(taskId) {
      closeHistoryModal();
      try {
        const res = await fetch('/api/tasks/' + taskId);
        if (!res.ok) throw new Error('Task not found');
        const data = await res.json();
        viewingArchivedTaskId = taskId;
        renderTaskView(data.leadTask, data.workers || [], true);
      } catch (err) {
        alert('Failed to open task: ' + err.message);
      }
    }

    function showEmptyState() {
      document.getElementById('activeTaskGoalBox').classList.add('hidden');
      document.getElementById('archiveViewingBanner').classList.add('hidden');
      document.getElementById('decisionCard').classList.add('hidden');
      document.getElementById('taskOutputArea').innerText = 'Task dispatch results, specialist reports, and the final verdict will appear here.';
      document.getElementById('taskStatusLabel').innerText = 'Status: waiting to start';
      const badge = document.getElementById('acceptanceBadge');
      badge.className = 'acceptance-pill acceptance-none';
      badge.innerText = 'no checks';
      document.getElementById('activeTaskIdDisplay').innerText = 'no active task';
      currentTaskId = null;
      displayedTaskTerminal = false;
      updateContinueBtn();
    }

    async function closeTaskView() {
      const closing = currentTaskId;
      dismissedTaskId = closing;
      viewingArchivedTaskId = null;
      showEmptyState();
      try {
        const res = await fetch('/api/tasks/latest');
        if (!res.ok) return;
        const data = await res.json();
        if (data.leadTask && isTerminalState(data.leadTask.state)) dismissedTaskId = data.leadTask.id;
      } catch (_) {}
    }

    async function returnToLatestTask() {
      viewingArchivedTaskId = null;
      try {
        const res = await fetch('/api/tasks/latest');
        if (!res.ok) throw new Error('latest');
        const data = await res.json();
        if (data.leadTask && isActiveState(data.leadTask.state)) {
          dismissedTaskId = null;
          renderTaskView(data.leadTask, data.workers || [], false);
          return;
        }
        dismissedTaskId = data.leadTask ? data.leadTask.id : null;
      } catch (_) {}
      showEmptyState();
    }

    async function deleteTaskItem(taskId, goalText) {
      if (!confirm('Delete task from database?\n' + (goalText ? '"' + goalText + '"' : taskId))) return;

      try {
        const res = await fetch('/api/tasks/' + taskId, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete task');

        if (viewingArchivedTaskId === taskId || currentTaskId === taskId) {
          viewingArchivedTaskId = null;
          document.getElementById('taskOutputArea').innerText = 'Task deleted from database.';
          document.getElementById('taskStatusLabel').innerText = 'Status: task deleted';
          document.getElementById('activeTaskIdDisplay').innerText = '';
          document.getElementById('activeTaskGoalBox').classList.add('hidden');
          document.getElementById('archiveViewingBanner').classList.add('hidden');
          currentTaskId = null;
          syncActiveTask();
        }

        fetchHistoryCount();
        openHistoryModal();
      } catch (err) {
        alert('Failed to delete: ' + err.message);
      }
    }

    async function deleteCurrentTask() {
      if (!currentTaskId) return;
      const goalEl = document.getElementById('activeTaskGoalText');
      const goal = goalEl ? goalEl.innerText : currentTaskId;
      await deleteTaskItem(currentTaskId, goal);
    }

    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function startServer() {
      const workspace = document.getElementById('workspaceInput').value.trim();
      if (!workspace) return alert('Specify project path!');

      const startBtn = document.getElementById('startBtn');
      const stopBtn = document.getElementById('stopBtn');
      const text = document.getElementById('serverStatusText');
      const dot = document.getElementById('serverDot');
      const logs = document.getElementById('serverLogsBody');

      startBtn.disabled = true;
      dot.className = 'status-dot starting';
      text.innerText = 'Starting process...';
      logs.innerText = '[LAUNCHER] Initializing server startup...\n';

      try {
        const res = await fetch('/api/server/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace })
        });
        const data = await res.json();
        if (!data.success) {
          logs.innerText += '[ERROR] ' + (data.message || data.error || 'Failed to start server') + '\n';
        }
      } catch (err) {
        logs.innerText += '[NETWORK ERROR] No connection to launcher: ' + err.message + '\n';
      }
      setTimeout(updateStatus, 800);
    }

    async function stopServer() {
      const stopBtn = document.getElementById('stopBtn');
      const text = document.getElementById('serverStatusText');
      stopBtn.disabled = true;
      text.innerText = 'Stopping...';

      try {
        await fetch('/api/server/stop', { method: 'POST' });
      } catch (err) {
        alert('Failed to stop: ' + err.message);
      }
      setTimeout(updateStatus, 500);
    }

    async function dispatchTask() {
      const goal = document.getElementById('taskGoal').value.trim();
      if (!goal) return alert('Enter task goal!');

      const checksRaw = document.getElementById('taskChecks').value.trim();
      const checks = checksRaw ? checksRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      currentTaskId = null;
      viewingArchivedTaskId = null;
      dismissedTaskId = null;
      document.getElementById('archiveViewingBanner').classList.add('hidden');
      document.getElementById('decisionCard').classList.add('hidden');
      await executeA2A({ goal, checks });
    }

    async function continueTask() {
      const goal = document.getElementById('taskGoal').value.trim();
      if (!goal) return alert('Enter task goal!');
      if (!currentTaskId || !displayedTaskTerminal) return;

      const checksRaw = document.getElementById('taskChecks').value.trim();
      const checks = checksRaw ? checksRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      const continueFrom = currentTaskId;
      currentTaskId = null;
      viewingArchivedTaskId = null;
      dismissedTaskId = null;
      displayedTaskTerminal = false;
      updateContinueBtn();
      document.getElementById('archiveViewingBanner').classList.add('hidden');
      document.getElementById('decisionCard').classList.add('hidden');
      await executeA2A({ goal, checks, continueFrom });
    }

    async function submitDecision() {
      const decisionId = document.getElementById('decisionId').value;
      const choice = document.getElementById('decisionChoice').value.trim();
      const answer = document.getElementById('decisionAnswer').value.trim();

      document.getElementById('decisionCard').classList.add('hidden');
      await executeA2A({
        goal: answer || choice || 'Approved',
        taskId: currentTaskId,
        decision: decisionId,
        choice: choice || undefined
      });
    }

    function selectOption(id) {
      document.getElementById('decisionChoice').value = id;
    }

    async function executeA2A(payload) {
      const out = document.getElementById('taskOutputArea');
      const statusLabel = document.getElementById('taskStatusLabel');
      const dispatchBtn = document.getElementById('dispatchBtn');

      if (payload.goal) {
        document.getElementById('activeTaskGoalText').innerText = payload.goal;
        document.getElementById('activeTaskSubText').classList.add('hidden');
        document.getElementById('activeTaskGoalBox').classList.remove('hidden');
      }

      dispatchBtn.disabled = true;
      statusLabel.innerText = 'Status: task in progress...';
      const goalBanner = payload.goal ? '🎯 Goal: ' + payload.goal + '\n\n' : '';
      out.innerText = goalBanner + '>>> Task dispatched to Lead Orchestrator (LangGraph).\nLead analyzes goal, creates assignments, and delegates them to specialists...\nPlease do not close this page.';

      try {
        const res = await fetch('/api/task/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        const task = data.result;
        currentTaskId = task.id || currentTaskId;
        document.getElementById('activeTaskIdDisplay').innerText = currentTaskId ? 'ID: ' + currentTaskId : '';

        const state = task.status?.state;
        const msgText = extractParts(task.status?.message?.parts);

        const isInputRequired = state === 'TASK_STATE_INPUT_REQUIRED' || state === 6 || state === '6';
        const isCompleted = state === 'TASK_STATE_COMPLETED' || state === 3 || state === '3';
        const isFailed = state === 'TASK_STATE_FAILED' || state === 4 || state === '4';

        if (isInputRequired) {
          statusLabel.innerText = 'Status: Input required (paused)';
          const pause = task.metadata?.pause || {};
          
          document.getElementById('decisionCard').classList.remove('hidden');
          const isErrorPause = pause.kind === 'error';
          
          let promptText = isErrorPause
            ? 'Error during Lead step: ' + (pause.message || 'Error') + '\nSend a message to retry the step.'
            : (pause.question || pause.message || 'Waiting for response');
            
          document.getElementById('decisionQuestion').innerText = promptText;
          document.getElementById('decisionId').value = pause.decisionId || '';

          if (isErrorPause && !document.getElementById('decisionAnswer').value) {
            document.getElementById('decisionAnswer').value = 'Retry without trailing slashes in allowedFiles';
          }

          const optContainer = document.getElementById('decisionOptionsList');
          optContainer.innerHTML = '';
          if (pause.options && pause.options.length) {
            pause.options.forEach(opt => {
              const pill = document.createElement('span');
              pill.className = 'option-pill';
              pill.innerText = opt.id + ': ' + opt.description;
              pill.onclick = () => selectOption(opt.id);
              optContainer.appendChild(pill);
            });
          }

          out.innerText = goalBanner + '⚠️ TASK PAUSED\nLead is waiting for response before continuing.\n\n' + msgText;

        } else if (isCompleted) {
          statusLabel.innerText = 'Status: COMPLETED SUCCESSFULLY';
          const artifact = task.artifacts?.at(-1);
          const artifactText = extractParts(artifact?.parts);
          const disposition = artifact?.metadata?.acceptance?.disposition;

          const accBadge = document.getElementById('acceptanceBadge');
          if (disposition === 'accepted') {
            accBadge.className = 'acceptance-pill acceptance-accepted';
            accBadge.innerText = 'Acceptance: Passed';
          } else if (disposition === 'rejected') {
            accBadge.className = 'acceptance-pill acceptance-rejected';
            accBadge.innerText = 'Acceptance: Rejected';
          } else {
            accBadge.className = 'acceptance-pill acceptance-none';
            accBadge.innerText = 'Acceptance: ' + (disposition || 'n/a');
          }

          out.innerText = goalBanner + '✅ WORK COMPLETED\n' + (artifactText || msgText || 'Completed without additional text.');

        } else if (isFailed) {
          statusLabel.innerText = 'Status: FAILED';
          out.innerText = goalBanner + '❌ Task failed with an error:\n\n' + msgText;
        } else {
          statusLabel.innerText = 'Status: ' + state;
          out.innerText = goalBanner + 'Response status: ' + state + '\n\n' + msgText;
        }

      } catch (err) {
        statusLabel.innerText = 'Status: error';
        out.innerText = '❌ Execution error:\n' + err.message;
      } finally {
        dispatchBtn.disabled = false;
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
    updateStatus();

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
  