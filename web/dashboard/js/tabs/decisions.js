// --- DECISIONS TAB (version-bound reviews and pending actions) ---

var decisionsView = {
  loaded: false,
  available: null,
  error: null,
  pending: [],
  responses: [],
  findingsDrafts: Object.create(null),
  actionErrors: {},
  commandIds: {},
  confirmImpl: function (message) { return window.confirm(message); }
};
var decisionsFieldHelpSequence = 0;

function decisionsFieldHelp(text) {
  var id = 'decisions-field-help-' + (++decisionsFieldHelpSequence);
  return {
    id: id,
    node: h('span', { class: 'field-help', text: text, attrs: { id: id } })
  };
}

function decisionsDisplay(value, fallback) {
  return value ? String(value) : (fallback || 'unavailable');
}

function decisionsBindingNote(binding, authorized) {
  if (binding === 'stale') return 'Binding stale (not authorized for the current revision).';
  if (binding === 'unavailable') return 'Binding unavailable (not authorized).';
  if (authorized === true) return 'Authorized for the current revision.';
  return 'Not authorized.';
}

function applyDecisionsSnapshot(body) {
  if (!body || body.available !== true) {
    decisionsView.available = false;
    decisionsView.error = (body && body.reason) || 'Decisions are unavailable';
    decisionsView.pending = [];
    decisionsView.responses = [];
  } else {
    decisionsView.available = true;
    decisionsView.error = null;
    decisionsView.pending = Array.isArray(body.pending) ? body.pending : [];
    decisionsView.responses = Array.isArray(body.responses) ? body.responses : [];
    pruneFindingsDrafts(decisionsView.pending);
  }
  decisionsView.loaded = true;
  renderDecisionsAndEscalations();
}

function pruneFindingsDrafts(items) {
  var pendingIds = Object.create(null);
  (items || []).forEach(function (item) {
    if (item && item.id !== undefined && item.id !== null) pendingIds[String(item.id)] = true;
  });
  Object.keys(decisionsView.findingsDrafts).forEach(function (id) {
    if (!pendingIds[id]) delete decisionsView.findingsDrafts[id];
  });
}

function findFindingsInput(container, itemId) {
  if (!container || !container.querySelectorAll) return null;
  var inputs = container.querySelectorAll('textarea.decisions-findings');
  for (var i = 0; i < inputs.length; i += 1) {
    if (inputs[i].getAttribute('data-id') === String(itemId)) return inputs[i];
  }
  return null;
}

function captureFindingsFocus() {
  var active = document.activeElement;
  if (!active || String(active.tagName || '').toLowerCase() !== 'textarea'
    || !/(^|\s)decisions-findings(\s|$)/.test(active.className || '')) return null;
  return {
    id: active.getAttribute('data-id'),
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
    selectionDirection: active.selectionDirection
  };
}

function restoreFindingsFocus(container, focusState) {
  if (!focusState || focusState.id === null) return;
  var input = findFindingsInput(container, focusState.id);
  if (!input) return;
  input.focus();
  if (typeof input.setSelectionRange === 'function'
    && Number.isInteger(focusState.selectionStart) && Number.isInteger(focusState.selectionEnd)) {
    input.setSelectionRange(focusState.selectionStart, focusState.selectionEnd, focusState.selectionDirection || 'none');
  }
}

function renderDecisionsList(container, items, emptyText, buildCard) {
  if (!container) return;
  container.textContent = '';
  if (!decisionsView.available) {
    container.appendChild(h('div', { class: 'empty-state', text: 'Decisions unavailable: ' + (decisionsView.error || 'unknown') }));
    return;
  }
  if (!items.length) {
    container.appendChild(h('div', { class: 'empty-state', text: emptyText }));
    return;
  }
  items.forEach(function (item) { container.appendChild(buildCard(item)); });
}

