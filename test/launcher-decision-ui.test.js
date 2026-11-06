'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'app.js'), 'utf8');

function functionSource(name) {
  const start = APP_SRC.search(new RegExp('^ {4}(?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, 'function ' + name + ' not found in app.js');
  const end = APP_SRC.indexOf('\n    }\n', start);
  assert.notEqual(end, -1, 'end of function ' + name + ' not found');
  return APP_SRC.slice(start, end + '\n    }\n'.length);
}

function element() {
  const classes = new Set();
  const node = {
    value: '',
    disabled: false,
    children: [],
    attributes: {},
    _textContent: '',
    get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { this._textContent = String(value); this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    querySelector(selector) { return selector === 'input' ? this.children.find((child) => child.type === 'radio') || null : null; },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
  };
  return node;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness() {
  const elements = Object.fromEntries([
    'decisionAnswer', 'decisionId', 'decisionSubmit', 'decisionCard', 'sendError',
    'decisionReasonRow', 'decisionReason', 'decisionQuestion', 'decisionIdText', 'decisionIdRow',
    'decisionOptionsBlock', 'decisionOptionsList', 'decisionIndependentRow', 'decisionIndependent',
    'decisionEvidence', 'decisionEvidenceCount', 'decisionEvidenceList',
  ].map((id) => [id, element()]));
  const calls = [];
  const request = deferred();
  const pause = { kind: 'error', decisionId: 'decision-1', message: 'Delivery is fenced.' };
  const context = {
    currentProjectId: 'project-a',
    currentSessionId: 'session-a',
    serverRunning: true,
    sessionData: { turns: [{ leadTask: { id: 'task-a', state: 'TASK_STATE_INPUT_REQUIRED', metadata: { pause } } }] },
    sending: false,
    sendingRequest: null,
    a2aRequestEpoch: 0,
    decisionSubmitting: false,
    decisionSubmitOwner: null,
    decisionCardKey: JSON.stringify(['task-a', 'error', 'decision-1', '', pause.message]),
    decisionOptionIds: ['keep', 'change'],
    selectedDecisionOption: 'keep',
    DECISION_LABELS: { infeasible_requirement: 'Infeasible requirement' },
    pendingTurn: null,
    document: {
      getElementById(id) { return elements[id] || (elements[id] = element()); },
      createElement(tag) { const node = element(); node.tagName = tag.toUpperCase(); return node; },
      querySelectorAll(selector) {
        return selector === '#decisionOptionsList .decision-option'
          ? elements.decisionOptionsList.children : [];
      },
    },
    projectUrl(endpoint) { return '/api/projects/' + context.currentProjectId + endpoint; },
    fetch(url, init) { calls.push({ url, init }); return request.promise; },
    showNotice(id, message) { elements[id].textContent = message; elements[id].classList.remove('hidden'); },
    renderTranscript() { context.updateDecisionCard(); },
    async pollSession() {
      if (context.pollState) context.sessionData.turns.at(-1).leadTask.state = context.pollState;
      context.updateDecisionCard();
    },
    async loadSessions() {},
    setSession(id) {
      if (id !== context.currentSessionId) {
        context.a2aRequestEpoch += 1;
        context.sending = false;
        context.sendingRequest = null;
        context.decisionSubmitting = false;
        context.decisionSubmitOwner = null;
      }
      context.currentSessionId = id;
      context.pendingTurn = null;
      context.sessionData = null;
    },
  };
  elements.decisionAnswer.value = 'Please continue after checking the provider.';
  elements.decisionId.value = 'decision-1';

  vm.createContext(context);
  vm.runInContext([
    functionSource('lastTurn'),
    functionSource('isPausedState'),
    functionSource('textEl'),
    functionSource('decisionLabel'),
    functionSource('renderDecisionCard'),
    functionSource('updateDecisionControls'),
    functionSource('updateDecisionCard'),
    functionSource('selectOption'),
    functionSource('decisionScopeMatches'),
    functionSource('isErrorPausedTask'),
    functionSource('submitDecision'),
    functionSource('executeA2A'),
    functionSource('extractParts'),
  ].join('\n'), context);
  return { context, elements, calls, request };
}

function response(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return { ok, status, statusText, json: async () => body };
}

const failures = [
  {
    name: 'network failure',
    settle(request) { request.reject(new Error('socket hang up')); },
    message: 'socket hang up',
  },
  {
    name: 'HTTP error response',
    settle(request) { request.resolve(response({ success: false, error: 'Concurrent delivery is unavailable.' }, { ok: false, status: 503 })); },
    message: 'Concurrent delivery is unavailable.',
  },
  {
    name: 'application failure response',
    settle(request) { request.resolve(response({ success: false, error: 'delivery_engine_unsafe' })); },
    message: 'delivery_engine_unsafe',
  },
  {
    name: 'A2A task still paused on error',
    settle(request) {
      request.resolve(response({ success: true, result: {
        status: { state: 'TASK_STATE_INPUT_REQUIRED' },
        metadata: { pause: { kind: 'error', message: 'Delivery is fenced by unresolved workspace effects.' } },
      } }));
    },
    message: 'Delivery is fenced by unresolved workspace effects.',
  },
  {
    name: 'A2A error pause without a pause message',
    settle(request) {
      request.resolve(response({ success: true, result: {
        status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [{ content: { $case: 'text', value: 'The planner could not resume this task.' } }] } },
        metadata: { pause: { kind: 'error' } },
      } }));
    },
    message: 'The planner could not resume this task.',
  },
];

for (const failure of failures) {
  test(`decision submit preserves its draft after ${failure.name}`, async () => {
    const harness = createHarness();
    const { context, elements, calls, request } = harness;
    const submission = context.submitDecision();
    const duplicate = await context.submitDecision();

    assert.equal(duplicate, undefined);
    assert.equal(calls.length, 1, 'a pending decision sends only once');
    assert.equal(calls[0].url, '/api/projects/project-a/task/send');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      goal: 'Please continue after checking the provider.',
      taskId: 'task-a',
      decision: 'decision-1',
      choice: 'keep',
    });

    failure.settle(request);
    const outcome = await submission;
    assert.equal(outcome.ok, false);
    assert.equal(elements.decisionAnswer.value, 'Please continue after checking the provider.');
    assert.equal(context.selectedDecisionOption, 'keep');
    assert.equal(elements.sendError.textContent, 'Send failed: ' + failure.message);
    assert.equal(elements.sendError.classList.contains('hidden'), false);
    assert.equal(elements.decisionSubmit.disabled, false);
  });
}

