// --- PROJECT RULES MODAL (PC-1): per-role system prompt overlay for this project ---
// Rule text from the server is always rendered with textContent (h() helper), never as markup.

const rr = {
  open: false, roleId: null, roleName: '', opener: null, seq: 0,
  loading: false, loadError: null, data: null, busy: false,
  status: '', statusError: false, fieldError: '',
  editId: null, editDraft: '', editError: '', confirmId: null,
  historyOpen: false, cmds: {}
};

const RR_DEFAULT_LIMITS = { maxRuleChars: 2000, maxRules: 20, maxTotalChars: 20000 };
const RR_CHANGE_LABELS = { add: 'Added', edit: 'Edited', remove: 'Removed' };

function rrEl(id) { return document.getElementById(id); }
function rrBase() { return '/settings/roles/' + encodeURIComponent(rr.roleId) + '/rules'; }
function rrLimits() { return Object.assign({}, RR_DEFAULT_LIMITS, rr.data && rr.data.limits); }
function rrRules() { return rr.data && Array.isArray(rr.data.rules) ? rr.data.rules : []; }

// Mutations are blocked while a request is pending or the dashboard has lost the orchestrator.
function rrCanMutate() {
  if (rr.busy) return false;
  return !(typeof Conn !== 'undefined' && (Conn.status === 'unpaired' || Conn.status === 'reconnecting'));
}

// The same payload keeps the same commandId so a retry after a network error replays instead of duplicating.
function rrCommandFor(key, payload) {
  const sig = JSON.stringify([key, payload]);
  const held = rr.cmds[key];
  if (held && held.sig === sig) return held.id;
  const rnd = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  rr.cmds[key] = { sig, id: 'rule-' + rnd };
  return rr.cmds[key].id;
}

function rrSetStatus(text, isError) {
  rr.status = text || '';
  rr.statusError = Boolean(isError);
  const el = rrEl('rr-status');
  if (!el) return;
  el.textContent = rr.status;
  el.className = 'rr-status' + (rr.status ? (rr.statusError ? ' tone-bad' : ' tone-ok') : '');
  el.setAttribute('role', rr.statusError ? 'alert' : 'status');
}

function rrCountText(len, max) {
  const left = max - len;
  return left >= 0 ? left + ' characters left' : (-left) + ' characters over the limit';
}

function rrOverLimits(text, ignoreRuleId) {
  const lim = rrLimits();
  const rules = rrRules();
  if (!text || text.length > lim.maxRuleChars) return true;
  const total = rules.reduce((n, r) => n + (r.ruleId === ignoreRuleId ? 0 : String(r.text).length), 0) + text.length;
  return total > lim.maxTotalChars;
}

// Add controls are updated in place so typing never re-renders (and never loses) the draft.
function rrUpdateAddControls() {
  const ta = rrEl('rr-new-text');
  const add = rrEl('btn-rr-add');
  const counter = rrEl('rr-counter');
  if (!ta || !add || !counter) return;
  const lim = rrLimits();
  const text = ta.value.trim();
  const full = rrRules().length >= lim.maxRules;
  counter.textContent = full ? 'Rule limit reached (' + lim.maxRules + ')' : rrCountText(text.length, lim.maxRuleChars);
  counter.className = 'rr-counter' + (text.length > lim.maxRuleChars || full ? ' tone-bad' : '');
  add.disabled = !rrCanMutate() || full || rrOverLimits(text, null);
  add.textContent = rr.busy && !rr.editId && !rr.confirmId ? 'Adding...' : 'Add rule';
}

// Re-rendering the list destroys the focused button; put focus back on the matching control.
function rrFocusRule(ruleId, act) {
  const list = rrEl('rr-list');
  if (!list || typeof list.querySelector !== 'function') return false;
  const item = list.querySelector('[data-rule-id="' + ruleId + '"]');
  const target = item && item.querySelector('[data-rr-act="' + act + '"]');
  if (target && target.focus) { target.focus(); return true; }
  return false;
}

function rrFocusNew() {
  const ta = rrEl('rr-new-text');
  if (ta && ta.focus) ta.focus();
}

