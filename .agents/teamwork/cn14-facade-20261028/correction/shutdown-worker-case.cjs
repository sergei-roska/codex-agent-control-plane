test('owner correction facade preserves admitted worker contract fences and private terminal report', { timeout: 15000 }, async (t) => {
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
  await assert.rejects(fx.engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
  release.resolve();
  await waitFor(() => !fx.engine.roleService.active.size, 'old worker did not drain');
  const resumed = fx.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  t.after(async () => { abort.abort(); await resumed; });
  try { await waitFor(() => fx.engine.executor.getAttempt(attempt.attemptId).state === 'settled', 'old worker result did not settle'); }
  catch (cause) {
    t.diagnostic(JSON.stringify({ scheduler: fx.engine.controllers.get('pause-facade-run').scheduler.projection(),
      lifecycle: fx.engine.controllers.get('pause-facade-run').lifecycle.projection(),
      intent: fx.engine.executor.getAttempt(attempt.attemptId), evidence: fx.engine.executor.listEvidence(attempt.attemptId),
      attempts: fx.engine.store.listAttempts(projectId, 'engine-objective-1'),
      claims: fx.engine.store.listClaims(projectId, 'engine-objective-1'), execution: fx.engine.roleService.getExecution(attempt.attemptId) }));
    throw cause;
  }
  const settled = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId);
  assert.equal(settled.outcome.failureKind, 'publication_authorization_changed');
  assert.equal(settled.outcome.publicationState, 'not_published');
  assert.deepEqual(settled.contractSnapshot, attempt.contractSnapshot);
  const execution = fx.engine.roleService.getExecution(attempt.attemptId);
  assert.equal(execution.report.summary, 'Old contract completed privately.');
  assert.equal(fs.readFileSync(path.join(fx.lanes.store.get(execution.laneId).path, 'old-private.txt'), 'utf8'), 'retained old contract output\n');
  assert.equal(fs.existsSync(path.join(fx.workspace, 'old-private.txt')), false);
  assert.equal(workerCalls, 1);
});
