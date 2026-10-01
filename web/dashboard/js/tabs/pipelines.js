// --- PIPELINES TAB (READ-ONLY: GET /pipelines and GET /presets) ---
const PIPELINE_ACTIVE_STATUSES = ['queued', 'running', 'paused', 'interrupted'];
const PIPELINE_STAGE_STATUSES = ['pending', 'eligible', 'running', 'succeeded', 'failed'];

const pipelinesData = { loaded: false, error: null, runs: [], presets: [], unavailable: [] };
let pipelinesSignature = null;
let pipelinesTabHooked = false;

function pipelinesTabVisible() {
  return state.activeTab === 'tab-pipelines';
}

// Called from the board poll tick; fetches only while the tab is visible.
async function refreshPipelinesIfVisible(signal) {
  if (!pipelinesTabVisible()) return;
  try {
    const [pipelines, presets] = await Promise.all([
      apiGet('/pipelines', { signal }),
      apiGet('/presets', { signal })
    ]);
    pipelinesData.runs = Array.isArray(pipelines.runs) ? pipelines.runs : [];
    pipelinesData.presets = Array.isArray(presets.presets) ? presets.presets : [];
    pipelinesData.unavailable = Array.isArray(presets.unavailable) ? presets.unavailable : [];
    pipelinesData.error = null;
    pipelinesData.loaded = true;
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    pipelinesData.error = err && err.message ? err.message : 'Request failed';
  }
  renderPipelines();
}

function pipelineRoleName(stage) {
  return roleDisplayNameFor(stage.publicRoleId || stage.roleId);
}

function pipelineStageNode(stage) {
  const status = PIPELINE_STAGE_STATUSES.includes(stage.status) ? stage.status : 'pending';
  const attempts = Array.isArray(stage.attempts) ? stage.attempts : [];
  const repairs = attempts.filter(a => a.repair).length;
  const meta = h('div', { class: 'pipeline-step-meta' }, [
    h('span', { class: 'badge badge-status ' + status, text: status }),
    h('span', {
      class: 'badge' + (stage.required ? ' badge-required' : ''),
      text: stage.required ? 'required' : 'optional',
      title: stage.required ? 'Required by the plan' : 'Optional stage'
    }),
    h('span', {
      class: 'badge', text: attempts.length + (attempts.length === 1 ? ' attempt' : ' attempts'),
      title: 'Journal attempts recorded for this stage'
    })
  ]);
  if (repairs > 0) {
    meta.appendChild(h('span', {
      class: 'badge badge-repair', text: repairs + (repairs === 1 ? ' repair' : ' repairs'),
      title: 'Attempts run by a repair executor'
    }));
  }
  return h('div', {
    class: 'pipeline-step ' + status,
    title: stage.stageId + ' (' + stage.roleId + ')'
  }, [
    h('div', { class: 'pipeline-step-body' }, [
      h('span', { class: 'pipeline-step-stage', text: stage.stageId }),
      h('span', { class: 'pipeline-step-role', text: pipelineRoleName(stage) }),
      meta
    ])
  ]);
}

function pipelineRunNode(run) {
  const stages = Array.isArray(run.stages) ? run.stages : [];
  const chain = h('div', { class: 'pipeline-chain' });
  if (stages.length === 0) {
    chain.appendChild(h('div', { class: 'pipeline-empty', text: 'No plan saved yet (phase: ' + runPhaseLabel(run.phase) + ')' }));
  }
  stages.forEach((stage, idx) => {
    chain.appendChild(pipelineStageNode(stage));
    if (idx < stages.length - 1) chain.appendChild(h('span', { class: 'chain-arrow', text: '>' }));
  });
  const preset = run.presetId
    ? run.presetId + (run.presetVersion ? ' v' + run.presetVersion : '')
    : 'no preset';
  const header = h('div', { class: 'pipeline-card-header' }, [
    h('div', { class: 'pipeline-card-title' }, [
      h('span', { class: 'pipeline-title', text: run.title || '(untitled)' }),
      h('span', { class: 'badge badge-status ' + cssToken(run.status), text: run.status }),
      h('span', { class: 'badge', text: 'Phase: ' + runPhaseLabel(run.phase), title: run.phase }),
      h('span', { class: 'badge', text: preset, title: 'Preset used by this run' }),
      run.rolePack ? h('span', { class: 'badge', text: run.rolePack, title: 'Role pack' }) : null
    ]),
    h('button', {
      class: 'btn btn-secondary', text: 'Open ticket', attrs: { type: 'button' },
      on: { click: () => openTicketRecord(run.ticketId) }
    })
  ]);
  return h('div', { class: 'pipeline-card', attrs: { 'data-run': run.runId } }, [header, chain]);
}