function rrRuleItem(rule, index) {
  const canMutate = rrCanMutate();
  const n = index + 1;
  if (rr.editId === rule.ruleId) {
    const lim = rrLimits();
    const ta = h('textarea', { class: 'form-textarea', attrs: { rows: '4', 'aria-label': 'Edit rule ' + n, 'data-rr-act': 'textarea' } });
    ta.value = rr.editDraft;
    const counter = h('span', { class: 'rr-counter' });
    const save = h('button', { class: 'btn btn-primary', text: 'Save', attrs: { type: 'button' } });
    const cancel = h('button', { class: 'btn btn-secondary', text: 'Cancel', attrs: { type: 'button' } });
    const err = h('div', { class: 'tf-field-error', text: rr.editError, attrs: { role: 'alert' } });
    const sync = () => {
      const text = rr.editDraft.trim();
      counter.textContent = rrCountText(text.length, lim.maxRuleChars);
      counter.className = 'rr-counter' + (text.length > lim.maxRuleChars ? ' tone-bad' : '');
      save.disabled = !rrCanMutate() || text === rule.text || rrOverLimits(text, rule.ruleId);
    };
    ta.addEventListener('input', () => { rr.editDraft = ta.value; sync(); });
    save.addEventListener('click', () => rrSaveEdit(rule));
    cancel.addEventListener('click', () => { rr.editId = null; rr.editError = ''; rrRenderList(); rrFocusRule(rule.ruleId, 'edit'); });
    sync();
    return h('div', { class: 'rr-rule rr-rule-editing', attrs: { 'data-rule-id': rule.ruleId } }, [ta, h('div', { class: 'rr-add-row' }, [counter, h('span', { class: 'rr-actions' }, [save, cancel])]), err]);
  }
  const actions = h('span', { class: 'rr-actions' });
  if (rr.confirmId === rule.ruleId) {
    const yes = h('button', { class: 'btn btn-secondary', text: 'Confirm remove', attrs: { type: 'button', 'aria-label': 'Confirm remove rule ' + n, 'data-rr-act': 'confirm' } });
    yes.disabled = !canMutate;
    yes.addEventListener('click', () => rrRemove(rule));
    const no = h('button', { class: 'btn btn-secondary', text: 'Keep', attrs: { type: 'button' } });
    no.addEventListener('click', () => { rr.confirmId = null; rrRenderList(); rrFocusRule(rule.ruleId, 'remove'); });
    actions.appendChild(h('span', { class: 'rr-confirm', text: 'Remove this rule?' }));
    actions.appendChild(yes);
    actions.appendChild(no);
  } else {
    const edit = h('button', { class: 'btn btn-secondary', text: 'Edit', attrs: { type: 'button', 'aria-label': 'Edit rule ' + n, 'data-rr-act': 'edit' } });
    edit.disabled = !canMutate;
    edit.addEventListener('click', () => { rr.editId = rule.ruleId; rr.editDraft = rule.text; rr.editError = ''; rr.confirmId = null; rrRenderList(); rrFocusRule(rule.ruleId, 'textarea'); });
    const remove = h('button', { class: 'btn btn-secondary', text: 'Remove', attrs: { type: 'button', 'aria-label': 'Remove rule ' + n, 'data-rr-act': 'remove' } });
    remove.disabled = !canMutate;
    remove.addEventListener('click', () => { rr.confirmId = rule.ruleId; rr.editId = null; rrRenderList(); rrFocusRule(rule.ruleId, 'confirm'); });
    actions.appendChild(edit);
    actions.appendChild(remove);
  }
  return h('div', { class: 'rr-rule', attrs: { 'data-rule-id': rule.ruleId } }, [
    h('div', { class: 'rr-rule-text', text: rule.text }), actions
  ]);
}

function rrRenderList() {
  const list = rrEl('rr-list');
  if (!list) return;
  cmClear(list);
  const rules = rrRules();
  if (!rules.length) { list.appendChild(h('div', { class: 'detail-empty', text: 'No project rules for this role yet.' })); return; }
  rules.forEach((rule, i) => list.appendChild(rrRuleItem(rule, i)));
}