function reviewMetaLines(item) {
  return [
    'Ticket: ' + decisionsDisplay(item.ticketId),
    'Run: ' + decisionsDisplay(item.runId),
    'Revision: ' + decisionsDisplay(item.revisionId),
    'Plan revision: ' + decisionsDisplay(item.planRevisionId),
    'Candidate: ' + decisionsDisplay(item.candidateId),
    'Integrity hash: ' + decisionsDisplay(item.integrityHash),
    decisionsBindingNote(item.binding, item.authorized)
  ];
}

function pendingReviewCard(item) {
  if (item.kind === 'intake_clarification' || item.kind === 'lead_decision') return pendingRunDecisionCard(item);
  var err = decisionsView.actionErrors[item.id] || '';
  var actions = [];
  if (item.actionable) {
    actions.push(h('button', { class: 'btn btn-secondary btn-sm', text: 'Accept', attrs: { type: 'button', 'data-action': 'accept', 'data-id': item.id } }));
    actions.push(h('button', { class: 'btn btn-secondary btn-sm', text: 'Request corrections', attrs: { type: 'button', 'data-action': 'corrections', 'data-id': item.id } }));
  }
  var findingsHelp = decisionsFieldHelp('Required when requesting corrections. Describe the specific changes needed so the next attempt can address them.');
  var findingsInput = h('textarea', { class: 'decisions-findings', attrs: { rows: '3', placeholder: 'Findings (required for corrections)', 'data-id': item.id, 'aria-describedby': findingsHelp.id } });
  findingsInput.value = Object.prototype.hasOwnProperty.call(decisionsView.findingsDrafts, String(item.id))
    ? decisionsView.findingsDrafts[String(item.id)] : '';
  findingsInput.addEventListener('input', function () {
    decisionsView.findingsDrafts[String(item.id)] = findingsInput.value;
  });
  var children = [
    h('div', { class: 'decisions-card-title', text: item.ticketTitle || 'unavailable' }),
    h('div', { class: 'decisions-card-meta', text: reviewMetaLines(item).join(' | ') })
  ];
  if (item.kind === 'operator_command') {
    children.push(h('div', { class: 'decisions-card-command', text: 'Operator command: ' + decisionsDisplay(item.command) + ' (display only)' }));
  }
  if (actions.length) {
    children.push(h('div', { class: 'decisions-card-actions' }, actions));
    children.push(findingsInput);
    children.push(findingsHelp.node);
  }
  if (err) children.push(h('div', { class: 'decisions-action-error', text: err }));
  return h('div', { class: 'adr-card decisions-card', attrs: { 'data-id': item.id } }, children);
}

function responseCard(item) {
  if (item.kind === 'intake_clarification' || item.kind === 'lead_decision') return answeredRunDecisionCard(item);
  var lines = reviewMetaLines(item);
  if (item.verdict) lines.push('Verdict: ' + item.verdict);
  if (item.findings) lines.push('Findings: ' + item.findings);
  return h('div', { class: 'adr-card decisions-card', attrs: { 'data-id': item.id } }, [
    h('div', { class: 'decisions-card-title', text: item.ticketTitle || 'unavailable' }),
    h('div', { class: 'decisions-card-meta', text: lines.join(' | ') })
  ]);
}

function decisionKindLabel(item) {
  return item.kind === 'intake_clarification' ? 'PM clarification' : 'Decision needed';
}

function decisionCardMeta(item) {
  return [
    'Ticket: ' + decisionsDisplay(item.ticketId),
    'Run: ' + decisionsDisplay(item.runId),
    'Revision: ' + decisionsDisplay(item.revisionId),
    'Plan revision: ' + decisionsDisplay(item.planRevisionId),
    'Ticket version: ' + decisionsDisplay(item.expectedVersion),
    (item.binding === 'current' ? 'Bound to the current ticket revision.' : item.binding === 'stale' ? 'Binding stale; display only.' : 'Binding unavailable; display only.')
  ].join(' | ');
}

