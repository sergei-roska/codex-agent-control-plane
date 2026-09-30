'use strict';

// Fake Codex app server and scripted lead decisions shared by e2e tests and the dashboard dev harness.

const { DECISION_SCHEMA } = require('../../src/contracts');

function decision(overrides = {}) {
  return { action: 'finish', assignments: [], final: '', resolutions: [], humanInput: null, ...overrides };
}

function assignment(role, overrides = {}) {
  return {
    role,
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

/**
 * Fake Codex app server. leadScript entries are decision objects or functions
 * (call, input) => decision | throws. workerImpl(call) handles specialists.
 */
function makeFakeAppServer({ leadScript = [], workerImpl } = {}) {
  const queue = [...leadScript];
  const fake = {
    leadCalls: [],
    workerCalls: [],
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async close() {},
    async readRateLimits() { return null; },
    async run({ role, input, threadId, outputSchema, signal }) {
      const isLead = role?.name === 'orch-lead' || outputSchema === DECISION_SCHEMA;
      if (isLead) {
        fake.leadCalls.push({ input, threadId });
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

module.exports = { decision, assignment, workerReport, humanDecision, makeFakeAppServer };
