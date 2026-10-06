'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canScript, buildLeanAssignment, buildLeanFinish, buildLeanDecision,
} = require('../src/lean-dispatch');

const stage = (stageId, roleId, extra = {}) => ({
  stageId, roleId, objective: `Stage ${stageId}`, dependencies: [], allowedFiles: roleId === 'orch-builder' ? ['src/a.js'] : [], required: true, ...extra,
});
const stages = [
  stage('reproduce', 'orch-explorer'),
  stage('implement', 'orch-builder', { dependencies: ['reproduce'] }),
  stage('review', 'orch-architect', { dependencies: ['implement'] }),
  stage('verify', 'orch-explorer', { dependencies: ['implement'] }),
];
const routing = {
  effective: 'lean', skipStageIds: ['reproduce'], conditionalStageIds: ['review'], gateStageIds: ['implement'], purposeOverrides: { implement: 'Fix it' },
};
const report = (summary, extra = {}) => ({
  outcome: 'completed', summary, filesChanged: ['src/a.js'], filesInspected: [], checks: [{ command: 'npm test', result: 'passed', detail: '' }], risks: [], scopeExpansion: [], decisionRequest: null, ...extra,
});
const baseState = (extra = {}) => ({
  goal: 'Fix the bug',
  plan: { stages, routing },
  stageStatuses: { reproduce: { status: 'skipped', attemptIds: [] } },
  outcomes: [],
  openDecisions: [],
  humanAnswers: [],
  humanRequest: null,
  unresolvedWriters: [],
  contract: { requiredChecks: [] },
  routePromotion: null,
  acceptance: null,
  acceptanceAttempts: 0,
  planViolations: 0,
  decisionViolations: 0,
  planRetry: false,
  status: null,
  budget: null,
  round: 0,
  ...extra,
});
const implemented = (extra = {}) => baseState({
  stageStatuses: { reproduce: { status: 'skipped', attemptIds: [] }, implement: { status: 'succeeded', attemptIds: ['a1'] } },
  outcomes: [{ attemptId: 'a1', role: 'orch-builder', report: report('Patched it') }],
  round: 1,
  ...extra,
});
const eligibleOf = (state) => state.plan.stages.filter((entry) => !['succeeded', 'skipped'].includes(state.stageStatuses[entry.stageId]?.status)
  && entry.dependencies.every((dep) => ['succeeded', 'skipped'].includes(state.stageStatuses[dep]?.status)));

test('canScript: only a clean lean state qualifies', () => {
  assert.equal(canScript(baseState(), { roundLimit: 8 }), true);
  const blocked = [
    ['full route', { plan: { stages, routing: { effective: 'full' } } }],
    ['no plan', { plan: null }],
    ['promotion', { routePromotion: { reasons: ['x'], at: 'implement' } }],
    ['open decision', { openDecisions: [{ id: 'd1' }] }],
    ['human request', { humanRequest: { decisionId: 'h1' } }],
    ['human answers', { humanAnswers: [{}] }],
    ['unresolved writer', { unresolvedWriters: [{ attemptId: 'a1' }] }],
    ['failed stage', { stageStatuses: { implement: { status: 'failed', attemptIds: [] } } }],
    ['rejected acceptance', { acceptance: { disposition: 'rejected' }, acceptanceAttempts: 1 }],
    ['plan violation counter', { planViolations: 1 }],
    ['decision violation counter', { decisionViolations: 1 }],
    ['plan retry', { planRetry: true }],
  ];
  blocked.forEach(([label, extra]) => assert.equal(canScript(baseState(extra), { roundLimit: 8 }), false, label));
  assert.equal(canScript(baseState(), { notes: ['resumed'], roundLimit: 8 }), false);
  assert.equal(canScript(baseState({ round: 8 }), { roundLimit: 8 }), false);
});

test('buildLeanAssignment: compact contract-shaped assignment with purpose override and fallback evidence', () => {
  const state = baseState({ goal: 'g'.repeat(5000), contract: { requiredChecks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 1 }] } });
  const assignment = buildLeanAssignment(state, stages[1]);
  assert.deepEqual(Object.keys(assignment).sort(), ['acceptanceCriteria', 'allowedFiles', 'checks', 'evidence', 'inputs', 'objective', 'role', 'stageId', 'stopConditions']);
  assert.equal(assignment.objective, 'Fix it');
  assert.equal(assignment.role, 'orch-builder');
  assert.equal(assignment.inputs[0].length, 3000);
  assert.equal(assignment.inputs[1], 'Plan stage objective: Stage implement');
  assert.deepEqual(assignment.checks, ['unit: npm test']);
  assert.equal(assignment.evidence.length, 1);
  assert.equal(assignment.acceptanceCriteria[0], 'Fix it');
  assert.match(buildLeanAssignment(baseState(), stages[1]).checks[0], /^Run the focused check/);
});

test('buildLeanAssignment: dependency evidence is bounded and reports the checks', () => {
  const state = implemented({ outcomes: [{ attemptId: 'a1', role: 'orch-builder', report: report('x'.repeat(4000)) }] });
  const { evidence, objective } = buildLeanAssignment(state, stages[3]);
  assert.equal(objective, 'Stage verify');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].length, 1500);
  assert.match(evidence[0], /^implement \(orch-builder\): completed - /);
  const short = buildLeanAssignment(implemented(), stages[3]).evidence[0];
  assert.match(short, /filesChanged: src\/a\.js; checks: npm test: passed$/);
});

test('buildLeanDecision: dispatch the first eligible required stage, then finish, else null', () => {
  const first = buildLeanDecision(baseState(), { eligible: eligibleOf(baseState()), roundLimit: 8 });
  assert.equal(first.action, 'dispatch');
  assert.deepEqual(first.assignments.map((entry) => entry.stageId), ['implement']);
  assert.deepEqual([first.final, first.resolutions, first.humanInput], ['', [], null]);
  const mid = implemented();
  // review is conditional and not required: only verify is dispatched
  assert.deepEqual(buildLeanDecision(mid, { eligible: eligibleOf(mid), roundLimit: 8 }).assignments.map((entry) => entry.stageId), ['verify']);
  const done = implemented({ stageStatuses: { ...mid.stageStatuses, verify: { status: 'succeeded', attemptIds: ['a2'] } }, outcomes: [...mid.outcomes, { attemptId: 'a2', role: 'orch-explorer', report: report('Verified') }] });
  const finish = buildLeanDecision(done, { eligible: eligibleOf(done).filter(() => true), roundLimit: 8 });
  assert.equal(finish.action, 'finish');
  assert.deepEqual([finish.assignments, finish.resolutions, finish.humanInput], [[], [], null]);
  assert.match(finish.final, /^Route: lean\.\nSucceeded stages: implement, verify\.\n- implement: Patched it\n- verify: Verified$/);
  // inconsistent: nothing eligible and a required stage is not done
  assert.equal(buildLeanDecision(mid, { eligible: [], roundLimit: 8 }), null);
  assert.equal(buildLeanDecision(baseState({ openDecisions: [{ id: 'd' }] }), { eligible: eligibleOf(baseState()), roundLimit: 8 }), null);
});

test('buildLeanFinish truncates stage summaries', () => {
  const state = implemented({ outcomes: [{ attemptId: 'a1', role: 'orch-builder', report: report('y'.repeat(2000)) }] });
  assert.equal(buildLeanFinish(state).final.split('\n')[2].length, '- implement: '.length + 600);
});
