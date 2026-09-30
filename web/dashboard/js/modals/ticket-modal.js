// --- TICKET DETAIL & CREATION / EDIT MODALS ---
let currentDetailTicketId = null;
let currentEditTicketId = null;
let attachedFileNames = [];

function renderAttachmentChips(containerEl, fileList, isEditable = true) {
  if (!containerEl) return;
  if (!fileList || fileList.length === 0) {
    containerEl.innerHTML = '<span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">No files attached</span>';
    return;
  }

  containerEl.innerHTML = fileList.map((fileName, idx) => `
    <span class="badge" style="display: inline-flex; align-items: center; gap: 6px; margin: 3px; font-size: 11px; color: var(--text-primary);">
      <span>&#x1F4CE; ${escapeHtml(fileName)}</span>
      ${isEditable ? `<button type="button" class="btn-remove-attachment" data-index="${idx}" style="background: none; border: none; cursor: pointer; color: var(--accent-red); font-size: 12px; font-weight: bold; padding: 0 2px;">&times;</button>` : ''}
    </span>
  `).join('');

  if (isEditable) {
    containerEl.querySelectorAll('.btn-remove-attachment').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const removeIdx = parseInt(btn.dataset.index, 10);
        attachedFileNames.splice(removeIdx, 1);
        renderAttachmentChips(containerEl, attachedFileNames, true);
      });
    });
  }
}