test('decision submit clears only the submitted draft after acknowledged continuation', async () => {
  const harness = createHarness();
  const { context, elements, request } = harness;
  const submission = context.submitDecision();
  context.pollState = 'TASK_STATE_COMPLETED';
  request.resolve(response({ success: true, result: { status: { state: 'TASK_STATE_COMPLETED' } } }));

  const outcome = await submission;
  assert.equal(outcome.ok, true);
  assert.equal(elements.decisionAnswer.value, '');
  assert.equal(context.selectedDecisionOption, '');
  assert.equal(context.sending, false);
  assert.equal(context.decisionSubmitting, false);
});

test('rendered owner decision shows LL-7 evidence and applies the selected option ID in scope', async () => {
  const harness = createHarness();
  const { context, elements, calls, request } = harness;
  const pause = {
    kind: 'owner_decision',
    decisionId: 'decision-ll7',
    reason: 'infeasible_requirement',
    question: 'Which supported recovery path should the team take?',
    recommendation: 'recover',
    options: [
      { id: 'recover', description: 'Use the supported recovery path.' },
      { id: 'defer', description: 'Defer until the missing capability is available.' },
    ],
    evidenceChecked: ['Checked the provider capability matrix.', 'Confirmed the workspace cannot change it.'],
    independentWork: 'The team can document the fallback while waiting.',
  };
  context.sessionData.turns[0].leadTask.metadata.pause = pause;
  context.decisionCardKey = '';
  context.updateDecisionCard();

  assert.equal(elements.decisionCard.classList.contains('hidden'), false);
  assert.equal(elements.decisionReason.textContent, 'Infeasible requirement');
  assert.equal(elements.decisionQuestion.textContent, pause.question);
  assert.equal(elements.decisionIndependent.textContent, pause.independentWork);
  assert.equal(elements.decisionEvidenceCount.textContent, '2');
  assert.deepEqual(elements.decisionEvidenceList.children.map((item) => item.textContent), pause.evidenceChecked);
  const [recommended, other] = elements.decisionOptionsList.children;
  assert.match(recommended.textContent, /recover/);
  assert.match(recommended.textContent, /Recommended/);
  assert.match(recommended.textContent, /Use the supported recovery path\./);
  assert.match(other.textContent, /Defer until the missing capability is available\./);
  assert.equal(elements.decisionSubmit.disabled, true, 'an option is required even when response text exists');

  elements.decisionAnswer.value = 'Owner notes may accompany the choice.';
  context.updateDecisionControls();
  assert.equal(elements.decisionSubmit.disabled, true, 'free text alone cannot choose an option');
  context.selectOption('recover');
  assert.equal(elements.decisionSubmit.disabled, false);
  assert.equal(recommended.querySelector('input').checked, true);
  assert.equal(other.querySelector('input').checked, false);
  assert.equal(context.decisionScopeMatches({ projectId: 'project-a', sessionId: 'session-a', taskId: 'task-a' }), true);
  context.pollState = 'TASK_STATE_COMPLETED';
  const submission = context.submitDecision();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/projects/project-a/task/send');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    goal: 'Owner notes may accompany the choice.',
    taskId: 'task-a',
    decision: 'decision-ll7',
    choice: 'recover',
  });
  request.resolve(response({ success: true, result: { status: { state: 'TASK_STATE_COMPLETED' } } }));
  assert.equal((await submission).ok, true);
});

