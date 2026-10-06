// --- CONNECTIONS & MODELS TAB (M5): real OpenAI account, model catalog and per-role defaults ---
// All strings from the server are rendered with textContent (h() helper).

const cm = {
  loaded: false,
  loading: false,
  accountLoaded: false,
  catalogLoaded: false,
  rolesLoaded: false,
  account: null,
  accountError: null,
  accountBusy: false,
  catalog: null,
  catalogError: null,
  roles: null,
  rolesError: null,
  drafts: {},
  busy: {},
  notes: {},
  cmds: {},
  history: {}
};

const ac = {
  loaded: false, loading: false, health: null, healthError: null,
  resources: [], resourcesLoaded: false, resourcesLoading: false, resourcesError: null,
  resourcesSeq: 0, busy: null, message: '', messageError: false, commands: {}, issueDraft: '', siteDraft: null
};

const CM_SETUP_TEXT = {
  requires_auth: 'Not signed in. Run `codex login` in a terminal, sign in with ChatGPT, restart the orchestrator, then press Refresh.',
  unsupported_account: 'This account type is not supported in beta. Run `codex login` and sign in with ChatGPT, restart the orchestrator, then press Refresh.',
  unavailable: 'The Codex App Server did not answer. Check that Codex is installed and running, then press Refresh.'
};

function cmClear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function cmCommandId() {
  const rnd = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  return 'set-' + rnd;
}

// The same payload keeps the same commandId so a retry after a network error replays instead of duplicating.
function cmCommandFor(roleId, kind, payload) {
  const sig = JSON.stringify([kind, payload]);
  const held = cm.cmds[roleId];
  if (held && held.sig === sig) return held.id;
  cm.cmds[roleId] = { sig, id: cmCommandId() };
  return cm.cmds[roleId].id;
}

function cmCatalogState() {
  if (cm.catalogError) return { state: 'unavailable', message: cm.catalogError };
  if (!cm.catalog) return { state: 'loading', message: '' };
  const st = cm.catalog.catalog || {};
  return { state: st.state === 'ok' ? 'ok' : 'unavailable', message: st.error && st.error.message ? st.error.message : 'The model catalog could not be read.' };
}

function cmModels() { return cm.catalog && Array.isArray(cm.catalog.models) ? cm.catalog.models : []; }
function cmFindModel(id) { return cmModels().find(m => m.model === id) || null; }

// A null tier is not sent to the App Server; the model's own default (if advertised) applies.
function cmTierLabel(tier, model) {
  if (tier) return String(tier);
  const entry = model ? cmFindModel(model) : null;
  return entry && entry.defaultServiceTier ? 'Default (not sent; model default ' + entry.defaultServiceTier + ')' : 'Default (not sent)';
}

function cmErrorText(err) {
  if (!err) return 'Request failed';
  const parts = [err.message || 'Request failed'];
  if (Array.isArray(err.details)) err.details.forEach(d => { if (d && d.message) parts.push((d.field ? d.field + ': ' : '') + d.message); });
  return parts.join(' - ');
}

const CM_REQUEST_TIMEOUT_MS = 15000;

// Bounded GET: aborts and rejects after the timeout even if the transport never settles.
function cmBoundedGet(path) {
  let timer = null;
  let controller = null;
  try { controller = typeof AbortController === 'function' ? new AbortController() : null; } catch (_) { controller = null; }
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) { try { controller.abort(); } catch (_) { /* already settled */ } }
      reject(new Error('Request timed out after ' + (CM_REQUEST_TIMEOUT_MS / 1000) + ' s'));
    }, CM_REQUEST_TIMEOUT_MS);
  });
  const request = controller ? apiGet(path, { signal: controller.signal }) : apiGet(path);
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

async function loadConnections() {
  if (cm.loading) return;
  cm.loading = true;
  // Each request fills its own section and re-renders when it settles; none waits for the others.
  const section = (path, apply) => cmBoundedGet(path).then(
    v => apply(v, null),
    e => apply(null, cmErrorText(e))
  ).then(() => { renderConnections(); });
  const done = Promise.all([
    section('/account', (v, e) => { cm.account = v; cm.accountError = e; cm.accountLoaded = true; }),
    section('/models', (v, e) => { cm.catalog = v; cm.catalogError = e; cm.catalogLoaded = true; }),
    section('/settings/roles', (v, e) => { cm.roles = v; cm.rolesError = e; cm.rolesLoaded = true; })
  ]);
  try { await done; } finally {
    cm.loading = false;
    cm.loaded = true;
  }
  loadAtlassian();
}

function acCommandId() {
  return 'm6-' + ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
}

function acCommandFor(slot, payload) {
  const sig = JSON.stringify(payload);
  if (!ac.commands[slot] || ac.commands[slot].sig !== sig) ac.commands[slot] = { sig, id: acCommandId() };
  return ac.commands[slot].id;
}

