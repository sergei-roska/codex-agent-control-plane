'use strict';

// Fake Codex app server and scripted lead decisions shared by e2e tests and the dashboard dev harness.

const { DECISION_SCHEMA } = require('../../src/contracts');
const { INTAKE_SCHEMA } = require('../../src/intake');

function decision(overrides = {}) {
  return { action: 'finish', assignments: [], final: '', resolutions: [], humanInput: null, ...overrides };
}

function assignment(role, overrides = {}) {
  return {
    role,
    stageId: null,
    objective: `Do the ${role} work`,
    allowedFiles: [],
    inputs: ['goal text'],
    evidence: ['none yet'],
    acceptanceCriteria: ['done'],
    checks: ['none'],
    stopConditions: ['blocked'],
    ...overrides,
  };
}

function workerReport(summary = 'All good') {
  return {
    outcome: 'completed',
    summary,
    filesChanged: [],
    filesInspected: ['README.md'],
    checks: [],
    risks: [],
    scopeExpansion: [],
    decisionRequest: null,
  };
}

function humanDecision() {
  return decision({
    action: 'request_human_input',
    humanInput: {
      reason: 'product_choice',
      question: 'Which flavour?',
      options: [{ id: 'a', description: 'Option A' }, { id: 'b', description: 'Option B' }],
      recommendation: 'a',
      evidenceChecked: ['README.md'],
      independentWork: '',
      relatedDecisionIds: [],
    },
  });
}

function intakeOutput(overrides = {}) {
  return {
    readiness: 'ready',
    classification: 'feature',
    requirements: { summary: 'Do the thing', scope: ['the thing'], outOfScope: [], unknowns: [], expectedOutcomes: ['the thing is done'] },
    questions: [],
    unsupportedReason: null,
    plan: null,
    ...overrides,
  };
}

function planStage(stageId, roleId, overrides = {}) {
  return {
    stageId, roleId, objective: `Stage ${stageId}`, dependencies: [], allowedFiles: [], required: true, ...overrides,
  };
}

/** A ready Intake output carrying a plan. */
function readyIntake({ classification = 'feature', stages, checkIds = ['unit'], ...rest } = {}) {
  return intakeOutput({ readiness: 'ready', classification, plan: { stages, checkIds }, ...rest });
}

function needsInputIntake(questions = [{ id: 'q1', question: 'Which one?', why: 'It changes the result' }]) {
  return intakeOutput({ readiness: 'needs_input', questions, plan: null });
}

/**
 * Fake Codex app server. leadScript entries are decision objects or functions
 * (call, input) => decision | throws. workerImpl(call) handles specialists.
 * intakeScript entries (PM Intake turns, recognised by INTAKE_SCHEMA) are objects, raw strings,
 * Errors (thrown) or functions (call, input, signal) => any of those, possibly async.
 */
function makeFakeAppServer({ leadScript = [], workerImpl, intakeScript = [] } = {}) {
  const queue = [...leadScript];
  const intakeQueue = [...intakeScript];
  const fake = {
    leadCalls: [],
    workerCalls: [],
    intakeCalls: [],
    intakeQueue,
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async close() {},
    async readRateLimits() { return null; },
    async run({ role, input, threadId, outputSchema, signal }) {
      if (outputSchema === INTAKE_SCHEMA) {
        fake.intakeCalls.push({ input, role: role?.name, instructions: role?.instructions });
        const next = intakeQueue.shift();
        if (next === undefined) throw new Error('intake script exhausted');
        const value = typeof next === 'function' ? await next(fake.intakeCalls.length, input, signal) : next;
        if (value instanceof Error) throw value;
        return { threadId: 'intake-thread', status: 'completed', text: typeof value === 'string' ? value : JSON.stringify(value) };
      }
      const isLead = role?.name === 'orch-lead' || outputSchema === DECISION_SCHEMA;
      if (isLead) {
        fake.leadCalls.push({ input, threadId, role: role?.name, instructions: role?.instructions });
        const next = queue.shift();
        if (next === undefined) throw new Error('lead script exhausted');
        const value = typeof next === 'function' ? next(fake.leadCalls.length, input) : next;
        return { threadId: threadId || 'lead-thread', status: 'completed', text: JSON.stringify(value) };
      }
      fake.workerCalls.push({ role: role.name, input });
      if (workerImpl) return workerImpl({ role: role.name, input, signal });
      return { threadId: 'worker-thread', status: 'completed', text: JSON.stringify(workerReport()) };
    },
  };
  return fake;
}

module.exports = {
  decision, assignment, workerReport, humanDecision, makeFakeAppServer, intakeOutput, planStage, readyIntake, needsInputIntake,
};