test('a stopped task is not presented or submitted as a human decision', async () => {
  const harness = createHarness();
  const { context, elements, calls } = harness;
  context.sessionData.turns[0].leadTask.metadata.pause = { kind: 'stopped', message: 'Waiting for safe recovery.' };
  context.updateDecisionCard();

  assert.equal(elements.decisionCard.classList.contains('hidden'), true);
  const result = await context.submitDecision();
  assert.equal(result, undefined);
  assert.deepEqual(calls, []);
});

test('an empty response cannot be converted into an implicit approval', async () => {
  const harness = createHarness();
  const { context, elements, calls } = harness;
  context.decisionOptionIds = [];
  context.selectedDecisionOption = '';
  elements.decisionAnswer.value = '  ';

  const result = await context.submitDecision();
  assert.equal(result.ok, false);
  assert.match(result.error, /Enter a response/);
  assert.deepEqual(calls, []);
});

test('decision submission stays disabled while the project is not task-ready', () => {
  const harness = createHarness();
  const { context, elements } = harness;
  context.serverRunning = false;
  context.updateDecisionControls();
  assert.equal(elements.decisionSubmit.disabled, true);
});

test('decision submit keeps edits made while the request is pending', async () => {
  const harness = createHarness();
  const { context, elements, request } = harness;
  const submission = context.submitDecision();
  elements.decisionAnswer.value = 'New clarification typed while waiting.';
  context.selectOption('change');
  request.resolve(response({ success: true, result: { status: { state: 'TASK_STATE_WORKING' } } }));

  const outcome = await submission;
  assert.equal(outcome.ok, true);
  assert.equal(elements.decisionAnswer.value, 'New clarification typed while waiting.');
  assert.equal(context.selectedDecisionOption, 'change');
});

test('decision submit does not apply an old response to a changed session', async () => {
  const harness = createHarness();
  const { context, elements, request } = harness;
  const submission = context.submitDecision();
  context.currentSessionId = 'session-b';
  elements.decisionAnswer.value = 'Draft for the new session.';
  context.selectedDecisionOption = 'change';
  request.resolve(response({ success: true, result: { status: { state: 'TASK_STATE_COMPLETED' } } }));

  const outcome = await submission;
  assert.equal(outcome.stale, true);
  assert.equal(elements.decisionAnswer.value, 'Draft for the new session.');
  assert.equal(context.selectedDecisionOption, 'change');
  assert.equal(elements.sendError.textContent, '');
});

