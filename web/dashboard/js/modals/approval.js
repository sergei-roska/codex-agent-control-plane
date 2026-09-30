// --- HUMAN APPROVAL & ESCALATION MODAL ---
let activeEscalationId = null;

function openApprovalModal(escId) {
  const esc = state.escalations.find(e => e.id === escId);
  if (!esc) return;
  activeEscalationId = escId;

  const modalTitle = document.getElementById('m3-modal-title');
  const catBadge = document.getElementById('m3-category-badge');
  const dynamicBody = document.getElementById('m3-dynamic-body');
  const dynamicFooter = document.getElementById('m3-dynamic-footer');
  const approvalModal = document.getElementById('modal-approval');

  const roleName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[esc.role]) ? ROLE_NAMES[esc.role] : esc.role;
  const config = (typeof ESCALATION_TYPE_CONFIG !== 'undefined' && ESCALATION_TYPE_CONFIG[esc.type])
    ? ESCALATION_TYPE_CONFIG[esc.type]
    : { label: "Human Escalation", badgeClass: "type-command", icon: "&#x26A0;&#xFE0F;", accent: "var(--accent-amber)" };

  if (modalTitle) {
    modalTitle.style.color = config.accent;
    modalTitle.textContent = getModalTitleForType(esc.type);
  }

  if (catBadge) {
    catBadge.className = `badge-esc-type ${config.badgeClass}`;
    catBadge.innerHTML = `${config.icon} ${config.label}`;
  }

  if (dynamicBody) {
    dynamicBody.innerHTML = renderEscalationModalBody(esc, roleName);
  }

  if (dynamicFooter) {
    dynamicFooter.innerHTML = renderEscalationModalFooter(esc);
  }

  attachEscalationModalEvents(esc);

  if (approvalModal) {
    approvalModal.classList.add('open');
  }
}

function getModalTitleForType(type) {
  switch (type) {
    case 'command_approval':
      return 'Human Authorization: Sensitive Command Execution';
    case 'decision_fork':
      return 'Architectural Fork: Select Implementation Strategy';
    case 'requirements_clarification':
      return 'Requirements Clarification: Socratic PM Intake';
    case 'credentials_request':
      return 'Security Authorization: Inject Missing Secret';
    case 'circuit_breaker':
      return 'Circuit Breaker Tripped: Failure Arbitration';
    case 'security_override':
      return 'Security Risk Governance: Vulnerability Exception';
    case 'scope_baseline_change':
      return 'Scope Governance: Baseline Expansion Approval';
    default:
      return 'Human Authorization Required';
  }
}

