// --- DOCS TAB ---

var docsView = {
  loaded: false,
  available: null,
  error: null,
  documents: [],
  selectedId: null,
  rawView: false
};

function applyDocsSnapshot(body) {
  if (!body || body.available !== true) {
    docsView.available = false;
    docsView.error = (body && body.reason) || 'Docs are unavailable';
    docsView.documents = [];
  } else {
    docsView.available = true;
    docsView.error = null;
    docsView.documents = Array.isArray(body.documents) ? body.documents : [];
    if (docsView.selectedId && !docsView.documents.some(function (d) { return d.id === docsView.selectedId; })) {
      docsView.selectedId = null;
    }
    if (!docsView.selectedId && docsView.documents.length) docsView.selectedId = docsView.documents[0].id;
  }
  docsView.loaded = true;
  renderDocs();
}

function selectedDoc() {
  if (!docsView.selectedId) return null;
  return docsView.documents.find(function (d) { return d.id === docsView.selectedId; }) || null;
}

function renderDocsList() {
  var docsList = document.getElementById('docs-list');
  if (!docsList) return;
  docsList.textContent = '';
  if (!docsView.available) {
    docsList.appendChild(h('div', { class: 'empty-state', text: 'Docs unavailable: ' + (docsView.error || 'unknown') }));
    return;
  }
  if (!docsView.documents.length) {
    docsList.appendChild(h('div', { class: 'empty-state', text: 'No documents available.' }));
    return;
  }
  docsView.documents.forEach(function (doc) {
    var label = doc.title + ' (' + doc.source + ', ' + doc.status + ')';
    var item = h('div', {
      class: 'doc-item' + (doc.id === docsView.selectedId ? ' active' : ''),
      text: label,
      attrs: { 'data-id': doc.id, role: 'button', tabindex: '0' }
    });
    item.addEventListener('click', function () {
      docsView.selectedId = doc.id;
      renderDocs();
    });
    docsList.appendChild(item);
  });
}

function renderDocViewer() {
  var docTitleEl = document.getElementById('active-doc-title');
  var viewer = document.getElementById('doc-viewer-content');
  var copyStatus = document.getElementById('doc-copy-status');
  var doc = selectedDoc();
  if (copyStatus && !copyStatus.textContent) copyStatus.textContent = '';
  if (docTitleEl) docTitleEl.textContent = doc ? doc.title : 'Document Viewer';
  if (!viewer) return;
  viewer.textContent = '';
  if (!doc) {
    viewer.appendChild(h('div', { class: 'empty-state', text: docsView.available ? 'Select a document.' : 'Docs unavailable.' }));
    return;
  }
  if (doc.status === 'unavailable' || doc.content == null) {
    viewer.appendChild(h('div', { class: 'empty-state', text: 'Unavailable: ' + (doc.reason || 'cannot read document') }));
    return;
  }
  if (doc.status === 'truncated' || doc.truncated) {
    viewer.appendChild(h('div', { class: 'doc-truncated-note', text: 'Content truncated at server limit.' }));
  }
  if (docsView.rawView || doc.format !== 'markdown') {
    viewer.appendChild(h('pre', { text: doc.content }));
  } else if (typeof renderMarkdown === 'function') {
    var rendered = document.createElement('div');
    rendered.className = 'doc-rendered';
    rendered.innerHTML = renderMarkdown(doc.content);
    viewer.appendChild(rendered);
  } else {
    viewer.appendChild(h('pre', { text: doc.content }));
  }
}

function renderDocs() {
  renderDocsList();
  renderDocViewer();
}

async function refreshDocsIfVisible(signal) {
  if (typeof state === 'undefined' || state.activeTab !== 'tab-docs') return;
  try {
    var body = await apiGet('/docs', { signal: signal });
    applyDocsSnapshot(body);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    docsView.loaded = true;
    docsView.available = false;
    docsView.error = (err && err.message) || 'Docs are unavailable';
    renderDocs();
    throw err;
  }
}

function initDocsEvents() {
  var btnToggleRaw = document.getElementById('btn-toggle-raw');
  var btnCopyDoc = document.getElementById('btn-copy-doc');
  if (btnToggleRaw) {
    btnToggleRaw.addEventListener('click', function () {
      docsView.rawView = !docsView.rawView;
      renderDocViewer();
    });
  }
  if (btnCopyDoc) {
    btnCopyDoc.addEventListener('click', function () {
      var status = document.getElementById('doc-copy-status');
      var doc = selectedDoc();
      if (!doc || doc.content == null) {
        if (status) status.textContent = 'Nothing to copy.';
        return;
      }
      navigator.clipboard.writeText(doc.content).then(function () {
        if (status) status.textContent = 'Copied to clipboard.';
      }).catch(function () {
        if (status) status.textContent = 'Copy failed.';
      });
    });
  }
  var tabButtons = document.querySelectorAll('[data-tab="tab-docs"], [data-tab=tab-docs]');
  for (var i = 0; i < tabButtons.length; i += 1) {
    tabButtons[i].addEventListener('click', function () {
      if (typeof Poller !== 'undefined' && Poller && typeof Poller.trigger === 'function') Poller.trigger();
    });
  }
  renderDocs();
}