function pendingRunDecisionCard(item) {
  var children = [
    h('div', { class: 'decisions-card-title', text: decisionKindLabel(item) + ': ' + (item.ticketTitle || 'unavailable') }),
    h('div', { class: 'decisions-card-meta', text: decisionCardMeta(item) })
  ];
  var err = decisionsView.actionErrors[item.id] || '';
  var request = item.request || {};
  if (item.kind === 'intake_clarification') {
    var answers = [];
    (Array.isArray(request.questions) ? request.questions : []).forEach(function (question) {
      children.push(h('div', { class: 'decisions-question', text: question.question || 'Question unavailable' }));
      if (question.why) children.push(h('div', { class: 'decisions-card-meta', text: 'Why it matters: ' + question.why }));
      if (item.actionable) {
        var answerHelp = decisionsFieldHelp('Enter an answer between 1 and 4000 characters.');
        var area = h('textarea', { class: 'decisions-answer', attrs: { rows: '2', maxlength: '4000', 'aria-label': 'Answer: ' + (question.question || 'Question unavailable'), 'aria-describedby': answerHelp.id } });
        children.push(area);
        children.push(answerHelp.node);
        answers.push({ questionId: question.id, area: area });
      }
    });
    if (!answers.length) children.push(h('div', { class: 'decisions-card-meta', text: 'No questions were recorded.' }));
    if (item.actionable && answers.length) {
      children.push(h('button', { class: 'btn btn-secondary btn-sm', text: 'Answer questions', attrs: { type: 'button' }, on: { click: function () {
        var payload = { answers: answers.map(function (entry) { return { questionId: entry.questionId, answer: String(entry.area.value || '').trim() }; }) };
        if (payload.answers.some(function (entry) { return !entry.answer || entry.answer.length > 4000; })) {
          decisionsView.actionErrors[item.id] = 'Every answer must contain 1 to 4000 characters.';
          renderDecisionsAndEscalations();
          return;
        }
        submitRunDecision(item, payload);
      } } }));
    }
  } else {
    children.push(h('div', { class: 'decisions-question', text: request.question || 'Question unavailable' }));
    if (request.reason) children.push(h('div', { class: 'decisions-card-meta', text: 'Reason: ' + request.reason }));
    var choice = null;
    var choiceHelp = decisionsFieldHelp('Choose one option to submit this decision.');
    var choiceGroup = h('div', { class: 'decisions-options', attrs: { role: 'radiogroup', 'aria-label': 'Decision options', 'aria-describedby': choiceHelp.id } });
    (Array.isArray(request.options) ? request.options : []).forEach(function (option) {
      if (item.actionable) {
        var radio = h('input', { attrs: { type: 'radio', name: 'decision-' + cssToken(item.decisionId), value: String(option.id) }, on: { change: function () { choice = option.id; } } });
        choiceGroup.appendChild(h('label', { class: 'decisions-option' }, [
          radio,
          h('span', { text: String(option.id || 'Option') + (option.description ? ': ' + option.description : '') })
        ]));
      } else {
        children.push(h('div', { class: 'decisions-question', text: String(option.id || 'Option') + (option.description ? ': ' + option.description : '') }));
      }
    });
    if (item.actionable) { children.push(choiceGroup); children.push(choiceHelp.node); }
    var note = null;
    if (item.actionable) {
      var noteHelp = decisionsFieldHelp('Optional context, up to 8000 characters. Leave blank to use the selected option as the answer.');
      note = h('textarea', { class: 'decisions-answer', attrs: { rows: '2', maxlength: '8000', placeholder: 'Note (optional)', 'aria-label': 'Optional note for decision: ' + (request.question || 'Question unavailable'), 'aria-describedby': noteHelp.id } });
      children.push(note);
      children.push(noteHelp.node);
    }
    if (item.actionable && Array.isArray(request.options) && request.options.length) {
      children.push(h('button', { class: 'btn btn-secondary btn-sm', text: 'Send decision', attrs: { type: 'button' }, on: { click: function () {
        var option = request.options.find(function (entry) { return entry.id === choice; });
        var text = String(note.value || '').trim();
        if (!option || text.length > 8000) {
          decisionsView.actionErrors[item.id] = !option ? 'Pick an option to continue.' : 'The note is limited to 8000 characters.';
          renderDecisionsAndEscalations();
          return;
        }
        var answer = text || ('Selected option ' + option.id + ': ' + (option.description || '')).slice(0, 8000);
        submitRunDecision(item, { choice: option.id, answer: answer });
      } } }));
    }
  }
  if (!item.actionable) children.push(h('div', { class: 'decisions-card-meta', text: 'Display only; this decision is not current for the ticket revision.' }));
  if (err) children.push(h('div', { class: 'decisions-action-error', text: err, attrs: { role: 'alert' } }));
  return h('div', { class: 'adr-card decisions-card', attrs: { 'data-id': item.id } }, children);
}