function acError(err) {
  if (err && err.status === 0) return 'The orchestrator could not be reached. Retry the same action to safely replay it.';
  const messages = {
    not_configured: 'The operator has not configured Atlassian access on the orchestrator.',
    reconnect_required: 'Reconnect Atlassian from this dashboard before loading or importing source data.',
    source_unavailable: 'The selected Atlassian site is unavailable. Retry after checking the connection.',
    stale_version: 'This ticket changed. Reload its current version before repeating the action.'
  };
  if (err && messages[err.code]) return messages[err.code];
  return 'The request could not be completed. Check the orchestrator status and retry.';
}

async function loadAtlassian() {
  if (ac.loading) return;
  ac.loading = true;
  try {
    ac.health = await apiGet('/integrations/atlassian');
    ac.healthError = null;
    ac.loaded = true;
  } catch (err) {
    ac.healthError = acError(err);
    ac.loaded = true;
  } finally {
    ac.loading = false;
    renderAtlassian();
  }
}

async function loadAtlassianResources() {
  if (ac.resourcesLoading || !(ac.health && ac.health.connected)) return;
  const seq = ++ac.resourcesSeq;
  ac.resourcesLoading = true;
  ac.resourcesError = null;
  renderAtlassian();
  try {
    const result = await apiGet('/integrations/atlassian/resources');
    if (seq !== ac.resourcesSeq || !(ac.health && ac.health.connected)) return;
    ac.resources = Array.isArray(result && result.resources) ? result.resources : [];
    ac.resourcesLoaded = true;
  } catch (err) {
    if (seq !== ac.resourcesSeq) return;
    ac.resourcesError = acError(err);
  }
  if (seq !== ac.resourcesSeq) return;
  ac.resourcesLoading = false;
  renderAtlassian();
}

function acStatusBadge(text, kind) {
  return h('span', { class: 'status-badge ' + kind, text });
}

function acButton(label, action, disabled, primary) {
  const btn = h('button', { class: 'btn ' + (primary ? 'btn-primary' : 'btn-secondary'), text: label, attrs: { type: 'button' } });
  btn.disabled = Boolean(disabled);
  btn.addEventListener('click', action);
  return btn;
}

function acJiraSites() {
  const sites = ac.health && Array.isArray(ac.health.selectedSites) ? ac.health.selectedSites : [];
  return sites.filter(site => site && site.sourceKind === 'jira' && typeof site.originId === 'string');
}

function acAvailableSites(resources, selectedSites) {
  const available = Array.isArray(resources) ? resources.slice() : [];
  (Array.isArray(selectedSites) ? selectedSites : []).forEach(site => {
    const id = site && typeof site.cloudId === 'string' ? site.cloudId : '';
    if (id && !available.some(resource => resource && resource.id === id)) {
      available.unshift({ id, name: site.name, url: site.url, saved: true });
    }
  });
  return available;
}

function acPreferredSiteId(availableSites, draft, selectedSites) {
  if (draft && availableSites.some(site => site.id === draft)) return draft;
  const saved = (Array.isArray(selectedSites) ? selectedSites : []).find(site => site && typeof site.cloudId === 'string' && site.cloudId);
  return saved ? saved.cloudId : '';
}

function acCallbackTarget() {
  const configured = ac.health && ac.health.callbackOrigin;
  if (typeof configured !== 'string') return null;
  try {
    const url = new URL(configured);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !loopback) || url.username || url.password) return null;
    return new URL(location.pathname, url.origin).href;
  } catch (_) { return null; }
}

function acCallbackOriginMismatch() {
  const target = acCallbackTarget();
  if (!target) return false;
  try { return new URL(target).origin !== location.origin; } catch (_) { return false; }
}

