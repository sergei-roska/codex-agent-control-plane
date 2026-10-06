'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLeanRouting, routingOf, isSatisfied, requiredStageIds, evaluateImplementDelta,
} = require('../src/route-runtime');

const stage = (stageId, extra = {}) => ({ stageId, required: true, ...extra });
const stages = [stage('reproduce'), stage('implement'), stage('review'), stage('verify'), stage('extra', { required: false })];
const leanRouting = {
  effective: 'lean', skipStageIds: ['reproduce'], conditionalStageIds: ['review'], gateStageIds: ['implement'], limits: { maxFiles: 3, maxChangedLines: 30 },
};

test('routingOf: a plan without routing is full and empty', () => {
  for (const plan of [null, {}, { stages }, { stages, routing: null }, { stages, routing: { effective: 'full' } }, { stages, routing: { effective: 'shadow' } }]) {
    const routing = routingOf(plan);
    assert.equal(routing.effective, 'full');
    assert.deepEqual([routing.skipStageIds, routing.conditionalStageIds, routing.gateStageIds, routing.purposeOverrides], [[], [], [], {}]);
  }
});

test('routingOf: a lean routing is normalized against the plan stages', () => {
  const routing = routingOf({
    stages,
    routing: { ...leanRouting, skipStageIds: ['reproduce', 'ghost', 'reproduce', 7], purposeOverrides: { implement: 'Fix it', ghost: 'x', review: 3 }, limits: { maxFiles: 5 } },
  });
  assert.equal(routing.effective, 'lean');
  assert.deepEqual(routing.skipStageIds, ['reproduce']);
  assert.deepEqual(routing.conditionalStageIds, ['review']);
  assert.deepEqual(routing.gateStageIds, ['implement']);
  assert.deepEqual(routing.purposeOverrides, { implement: 'Fix it' });
  assert.equal(routing.limits.maxFiles, 5);
  assert.equal(routing.limits.maxChangedLines, 30);
});

test('isSatisfied: succeeded and skipped only', () => {
  assert.equal(isSatisfied('succeeded'), true);
  assert.equal(isSatisfied('skipped'), true);
  for (const status of ['pending', 'failed', 'eligible', undefined, null]) assert.equal(isSatisfied(status), false);
});

test('requiredStageIds: full, lean, lean promoted', () => {
  const plan = { stages, routing: leanRouting };
  assert.deepEqual(requiredStageIds(plan, routingOf({ stages }), null), ['reproduce', 'implement', 'review', 'verify']);
  assert.deepEqual(requiredStageIds(plan, routingOf(plan), null), ['implement', 'verify']);
  assert.deepEqual(requiredStageIds(plan, routingOf(plan), { reasons: ['delta_unknown'], at: 'implement' }), ['implement', 'review', 'verify']);
  assert.deepEqual(requiredStageIds(plan, undefined, null), ['reproduce', 'implement', 'review', 'verify']);
});

test('evaluateImplementDelta: clean, unknown, headChanged and report-derived inputs', () => {
  const delta = { known: true, headChanged: false, changedPaths: ['src/a.js'] };
  const lines = [{ path: 'src/a.js', addedLines: 3, removedLines: 1, bytes: 40 }];
  const clean = { allowedFiles: ['src'], delta, lines, report: { outcome: 'completed', checks: [{ result: 'passed' }], scopeExpansion: [] } };
  assert.deepEqual(evaluateImplementDelta(clean), { promote: false, reasons: [] });
  assert.deepEqual(evaluateImplementDelta({ ...clean, lines: null }).reasons, ['delta_unknown']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, lines: [] }).reasons, ['delta_unknown']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, delta: { ...delta, known: false } }).reasons, ['delta_unknown']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, delta: { ...delta, headChanged: true } }).reasons, ['delta_unknown']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, delta: null }).reasons, ['delta_unknown']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, delta: { ...delta, changedPaths: [] }, lines: null }), { promote: true, reasons: ['empty_delta'] });
  assert.deepEqual(evaluateImplementDelta({ ...clean, delta: { ...delta, changedPaths: [] }, lines: null, requireChange: false }), { promote: false, reasons: [] });
  assert.deepEqual(evaluateImplementDelta({ ...clean, lines: [{ ...lines[0], bytes: 20001 }] }).reasons, ['too_many_changed_bytes']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, lines: [{ ...lines[0], modeChanged: true }] }).reasons, ['mode_change']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, report: { ...clean.report, checks: [{ result: 'failed' }] } }).reasons, ['check_not_passed']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, report: { ...clean.report, scopeExpansion: [{ path: 'x', reason: 'y' }] } }).reasons, ['scope_expansion']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, report: { ...clean.report, outcome: 'needs_decision' } }).reasons, ['needs_decision']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, allowedFiles: ['docs'] }).reasons, ['outside_allowed_files:src/a.js']);
  assert.deepEqual(evaluateImplementDelta({ ...clean, limits: { maxChangedLines: 3 } }).reasons, ['too_many_changed_lines']);
});

test('buildLeanRouting: derives everything from the preset, the plan and the policy', () => {
  const plan = {
    stages: [
      { stageId: 's1', roleId: 'dlv-developer', presetStageKey: 'reproduce' },
      { stageId: 's2', roleId: 'dlv-developer', presetStageKey: 'implement' },
      { stageId: 's3', roleId: 'dlv-reviewer', presetStageKey: 'review' },
      { stageId: 's4', roleId: 'dlv-qa', presetStageKey: 'verify' },
    ],
  };
  const preset = { lean: { skip: ['reproduce'], conditional: ['review'], purposeOverrides: { implement: 'Fix it' } } };
  const isWritableRole = (roleId) => roleId !== 'dlv-reviewer';
  const routing = buildLeanRouting({ preset, plan, projectConfig: { routeLimits: { maxFiles: 2 } }, isWritableRole });
  assert.deepEqual(routing.skipStageIds, ['s1']);
  assert.deepEqual(routing.conditionalStageIds, ['s3']);
  assert.deepEqual(routing.gateStageIds, ['s1', 's2', 's4']);
  assert.deepEqual(routing.purposeOverrides, { s2: 'Fix it' });
  assert.equal(routing.limits.maxFiles, 2);
  assert.equal(routing.limits.maxChangedBytes, 20000);
  assert.equal(buildLeanRouting({ preset: {}, plan, isWritableRole }), null);
  assert.equal(buildLeanRouting({ preset, plan }), null);
});
