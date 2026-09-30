// --- M2: CREATE / EDIT DIRECT TICKET FORM (POST /tickets, POST /tickets/:id/revisions) ---
const TF_TITLE_MAX = 200;
const TF_DESC_MAX = 32000;
const TF_CRITERIA_MAX_ITEMS = 100;
const TF_CRITERIA_MAX_CHARS = 16000;
const TF_REF_MAX_ITEMS = 20;
const TF_REF_MAX_CHARS = 2000;
const TF_DEFAULT_EXTENSIONS = ['.txt', '.md', '.json', '.png', '.jpg', '.jpeg', '.webp', '.pdf', '.doc', '.docx'];
const TF_DEFAULT_POLICY = { maxFiles: 10, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024 };
const TF_REF_FIELDS = [
  { key: 'jiraIssues', id: 'ticket-jira-issue' },
  { key: 'jiraParents', id: 'ticket-jira-parents' },
  { key: 'confluence', id: 'ticket-confluence' },
  { key: 'figma', id: 'ticket-figma' },
  { key: 'links', id: 'ticket-links' }
];
const TF_EXTRACTION_TEXT = {
  extracted: 'Text available to agents after Intake (M3)',
  stored_not_read: 'Stored; agents cannot read images yet',
  reference_only: 'Stored as reference; content is not read'
};

// One entry per form open; `session` invalidates late upload callbacks after close/reopen.
const tf = {
  session: 0, mode: 'create', ticketId: null, expectedVersion: null, commandId: null,
  lastPayload: null, files: [], saving: false, nextKey: 1, ordinal: null
};

function extractionWording(extraction) {
  return TF_EXTRACTION_TEXT[extraction] || 'Extraction state unknown';
}

function formatBytes(n) {
  if (!isNumber(n)) return 'unknown size';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1024 / 1024).toFixed(1) + ' MiB';
}

function newCommandId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function ticketCommandEnabled(name) {
  const caps = boardData.context && boardData.context.capabilities;
  return Boolean(caps && Array.isArray(caps.ticketCommands) && caps.ticketCommands.includes(name));
}

// Tolerant reader: the context contract names the policy but not its key names.
function attachmentPolicy() {
  const raw = (boardData.context && boardData.context.attachmentPolicy) || {};
  const src = Object.assign({}, raw, raw.limits && typeof raw.limits === 'object' ? raw.limits : {});
  const pick = (keys, fallback) => {
    for (const k of keys) if (isNumber(src[k]) && src[k] > 0) return src[k];
    return fallback;
  };
  const exts = new Set();
  const addExt = (e) => {
    if (typeof e !== 'string' || !e) return;
    const v = e.trim().toLowerCase();
    if (v) exts.add(v.startsWith('.') ? v : '.' + v);
  };
  const walk = (entry) => {
    if (typeof entry === 'string') addExt(entry);
    else if (Array.isArray(entry)) entry.forEach(walk);
    else if (entry && typeof entry === 'object') {
      addExt(entry.extension); addExt(entry.ext);
      if (entry.extensions) walk(entry.extensions);
    }
  };
  ['extensions', 'allowedExtensions', 'formats', 'matrix'].forEach(k => { if (src[k]) walk(src[k]); });
  return {
    maxFiles: pick(['maxFiles', 'maxFilesPerTicket', 'maxFileCount'], TF_DEFAULT_POLICY.maxFiles),
    maxFileBytes: pick(['maxFileBytes', 'maxBytesPerFile', 'maxFileSizeBytes', 'maxFileSize'], TF_DEFAULT_POLICY.maxFileBytes),
    maxTotalBytes: pick(['maxCombinedBytes', 'maxTotalBytes', 'maxBytesPerTicket', 'maxCombinedSizeBytes'], TF_DEFAULT_POLICY.maxTotalBytes),
    extensions: exts.size ? Array.from(exts) : TF_DEFAULT_EXTENSIONS
  };
}

function updateNewTicketButton() {
  const btn = document.getElementById('btn-open-new-ticket');
  const note = document.getElementById('new-ticket-note');
  if (!btn || !boardData.context) return;
  const ok = ticketCommandEnabled('create');
  btn.disabled = !ok;
  btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
  btn.title = ok ? 'Create a direct ticket' : 'Direct tickets are not available on this server';
  if (note) note.textContent = ok ? 'Direct requests are saved as internal backlog drafts' : 'Direct tickets are not available on this server';
}

