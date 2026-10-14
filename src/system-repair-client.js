'use strict';
const crypto = require('node:crypto');
const net = require('node:net');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { Role, TaskState } = require('@a2a-js/sdk');
const { parseWorkerReport, WORKER_REPORT_CONTRACT } = require('./contracts');
const { deterministicContextId } = require('./durable-store');

const SYSTEM_REPAIR_SCOPE = Object.freeze(['src', 'profiles', 'test', 'docs', 'launcher-ui', 'launcher.js', 'README.md', 'package.json', 'package-lock.json']);
const SYSTEM_REPAIR_CHECKS = Object.freeze(['env -u NODE_TEST_CONTEXT npm test', 'git diff --check']);
const REQUEST_TIMEOUT_MS = 10000;
const isTerminal = (task) => [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(task?.status?.state);
const taskOf = (value) => value?.task || (value?.id && value?.status ? value : null);
const textOf = (parts = []) => parts.map((p) => p?.content?.$case === 'text' ? p.content.value || '' : p?.text || '').filter(Boolean).join('\n');
const inScope = (file) => typeof file === 'string' && SYSTEM_REPAIR_SCOPE.some((scope) => file === scope || file.startsWith(scope + '/'));

function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new TypeError('endpoint must be an absolute loopback URL'); }
  const host = url.hostname.replace(/[\[\]]/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
  if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/agents/chuck-norris') {
    throw new TypeError('endpoint must be loopback /agents/chuck-norris without credentials, query, or fragment');
  }
  return url;
}

function projectContext(input) {
  const value = {
    goal: String(input?.goal || '').slice(0, 2000),
    projectChecks: (Array.isArray(input?.projectChecks) ? input.projectChecks : []).slice(0, 10).map((check) => ({
      id: String(check?.id || '').slice(0, 120),
      argv: (Array.isArray(check?.argv) ? check.argv : []).slice(0, 20).map((part) => String(part).slice(0, 500)),
    })),
    evidence: (Array.isArray(input?.evidence) ? input.evidence : []).slice(-10).map((entry) => String(entry).slice(0, 1000)),
    openDecisions: (Array.isArray(input?.openDecisions) ? input.openDecisions : []).slice(0, 10).map((entry) => ({
      id: String(entry?.id || '').slice(0, 160), role: String(entry?.role || '').slice(0, 80),
      question: String(entry?.question || '').slice(0, 500),
    })),
  };
  let text = JSON.stringify(value);
  if (text.length > 12000) text = text.slice(0, 12000);
  try { return JSON.parse(text); } catch (_) { return { truncated: true, text }; }
}

function runtimeGeneration(identity) {
  if (!identity || identity.pid === undefined || !identity.moduleLoadedAt) return null;
  return String(identity.pid) + ':' + String(identity.moduleLoadedAt);
}

function requiresRuntimeReload(file) {
  return file === 'launcher.js' || (file.startsWith('src/') && /\.(?:js|cjs|mjs)$/i.test(file))
    || file === 'profiles/system/chuck-norris.toml' || file === 'profiles/TEAM.md'
    || (file.startsWith('profiles/agents/') && file.endsWith('.toml'));
}

function manifestMatches(manifest, paths, actualHashes) {
  if (!manifest || manifest.schema !== 'system-source-manifest/v1' || manifest.known !== true || !Array.isArray(manifest.files)
    || !actualHashes || typeof actualHashes !== 'object') return false;
  const hashes = new Map(manifest.files.filter((entry) => entry?.present !== false).map((entry) => [entry?.path, entry?.sha256]));
  return paths.every((file) => /^[0-9a-f]{64}$/i.test(hashes.get(file) || '')
    && actualHashes[file] === hashes.get(file));
}

function serviceGeneration(identity) {
  if (!identity || identity.schema !== 'system-agent-runtime-identity/v1'
    || identity.pid === undefined || !identity.moduleLoadedAt) return null;
  return String(identity.pid) + ':' + String(identity.moduleLoadedAt);
}

function compactRuntimeIdentity(identity) {
  if (!identity || !runtimeGeneration(identity) || !identity.sourceHashes || !identity.profileHashes
    || !Array.isArray(identity.loadedUncapturedSourceFiles)) return null;
  return {
    generation: runtimeGeneration(identity),
    sourceHashes: identity.sourceHashes,
    profileHashes: identity.profileHashes,
    loadedUncapturedSourceFiles: identity.loadedUncapturedSourceFiles,
  };
}

