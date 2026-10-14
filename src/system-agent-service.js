'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AgentCard } = require('@a2a-js/sdk');
const { CodexAppServer } = require('./codex-app-server');
const { createAccountProfiles } = require('./account-profiles');
const { createSwitchingAppServer } = require('./app-server-switch');
const { createAuthMiddleware } = require('./local-auth');
const {
  acquireStateLock,
  acquireWorkspaceLock,
  createTaskStore,
  DispatchJournal,
  openStateDatabase,
  reconcileInterruptedTasks,
} = require('./durable-store');
const { createActivityStore } = require('./activity-store');
const { StagingLog } = require('./staging-log');
const { UsageLedger } = require('./usage-ledger');
const { WriterAdmission } = require('./writer-admission');
const { LaneManager, selectWriterIsolation, laneRetentionHours } = require('./writer-lanes');
const { loadSystemRole, EFFORTS, MODEL_PATTERN } = require('./role-catalog');
const { registerRoleAgents } = require('./a2a-role-service');
const { protectRoleRpcMounts } = require('./server');

const SYSTEM_AGENT_NAME = 'chuck-norris';
const DISPLAY_NAME = 'Chuck Norris';
const SYSTEM_REQUEST_PROTOCOL = 'system-repair-request/v1';
const MAX_CONTEXT_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_MS = 5000;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasForbiddenBoundaryKey(value, ancestors = new Set()) {
  if (typeof value === 'string' || value === null || typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/^(workspace|allowedfiles|scope)$/i.test(key)) return true;
    if (hasForbiddenBoundaryKey(child, ancestors)) return true;
  }
  ancestors.delete(value);
  return false;
}

function validateProjectContext(context) {
  if (!isRecord(context)) throw new Error('projectContext must be an object');
  const encoded = JSON.stringify(context);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTEXT_BYTES) throw new Error('projectContext exceeds the size limit');
  if (hasForbiddenBoundaryKey(context)) throw new Error('projectContext cannot select a workspace or write scope');
  return context;
}

function normalizeSystemRequest(text, allowedFiles, requiredChecks = []) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (_) {
    throw new Error('A structured system repair request is required');
  }
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'projectContext,protocol,request,serviceChecks,serviceScope'
    || value.protocol !== SYSTEM_REQUEST_PROTOCOL) {
    throw new Error('Unsupported system repair request envelope');
  }
  if (!Array.isArray(value.serviceScope) || JSON.stringify(value.serviceScope) !== JSON.stringify(allowedFiles)) {
    throw new Error('serviceScope must exactly match the fixed system repair scope');
  }
  if (!Array.isArray(value.serviceChecks) || JSON.stringify(value.serviceChecks) !== JSON.stringify(requiredChecks)) {
    throw new Error('serviceChecks must exactly match the fixed system repair checks');
  }
  if (hasForbiddenBoundaryKey(value.request)) throw new Error('request cannot select a workspace or write scope');
  if (!isRecord(value.request)
    || Object.keys(value.request).sort().join(',') !== 'evidence,incidentId,question,relatedDecisionIds'
    || typeof value.request.incidentId !== 'string' || !value.request.incidentId.trim() || value.request.incidentId.length > 160
    || typeof value.request.question !== 'string' || !value.request.question.trim() || value.request.question.length > 3000
    || !Array.isArray(value.request.evidence) || value.request.evidence.length === 0 || value.request.evidence.length > 20
    || value.request.evidence.some((item) => typeof item !== 'string' || !item.trim() || item.length > 3000)
    || !Array.isArray(value.request.relatedDecisionIds) || value.request.relatedDecisionIds.length > 20
    || value.request.relatedDecisionIds.some((item) => typeof item !== 'string' || !item.trim() || item.length > 160)) {
    throw new Error('request must contain a bounded incident, question, evidence, and relatedDecisionIds');
  }
  const projectContext = validateProjectContext(value.projectContext);
  return JSON.stringify({
    objective: 'Diagnose and repair this bounded control-plane incident: ' + value.request.question.trim(),
    allowedFiles: [...allowedFiles],
    inputs: [
      'Incident ID: ' + value.request.incidentId,
      'Related open decisions: ' + JSON.stringify(value.request.relatedDecisionIds),
      'Read-only project context: ' + JSON.stringify(projectContext),
    ],
    evidence: [...value.request.evidence],
    acceptanceCriteria: [
      'Identify the control-plane cause with repository evidence.',
      'Make the smallest safe repair within allowedFiles.',
      'Preserve owner pauses, review gates, budgets, credentials, and unresolved writer state.',
      'Run the supplied controller checks and report exact outcomes.',
    ],
    checks: [...requiredChecks],
    stopConditions: [
      'Stop if the required repair needs a path outside allowedFiles.',
      'Stop before changing project data, credentials, Git state, or a running service.',
    ],
  });
}