function answeredRunDecisionCard(item) {
  var children = [
    h('div', { class: 'decisions-card-title', text: decisionKindLabel(item) + ': ' + (item.ticketTitle || 'unavailable') }),
    h('div', { class: 'decisions-card-meta', text: decisionCardMeta(item) })
  ];
  var request = item.request || {};
  var answer = item.answer || {};
  if (item.kind === 'intake_clarification') {
    (Array.isArray(request.questions) ? request.questions : []).forEach(function (question) {
      var entry = (Array.isArray(answer.answers) ? answer.answers : []).find(function (a) { return a.questionId === question.id; });
      children.push(h('div', { class: 'decisions-question', text: question.question || 'Question unavailable' }));
      children.push(h('div', { class: 'decisions-card-meta', text: entry ? entry.answer : '(no answer recorded)' }));
    });
  } else {
    children.push(h('div', { class: 'decisions-question', text: request.question || 'Question unavailable' }));
    if (answer.choice) children.push(h('div', { class: 'decisions-card-meta', text: 'Chosen: ' + answer.choice }));
    if (answer.answer) children.push(h('div', { class: 'decisions-card-meta', text: 'Answer: ' + answer.answer }));
  }
  if (item.state === 'stale') children.push(h('div', { class: 'decisions-card-meta', text: 'Superseded; display only.' }));
  return h('div', { class: 'adr-card decisions-card', attrs: { 'data-id': item.id } }, children);
}

function decisionsAnswerCommandId(item, payload) {
  var key = item.id + ':answer:' + String(item.expectedVersion) + ':' + JSON.stringify(payload);
  if (!decisionsView.commandIds[key]) decisionsView.commandIds[key] = typeof newCommandId === 'function' ? newCommandId() : ('cmd-' + Math.random().toString(36).slice(2));
  return decisionsView.commandIds[key];
}

async function submitRunDecision(item, payload) {
  if (!item || !item.actionable || item.binding !== 'current' || !item.ticketId || !item.runId
    || !item.revisionId || !item.decisionId || !Number.isInteger(item.expectedVersion)) return;
  decisionsView.actionErrors[item.id] = '';
  renderDecisionsAndEscalations();
  try {
    await apiPost('/tickets/' + encodeURIComponent(item.ticketId) + '/decisions/' + encodeURIComponent(item.decisionId) + '/answer', Object.assign({
      commandId: decisionsAnswerCommandId(item, payload), expectedVersion: item.expectedVersion
    }, payload));
    delete decisionsView.actionErrors[item.id];
    if (typeof Poller !== 'undefined' && Poller && typeof Poller.trigger === 'function') await Poller.trigger();
  } catch (err) {
    decisionsView.actionErrors[item.id] = (err && err.message) || 'Decision answer failed';
    if (typeof Poller !== 'undefined' && Poller && typeof Poller.trigger === 'function') await Poller.trigger();
    renderDecisionsAndEscalations();
  }
}

