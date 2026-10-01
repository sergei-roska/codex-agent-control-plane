'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { comparePromptsLive, scoreLiveCase } = require('../src/m8/compare');
const { loadInputs } = require('../src/m8/experiment');

const dataset = require('../eval/m8/dataset/live-v1.json');

test('adoption scorer accepts explicit non-promotion decisions', () => {
  const caseItem = dataset.cases[1];
  const workspace = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm8-score-'));
  try {
    fs.writeFileSync(path.join(workspace, 'review-checklist.txt'), 'review artifact isolation\n');
    assert.equal(scoreLiveCase(caseItem, 'Production adoption is not authorized.', workspace).passed, true);
    assert.equal(scoreLiveCase(caseItem, 'Production adoption: do not promote.', workspace).passed, true);
    assert.equal(scoreLiveCase(caseItem, 'Production adoption approved.', workspace).passed, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('live comparison uses fresh sanitized turns and cleans isolated workspaces', async () => {
  const inputs = loadInputs();
  const requests = [];
  const result = await comparePromptsLive({ ...inputs, dataset, runTurn: async (request) => {
    requests.push(request);
    assert.equal(request.input.includes('fixture-token-value'), false);
    assert.equal(request.input.includes('s3cret-pass'), false);
    assert.equal(request.model, 'gpt-6-luna');
    assert.equal(request.effort, 'low');
    if (request.sandbox === 'workspace-write') {
      fs.writeFileSync(path.join(request.cwd, 'review-checklist.txt'), 'review artifact isolation\n');
      return { text: 'Production adoption: defer.' };
    }
    return { text: 'tkt_m8_001 run_m8_001 att_m8_001 out_m8_001 accepted' };
  } });
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.map((request) => request.cwd)).size, 4);
  assert.equal(requests.every((request) => !fs.existsSync(request.cwd)), true);
  assert.equal(result.promptComparison.status, 'evaluated');
  assert.equal(result.promptComparison.improvementObserved, false);
  assert.equal(result.promptComparison.baseline.passed, 2);
  assert.equal(result.promptComparison.candidate.passed, 2);
  assert.equal(result.promoted, false);
});

test('failed model invocation leaves prompt comparison not evaluated', async () => {
  const inputs = loadInputs();
  const result = await comparePromptsLive({ ...inputs, dataset, runTurn: async () => {
    throw new Error('network unavailable');
  } });
  assert.equal(result.promptComparison.status, 'not-evaluated');
  assert.equal(result.promptComparison.improvementObserved, null);
  assert.equal(result.cases.length, 4);
  assert.equal(result.cases.every((item) => item.error === 'network unavailable'), true);
});
