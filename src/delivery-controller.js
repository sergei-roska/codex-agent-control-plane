'use strict';

// Delivery controller (D-M3-6): one in-process loop that drives runs through
// queued -> intake -> (awaiting_answer) -> branch -> engineering -> candidate -> settled.
// Every step reads durable state, performs one idempotent action and persists the next phase
// in a single store transaction; events are recorded afterwards and never drive state.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TaskState } = require('@a2a-js/sdk');
const {
  INTAKE_SCHEMA, MAX_INTAKE_TURNS, MAX_EXTRACTED_CHARS, PROMPT_VERSION, createPmLeadRole, buildIntakePrompt,
  validateIntakeOutput, renderRequirementsGoal,
} = require('./intake');
const { VALIDATOR_VERSION, WRITABLE_STAGE_ROLES } = require('./plan-validator');
const { ProductError, canonicalJson } = require('./product-store');
const { WriterAdmission } = require('./writer-admission');
const { takeSnapshot } = require('./workspace-snapshot');

const LEAD_PROMPT_VERSION = 'pm-lead-v1';
const DEFAULT_TICK_MS = 2000;
const MAX_STEPS_PER_RUN = 12;
const MAX_MESSAGE_CHARS = 500;
const OUTPUT_TAIL_CHARS = 4096;
const ROLE_MAPPING = Object.freeze({
  'orch-builder': 'Developer (writes product code within allowedFiles)',
  'orch-verifier': 'QA (independent verification)',
  'orch-auditor': 'Reviewer (independent review, read-only)',
  'orch-explorer': 'technical investigation (read-only)',
  'orch-architect': 'narrow technical second opinion (read-only)',
  'orch-scout': 'mechanical inventory (read-only)',
});
const UNRESOLVED_PAUSE_KINDS = Object.freeze(['writer_unresolved', 'restart']);
const PAUSE_WAIT_REASONS = Object.freeze({
  waiting_for_budget: 'budget',
  restart: 'restart',
  writer_unresolved: 'writer_unresolved',
  error: 'execution_error',
});

/** sha256 over TEAM.md and every profile file, in a stable order. */
function computeRolePackHash(profilesDir) {
  const hash = crypto.createHash('sha256');
  const team = path.join(profilesDir, 'TEAM.md');
  hash.update('TEAM.md\0');
  if (fs.existsSync(team)) hash.update(fs.readFileSync(team));
  const agentsDir = path.join(profilesDir, 'agents');
  const names = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((name) => name.endsWith('.toml')).sort() : [];
  for (const name of names) {
    hash.update(`\0agents/${name}\0`);
    hash.update(fs.readFileSync(path.join(agentsDir, name)));
  }
  return hash.digest('hex');
}

/** Settings pinned on a run at submit time (D-M3-6). */
function buildSettingsSnapshot({ roles, leadRole, projectConfig, rolePackHash = null, appServerVersion = null }) {
  const roleSettings = {};
  for (const [id, role] of roles || []) roleSettings[id] = { model: role.model, effort: role.effort, sandbox: role.sandbox };
  return {
    provider: 'openai',
    runtimeAdapter: 'codex-app-server',
    rolePack: 'legacy-orch',
    rolePackHash,
    leadModel: leadRole ? leadRole.model : null,
    leadEffort: leadRole ? leadRole.effort : null,
    roles: roleSettings,
    promptVersions: { intake: PROMPT_VERSION, lead: LEAD_PROMPT_VERSION },
    projectPolicyRevision: projectConfig ? projectConfig.revision : null,
    appServerVersion,
  };
}