function renderAtlassian() {
  const badge = document.getElementById('atlassian-status');
  const desc = document.getElementById('atlassian-description');
  const actions = document.getElementById('atlassian-actions');
  const state = document.getElementById('atlassian-resources-state');
  const siteRow = document.getElementById('atlassian-site-row');
  const siteSelect = document.getElementById('atlassian-site-select');
  const selectBtn = document.getElementById('btn-atlassian-select-site');
  const importPanel = document.getElementById('atlassian-import-panel');
  const issueInput = document.getElementById('atlassian-issue-key');
  const importBtn = document.getElementById('btn-atlassian-import');
  const importSite = document.getElementById('atlassian-import-site');
  const message = document.getElementById('atlassian-message');
  if (!badge || !desc || !actions || !state) return;
  actions.textContent = '';
  if (message) { message.textContent = ac.message; message.className = 'atlassian-message' + (ac.messageError ? ' is-error' : ''); }
  if (!ac.loaded && ac.loading) {
    badge.className = 'status-badge warning'; badge.textContent = 'Checking...';
    desc.textContent = 'Checking Atlassian configuration...'; state.textContent = '';
    if (siteRow) siteRow.hidden = true;
    if (importPanel) importPanel.hidden = true;
    return;
  }
  if (ac.healthError || !ac.health) {
    badge.className = 'status-badge warning'; badge.textContent = 'Unavailable';
    desc.textContent = ac.healthError || 'Atlassian status is unavailable.';
    actions.appendChild(acButton('Retry', loadAtlassian, Boolean(ac.loading)));
    state.textContent = '';
    if (siteRow) siteRow.hidden = true;
    if (importPanel) importPanel.hidden = true;
    return;
  }
  if (!ac.health.configured) {
    badge.className = 'status-badge warning'; badge.textContent = 'Not configured';
    desc.textContent = 'An operator must configure the Atlassian OAuth app and encrypted token storage on the orchestrator before connecting. No credentials are entered in this browser.';
    state.textContent = 'Jira and Confluence access is read-only. Imported work is tracked inside this dashboard.';
    if (siteRow) siteRow.hidden = true;
    if (importPanel) importPanel.hidden = true;
    return;
  }
  if (!ac.health.connected) {
    const needsReconnect = ac.health.state === 'reconnect_required';
    badge.className = 'status-badge disconnected'; badge.textContent = needsReconnect ? 'Reconnect required' : 'Disconnected';
    const originMismatch = acCallbackOriginMismatch();
    desc.textContent = originMismatch
      ? 'Open this dashboard at the orchestrator callback origin before connecting. Browser sessions do not cross between localhost and 127.0.0.1.'
      : needsReconnect ? 'Atlassian rejected the saved credentials. Reconnect to resume Jira and Confluence reads.'
      : 'Connect an Atlassian account to retrieve Jira and Confluence context. The orchestrator requests read-only access.';
    state.textContent = 'OAuth tokens remain on the orchestrator; this page never receives them.';
    if (originMismatch) {
      const target = acCallbackTarget();
      actions.appendChild(acButton('Open dashboard at configured origin', () => { if (target) window.location.assign(target); }, Boolean(ac.busy)));
    } else actions.appendChild(acButton(ac.busy === 'begin' ? 'Connecting...' : (needsReconnect ? 'Reconnect Atlassian' : 'Connect Atlassian'), beginAtlassianAuthorization, Boolean(ac.busy)));
    if (siteRow) siteRow.hidden = true;
    if (importPanel) importPanel.hidden = true;
    return;
  }
  badge.className = 'status-badge connected'; badge.textContent = 'Connected (read-only)';
  desc.textContent = 'Atlassian is connected. External Jira issues and Confluence pages are read-only; ticket lifecycle and execution stay internal.';
  actions.appendChild(acButton('Load available sites', loadAtlassianResources, Boolean(ac.busy || ac.resourcesLoading)));
  actions.appendChild(acButton(ac.busy === 'disconnect' ? 'Disconnecting...' : 'Disconnect', disconnectAtlassian, Boolean(ac.busy)));
  if (ac.resourcesError) {
    state.textContent = 'Sites unavailable: ' + ac.resourcesError;
    actions.appendChild(acButton('Retry sites', loadAtlassianResources, Boolean(ac.busy || ac.resourcesLoading)));
  } else if (ac.resourcesLoading) state.textContent = 'Loading available sites...';
  else if (ac.resourcesLoaded && !ac.resources.length) state.textContent = 'No accessible Atlassian sites were returned.';
  else if (!ac.resourcesLoaded && ac.health.selectedSites && ac.health.selectedSites.length) state.textContent = 'A saved Atlassian site is selected. Load available sites to add or change the selection.';
  else if (!ac.resourcesLoaded) state.textContent = 'Load available sites, then select a site to enable source access and Jira issue imports.';
  else state.textContent = ac.resources.length + ' accessible site(s). Choose a Jira site explicitly before importing.';

  if (siteRow && siteSelect) {
    const selectedSites = Array.isArray(ac.health.selectedSites) ? ac.health.selectedSites : [];
    const availableSites = acAvailableSites(ac.resourcesLoaded ? ac.resources : [], selectedSites);
    siteRow.hidden = !availableSites.length;
    siteSelect.textContent = '';
    availableSites.forEach(resource => {
      const label = (resource.name || 'Atlassian site') + (resource.url ? ' (' + resource.url + ')' : '') + (resource.saved ? ' (saved)' : '');
      const option = h('option', { text: label, attrs: { value: resource.id } });
      siteSelect.appendChild(option);
    });
    const desiredSite = acPreferredSiteId(availableSites, ac.siteDraft, selectedSites);
    if (desiredSite && availableSites.some(site => site.id === desiredSite)) siteSelect.value = desiredSite;
    else if (availableSites.length) siteSelect.value = availableSites[0].id;
    siteSelect.onchange = () => { ac.siteDraft = siteSelect.value; };
    if (selectBtn) {
      selectBtn.disabled = Boolean(ac.busy || !availableSites.length);
      selectBtn.textContent = ac.busy === 'site' ? 'Selecting...' : 'Select site';
      selectBtn.onclick = selectAtlassianSite;
    }
  }
  const jiraSites = acJiraSites();
  if (importPanel) importPanel.hidden = !jiraSites.length;
  if (issueInput) {
    if (issueInput.value !== ac.issueDraft) issueInput.value = ac.issueDraft;
    issueInput.disabled = Boolean(ac.busy === 'import');
    issueInput.oninput = () => {
      ac.issueDraft = issueInput.value;
      if (importBtn) importBtn.disabled = Boolean(ac.busy || !acJiraSites().length || !/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8})$/.test(ac.issueDraft.trim()));
    };
  }
  if (importBtn) {
    importBtn.disabled = Boolean(ac.busy || !jiraSites.length || !/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8})$/.test(ac.issueDraft.trim()));
    importBtn.textContent = ac.busy === 'import' ? 'Importing...' : 'Import Jira issue';
    importBtn.onclick = importAtlassianIssue;
  }
  if (importSite) importSite.textContent = jiraSites.length === 1 ? 'Selected Jira site: ' + (jiraSites[0].name || jiraSites[0].url || jiraSites[0].originId) : jiraSites.length + ' Jira sites selected. The first selected site is used for imports.';
}