function openTicketDetailModal(ticketId) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  currentDetailTicketId = ticketId;

  const titleEl = document.getElementById('m1-title');
  const badgeEl = document.getElementById('m1-status-badge');
  const ticketTitleEl = document.getElementById('m1-ticket-title');
  const ticketDescEl = document.getElementById('m1-ticket-desc');
  const roleTextEl = document.getElementById('m1-role-text');
  const priorityTextEl = document.getElementById('m1-priority-text');
  const createdTextEl = document.getElementById('m1-created-text');

  if (titleEl) titleEl.textContent = `${ticket.id}`;
  if (badgeEl) {
    badgeEl.textContent = ticket.status;
    badgeEl.className = `badge badge-status ${ticket.status}`;
  }
  
  if (ticketTitleEl) ticketTitleEl.textContent = ticket.title;
  if (ticketDescEl) ticketDescEl.textContent = ticket.description || 'No description.';
  if (roleTextEl) roleTextEl.textContent = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[ticket.role]) ? ROLE_NAMES[ticket.role] : ticket.role;
  if (priorityTextEl) priorityTextEl.textContent = ticket.priority;
  if (createdTextEl) createdTextEl.textContent = ticket.created;

  // Acceptance Criteria
  const acWrapper = document.getElementById('m1-ac-wrapper');
  const ticketAcEl = document.getElementById('m1-ticket-ac');
  if (acWrapper && ticketAcEl) {
    if (ticket.acceptanceCriteria) {
      ticketAcEl.textContent = ticket.acceptanceCriteria;
      acWrapper.style.display = 'block';
    } else {
      acWrapper.style.display = 'none';
    }
  }

  // Links (Jira Issue, Parent/Epic, Confluence, Figma)
  const linksWrapper = document.getElementById('m1-links-wrapper');
  if (linksWrapper) {
    const linkBadges = [];
    const parseMulti = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val.filter(Boolean);
      return String(val).split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    };

    const mainJiras = parseMulti(ticket.jiraIssue || ticket.jira);
    mainJiras.forEach(item => {
      const isUrl = item.startsWith('http');
      linkBadges.push(`<a href="${isUrl ? item : '#'}" target="_blank" class="badge" style="color:var(--accent-blue); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">Jira: ${escapeHtml(item)}</a>`);
    });

    const parentJiras = parseMulti(ticket.jiraParents);
    parentJiras.forEach(item => {
      const isUrl = item.startsWith('http');
      linkBadges.push(`<a href="${isUrl ? item : '#'}" target="_blank" class="badge" style="color:var(--accent-indigo, #818cf8); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">Parent/Epic: ${escapeHtml(item)}</a>`);
    });

    const confList = parseMulti(ticket.confluence);
    confList.forEach((item, idx) => {
      const isUrl = item.startsWith('http');
      const label = confList.length > 1 ? `Confluence Spec (${idx + 1})` : 'Confluence Spec';
      linkBadges.push(`<a href="${isUrl ? item : '#'}" target="_blank" class="badge" style="color:var(--accent-cyan); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">${label}</a>`);
    });

    const figmaList = parseMulti(ticket.figma);
    figmaList.forEach((item, idx) => {
      const isUrl = item.startsWith('http');
      const label = figmaList.length > 1 ? `Figma Design (${idx + 1})` : 'Figma Design';
      linkBadges.push(`<a href="${isUrl ? item : '#'}" target="_blank" class="badge" style="color:var(--accent-purple); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">${label}</a>`);
    });

    if (ticket.ctaUrl) {
      linkBadges.push(`<a href="${ticket.ctaUrl}" target="_blank" class="badge" style="color:var(--accent-green); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">Link &rarr;</a>`);
    }

    if (linkBadges.length > 0) {
      linksWrapper.innerHTML = `<strong style="font-size:12px; display:block; margin-bottom:6px;">Attached Links &amp; References:</strong><div style="display:flex; flex-wrap:wrap; gap:6px;">` + linkBadges.join('') + `</div>`;
      linksWrapper.style.display = 'block';
    } else {
      linksWrapper.style.display = 'none';
    }
  }

  // Attachments
  const filesWrapper = document.getElementById('m1-files-wrapper');
  if (filesWrapper) {
    if (ticket.files && ticket.files.length > 0) {
      filesWrapper.innerHTML = `<strong>Attachments (${ticket.files.length}):</strong> ` + ticket.files.map(f => `<span>&bull; ${escapeHtml(f)}</span>`).join(' ');
      filesWrapper.style.display = 'block';
    } else {
      filesWrapper.style.display = 'none';
    }
  }

  const runLogList = document.getElementById('m1-runlog-list');
  if (runLogList) {
    runLogList.innerHTML = (ticket.runLog && ticket.runLog.length > 0)
      ? ticket.runLog.map(l => `<div>- ${escapeHtml(l)}</div>`).join('')
      : '<div style="color:var(--text-muted);">No log entries.</div>';
  }

  const turnsList = document.getElementById('m1-turns-list');
  if (turnsList) {
    turnsList.innerHTML = (ticket.turns && ticket.turns.length > 0)
      ? ticket.turns.map(turn => `
          <div style="background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:12px; border-radius:12px;">
            <strong>${escapeHtml(turn.type)}:</strong> <span style="font-family:var(--font-mono); font-size:12px;">${escapeHtml(turn.content)}</span>
          </div>
        `).join('')
      : '<div style="color:var(--text-muted);">No turns recorded.</div>';
  }

  const attemptsBody = document.getElementById('m1-attempts-body');
  if (attemptsBody) {
    attemptsBody.innerHTML = (ticket.attempts && ticket.attempts.length > 0)
      ? ticket.attempts.map(a => {
          const roleName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[a.role]) ? ROLE_NAMES[a.role] : a.role;
          return `
            <tr>
              <td>${a.num}</td>
              <td style="font-family:var(--font-sans); font-weight:600;" title="${escapeHtml(a.role)}">${escapeHtml(roleName)}</td>
              <td>${escapeHtml(a.provider)}</td>
              <td style="font-family:var(--font-sans); font-size:12px; font-weight:500;">${escapeHtml(typeof formatModelName === 'function' ? formatModelName(a.model) : a.model)}</td>
              <td><span class="badge">${escapeHtml(a.tier)}</span></td>
              <td><span class="badge ${a.outcome === 'Succeeded' ? 'badge-status done' : (a.outcome === 'In Progress' ? 'badge-status in_progress' : 'badge-status blocked')}">${escapeHtml(a.outcome)}</span></td>
              <td>${escapeHtml(a.started)}</td>
              <td>${escapeHtml(a.finished)}</td>
            </tr>
          `;
        }).join('')
      : '<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:14px;">No attempts recorded.</td></tr>';
  }

  // Operator Action Buttons setup
  const btnPause = document.getElementById('m1-btn-pause');
  const btnPauseIcon = document.getElementById('m1-btn-pause-icon');
  const btnPauseText = document.getElementById('m1-btn-pause-text');
  const btnStop = document.getElementById('m1-btn-stop');
  const btnCancel = document.getElementById('m1-btn-cancel');
  const btnReturnBacklog = document.getElementById('m1-btn-return-backlog');

  if (btnPause && btnPauseIcon && btnPauseText) {
    if (ticket.status === 'in_progress') {
      btnPause.style.display = 'inline-flex';
      btnPause.style.color = 'var(--accent-amber)';
      btnPauseIcon.innerHTML = '&#x23F8;';
      btnPauseText.textContent = 'Pause';
    } else if (ticket.status === 'paused') {
      btnPause.style.display = 'inline-flex';
      btnPause.style.color = 'var(--accent-green)';
      btnPauseIcon.innerHTML = '&#x25B6;';
      btnPauseText.textContent = 'Resume';
    } else {
      btnPause.style.display = 'none';
    }
  }

  if (btnStop) {
    if (['in_progress', 'paused', 'waiting_human'].includes(ticket.status)) {
      btnStop.style.display = 'inline-flex';
    } else {
      btnStop.style.display = 'none';
    }
  }

  if (btnCancel) {
    if (!['done', 'cancelled', 'stopped'].includes(ticket.status)) {
      btnCancel.style.display = 'inline-flex';
    } else {
      btnCancel.style.display = 'none';
    }
  }

  if (btnReturnBacklog) {
    btnReturnBacklog.style.display = 'inline-flex';
    if (ticket.status === 'backlog') {
      btnReturnBacklog.innerHTML = '<span>&#x21A9;</span> In Backlog';
    } else {
      btnReturnBacklog.innerHTML = '<span>&#x21A9;</span> Return to Backlog';
    }
  }

  // Metrics & Cost setup
  renderTicketMetrics(ticket);

  // Reset tab selection to overview
  document.querySelectorAll('#modal-ticket-detail .sub-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#modal-ticket-detail .sub-tab-pane').forEach(p => p.classList.remove('active'));
  const overviewBtn = document.querySelector('#modal-ticket-detail .sub-tab-btn[data-subtab="m1-overview"]');
  const overviewPane = document.getElementById('m1-overview');
  if (overviewBtn) overviewBtn.classList.add('active');
  if (overviewPane) overviewPane.classList.add('active');

  const detailModal = document.getElementById('modal-ticket-detail');
  if (detailModal) detailModal.classList.add('open');
}