test('an intermediate working poll preserves the option when the same error pause returns', async () => {
  const harness = createHarness();
  const { context, elements, request } = harness;
  const pauseKey = context.decisionCardKey;
  const task = context.sessionData.turns[0].leadTask;
  const submission = context.submitDecision();

  task.state = 'TASK_STATE_WORKING';
  context.updateDecisionCard();
  assert.equal(context.decisionCardKey, pauseKey);
  assert.equal(context.selectedDecisionOption, 'keep');

  task.state = 'TASK_STATE_INPUT_REQUIRED';
  request.resolve(response({ success: true, result: {
    status: { state: 'TASK_STATE_INPUT_REQUIRED' },
    metadata: { pause: { kind: 'error', decisionId: 'decision-1', message: 'Delivery is fenced.' } },
  } }));
  const outcome = await submission;

  assert.equal(outcome.ok, false);
  assert.equal(context.decisionCardKey, pauseKey);
  assert.equal(context.selectedDecisionOption, 'keep');
  assert.equal(elements.decisionAnswer.value, 'Please continue after checking the provider.');
});

test('a changed decision is rendered after the pending submission settles', async () => {
  const harness = createHarness();
  const { context, elements, request } = harness;
  context.renderDecisionCard = (pause) => { context.renderedPause = pause; };
  const task = context.sessionData.turns[0].leadTask;
  const submission = context.submitDecision();

  task.state = 'TASK_STATE_INPUT_REQUIRED';
  task.metadata.pause = { kind: 'owner_decision', decisionId: 'decision-2', question: 'Choose the next step.' };
  request.resolve(response({ success: false, error: 'decision is now stale' }));
  const outcome = await submission;

  assert.equal(outcome.ok, false);
  assert.deepEqual(JSON.parse(context.decisionCardKey), ['task-a', 'owner_decision', 'decision-2', 'Choose the next step.', '']);
  assert.equal(context.renderedPause.decisionId, 'decision-2');
  assert.equal(elements.decisionCard.classList.contains('hidden'), false);
  assert.equal(context.selectedDecisionOption, '');
  assert.equal(elements.decisionAnswer.value, 'Please continue after checking the provider.');
});

test('an older project request cannot release the newer request busy state', async () => {
  const harness = createHarness();
  const { context, request } = harness;
  const oldRequest = deferred();
  const newRequest = deferred();
  let count = 0;
  context.fetch = () => (++count === 1 ? oldRequest.promise : newRequest.promise);
  context.window = { location: { href: 'http://example.test/ui' } };
  context.URL = URL;
  context.history = { replaceState() {} };
  context.initialSessionParam = null;
  context.autoOpenLatest = false;
  context.renderProjectBar = () => {};
  context.updateStatus = () => {};
  context.loadTeam = () => {};
  vm.runInContext(functionSource('resetSessionView') + functionSource('selectProject'), context);

  const oldSend = context.executeA2A({ goal: 'Old project message' });
  context.selectProject('project-b');
  context.setSession('session-b');
  const newSend = context.executeA2A({ goal: 'New project message' });
  const newOwner = context.sendingRequest;
  assert.equal(context.sending, true);
  assert.equal(count, 2);

  oldRequest.resolve(response({ success: true }));
  const oldOutcome = await oldSend;
  assert.equal(oldOutcome.stale, true);
  assert.equal(context.sending, true);
  assert.equal(context.sendingRequest, newOwner);

  newRequest.resolve(response({ success: true }));
  const newOutcome = await newSend;
  assert.equal(newOutcome.ok, true);
  assert.equal(context.sending, false);
  assert.equal(context.sendingRequest, null);
});