function setAtlassianCallbackError(message) {
  ac.message = message || 'Atlassian authorization did not complete.';
  ac.messageError = true;
  renderAtlassian();
}

function acAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'auth.atlassian.com' && !url.username && !url.password ? url.href : null;
  } catch (_) { return null; }
}

async function beginAtlassianAuthorization() {
  if (ac.busy) return;
  if (acCallbackOriginMismatch()) {
    ac.message = 'Open the dashboard at its configured callback origin before connecting.'; ac.messageError = true; renderAtlassian(); return;
  }
  if (typeof window.clearPendingAtlassianOAuth === 'function') window.clearPendingAtlassianOAuth();
  ac.busy = 'begin'; ac.message = ''; ac.messageError = false; renderAtlassian();
  try {
    const result = await apiPost('/integrations/atlassian/begin', {});
    const url = acAuthorizationUrl(result && result.authorizationUrl);
    if (!url) throw new Error('invalid authorization URL');
    window.location.assign(url);
  } catch (_) {
    ac.busy = null; ac.message = 'Could not start Atlassian authorization. Check the orchestrator configuration.'; ac.messageError = true; renderAtlassian();
  }
}

async function completeAtlassianCallback(handle) {
  if (!handle || ac.busy) return false;
  ac.busy = 'complete'; ac.message = ''; ac.messageError = false; renderAtlassian();
  try {
    await apiPost('/integrations/atlassian/complete', { handle });
    ac.resourcesSeq += 1;
    ac.resourcesLoading = false;
    ac.resourcesLoaded = false; ac.resources = [];
    ac.siteDraft = null;
    ac.message = 'Atlassian authorization completed. Load sites and select a Jira site.'; ac.messageError = false;
    try { ac.health = await apiGet('/integrations/atlassian'); ac.healthError = null; }
    catch (_) { ac.health = null; ac.healthError = 'Atlassian authorization completed, but connection status could not be read.'; }
    return true;
  } catch (err) {
    ac.message = err && err.status === 401 ? 'Pair this browser with the orchestrator, then retry the Atlassian callback.' : 'Atlassian authorization could not be completed. Start again from Connections.';
    ac.messageError = true;
    return false;
  } finally {
    ac.busy = null; renderAtlassian();
  }
}

async function selectAtlassianSite() {
  const select = document.getElementById('atlassian-site-select');
  if (!select || !select.value || ac.busy) return;
  const cloudId = select.value;
  ac.busy = 'site'; ac.message = ''; ac.messageError = false; renderAtlassian();
  try {
    const result = await apiRequest('PUT', '/integrations/atlassian/site', { body: { cloudId } });
    ac.health.selectedSites = Array.isArray(result && result.sites) ? result.sites : [];
    ac.siteDraft = cloudId;
    ac.message = 'Selected Atlassian site for read-only imports.';
  } catch (err) { ac.message = acError(err); ac.messageError = true; }
  ac.busy = null; renderAtlassian();
}

async function disconnectAtlassian() {
  if (ac.busy) return;
  ac.busy = 'disconnect'; ac.message = ''; ac.messageError = false; renderAtlassian();
  try {
    await apiPost('/integrations/atlassian/disconnect', {});
    ac.resourcesSeq += 1;
    ac.resourcesLoading = false;
    ac.health.connected = false; ac.health.selectedSites = []; ac.resources = []; ac.resourcesLoaded = false;
    ac.siteDraft = null;
    ac.message = 'Atlassian disconnected.';
  } catch (err) { ac.message = acError(err); ac.messageError = true; }
  ac.busy = null; renderAtlassian();
}