function initNewTicketButton() {
  const btn = document.getElementById('btn-open-new-ticket');
  if (!btn) return;
  btn.disabled = true;
  btn.setAttribute('aria-disabled', 'true');
  btn.title = 'Checking capabilities...';
  btn.addEventListener('click', () => { if (!btn.disabled) openTicketForm({ mode: 'create' }); });
  initTicketFormEvents();
}

function tfEl(id) { return document.getElementById(id); }

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function referenceValue(item) {
  return item && typeof item === 'object' ? String(item.value === undefined ? '' : item.value) : String(item);
}

function isFormOpen() {
  const modal = tfEl('modal-add-ticket');
  return Boolean(modal && modal.classList.contains('open'));
}

// opts: { mode: 'create' } or { mode: 'edit', detail: <GET /tickets/:id response> }
function openTicketForm(opts) {
  const modal = tfEl('modal-add-ticket');
  if (!modal) return;
  const edit = opts.mode === 'edit';
  const detail = opts.detail || null;
  const rev = edit ? (detail.revision || {}) : {};
  tf.session += 1;
  tf.mode = edit ? 'edit' : 'create';
  tf.ticketId = edit ? detail.ticket.ticketId : null;
  tf.expectedVersion = edit ? detail.ticket.version : null;
  tf.ordinal = edit ? rev.ordinal : null;
  tf.commandId = newCommandId();
  tf.lastPayload = null;
  tf.saving = false;
  tf.files = [];

  tfEl('modal-ticket-form-title').textContent = edit ? 'Edit Ticket (new revision)' : 'Create Ticket';
  tfEl('btn-submit-ticket').textContent = edit ? 'Save revision' : 'Create Ticket';
  tfEl('tf-revision-note').textContent = edit && isNumber(rev.ordinal)
    ? 'Saving creates revision r' + (rev.ordinal + 1) + '; earlier revisions are kept.' : '';
  const project = boardData.context && boardData.context.project;
  tfEl('tf-project').textContent = project && project.displayName ? project.displayName : 'unknown';

  tfEl('ticket-title-input').value = edit ? (rev.title || '') : '';
  tfEl('ticket-desc-input').value = edit ? (rev.description || '') : '';
  tfEl('ticket-ac-input').value = edit && Array.isArray(rev.criteria) ? rev.criteria.join('\n') : '';
  tfEl('ticket-priority').value = edit && rev.priority ? rev.priority : 'normal';
  fillSpecialtyOptions(edit ? rev.requestedSpecialty : null);
  const refs = (edit && rev.references) || {};
  TF_REF_FIELDS.forEach(f => {
    tfEl(f.id).value = (Array.isArray(refs[f.key]) ? refs[f.key] : []).map(referenceValue).join('\n');
  });

  if (edit) {
    const metas = Array.isArray(rev.artifacts) ? rev.artifacts : [];
    const pool = metas.concat(Array.isArray(detail.artifacts) ? detail.artifacts : []);
    (Array.isArray(rev.artifactIds) ? rev.artifactIds : []).forEach(id => {
      const meta = pool.find(m => m && m.artifactId === id) || { artifactId: id };
      tf.files.push({
        key: tf.nextKey++, id, name: meta.displayName || id, size: meta.size, meta,
        state: 'ok', progress: 1, error: null
      });
    });
  }

  const policy = attachmentPolicy();
  tfEl('ticket-attachments-input').setAttribute('accept', policy.extensions.join(','));
  tfEl('tf-policy-note').textContent = 'Up to ' + policy.maxFiles + ' files, ' + formatBytes(policy.maxFileBytes)
    + ' each, ' + formatBytes(policy.maxTotalBytes) + ' combined. Types: ' + policy.extensions.join(' ');

  clearFormErrors();
  updateTitleCounter();
  renderFormFiles();
  updateSaveState();
  modal.classList.add('open');
  tfEl('ticket-title-input').focus();
}

