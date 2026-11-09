test('historical defect reproduction: corrected old task is resent after shutdown', { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let plannerCalls = 0;
  let workerCalls = 0;
  const roles = new Map([
    ['engineer', { id: 'engineer', name: 'Engineer', description: 'Writes private work.', sandbox: 'workspace-write', model: 'test-model', effort: 'low', fastMode: 'off' }],
    ['verifier', { id: 'verifier', name: 'Verifier', description: 'Reviews candidates.', sandbox: 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' }],
  ]);
  const fx = await createHarness(t, { roles, appServer: { async run(options) {
    const threadId = options.threadId || `${options.role.id}-correction-thread`;
    const turnId = `${options.role.id}-correction-${plannerCalls + workerCalls}`;
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId, processIdentity });
    let text;
    if (options.role.id === 'lead') {
      plannerCalls += 1;
      const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
      text = JSON.stringify({ expected: prompt.pins, delta: plannerCalls === 1
        ? planDelta(prompt.pins, [engineerTask('engine-objective-1', 'old-contract-worker', 'old-private.txt', 'retain admitted contract')]) : null,
      dialogue: null, recovery: null, ownerDecision: null });
    } else if (options.role.id === 'engineer') {
      workerCalls += 1;
      fs.writeFileSync(path.join(options.cwd, 'old-private.txt'), 'retained old contract output\n');
      entered.resolve(); await release.promise;
      text = JSON.stringify({ outcome: 'completed', summary: 'Old contract completed privately.', filesChanged: ['old-private.txt'],
        filesInspected: ['source.txt'], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
    } else {
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.verifyCandidate(), true);
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nFrozen source checked.', filesChanged: [],
        filesInspected: ['source.txt', 'verify-source.js'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Checked frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null });
    }
    return { threadId, turnId, status: 'completed', text,
      execution: { threadId, turnId, processIdentity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
  } } });
  fx.engine.authenticateOwner = () => true;
  fx.engine.ownerCorrectionAuthorized = () => true;
  const abort = new AbortController();
  const running = fx.engine.run(facadeIntake(abort.signal));
  t.after(async () => { abort.abort(); await running; });
  await entered.promise;
  const attempt = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.taskId === 'old-contract-worker');
  const claim = fx.engine.store.listClaims(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId);
  const controller = fx.engine.controllers.get('pause-facade-run');
  const before = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const message = ownerCorrectionMessage(before, 'worker-correction', `sha256:${'a'.repeat(64)}`);
  controller.receive(message);
  await waitFor(() => controller.inbox.get(message.messageId).state === 'applied', 'worker correction did not apply');
  const held = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId);
  assert.deepEqual(held.contractSnapshot, attempt.contractSnapshot);
  assert.deepEqual(held.capturedControls, attempt.capturedControls);
  assert.equal(held.fencingToken, attempt.fencingToken);
  assert.deepEqual(fx.engine.store.listClaims(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId), claim);
  fx.engine.requestPause('pause-facade-run');
  assert.equal((await running).pause.kind, 'owner_pause');
  const closing = fx.engine.shutdown();
  release.resolve();
  await closing;
  const afterClose = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const old = afterClose.tasks.find((row) => row.taskId === 'old-contract-worker');
  console.log('POST_SHUTDOWN', JSON.stringify({ oldTaskState: old.state, goalRevision: afterClose.goalRevision,
    oldAttemptControls: attempt.capturedControls, oldTaskObjective: old.objective }));
  assert.equal(old.state, 'queued');
  const resumed = fx.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  t.after(async () => { abort.abort(); await resumed; });
  await waitFor(() => workerCalls >= 2, 'old task was not resent');
  const attempts = fx.engine.store.listAttempts(projectId, 'engine-objective-1').filter((row) => row.taskId === 'old-contract-worker');
  console.log('RESENT_OLD_TASK', JSON.stringify({ workerCalls, attempts: attempts.map((row) => ({ attemptId: row.attemptId,
    state: row.state, objective: row.contractSnapshot.objective, capturedControls: row.capturedControls })) }));
  assert.equal(workerCalls, 2);
  fx.engine.requestPause('pause-facade-run');
  await resumed;
});