async function importAtlassianIssue() {
  const site = acJiraSites()[0];
  const input = document.getElementById('atlassian-issue-key');
  const issueIdOrKey = input ? input.value.trim() : '';
  if (!site || !/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8})$/.test(issueIdOrKey) || ac.busy) return;
  const payload = { originId: site.originId, issueIdOrKey };
  const body = Object.assign({ commandId: acCommandFor('import', payload) }, payload);
  ac.busy = 'import'; ac.message = ''; ac.messageError = false; renderAtlassian();
  try {
    const result = await apiPost('/integrations/atlassian/import', body);
    delete ac.commands.import;
    const ticket = result && result.ticket;
    const ticketId = ticket && (ticket.ticketId || ticket.id);
    if (!ticketId) throw new Error('missing ticket');
    ac.message = result.duplicate ? 'This Jira issue is already linked to an internal ticket. Opened the existing ticket.' : (result.replayed ? 'The previous import was replayed. Opened the internal ticket.' : 'Jira issue imported as an internal ticket.');
    ac.messageError = false;
    if (typeof openTicketRecord === 'function') openTicketRecord(ticketId);
    if (typeof Poller !== 'undefined') Poller.trigger();
  } catch (err) { ac.message = err && err.status === 0 ? acError(err) : 'Jira import failed. Check the selected site and issue key, then retry.'; ac.messageError = true; }
  ac.busy = null; renderAtlassian();
}

async function reloadRoles() {
  try { cm.roles = await apiGet('/settings/roles'); cm.rolesError = null; } catch (err) { cm.rolesError = cmErrorText(err); }
}

async function refreshAccount() {
  cm.accountBusy = true;
  renderConnections();
  try { cm.account = await apiPost('/account/refresh', {}); cm.accountError = null; } catch (err) { cm.accountError = cmErrorText(err); }
  cm.accountBusy = false;
  renderConnections();
}

async function refreshCatalog() {
  cm.busy.catalog = true;
  renderConnections();
  try { cm.catalog = await apiPost('/models/refresh', {}); cm.catalogError = null; } catch (err) { cm.catalogError = cmErrorText(err); }
  await reloadRoles();
  cm.busy.catalog = false;
  renderConnections();
}

// ---------- account card ----------

function cmResetTime(value) {
  if (!isNumber(value)) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleString();
}

function cmWindowLabel(name, win) {
  const mins = win && win.windowDurationMins;
  if (!isNumber(mins)) return name;
  if (mins % 1440 === 0) return name + ' (' + (mins / 1440) + ' d window)';
  if (mins % 60 === 0) return name + ' (' + (mins / 60) + ' h window)';
  return name + ' (' + mins + ' min window)';
}

function cmLimitRow(name, win) {
  const used = win && isNumber(win.usedPercent) ? Math.round(win.usedPercent) + '% used' : 'usage unavailable';
  const reset = win ? cmResetTime(win.resetsAt) : null;
  return h('div', { class: 'provider-limit' }, [
    h('span', { class: 'provider-limit-name', text: cmWindowLabel(name, win) }),
    h('span', { class: 'provider-limit-value', text: used + (reset ? ', resets ' + reset : '') })
  ]);
}

function cmAccountBadge() {
  const acc = cm.account;
  if (!acc) return h('span', { class: 'status-badge warning', text: cm.accountError ? 'Unavailable' : 'Checking...' });
  if (acc.status === 'connected') return h('span', { class: 'status-badge connected', text: 'Connected' });
  if (acc.status === 'requires_auth') return h('span', { class: 'status-badge disconnected', text: 'Sign-in required' });
  if (acc.status === 'unsupported_account') return h('span', { class: 'status-badge warning', text: 'Unsupported account' });
  return h('span', { class: 'status-badge warning', text: 'Unavailable' });
}

function renderAccountCard(grid) {
  const acc = cm.account;
  const card = h('div', { class: 'provider-card', attrs: { id: 'openai-card' } });
  card.appendChild(h('div', { class: 'provider-header' }, [
    h('div', { attrs: { style: 'display:flex; align-items:center; gap:10px;' } }, [
      h('div', { class: 'provider-icon-badge', text: 'AI' }),
      h('div', {}, [
        h('div', { class: 'provider-title', text: 'OpenAI (Codex, ChatGPT sign-in)' }),
        h('div', { class: 'provider-sub', text: 'Installed Codex App Server' })
      ])
    ]),
    cmAccountBadge()
  ]));

  const rows = [];
  if (acc && acc.account) {
    if (acc.status === 'connected') {
      rows.push(['Plan', acc.account.planType || 'unavailable']);
      rows.push(['Email', acc.account.email || 'unavailable']);
    } else {
      rows.push(['Account type', acc.account.type || 'unknown']);
    }
  }
  if (acc) {
    rows.push(['App Server version', acc.appServerVersion || 'unavailable']);
    rows.push(['Checked', formatAbsTime(acc.checkedAt)]);
  }
  if (rows.length) card.appendChild(trrKv(rows));

  if (acc && acc.status === 'connected') {
    const rl = acc.rateLimits;
    const limits = h('div', { class: 'provider-limits' });
    if (rl && (rl.primary || rl.secondary)) {
      if (rl.primary) limits.appendChild(cmLimitRow('Primary', rl.primary));
      if (rl.secondary) limits.appendChild(cmLimitRow('Secondary', rl.secondary));
      if (rl.ordinaryUsageAllowed === false) {
        limits.appendChild(h('div', { class: 'tone-warn', attrs: { style: 'font-size:12px;font-weight:600;' }, text: 'Ordinary usage is currently not allowed on this account.' }));
      }
    } else {
      limits.appendChild(h('span', { class: 'detail-empty', text: 'Rate limit windows unavailable.' }));
    }
    card.appendChild(limits);
  }

  if (cm.accountError) card.appendChild(h('div', { class: 'tf-field-error', text: 'Account check failed: ' + cm.accountError, attrs: { role: 'alert' } }));
  else if (!acc && cm.accountLoaded) card.appendChild(h('div', { class: 'detail-empty', text: 'Account status unavailable.' }));
  if (acc && acc.status !== 'connected') {
    const text = CM_SETUP_TEXT[acc.status] || CM_SETUP_TEXT.unavailable;
    card.appendChild(h('p', { class: 'provider-setup', text }));
  }

  const refresh = h('button', { class: 'btn btn-secondary', text: cm.accountBusy ? 'Refreshing...' : 'Refresh', attrs: { type: 'button', id: 'btn-refresh-account' } });
  refresh.disabled = cm.accountBusy || !cm.accountLoaded;
  refresh.addEventListener('click', refreshAccount);
  card.appendChild(h('div', { class: 'provider-actions' }, [refresh]));
  grid.appendChild(card);
}