function calculateFallbackMetrics(ticket) {
  if (!ticket.attempts || ticket.attempts.length === 0) {
    return {
      totalCost: 0,
      promptCost: 0,
      completionCost: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      roleBreakdown: []
    };
  }

  const PRICING = {
    'gemini-2.5-pro': { prompt: 1.25, completion: 5.0 },
    'gemini-2.5-flash': { prompt: 0.075, completion: 0.30 },
    'gemini': { prompt: 0.075, completion: 0.30 },
    'claude-3-7-sonnet': { prompt: 3.0, completion: 15.0 },
    'claude': { prompt: 3.0, completion: 15.0 },
    'o3-mini': { prompt: 1.1, completion: 4.4 },
    'codex': { prompt: 1.1, completion: 4.4 },
    'deepseek': { prompt: 0.14, completion: 0.28 },
    'default': { prompt: 1.0, completion: 3.0 }
  };

  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCost = 0;
  let promptCost = 0;
  let completionCost = 0;

  const roleBreakdown = ticket.attempts.map((att, idx) => {
    const pTokens = 11000 + ((idx + 1) * 3200);
    const cTokens = 2200 + ((idx + 1) * 750);
    const modelKey = Object.keys(PRICING).find(k => (att.model || att.provider || '').toLowerCase().includes(k)) || 'default';
    const rate = PRICING[modelKey];

    const pCost = (pTokens / 1000000) * rate.prompt;
    const cCost = (cTokens / 1000000) * rate.completion;
    const attCost = pCost + cCost;

    totalPrompt += pTokens;
    totalCompletion += cTokens;
    promptCost += pCost;
    completionCost += cCost;
    totalCost += attCost;

    return {
      role: att.role || ticket.role || 'developer',
      provider: att.provider,
      model: att.model || att.provider,
      promptTokens: pTokens,
      completionTokens: cTokens,
      totalTokens: pTokens + cTokens,
      cost: attCost,
      percentage: 0
    };
  });

  roleBreakdown.forEach(item => {
    item.percentage = totalCost > 0 ? (item.cost / totalCost) * 100 : 0;
  });

  return {
    totalCost,
    promptCost,
    completionCost,
    totalTokens: totalPrompt + totalCompletion,
    promptTokens: totalPrompt,
    completionTokens: totalCompletion,
    cachedTokens: Math.floor(totalPrompt * 0.35),
    roleBreakdown
  };
}