function fillSpecialtyOptions(selected) {
  const select = tfEl('ticket-role');
  select.textContent = '';
  select.appendChild(h('option', { text: 'No preference', attrs: { value: '' } }));
  const list = boardData.context && Array.isArray(boardData.context.requestedSpecialties) ? boardData.context.requestedSpecialties : [];
  list.forEach(s => select.appendChild(h('option', { text: s.displayName || s.id, attrs: { value: s.id } })));
  if (selected && !list.some(s => s.id === selected)) {
    select.appendChild(h('option', { text: selected, attrs: { value: selected } }));
  }
  select.value = selected || '';
}

function closeTicketForm() {
  tf.session += 1;
  const modal = tfEl('modal-add-ticket');
  if (modal) modal.classList.remove('open');
}

function updateTitleCounter() {
  const len = tfEl('ticket-title-input').value.length;
  const counter = tfEl('ticket-title-counter');
  counter.textContent = len + ' / ' + TF_TITLE_MAX;
  counter.style.color = len >= TF_TITLE_MAX ? 'var(--accent-amber)' : '';
}

function uploadsBusy() {
  return tf.files.some(f => f.state === 'uploading');
}

function updateSaveState() {
  const hasTitle = tfEl('ticket-title-input').value.trim() !== '';
  const btn = tfEl('btn-submit-ticket');
  btn.disabled = tf.saving || uploadsBusy() || !hasTitle;
  btn.title = uploadsBusy() ? 'Wait for uploads to finish' : '';
}

function clearFormErrors() {
  document.querySelectorAll('#form-add-ticket .tf-field-error').forEach(el => { el.textContent = ''; });
  showFormBanner(null);
}

function showFormBanner(message, withReload) {
  const box = tfEl('tf-error');
  tfEl('tf-error-text').textContent = message || '';
  tfEl('tf-reload').style.display = withReload ? '' : 'none';
  box.style.display = message ? 'flex' : 'none';
}

// --- Attachments ---
function fileExtension(name) {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i).toLowerCase();
}

function precheckFile(file, policy) {
  if (!policy.extensions.includes(fileExtension(file.name))) {
    return 'Unsupported file type. Allowed: ' + policy.extensions.join(' ');
  }
  if (file.size === 0) return 'The file is empty';
  if (file.size > policy.maxFileBytes) return 'File is larger than ' + formatBytes(policy.maxFileBytes);
  const live = tf.files.filter(f => f.state !== 'error');
  if (live.length >= policy.maxFiles) return 'At most ' + policy.maxFiles + ' files per ticket';
  const total = live.reduce((sum, f) => sum + (isNumber(f.size) ? f.size : 0), 0);
  if (total + file.size > policy.maxTotalBytes) return 'Combined size would exceed ' + formatBytes(policy.maxTotalBytes);
  return null;
}

function addFiles(fileList) {
  const policy = attachmentPolicy();
  const session = tf.session;
  Array.from(fileList).forEach(file => {
    const entry = { key: tf.nextKey++, id: null, name: file.name, size: file.size, meta: null, state: 'uploading', progress: 0, error: null };
    const problem = precheckFile(file, policy);
    tf.files.push(entry);
    if (problem) {
      entry.state = 'error';
      entry.error = problem;
      return;
    }
    apiUploadFile(file, (p) => {
      if (session !== tf.session) return;
      entry.progress = p;
      updateFileProgress(entry);
    }).then(meta => {
      if (session !== tf.session) return;
      entry.state = 'ok';
      entry.id = meta.artifactId;
      entry.meta = meta;
      entry.name = meta.displayName || entry.name;
      entry.progress = 1;
      entry.error = null;
    }).catch(err => {
      if (session !== tf.session) return;
      entry.state = 'error';
      entry.error = (err && err.message ? err.message : 'Upload failed') + (err && err.status ? ' (HTTP ' + err.status + ')' : '');
    }).then(() => {
      if (session !== tf.session) return;
      renderFormFiles();
      updateSaveState();
    });
  });
  renderFormFiles();
  updateSaveState();
}

function updateFileProgress(entry) {
  const bar = document.querySelector('#ticket-attachments-preview [data-file-key="' + entry.key + '"] progress');
  if (bar) bar.value = entry.progress;
}