function loadedState(identity, file) {
  if (!identity) return 'unknown';
  if (Object.hasOwn(identity.sourceHashes || {}, file)) return 'loaded';
  if (identity.loadedUncapturedSourceFiles?.includes(file)) return 'loaded_uncaptured';
  return 'not_loaded';
}

function restartResult(result, identities = {}) {
  if (result?.status !== 'restart_required') return result;
  const requester = compactRuntimeIdentity(identities.requesterRuntimeIdentity);
  const service = compactRuntimeIdentity(identities.serviceRuntimeIdentity);
  const submitted = result.runtimeIdentityAtSubmit || {};
  const submittedRequester = submitted.requester || null;
  const submittedService = submitted.service || null;
  const runtimePaths = result.delta?.changedPaths?.filter(requiresRuntimeReload) || [];
  const sourcePaths = runtimePaths.filter((file) => file === 'launcher.js' || (file.startsWith('src/') && /\.(?:js|cjs|mjs)$/i.test(file)));
  const leadProfilePaths = runtimePaths.filter((file) => file === 'profiles/TEAM.md' || file.startsWith('profiles/agents/'));
  const serviceProfilePaths = runtimePaths.filter((file) => file === 'profiles/TEAM.md' || file === 'profiles/system/chuck-norris.toml');
  let sourceReady = true;
  for (const file of sourcePaths) {
    const checks = file === 'launcher.js' ? [['service', submittedService, service]]
      : [['requester', submittedRequester, requester], ['service', submittedService, service]];
    if (checks.some(([, baseline]) => !baseline)) sourceReady = false;
    const relevant = checks.filter(([, baseline]) => ['loaded', 'loaded_uncaptured'].includes(loadedState(baseline, file)));
    if (relevant.length === 0) {
      const newlyLoaded = checks.some(([, baseline, current]) => baseline && current
        && current.generation !== baseline.generation
        && manifestMatches(result.systemSourceManifest, [file], current.sourceHashes));
      if (!newlyLoaded) sourceReady = false;
      continue;
    }
    for (const [, baseline, current] of relevant) {
      if (!current?.generation || current.generation === baseline.generation
        || !manifestMatches(result.systemSourceManifest, [file], current.sourceHashes)) sourceReady = false;
    }
  }
  const leadProfilesReady = leadProfilePaths.length === 0 || (Boolean(requester)
    && leadProfilePaths.every((file) => file !== 'profiles/TEAM.md'
      ? submittedRequester && requester.generation !== submittedRequester.generation
        && manifestMatches(result.systemSourceManifest, [file], requester.profileHashes)
      : submittedRequester && submittedService
        && requester.generation !== submittedRequester.generation
        && service?.generation !== submittedService.generation
        && manifestMatches(result.systemSourceManifest, [file], requester.profileHashes)
        && manifestMatches(result.systemSourceManifest, [file], service.profileHashes)));
  const serviceProfilesReady = serviceProfilePaths.length === 0 || (Boolean(service)
    && serviceProfilePaths.every((file) => file !== 'profiles/TEAM.md'
      ? submittedService && service.generation !== submittedService.generation
        && manifestMatches(result.systemSourceManifest, [file], service.profileHashes)
      : submittedRequester && submittedService
        && requester?.generation !== submittedRequester.generation
        && service.generation !== submittedService.generation
        && manifestMatches(result.systemSourceManifest, [file], requester.profileHashes)
        && manifestMatches(result.systemSourceManifest, [file], service.profileHashes)));
  return sourceReady && leadProfilesReady && serviceProfilesReady
    ? { ...result, status: 'completed', reason: null, runtimeReloadVerified: true,
      requesterRuntimeGeneration: requester?.generation || null, serviceRuntimeGeneration: service?.generation || null }
    : result;
}
function identityAtSubmit(task) {
  for (const message of task?.history || []) {
    const metadata = message?.metadata || {};
    if (metadata.systemRequest === true) {
      return { requester: metadata.requesterRuntimeIdentityAtSubmit || null, service: metadata.systemRuntimeIdentityAtSubmit || null };
    }
  }
  return { requester: null, service: null };
}

