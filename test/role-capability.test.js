'use strict';

// M4 exit gate: every public role has a reproducible capability case (scripts/role-capability-check.js).
// Fake protocol only: proves routing, scope/sandbox accounting, report validation and plan binding.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CASES, runCase, runAll, assignmentFor, createHybridAppServer, formatHybridTrace, formatTable, harnessRunOutcome, hybridLeadDecision, modeFlagError, stageFailureDetail, planBindingProblems } = require('../scripts/role-capability-check');
const { WORKER_REPORT_SCHEMA, DECISION_SCHEMA } = require('../src/contracts');

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

const caseById = (id) => CASES.find((entry) => entry.id === id);
const joined = (result) => result.problems.join('\n');

test('live plan binding follows required preset keys while scripted plans keep exact stage ids', () => {
  const expected = [
    { stageId: 'investigate', presetStageKey: 'investigate', roleId: 'architect' },
    { stageId: 'synthesis', presetStageKey: 'synthesis', roleId: 'reviewer' },
  ];
  const pack = { publicToRuntime: (role) => ({ architect: 'dlv-architect', reviewer: 'dlv-reviewer' })[role] };
  const renamed = { stages: [
    { stageId: 'inspect-ticket', presetStageKey: 'investigate', roleId: 'dlv-architect' },
    { stageId: 'summarize-findings', presetStageKey: 'synthesis', roleId: 'dlv-reviewer' },
  ] };

  assert.deepEqual(planBindingProblems(renamed, expected, pack, { matchPresetStageKeys: true }), []);
  assert.deepEqual(planBindingProblems(renamed, expected, pack), [
    'plan lost stage investigate',
    'plan lost stage synthesis',
  ]);

  const missing = { stages: renamed.stages.slice(0, 1) };
  assert.deepEqual(planBindingProblems(missing, expected, pack, { matchPresetStageKeys: true }), [
    'plan lost required preset stage synthesis',
  ]);

  const wrongRole = { stages: [
    renamed.stages[0],
    { ...renamed.stages[1], roleId: 'dlv-security' },
  ] };
  assert.deepEqual(planBindingProblems(wrongRole, expected, pack, { matchPresetStageKeys: true }), [
    'preset stage synthesis bound to dlv-security, expected dlv-reviewer',
  ]);

  const duplicate = { stages: [...renamed.stages, { ...renamed.stages[1], stageId: 'second-synthesis' }] };
  assert.deepEqual(planBindingProblems(duplicate, expected, pack, { matchPresetStageKeys: true }), [
    'plan duplicated required preset stage synthesis',
  ]);
});

