'use strict';

// Fake Codex app server and scripted lead decisions shared by e2e tests and the dashboard dev harness.

const { DECISION_SCHEMA } = require('../../src/contracts');
const { INTAKE_SCHEMA, INTAKE_SCHEMA_V2 } = require('../../src/intake');

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

/** Pack-aware (INTAKE_SCHEMA_V2) stage: roleId is a PUBLIC role id, presetStageKey a preset stage key or null. */
function planStageV2(stageId, roleId, presetStageKey, overrides = {}) {
  return {
    stageId, presetStageKey, roleId, objective: `Stage ${stageId}`, dependencies: [], allowedFiles: [], required: true, ...overrides,
  };
}

/** A ready Intake V2 output bound to a preset. */
function readyIntakeV2({ classification = 'feature', presetId = classification, stages, checkIds = ['unit'], ...rest } = {}) {
  return intakeOutput({ readiness: 'ready', classification, plan: { presetId, stages, checkIds }, ...rest });
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function defaultModels() {
  const efforts = EFFORTS.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
  const model = (id, extra = {}) => ({
    id, model: id, displayName: id, description: '', hidden: false, isDefault: false,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts, serviceTiers: [],
    defaultServiceTier: null, upgrade: null, upgradeInfo: null, ...extra,
  });
  return [
    model('gpt-6-sol', { isDefault: true }),
    model('gpt-6-luna', { serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Faster responses' }] }),
    model('gpt-6.1-sol'),
  ];
}

/**
 * Fake Codex app server. leadScript entries are decision objects or functions
 * (call, input) => decision | throws. workerImpl(call) handles specialists.
 * intakeScript entries (PM Intake turns, recognised by INTAKE_SCHEMA) are objects, raw strings,
 * Errors (thrown) or functions (call, input, signal) => any of those, possibly async.
 */
function makeFakeAppServer({ leadScript = [], workerImpl, intakeScript = [], models, account, rateLimits = null } = {}) {
  const queue = [...leadScript];
  const intakeQueue = [...intakeScript];
  const fake = {
    leadCalls: [],
    workerCalls: [],
    intakeCalls: [],
    intakeQueue,
    async start() {},
    async getAccount() {
      if (account instanceof Error) throw account;
      return account === undefined ? { account: { type: 'chatgpt' } } : account;
    },
    async close() {},
    async readRateLimits() {
      if (rateLimits instanceof Error) throw rateLimits;
      return rateLimits;
    },
    async listModels() {
      if (models instanceof Error) throw models;
      return models === undefined ? defaultModels() : models;
    },
    async run({ role, input, threadId, outputSchema, signal }) {
      const settingsUsage = {
        usage: {
          model: role?.model ?? null,
          effort: role?.effort ?? null,
          requested: { model: role?.model ?? null, effort: role?.effort ?? null, serviceTier: role?.serviceTier ?? null },
          reported: { model: role?.model ?? null, reasoningEffort: role?.effort ?? null, serviceTier: role?.serviceTier ?? null },
        },
      };
      if (outputSchema === INTAKE_SCHEMA || outputSchema === INTAKE_SCHEMA_V2) {
        fake.intakeCalls.push({
          input, role: role?.name, instructions: role?.instructions, model: role?.model, effort: role?.effort, serviceTier: role?.serviceTier ?? null,
        });
        const next = intakeQueue.shift();
        if (next === undefined) throw new Error('intake script exhausted');
        const value = typeof next === 'function' ? await next(fake.intakeCalls.length, input, signal) : next;
        if (value instanceof Error) throw value;
        return { threadId: 'intake-thread', status: 'completed', text: typeof value === 'string' ? value : JSON.stringify(value), ...settingsUsage };
      }
      const isLead = role?.name === 'orch-lead' || outputSchema === DECISION_SCHEMA;
      if (isLead) {
        fake.leadCalls.push({
          input, threadId, role: role?.name, instructions: role?.instructions, model: role?.model, effort: role?.effort, serviceTier: role?.serviceTier ?? null,
        });
        const next = queue.shift();
        if (next === undefined) throw new Error('lead script exhausted');
        const value = typeof next === 'function' ? next(fake.leadCalls.length, input) : next;
        return { threadId: threadId || 'lead-thread', status: 'completed', text: JSON.stringify(value), ...settingsUsage };
      }
      fake.workerCalls.push({
        role: role.name, input, model: role.model, effort: role.effort, serviceTier: role.serviceTier ?? null,
      });
      if (workerImpl) {
        const out = await workerImpl({ role: role.name, input, signal });
        return out && typeof out === 'object' && !out.usage ? { ...out, ...settingsUsage } : out;
      }
      return { threadId: 'worker-thread', status: 'completed', text: JSON.stringify(workerReport()), ...settingsUsage };
    },
  };
  return fake;
}

module.exports = {
  decision, assignment, workerReport, humanDecision, makeFakeAppServer, defaultModels, intakeOutput, planStage, readyIntake, needsInputIntake,
  planStageV2, readyIntakeV2,
};
