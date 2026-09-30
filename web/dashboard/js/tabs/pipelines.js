// --- PIPELINES TAB ---
function renderPipelines() {
  const container = document.getElementById('pipelines-container');
  if (!container) return;

  container.innerHTML = state.pipelines.map(pipe => {
    const stepsHtml = pipe.steps.map((step, idx) => {
      const isLast = idx === pipe.steps.length - 1;
      const roleDisplayName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[step.role]) ? ROLE_NAMES[step.role] : step.role;
      const icon = (typeof ROLE_ICONS !== 'undefined' && ROLE_ICONS[step.role]) ? ROLE_ICONS[step.role] : '';
      return `
        <div class="pipeline-step ${step.status}" title="Role: ${roleDisplayName} (${step.role})">
          <span style="font-family:var(--font-sans); font-weight:600; font-size:12px; display:inline-flex; align-items:center; gap:4px;">
            <span>${icon}</span>
            <span>${roleDisplayName}</span>
          </span>
          <span class="badge badge-status ${step.status}" style="font-size:10px;">${step.status}</span>
        </div>
        ${!isLast ? '<span class="chain-arrow">&gt;</span>' : ''}
      `;
    }).join('');

    return `
      <div class="pipeline-card">
        <div class="pipeline-card-header">
          <span style="font-weight: 700; font-size: 14px;">${pipe.name}</span>
          <span class="badge badge-status" style="font-family:var(--font-mono);">${pipe.id}</span>
        </div>
        <div class="pipeline-chain">
          ${stepsHtml}
        </div>
      </div>
    `;
  }).join('');
}