test('stage failure diagnostics include bounded outcome metadata and omit report prose', () => {
  const detail = stageFailureDetail({
    stageId: 'reproduce',
    status: 'eligible',
  }, [{ stageId: 'reproduce', result: {
    status: 'TASK_STATE_COMPLETED',
    report: { outcome: 'completed', summary: 'private access_token=secret prose' },
    attestedDeltaKnown: false,
    attestedScopeViolations: ['src/private.js'],
    scopeViolations: ['src/other.js'],
    writerExecution: {
      state: 'reconciled',
      reason: 'execution_finished',
      delta: {
        known: false,
        reason: 'ambiguous_access_token=secret',
        kind: 'unresolved',
        changedPaths: Array.from({ length: 13 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.js`),
      },
    },
  } }]);
  assert.match(detail, /TASK_STATE_COMPLETED/);
  assert.match(detail, /"reportOutcome":"completed"/);
  assert.match(detail, /"attestedDeltaKnown":false/);
  assert.match(detail, /"attestedScopeViolations":\["src\/private\.js"\]/);
  assert.match(detail, /"scopeViolations":\["src\/other\.js"\]/);
  assert.match(detail, /"kind":"unresolved"/);
  assert.match(detail, /src\/file-11\.js/);
  assert.doesNotMatch(detail, /src\/file-12\.js/);
  assert.match(detail, /\[REDACTED\]/);
  assert.doesNotMatch(detail, /private prose|secret/);
  assert.ok(detail.length <= 600);
});

test('reviewer and security accept severity-tagged exact findings from summary', () => {
  const reviewer = caseById('reviewer');
  const reviewerLine = reviewer.files['src/price.js'].split('\n').findIndex((entry) => /subtotal \* 1\.0825/.test(entry)) + 1;
  const reviewerReport = {
    summary: `[High] src/price.js:${reviewerLine} returns a float despite the integer cents contract.`,
    risks: ['Caveat: verify rounding behavior in a separate review.'],
    filesInspected: ['src/price.js'],
    filesChanged: [],
  };
  assert.deepEqual(reviewer.check({ def: reviewer, firstCall: () => ({ report: reviewerReport }), fixtureText: (file) => reviewer.files[file] }), []);

  const security = caseById('security');
  const securityLine = security.files['src/admin.js'].split('\n').findIndex((entry) => /router\.delete/.test(entry)) + 1;
  const securityReport = {
    summary: `[High] src/admin.js:${securityLine} registers DELETE /users/:id without requireAdmin, allowing unauthenticated deletion; add the authorization guard.`,
    risks: ['Caveat: confirm the deployment also enforces network controls.'],
    filesInspected: ['src/admin.js'],
    filesChanged: [],
  };
  assert.deepEqual(security.check({ def: security, firstCall: () => ({ report: securityReport }), fixtureText: (file) => security.files[file] }), []);
});

test('security does not accept a caveat without a severity-tagged exact finding', () => {
  const security = caseById('security');
  const report = {
    summary: 'The route configuration has a caveat for follow-up.',
    risks: ['Caveat: authorization should be reviewed.'],
    filesInspected: ['src/admin.js'],
    filesChanged: [],
  };
  const problems = security.check({ def: security, firstCall: () => ({ report }), fixtureText: (file) => security.files[file] });
  assert.ok(problems.some((problem) => /findings carry no severity/.test(problem)));
  assert.ok(problems.some((problem) => /did not cite the seeded location src\/admin\.js:/.test(problem)));
});

test('hybrid assignments carry case-specific ticket and plan contracts without answer leakage', () => {
  const architect = caseById('architect');
  const architectAssignment = assignmentFor(architect, architect.runtime, 'investigate');
  const architectText = JSON.stringify(architectAssignment);
  assert.match(architectAssignment.objective, /Map order\.js dependencies/);
  assert.ok(architectAssignment.inputs.some((entry) => entry.includes(architect.ticket.description)));
  assert.ok(architectAssignment.inputs.some((entry) => entry.includes('src/order.js')));
  assert.ok(architectAssignment.acceptanceCriteria.some((entry) => entry.includes(architect.ticket.criteria[0])));
  assert.deepEqual(architectAssignment.allowedFiles, []);
  assert.ok(architectAssignment.stopConditions.some((entry) => /allowedFiles as the write boundary/.test(entry)));
  assert.ok(architectAssignment.stopConditions.some((entry) => /follow only verified local require\/import edges transitively/.test(entry)));
  assert.doesNotMatch(architectText, /src\/order\.js\s*->|src\/price\.js|src\/tax\.js|unrelated\.js/);

  const qa = caseById('qa');
  const qaAssignment = assignmentFor(qa, qa.runtime, 'reproduce', ['test/tiny.test.js']);
  assert.match(qaAssignment.objective, /greet\(\) returns the wrong text/);
  assert.ok(qaAssignment.inputs.some((entry) => entry.includes(qa.ticket.description)));
  assert.ok(qaAssignment.inputs.some((entry) => entry.includes('src/greet.js') && entry.includes('test/tiny.test.js')));
  assert.ok(qaAssignment.acceptanceCriteria.some((entry) => entry.includes(qa.ticket.criteria[0])));
  assert.deepEqual(qaAssignment.allowedFiles, ['test/tiny.test.js']);
  assert.deepEqual(qaAssignment.checks, ['node --test test/tiny.test.js']);
  assert.ok(qaAssignment.stopConditions.some((entry) => /outside the ticket scope/.test(entry)));

  const isolatedCases = [
    ['performance', 'perf', ['bench/result.json'], ['node bench/run.js'], /MEASURED:|HYPOTHESIS:|iterations in \d+/],
    ['devops', 'setup', ['scripts/setup.js'], ['node scripts/setup.js'], /setup ok|API_TOKEN=/],
    ['tech-writer', 'write', ['docs/guide.md'], [`node -e "console.log(require('./src/greet')())"`], /Output:\s*`hello`/],
  ];
  for (const [id, stageId, allowedFiles, checks, answerPattern] of isolatedCases) {
    const def = caseById(id);
    assert.equal(def.liveWorkersIsolation, true, `${id} must be isolated to its focus role in live-workers mode`);
    const isolated = assignmentFor(def, def.focus, stageId);
    assert.deepEqual(isolated.allowedFiles, allowedFiles, `${id} allowedFiles`);
    assert.deepEqual(isolated.checks, checks, `${id} assigned checks`);
    assert.doesNotMatch(JSON.stringify(isolated), answerPattern, `${id} assignment leaks the expected answer`);
  }
});

test('role capability cases', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('there is one case per public role plus the repair chain', () => {
    assert.deepEqual(CASES.map((entry) => entry.role).sort(), [
      'architect', 'developer', 'developer (repair chain)', 'devops', 'performance', 'project-manager', 'qa', 'reviewer', 'security', 'tech-writer',
    ]);
  });

  await suite.test('all ten cases pass on the fake protocol', async () => {
    const results = await runAll({ mode: 'fake' });
    assert.equal(results.length, 10);
    for (const result of results) assert.equal(result.ok, true, `${result.id}: ${joined(result)}`);
  });

  // Negative controls: each mutates one fake behavior and must be flagged.

  await suite.test('control: a read-only role that writes a file is flagged', async () => {
    const result = await runCase(caseById('security'), {
      behavior: (ctx, original) => {
        const out = original(ctx);
        if (ctx.role !== 'dlv-security') return out;
        return { ...out, writes: { 'src/admin.js': "'use strict';\n// patched by a read-only role\n" } };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /read-only role dlv-security changed files: src\/admin\.js/);
  });

  await suite.test('control: a developer editing outside allowedFiles is flagged', async () => {
    const result = await runCase(caseById('developer'), {
      behavior: (ctx, original) => {
        const out = original(ctx);
        if (ctx.role !== 'dlv-developer') return out;
        return {
          report: { ...out.report, filesChanged: ['src/greet.js', 'src/other.js'] },
          writes: { 'src/other.js': "module.exports = () => 'changed outside scope';\n" },
        };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /dlv-developer changed files outside allowedFiles \[src\/greet\.js\]: src\/other\.js/);
  });

  await suite.test('control: a QA report missing the seeded failure is flagged', async () => {
    const result = await runCase(caseById('qa'), {
      behavior: (ctx, original) => {
        if (ctx.role !== 'dlv-qa' || ctx.stageId !== 'reproduce') return original(ctx);
        return {
          report: {
            ...original(ctx).report,
            summary: 'looked fine',
            checks: [{ command: 'node --test test/tiny.test.js', result: 'passed', detail: 'not actually run' }],
            risks: [],
          },
        };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /QA did not report the seeded failure/);
  });

  await suite.test('QA may report observed behavior separately when runner output omits assertion text', async () => {
    const result = await runCase(caseById('qa'), {
      behavior: (ctx, original) => {
        const out = original(ctx);
        if (ctx.role !== 'dlv-qa' || ctx.stageId !== 'reproduce') return out;
        return {
          ...out,
          report: {
            ...out.report,
            summary: 'The approved check failed; src/greet.js returns helo, expected hello.',
            filesInspected: ['src/greet.js', 'test/tiny.test.js'],
            checks: [{
              command: 'node --test test/tiny.test.js',
              result: 'failed',
              detail: 'node --test test/tiny.test.js: one test failed; runner omitted assertion values.',
            }],
            risks: [],
          },
        };
      },
    });
    assert.equal(result.ok, true, joined(result));
  });

  await suite.test('control: a reviewer citing the wrong location is flagged', async () => {
    const result = await runCase(caseById('reviewer'), {
      behavior: (ctx, original) => {
        const out = original(ctx);
        if (ctx.role !== 'dlv-reviewer' || ctx.stageId !== 'investigate') return out;
        return { report: { ...out.report, risks: ['[high] src/price.js:99 - looks wrong somewhere'] } };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /did not cite the seeded location src\/price\.js:5/);
  });

  await suite.test('control: a repair executor on the wrong model or effort is flagged', () => {
    const { loadRolePack } = require('../src/role-pack');
    const pack = loadRolePack();
    const xhigh = pack.repairProfiles.get('dlv-developer-xhigh');
    const sol = pack.repairProfiles.get('dlv-developer-sol');
    const call = (role, profile, over) => ({ role, model: profile.model, effort: profile.effort, report: { outcome: 'failed' }, observedDelta: [], ...over });
    const run = (calls) => caseById('repair-chain').check({ calls, pack, view: { stages: [], candidate: {} } }).join('\n');
    const dev = { role: 'dlv-developer', model: 'm', effort: 'e', report: { outcome: 'failed' }, observedDelta: [] };
    assert.doesNotMatch(run([dev, call('dlv-developer-xhigh', xhigh), call('dlv-developer-sol', sol)]), /ran on|ran at effort/);
    assert.match(run([dev, call('dlv-developer-xhigh', xhigh, { model: 'wrong-model' }), call('dlv-developer-sol', sol)]), /dlv-developer-xhigh ran on wrong-model/);
    assert.match(run([dev, call('dlv-developer-xhigh', xhigh), call('dlv-developer-sol', sol, { effort: 'bogus' })]), /dlv-developer-sol ran at effort bogus/);
  });

  await suite.test('a thrown worker call is reported with a bounded, redacted diagnostic', async () => {
    const result = await runCase(caseById('developer'), {
      behavior: (ctx) => {
        if (ctx.role === 'dlv-developer') throw new Error(`worker timed out; api_key=sk-1234567890 ${'x'.repeat(600)}`);
        return {};
      },
    });
    const summary = joined(result);
    assert.equal(result.ok, false);
    assert.match(summary, /dlv-developer App Server error: worker timed out; api_key=\[REDACTED\]/);
    assert.doesNotMatch(summary, /sk-1234567890|Error: worker|at .*role-capability/);
    const diagnostic = result.problems.find((problem) => problem.includes('dlv-developer App Server error:'));
    assert.ok(diagnostic.length < 460);
  });

  await suite.test('live mode refuses to run without the quota acknowledgement', () => {
    const script = path.join(__dirname, '..', 'scripts', 'role-capability-check.js');
    const refused = spawnSync(process.execPath, [script, '--live'], { encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--i-understand-this-uses-my-quota/);
    assert.match(refused.stderr, /ChatGPT plan usage/);
  });
});

test('live-workers router scripts planning and sends worker reports to the real server', async () => {
  const plannerCalls = [];
  const workerCalls = [];
  const planner = { run: async (args) => { plannerCalls.push(args); return { text: 'scripted' }; } };
  const workers = { run: async (args) => { workerCalls.push(args); return { text: 'real worker' }; } };
  const appServer = createHybridAppServer(planner, workers);
  const recorded = [];
  const inner = appServer.run.bind(appServer);
  appServer.run = async (args) => { recorded.push(args); return inner(args); };

  assert.equal((await appServer.run({ role: { name: 'dlv-project-manager' }, outputSchema: DECISION_SCHEMA })).text, 'scripted');
  assert.equal((await appServer.run({ role: { name: 'dlv-developer' }, outputSchema: WORKER_REPORT_SCHEMA })).text, 'real worker');
  assert.equal(plannerCalls.length, 1);
  assert.equal(workerCalls.length, 1);
  assert.equal(recorded.length, 2);
  assert.deepEqual(appServer.hybridTrace().counts, { planner: 1, worker: 1, total: 2, dropped: 0 });
  assert.match(formatHybridTrace(appServer), /dlv-project-manager\/lead-decision\/scripted-planner\/lead-planning\/completed/);
  assert.match(formatHybridTrace(appServer), /dlv-developer\/worker-report\/real-worker\/worker-turn\/completed/);
});

test('live-workers can isolate one real focus role while prerequisite workers use explicit fixture routing', async () => {
  const plannerCalls = [];
  const workerCalls = [];
  const skipped = [];
  const planner = {
    run: async (args) => { plannerCalls.push(args); return { text: 'scripted prerequisite' }; },
    skipLiveWorker: (role) => skipped.push(role),
  };
  const workers = { run: async (args) => { workerCalls.push(args); return { text: 'real focus report' }; } };
  const appServer = createHybridAppServer(planner, workers, { realWorkerRoles: ['dlv-performance'] });
  const fixture = await appServer.run({ role: { name: 'dlv-developer' }, outputSchema: WORKER_REPORT_SCHEMA });
  const focus = await appServer.run({ role: { name: 'dlv-performance' }, outputSchema: WORKER_REPORT_SCHEMA });
  const trace = appServer.hybridTrace();

  assert.equal(fixture.text, 'scripted prerequisite');
  assert.equal(focus.text, 'real focus report');
  assert.equal(plannerCalls.length, 1);
  assert.equal(workerCalls.length, 1);
  assert.deepEqual(skipped, ['dlv-performance']);
  assert.deepEqual(trace.entries.map((entry) => entry.route), ['scripted-worker', 'real-worker']);
  assert.deepEqual(trace.counts, { planner: 1, worker: 1, total: 2, dropped: 0 });
});

test('live-workers success output states real and scripted role provenance', () => {
  const output = formatTable([{
    id: 'performance',
    ok: true,
    problems: [],
    provenance: {
      planning: 'scripted Intake and lead decisions',
      realWorkerRoles: ['dlv-performance'],
      scriptedWorkerRoles: ['dlv-architect', 'dlv-developer', 'dlv-qa', 'dlv-reviewer'],
      preparedCandidate: 'the required implement stage ran the case scripted fixture behavior before the real focus role',
    },
  }]);
  assert.match(output, /real performance specialist/);
  assert.match(output, /real worker roles: dlv-performance/);
  assert.match(output, /scripted worker roles: dlv-architect, dlv-developer, dlv-qa, dlv-reviewer/);
  assert.match(output, /prepared candidate: the required implement stage ran the case scripted fixture behavior/);
  assert.doesNotMatch(output, /performance fake really runs the benchmark/);
});

test('live-workers trace records failed scripted planning calls without prompts or errors', async () => {
  const planner = { run: async () => { throw new Error('planner failed api_key=sk-secret'); } };
  const workers = { run: async () => ({ text: 'unused' }) };
  const appServer = createHybridAppServer(planner, workers);

  await assert.rejects(appServer.run({
    role: { name: 'dlv-project-manager' },
    input: 'private planning prompt',
    outputSchema: DECISION_SCHEMA,
  }), /planner failed/);

  const summary = formatHybridTrace(appServer);
  assert.match(summary, /planner=1 worker=0 total=1/);
  assert.match(summary, /dlv-project-manager\/lead-decision\/scripted-planner\/lead-planning\/failed/);
  assert.doesNotMatch(summary, /private planning prompt|sk-secret|planner failed/);
});

test('harness reports interrupted execution errors promptly but leaves resumable Intake pauses pending', () => {
  const interrupted = harnessRunOutcome({
    status: 'interrupted',
    phase: 'engineering',
    waitReason: 'execution_error',
    waitDetail: { code: 'run_error', message: `worker failed api_key=sk-secret ${'x'.repeat(500)}` },
  }, 'blocked');
  assert.ok(interrupted);
  assert.match(interrupted.diagnostic, /status=interrupted phase=engineering waitReason=execution_error code=run_error/);
  assert.match(interrupted.diagnostic, /api_key=\[REDACTED\]/);
  assert.ok(interrupted.diagnostic.length <= 600);
  assert.doesNotMatch(interrupted.diagnostic, /sk-secret/);
  assert.ok(interrupted.diagnostic.length < 400);

  assert.equal(harnessRunOutcome({
    status: 'paused',
    phase: 'awaiting_answer',
    waitReason: 'human_decision',
    waitDetail: { code: 'intake_clarification', message: 'waiting for user answer' },
  }, 'waiting_human'), null);

  const operatorInput = harnessRunOutcome({
    status: 'paused',
    phase: 'awaiting_answer',
    waitReason: 'human_decision',
    waitDetail: { code: 'lead_decision', message: 'Choose an option' },
  }, 'waiting_human');
  assert.match(operatorInput.diagnostic, /run requires operator input before settling/);
});

test('hybrid scripted lead resolves valid worker recommendations and defers invalid ones to the operator', () => {
  const fallback = { action: 'finish', assignments: [], final: 'Done.', resolutions: [], humanInput: null };
  const promptFor = (decisions) => `Open worker decisions (each must be resolved in resolutions, or listed in humanInput.relatedDecisionIds):\n${JSON.stringify(decisions)}\n\nPrior worker outcomes: []`;
  const request = (recommendation) => ({
    question: 'Which implementation should be used?',
    options: [{ id: 'existing', description: 'Use existing API' }, { id: 'new', description: 'Add a new helper' }],
    evidenceChecked: ['src/example.js'],
    recommendation,
    consequenceIfWrong: 'The API may not fit.',
  });

  const resolved = hybridLeadDecision(promptFor([{ id: 'decision-a', request: request('existing') }]), fallback);
  assert.equal(resolved.action, 'finish');
  assert.equal(resolved.final, fallback.final);
  assert.deepEqual(resolved.resolutions, [{
    decisionId: 'decision-a',
    choice: 'existing',
    rationale: 'The scripted hybrid fixture follows the worker recommendation as its bounded choice.',
  }]);

  const deferred = hybridLeadDecision(promptFor([
    { id: 'decision-a', request: request('invalid-id') },
    { id: 'decision-b', request: request('new') },
  ]), fallback);
  assert.equal(deferred.action, 'request_human_input');
  assert.deepEqual(deferred.humanInput.relatedDecisionIds, ['decision-a', 'decision-b']);
  assert.equal(deferred.humanInput.recommendation, 'defer');
  assert.equal(deferred.resolutions.length, 0);
  assert.deepEqual(hybridLeadDecision('No open decisions here.', fallback), fallback);
});

test('live-workers mode validates quota acknowledgement and rejects conflicting modes', () => {
  const base = { live: false, liveWorkers: false, explicitFake: false, acknowledged: false };
  assert.match(modeFlagError({ ...base, liveWorkers: true }), /--i-understand-this-uses-my-quota/);
  assert.match(modeFlagError({ ...base, live: true, liveWorkers: true, acknowledged: true }), /Choose either --live or --live-workers/);
  assert.match(modeFlagError({ ...base, explicitFake: true, liveWorkers: true, acknowledged: true }), /--fake cannot be combined/);
  assert.match(modeFlagError({ ...base, acknowledged: true }), /only valid with --live or --live-workers/);
  assert.equal(modeFlagError({ ...base, liveWorkers: true, acknowledged: true }), null);
});
