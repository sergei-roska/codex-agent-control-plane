// --- DECISIONS & ESCALATIONS TAB ---

const ESCALATION_TYPE_CONFIG = {
  command_approval: {
    label: "Destructive Action",
    badgeClass: "type-command",
    icon: "&#x2699;&#xFE0F;",
    accent: "var(--accent-amber)"
  },
  decision_fork: {
    label: "Architecture Fork",
    badgeClass: "type-decision",
    icon: "&#x1F3DB;&#xFE0F;",
    accent: "var(--accent-purple)"
  },
  requirements_clarification: {
    label: "Requirements Clarifier",
    badgeClass: "type-requirements",
    icon: "&#x1F4CB;",
    accent: "var(--accent-blue)"
  },
  credentials_request: {
    label: "Missing Secret",
    badgeClass: "type-credentials",
    icon: "&#x1F511;",
    accent: "var(--accent-cyan)"
  },
  circuit_breaker: {
    label: "Circuit Breaker",
    badgeClass: "type-circuit",
    icon: "&#x26A0;&#xFE0F;",
    accent: "var(--accent-red)"
  },
  security_override: {
    label: "Security Exception",
    badgeClass: "type-security",
    icon: "&#x1F6E1;&#xFE0F;",
    accent: "var(--accent-crimson)"
  },
  scope_baseline_change: {
    label: "Scope Governance",
    badgeClass: "type-scope",
    icon: "&#x1F4C8;",
    accent: "var(--accent-green)"
  }
};

function renderDecisionsAndEscalations() {
  const adrList = document.getElementById('adr-list');
  const adrCount = document.getElementById('adr-count');
  if (adrList) {
    adrList.innerHTML = state.decisions.map(d => {
      const roleName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[d.role]) ? ROLE_NAMES[d.role] : d.role;
      return `
        <div class="adr-card">
          <div style="display:flex; justify-content:space-between; align-items:center; gap: 8px;">
            <span style="font-weight:700; font-size:13px; color:var(--heading-color);">${d.id}: ${d.title}</span>
            <span class="badge badge-role" title="${d.role}">${roleName}</span>
          </div>
          <p style="font-size:12px; color:var(--text-secondary); line-height:1.5;">${d.summary}</p>
          <div style="font-size:11px; color:var(--text-muted); display:flex; justify-content:space-between;">
            <span>Locked ADR &middot; Permanent</span>
            <span>${d.date}</span>
          </div>
        </div>
      `;
    }).join('');
  }
  if (adrCount) {
    adrCount.textContent = `${state.decisions.length} Decisions`;
  }

  const escList = document.getElementById('escalation-list');
  const escCount = document.getElementById('escalation-count');
  if (escList && escCount) {
    if (state.escalations.length === 0) {
      escList.innerHTML = `<div class="empty-state">No pending human escalations. All agent pipelines running autonomously.</div>`;
      escCount.textContent = `0 Actions Required`;
      escCount.className = 'badge badge-status done';
    } else {
      escList.innerHTML = state.escalations.map(e => {
        const roleName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[e.role]) ? ROLE_NAMES[e.role] : e.role;
        const config = ESCALATION_TYPE_CONFIG[e.type] || {
          label: "Human Escalation",
          badgeClass: "type-command",
          icon: "&#x26A0;&#xFE0F;",
          accent: "var(--accent-amber)"
        };

        let previewHtml = '';
        if (e.command) {
          previewHtml = `<div class="esc-card-preview" title="${e.command}">$ ${e.command}</div>`;
        } else if (e.type === 'decision_fork' && e.options) {
          previewHtml = `<div class="esc-card-preview" style="color:var(--accent-purple);">$ ${e.options.length} options evaluated &middot; Choice required</div>`;
        } else if (e.type === 'credentials_request' && e.secretKey) {
          previewHtml = `<div class="esc-card-preview" style="color:var(--accent-cyan);">$ Secret required: ${e.secretKey}</div>`;
        } else if (e.type === 'circuit_breaker') {
          previewHtml = `<div class="esc-card-preview" style="color:var(--accent-red);">$ 2/2 retries failed &middot; Pipeline paused</div>`;
        } else if (e.type === 'security_override' && e.cveId) {
          previewHtml = `<div class="esc-card-preview" style="color:var(--accent-crimson);">$ ${e.cveId} (${e.severity})</div>`;
        } else if (e.type === 'scope_baseline_change' && e.baseline) {
          previewHtml = `<div class="esc-card-preview" style="color:var(--accent-green);">$ Baseline: ${e.baseline.originalPoints} &rarr; ${e.baseline.revisedPoints}</div>`;
        } else if (e.description) {
          previewHtml = `<div class="esc-card-desc">${e.description}</div>`;
        }

        const urgencyColor = e.urgency === 'Critical' ? 'var(--accent-red)' : e.urgency === 'High' ? 'var(--accent-amber)' : 'var(--text-muted)';

        return `
          <div class="escalation-card" data-id="${e.id}" data-type="${e.type || 'command_approval'}">
            <div class="esc-card-header">
              <div class="esc-card-meta">
                <span style="font-weight:700; font-size:13px; font-family:var(--font-mono); color:${config.accent};">${e.id}</span>
                <span class="badge-esc-type ${config.badgeClass}">${config.icon} ${config.label}</span>
              </div>
              <span class="badge badge-role" title="${e.role}">${roleName}</span>
            </div>

            <div class="esc-card-title">${e.reason}</div>
            ${previewHtml}

            <div class="esc-card-footer">
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-family:var(--font-mono); color:var(--text-secondary);">Ticket: ${e.ticketId}</span>
                ${e.urgency ? `&middot; <span style="color:${urgencyColor}; font-weight:600;">${e.urgency} Urgency</span>` : ''}
              </div>
              <span class="esc-action-btn-hint">Review &amp; Decide &rarr;</span>
            </div>
          </div>
        `;
      }).join('');

      escCount.textContent = `${state.escalations.length} Action${state.escalations.length > 1 ? 's' : ''} Required`;
      escCount.className = 'badge badge-status waiting_human';

      escList.querySelectorAll('.escalation-card').forEach(card => {
        card.addEventListener('click', () => {
          openApprovalModal(card.dataset.id);
        });
      });
    }
  }
}
