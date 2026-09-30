// --- DOCS TAB ---
function renderDocs() {
  const docsList = document.getElementById('docs-list');
  if (!docsList) return;

  docsList.innerHTML = state.docs.map(doc => `
    <div class="doc-item ${doc.id === state.selectedDocId ? 'active' : ''}" data-id="${doc.id}">
      <span>#</span>
      <span>${doc.title}</span>
    </div>
  `).join('');

  docsList.querySelectorAll('.doc-item').forEach(item => {
    item.addEventListener('click', () => {
      state.selectedDocId = item.dataset.id;
      renderDocs();
    });
  });

  const activeDoc = state.docs.find(d => d.id === state.selectedDocId) || state.docs[0];
  const docTitleEl = document.getElementById('active-doc-title');
  const viewer = document.getElementById('doc-viewer-content');

  if (docTitleEl && activeDoc) {
    docTitleEl.textContent = activeDoc.title;
  }

  if (viewer && activeDoc) {
    if (state.docRawView) {
      viewer.innerHTML = `<pre>${escapeHtml(activeDoc.content)}</pre>`;
    } else {
      viewer.innerHTML = renderMarkdown(activeDoc.content);
    }
  }
}

function initDocsEvents() {
  const btnToggleRaw = document.getElementById('btn-toggle-raw');
  const btnCopyDoc = document.getElementById('btn-copy-doc');

  if (btnToggleRaw) {
    btnToggleRaw.addEventListener('click', () => {
      state.docRawView = !state.docRawView;
      renderDocs();
    });
  }

  if (btnCopyDoc) {
    btnCopyDoc.addEventListener('click', () => {
      const activeDoc = state.docs.find(d => d.id === state.selectedDocId);
      if (activeDoc) {
        navigator.clipboard.writeText(activeDoc.content);
        alert("Document copied to clipboard.");
      }
    });
  }
}