function extractTextPart(part) {
  if (part?.content?.$case === 'text' && typeof part.content.value === 'string') {
    return { kind: 'value', text: part.content.value };
  }
  if (typeof part?.text === 'string') return { kind: 'text', text: part.text };
  throw new Error('The system repair agent accepts one structured text part');
}

const SYSTEM_SEND_METHODS = new Map([
  ['SendMessage', 'SendMessage'],
  ['SendStreamingMessage', 'SendStreamingMessage'],
  ['message/send', 'SendMessage'],
  ['message/stream', 'SendStreamingMessage'],
]);

function normalizeRpcBody(body, allowedFiles, requiredChecks = []) {
  if (!isRecord(body)) throw new Error('A single JSON-RPC request is required');
  const canonicalMethod = SYSTEM_SEND_METHODS.get(body.method);
  if (!canonicalMethod) return body;
  if (!isRecord(body.params) || !isRecord(body.params.message)
    || !Array.isArray(body.params.message.parts) || body.params.message.parts.length !== 1
    || hasForbiddenBoundaryKey(body)) {
    throw new Error('The system repair assignment has invalid or sender-controlled scope fields');
  }
  const part = body.params.message.parts[0];
  const extracted = extractTextPart(part);
  const normalized = normalizeSystemRequest(extracted.text, allowedFiles, requiredChecks);
  if (extracted.kind === 'value') part.content.value = normalized;
  else part.text = normalized;
  body.method = canonicalMethod;
  return body;
}


function systemSourceManifest(repoDir, writerExecution) {
  const changedPaths = writerExecution?.delta?.changedPaths;
  if (writerExecution?.lane?.state !== 'integrated' || writerExecution?.state !== 'released'
    || writerExecution?.delta?.known !== true || !Array.isArray(changedPaths)) {
    return { schema: 'system-source-manifest/v1', known: false, files: [] };
  }
  const runtimePath = (file) => file === 'launcher.js'
    || (file.startsWith('src/') && /\.(?:js|cjs|mjs)$/i.test(file))
    || /^profiles\/(?:agents\/.+|system\/chuck-norris)\.toml$/i.test(file)
    || file === 'profiles/TEAM.md';
  const files = [];
  try {
    for (const file of changedPaths.filter(runtimePath)) {
      const target = path.resolve(repoDir, file);
      if (path.relative(repoDir, target).startsWith('..' + path.sep) || path.isAbsolute(path.relative(repoDir, target))) {
        throw new Error('Changed runtime path escaped the repository');
      }
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') { files.push({ path: file, present: false, sha256: null }); continue; } throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Changed runtime path is not a regular file');
      files.push({ path: file, present: true, sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
    }
    return { schema: 'system-source-manifest/v1', known: true, files };
  } catch (_) {
    return { schema: 'system-source-manifest/v1', known: false, files: [] };
  }
}

function makeAgentCard(endpoint, role, profileSha256) {
  return AgentCard.toJSON({
    name: DISPLAY_NAME,
    description: role.description,
    supportedInterfaces: [{
      url: endpoint,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: '',
    }],
    provider: { url: endpoint, organization: 'Codex Universal' },
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [{
      uri: 'urn:codex:system-profile-identity:v1',
      description: 'sha256=' + profileSha256,
    }] },
    securitySchemes: {
      localBearer: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: { scheme: 'Bearer', bearerFormat: 'opaque', description: 'Local A2A access token.' },
        },
      },
    },
    securityRequirements: [{ schemes: { localBearer: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: SYSTEM_AGENT_NAME,
      name: DISPLAY_NAME,
      description: role.description,
      tags: [SYSTEM_AGENT_NAME, 'system-repair'],
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: [],
    }],
    signatures: [],
  });
}