function rrRenderHistory() {
  const btn = rrEl('btn-rr-history');
  const box = rrEl('rr-history');
  if (!btn || !box) return;
  btn.setAttribute('aria-expanded', rr.historyOpen ? 'true' : 'false');
  btn.textContent = rr.historyOpen ? 'Hide history' : 'History';
  box.hidden = !rr.historyOpen;
  cmClear(box);
  if (!rr.historyOpen) return;
  const history = rr.data && Array.isArray(rr.data.history) ? rr.data.history : [];
  if (!history.length) { box.appendChild(h('span', { class: 'detail-empty', text: 'No rule changes yet.' })); return; }
  const ul = h('ul', { class: 'role-history-list' });
  history.forEach(r => {
    ul.appendChild(h('li', {}, [
      h('span', { class: 'role-history-time', text: formatAbsTime(r.createdAt) }),
      h('span', { text: RR_CHANGE_LABELS[r.changeKind] || String(r.changeKind) }),
      h('span', { text: 'by ' + r.actor }),
      h('span', { text: r.ruleCount + (r.ruleCount === 1 ? ' rule' : ' rules') })
    ]));
  });
  box.appendChild(ul);
}

function renderRoleRules() {
  if (!rr.open) return;
  const load = rrEl('rr-load');
  const content = rrEl('rr-content');
  if (!load || !content) return;
  cmClear(load);
  const ready = Boolean(rr.data);
  content.hidden = !ready;
  if (rr.loading && !ready) load.appendChild(h('div', { class: 'detail-empty', text: 'Loading rules...' }));
  if (rr.loadError && !ready) {
    const retry = h('button', { class: 'btn btn-secondary', text: 'Retry', attrs: { type: 'button', id: 'btn-rr-retry' } });
    retry.addEventListener('click', () => loadRoleRules());
    load.appendChild(h('div', { class: 'tr-banner tone-bad', attrs: { role: 'alert' } }, [
      h('span', { text: 'Rules unavailable: ' + rr.loadError }),
      h('span', { class: 'tr-banner-actions' }, [retry])
    ]));
  }
  if (!ready) return;
  rrRenderList();
  rrRenderHistory();
  const fe = rrEl('rr-field-error');
  if (fe) fe.textContent = rr.fieldError;
  rrUpdateAddControls();
}

async function loadRoleRules() {
  const seq = ++rr.seq;
  rr.loading = true; rr.loadError = null;
  renderRoleRules();
  try {
    const data = await apiGet(rrBase());
    if (seq !== rr.seq) return;
    rr.data = data;
  } catch (err) {
    if (seq !== rr.seq) return;
    rr.loadError = cmErrorText(err);
  }
  rr.loading = false;
  renderRoleRules();
}

// Table row label and count follow the server after every successful change.
async function rrRefreshTable() {
  if (typeof reloadRoles === 'function') await reloadRoles();
  if (typeof renderConnections === 'function') renderConnections();
}

// kind: add | edit | remove; one pending request at a time.
async function rrMutate(kind, rule, text, okText) {
  const expectedRevisionId = rr.data ? rr.data.currentRevisionId : null;
  const payload = { expectedRevisionId };
  if (text !== null) payload.text = text;
  const body = Object.assign({ commandId: rrCommandFor(kind + ':' + (rule ? rule.ruleId : ''), payload) }, payload);
  const method = kind === 'add' ? 'POST' : (kind === 'edit' ? 'PUT' : 'DELETE');
  const path = rrBase() + (rule ? '/' + encodeURIComponent(rule.ruleId) : '');
  const seq = rr.seq;
  rr.busy = true; rr.fieldError = ''; rr.editError = '';
  rrSetStatus('', false);
  renderRoleRules();
  let ok = false;
  try {
    await apiRequest(method, path, { body });
    ok = true;
    delete rr.cmds[kind + ':' + (rule ? rule.ruleId : '')];
  } catch (err) {
    if (seq !== rr.seq || !rr.open) { rr.busy = false; return false; }
    if (err && err.code === 'stale_version') {
      rr.editId = null; rr.confirmId = null;
      delete rr.cmds[kind + ':' + (rule ? rule.ruleId : '')];
      rrSetStatus('Rules changed elsewhere; reloaded.', true);
    } else if (err && err.status >= 400 && err.status < 500) {
      const msg = cmErrorText(err);
      if (kind === 'add') rr.fieldError = msg;
      else if (kind === 'edit') rr.editError = msg;
      else rrSetStatus(msg, true);
    } else {
      rrSetStatus(cmErrorText(err) + ' Your text is kept; retry when the connection is back.', true);
    }
  }
  if (seq !== rr.seq || !rr.open) { rr.busy = false; return ok; }
  if (ok) {
    rr.editId = null; rr.confirmId = null; rr.editDraft = '';
    rrSetStatus(okText + ' Applies to new runs only.', false);
  }
  if (ok || (rr.status === 'Rules changed elsewhere; reloaded.')) {
    try { rr.data = await apiGet(rrBase()); } catch (err) { rrSetStatus('Saved, but the list could not be reloaded: ' + cmErrorText(err), true); }
  }
  rr.busy = false;
  if (!rr.open) return ok;
  renderRoleRules();
  if (kind === 'edit') { if (!rrFocusRule(rule.ruleId, ok ? 'edit' : 'textarea')) rrFocusNew(); }
  else if (kind === 'remove' && !ok && rr.confirmId) rrFocusRule(rule.ruleId, 'confirm');
  else rrFocusNew();
  if (ok) await rrRefreshTable();
  return ok;
}