function pipelineGroup(label, runs) {
  if (!runs.length) return null;
  return h('div', { class: 'pipeline-group' }, [
    h('div', { class: 'pipeline-group-label', text: label + ' (' + runs.length + ')' }),
    ...runs.map(pipelineRunNode)
  ]);
}

function presetNode(preset) {
  const stages = Array.isArray(preset.stages) ? preset.stages : [];
  const names = ids => (ids || []).map(id => roleDisplayNameFor(id));
  const list = h('ol', { class: 'preset-stages' }, stages.map(stage => h('li', {}, [
    h('span', { class: 'preset-stage-key', text: stage.key }),
    h('span', { class: 'preset-stage-roles', text: names(stage.roles).join(' or ') }),
    stage.dependsOn && stage.dependsOn.length
      ? h('span', { class: 'preset-stage-deps', text: 'after ' + stage.dependsOn.join(', ') })
      : h('span', { class: 'preset-stage-deps', text: 'no dependencies' }),
    stage.purpose ? h('span', { class: 'preset-stage-purpose', text: stage.purpose }) : null
  ])));
  const optional = preset.optionalRoles && preset.optionalRoles.length
    ? h('div', { class: 'preset-optional' }, [
      h('span', { class: 'preset-label', text: 'Optional roles' }),
      ...names(preset.optionalRoles).map(name => h('span', { class: 'badge badge-role', text: name }))
    ])
    : h('div', { class: 'preset-optional' }, [h('span', { class: 'preset-label', text: 'No optional roles' })]);
  return h('div', { class: 'preset-card' }, [
    h('div', { class: 'pipeline-card-title' }, [
      h('span', { class: 'pipeline-title', text: preset.presetId }),
      h('span', { class: 'badge', text: 'v' + preset.version }),
      h('span', { class: 'badge', text: preset.classification, title: 'Ticket classification' }),
      h('span', { class: 'badge', text: 'min checks: ' + preset.minChecks })
    ]),
    preset.description ? h('div', { class: 'preset-description', text: preset.description }) : null,
    list,
    optional
  ]);
}

function unavailablePresetNode(entry) {
  return h('div', { class: 'preset-card unavailable' }, [
    h('div', { class: 'pipeline-card-title' }, [
      h('span', { class: 'pipeline-title', text: entry.presetId }),
      h('span', { class: 'badge', text: 'unavailable' })
    ]),
    h('div', { class: 'preset-description', text: entry.reason || 'Not available' })
  ]);
}

function renderPipelines() {
  const container = document.getElementById('pipelines-container');
  const presetsBox = document.getElementById('presets-container');
  if (!container || !presetsBox) return;

  if (!pipelinesTabHooked) {
    pipelinesTabHooked = true;
    const tabBtn = document.querySelector('.tab-btn[data-tab="tab-pipelines"]');
    if (tabBtn) tabBtn.addEventListener('click', () => { Poller.trigger(); });
  }

  const signature = JSON.stringify([pipelinesData, boardData.roles.map(r => r.runtimeId + '|' + r.displayName)]);
  if (signature === pipelinesSignature) return;
  pipelinesSignature = signature;

  container.textContent = '';
  presetsBox.textContent = '';
  if (pipelinesData.error) {
    container.appendChild(h('div', { class: 'empty-state', text: 'Could not load pipelines: ' + pipelinesData.error }));
  }
  if (!pipelinesData.loaded) {
    if (!pipelinesData.error) {
      container.appendChild(h('div', { class: 'empty-state', text: 'Loading pipelines...' }));
      presetsBox.appendChild(h('div', { class: 'empty-state', text: 'Loading presets...' }));
    }
    return;
  }

  const active = pipelinesData.runs.filter(run => PIPELINE_ACTIVE_STATUSES.includes(run.status));
  const settled = pipelinesData.runs.filter(run => !PIPELINE_ACTIVE_STATUSES.includes(run.status));
  if (!pipelinesData.runs.length) {
    container.appendChild(h('div', { class: 'empty-state', text: 'No runs yet. Submit a ticket to see its stage progress here.' }));
  }
  [pipelineGroup('Active', active), pipelineGroup('Recent', settled)].forEach(node => { if (node) container.appendChild(node); });

  if (!pipelinesData.presets.length && !pipelinesData.unavailable.length) {
    presetsBox.appendChild(h('div', { class: 'empty-state', text: 'No presets are defined for the active role pack.' }));
  }
  pipelinesData.presets.forEach(preset => presetsBox.appendChild(presetNode(preset)));
  pipelinesData.unavailable.forEach(entry => presetsBox.appendChild(unavailablePresetNode(entry)));
}