function renderDecisionsAndEscalations() {
  var focusState = captureFindingsFocus();
  var adrList = document.getElementById('adr-list');
  var adrCount = document.getElementById('adr-count');
  var escList = document.getElementById('escalation-list');
  var escCount = document.getElementById('escalation-count');
  if (adrCount) adrCount.textContent = decisionsView.available ? (decisionsView.responses.length + ' records') : 'unavailable';
  renderDecisionsList(adrList, decisionsView.responses, 'No answered decisions or reviews.', responseCard);
  if (escCount) escCount.textContent = decisionsView.available ? (decisionsView.pending.length + ' pending') : 'unavailable';
  renderDecisionsList(escList, decisionsView.pending, 'No pending actions.', pendingReviewCard);
  restoreFindingsFocus(escList, focusState);
}

function decisionsCommandIdKey(item, verdict) {
  return item.id + ':' + verdict + ':' + String(item.expectedVersion);
}

function decisionsNextCommandId(item, verdict) {
  var key = decisionsCommandIdKey(item, verdict);
  if (!decisionsView.commandIds[key]) {
    decisionsView.commandIds[key] = typeof newCommandId === 'function' ? newCommandId() : ('cmd-' + Math.random().toString(36).slice(2));
  }
  return decisionsView.commandIds[key];
}

async function submitReviewDecision(item, verdict, findings) {
  var body = {
    commandId: decisionsNextCommandId(item, verdict),
    expectedVersion: item.expectedVersion,
    runId: item.runId,
    candidateId: item.candidateId,
    integrityHash: item.integrityHash,
    verdict: verdict
  };
  if (verdict === 'corrections') body.findings = findings;
  await apiPost('/tickets/' + encodeURIComponent(item.ticketId) + '/review', body);
}

async function handleDecisionsAction(action, itemId) {
  var item = decisionsView.pending.find(function (p) { return p.id === itemId; });
  if (!item || !item.actionable) return;
  decisionsView.actionErrors[itemId] = '';
  try {
    if (action === 'accept') {
      if (!decisionsView.confirmImpl('Accept this candidate for ticket ' + item.ticketId + '?')) return;
      await submitReviewDecision(item, 'accept', null);
      delete decisionsView.findingsDrafts[String(itemId)];
    } else if (action === 'corrections') {
      var area = findFindingsInput(document.getElementById('escalation-list'), itemId);
      var findings = area && area.value ? String(area.value).trim() : '';
      if (!findings) {
        decisionsView.actionErrors[itemId] = 'Findings are required for corrections.';
        renderDecisionsAndEscalations();
        return;
      }
      await submitReviewDecision(item, 'corrections', findings);
      delete decisionsView.findingsDrafts[String(itemId)];
    }
    delete decisionsView.actionErrors[itemId];
    renderDecisionsAndEscalations();
    if (typeof Poller !== 'undefined' && Poller && typeof Poller.trigger === 'function') await Poller.trigger();
  } catch (err) {
    decisionsView.actionErrors[itemId] = (err && err.message) || 'Review request failed';
    renderDecisionsAndEscalations();
  }
}

async function refreshDecisionsIfVisible(signal) {
  if (typeof state === 'undefined' || state.activeTab !== 'tab-decisions') return;
  try {
    var body = await apiGet('/decisions', { signal: signal });
    applyDecisionsSnapshot(body);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    decisionsView.loaded = true;
    decisionsView.available = false;
    decisionsView.error = (err && err.message) || 'Decisions are unavailable';
    renderDecisionsAndEscalations();
    throw err;
  }
}

function initDecisionsEvents() {
  var escList = document.getElementById('escalation-list');
  var onClick = function (event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!btn) return;
    handleDecisionsAction(btn.getAttribute('data-action'), btn.getAttribute('data-id'));
  };
  if (escList) escList.addEventListener('click', onClick);
  var tabButtons = document.querySelectorAll('[data-tab="tab-decisions"], [data-tab=tab-decisions]');
  for (var i = 0; i < tabButtons.length; i += 1) {
    tabButtons[i].addEventListener('click', function () {
      if (typeof Poller !== 'undefined' && Poller && typeof Poller.trigger === 'function') Poller.trigger();
    });
  }
  renderDecisionsAndEscalations();
}