async function rrAdd() {
  const ta = rrEl('rr-new-text');
  const text = ta ? ta.value.trim() : '';
  if (!text || !rrCanMutate()) return;
  const ok = await rrMutate('add', null, text, 'Rule added.');
  if (ok && ta && ta.value.trim() === text) { ta.value = ''; rrUpdateAddControls(); }
}

function rrSaveEdit(rule) {
  const text = rr.editDraft.trim();
  if (!text || !rrCanMutate()) return Promise.resolve();
  return rrMutate('edit', rule, text, 'Rule updated.');
}

function rrRemove(rule) {
  if (!rrCanMutate()) return Promise.resolve();
  return rrMutate('remove', rule, null, 'Rule removed.');
}

function openRoleRules(row, opener) {
  const modal = rrEl('modal-role-rules');
  if (!modal || !row) return;
  rr.seq += 1;
  Object.assign(rr, {
    open: true, roleId: row.roleRuntimeId, roleName: row.displayName || row.roleRuntimeId, opener: opener || null,
    loading: false, loadError: null, data: null, busy: false, status: '', statusError: false, fieldError: '',
    editId: null, editDraft: '', editError: '', confirmId: null, historyOpen: false, cmds: {}
  });
  const title = rrEl('rr-title');
  if (title) title.textContent = 'Project rules - ' + rr.roleName;
  const ta = rrEl('rr-new-text');
  if (ta) ta.value = '';
  rrSetStatus('', false);
  modal.classList.add('open');
  const close = rrEl('btn-rr-close');
  if (close && close.focus) close.focus();
  loadRoleRules();
}

function closeRoleRules() {
  if (!rr.open) return;
  const modal = rrEl('modal-role-rules');
  const roleId = rr.roleId;
  const opener = rr.opener;
  rr.open = false; rr.seq += 1; rr.busy = false; rr.data = null;
  if (modal) modal.classList.remove('open');
  // The table re-renders after changes, so the original button may be detached: look it up again.
  let target = null;
  try { target = document.querySelector('[data-role-rules="' + String(roleId).replace(/["\\]/g, '\\$&') + '"]'); } catch (_) { target = null; }
  target = target || opener;
  if (target && target.focus) target.focus();
}

function rrFocusable() {
  const modal = rrEl('modal-role-rules');
  if (!modal || !modal.querySelectorAll) return [];
  return Array.from(modal.querySelectorAll('button, textarea, input, select, [href], [tabindex]'))
    .filter(el => !el.disabled && el.getAttribute('tabindex') !== '-1' && !(el.closest && el.closest('[hidden]')));
}

function initRoleRulesEvents() {
  const modal = rrEl('modal-role-rules');
  if (!modal) return;
  rrEl('btn-rr-close').addEventListener('click', closeRoleRules);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeRoleRules(); });
  rrEl('btn-rr-add').addEventListener('click', rrAdd);
  rrEl('rr-new-text').addEventListener('input', () => { rr.fieldError = ''; const fe = rrEl('rr-field-error'); if (fe) fe.textContent = ''; rrUpdateAddControls(); });
  rrEl('btn-rr-history').addEventListener('click', () => { rr.historyOpen = !rr.historyOpen; rrRenderHistory(); });
  document.addEventListener('keydown', (e) => {
    if (!rr.open) return;
    if (e.key === 'Escape') { closeRoleRules(); return; }
    if (e.key !== 'Tab') return;
    const items = rrFocusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !modal.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !modal.contains(active))) { e.preventDefault(); first.focus(); }
  });
}