// ---------- role defaults ----------

function cmBase(row) {
  const e = row.effective || {};
  return { model: e.model || '', effort: e.effort || '', serviceTier: e.serviceTier || null };
}

function cmDraftOf(row) {
  return cm.drafts[row.roleRuntimeId] || cmBase(row);
}

function cmSetDraft(row, patch) {
  const next = Object.assign({}, cmDraftOf(row), patch);
  const entry = cmFindModel(next.model);
  if (entry && patch.model !== undefined) {
    if (!entry.efforts.includes(next.effort)) next.effort = entry.defaultEffort && entry.efforts.includes(entry.defaultEffort) ? entry.defaultEffort : (entry.efforts[0] || '');
    if (next.serviceTier && !entry.serviceTiers.some(t => t.id === next.serviceTier)) next.serviceTier = null;
  }
  cm.drafts[row.roleRuntimeId] = next;
  delete cm.notes[row.roleRuntimeId];
  renderConnections();
}

function cmDirty(row) {
  const d = cm.drafts[row.roleRuntimeId];
  if (!d) return false;
  const b = cmBase(row);
  return d.model !== b.model || d.effort !== b.effort || (d.serviceTier || null) !== (b.serviceTier || null);
}

function cmSelect(options, value, onChange, disabled, label, descriptionId) {
  const sel = h('select', { class: 'select-input', attrs: { 'aria-label': label, 'aria-describedby': descriptionId } });
  options.forEach(o => {
    const opt = h('option', { text: o.label, attrs: { value: o.value } });
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.disabled = disabled;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function cmModelOptions(current) {
  const options = cmModels().map(m => ({ value: m.model, label: m.displayName && m.displayName !== m.model ? m.displayName + ' (' + m.model + ')' : m.model }));
  if (current && !options.some(o => o.value === current)) {
    options.unshift({ value: current, label: cmCatalogState().state === 'ok' ? current + ' (not in catalog)' : current });
  }
  return options;
}

function cmEffortOptions(entry, current) {
  const list = entry ? entry.efforts.slice() : [];
  if (current && !list.includes(current)) list.unshift(current);
  return list.map(id => ({ value: id, label: id }));
}

function cmRoleRow(row, catalogOk) {
  const id = row.roleRuntimeId;
  const draft = cmDraftOf(row);
  const entry = cmFindModel(draft.model);
  const busy = Boolean(cm.busy[id]);
  const catalogErr = (row.errors || []).some(e => e.field === 'catalog');
  const invalid = row.valid === false && !catalogErr;
  const disabled = !catalogOk || busy;

  const nameCell = h('td', {}, [
    h('div', { class: 'role-name', text: row.displayName || id }),
    h('div', { class: 'role-id', text: id + (row.kind ? ' - ' + row.kind : '') })
  ]);
  const modelCell = h('td', {}, [cmSelect(cmModelOptions(draft.model), draft.model, v => cmSetDraft(row, { model: v }), disabled, 'Model for ' + id, 'role-model-help')]);
  const effortCell = h('td', {}, [cmSelect(cmEffortOptions(entry, draft.effort), draft.effort, v => cmSetDraft(row, { effort: v }), disabled, 'Reasoning effort for ' + id, 'role-effort-help')]);
  const speedCell = h('td', {});
  if (entry && entry.serviceTiers.length) {
    const opts = [{ value: '', label: cmTierLabel(null, draft.model) }].concat(entry.serviceTiers.map(t => ({ value: t.id, label: t.name || t.id })));
    const sel = cmSelect(opts, draft.serviceTier || '', v => cmSetDraft(row, { serviceTier: v || null }), disabled, 'Speed for ' + id, 'role-speed-help');
    sel.title = 'Listed by the model. This does not prove your account is entitled to it.';
    speedCell.appendChild(sel);
  } else {
    speedCell.appendChild(h('span', { class: 'detail-empty', text: cmTierLabel(null, draft.model) }));
  }

  const source = row.effective && row.effective.source === 'saved' ? 'saved' : 'profile';
  const sourceCell = h('td', { class: 'role-cell-source' }, [
    h('span', {
      class: 'badge ' + (source === 'saved' ? 'tone-info' : 'tone-neutral'), text: source,
      title: source === 'saved' ? 'Saved default (used for new runs)' : 'Built-in profile default (nothing saved)'
    })
  ]);
  if (invalid) {
    sourceCell.appendChild(document.createTextNode(' '));
    sourceCell.appendChild(h('span', {
      class: 'badge tone-bad', text: 'Invalid',
      title: (row.errors || []).map(e => e.message).join('; ') || 'Not valid against the current catalog'
    }));
  }

  const ruleCount = row.rules && Number.isInteger(row.rules.count) ? row.rules.count : 0;
  const rulesBtn = h('button', {
    class: 'btn btn-secondary role-rules-btn', text: ruleCount > 0 ? 'Rules (' + ruleCount + ')' : 'Add rules',
    attrs: { type: 'button', 'data-role-rules': id, 'aria-label': (ruleCount > 0 ? 'Rules (' + ruleCount + ') for ' : 'Add rules for ') + (row.displayName || id) }
  });
  rulesBtn.addEventListener('click', () => { if (typeof openRoleRules === 'function') openRoleRules(row, rulesBtn); });
  const rulesCell = h('td', { class: 'role-cell-rules' }, [rulesBtn]);

  const dirty = cmDirty(row);
  const save = h('button', { class: 'btn btn-primary', text: busy ? 'Working...' : 'Save', attrs: { type: 'button', 'data-role': id } });
  save.disabled = disabled || !dirty || !draft.model || !draft.effort;
  save.addEventListener('click', () => cmSave(row));
  const reset = h('button', { class: 'btn btn-secondary', text: 'Reset', attrs: { type: 'button', title: 'Return to the profile default' } });
  reset.disabled = busy || !row.current;
  reset.addEventListener('click', () => cmReset(row));
  const hist = h('button', {
    class: 'btn btn-secondary', text: cm.history[id] && cm.history[id].open ? 'Hide history' : 'History', attrs: { type: 'button' }
  });
  hist.addEventListener('click', () => cmToggleHistory(row));
  const actions = h('td', {}, [h('div', { class: 'role-row-actions' }, [save, reset, hist])]);
  const note = cm.notes[id];
  if (note) actions.appendChild(h('div', { class: 'role-row-note ' + (note.ok ? 'tone-ok' : 'tone-bad'), text: note.text, attrs: { role: note.ok ? 'status' : 'alert' } }));
  if (invalid) actions.appendChild(h('div', { class: 'role-row-note tone-bad', text: 'Saved default is not valid: choose a supported model and effort, or reset.' }));

  const tr = h('tr', { class: invalid ? 'role-invalid' : '', attrs: { 'data-role': id } }, [nameCell, modelCell, effortCell, speedCell, sourceCell, rulesCell, actions]);
  const out = [tr];
  const hs = cm.history[id];
  if (hs && hs.open) out.push(cmHistoryRow(hs));
  return out;
}

function cmHistoryRow(hs) {
  const cell = h('td', { class: 'role-history-cell', attrs: { colspan: '7' } });
  if (hs.loading) cell.appendChild(h('span', { class: 'detail-empty', text: 'Loading history...' }));
  else if (hs.error) cell.appendChild(h('span', { class: 'tf-field-error', text: 'History unavailable: ' + hs.error }));
  else if (!hs.data || !hs.data.revisions.length) cell.appendChild(h('span', { class: 'detail-empty', text: 'No saved revisions yet.' }));
  else {
    const list = h('ul', { class: 'role-history-list' });
    hs.data.revisions.forEach(r => {
      const isCurrent = r.settingsRevisionId === hs.data.currentRevisionId;
      list.appendChild(h('li', {}, [
        h('span', { class: 'role-history-time', text: formatAbsTime(r.createdAt) }),
        h('span', { text: r.model + ' / ' + r.effort + ' / ' + cmTierLabel(r.serviceTier, r.model) }),
        h('span', { text: 'by ' + r.actor }),
        isCurrent ? h('span', { class: 'badge tone-info', text: 'current' }) : null
      ]));
    });
    cell.appendChild(list);
  }
  return h('tr', { class: 'role-history-row' }, [cell]);
}

async function cmToggleHistory(row) {
  const id = row.roleRuntimeId;
  const hs = cm.history[id] || (cm.history[id] = { open: false, loading: false, data: null, error: null });
  hs.open = !hs.open;
  if (hs.open) {
    hs.loading = true; hs.error = null;
    renderConnections();
    try { hs.data = await apiGet('/settings/roles/' + encodeURIComponent(id) + '/history'); } catch (err) { hs.error = cmErrorText(err); }
    hs.loading = false;
  }
  renderConnections();
}

async function cmMutate(row, run, okText) {
  const id = row.roleRuntimeId;
  cm.busy[id] = true;
  delete cm.notes[id];
  renderConnections();
  try {
    await run();
    delete cm.drafts[id];
    delete cm.cmds[id];
    cm.notes[id] = { ok: true, text: okText };
    if (cm.history[id] && cm.history[id].open) {
      try { cm.history[id].data = await apiGet('/settings/roles/' + encodeURIComponent(id) + '/history'); } catch (_) { /* shown on next toggle */ }
    }
  } catch (err) {
    if (err && err.code === 'stale_version') {
      delete cm.drafts[id];
      delete cm.cmds[id];
      cm.notes[id] = { ok: false, text: 'This default changed elsewhere. Reloaded the current value; review and try again.' };
    } else if (err && err.code === 'catalog_unavailable') {
      cm.notes[id] = { ok: false, text: 'Model catalog unavailable. Retry the catalog, then save again.' };
    } else {
      cm.notes[id] = { ok: false, text: cmErrorText(err) };
    }
  }
  await reloadRoles();
  cm.busy[id] = false;
  renderConnections();
}

function cmSave(row) {
  const d = cmDraftOf(row);
  const payload = {
    expectedRevisionId: row.current ? row.current.settingsRevisionId : null,
    model: d.model, effort: d.effort, serviceTier: d.serviceTier || null
  };
  const body = Object.assign({ commandId: cmCommandFor(row.roleRuntimeId, 'save', payload) }, payload);
  return cmMutate(row, () => apiRequest('PUT', '/settings/roles/' + encodeURIComponent(row.roleRuntimeId), { body }),
    'Saved. Applies to new runs only.');
}

function cmReset(row) {
  if (!row.current) return Promise.resolve();
  const payload = { expectedRevisionId: row.current.settingsRevisionId };
  const body = Object.assign({ commandId: cmCommandFor(row.roleRuntimeId, 'reset', payload) }, payload);
  return cmMutate(row, () => apiRequest('DELETE', '/settings/roles/' + encodeURIComponent(row.roleRuntimeId), { body }),
    'Reset to the profile default. Applies to new runs only.');
}

function renderCatalogStatus(el, cs) {
  cmClear(el);
  if (cs.state === 'ok') return;
  if (cs.state === 'loading') {
    el.appendChild(h('div', { class: 'detail-empty', text: 'Loading model catalog...' }));
    return;
  }
  const retry = h('button', { class: 'btn btn-secondary', text: cm.busy.catalog ? 'Retrying...' : 'Retry', attrs: { type: 'button', id: 'btn-retry-catalog' } });
  retry.disabled = Boolean(cm.busy.catalog);
  retry.addEventListener('click', refreshCatalog);
  el.appendChild(h('div', { class: 'tr-banner tone-bad', attrs: { role: 'alert' } }, [
    h('span', { text: 'Model catalog unavailable: ' + cs.message + ' Defaults are read-only until the catalog loads.' }),
    h('span', { class: 'tr-banner-actions' }, [retry])
  ]));
}

function renderConnections() {
  renderAtlassian();
  const grid = document.getElementById('providers-grid');
  if (grid) {
    cmClear(grid);
    renderAccountCard(grid);
  }

  const status = document.getElementById('role-defaults-status');
  const cs = cmCatalogState();
  if (status) renderCatalogStatus(status, cs);

  const tbody = document.getElementById('role-defaults-body');
  if (!tbody) return;
  cmClear(tbody);
  const span = (text, cls) => h('tr', {}, [h('td', { attrs: { colspan: '7' } }, [h('span', { class: cls || 'detail-empty', text })])]);
  if (cm.rolesError) { tbody.appendChild(span('Role defaults unavailable: ' + cm.rolesError, 'tf-field-error')); return; }
  if (!cm.roles) { tbody.appendChild(span(cm.rolesLoaded ? 'Role defaults unavailable.' : 'Loading role defaults...')); return; }
  const rows = Array.isArray(cm.roles.roles) ? cm.roles.roles : [];
  if (!rows.length) { tbody.appendChild(span('No roles in the active pack.')); return; }
  rows.forEach(row => cmRoleRow(row, cs.state === 'ok').forEach(tr => tbody.appendChild(tr)));
}

// The tab loads its data whenever it becomes visible by any route: click, restored navigation or
// programmatic activation. The pane's class change is the single signal; loadConnections() ignores
// calls while a load is in flight.
(function initConnectionsLoad() {
  const tabBtn = document.querySelector('.tab-btn[data-tab="tab-connections"]');
  if (tabBtn) tabBtn.addEventListener('click', () => { loadConnections(); });
  const pane = document.getElementById('tab-connections');
  if (pane && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (pane.classList.contains('active')) loadConnections();
    }).observe(pane, { attributes: true, attributeFilter: ['class'] });
  }
})();