function planHashOf(plan) {
  const body = { classification: plan.classification, stages: plan.stages, checkIds: plan.checkIds };
  return crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function requiredChecksOf(plan) {
  return plan.checks.map(({ id, argv, timeoutMs }) => ({ id, argv, timeoutMs }));
}

/** Metadata of the first user message that carries any (the lead task's original request). */
function firstMessageMetadata(task) {
  for (const message of (task && task.history) || []) {
    if (message && message.role === 1 && message.metadata && typeof message.metadata === 'object') return message.metadata;
  }
  return {};
}

function shorten(text, max = MAX_MESSAGE_CHARS) {
  const value = String(text === undefined || text === null ? '' : text);
  return value.length > max ? value.slice(0, max) : value;
}

function messageText(message) {
  const parts = message && Array.isArray(message.parts) ? message.parts : [];
  return parts.map((part) => (part && part.content && part.content.$case === 'text' ? part.content.value : (typeof part?.text === 'string' ? part.text : '')))
    .filter(Boolean).join('\n');
}

function checkView(check) {
  const stdout = typeof check.stdoutTail === 'string' ? check.stdoutTail : '';
  const stderr = typeof check.stderrTail === 'string' ? check.stderrTail : '';
  return {
    id: check.id,
    exitCode: check.exitCode === undefined ? null : check.exitCode,
    timedOut: Boolean(check.timedOut),
    durationMs: Number.isFinite(check.durationMs) ? check.durationMs : 0,
    outputTail: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.slice(-OUTPUT_TAIL_CHARS),
  };
}

function createDeliveryController({
  store, artifactStore, gitAdapterFactory, projectConfig, appServer, leadRole, roles, leadClient, taskReader,
  usageLedger, events, now, workspace, writerAdmission, tickMs = DEFAULT_TICK_MS, rolePackHash = null, appServerVersion = null, logger,
} = {}) {
  for (const [name, value] of Object.entries({ store, artifactStore, gitAdapterFactory, projectConfig, appServer, leadRole, leadClient, taskReader })) {
    if (!value) throw new TypeError(`createDeliveryController requires ${name}`);
  }
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('createDeliveryController requires workspace');
  const clock = () => {
    const value = typeof now === 'function' ? now() : now;
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
  };
  const pmRole = createPmLeadRole(leadRole);
  let admission = writerAdmission || null;
  // Read-only view of the workspace writer holder (active or unresolved), or null when the workspace is free.
  function writerHolder() {
    if (!admission) admission = new WriterAdmission({ db: store.db, workspace });
    return admission.holder();
  }
  const log = logger || ((message) => process.stderr.write(`${message}\n`));

  let stopped = true;
  let timer = null;
  let abort = new AbortController();
  let current = Promise.resolve();
  let scheduled = null;
  // Lead-decision answers already handed to the lead task in this process, to avoid resending while it resumes.
  const sentAnswers = new Map();
  const lastErrors = new Map();
  // Runs whose lead task is being cancelled by a ticket cancel; the loop leaves them alone meanwhile.
  const cancelling = new Set();

  function emit(type, run, payload) {
    try { events?.record(type, { runId: run.runId, ticketId: run.ticketId, payload }); } catch (_) { /* diagnostic only */ }
  }

  function reportError(key, error) {
    const text = `Delivery controller: ${key}: ${error && error.message ? error.message : String(error)}`;
    if (lastErrors.get(key) === text) return;
    lastErrors.set(key, text);
    try { log(text); } catch (_) { /* logging never breaks the loop */ }
  }

  function settle(run, patch) {
    const settled = store.settleRun(run.runId, patch);
    if (settled) {
      emit('run_settled', run, { status: patch.status, phase: 'settled', waitReason: patch.waitReason, code: patch.waitDetail && patch.waitDetail.code });
    }
    return settled;
  }

  function planOf(run) {
    const plan = run.planRevisionId ? store.getPlanRevision(run.planRevisionId) : null;
    if (!plan) throw new Error(`run ${run.runId} has no saved plan`);
    return plan;
  }

  function isWritable(plan) {
    return plan.stages.some((stage) => WRITABLE_STAGE_ROLES.includes(stage.roleId));
  }

  // ---------------------------------------------------------------- intake

  function extractedTextOf(artifact) {
    try {
      let text = artifactStore.read(artifact.storageRef).toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
    } catch (_) {
      return null;
    }
  }

  function priorTurnsOf(run) {
    const records = store.listIntakeRecords(run.runId).filter((record) => record.valid && record.output && record.output.readiness === 'needs_input');
    const decisions = store.listDecisions(run.runId).filter((decision) => decision.kind === 'intake_clarification');
    const turns = [];
    records.forEach((record, index) => {
      const decision = decisions[index];
      if (decision && decision.state === 'answered' && decision.answer) turns.push({ output: record.output, answers: decision.answer.answers || [] });
    });
    return turns;
  }

  function recordIntakeUsage(run, turn, attempt, source, outcome) {
    if (!usageLedger) return;
    try {
      const usage = source && source.usage ? source.usage : null;
      const startedAt = usage && usage.startedAt ? usage.startedAt : clock().toISOString();
      usageLedger.record({
        entryId: `intake:${run.runId}:t${turn}:a${attempt}:${startedAt}`,
        kind: 'intake_turn',
        runId: run.runId,
        role: pmRole.name,
        model: usage?.model ?? pmRole.model ?? null,
        effort: usage?.effort ?? pmRole.effort ?? null,
        startedAt,
        elapsedMs: usage?.elapsedMs ?? null,
        turns: usage?.turns ?? null,
        modelRequests: usage?.modelRequests ?? null,
        tokens: usage?.tokens ?? null,
        tokenSource: usage?.tokenSource ?? 'unavailable',
        cumulativeTotal: usage?.cumulativeTotal ?? null,
        appServerVersion: usage?.appServerVersion ?? null,
        outcome,
        permissionEvents: Array.isArray(source?.permissionEvents) ? source.permissionEvents : [],
      });
    } catch (_) { /* usage recording never breaks a run */ }
  }

  function parseIntake(text) {
    try {
      return { value: JSON.parse(text), error: null };
    } catch (_) {
      return { value: null, error: { path: '', message: 'output is not valid JSON' } };
    }
  }

  async function stepIntake(run) {
    const turn = run.intakeTurns + 1;
    if (turn > MAX_INTAKE_TURNS) {
      settle(run, {
        status: 'failed', releaseLease: true, ticketStatus: 'blocked', waitReason: 'execution_error',
        waitDetail: { code: 'intake_exhausted', message: `Intake did not converge within ${MAX_INTAKE_TURNS} turns` },
      });
      return true;
    }
    const revision = store.getRevision(run.ticketId, run.revisionId);
    const artifacts = (revision.artifactIds || []).map((id) => store.getArtifact(id)).filter(Boolean);
    const extractedTexts = new Map();
    for (const artifact of artifacts) {
      if (artifact.extraction !== 'extracted') continue;
      const text = extractedTextOf(artifact);
      if (text !== null) extractedTexts.set(artifact.artifactId, text);
    }
    const basePrompt = buildIntakePrompt({
      revision, artifacts, extractedTexts, priorTurns: priorTurnsOf(run), projectConfig, roleMapping: ROLE_MAPPING,
    });

    let value = null;
    let errors = [];
    let lastRaw = null;
    for (let attempt = 1; attempt <= 2 && !value; attempt += 1) {
      const input = attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nYour previous answer was rejected. Fix these problems and answer again with JSON only:\n${errors.map((e) => `- ${e.path || 'output'}: ${e.message}`).join('\n')}`;
      let result;
      try {
        result = await appServer.run({ role: pmRole, cwd: workspace, input, outputSchema: INTAKE_SCHEMA, signal: abort.signal });
      } catch (error) {
        // Shutdown mid-turn: nothing is persisted, the turn is repeated on the next start (read-only).
        if (stopped || abort.signal.aborted || error?.name === 'AbortError') return false;
        recordIntakeUsage(run, turn, attempt, error, 'error');
        settle(run, {
          status: 'failed', releaseLease: true, ticketStatus: 'blocked', waitReason: 'execution_error',
          waitDetail: { code: 'intake_error', message: shorten(error?.message || String(error)) },
        });
        return true;
      }
      if (stopped) return false;
      recordIntakeUsage(run, turn, attempt, result, result?.status || 'completed');
      if (result && result.status && result.status !== 'completed') {
        settle(run, {
          status: 'failed', releaseLease: true, ticketStatus: 'blocked', waitReason: 'execution_error',
          waitDetail: { code: 'intake_error', message: `The intake turn ended with status ${shorten(result.status, 80)}` },
        });
        return true;
      }
      const parsed = parseIntake(result?.text);
      lastRaw = parsed.value;
      if (parsed.error) {
        errors = [parsed.error];
        continue;
      }
      const validation = validateIntakeOutput(parsed.value, { projectConfig });
      if (validation.ok) value = validation.value;
      else errors = validation.errors;
    }

    if (!value) {
      emit('intake_completed', run, { turn, outcome: 'invalid', count: errors.length });
      settle(run, {
        status: 'failed', releaseLease: true, ticketStatus: 'blocked', waitReason: 'execution_error',
        waitDetail: {
          code: 'intake_invalid',
          message: 'Intake output was invalid after one corrective retry',
          problems: errors.slice(0, 10).map((e) => ({ code: 'invalid_output', message: shorten(`${e.path ? `${e.path}: ` : ''}${e.message}`, 300) })),
        },
        intake: { turn, output: lastRaw === null || typeof lastRaw !== 'object' ? {} : lastRaw, valid: false, errors },
      });
      return true;
    }

    emit('intake_completed', run, { turn, readiness: value.readiness, classification: value.classification });
    if (value.readiness === 'ready') {
      const checks = value.plan.checkIds.map((id) => {
        const check = projectConfig.checks.find((entry) => entry.id === id);
        return { id: check.id, argv: check.argv, timeoutMs: check.timeoutMs, description: check.description || '' };
      });
      const saved = store.saveIntakePlan(run.runId, {
        turn, output: value, classification: value.classification, plan: value.plan, checks,
        requirements: value.requirements, validatorVersion: VALIDATOR_VERSION,
      });
      if (!saved) return false;
      emit('plan_saved', run, { stageCount: value.plan.stages.length, classification: value.classification });
      return true;
    }
    if (value.readiness === 'needs_input') {
      if (turn >= MAX_INTAKE_TURNS) {
        settle(run, {
          status: 'failed', releaseLease: true, ticketStatus: 'blocked', waitReason: 'execution_error',
          waitDetail: { code: 'intake_exhausted', message: `Intake still needs input after ${MAX_INTAKE_TURNS} turns` },
          intake: { turn, output: value, valid: true, errors: [] },
        });
        return true;
      }
      const decision = store.requestIntakeAnswer(run.runId, { turn, output: value });
      if (!decision) return false;
      emit('decision_requested', run, { kind: 'intake_clarification', count: value.questions.length });
      return false;
    }
    settle(run, {
      status: 'failed', releaseLease: true, ticketStatus: 'blocked', waitReason: 'execution_error',
      waitDetail: { code: 'intake_unsupported', message: shorten(value.unsupportedReason || 'The request is not supported') },
      intake: { turn, output: value, valid: true, errors: [] },
    });
    return true;
  }

  // ---------------------------------------------------------------- branch

  async function stepBranch(run) {
    const plan = planOf(run);
    if (writerHolder()) return false; // another writer holds the workspace; wait in this phase
    const adapter = gitAdapterFactory();
    const pre = await adapter.preflight({ baseRef: projectConfig.baseRef });
    const fail = (problems) => {
      const codes = problems.map((problem) => problem.code);
      emit('preflight_failed', run, { codes });
      settle(run, {
        status: 'failed', releaseLease: true, ticketStatus: 'blocked', waitReason: 'dependency',
        waitDetail: {
          code: 'preflight_failed',
          message: `Repository preflight failed: ${codes.join(', ')}`,
          problems: problems.map(({ code, message }) => ({ code, message: shorten(message, 300) })),
        },
      });
    };
    if (!pre.ok) { fail(pre.problems); return true; }
    if (!isWritable(plan)) {
      if (store.recordBranch(run.runId, { branchName: null, baseCommit: pre.baseCommit })) emit('branch_prepared', run, { created: false, kind: 'read_only' });
      return true;
    }
    const revision = store.getRevision(run.ticketId, run.revisionId);
    const name = run.branchName || await adapter.branchName({
      classification: plan.classification, title: revision.title, ticketId: run.ticketId, branchPrefixes: projectConfig.branchPrefixes,
    });
    let owned = store.isTicketBranch(name, run.ticketId);
    // Record the intent before creating, so a crash in between leaves the branch recognisably ours.
    if (!owned && !(await adapter.branchExists(name))) owned = store.reserveBranch(name, run.ticketId);
    // An owned branch that already exists keeps the base of the run that created it.
    let baseCommit = pre.baseCommit;
    if (owned && await adapter.branchExists(name)) {
      const earlier = store.listRuns(run.ticketId).filter((entry) => entry.runId !== run.runId && entry.branchName === name && entry.baseCommit);
      if (earlier.length) baseCommit = earlier[earlier.length - 1].baseCommit;
    }
    const prepared = await adapter.prepareBranch({ name, baseCommit, ownedByThisTicket: owned });
    if (!prepared.ok) { fail(prepared.problems); return true; }
    if (store.recordBranch(run.runId, { branchName: name, baseCommit })) {
      emit('branch_prepared', run, { created: Boolean(prepared.created), kind: prepared.reused ? 'reused' : 'new' });
    }
    return true;
  }

  // ----------------------------------------------------------- engineering

  function latestReadyIntake(run) {
    const records = store.listIntakeRecords(run.runId).filter((record) => record.valid && record.output && record.output.readiness === 'ready');
    return records.length ? records[records.length - 1].output : null;
  }

  async function startLead(run) {
    const plan = planOf(run);
    const planHash = planHashOf(plan);
    const adopted = taskReader.findByRun ? await taskReader.findByRun(run.runId) : null;
    if (adopted) {
      const found = await taskReader.get(adopted.taskId);
      const message = firstMessageMetadata(found);
      const stored = found && found.metadata && found.metadata.delivery && found.metadata.delivery.planHash ? found.metadata.delivery : message.delivery;
      const contract = message.acceptance && Array.isArray(message.acceptance.requiredChecks) ? message.acceptance.requiredChecks : null;
      const matches = stored && stored.planRevisionId === plan.planRevisionId && stored.planHash === planHash
        && contract && canonicalJson(contract) === canonicalJson(requiredChecksOf(plan));
      if (!matches) {
        settle(run, {
          status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error',
          waitDetail: { code: 'lead_task_mismatch', message: 'An existing lead task does not match the saved plan and checks' },
        });
        return true;
      }
      store.recordLeadTask(run.runId, adopted.taskId, adopted.contextId);
      return true;
    }
    const revision = store.getRevision(run.ticketId, run.revisionId);
    const intake = latestReadyIntake(run);
    if (!intake) throw new Error(`run ${run.runId} has no ready intake result`);
    const goal = renderRequirementsGoal({ revision, intake });
    const acceptance = { requiredChecks: requiredChecksOf(plan) };
    const delivery = {
      runId: run.runId,
      planRevisionId: plan.planRevisionId,
      planHash,
      plan: { planRevisionId: plan.planRevisionId, classification: plan.classification, stages: plan.stages, checkIds: plan.checkIds },
    };
    const sent = await leadClient.send({ goal, acceptance, delivery });
    if (!sent || !sent.taskId) throw new Error('the lead endpoint returned no task id');
    if (store.recordLeadTask(run.runId, sent.taskId, sent.contextId)) emit('engineering_started', run, { stageCount: plan.stages.length });
    return true;
  }

  function pauseDetail(run, pause) {
    const kind = pause && typeof pause.kind === 'string' ? pause.kind : 'input_required';
    return {
      waitReason: PAUSE_WAIT_REASONS[kind] || 'execution_error',
      waitDetail: {
        code: kind,
        message: shorten(pause && (pause.message || pause.question) ? (pause.message || pause.question) : 'The lead run is paused'),
        resumeCommand: `npm run ask -- --task ${run.leadTaskId} "<answer>"`,
      },
    };
  }

  async function stepEngineering(run) {
    if (!run.leadTaskId) return startLead(run);
    const task = await taskReader.get(run.leadTaskId);
    if (!task) {
      settle(run, {
        status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error',
        waitDetail: { code: 'lead_task_missing', message: 'The lead task could not be found' },
      });
      return true;
    }
    const state = task.status && task.status.state;
    if (state === TaskState.TASK_STATE_COMPLETED) {
      return Boolean(store.moveToCandidate(run.runId));
    }
    if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED) {
      settle(run, {
        status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error',
        waitDetail: { code: 'lead_failed', message: shorten(messageText(task.status.message) || 'The lead run failed') },
      });
      return true;
    }
    if (state === TaskState.TASK_STATE_CANCELED) {
      settle(run, {
        status: 'cancelled', ticketStatus: 'blocked', waitReason: 'run_stopped',
        waitDetail: { code: 'lead_canceled', message: 'The lead run was canceled' },
      });
      return true;
    }
    if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      const pause = task.metadata && task.metadata.pause;
      if (pause && pause.kind === 'human_decision' && pause.decisionId) {
        await handleLeadDecision(run, pause);
        return false;
      }
      const { waitReason, waitDetail } = pauseDetail(run, pause);
      store.setExecutionState(run.runId, { status: 'interrupted', ticketStatus: 'blocked', waitReason, waitDetail });
      return false;
    }
    // Working (or an unrecognised live state): the lead is running; any earlier pause is over.
    for (const decision of store.listDecisions(run.runId)) {
      if (decision.kind === 'lead_decision' && decision.state === 'pending') store.markDecisionStale(decision.decisionId);
    }
    store.setExecutionState(run.runId, { status: 'running', ticketStatus: 'in_progress' });
    sentAnswers.delete(run.runId);
    return false;
  }

  async function handleLeadDecision(run, pause) {
    let decision = store.findLeadDecision(run.runId, pause.decisionId);
    if (!decision) {
      decision = store.requestLeadDecision(run.runId, pause);
      if (decision) emit('decision_requested', run, { kind: 'lead_decision', count: Array.isArray(pause.options) ? pause.options.length : 0 });
      return;
    }
    if (decision.state === 'pending') {
      store.setExecutionState(run.runId, {
        status: 'paused', ticketStatus: 'waiting_human', waitReason: 'human_decision',
        waitDetail: { code: 'lead_decision', message: shorten(pause.question || 'The lead needs a decision') },
      });
      return;
    }
    if (decision.state === 'answered' && sentAnswers.get(run.runId) !== pause.decisionId) {
      const answer = decision.answer || {};
      await leadClient.send({
        taskId: run.leadTaskId,
        contextId: run.leadContextId || undefined,
        answer: answer.answer,
        decisionId: pause.decisionId,
        ...(answer.choice ? { choice: answer.choice } : {}),
      });
      sentAnswers.set(run.runId, pause.decisionId);
    }
  }

  // ------------------------------------------------------------- candidate

  // D-M3-8 gates; the first failing one blocks the ticket (the candidate row is still stored for inspection).
  function candidateGate({ run, plan, raw, stages, capture }) {
    const block = (code, message) => ({ code, message });
    const required = Array.isArray(raw && raw.requiredCheckIds) ? raw.requiredCheckIds : null;
    if (!required || canonicalJson([...required].sort()) !== canonicalJson([...plan.checkIds].sort())) {
      return block('check_set_mismatch', 'The accepted check set does not match the saved plan');
    }
    const open = plan.stages.filter((stage) => stage.required && !stages.some((entry) => entry.stageId === stage.stageId && entry.status === 'succeeded'));
    if (open.length) return block('stages_incomplete', `Required stages did not succeed: ${open.map((stage) => stage.stageId).join(', ')}`);
    if (run.branchName && capture.branch !== run.branchName) {
      return block('branch_mismatch', 'The checkout is not on the branch prepared for this run');
    }
    if (capture.headMoved) return block('head_moved', 'HEAD moved from the base commit; agents must not commit');
    const expected = raw && raw.candidate ? raw.candidate.fingerprint : null;
    if (isWritable(plan) || expected) {
      const fresh = takeSnapshot(workspace);
      if (!expected || fresh.kind !== 'git' || fresh.fingerprint !== expected) {
        return block('candidate_changed', 'The checkout changed after acceptance verified it');
      }
    }
    if (isWritable(plan) && capture.manifest.length === 0) return block('empty_candidate', 'The plan is writable but no files changed');
    return null;
  }

  async function stepCandidate(run) {
    const plan = planOf(run);
    const task = await taskReader.get(run.leadTaskId);
    const artifacts = (task && task.artifacts) || [];
    const resultArtifact = artifacts.find((artifact) => artifact.artifactId === `${run.leadTaskId}-result`) || artifacts[artifacts.length - 1] || null;
    const meta = (resultArtifact && resultArtifact.metadata) || {};
    const raw = meta.acceptance && typeof meta.acceptance === 'object' ? meta.acceptance : null;
    const stages = Array.isArray(meta.stages) ? meta.stages : [];
    const acceptance = raw
      ? {
        disposition: String(raw.disposition),
        reasons: Array.isArray(raw.reasons) ? raw.reasons : [],
        checks: (Array.isArray(raw.checks) ? raw.checks : []).map(checkView),
        stages,
      }
      : {
        disposition: 'unverifiable',
        reasons: [{ code: 'acceptance_missing', detail: 'The lead result carried no acceptance record.' }],
        checks: [],
        stages,
      };

    const holder = writerHolder();
    if (holder) {
      if (holder.state !== 'unresolved') return false; // a writer is still finishing; wait
      settle(run, {
        status: 'failed', ticketStatus: 'blocked', waitReason: 'execution_error',
        waitDetail: { code: 'writer_unresolved', message: 'A writer outcome is unresolved; the checkout cannot be captured safely' },
      });
      return true;
    }
    const capture = await gitAdapterFactory().captureCandidate({ baseCommit: run.baseCommit });
    const gate = candidateGate({ run, plan, raw, stages, capture });
    let diffArtifact = null;
    if (capture.diffText) {
      const stored = artifactStore.store(Buffer.from(capture.diffText, 'utf8'), 'candidate.txt');
      diffArtifact = {
        artifactId: stored.artifactId, displayName: 'candidate.diff', size: stored.size, sha256: stored.sha256, storageRef: stored.storageRef,
      };
    }
    const accepted = !gate && (acceptance.disposition === 'accepted' || (acceptance.disposition === 'not_required' && !isWritable(plan)));
    const candidate = store.completeRun(run.runId, {
      candidate: {
        baseCommit: capture.baseCommit,
        head: capture.head,
        branch: capture.branch,
        headMoved: capture.headMoved,
        manifest: capture.manifest,
        truncated: Boolean(capture.truncated || capture.manifestTruncated),
        acceptance,
        integrityHash: capture.integrityHash,
      },
      diffArtifact,
      outcome: accepted ? 'review' : 'blocked',
      waitDetail: gate || {
        code: 'acceptance_not_accepted',
        message: `Acceptance disposition: ${acceptance.disposition}`,
        disposition: acceptance.disposition,
      },
    });
    if (!candidate) {
      if (diffArtifact) { try { artifactStore.remove(diffArtifact.storageRef); } catch (_) { /* swept later */ } }
      return false;
    }
    emit('candidate_captured', run, { fileCount: capture.manifest.length, truncated: capture.truncated, disposition: acceptance.disposition });
    emit('run_settled', run, { status: 'completed', phase: 'settled', waitReason: accepted ? 'human_review' : 'execution_error', code: accepted ? 'human_review' : (gate ? gate.code : 'acceptance_not_accepted') });
    return true;
  }

  // ------------------------------------------------------------------ loop

  async function stepOnce(run) {
    switch (run.phase) {
      case 'queued': {
        const result = store.acquireLease(run.runId);
        if (result.acquired) emit('lease_acquired', run, { phase: 'intake' });
        return result.acquired;
      }
      case 'intake': return stepIntake(run);
      case 'branch': return stepBranch(run);
      case 'engineering': return stepEngineering(run);
      case 'candidate': return stepCandidate(run);
      default: return false; // awaiting_answer waits for the answer command
    }
  }

  async function stepRun(runId) {
    for (let step = 0; step < MAX_STEPS_PER_RUN && !stopped; step += 1) {
      const run = store.getRun(runId);
      if (!run || !['queued', 'running', 'paused', 'interrupted'].includes(run.status)) return;
      if (cancelling.has(runId)) return;
      let progressed = false;
      try {
        progressed = await stepOnce(run);
      } catch (error) {
        reportError(`${run.phase} ${run.runId}`, error);
        return;
      }
      if (!progressed) return;
    }
  }

  async function doTick() {
    if (stopped) return;
    let runs;
    try {
      runs = store.listActiveRuns();
    } catch (error) {
      reportError('list runs', error);
      return;
    }
    for (const run of runs) {
      if (stopped) return;
      await stepRun(run.runId);
    }
  }

  /** Runs one full pass; calls never overlap and a burst of calls coalesces into one follow-up pass. */
  function tick() {
    if (stopped) return Promise.resolve();
    if (scheduled) return scheduled;
    const pass = current.then(() => {
      scheduled = null;
      return doTick();
    });
    scheduled = pass;
    current = pass.catch(() => {});
    return pass;
  }

  /**
   * Cancels a ticket (store semantics). A paused lead task is first ended through the in-process A2A
   * client and confirmed canceled in the task store, so a later CLI resume cannot restart it; a task
   * that is executing keeps the M7 refusal.
   */
  async function cancelTicket(ticketId, command) {
    const ticket = store.getTicket(ticketId);
    const run = ticket ? store.getActiveRun(ticket.ticketId) : null;
    const eligible = ticket && run && run.leadTaskId && ['waiting_human', 'blocked'].includes(ticket.status)
      && run.status !== 'running' && command && ticket.version === command.expectedVersion;
    if (!eligible) return store.cancelTicket(ticketId, command);
    cancelling.add(run.runId);
    try {
      const task = await taskReader.get(run.leadTaskId);
      const state = task && task.status && task.status.state;
      if (state === TaskState.TASK_STATE_WORKING || state === TaskState.TASK_STATE_SUBMITTED) {
        throw new ProductError('invalid_state', 'Stopping active work arrives in M7');
      }
      if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
        const kind = task.metadata && task.metadata.pause && task.metadata.pause.kind;
        if (UNRESOLVED_PAUSE_KINDS.includes(kind)) {
          throw new ProductError('invalid_state', 'Writer outcome is unresolved; resume from the CLI first');
        }
        await leadClient.cancel(run.leadTaskId);
        const after = await taskReader.get(run.leadTaskId);
        if (!after || !after.status || after.status.state !== TaskState.TASK_STATE_CANCELED) {
          throw new ProductError('invalid_state', 'The lead task could not be canceled; try again');
        }
      }
      return store.cancelTicket(ticketId, command);
    } finally {
      cancelling.delete(run.runId);
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    abort = new AbortController();
    timer = setInterval(() => { tick(); }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
    tick();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    abort.abort();
    await current.catch(() => {});
  }

  return {
    start,
    stop,
    tick,
    poke() { return tick(); },
    cancelTicket,
    settingsSnapshot() {
      return buildSettingsSnapshot({ roles, leadRole, projectConfig, rolePackHash, appServerVersion });
    },
  };
}

module.exports = { createDeliveryController, buildSettingsSnapshot, computeRolePackHash, planHashOf, LEAD_PROMPT_VERSION };
