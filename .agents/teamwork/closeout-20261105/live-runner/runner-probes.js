'use strict';

const assert = require('node:assert/strict');
const { TaskState } = require('@a2a-js/sdk');
const runner = require('./run-comparison');

function acceptedEvidence() {
  return { engine: 'concurrent-v1', finalTask: { state: TaskState.TASK_STATE_COMPLETED },
    productCheck: { exitCode: 0 }, checkUnchanged: true, productScope: { allowedOnly: true },
    finalization: { disposition: 'accepted', candidateId: 'candidate-1' },
    close: { status: 'closed' }, stateBackupBeforeClose: { path: 'pre.sqlite' },
    stateBackupAfterClose: { path: 'post.sqlite' },
    closeLifecycle: { beforeClose: { complete: true }, afterClose: { complete: true } },
    sourceManifestBefore: { 'src/example.js': 'hash' }, sourceManifestAfter: { 'src/example.js': 'hash' }, sourceDrift: [],
    steeringAccepted: true, finalizationFailures: [] };
}

async function finalizationProbes() {
  const runFinalSequence = async (evidence, captureSourceAfter) => {
    const calls = [];
    const result = await runner.finalizationSequence({
      evidence,
      awaitSteering: async () => { calls.push('steering'); },
      closeRuntime: async () => { calls.push('close'); },
      captureSourceAfter: async () => { calls.push('source_after'); await captureSourceAfter(); },
      reduce: async () => { calls.push('reduce'); return runner.finalizeCollector(evidence); },
    });
    assert.deepEqual(calls, ['steering', 'close', 'source_after', 'reduce']);
    return result;
  };
  const order = [];
  const evidence = acceptedEvidence();
  let resolveSteering;
  const lateSteering = new Promise((resolve) => { resolveSteering = resolve; });
  setTimeout(() => { evidence.steeringAccepted = true; resolveSteering(); }, 20);
  const success = await runner.finalizationSequence({
    evidence,
    awaitSteering: async () => { await lateSteering; order.push('steering'); },
    closeRuntime: async () => { order.push('close'); },
    captureSourceAfter: async () => { order.push('source_after'); },
    reduce: async () => { order.push('reduce'); return runner.finalizeCollector(evidence); },
  });
  assert.deepEqual(order, ['steering', 'close', 'source_after', 'reduce']);
  assert.deepEqual(success.order, ['steering', 'close', 'source_after']);
  assert.equal(success.outcome, 'objective_accepted_pending_independent_review');
  assert.equal(evidence.trialAccepted, null);

  const closeOrder = [];
  const closeEvidence = acceptedEvidence();
  let closeCalls = 0;
  const closeFailure = await runner.finalizationSequence({
    evidence: closeEvidence,
    awaitSteering: async () => { closeOrder.push('steering'); },
    closeRuntime: async () => {
      closeOrder.push('close');
      const lifecycle = await runner.closeWithEvidence({ runtime: { async close() { closeCalls += 1; throw new Error('close failed'); } },
        evidence: closeEvidence, captureBeforeClose: async () => ({ complete: true }),
        captureAfterClose: async () => ({ complete: true }) });
      closeEvidence.close = lifecycle.closeSafe ? { status: 'closed' } : { status: 'failed' };
    },
    captureSourceAfter: async () => { closeOrder.push('source_after'); },
    reduce: async () => { closeOrder.push('reduce'); return runner.finalizeCollector(closeEvidence); },
  });
  assert.equal(closeCalls, 1);
  assert.deepEqual(closeOrder, ['steering', 'close', 'source_after', 'reduce']);
  assert.equal(closeFailure.outcome, 'incomplete');
  assert.equal(closeEvidence.trialAccepted, null);

  const nullBackup = acceptedEvidence();
  nullBackup.stateBackupBeforeClose = null;
  nullBackup.closeLifecycle.beforeClose.complete = false;
  assert.equal((await runFinalSequence(nullBackup, async () => {})).outcome, 'incomplete');
  const sourceFailure = acceptedEvidence();
  sourceFailure.sourceManifestAfter = null;
  const failedSourceSequence = await runFinalSequence(sourceFailure, async () => { throw new Error('source read failed'); });
  assert.equal(failedSourceSequence.outcome, 'incomplete');
  assert.equal(failedSourceSequence.failures[0].stage, 'source_after');
  const sourceDrift = acceptedEvidence();
  assert.equal((await runFinalSequence(sourceDrift, async () => { sourceDrift.sourceDrift = ['src/example.js']; })).outcome, 'incomplete');
}