function renderFormFiles() {
  const box = tfEl('ticket-attachments-preview');
  box.textContent = '';
  if (!tf.files.length) {
    box.appendChild(h('div', { class: 'form-hint', text: 'No files attached' }));
    return;
  }
  tf.files.forEach(f => {
    const row = h('div', { class: 'tf-file', attrs: { 'data-file-key': String(f.key) } });
    const head = h('div', { class: 'tf-file-head' }, [
      h('span', { class: 'tf-file-name', text: f.name }),
      h('button', {
        class: 'btn btn-secondary btn-remove-attachment', text: 'Remove',
        attrs: { type: 'button', 'aria-label': 'Remove ' + f.name },
        on: { click: () => removeFile(f.key) }
      })
    ]);
    row.appendChild(head);
    const bits = [formatBytes(f.size)];
    if (f.meta && f.meta.mediaType) bits.push(f.meta.mediaType);
    row.appendChild(h('div', { class: 'tf-file-meta', text: bits.join(' | ') }));
    if (f.state === 'uploading') {
      row.appendChild(h('div', { class: 'tf-file-meta tf-file-state', text: 'Uploading...' }));
      const bar = h('progress', { class: 'tf-progress', attrs: { max: '1', value: String(f.progress || 0) } });
      row.appendChild(bar);
    } else if (f.state === 'error') {
      row.appendChild(h('div', { class: 'tf-file-meta tf-file-state error', text: 'Not attached: ' + f.error, attrs: { role: 'alert' } }));
    } else {
      row.appendChild(h('div', { class: 'tf-file-meta tf-file-state ok', text: 'Uploaded' }));
      const ex = f.meta && f.meta.extraction;
      row.appendChild(h('div', { class: 'tf-file-meta', text: extractionWording(ex) }));
      if (f.meta && f.meta.extractionTruncated) {
        row.appendChild(h('div', { class: 'tf-file-meta', text: 'Full file stored; only the first 100,000 characters will be available to agents' }));
      }
    }
    box.appendChild(row);
  });
}

function removeFile(key) {
  tf.files = tf.files.filter(f => f.key !== key);
  renderFormFiles();
  updateSaveState();
}

// --- Build, validate, send ---
function collectFormBody() {
  const references = {};
  TF_REF_FIELDS.forEach(f => { references[f.key] = splitLines(tfEl(f.id).value); });
  const spec = tfEl('ticket-role').value;
  return {
    title: tfEl('ticket-title-input').value.trim(),
    description: tfEl('ticket-desc-input').value,
    criteria: splitLines(tfEl('ticket-ac-input').value),
    priority: tfEl('ticket-priority').value,
    requestedSpecialty: spec === '' ? null : spec,
    references,
    artifactIds: tf.files.filter(f => f.state === 'ok' && f.id).map(f => f.id)
  };
}

function setFieldError(field, message) {
  const base = String(field || '').replace(/\[\d+\]/g, '');
  const candidates = [base, base.split('.')[0]];
  for (const c of candidates) {
    const el = document.getElementById('err-' + c);
    if (el) { el.textContent += (el.textContent ? '\n' : '') + message; return el; }
  }
  const other = tfEl('err-other');
  other.textContent += (other.textContent ? '\n' : '') + (field ? field + ': ' : '') + message;
  return other;
}

function validateFormBody(body) {
  const problems = [];
  if (!body.title) problems.push(['title', 'Title is required']);
  if (body.title.length > TF_TITLE_MAX) problems.push(['title', 'Title must be at most ' + TF_TITLE_MAX + ' characters']);
  if (body.description.length > TF_DESC_MAX) problems.push(['description', 'Description must be at most ' + TF_DESC_MAX + ' characters']);
  if (body.criteria.length > TF_CRITERIA_MAX_ITEMS) problems.push(['criteria', 'At most ' + TF_CRITERIA_MAX_ITEMS + ' criteria']);
  if (body.criteria.join('\n').length > TF_CRITERIA_MAX_CHARS) problems.push(['criteria', 'Criteria are limited to ' + TF_CRITERIA_MAX_CHARS + ' characters combined']);
  TF_REF_FIELDS.forEach(f => {
    const list = body.references[f.key];
    if (list.length > TF_REF_MAX_ITEMS) problems.push(['references.' + f.key, 'At most ' + TF_REF_MAX_ITEMS + ' entries']);
    if (list.some(v => v.length > TF_REF_MAX_CHARS)) problems.push(['references.' + f.key, 'Each entry must be at most ' + TF_REF_MAX_CHARS + ' characters']);
  });
  return problems;
}