function renderEscalationModalBody(esc, roleName) {
  const metaHeader = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding-bottom:12px; border-bottom:var(--nm-border-bevel);">
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="badge badge-role" title="${esc.role}">${roleName}</span>
        <span style="font-family:var(--font-mono); font-size:12px; color:var(--text-secondary);">Ticket: <strong>${esc.ticketId}</strong></span>
      </div>
      <div style="font-size:11px; font-family:var(--font-mono); color:var(--text-muted);">
        ID: <strong>${esc.id}</strong> &middot; Urgency: <strong style="color:var(--accent-amber);">${esc.urgency || 'Normal'}</strong>
      </div>
    </div>
  `;

  switch (esc.type) {
    case 'command_approval':
      return `
        ${metaHeader}
        <div class="esc-info-banner">
          <strong style="font-size:13px; color:var(--heading-color);">${esc.reason}</strong>
          <span style="font-size:12px; color:var(--text-secondary); line-height:1.5;">${esc.description || 'Action executes with administrative privileges.'}</span>
        </div>

        <div class="form-group">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <label class="form-label" style="margin-bottom:0;">Command / Action Payload</label>
            <button class="btn btn-secondary" id="btn-copy-command" style="padding:4px 10px; font-size:11px;">Copy Command</button>
          </div>
          <pre id="m3-command-payload" style="background:#0d1117; border:1px solid rgba(255,255,255,0.1); padding:14px; border-radius:12px; font-family:var(--font-mono); font-size:12px; color:var(--accent-cyan); overflow-x:auto;">${esc.command}</pre>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
          <div class="form-group">
            <label class="form-label">Target Environment</label>
            <select class="form-select" id="m3-cmd-env">
              <option value="staging" ${esc.targetEnv === 'staging' ? 'selected' : ''}>staging (Isolated cluster)</option>
              <option value="pre-prod">pre-prod (Staging mirror)</option>
              <option value="production">production (Live traffic)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Execution Timeout</label>
            <select class="form-select" id="m3-cmd-timeout">
              <option value="30s">30 seconds</option>
              <option value="2m">2 minutes</option>
              <option value="5m" selected>5 minutes (Default)</option>
              <option value="15m">15 minutes</option>
            </select>
          </div>
        </div>

        <div style="background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:12px 14px; border-radius:12px; display:flex; flex-direction:column; gap:8px; font-size:12px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" id="m3-opt-dryrun" checked>
            <span>Run preflight verification dry-run before mutating database</span>
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" id="m3-opt-snapshot" checked>
            <span>Create automated point-in-time database snapshot prior to execution</span>
          </label>
        </div>
      `;

    case 'decision_fork':
      return `
        ${metaHeader}
        <div class="esc-info-banner">
          <strong style="font-size:13px; color:var(--heading-color);">${esc.reason}</strong>
          <span style="font-size:12px; color:var(--text-secondary); line-height:1.5;">${esc.description}</span>
        </div>

        <div class="form-group">
          <label class="form-label">Select Target Architecture Option</label>
          <div class="esc-option-group" id="m3-fork-options">
            ${esc.options.map(opt => `
              <div class="esc-option-card ${opt.selected ? 'selected' : ''}" data-opt-id="${opt.id}">
                <div class="esc-radio-dot"><div class="esc-radio-dot-inner"></div></div>
                <div class="esc-option-content">
                  <div class="esc-option-title">${opt.title}</div>
                  <div class="esc-option-desc">${opt.desc}</div>
                  <div class="esc-tag-list">
                    ${opt.tags.map(t => `<span class="esc-tag ${t === 'Recommended' ? 'recommended' : ''}">${t}</span>`).join('')}
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Operator Guidance / Architecture Constraints (Optional)</label>
          <textarea class="form-input" id="m3-decision-notes" rows="2" placeholder="e.g. Ensure client reconnect timeout is set to 5000ms with jitter..."></textarea>
        </div>

        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:var(--text-secondary);">
          <input type="checkbox" id="m3-record-adr" checked>
          <span>Automatically record locked decision to <code>.agents/decisions.log</code> as ADR</span>
        </label>
      `;

    case 'requirements_clarification':
      return `
        ${metaHeader}
        <div class="esc-info-banner">
          <strong style="font-size:13px; color:var(--heading-color);">${esc.reason}</strong>
          <span style="font-size:12px; color:var(--text-secondary); line-height:1.5;">${esc.description}</span>
        </div>

        <div style="display:flex; flex-direction:column; gap:14px;">
          ${esc.questions.map((q, idx) => {
            if (q.type === 'select') {
              return `
                <div class="form-group">
                  <label class="form-label">Q${idx + 1}: ${q.title}</label>
                  <select class="form-select" id="m3-q-${q.id}">
                    ${q.options.map(o => `<option value="${o}">${o}</option>`).join('')}
                  </select>
                </div>
              `;
            } else if (q.type === 'radio') {
              return `
                <div class="form-group">
                  <label class="form-label">Q${idx + 1}: ${q.title}</label>
                  <div style="display:flex; flex-direction:column; gap:8px;">
                    ${q.options.map((o, oIdx) => `
                      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px; background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:8px 12px; border-radius:10px;">
                        <input type="radio" name="m3-radio-${q.id}" value="${o}" ${oIdx === 0 ? 'checked' : ''}>
                        <span>${o}</span>
                      </label>
                    `).join('')}
                  </div>
                </div>
              `;
            } else if (q.type === 'checkbox') {
              return `
                <div style="background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:10px 14px; border-radius:10px; font-size:12px;">
                  <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="m3-chk-${q.id}" ${q.checked ? 'checked' : ''}>
                    <span><strong>Q${idx + 1}:</strong> ${q.label}</span>
                  </label>
                </div>
              `;
            }
            return '';
          }).join('')}
        </div>

        <div class="form-group">
          <label class="form-label">Additional Business Logic Notes (Optional)</label>
          <textarea class="form-input" id="m3-pm-clarifications" rows="2" placeholder="Provide extra clarifications, edge cases, or acceptance criteria updates..."></textarea>
        </div>
      `;

    case 'credentials_request':
      return `
        ${metaHeader}
        <div class="esc-info-banner">
          <strong style="font-size:13px; color:var(--heading-color);">${esc.reason}</strong>
          <span style="font-size:12px; color:var(--text-secondary); line-height:1.5;">${esc.description}</span>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; font-size:12px;">
          <div style="background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:10px 12px; border-radius:10px;">
            <div style="color:var(--text-muted); font-size:11px; margin-bottom:2px;">TARGET SERVICE</div>
            <strong>${esc.service}</strong>
          </div>
          <div style="background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:10px 12px; border-radius:10px;">
            <div style="color:var(--text-muted); font-size:11px; margin-bottom:2px;">REQUIRED SCOPE</div>
            <code style="color:var(--accent-cyan);">${esc.scope}</code>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Secret Key: <code>${esc.secretKey}</code></label>
          <div class="esc-secret-wrapper">
            <input type="password" class="form-input" id="m3-secret-value" placeholder="Paste secret token (e.g. whsec_...)" autocomplete="off">
            <button type="button" class="esc-toggle-pwd-btn" id="btn-toggle-secret-visibility" title="Show / Hide Password">&#128065;</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Secret Lifetime &amp; Storage Scope</label>
          <div style="display:flex; flex-direction:column; gap:8px; font-size:12px;">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:8px 12px; border-radius:10px;">
              <input type="radio" name="m3-secret-scope" value="session" checked>
              <span><strong>In-Memory Session Only</strong> (Wipe immediately upon task completion)</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:8px 12px; border-radius:10px;">
              <input type="radio" name="m3-secret-scope" value="env">
              <span><strong>Persist to Local .env</strong> (Project sandbox only, never committed to git)</span>
            </label>
          </div>
        </div>

        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:var(--text-secondary);">
          <input type="checkbox" id="m3-mask-logs" checked>
          <span>Mask token values in all agent output logs and turn replays</span>
        </label>
      `;

    case 'circuit_breaker':
      return `
        ${metaHeader}
        <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="color:var(--accent-red); font-size:16px;">&#x26A0;&#xFE0F;</span>
            <strong style="color:var(--accent-red); font-size:13px;">${esc.reason}</strong>
          </div>
          <span style="font-size:12px; color:var(--text-secondary);">${esc.description}</span>
        </div>

        <div class="form-group">
          <label class="form-label">Subprocess Failure Output (STDERR / Traceback)</label>
          <div class="esc-terminal-box">${esc.traceback}</div>
        </div>

        <div class="form-group">
          <label class="form-label">Select Circuit Breaker Resolution Strategy</label>
          <div class="esc-option-group" id="m3-cb-strategies">
            ${esc.strategies.map(strat => `
              <div class="esc-option-card ${strat.selected ? 'selected' : ''}" data-strat-id="${strat.id}">
                <div class="esc-radio-dot"><div class="esc-radio-dot-inner"></div></div>
                <div class="esc-option-content">
                  <div class="esc-option-title">${strat.title}</div>
                  <div class="esc-option-desc">${strat.desc}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Operator Correction Prompt for Next Agent Turn (Optional)</label>
          <textarea class="form-input" id="m3-cb-prompt" rows="2" placeholder="e.g. Set mock IdP response delay to 50ms and mock successful OAuth exchange..."></textarea>
        </div>
      `;

    case 'security_override':
      return `
        ${metaHeader}
        <div class="esc-info-banner">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <strong style="font-size:13px; color:var(--heading-color);">${esc.reason}</strong>
            <span class="badge" style="background:rgba(225,29,72,0.2); color:var(--accent-crimson); font-weight:700;">${esc.severity}</span>
          </div>
          <div style="font-size:12px; color:var(--text-muted); font-family:var(--font-mono);">Affected: ${esc.package}</div>
        </div>

        <div class="form-group">
          <label class="form-label">Security Team Risk Assessment</label>
          <div style="background:var(--nm-surface); box-shadow:var(--nm-shadow-in-sm); border:var(--nm-border-inset); padding:12px 14px; border-radius:12px; font-size:12px; color:var(--text-secondary); line-height:1.5;">
            ${esc.assessment}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Exception Duration &amp; Whitelist Scope</label>
          <select class="form-select" id="m3-sec-duration">
            ${esc.durations.map(d => `<option value="${d}">${d}</option>`).join('')}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Compliance Audit Justification Note (Required for Whitelist)</label>
          <input type="text" class="form-input" id="m3-sec-justification" placeholder="e.g. Build-time tool in isolated runner. Mitigated by air-gapped CI." value="Isolated build sandbox verified. Zero production exposure.">
        </div>

        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:var(--text-secondary);">
          <input type="checkbox" id="m3-sec-ack" checked>
          <span>Acknowledge risk and create formal security exception entry</span>
        </label>
      `;

    case 'scope_baseline_change':
      return `
        ${metaHeader}
        <div class="esc-info-banner">
          <strong style="font-size:13px; color:var(--heading-color);">${esc.reason}</strong>
          <span style="font-size:12px; color:var(--text-secondary); line-height:1.5;">${esc.description}</span>
        </div>

        <div class="esc-comparison-grid">
          <div class="esc-comparison-card">
            <span class="esc-comparison-label">Original Baseline</span>
            <span class="esc-comparison-value">${esc.baseline.originalPoints}</span>
            <span style="font-size:11px; color:var(--text-muted);">${esc.baseline.originalDays} schedule estimate</span>
          </div>
          <div class="esc-comparison-card highlight">
            <span class="esc-comparison-label" style="color:var(--accent-amber);">Revised Estimate</span>
            <span class="esc-comparison-value" style="color:var(--accent-amber);">${esc.baseline.revisedPoints}</span>
            <span style="font-size:11px; color:var(--text-muted);">${esc.baseline.revisedDays} schedule (+3 days)</span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Select Scope Governance Decision</label>
          <div class="esc-option-group" id="m3-scope-options">
            ${esc.options.map(opt => `
              <div class="esc-option-card ${opt.selected ? 'selected' : ''}" data-scope-id="${opt.id}">
                <div class="esc-radio-dot"><div class="esc-radio-dot-inner"></div></div>
                <div class="esc-option-content">
                  <div class="esc-option-title">${opt.title}</div>
                  <div class="esc-option-desc">${opt.desc}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Stakeholder Note / Sprint Adjustment Notes (Optional)</label>
          <textarea class="form-input" id="m3-scope-notes" rows="2" placeholder="e.g. Approved with product lead. Adjusted Sprint 11 milestone date to Sep 1st..."></textarea>
        </div>
      `;

    default:
      return `
        ${metaHeader}
        <div class="esc-info-banner">
          <strong>${esc.reason}</strong>
        </div>
      `;
  }
}

function renderEscalationModalFooter(esc) {
  switch (esc.type) {
    case 'command_approval':
      return `
        <button class="btn btn-danger" id="btn-escalation-deny">Deny Execution</button>
        <button class="btn btn-success" id="btn-escalation-confirm">&#10003; Approve &amp; Execute</button>
      `;
    case 'decision_fork':
      return `
        <button class="btn btn-secondary" id="btn-escalation-deny">Request More Research</button>
        <button class="btn btn-success" id="btn-escalation-confirm">&#128274; Lock Decision &amp; Proceed</button>
      `;
    case 'requirements_clarification':
      return `
        <button class="btn btn-danger" id="btn-escalation-deny">Reject to Backlog</button>
        <button class="btn btn-success" id="btn-escalation-confirm">&#10003; Submit Answers &amp; Resume PM</button>
      `;
    case 'credentials_request':
      return `
        <button class="btn btn-secondary" id="btn-escalation-deny">Skip &amp; Use Mock Stub</button>
        <button class="btn btn-success" id="btn-escalation-confirm">&#128273; Inject Secret &amp; Proceed</button>
      `;
    case 'circuit_breaker':
      return `
        <button class="btn btn-danger" id="btn-escalation-deny">Abort Pipeline (Blocked)</button>
        <button class="btn btn-success" id="btn-escalation-confirm">&#x26A1; Apply Resolution</button>
      `;
    case 'security_override':
      return `
        <button class="btn btn-danger" id="btn-escalation-deny">Reject Exception (Require Patch)</button>
        <button class="btn btn-success" id="btn-escalation-confirm">&#128737; Authorize Whitelist Exception</button>
      `;
    case 'scope_baseline_change':
      return `
        <button class="btn btn-danger" id="btn-escalation-deny">Reject Scope Expansion</button>
        <button class="btn btn-success" id="btn-escalation-confirm">&#10003; Confirm Scope Governance</button>
      `;
    default:
      return `
        <button class="btn btn-danger" id="btn-escalation-deny">Deny</button>
        <button class="btn btn-success" id="btn-escalation-confirm">Approve</button>
      `;
  }
}

function attachEscalationModalEvents(esc) {
  // Option Cards selection for decision forks, circuit breakers, scope changes
  document.querySelectorAll('.esc-option-card').forEach(card => {
    card.addEventListener('click', () => {
      const container = card.parentElement;
      if (container) {
        container.querySelectorAll('.esc-option-card').forEach(c => c.classList.remove('selected'));
      }
      card.classList.add('selected');
    });
  });

  // Copy command button
  const copyBtn = document.getElementById('btn-copy-command');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const payloadEl = document.getElementById('m3-command-payload');
      if (payloadEl && navigator.clipboard) {
        navigator.clipboard.writeText(payloadEl.textContent);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
      }
    });
  }

  // Toggle secret visibility
  const togglePwdBtn = document.getElementById('btn-toggle-secret-visibility');
  if (togglePwdBtn) {
    togglePwdBtn.addEventListener('click', () => {
      const secretInput = document.getElementById('m3-secret-value');
      if (secretInput) {
        if (secretInput.type === 'password') {
          secretInput.type = 'text';
          togglePwdBtn.innerHTML = '&#128584;';
        } else {
          secretInput.type = 'password';
          togglePwdBtn.innerHTML = '&#128065;';
        }
      }
    });
  }

  // Confirm Button Action
  const confirmBtn = document.getElementById('btn-escalation-confirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      handleEscalationResolution(esc, true);
    });
  }

  // Deny Button Action
  const denyBtn = document.getElementById('btn-escalation-deny');
  if (denyBtn) {
    denyBtn.addEventListener('click', () => {
      handleEscalationResolution(esc, false);
    });
  }
}