async function main() {
  const interval = { startedAt: 1_700_000_000_000, completedAt: 1_700_000_010_000 };
  const applied = runner.steeringTiming({ state: 'applied', receivedAt: 1_700_000_002_000,
    updatedAt: 1_700_000_008_000 }, interval);
  assert.equal(applied.timingKnown, true);
  assert.equal(applied.receivedWithinTurn, true);
  assert.equal(applied.appliedWithinTurn, true);
  assert.equal(applied.steeringWithinWorkerTurn, true);
  const lateApply = runner.steeringTiming({ state: 'applied', receivedAt: 1_700_000_002_000,
    updatedAt: 1_700_000_011_000 }, interval);
  assert.equal(lateApply.receivedWithinTurn, true);
  assert.equal(lateApply.appliedWithinTurn, false);
  assert.equal(lateApply.steeringWithinWorkerTurn, false);
  const incompleteReceipt = runner.steeringTiming({ state: 'received', receivedAt: 1_700_000_002_000 }, interval);
  assert.equal(incompleteReceipt.timingKnown, false);
  assert.equal(incompleteReceipt.steeringWithinWorkerTurn, false);

  const observer = { knownTokenSubtotal: 0, observedTokenTotal: 0, unknownUsageCalls: 0, usageComplete: true };
  const call = {};
  const returned = { status: 'completed', usage: { model: 'model-a', effort: 'low', fastMode: 'off',
    tokens: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } } };
  assert.strictEqual(await runner.preserveRunOutcome(async () => returned,
    {}, { observer }, call), returned);
  assert.equal(call.usageOutcome, 'returned');
  assert.equal(call.authoritativeTotalTokens, 10);
  assert.equal(observer.knownTokenSubtotal, 10);

  const thrownObserver = { knownTokenSubtotal: 0, observedTokenTotal: 0, unknownUsageCalls: 0, usageComplete: true };
  const thrownCall = {};
  const originalError = new Error('native failure');
  originalError.execution = { processIdentity: { pid: 42 } };
  originalError.terminalTurn = { id: 'turn-a', status: 'failed' };
  originalError.usage = { model: 'model-a', tokens: { inputTokens: 2, totalTokens: 7 } };
  let caught;
  try { await runner.preserveRunOutcome(async () => { throw originalError; }, {}, { observer: thrownObserver }, thrownCall); }
  catch (error) { caught = error; }
  assert.strictEqual(caught, originalError);
  assert.equal(thrownCall.usageOutcome, 'thrown');
  assert.equal(thrownCall.authoritativeTotalTokens, 7);
  assert.deepEqual(thrownCall.execution, originalError.execution);
  assert.deepEqual(thrownCall.terminalTurn, originalError.terminalTurn);
  assert.equal(thrownObserver.knownTokenSubtotal, 7);

  const partialObserver = { knownTokenSubtotal: 0, observedTokenTotal: 0, unknownUsageCalls: 0, usageComplete: true };
  const partialCall = {};
  runner.recordUsage({ observer: partialObserver }, partialCall,
    { tokens: { inputTokens: 12, outputTokens: null, totalTokens: null } }, 'thrown');
  assert.deepEqual(partialCall.usage.tokens, { inputTokens: 12, outputTokens: null, totalTokens: null });
  assert.equal(partialObserver.knownTokenSubtotal, 0);
  assert.equal(partialObserver.observedTokenTotal, null);
  assert.equal(partialObserver.usageComplete, false);

  const admission = { turns: Array(19).fill({}), pendingTurnReservations: 0,
    knownTokenSubtotal: 0, unknownUsageCalls: 0 };
  assert.equal(runner.reserveNativeTurn(admission), true);
  const reservedCall = { turnReservationPending: true };
  assert.equal(admission.pendingTurnReservations, 1);
  assert.equal(runner.reserveNativeTurn(admission), false);
  runner.releaseNativeTurnReservation(admission, reservedCall);
  assert.equal(admission.pendingTurnReservations, 0);

  const semanticA = runner.semanticInput('same goal', { source: 'agent', requiredChecks: [{ id: 'check', argv: ['node', 'verify.js'], timeoutMs: 5000 }] });
  const semanticB = runner.semanticInput('same goal', { source: 'agent', requiredChecks: [{ id: 'check', argv: ['node', 'verify.js'], timeoutMs: 5000 }] });
  assert.equal(runner.hash(JSON.stringify(semanticA)), runner.hash(JSON.stringify(semanticB)));
  assert.notEqual(runner.hash(JSON.stringify(semanticA)), runner.hash(JSON.stringify(
    runner.semanticInput('same goal', { source: 'agent', requiredChecks: [{ id: 'check', argv: ['node', 'verify.js'], timeoutMs: 5001 }] }))));
  const quotaDefault = runner.parseQuotaStopOption(['concurrent-v1', '--go']);
  const quotaOverride = runner.parseQuotaStopOption(['concurrent-v1', '--go', '--quota-stop-percent=99']);
  assert.deepEqual(quotaDefault, { stopThresholdPercent: 90, thresholdOverridden: false });
  assert.equal(runner.DEFAULT_QUOTA_STOP_PERCENT, 90);
  assert.deepEqual(quotaOverride, { stopThresholdPercent: 99, thresholdOverridden: true });
  const acceptanceForThreshold = { source: 'agent', requiredChecks: [{ id: 'check', argv: ['node', 'verify.js'], timeoutMs: 5000 }] };
  const semanticDefault = runner.semanticInput('same goal', acceptanceForThreshold);
  const semanticOverride = runner.semanticInput('same goal', acceptanceForThreshold);
  assert.deepEqual(Object.keys(semanticOverride).sort(), ['acceptance', 'goal']);
  assert.equal(runner.hash(JSON.stringify(semanticOverride)), runner.hash(JSON.stringify(semanticDefault)));
  assert.equal(runner.hash(JSON.stringify(semanticOverride)), runner.hash(JSON.stringify({ goal: 'same goal', acceptance: acceptanceForThreshold })));
  assert.equal(runner.parseQuotaStopOption(['--quota-stop-percent=90']).thresholdOverridden, false);
  assert.deepEqual(runner.parseQuotaStopOption(['--quota-stop-percent=1']), { stopThresholdPercent: 1, thresholdOverridden: true });
  assert.deepEqual(runner.parseQuotaStopOption(['--quota-stop-percent=05']), { stopThresholdPercent: 5, thresholdOverridden: true });
  for (const bad of ['--quota-stop-percent=abc', '--quota-stop-percent=100', '--quota-stop-percent=0', '--quota-stop-percent=1.5',
    '--quota-stop-percent=-5', '--quota-stop-percent=+5', '--quota-stop-percent=1e1', '--quota-stop-percent=', '--quota-stop-percent']) {
    assert.throws(() => runner.parseQuotaStopOption(['concurrent-v1', bad]), /quota_stop_percent_invalid/, bad);
  }
  assert.throws(() => runner.parseQuotaStopOption(['--quota-stop-percent=95', '--quota-stop-percent=95']), /quota_stop_percent_repeated/);
  assert.throws(() => runner.parseQuotaStopOption(['--quota-stop-percent=95', '--quota-stop-percent=96']), /quota_stop_percent_repeated/);
  const observed97 = runner.quotaUsage({ rateLimits: { primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: 1 } } });
  assert.equal(observed97.primaryUsedPercent, 97);
  assert.equal(runner.quotaGate(observed97, 99), true);
  assert.equal(runner.quotaGate(observed97, 90), false);
  assert.equal(runner.quotaGate(runner.quotaUsage({ rateLimits: { primary: { usedPercent: 99 } } }), 99), false);
  assert.equal(runner.quotaGate(runner.quotaUsage({ rateLimits: { primary: { usedPercent: 98 } } }), 99), true);
  assert.equal(runner.quotaGate(runner.quotaUsage({ rateLimits: { primary: { usedPercent: 89 } } }), 90), true);
  assert.equal(runner.quotaGate(runner.quotaUsage({ rateLimits: { primary: { usedPercent: 90 } } }), 90), false);
  assert.equal(runner.quotaGate(runner.quotaUsage({}), 99), false);
  assert.equal(runner.quotaGate(null, 90), false);
  assert.deepEqual(runner.sourceDrift({ 'src/a.js': 'a' }, { 'src/a.js': 'b', 'src/b.js': 'c' }), ['src/a.js', 'src/b.js']);
  const sourceManifest = runner.captureSourceManifest();
  assert.ok(Object.keys(sourceManifest).length >= 300);
  assert.deepEqual(runner.sourceDrift(sourceManifest, sourceManifest), []);
  const frozen = runner.frozenFixtureControls();
  assert.equal(frozen.immutableCheckSha256, runner.fixtureHashes(require('node:path').join(__dirname, 'fixture'))['verify-product.js']);
  const controls = { productInputSha256: { 'format-label.js': 'a', 'sum-positive.js': 'b',
    'report.js': 'c', 'verify-product.js': 'd' }, immutableCheckSha256: 'd',
    initialNegativeControl: { exitCode: 1 }, positiveControl: { exitCode: 0 } };
  assert.equal(runner.fixtureControlsMatch(controls.productInputSha256, controls), true);
  assert.equal(runner.fixtureControlsMatch({ ...controls.productInputSha256, 'verify-product.js': 'changed' }, controls), false);

  let closeCount = 0;
  const lifecycleEvidence = {};
  const closeResult = await runner.closeWithEvidence({ runtime: { async close() { closeCount += 1; } },
    evidence: lifecycleEvidence, captureBeforeClose: async () => { throw new Error('snapshot unavailable'); },
    captureAfterClose: async () => ({ complete: true }) });
  assert.equal(closeCount, 1);
  assert.equal(closeResult.closeSafe, true);
  assert.equal(closeResult.evidenceSafe, false);
  const startupState = { startupAttempted: false, runtimeReturned: false, retainRoot: false };
  const startupError = new Error('unsafe startup cleanup');
  let startupCaught;
  try { await runner.startRuntimeSafely(async () => { throw startupError; }, {}, startupState); }
  catch (error) { startupCaught = error; }
  assert.strictEqual(startupCaught, startupError);
  assert.equal(startupState.startupAttempted, true);
  assert.equal(startupState.runtimeReturned, false);
  assert.equal(startupState.retainRoot, true);
  const successfulStartup = { startupAttempted: false, runtimeReturned: false, retainRoot: false };
  const fakeRuntime = { marker: 'mock-only' };
  assert.strictEqual(await runner.startRuntimeSafely(async () => fakeRuntime, {}, successfulStartup), fakeRuntime);
  assert.equal(successfulStartup.runtimeReturned, true);
  assert.equal(runner.shouldRetainPrivateRoot({ startupAttempted: true, runtimeReturned: false,
    closeSafe: false, evidenceSafe: false }), true);
  assert.equal(runner.shouldRetainPrivateRoot({ startupAttempted: true, runtimeReturned: true,
    closeSafe: true, evidenceSafe: true }), false);
  await finalizationProbes();
  process.stdout.write('PASS runner invariant probes (receipt, usage, admission, pins, retention, close, finalization order)\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
