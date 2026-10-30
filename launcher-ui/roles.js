(function () {
  'use strict';
  const query = new URLSearchParams(location.search);
  let projects = [];
  let team = null;
  let teamRequestId = 0;
  let engineRequestId = 0;
  let selectionRevision = 0;
  let displayedRevision = 0;
  let capabilities = { available: false, models: [] };
  const select = document.getElementById('projectSelect');
  const error = document.getElementById('error');
  const engineSelect = document.getElementById('deliveryEngineSelect');
  const engineSave = document.getElementById('deliveryEngineSave');
  const engineNote = document.getElementById('deliveryEngineNote');

  async function get(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }
  function fill(selectEl, options, selected) {
    selectEl.textContent = '';
    options.forEach(function (item) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      selectEl.appendChild(option);
    });
    selectEl.value = selected;
  }
  function modelRecord(id) { return capabilities.models.find(function (model) { return model.id === id; }) || null; }
  function advertisedFastTier(model) {
    if (!model || !Array.isArray(model.serviceTiers)) return null;
    const matches = model.serviceTiers.filter((tier) => typeof tier.id === 'string' && tier.id.trim().toLowerCase() === 'fast');
    return matches.length === 1 ? matches[0] : null;
  }
  function roleEffortOptions(model, modelId, defaultModelId, effectiveEffort, overrideEffort, modelChanged = false) {
    const values = model ? model.supportedReasoningEfforts.slice() : ['low', 'medium', 'high', 'xhigh'];
    const inherited = effectiveEffort;
    if (inherited && !values.includes(inherited)) values.push(inherited);
    const defaultEffort = model && model.defaultReasoningEffort;
    if (defaultEffort && !values.includes(defaultEffort)) values.push(defaultEffort);
    let selected = overrideEffort || '';
    if (modelChanged && !overrideEffort && modelId !== defaultModelId && defaultEffort) selected = defaultEffort;
    const options = values.slice();
    if (selected && !options.includes(selected)) options.push(selected);
    return {
      values: options,
      inherited,
      selected,
      inheritedUnknown: Boolean(inherited && model && !model.supportedReasoningEfforts.includes(inherited)),
      savedUnknown: Boolean(selected && (!model || !model.supportedReasoningEfforts.includes(selected))),
    };
  }
  function isRenderedProjectCurrent(projectId, revision) {
    return select.value === projectId && selectionRevision === revision && displayedRevision === revision;
  }
  function roleOverrideUrl(projectId, roleName, revision) {
    if (!isRenderedProjectCurrent(projectId, revision)) return null;
    return '/api/projects/' + encodeURIComponent(projectId) + '/roles/' + encodeURIComponent(roleName) + '/override';
  }
  async function sendRoleMutation(projectId, roleName, revision, method, body, button) {
    const url = roleOverrideUrl(projectId, roleName, revision);
    if (!url) return false;
    button.disabled = true;
    try {
      const request = { method };
      if (body !== undefined) {
        request.headers = { 'Content-Type': 'application/json' };
        request.body = JSON.stringify(body);
      }
      const response = await fetch(url, request);
      const result = await response.json();
      if (!isRenderedProjectCurrent(projectId, revision)) return false;
      if (!response.ok) throw new Error(result.error || ('HTTP ' + response.status));
      await loadTeam(projectId, revision);
      return true;
    } catch (err) {
      if (isRenderedProjectCurrent(projectId, revision)) error.textContent = err.message;
      return false;
    } finally {
      if (isRenderedProjectCurrent(projectId, revision)) button.disabled = !team || team.running;
    }
  }
  function renderRole(role, isLead, projectId, revision) {
    const card = document.createElement('section');
    card.className = 'card role-setting-card';
    const title = document.createElement('h2'); title.textContent = role.displayName || role.name; card.appendChild(title);
    const roleId = document.createElement('div'); roleId.className = 'role-id'; roleId.textContent = role.name + (isLead ? ' - lead' : ''); card.appendChild(roleId);
    const editable = !team.running;
    const override = role.override || {};
    const defaults = role.defaults || role;
    function field(labelText, control) {
      const label = document.createElement('label'); label.className = 'role-setting-field'; label.textContent = labelText; label.appendChild(control); card.appendChild(label);
    }
    const model = document.createElement('select');
    const modelOptions = Array.from(new Set([...(capabilities.models || []).map((m) => m.id), role.model, defaults.model].filter(Boolean))).sort().map((id) => ({ value: id, label: id + (modelRecord(id) ? '' : ' (capability unknown)') }));
    fill(model, [{ value: '', label: 'Inherited (' + defaults.model + ')' }, ...modelOptions], override.model || '');
    field('Model', model);
    const effort = document.createElement('select');
    function updateEffort(modelChanged = false) {
      const configured = model.value || defaults.model;
      const metadata = modelRecord(configured);
      const settings = roleEffortOptions(metadata, configured, defaults.model, role.effort || defaults.effort, override.effort, modelChanged);
      const inheritedLabel = settings.inheritedUnknown ? 'Inherited (' + settings.inherited + '; not advertised)' : 'Inherited (' + settings.inherited + ')';
      fill(effort, [{ value: '', label: inheritedLabel }, ...settings.values.map((value) => ({ value, label: value }))], settings.selected);
      if (settings.savedUnknown) {
        const option = Array.from(effort.options).find((item) => item.value === settings.selected);
        if (option) option.textContent = settings.selected + (metadata ? ' (saved; not advertised)' : ' (saved; capability unknown)');
      }
    }
    model.addEventListener('change', function () { updateEffort(true); }); updateEffort(); field('Reasoning effort', effort);
    const capacity = document.createElement('input'); capacity.type = 'number'; capacity.min = '1'; capacity.max = '12'; capacity.step = '1'; capacity.value = override.maxConcurrentAgents || defaults.maxConcurrentAgents || 1;
    field('Number of agents', capacity);
    const fast = document.createElement('select');
    const fastHelp = document.createElement('div'); fastHelp.className = 'roles-fast-unavailable';
    function updateFast() {
      const selectedModel = model.value || defaults.model;
      const metadata = modelRecord(selectedModel);
      const fastTier = advertisedFastTier(metadata);
      const current = (override.model || defaults.model) === selectedModel ? override.fastMode || '' : '';
      fill(fast, [{ value: '', label: 'Inherited (Fast off)' }, { value: 'off', label: 'Fast off' }, { value: 'on', label: 'Fast on' }], current);
      fast.querySelector('option[value="on"]').disabled = !fastTier;
      fastHelp.textContent = fastTier ? '' : metadata && metadata.serviceTiersKnown !== false
        ? 'Fast tier is not advertised for this model.'
        : 'Fast tier availability is unknown.';
    }
    updateFast(); model.addEventListener('change', updateFast);
    field('Speed', fast); card.appendChild(fastHelp);
    const rules = document.createElement('textarea'); rules.maxLength = 4000; rules.value = override.extraRules || ''; const rulesField = document.createElement('label'); rulesField.className = 'role-setting-field is-wide'; rulesField.textContent = 'Extra rules'; rulesField.appendChild(rules); card.appendChild(rulesField);
    const actions = document.createElement('div'); actions.className = 'role-setting-actions';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-primary btn-sm'; save.textContent = 'Save'; save.disabled = !editable;
    save.addEventListener('click', async function () {
      if (!isRenderedProjectCurrent(projectId, revision)) return;
      error.textContent = '';
      const count = Number(capacity.value);
      if (!Number.isSafeInteger(count) || count < 1 || count > 12) { error.textContent = 'Agent capacity must be an integer from 1 to 12.'; return; }
      const selectedModel = model.value || null;
      const selectedEffort = effort.value || null;
      await sendRoleMutation(projectId, role.name, revision, 'PUT', { model: selectedModel, effort: selectedEffort, maxConcurrentAgents: count, fastMode: fast.value || null, extraRules: rules.value.trim() || null }, save);
    });
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn btn-secondary btn-sm'; reset.textContent = 'Reset'; reset.disabled = !editable;
    reset.addEventListener('click', async function () {
      if (!isRenderedProjectCurrent(projectId, revision)) return;
      await sendRoleMutation(projectId, role.name, revision, 'DELETE', undefined, reset);
    });
    actions.append(save, reset); card.appendChild(actions);
    if (!editable) { const note = document.createElement('p'); note.className = 'roles-note'; note.textContent = 'Stop the project server before saving role settings.'; card.appendChild(note); }
    return card;
  }
  async function loadTeam(id = select.value, revision = selectionRevision) {
    if (!id) return;
    const requestId = ++teamRequestId;
    const [data] = await Promise.all([
      get('/api/projects/' + encodeURIComponent(id) + '/team'),
      document.getElementById('deliveryEngineSelect') ? loadDeliveryEngine(id, revision) : Promise.resolve(),
    ]);
    if (select.value !== id || revision !== selectionRevision || requestId !== teamRequestId) return false;
    displayedRevision = revision;
    team = data;
    document.getElementById('pageNote').textContent = team.running ? 'Project is running. Settings are read at startup and are currently locked.' : 'Changes apply the next time the project server starts.';
    const list = document.getElementById('roleList'); list.textContent = '';
    list.appendChild(renderRole(team.lead, true, id, revision)); team.roles.forEach((role) => list.appendChild(renderRole(role, false, id, revision)));
    document.getElementById('backLink').href = '/?project=' + encodeURIComponent(id);
    return true;
  }
  async function loadDeliveryEngine(id, revision) {
    if (!engineSelect || !engineSave || !engineNote) return;
    const requestId = ++engineRequestId;
    if (document.getElementById('deliveryEngineSelect')) {
      document.getElementById('deliveryEngineSelect').disabled = true;
      document.getElementById('deliveryEngineSave').disabled = true;
    }
    engineNote.textContent = 'Loading delivery engine...';
    try {
      const data = await get('/api/projects/' + encodeURIComponent(id) + '/delivery-engine');
      if (!isRenderedProjectCurrent(id, revision) || requestId !== engineRequestId) return;
      engineSelect.value = data.deliveryEngine;
      engineSelect.disabled = data.stopped !== true;
      engineSave.disabled = data.stopped !== true;
      engineNote.textContent = data.stopped !== true
        ? 'Project server is not stopped. Stop it before changing the engine; changes apply to new runs after restart.'
        : 'Changes apply to new runs after the project server starts. Existing runs keep their engine.';
    } catch (err) {
      if (!isRenderedProjectCurrent(id, revision) || requestId !== engineRequestId) return;
      engineNote.textContent = err.message + '. The setting was not changed.';
      engineSelect.disabled = true; engineSave.disabled = true;
    }
  }
  async function saveDeliveryEngine() {
    const id = select.value; const revision = selectionRevision;
    if (!isRenderedProjectCurrent(id, revision)) return;
    engineSave.disabled = true; engineNote.textContent = 'Saving delivery engine...';
    try {
      const response = await fetch('/api/projects/' + encodeURIComponent(id) + '/delivery-engine', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryEngine: engineSelect.value }),
      });
      const data = await response.json();
      if (!isRenderedProjectCurrent(id, revision)) return;
      if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
      engineSelect.value = data.deliveryEngine;
      engineNote.textContent = 'Saved. The change applies to new runs after the project server starts.';
      await loadDeliveryEngine(id, revision);
    } catch (err) {
      if (!isRenderedProjectCurrent(id, revision)) return;
      engineNote.textContent = err.message + '. Your selection is kept; the setting was not changed.';
      engineSave.disabled = false;
    }
  }
  async function selectProject(projectId) {
    select.value = projectId;
    const revision = ++selectionRevision;
    displayedRevision = revision;
    document.getElementById('roleList').textContent = '';
    if (document.getElementById('deliveryEngineSelect')) {
      document.getElementById('deliveryEngineSelect').disabled = true;
      document.getElementById('deliveryEngineSave').disabled = true;
    }
    document.getElementById('pageNote').textContent = 'Loading project roles...';
    error.textContent = '';
    if (projectId) query.set('project', projectId);
    else query.delete('project');
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query : ''));
    try { await loadTeam(projectId, revision); }
    catch (err) { if (isRenderedProjectCurrent(projectId, revision)) error.textContent = err.message; }
  }
  async function init() {
    try {
      const data = await get('/api/projects'); projects = data.projects || [];
      select.textContent = '';
      projects.forEach(function (project) { const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; select.appendChild(option); });
      const chosen = projects.some((project) => project.id === query.get('project')) ? query.get('project') : (projects[0] && projects[0].id);
      if (chosen) select.value = chosen;
      capabilities = await get('/api/models/capabilities').catch(() => ({ available: false, models: [] }));
      document.getElementById('capabilityNote').textContent = capabilities.available ? 'Model capabilities loaded from the configured Codex account.' : 'Model capability discovery is unavailable; custom choices remain visible and unsupported options are marked unknown.';
      select.addEventListener('change', function () { selectProject(select.value); });
      engineSave.addEventListener('click', saveDeliveryEngine);
      await loadTeam();
    } catch (err) { error.textContent = err.message; }
  }
  init();
}());