function createSystemAgentService({
  repoDir = path.resolve(__dirname, '..'),
  runtimeDir = process.env.LAUNCHER_RUNTIME_DIR
    ? path.resolve(process.env.LAUNCHER_RUNTIME_DIR)
    : path.join(path.resolve(__dirname, '..'), '.runtime'),
  endpoint = 'http://127.0.0.1:8080/agents/chuck-norris',
  token = null,
  createAppServer = (options) => new CodexAppServer(options),
  createAccountProfiles: makeAccountProfiles = createAccountProfiles,
  createState = openStateDatabase,
  registerAgents = registerRoleAgents,
  profilesDir = path.join(path.resolve(__dirname, '..'), 'profiles'),
  workspaceLockDir,
  closeGraceMs = SHUTDOWN_GRACE_MS,
  selectIsolation = selectWriterIsolation,
  createLaneManager: makeLaneManager = (options) => new LaneManager(options),
  runtimeIdentity = null,
} = {}) {
  const canonicalRepo = fs.realpathSync(repoDir);
  const profilePath = path.join(profilesDir, 'system', SYSTEM_AGENT_NAME + '.toml');
  let profileSha256 = null;
  const role = loadSystemRole({
    profilePath,
    teamPath: path.join(profilesDir, 'TEAM.md'),
    onSourceFile: (file, source) => {
      runtimeIdentity?.captureProfileSource?.(file, source);
      if (path.resolve(file) === path.resolve(profilePath)) {
        profileSha256 = crypto.createHash('sha256').update(source).digest('hex');
      }
    },
  });
  if (!profileSha256) throw new Error('The system role profile identity was not captured during load');
  if (typeof token !== 'string' || !token) throw new TypeError('A system-agent bearer token is required');
  const authToken = token;
  const authMiddleware = createAuthMiddleware(authToken);
  const agentEndpoint = new URL(endpoint);
  if (agentEndpoint.protocol !== 'http:' || agentEndpoint.hostname !== '127.0.0.1'
    || agentEndpoint.pathname !== '/agents/' + SYSTEM_AGENT_NAME || agentEndpoint.username || agentEndpoint.password) {
    throw new TypeError('The system agent endpoint must be its loopback A2A route');
  }
  const { SYSTEM_REPAIR_SCOPE: allowedFiles, SYSTEM_REPAIR_CHECKS: requiredChecks } = require('./system-repair-client');
  const defaultSettings = Object.freeze({ model: 'gpt-6.1-sol', effort: 'high' });
  function readSettings() {
    const configured = loadSystemRole({ profilePath, teamPath: path.join(profilesDir, 'TEAM.md') });
    return { model: configured.model, effort: configured.effort };
  }
  function writeSettings(settings) {
    readSettings();
    const source = fs.readFileSync(profilePath, 'utf8');
    const lines = source.split(/\r?\n/);
    let inInstructions = false;
    let inTable = false;
    const found = new Set();
    const replacements = { model: settings.model, model_reasoning_effort: settings.effort };
    for (let index = 0; index < lines.length; index += 1) {
      if (inInstructions) {
        if (/^\s*"""\s*(?:#.*)?$/.test(lines[index])) inInstructions = false;
        continue;
      }
      const table = lines[index].match(/^\s*\[[A-Za-z0-9_.-]+\]\s*(?:#.*)?$/);
      if (table) { inTable = true; continue; }
      if (inTable) continue;
      const multiline = lines[index].match(/^\s*developer_instructions\s*=\s*"""\s*$/);
      if (multiline) { inInstructions = true; continue; }
      const assignment = lines[index].match(/^(\s*)(model|model_reasoning_effort)\s*=\s*"(?:\\.|[^"\\])*"\s*(?:#.*)?$/);
      if (!assignment) continue;
      const [, indentation, key] = assignment;
      if (found.has(key)) throw new Error('System profile contains a duplicate ' + key + ' field');
      found.add(key);
      lines[index] = indentation + key + ' = ' + JSON.stringify(replacements[key === 'model' ? 'model' : 'model_reasoning_effort']);
    }
    if (found.size !== 2) throw new Error('System profile is missing model settings');
    const updated = lines.join(source.includes('\r\n') ? '\r\n' : '\n');
    const dir = path.dirname(profilePath);
    const temp = path.join(dir, '.' + path.basename(profilePath) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
    let fd;
    try {
      const mode = fs.statSync(profilePath).mode & 0o777;
      fd = fs.openSync(temp, 'wx', mode);
      fs.writeFileSync(fd, updated, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, profilePath);
      const directoryFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (error) {
      if (fd !== null && fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (_) {}
      throw error;
    }
    return readSettings();
  }
  function validateSettings(value) {
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'effort,model') {
      throw Object.assign(new Error('Settings must contain only model and effort'), { statusCode: 400 });
    }
    if (typeof value.model !== 'string' || !MODEL_PATTERN.test(value.model)) throw Object.assign(new Error('Unsupported model'), { statusCode: 400 });
    if (typeof value.effort !== 'string' || !EFFORTS.has(value.effort)) throw Object.assign(new Error('Unsupported reasoning effort'), { statusCode: 400 });
    return { model: value.model, effort: value.effort };
  }
  const descriptor = Object.freeze({
    name: SYSTEM_AGENT_NAME,
    displayName: DISPLAY_NAME,
    model: role.model,
    effort: role.effort,
    defaults: { ...defaultSettings },
    sandbox: role.sandbox,
    scope: 'system',
    workspace: canonicalRepo,
    endpoint: agentEndpoint.toString(),
    status: 'lazy',
  });
  const card = makeAgentCard(agentEndpoint.toString(), role, profileSha256);
  const router = express.Router();
  let serviceApp = null;
  let initialized = null;
  let initPromise = null;
  let closing = false;
  const consumers = new Set();
  let sendQueue = Promise.resolve();
  let state = null;
  let appServer = null;
  let executor = null;
  let releaseStateLock = () => {};
  let releaseWorkspaceLock = () => {};

  router.get('/agents/' + SYSTEM_AGENT_NAME + '/agent-card.json', (_req, res) => res.json(card));
  router.use(async (req, res, next) => {
    if (!req.path.startsWith('/agents/' + SYSTEM_AGENT_NAME)) return next();
    if (closing) return res.status(503).json({ error: 'System agent is shutting down' });
    let authResult = false;
    authMiddleware(req, res, (error) => {
      if (error) return next(error);
      authResult = true;
    });
    if (!authResult) return;
    if (req.path.endsWith('/agent-card.json')) return next();
    if (req.path === '/agents/' + SYSTEM_AGENT_NAME + '/runtime') {
      const identity = runtimeIdentity?.snapshot;
      if (!identity) {
        return res.json({
          schema: 'system-agent-runtime-identity/v1',
          known: false,
          sourceHashes: {},
          profileHashes: {},
          uncapturedSourceFiles: ['launcher.js'],
          loadedUncapturedSourceFiles: [],
        });
      }
      return res.json({
        schema: 'system-agent-runtime-identity/v1',
        pid: identity.pid,
        moduleLoadedAt: identity.moduleLoadedAt,
        startupGitRevision: identity.startupGitRevision,
        sourceHashes: identity.sourceHashes,
        profileHashes: identity.profileHashes,
        uncapturedSourceFiles: identity.uncapturedSourceFiles,
        loadedUncapturedSourceFiles: identity.loadedUncapturedSourceFiles,
      });
    }
    let normalized;
    try {
      normalized = normalizeRpcBody(req.body, allowedFiles, requiredChecks);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    req.body = normalized;
    let resolveConsumer;
    const consumer = new Promise((resolve) => { resolveConsumer = resolve; });
    const completed = new Promise((resolve) => {
      const done = () => resolve();
      res.once('finish', done);
      res.once('close', done);
    });
    consumers.add(consumer);
    let releaseTurn = null;
    try {
      if (['SendMessage', 'SendStreamingMessage'].includes(req.body?.method)) {
        const previous = sendQueue;
        let release;
        sendQueue = new Promise((resolve) => { release = resolve; });
        await previous;
        releaseTurn = release;
      }
      await initialize();
      if (closing) {
        res.status(503).json({ error: 'System agent is shutting down' });
        return;
      }
      serviceApp(req, res, next);
      await completed;
      if (['SendMessage', 'SendStreamingMessage'].includes(req.body?.method)) {
        await executor?.settled?.();
      }
    } catch (error) {
      if (!res.headersSent) res.status(503).json({ error: 'System agent unavailable', message: error.message });
    } finally {
      releaseTurn?.();
      consumers.delete(consumer);
      resolveConsumer();
    }
  });

  async function initialize() {
    if (initialized) return initialized;
    if (initPromise) return initPromise;
    if (closing) throw new Error('System agent is shutting down');
    initPromise = (async () => {
      let localState = null;
      let localAppServer = null;
      let localReleaseStateLock = () => {};
      let localReleaseWorkspaceLock = () => {};
      try {
        localReleaseWorkspaceLock = acquireWorkspaceLock(canonicalRepo, workspaceLockDir ? { lockDir: workspaceLockDir } : undefined);
        const stateFile = path.join(runtimeDir, 'system', SYSTEM_AGENT_NAME, 'state.sqlite');
        localState = await createState({ filePath: stateFile });
        localReleaseStateLock = acquireStateLock(localState.filePath);
        const profiles = makeAccountProfiles();
        localAppServer = createSwitchingAppServer({
          profiles,
          create: (codexHome) => createAppServer({
            cwd: canonicalRepo,
            ...(codexHome ? { codexHome } : {}),
          }),
        });
        await localAppServer.start();
        const accountResult = await localAppServer.getAccount();
        const account = accountResult?.account || accountResult;
        if (account?.type !== 'chatgpt') throw new Error('Codex OAuth requires an authenticated ChatGPT account');
        await reconcileInterruptedTasks(localState);
        const admission = new WriterAdmission({ db: localState.db, workspace: canonicalRepo });
        await admission.reconcileStale();
        const isolation = await selectIsolation({
          env: {
            ...process.env,
            CODEX_A2A_WRITER_ISOLATION: 'worktree',
            CODEX_A2A_LANE_LINKS: '.venv,venv,node_modules',
          },
          appServer: localAppServer,
          workspace: canonicalRepo,
          db: localState.db,
          stateFile: localState.filePath,
          home: path.join(runtimeDir, 'system', SYSTEM_AGENT_NAME),
        });
        const lanes = makeLaneManager({
          db: localState.db,
          workspace: canonicalRepo,
          admission,
          appServer: localAppServer,
          ...isolation,
        });
        lanes.recover({ retentionHours: laneRetentionHours(process.env.CODEX_A2A_LANE_RETENTION_HOURS) });
        const usageLedger = new UsageLedger({ db: localState.db });
        const stagingLog = new StagingLog({ db: localState.db });
        const activityStore = createActivityStore(localState.db);
        const taskApp = express();
        serviceApp = taskApp;
        const journal = new DispatchJournal(localState);
        const registered = registerAgents(protectRoleRpcMounts(taskApp, authMiddleware), {
          roles: new Map([[SYSTEM_AGENT_NAME, role]]),
          appServer: localAppServer,
          workspace: canonicalRepo,
          baseUrl: agentEndpoint.origin,
          admission,
          usageLedger,
          activityStore,
          skillCatalog: new Map(),
          stagingLog,
          lanes,
          requireIsolatedWrites: true,
          taskStoreFactory: (roleId) => createTaskStore(localState, roleId),
          artifactMetadata: ({ writerExecution }) => ({
            systemSourceManifest: systemSourceManifest(canonicalRepo, writerExecution),
          }),
        });
        const registration = registered.get(SYSTEM_AGENT_NAME);
        if (!registration?.handler || !registration?.executor?.cancelAll || !registration?.executor?.settled) {
          throw new Error('System role registration has no complete lifecycle handle');
        }
        localState.db.prepare('SELECT 1').get();
        state = localState;
        appServer = localAppServer;
        executor = registration.executor;
        releaseStateLock = localReleaseStateLock;
        releaseWorkspaceLock = localReleaseWorkspaceLock;
        initialized = { role, appServer, state, admission, journal, registration };
        return initialized;
      } catch (error) {
        if (localAppServer) await localAppServer.close().catch(() => {});
        if (localState) await localState.close().catch(() => {});
        localReleaseStateLock();
        localReleaseWorkspaceLock();
        serviceApp = null;
        throw error;
      }
    })();
    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function close() {
    if (closing) return;
    closing = true;
    if (initPromise) {
      try { await initPromise; } catch (_) { /* initialization released its own resources */ }
    }
    if (!initialized) return;
    executor.cancelAll();
    await Promise.race([
      executor.settled(),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, closeGraceMs);
        timer.unref?.();
      }),
    ]);
    try {
      await appServer.close();
    } finally {
      await Promise.all([...consumers]);
      await executor.settled();
      await new Promise((resolve) => setImmediate(resolve));
      await state.close();
      releaseStateLock();
      releaseWorkspaceLock();
      initialized = null;
      state = null;
      appServer = null;
      executor = null;
      serviceApp = null;
    }
  }

  return {
    router,
    card,
    descriptor: () => {
      const configured = readSettings();
      return {
        ...descriptor,
        configuredModel: configured.model,
        configuredEffort: configured.effort,
        pendingRestart: configured.model !== role.model || configured.effort !== role.effort,
        status: initialized ? 'ready' : 'lazy',
      };
    },
    saveSettings(value) {
      return writeSettings(validateSettings(value));
    },
    resetSettings() {
      return writeSettings(defaultSettings);
    },
    initialize,
    close,
  };
}

module.exports = {
  createSystemAgentService,
  hasForbiddenBoundaryKey,
  normalizeRpcBody,
  normalizeSystemRequest,
  SYSTEM_SEND_METHODS,
  systemSourceManifest,
};