async function reloadTicketForEdit() {
  if (!tf.ticketId) return;
  const id = tf.ticketId;
  try {
    const detail = await apiGet('/tickets/' + encodeURIComponent(id));
    openTicketForm({ mode: 'edit', detail });
  } catch (err) {
    showFormBanner('Could not reload the ticket: ' + err.message, false);
  }
}

async function submitTicketForm(ev) {
  ev.preventDefault();
  if (tf.saving || uploadsBusy()) return;
  clearFormErrors();
  const body = collectFormBody();
  const problems = validateFormBody(body);
  if (problems.length) {
    problems.forEach(p => setFieldError(p[0], p[1]));
    return;
  }
  const edit = tf.mode === 'edit';
  const payloadKey = JSON.stringify(body);
  // Same payload after an uncertain failure keeps the commandId (idempotent retry); a changed payload is a new command.
  if (tf.lastPayload !== null && tf.lastPayload !== payloadKey) tf.commandId = newCommandId();
  tf.lastPayload = payloadKey;
  const command = Object.assign({ commandId: tf.commandId }, body);
  if (edit) command.expectedVersion = tf.expectedVersion;

  const session = tf.session;
  tf.saving = true;
  updateSaveState();
  try {
    const path = edit ? '/tickets/' + encodeURIComponent(tf.ticketId) + '/revisions' : '/tickets';
    const result = await apiPost(path, command);
    if (session !== tf.session) return;
    const ticketId = result && result.ticket ? result.ticket.ticketId : tf.ticketId;
    closeTicketForm();
    Poller.trigger();
    if (edit) openTicketRecord(ticketId);
  } catch (err) {
    if (session !== tf.session) return;
    if (err instanceof ApiError && err.status === 0) {
      showFormBanner('Cannot reach the orchestrator. Press save again to retry; the same request will not be applied twice.', false);
    } else if (err instanceof ApiError && err.code === 'stale_version') {
      tf.lastPayload = null;
      showFormBanner('This ticket changed since you opened it', true);
    } else if (err instanceof ApiError && err.code === 'invalid_request') {
      tf.lastPayload = null;
      const details = Array.isArray(err.details) ? err.details : [];
      if (!details.length) showFormBanner(err.message, false);
      details.forEach(d => setFieldError(d.field, d.message || 'Invalid value'));
      if (details.length) showFormBanner('Some fields need attention: ' + err.message, false);
    } else {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) tf.lastPayload = null;
      showFormBanner((err && err.message ? err.message : 'Save failed') + (err && err.code ? ' (' + err.code + ')' : ''), false);
    }
  } finally {
    if (session === tf.session) {
      tf.saving = false;
      updateSaveState();
    }
  }
}

function initTicketFormEvents() {
  const form = tfEl('form-add-ticket');
  if (!form) return;
  form.addEventListener('submit', submitTicketForm);
  tfEl('ticket-title-input').addEventListener('input', () => { updateTitleCounter(); updateSaveState(); });
  tfEl('btn-ticket-form-close').addEventListener('click', closeTicketForm);
  tfEl('btn-ticket-form-cancel').addEventListener('click', closeTicketForm);
  tfEl('tf-reload').addEventListener('click', reloadTicketForEdit);
  const input = tfEl('ticket-attachments-input');
  tfEl('btn-browse-attachments').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  const zone = tfEl('ticket-dropzone');
  ['dragenter', 'dragover'].forEach(n => zone.addEventListener(n, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(n => zone.addEventListener(n, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  // A stray drop outside the zone must not navigate away from the dashboard.
  ['dragover', 'drop'].forEach(n => tfEl('modal-add-ticket').addEventListener(n, (e) => e.preventDefault()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFormOpen() && !tf.saving) closeTicketForm();
  });
}