function resultFor(task, _context, identity) {
  if (task?.status?.state === TaskState.TASK_STATE_AUTH_REQUIRED) return { status: 'unavailable', taskId: task?.id || null, reason: 'authentication_required' };
  if (task?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) return { status: 'blocked', taskId: task?.id || null, reason: 'specialist_input_required' };
  if (task?.status?.state === TaskState.TASK_STATE_REJECTED) return { status: 'blocked', taskId: task?.id || null, reason: 'specialist_task_rejected' };
  if (task?.status?.state === TaskState.TASK_STATE_FAILED && task.status.message?.metadata?.failureKind === 'usage_limit') return { status: 'budget', taskId: task?.id || null, reason: 'specialist_usage_limit' };
  if (task?.status?.state !== TaskState.TASK_STATE_COMPLETED) return { status: 'blocked', taskId: task?.id || null, reason: 'task_not_completed' };
  const artifact = (task.artifacts || []).map((entry) => ({ entry, text: textOf(entry.parts) }))
    .find(({ entry, text }) => entry.metadata?.contract === WORKER_REPORT_CONTRACT || text.trimStart().startsWith('{'));
  if (!artifact || artifact.entry.metadata?.contract !== WORKER_REPORT_CONTRACT || artifact.entry.metadata?.reportError) {
    return { status: 'blocked', taskId: task.id, reason: 'invalid_worker_report' };
  }
  const parsed = parseWorkerReport(artifact.text);
  if (!parsed.report || parsed.report.outcome !== 'completed') return { status: 'blocked', taskId: task.id, reason: 'repair_report_not_completed' };
  for (const command of SYSTEM_REPAIR_CHECKS) {
    const check = parsed.report.checks.find((entry) => entry.command === command);
    if (!check || check.result !== 'passed') return { status: 'blocked', taskId: task.id, reason: 'repair_check_not_passed', report: parsed.report };
  }
  if (parsed.report.checks.some((check) => check.result !== 'passed')) {
    return { status: 'blocked', taskId: task.id, reason: 'repair_report_has_failed_or_unrun_check', report: parsed.report };
  }
  const metadata = artifact.entry.metadata || {};
  if (!Array.isArray(parsed.report.checks) || parsed.report.checks.some((check) => check.result !== 'passed')) {
    return { status: 'blocked', taskId: task.id, reason: 'repair_report_has_failed_or_unrun_check', report: parsed.report };
  }
  if (!Array.isArray(metadata.boundary?.results) || metadata.boundary.results.length === 0 || metadata.boundary.results.some((item) => item.result !== 'PASS')) {
    return { status: 'blocked', taskId: task.id, reason: 'boundary_evidence_not_passed', report: parsed.report };
  }
  const writerExecution = metadata.writerExecution;
  const delta = writerExecution?.delta;
  if (writerExecution?.state !== 'released' || writerExecution.lane?.state !== 'integrated'
    || delta?.known !== true || !Array.isArray(delta.changedPaths)
    || delta.changedPaths.length > 100 || (delta.changedPathCount ?? delta.changedPaths.length) !== delta.changedPaths.length) {
    return { status: 'unknown', taskId: task.id, reason: 'writer_execution_not_authoritatively_released', report: parsed.report };
  }
  const violations = [...delta.changedPaths, ...parsed.report.filesChanged].filter((file) => !inScope(file));
  if (violations.length || parsed.report.scopeExpansion.length) {
    return { status: 'blocked', taskId: task.id, reason: 'scope_violation', scopeViolations: violations.slice(0, 20), report: parsed.report };
  }
  const restartRequired = delta.changedPaths.some(requiresRuntimeReload);
  const submission = identity || {};
  return {
    status: restartRequired ? 'restart_required' : 'completed', taskId: task.id, report: parsed.report,
    writerExecution, delta: { known: true, changedPaths: delta.changedPaths.slice(0, 100), changedPathCount: delta.changedPaths.length },
    ...(metadata.systemSourceManifest ? { systemSourceManifest: metadata.systemSourceManifest } : {}),
    ...(metadata.systemProfileManifest ? { systemProfileManifest: metadata.systemProfileManifest } : {}),
    ...(restartRequired ? {
      runtimeIdentityAtSubmit: {
        requester: compactRuntimeIdentity(submission.requesterRuntimeIdentity),
        service: compactRuntimeIdentity(submission.serviceRuntimeIdentity),
      },
    } : {}),
    reason: restartRequired ? 'loaded_runtime_code_requires_restart' : null,
  };
}