function handleEscalationResolution(esc, isApproved) {
  const approvalModal = document.getElementById('modal-approval');
  const ticket = state.tickets.find(t => t.id === esc.ticketId);
  const timeStr = new Date().toLocaleTimeString();

  if (isApproved) {
    let resolutionDetail = 'Authorized by Human Operator.';

    if (esc.type === 'command_approval') {
      const env = document.getElementById('m3-cmd-env')?.value || esc.targetEnv || 'staging';
      resolutionDetail = `Command authorized for [${env}]: ${esc.command}`;
      if (ticket) ticket.status = 'in_progress';
    } else if (esc.type === 'decision_fork') {
      const selectedCard = document.querySelector('#m3-fork-options .esc-option-card.selected');
      const selectedId = selectedCard?.dataset.optId;
      const chosenOpt = esc.options.find(o => o.id === selectedId) || esc.options[0];
      const notes = document.getElementById('m3-decision-notes')?.value;
      resolutionDetail = `Architectural decision locked: [${chosenOpt.title}]. ${notes ? 'Note: ' + notes : ''}`;

      const shouldRecord = document.getElementById('m3-record-adr')?.checked;
      if (shouldRecord) {
        const nextAdrNum = String(state.decisions.length + 1).padStart(3, '0');
        state.decisions.push({
          id: `ADR-${nextAdrNum}`,
          title: chosenOpt.title,
          role: esc.role,
          date: new Date().toISOString().split('T')[0],
          summary: `${chosenOpt.desc} Selected by Operator to lock baseline.`
        });
      }
      if (ticket) ticket.status = 'in_progress';
    } else if (esc.type === 'requirements_clarification') {
      const notes = document.getElementById('m3-pm-clarifications')?.value;
      resolutionDetail = `Requirements clarified by Operator. Intake approved. ${notes ? 'Notes: ' + notes : ''}`;
      if (ticket) ticket.status = 'in_progress';
    } else if (esc.type === 'credentials_request') {
      const scopeRadio = document.querySelector('input[name="m3-secret-scope"]:checked')?.value || 'session';
      resolutionDetail = `Secret injected for [${esc.secretKey}] (Scope: ${scopeRadio}).`;
      if (ticket) ticket.status = 'in_progress';
    } else if (esc.type === 'circuit_breaker') {
      const selectedStrat = document.querySelector('#m3-cb-strategies .esc-option-card.selected');
      const stratId = selectedStrat?.dataset.stratId;
      const chosen = esc.strategies.find(s => s.id === stratId) || esc.strategies[0];
      const prompt = document.getElementById('m3-cb-prompt')?.value;
      resolutionDetail = `Circuit breaker arbitrated: [${chosen.title}]. ${prompt ? 'Guidance: ' + prompt : ''}`;
      if (stratId === 'strat-abort') {
        if (ticket) ticket.status = 'blocked';
      } else {
        if (ticket) ticket.status = 'in_progress';
      }
    } else if (esc.type === 'security_override') {
      const duration = document.getElementById('m3-sec-duration')?.value || '30 days';
      const justification = document.getElementById('m3-sec-justification')?.value || 'Approved exception';
      resolutionDetail = `Security exception authorized for ${esc.cveId} (${duration}). Justification: ${justification}`;
      if (ticket) ticket.status = 'in_progress';
    } else if (esc.type === 'scope_baseline_change') {
      const selectedScope = document.querySelector('#m3-scope-options .esc-option-card.selected');
      const scopeId = selectedScope?.dataset.scopeId;
      const chosen = esc.options.find(o => o.id === scopeId) || esc.options[0];
      const notes = document.getElementById('m3-scope-notes')?.value;
      resolutionDetail = `Scope baseline decision: [${chosen.title}]. ${notes ? 'Notes: ' + notes : ''}`;
      if (ticket) ticket.status = 'in_progress';
    }

    if (ticket) {
      if (!ticket.runLog) ticket.runLog = [];
      ticket.runLog.push(`${timeStr} - ${resolutionDetail}`);
    }
  } else {
    // Denied / Rejected
    if (ticket) {
      ticket.status = 'blocked';
      if (!ticket.runLog) ticket.runLog = [];
      ticket.runLog.push(`${timeStr} - Human Operator denied/rejected escalation (${esc.id}). Ticket marked as blocked.`);
    }
  }

  // Remove the resolved escalation from pending list
  state.escalations = state.escalations.filter(e => e.id !== esc.id);

  if (approvalModal) {
    approvalModal.classList.remove('open');
  }

  renderDecisionsAndEscalations();
  renderSidebarRoles();
  renderBoard();
  if (typeof renderLogs === 'function') renderLogs();
}

function initApprovalEvents() {
  // Global backdrop click or modal close events
  const approvalModal = document.getElementById('modal-approval');
  if (approvalModal) {
    approvalModal.querySelectorAll('[data-close="modal-approval"]').forEach(btn => {
      btn.addEventListener('click', () => {
        approvalModal.classList.remove('open');
      });
    });
  }
}