test('an older decision submit cannot release a newer project decision submit', async () => {
  const harness = createHarness();
  const { context, elements } = harness;
  const oldRequest = deferred();
  const newRequest = deferred();
  let count = 0;
  context.fetch = () => (++count === 1 ? oldRequest.promise : newRequest.promise);
  context.window = { location: { href: 'http://example.test/ui' } };
  context.URL = URL;
  context.history = { replaceState() {} };
  context.initialSessionParam = null;
  context.autoOpenLatest = false;
  context.renderProjectBar = () => {};
  context.updateStatus = () => {};
  context.loadTeam = () => {};
  vm.runInContext(functionSource('resetSessionView') + functionSource('selectProject'), context);

  const oldSubmit = context.submitDecision();
  context.selectProject('project-b');
  context.serverRunning = true;
  context.setSession('session-b');
  const nextPause = { kind: 'error', decisionId: 'decision-2', message: 'New project pause.' };
  context.sessionData = { turns: [{ leadTask: { id: 'task-b', state: 'TASK_STATE_INPUT_REQUIRED', metadata: { pause: nextPause } } }] };
  context.decisionCardKey = JSON.stringify(['task-b', 'error', 'decision-2', '', nextPause.message]);
  context.decisionOptionIds = ['stay', 'go'];
  context.selectedDecisionOption = 'go';
  elements.decisionId.value = 'decision-2';
  elements.decisionAnswer.value = 'New project draft.';
  const newSubmit = context.submitDecision();
  const newSubmitOwner = context.decisionSubmitOwner;

  oldRequest.resolve(response({ success: true }));
  const oldOutcome = await oldSubmit;
  assert.equal(oldOutcome.stale, true);
  assert.equal(context.decisionSubmitting, true);
  assert.equal(context.decisionSubmitOwner, newSubmitOwner);
  assert.equal(context.sending, true);
  assert.equal(elements.decisionAnswer.value, 'New project draft.');
  assert.equal(context.selectedDecisionOption, 'go');

  context.pollState = 'TASK_STATE_COMPLETED';
  newRequest.resolve(response({ success: true, result: { status: { state: 'TASK_STATE_COMPLETED' } } }));
  const newOutcome = await newSubmit;
  assert.equal(newOutcome.ok, true);
  assert.equal(context.decisionSubmitting, false);
  assert.equal(context.decisionSubmitOwner, null);
  assert.equal(elements.decisionAnswer.value, '');
});

test('request cleanup rechecks ownership after a deferred session poll', async () => {
  const harness = createHarness();
  const { context } = harness;
  const oldRequest = deferred();
  const newRequest = deferred();
  const pollGate = deferred();
  const pollStarted = deferred();
  let fetchCount = 0;
  let pollCount = 0;
  context.fetch = () => (++fetchCount === 1 ? oldRequest.promise : newRequest.promise);
  context.pollSession = async () => {
    pollCount += 1;
    if (pollCount === 1) {
      pollStarted.resolve();
      await pollGate.promise;
    }
  };
  context.window = { location: { href: 'http://example.test/ui' } };
  context.URL = URL;
  context.history = { replaceState() {} };
  context.initialSessionParam = null;
  context.autoOpenLatest = false;
  context.renderProjectBar = () => {};
  context.updateStatus = () => {};
  context.loadTeam = () => {};
  vm.runInContext(functionSource('resetSessionView') + functionSource('selectProject'), context);

  const oldSend = context.executeA2A({ goal: 'Old project message' });
  oldRequest.resolve(response({ success: true }));
  await pollStarted.promise;

  context.selectProject('project-b');
  context.setSession('session-b');
  context.sessionData = { turns: [] };
  context.pendingTurn = { goal: 'New project goal', baseTurns: 0 };
  const newSend = context.executeA2A({ goal: 'New project message' });
  const newOwner = context.sendingRequest;
  const newEpoch = context.a2aRequestEpoch;
  assert.equal(context.sending, true);

  pollGate.resolve();
  const oldOutcome = await oldSend;
  assert.equal(oldOutcome.ok, true);
  assert.equal(context.sending, true);
  assert.equal(context.sendingRequest, newOwner);
  assert.equal(context.a2aRequestEpoch, newEpoch);
  assert.deepEqual(JSON.parse(JSON.stringify(context.pendingTurn)), { goal: 'New project goal', baseTurns: 0 });

  context.pendingTurn = null;
  newRequest.resolve(response({ success: true }));
  const newOutcome = await newSend;
  assert.equal(newOutcome.ok, true);
  assert.equal(context.sending, false);
});