function validateAgentCard(card, endpointUrl, responseUrl) {
  if (responseUrl && responseUrl !== new URL(endpointUrl.pathname + '/agent-card.json', endpointUrl.origin).toString()) {
    throw new Error('system agent card redirected away from its configured loopback route');
  }
  const approved = (card?.supportedInterfaces || []).filter((entry) => {
    if (entry?.protocolBinding !== 'JSONRPC' || typeof entry.url !== 'string') return false;
    try {
      const target = new URL(entry.url);
      return target.origin === endpointUrl.origin && target.pathname.replace(/\/$/, '') === endpointUrl.pathname
        && !target.username && !target.password && !target.search && !target.hash;
    } catch (_) { return false; }
  });
  if (approved.length === 0) throw new Error('system agent card has no JSONRPC interface at the configured endpoint');
  return { ...card, supportedInterfaces: [approved[0]] };
}

function withTimeout(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('A2A request timed out'), { name: 'TimeoutError' })), timeoutMs);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function createSystemRepairClient({ endpoint, authToken, journal, pollIntervalMs = 500, cancelTimeoutMs = 30000, clientFactory = new ClientFactory(), fetchImpl = globalThis.fetch } = {}) {
  const url = validateEndpoint(endpoint);
  if (typeof authToken !== 'string' || !authToken.trim()) throw new TypeError('authToken is required');
  if (!journal || !['recordSubmitting', 'recordSubmitted', 'recordFinished', 'get'].every((key) => typeof journal[key] === 'function')) {
    throw new TypeError('journal must implement DispatchJournal methods');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || !Number.isFinite(cancelTimeoutMs) || cancelTimeoutMs < 0) throw new TypeError('poll and cancellation intervals must be non-negative');
  let cachedClient = null;
  let cachedAgentCard = null;
  const cardUrl = new URL(url.pathname + '/agent-card.json', url.origin).toString();
  async function fetchAgentCard() {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for agent-card discovery');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await withTimeout(fetchImpl(cardUrl, { signal: controller.signal }), REQUEST_TIMEOUT_MS, controller.signal);
      if (!response?.ok) throw new Error('system agent card request failed');
      const card = await withTimeout(response.json(), REQUEST_TIMEOUT_MS, controller.signal);
      return validateAgentCard(card, url, response.url || cardUrl);
    } finally {
      clearTimeout(timer);
    }
  }
  const getClient = async () => {
    if (cachedClient) return cachedClient;
    const card = await fetchAgentCard();
    if (typeof clientFactory.createFromAgentCard !== 'function') throw new TypeError('clientFactory.createFromAgentCard is required');
    const client = await withTimeout(clientFactory.createFromAgentCard(card), REQUEST_TIMEOUT_MS);
    if (typeof client?.getAgentCard !== 'function') throw new TypeError('A2A client getAgentCard is required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let discoveredCard;
    try {
      discoveredCard = await withTimeout(client.getAgentCard({ signal: controller.signal }), REQUEST_TIMEOUT_MS, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    cachedAgentCard = validateAgentCard(discoveredCard, url);
    cachedClient = client;
    return client;
  };
  async function fetchServiceRuntimeIdentity(refreshCard = false) {
    try {
      if (refreshCard) cachedAgentCard = validateAgentCard(await fetchAgentCard(), url);
      if (!cachedAgentCard) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const runtimeUrl = new URL(url.pathname + '/runtime', url.origin).toString();
      try {
        const response = await withTimeout(fetchImpl(runtimeUrl, {
          headers: { authorization: 'Bearer ' + authToken }, signal: controller.signal,
        }), REQUEST_TIMEOUT_MS, controller.signal);
        if (!response?.ok || (response.url && response.url !== runtimeUrl)) return null;
        const identity = await withTimeout(response.json(), REQUEST_TIMEOUT_MS, controller.signal);
        if (identity?.schema !== 'system-agent-runtime-identity/v1'
          || identity.pid === undefined || !identity.moduleLoadedAt
          || !identity.sourceHashes || typeof identity.sourceHashes !== 'object'
          || !identity.profileHashes || typeof identity.profileHashes !== 'object'
          || !Array.isArray(identity.loadedUncapturedSourceFiles)) return null;
        return identity;
      } finally {
        clearTimeout(timer);
      }
    } catch (_) {
      return null;
    }
  }

  const auth = (signal) => ({ serviceParameters: { authorization: 'Bearer ' + authToken }, ...(signal ? { signal } : {}) });
  const call = (invoke, signal, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const controller = new AbortController();
    let timer;
    let abortListener;
    const pending = new Promise((resolve, reject) => {
      const abort = () => {
        controller.abort();
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      abortListener = abort;
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('A2A request timed out'), { name: 'TimeoutError' }));
      }, timeoutMs);
      Promise.resolve().then(() => invoke(auth(controller.signal))).then(resolve, reject);
    });
    return pending.finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortListener);
    });
  };
  const list = (client, contextId, signal, timeoutMs = REQUEST_TIMEOUT_MS) => call((options) => client.listTasks({
    contextId, status: TaskState.TASK_STATE_UNSPECIFIED, pageSize: 100, pageToken: '', historyLength: 20,
    statusTimestampAfter: undefined,
  }, options), signal, timeoutMs);
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }
    signal?.addEventListener('abort', abort, { once: true });
  });
  const persist = (attemptId, value) => { journal.recordFinished(attemptId, value); return value; };

  async function cancel(client, contextId, taskId, attemptId) {
    const deadline = Date.now() + cancelTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        if (!taskId) taskId = (await list(client, contextId, null, Math.max(1, deadline - Date.now())))?.tasks?.find((item) => item.contextId === contextId)?.id || null;
        if (taskId) {
          const canceled = await call((options) => client.cancelTask({ id: taskId }, options), null, Math.max(1, deadline - Date.now()));
          const current = isTerminal(canceled) ? canceled : await call((options) => client.getTask({ id: taskId, historyLength: 20 }, options), null, Math.max(1, deadline - Date.now()));
          if (isTerminal(current)) return persist(attemptId, { status: 'unknown', taskId, reason: 'canceled_with_unknown_effects' });
        }
      } catch (_) {}
      if (Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()));
    }
    return { status: 'unknown', taskId: taskId || null, reason: 'cancellation_unconfirmed' };
  }

  return async function repairSystem(request, { runId, workspace: _workspace, signal, onEvent, requestId, requesterRuntimeIdentity } = {}) {
    if (signal?.aborted) return { status: 'unknown', reason: 'aborted_before_dispatch' };
    if (!request?.incidentId || !runId || !requestId) return { status: 'blocked', reason: 'identity_or_request_missing' };
    const hash = crypto.createHash('sha256').update(String(runId)).update('\0').update(String(requestId)).digest('hex');
    const attemptId = 'system:' + hash + ':t1';
    const assignmentId = 'system:' + hash;
    const contextId = deterministicContextId(attemptId);
    const saved = journal.get(attemptId);
    if (saved?.state === 'finished') {
      if (saved.result?.status !== 'restart_required') return saved.result;
      const serviceRuntimeIdentity = await fetchServiceRuntimeIdentity(true);
      return restartResult(saved.result, {
        requesterRuntimeIdentity: requesterRuntimeIdentity || null,
        serviceRuntimeIdentity,
      });
    }
    let client;
    try { client = await getClient(); } catch (error) { return { status: 'unavailable', reason: String(error?.message || error).slice(0, 500) }; }
    const fresh = !saved;
    const currentServiceRuntimeIdentity = await fetchServiceRuntimeIdentity();
    if (!currentServiceRuntimeIdentity) return { status: 'unavailable', reason: 'system_runtime_identity_unavailable' };
    let submissionRequesterIdentity = requesterRuntimeIdentity || null;
    let submissionServiceIdentity = currentServiceRuntimeIdentity;
    if (fresh) journal.recordSubmitting({ attemptId, runId, assignmentId, role: 'chuck-norris', sandbox: 'workspace-write', contextId, objectiveSha256: hash });
    let task = null;
    const row = journal.get(attemptId);
    if (row?.state === 'submitted' && row.taskId) {
      try { task = await call((options) => client.getTask({ id: row.taskId, historyLength: 20 }, options), signal); }
      catch (_) { return { status: 'unknown', taskId: row.taskId, reason: 'journaled_task_unavailable' }; }
    } else if (row?.state === 'submitting' && !fresh) {
      try { task = (await list(client, contextId, signal))?.tasks?.find((item) => item.contextId === contextId) || null; }
      catch (_) { return { status: 'unknown', reason: 'submission_lookup_failed' }; }
      if (!task) return { status: 'unknown', reason: 'ambiguous_writable_submission_not_resent' };
      const identities = identityAtSubmit(task);
      submissionRequesterIdentity = identities.requester;
      submissionServiceIdentity = identities.service;
      journal.recordSubmitted(attemptId, task.id);
    }
    if (saved && task) {
      const identities = identityAtSubmit(task);
      submissionRequesterIdentity = identities.requester;
      submissionServiceIdentity = identities.service;
    }

    if (!task) {
      if (signal?.aborted) return { status: 'unknown', reason: 'aborted_before_send' };
      const context = projectContext(request.projectContext);
      const payload = {
        protocol: 'system-repair-request/v1',
        request: {
          incidentId: String(request.incidentId).slice(0, 160),
          question: String(request.question || '').slice(0, 3000),
          evidence: (Array.isArray(request.evidence) ? request.evidence : []).slice(0, 20).map((item) => String(item).slice(0, 3000)),
          relatedDecisionIds: (Array.isArray(request.relatedDecisionIds) ? request.relatedDecisionIds : []).slice(0, 20),
        },
        serviceScope: [...SYSTEM_REPAIR_SCOPE], serviceChecks: [...SYSTEM_REPAIR_CHECKS], projectContext: context,
      };
      const text = JSON.stringify(payload).slice(0, 100000);
      try { onEvent?.({ type: 'system_repair_submitted', requestId, incidentId: request.incidentId }); } catch (_) {}
      try {
        const sent = await call((options) => client.sendMessage({
          message: {
            messageId: attemptId + ':msg', contextId, role: Role.ROLE_USER,
            parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain' }],
            metadata: { runId, requestId, attemptId, systemRequest: true, requesterRuntimeIdentityAtSubmit: requesterRuntimeIdentity || null, systemRuntimeIdentityAtSubmit: currentServiceRuntimeIdentity }, extensions: [], referenceTaskIds: [],
          },
          configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] },
          metadata: { runId, requestId, attemptId, systemRequest: true, requesterRuntimeIdentityAtSubmit: requesterRuntimeIdentity || null, systemRuntimeIdentityAtSubmit: currentServiceRuntimeIdentity },
        }, options), signal);
        task = taskOf(sent);
        const identities = identityAtSubmit(task);
        if (identities.requester) submissionRequesterIdentity = identities.requester;
        if (identities.service) submissionServiceIdentity = identities.service;
        if (!task?.id) task = (await list(client, contextId, signal))?.tasks?.find((item) => item.contextId === contextId) || null;
        if (!task?.id) return { status: 'unknown', reason: 'task_id_missing_after_send' };
        journal.recordSubmitted(attemptId, task.id);
      } catch (error) {
        if (signal?.aborted) return cancel(client, contextId, null, attemptId);
        try { task = (await list(client, contextId, signal))?.tasks?.find((item) => item.contextId === contextId) || null; } catch (_) {}
        if (task?.id) journal.recordSubmitted(attemptId, task.id);
        else return { status: 'unknown', reason: 'send_result_unknown', detail: String(error?.message || error).slice(0, 500) };
      }
    }

    const context = projectContext(request.projectContext);
    while (true) {
      if (signal?.aborted) return cancel(client, contextId, task?.id, attemptId);
      if (isTerminal(task)) {
        const outcome = resultFor(task, context, {
          requesterRuntimeIdentity: submissionRequesterIdentity,
          serviceRuntimeIdentity: submissionServiceIdentity,
        });
        return persist(attemptId, outcome);
      }
      try { await delay(pollIntervalMs, signal); } catch (_) { return cancel(client, contextId, task?.id, attemptId); }
      try { task = await call((options) => client.getTask({ id: task.id, historyLength: 20 }, options), signal); }
      catch (error) { return { status: 'unknown', taskId: task?.id, reason: 'task_poll_failed', detail: String(error?.message || error).slice(0, 500) }; }
    }
  };
}
module.exports = { createSystemRepairClient, SYSTEM_REPAIR_SCOPE, SYSTEM_REPAIR_CHECKS, restartResult, manifestMatches, requiresRuntimeReload, validateAgentCard, serviceGeneration, identityAtSubmit, compactRuntimeIdentity };