function renderTicketMetrics(ticket) {
  const costEl = document.getElementById('m1-metric-cost');
  const costSubEl = document.getElementById('m1-metric-cost-sub');
  const tokensEl = document.getElementById('m1-metric-tokens');
  const tokensSubEl = document.getElementById('m1-metric-tokens-sub');
  const cacheEl = document.getElementById('m1-metric-cache');
  const cacheSubEl = document.getElementById('m1-metric-cache-sub');
  const runsEl = document.getElementById('m1-metric-runs');
  const runsSubEl = document.getElementById('m1-metric-runs-sub');
  const roleCountEl = document.getElementById('m1-role-breakdown-count');
  const progressBarEl = document.getElementById('m1-role-progress-bar');
  const roleTableBody = document.getElementById('m1-metrics-role-body');

  if (!costEl || !tokensEl || !roleTableBody) return;

  const metrics = ticket.metrics || calculateFallbackMetrics(ticket);

  if (!metrics || metrics.totalTokens === 0) {
    costEl.textContent = '$0.0000';
    if (costSubEl) costSubEl.textContent = 'In: $0.00 | Out: $0.00';
    tokensEl.textContent = '0';
    if (tokensSubEl) tokensSubEl.textContent = 'Prompt + Completion';
    if (cacheEl) cacheEl.textContent = '0';
    if (cacheSubEl) cacheSubEl.textContent = 'Cached Prompt Reads';
    if (runsEl) runsEl.textContent = '0';
    if (runsSubEl) runsSubEl.textContent = 'Active Invocations';
    if (roleCountEl) roleCountEl.textContent = '0 roles';
    if (progressBarEl) progressBarEl.innerHTML = '<div style="width: 100%; height: 100%; opacity: 0.2; background: var(--text-muted);"></div>';
    roleTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 16px;">No token or cost usage recorded for this ticket yet.</td></tr>';
    return;
  }

  costEl.textContent = `$${metrics.totalCost.toFixed(4)}`;
  if (costSubEl) {
    costSubEl.textContent = `In: $${(metrics.promptCost || 0).toFixed(4)} | Out: $${(metrics.completionCost || 0).toFixed(4)}`;
  }

  tokensEl.textContent = metrics.totalTokens.toLocaleString();
  if (tokensSubEl) {
    tokensSubEl.textContent = `Prompt: ${(metrics.promptTokens || 0).toLocaleString()} | Compl: ${(metrics.completionTokens || 0).toLocaleString()}`;
  }

  if (cacheEl) {
    cacheEl.textContent = (metrics.cachedTokens || 0).toLocaleString();
  }
  if (cacheSubEl) {
    const savingsPercent = metrics.promptTokens ? Math.round(((metrics.cachedTokens || 0) / metrics.promptTokens) * 100) : 0;
    cacheSubEl.textContent = `${savingsPercent}% cached context`;
  }

  const roleList = metrics.roleBreakdown || [];
  if (runsEl) {
    runsEl.textContent = `${roleList.length}`;
  }
  if (runsSubEl) {
    const avgCost = roleList.length > 0 ? (metrics.totalCost / roleList.length).toFixed(4) : '0.0000';
    runsSubEl.textContent = `Avg: $${avgCost} / role`;
  }

  if (roleCountEl) {
    roleCountEl.textContent = `${roleList.length} ${roleList.length === 1 ? 'role' : 'roles'} contributing`;
  }

  // Render Visual Progress Bar
  if (progressBarEl) {
    if (roleList.length === 0) {
      progressBarEl.innerHTML = '';
    } else {
      progressBarEl.innerHTML = roleList.map(item => {
        const color = (typeof ROLE_COLORS !== 'undefined' && ROLE_COLORS[item.role]) ? ROLE_COLORS[item.role] : 'var(--accent-blue)';
        const pct = item.percentage || (metrics.totalCost > 0 ? (item.cost / metrics.totalCost) * 100 : 0);
        return `<div style="width: ${pct}%; background: ${color}; height: 100%; transition: width 0.3s ease;" title="${escapeHtml(item.role)}: $${item.cost.toFixed(4)} (${pct.toFixed(1)}%)"></div>`;
      }).join('');
    }
  }

  // Render Table
  roleTableBody.innerHTML = roleList.map(item => {
    const icon = (typeof ROLE_ICONS !== 'undefined' && ROLE_ICONS[item.role]) ? ROLE_ICONS[item.role] : '&#x1F916;';
    const color = (typeof ROLE_COLORS !== 'undefined' && ROLE_COLORS[item.role]) ? ROLE_COLORS[item.role] : 'var(--accent-blue)';
    const roleDisplayName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[item.role]) ? ROLE_NAMES[item.role] : item.role;
    const pct = item.percentage || (metrics.totalCost > 0 ? (item.cost / metrics.totalCost) * 100 : 0);
    return `
      <tr>
        <td style="font-weight: 600;">
          <span style="margin-right: 6px;">${icon}</span>
          <span style="color: ${color};" title="${escapeHtml(item.role)}">${escapeHtml(roleDisplayName)}</span>
        </td>
        <td>
          <span style="font-size: 11px; color: var(--text-primary); font-family: var(--font-sans); font-weight: 500;">${escapeHtml(typeof formatModelName === 'function' ? formatModelName(item.model || item.provider) : (item.model || item.provider || 'N/A'))}</span>
        </td>
        <td style="text-align: right; font-family: var(--font-mono);">${(item.promptTokens || 0).toLocaleString()}</td>
        <td style="text-align: right; font-family: var(--font-mono);">${(item.completionTokens || 0).toLocaleString()}</td>
        <td style="text-align: right; font-family: var(--font-mono); font-weight: 600; color: var(--accent-cyan);">${(item.totalTokens || 0).toLocaleString()}</td>
        <td style="text-align: right; font-family: var(--font-mono); font-weight: 600; color: var(--accent-green);">$${(item.cost || 0).toFixed(4)}</td>
        <td style="text-align: right;">
          <div style="display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; width: 100%;">
            <div style="width: 36px; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
              <div style="width: ${Math.min(100, Math.max(0, pct))}%; height: 100%; background: ${color};"></div>
            </div>
            <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); min-width: 38px; text-align: right;">${pct.toFixed(1)}%</span>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}


function openTicketCreateModal() {
  currentEditTicketId = null;
  attachedFileNames = [];

  const modalAddTicket = document.getElementById('modal-add-ticket');
  const formAddTicket = document.getElementById('form-add-ticket');
  const modalTitle = document.getElementById('modal-ticket-form-title');
  const editIdInput = document.getElementById('ticket-edit-id');
  const submitTicketBtn = document.getElementById('btn-submit-ticket');
  const viewDetailsBtn = document.getElementById('btn-ticket-form-view-details');
  const filePreviewEl = document.getElementById('ticket-attachments-preview');

  if (formAddTicket) formAddTicket.reset();
  if (editIdInput) editIdInput.value = '';
  if (modalTitle) modalTitle.textContent = 'Create Ticket';
  if (submitTicketBtn) {
    submitTicketBtn.textContent = 'Create Ticket';
    submitTicketBtn.disabled = true;
  }
  if (viewDetailsBtn) viewDetailsBtn.style.display = 'none';

  const roleSelect = document.getElementById('ticket-role');
  if (roleSelect) roleSelect.value = 'developer';

  const statusSelect = document.getElementById('ticket-status-input');
  if (statusSelect) statusSelect.value = 'backlog';

  const prioritySelect = document.getElementById('ticket-priority');
  if (prioritySelect) prioritySelect.value = 'Normal';

  renderAttachmentChips(filePreviewEl, attachedFileNames, true);

  if (modalAddTicket) modalAddTicket.classList.add('open');
}

function openTicketEditModal(ticketId) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (!ticket) return;

  currentEditTicketId = ticketId;
  attachedFileNames = [...(ticket.files || [])];

  const modalAddTicket = document.getElementById('modal-add-ticket');
  const modalTitle = document.getElementById('modal-ticket-form-title');
  const editIdInput = document.getElementById('ticket-edit-id');
  const submitTicketBtn = document.getElementById('btn-submit-ticket');
  const viewDetailsBtn = document.getElementById('btn-ticket-form-view-details');
  const filePreviewEl = document.getElementById('ticket-attachments-preview');

  const roleSelect = document.getElementById('ticket-role');
  const statusSelect = document.getElementById('ticket-status-input');
  const titleInput = document.getElementById('ticket-title-input');
  const descInput = document.getElementById('ticket-desc-input');
  const acInput = document.getElementById('ticket-ac-input');
  const prioritySelect = document.getElementById('ticket-priority');
  const jiraIssueInput = document.getElementById('ticket-jira-issue');
  const jiraParentsInput = document.getElementById('ticket-jira-parents');
  const confluenceInput = document.getElementById('ticket-confluence');
  const figmaInput = document.getElementById('ticket-figma');

  if (editIdInput) editIdInput.value = ticket.id;
  if (modalTitle) modalTitle.textContent = ticket.status === 'backlog' ? `Edit Backlog Ticket (${ticket.id})` : `Edit Ticket (${ticket.id})`;
  if (submitTicketBtn) {
    submitTicketBtn.textContent = 'Save Changes';
    submitTicketBtn.disabled = false;
  }
  if (viewDetailsBtn) viewDetailsBtn.style.display = 'inline-flex';

  if (roleSelect) roleSelect.value = ticket.role || 'developer';
  if (statusSelect) statusSelect.value = ticket.status || 'backlog';
  if (titleInput) titleInput.value = ticket.title || '';
  if (descInput) descInput.value = ticket.description || '';
  if (acInput) acInput.value = ticket.acceptanceCriteria || '';
  if (prioritySelect) prioritySelect.value = ticket.priority || 'Normal';
  if (jiraIssueInput) jiraIssueInput.value = ticket.jiraIssue || ticket.jira || '';
  if (jiraParentsInput) jiraParentsInput.value = ticket.jiraParents || '';
  if (confluenceInput) confluenceInput.value = ticket.confluence || '';
  if (figmaInput) figmaInput.value = ticket.figma || '';

  renderAttachmentChips(filePreviewEl, attachedFileNames, true);

  if (modalAddTicket) modalAddTicket.classList.add('open');
}

function initTicketDetailEvents() {
  // Sub-tabs switching in M1
  document.querySelectorAll('#modal-ticket-detail .sub-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.modal-body');
      if (!container) return;
      container.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.sub-tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetSubPane = document.getElementById(btn.dataset.subtab);
      if (targetSubPane) targetSubPane.classList.add('active');
    });
  });

  // Action: Return to Backlog
  const btnReturnBacklog = document.getElementById('m1-btn-return-backlog');
  if (btnReturnBacklog) {
    btnReturnBacklog.addEventListener('click', () => {
      if (!currentDetailTicketId) return;
      const ticket = state.tickets.find(t => t.id === currentDetailTicketId);
      if (!ticket) return;

      const oldStatus = ticket.status;
      ticket.status = 'backlog';
      if (!ticket.runLog) ticket.runLog = [];
      ticket.runLog.push(`${new Date().toLocaleTimeString()} - Returned to Backlog from [${oldStatus}] by Operator.`);

      const detailModal = document.getElementById('modal-ticket-detail');
      if (detailModal) detailModal.classList.remove('open');

      renderSidebarRoles();
      renderBoard();
      openTicketEditModal(ticket.id);
    });
  }

  // Action: Edit Ticket from Detail modal
  const btnEditTicket = document.getElementById('m1-btn-edit-ticket');
  if (btnEditTicket) {
    btnEditTicket.addEventListener('click', () => {
      if (!currentDetailTicketId) return;
      const detailModal = document.getElementById('modal-ticket-detail');
      if (detailModal) detailModal.classList.remove('open');
      openTicketEditModal(currentDetailTicketId);
    });
  }

  // Action: Pause / Resume
  const btnPause = document.getElementById('m1-btn-pause');
  if (btnPause) {
    btnPause.addEventListener('click', () => {
      if (!currentDetailTicketId) return;
      const ticket = state.tickets.find(t => t.id === currentDetailTicketId);
      if (!ticket) return;

      if (!ticket.runLog) ticket.runLog = [];
      if (ticket.status === 'in_progress') {
        ticket.status = 'paused';
        ticket.runLog.push(`${new Date().toLocaleTimeString()} - Task paused by Operator.`);
      } else if (ticket.status === 'paused') {
        ticket.status = 'in_progress';
        ticket.runLog.push(`${new Date().toLocaleTimeString()} - Task resumed by Operator.`);
      }

      renderSidebarRoles();
      renderBoard();
      openTicketDetailModal(ticket.id);
    });
  }

  // Action: Stop
  const btnStop = document.getElementById('m1-btn-stop');
  if (btnStop) {
    btnStop.addEventListener('click', () => {
      if (!currentDetailTicketId) return;
      const ticket = state.tickets.find(t => t.id === currentDetailTicketId);
      if (!ticket) return;

      if (!ticket.runLog) ticket.runLog = [];
      ticket.status = 'stopped';
      ticket.runLog.push(`${new Date().toLocaleTimeString()} - Task execution stopped by Operator.`);

      renderSidebarRoles();
      renderBoard();
      openTicketDetailModal(ticket.id);
    });
  }

  // Action: Cancel Task
  const btnCancel = document.getElementById('m1-btn-cancel');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (!currentDetailTicketId) return;
      const ticket = state.tickets.find(t => t.id === currentDetailTicketId);
      if (!ticket) return;

      if (!ticket.runLog) ticket.runLog = [];
      ticket.status = 'cancelled';
      ticket.runLog.push(`${new Date().toLocaleTimeString()} - Task cancelled by Operator.`);

      renderSidebarRoles();
      renderBoard();
      openTicketDetailModal(ticket.id);
    });
  }
}

function initTicketCreateEvents() {
  const fileInputEl = document.getElementById('ticket-attachments-input');
  const filePreviewEl = document.getElementById('ticket-attachments-preview');
  const browseBtn = document.getElementById('btn-browse-attachments');
  const openTicketBtn = document.getElementById('btn-open-new-ticket');
  const submitTicketBtn = document.getElementById('btn-submit-ticket');
  const formAddTicket = document.getElementById('form-add-ticket');
  const titleInput = document.getElementById('ticket-title-input');
  const viewDetailsBtn = document.getElementById('btn-ticket-form-view-details');

  if (browseBtn && fileInputEl) {
    browseBtn.addEventListener('click', () => fileInputEl.click());
    fileInputEl.addEventListener('change', () => {
      const newFiles = Array.from(fileInputEl.files).map(f => f.name);
      newFiles.forEach(name => {
        if (!attachedFileNames.includes(name)) {
          attachedFileNames.push(name);
        }
      });
      renderAttachmentChips(filePreviewEl, attachedFileNames, true);
    });
  }

  if (openTicketBtn) {
    openTicketBtn.addEventListener('click', () => {
      openTicketCreateModal();
    });
  }

  if (viewDetailsBtn) {
    viewDetailsBtn.addEventListener('click', () => {
      if (!currentEditTicketId) return;
      const modalAddTicket = document.getElementById('modal-add-ticket');
      if (modalAddTicket) modalAddTicket.classList.remove('open');
      openTicketDetailModal(currentEditTicketId);
    });
  }

  if (titleInput && submitTicketBtn) {
    titleInput.addEventListener('input', () => {
      submitTicketBtn.disabled = titleInput.value.trim() === '';
    });
  }

  if (formAddTicket) {
    formAddTicket.addEventListener('submit', (e) => {
      e.preventDefault();
      const editIdInput = document.getElementById('ticket-edit-id');
      const editId = editIdInput ? editIdInput.value.trim() : '';

      const statusSelect = document.getElementById('ticket-status-input');
      const roleSelect = document.getElementById('ticket-role');
      const prioritySelect = document.getElementById('ticket-priority');
      const descInput = document.getElementById('ticket-desc-input');
      const acInput = document.getElementById('ticket-ac-input');
      const jiraIssueInput = document.getElementById('ticket-jira-issue');
      const jiraParentsInput = document.getElementById('ticket-jira-parents');
      const confluenceInput = document.getElementById('ticket-confluence');
      const figmaInput = document.getElementById('ticket-figma');

      const statusVal = statusSelect ? statusSelect.value : 'backlog';
      const roleVal = roleSelect ? roleSelect.value : 'developer';
      const priorityVal = prioritySelect ? prioritySelect.value : 'Normal';
      const titleVal = titleInput ? titleInput.value.trim() : 'Untitled';
      const descVal = descInput ? descInput.value.trim() : '';
      const acVal = acInput ? acInput.value.trim() : '';
      const jiraVal = jiraIssueInput ? jiraIssueInput.value.trim() : '';
      const parentsVal = jiraParentsInput ? jiraParentsInput.value.trim() : '';
      const confVal = confluenceInput ? confluenceInput.value.trim() : '';
      const figmaVal = figmaInput ? figmaInput.value.trim() : '';

      if (editId) {
        // Updating existing ticket
        const ticket = state.tickets.find(t => t.id === editId);
        if (ticket) {
          const oldStatus = ticket.status;
          ticket.role = roleVal;
          ticket.status = statusVal;
          ticket.title = titleVal;
          ticket.description = descVal;
          ticket.acceptanceCriteria = acVal;
          ticket.priority = priorityVal;
          ticket.jiraIssue = jiraVal;
          ticket.jiraParents = parentsVal;
          ticket.confluence = confVal;
          ticket.figma = figmaVal;
          ticket.files = [...attachedFileNames];

          if (!ticket.runLog) ticket.runLog = [];
          if (oldStatus !== statusVal) {
            ticket.runLog.push(`${new Date().toLocaleTimeString()} - Status changed from [${oldStatus}] to [${statusVal}] by Operator.`);
          } else {
            ticket.runLog.push(`${new Date().toLocaleTimeString()} - Ticket specifications updated by Operator.`);
          }
        }
      } else {
        // Creating new ticket
        const newTicket = {
          id: `TICKET-${Math.floor(100 + Math.random() * 900)}`,
          title: titleVal,
          description: descVal,
          acceptanceCriteria: acVal,
          role: roleVal,
          priority: priorityVal,
          status: statusVal,
          jiraIssue: jiraVal,
          jiraParents: parentsVal,
          confluence: confVal,
          figma: figmaVal,
          files: [...attachedFileNames],
          created: new Date().toISOString().slice(0, 16).replace('T', ' '),
          attempts: [],
          runLog: [`Created via Orchestrator UI in status [${statusVal}].`],
          turns: []
        };
        state.tickets.unshift(newTicket);
      }

      const modalAddTicket = document.getElementById('modal-add-ticket');
      if (modalAddTicket) modalAddTicket.classList.remove('open');
      renderSidebarRoles();
      renderBoard();
    });
  }
}
