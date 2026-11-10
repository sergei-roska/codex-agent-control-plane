'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

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
  return {
    disabled: false,
    placeholder: '',
    textContent: '',
    value: '',
    attrs: {},
    dataset: {},
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    focus() { this.focused = true; },
  };
}

function loadControls(overrides = {}) {
  const ids = [
    'taskGoal', 'sendBtn', 'newSessionBtn', 'composerHint', 'sendLabel', 'composerBox',
    'modeLeadBtn', 'modeScoutBtn', 'activeTaskIdDisplay', 'decisionCard', 'sendError',
    'decisionOptionsList', 'decisionId', 'decisionIdText', 'decisionAnswer', 'taskChecks', 'taskChecksBox',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const context = Object.assign({
    document: { getElementById: (id) => elements[id] || null },
    window: {},
    currentSessionId: 'session-old',
    sessionData: { turns: [{ leadTask: { id: 'task-old', state: 'TASK_STATE_INPUT_REQUIRED' } }] },
    pendingTurn: null,
    sending: false,
    askSending: false,
    pauseBusy: false,
    leadWasActive: false,
    scoutChoice: null,
    currentProjectId: 'project-a',
    serverRunning: true,
    situationKey: 'project-a/session-old',
    situation: { phase: 'paused', pauseKind: 'owner_pause', leadTaskId: 'task-old', batch: [] },
    autoOpenLatest: true,
    usageSawTerminal: false,
    renderSignature: 'old',
    decisionCardKey: 'old-decision',
    decisionOptionIds: ['keep', 'change'],
    selectedDecisionOption: 'keep',
    fetchCalls: 0,
    situationBatch(sit) { return Array.isArray(sit.batch) ? sit.batch : []; },
    leadActive() { return true; },
    pauseKindNow() { return 'owner_pause'; },
    askMode() { return 'lead'; },
    updatePauseButton() {},
    setTooltip() {},
    setSessionParam() {},
    renderTranscript() {},
    updateTeamLeds() {},
    refreshSessionUsage() {},
    refreshSituation() {},
    refreshGitStatus() {},
    ...overrides,
  }, elements, { LEGACY_ROLE_IDS: {} });
  context.situationScope = () => context.currentProjectId && context.currentSessionId
    ? context.currentProjectId + '/' + context.currentSessionId : '';
  context.ownerPhase = () => context.situationKey === context.situationScope() && context.situation
    ? context.situation.phase : null;
  context.executeA2A = (payload) => { context.lastPayload = payload; };
  context.fetch = () => { context.fetchCalls += 1; throw new Error('unexpected fetch'); };
  vm.createContext(context);
  vm.runInContext([
    functionSource('lastTurn'),
    functionSource('isTerminalState'),
    functionSource('isPausedState'),
    functionSource('canStartNewSession'),
    functionSource('setSession'),
    functionSource('updateComposer'),
    functionSource('newSession'),
    functionSource('newContextId'),
    functionSource('sendMessage'),
  ].join('\n'), context);
  return { context, elements };
}

describe('new session controls', () => {
  it('enables New session after the matching owner pause is parked', () => {
    const { context, elements } = loadControls();
    context.updateComposer();
    assert.equal(elements.newSessionBtn.disabled, false);
    assert.equal(context.newSession(), true);
    assert.equal(context.currentSessionId, null);
    assert.equal(context.sessionData, null);
    assert.equal(context.pendingTurn, null);
    assert.equal(context.autoOpenLatest, false);
    assert.equal(context.decisionCardKey, '');
    assert.deepEqual(Array.from(context.decisionOptionIds), []);
    assert.equal(context.selectedDecisionOption, '');
    assert.equal(elements.decisionCard.classList.contains('hidden'), true);
    assert.equal(elements.decisionId.value, '');
    assert.equal(elements.decisionAnswer.value, '');
    assert.equal(elements.taskGoal.focused, true);
    assert.equal(context.fetchCalls, 0, 'starting a new session does not mutate the old stored session');
  });

  it('sends the next goal with a fresh context and no old task continuation fields', async () => {
    const { context, elements } = loadControls({
      window: { crypto: { randomUUID: () => 'new-context-id' } },
    });
    assert.equal(context.newSession(), true);
    elements.taskGoal.value = 'Start separate work';
    await context.sendMessage();
    assert.deepEqual(JSON.parse(JSON.stringify(context.lastPayload)), {
      goal: 'Start separate work',
      contextId: 'new-context-id',
    });
  });

  it('enables a confirmed stopped pause with a numeric task state', () => {
    const { context, elements } = loadControls({
      sessionData: { turns: [{ leadTask: { id: 'task-old', state: 6 } }] },
      situation: { phase: 'paused', pauseKind: 'stopped', leadTaskId: 'task-old', batch: [] },
    });
    context.updateComposer();
    assert.equal(elements.newSessionBtn.disabled, false);
  });

  it('enables New session while the lead waits for an owner decision', () => {
    const { context, elements } = loadControls({
      sessionData: { turns: [{ leadTask: { id: 'task-old', state: 'TASK_STATE_INPUT_REQUIRED' } }] },
      situation: { phase: 'waiting_owner', pauseKind: null, leadTaskId: 'task-old', batch: [] },
    });
    context.updateComposer();
    assert.equal(elements.newSessionBtn.disabled, false);
    assert.equal(context.newSession(), true);
    assert.equal(context.fetchCalls, 0);
  });

  it('keeps New session disabled while the pause is pending or workers are running', () => {
    for (const situation of [
      { phase: 'pausing', leadTaskId: 'task-old', batch: [] },
      { phase: 'paused', pauseKind: 'owner_pause', leadTaskId: 'task-old', batch: [{ state: 'running' }] },
    ]) {
      const { context, elements } = loadControls({ situation });
      context.updateComposer();
      assert.equal(elements.newSessionBtn.disabled, true);
      assert.equal(context.newSession(), false);
      assert.equal(context.currentSessionId, 'session-old');
    }
  });

  it('rejects stale situations from another task or project', () => {
    for (const overrides of [
      { situation: { phase: 'paused', pauseKind: 'owner_pause', leadTaskId: 'task-prior', batch: [] } },
      { currentProjectId: 'project-b' },
      { situation: { phase: 'paused', leadTaskId: 'task-old', batch: [] } },
      { situation: { phase: 'paused', pauseKind: 'human_decision', leadTaskId: 'task-old', batch: [] } },
    ]) {
      const { context, elements } = loadControls(overrides);
      context.updateComposer();
      assert.equal(elements.newSessionBtn.disabled, true);
      assert.equal(context.newSession(), false);
    }
  });

  it('keeps the action disabled for unsettled sends and pending turns', () => {
    for (const overrides of [
      { sending: true },
      { pendingTurn: { goal: 'pending', baseTurns: 1 } },
      { askSending: true },
      { pauseBusy: true },
    ]) {
      const { context, elements } = loadControls(overrides);
      context.updateComposer();
      assert.equal(elements.newSessionBtn.disabled, true);
      assert.equal(context.newSession(), false);
      assert.equal(context.currentSessionId, 'session-old');
    }
  });

  it('preserves terminal-session behavior without requiring a situation', () => {
    const { context, elements } = loadControls({
      sessionData: { turns: [{ leadTask: { id: 'task-old', state: 'TASK_STATE_COMPLETED' } }] },
      situationKey: '',
      situation: null,
    });
    context.updateComposer();
    assert.equal(elements.newSessionBtn.disabled, false);
  });
});

describe('acceptance checks in the composer', () => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const terminalSession = { sessionData: { turns: [{ leadTask: { id: 'task-old', state: 'TASK_STATE_COMPLETED' } }] }, situationKey: '', situation: null };

  it('sends one command per line as checks and clears the box', async () => {
    const { context, elements } = loadControls({ window: { crypto: { randomUUID: () => 'ctx-new' } } });
    assert.equal(context.newSession(), true);
    elements.taskGoal.value = 'Build it';
    elements.taskChecks.value = '  npm test  \n\n   \nuv run pytest -q\r\n';
    await context.sendMessage();
    assert.deepEqual(plain(context.lastPayload), { goal: 'Build it', contextId: 'ctx-new', checks: ['npm test', 'uv run pytest -q'] });
    assert.equal(elements.taskChecks.value, '');
  });

  it('omits the field for an empty or blank box so the project defaults apply', async () => {
    for (const value of ['', '  \n \n']) {
      const { context, elements } = loadControls({ window: { crypto: { randomUUID: () => 'ctx-new' } } });
      assert.equal(context.newSession(), true);
      elements.taskGoal.value = 'Build it';
      elements.taskChecks.value = value;
      await context.sendMessage();
      assert.equal('checks' in context.lastPayload, false);
    }
  });

  it('sends checks with a follow-up run but never with a resume of a paused task', async () => {
    const followUp = loadControls(terminalSession);
    followUp.elements.taskGoal.value = 'Next step';
    followUp.elements.taskChecks.value = 'make check';
    await followUp.context.sendMessage();
    assert.deepEqual(plain(followUp.context.lastPayload), { goal: 'Next step', continueFrom: 'task-old', checks: ['make check'] });

    const resume = loadControls();
    resume.elements.taskGoal.value = 'Carry on';
    resume.elements.taskChecks.value = 'make check';
    await resume.context.sendMessage();
    assert.deepEqual(plain(resume.context.lastPayload), { goal: 'Carry on', taskId: 'task-old' });
    assert.equal(resume.elements.taskChecks.value, 'make check');
  });

  it('hides the checks box in scout mode', () => {
    const lead = loadControls();
    lead.context.updateComposer();
    assert.equal(lead.elements.taskChecksBox.classList.contains('hidden'), false);
    const scout = loadControls({ askMode() { return 'scout'; } });
    scout.context.updateComposer();
    assert.equal(scout.elements.taskChecksBox.classList.contains('hidden'), true);
  });

  it('the page declares the textarea with the host-execution hint', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'index.html'), 'utf8');
    assert.match(html, /<textarea id="taskChecks"/);
    assert.match(html, /Owner checks run on the host, unsandboxed/);
  });
});
