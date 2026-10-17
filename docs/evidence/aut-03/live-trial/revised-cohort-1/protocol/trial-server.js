'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const pins = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/aut-03/trial-runtime-pins.json'), 'utf8'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
if (!['true', 'false'].includes(process.env.AUT03_TRIAL_EXPECTED_SKILL_ENABLED || '')) {
  throw new Error('AUT03_TRIAL_EXPECTED_SKILL_ENABLED must be true or false.');
}
const expectedEnabled = process.env.AUT03_TRIAL_EXPECTED_SKILL_ENABLED === 'true';
const settingPath = process.env.CODEX_A2A_PROJECT_SETTINGS;
const attestationPath = process.env.AUT03_TRIAL_ATTESTATION_FILE;
if (!settingPath || !attestationPath) throw new Error('Trial settings and attestation paths are required.');
if (process.env.CODEX_A2A_ROLE_OVERRIDES) throw new Error('Role overrides must be unset for the trial.');
if ((process.env.CODEX_A2A_AUT03_TRIAL_RUN_IDS || '') !== '') throw new Error('The AUT-03 UUID allowlist must be empty.');

function verifyPinnedFiles() {
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), pins.repository.branch);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), pins.repository.commit);
  const dirtyPaths = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((line) => line.slice(3));
  assert.ok(dirtyPaths.every((relativePath) => relativePath.startsWith('docs/evidence/aut-03/')),
    `Unexpected working-tree changes: ${dirtyPaths.filter((relativePath) => !relativePath.startsWith('docs/evidence/aut-03/')).join(', ')}`);
  for (const item of pins.runtime.sourceFiles) {
    assert.equal(hash(fs.readFileSync(path.join(root, item.path))), item.sha256, `Source pin drift: ${item.path}`);
  }
  for (const item of pins.trialHelpers) {
    assert.equal(hash(fs.readFileSync(path.join(root, item.path))), item.sha256, `Trial helper drift: ${item.path}`);
  }
  for (const item of pins.runtime.binaryFiles) {
    assert.equal(hash(fs.readFileSync(item.path)), item.sha256, `Runtime binary drift: ${item.path}`);
  }
  assert.equal(process.version, pins.runtime.nodeVersion);
  const nodeBinary = pins.runtime.binaryFiles.find((item) => item.path.endsWith('/node'));
  assert.ok(nodeBinary, 'Pinned Node executable is missing.');
  assert.equal(fs.realpathSync(process.execPath), nodeBinary.path);
  const codexLookup = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync(codexLookup), pins.runtime.codexResolvedPath);
  assert.equal(execFileSync(codexLookup, ['--version'], { encoding: 'utf8' }).trim(), pins.runtime.codexCliVersion);
  assert.equal(fs.realpathSync(pins.runtime.codexHome), pins.runtime.codexHome, 'Pinned system account CODEX_HOME is unavailable.');
  const settings = pins.settings[expectedEnabled ? 'on' : 'off'];
  const settingBytes = fs.readFileSync(settingPath);
  assert.equal(settingBytes.toString('utf8'), settings.exactBytes);
  assert.equal(hash(settingBytes), settings.sha256);
  const trialEntry = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/aut-03/trial-entry.json'), 'utf8'));
  assert.deepEqual(trialEntry.previousAcceptedEvidence, pins.acceptedEvidence, 'Accepted offline evidence pins changed.');
  for (const accepted of Object.values(pins.acceptedEvidence)) {
    assert.equal(hash(fs.readFileSync(path.join(root, accepted.path))), accepted.sha256, `Accepted evidence drift: ${accepted.path}`);
  }
  const entry = trialEntry;
  assert.equal(entry.s0.baselineCaptureAllowed, true, 'The baseline entry gate is not open.');
  assert.equal(hash(fs.readFileSync(path.join(root, 'docs/evidence/aut-03/trial-runtime-pins.json'))), entry.trialDeclaration.runtime.pinFileSha256);
  const declarationPath = path.join(root, 'docs/evidence/aut-03/paired-trial-declaration.md');
  assert.equal(hash(fs.readFileSync(declarationPath)), entry.trialDeclaration.trialPlan.sha256);
  const runtimePinsPath = path.join(root, 'docs/evidence/aut-03/trial-runtime-pins.json');
  assert.equal(hash(fs.readFileSync(runtimePinsPath)), entry.trialDeclaration.runtime.pinFileSha256);
  const promptPath = path.join(root, 'docs/evidence/aut-03/trial-prompts.json');
  assert.equal(hash(fs.readFileSync(promptPath)), entry.trialDeclaration.prompts.sha256);
  const prompts = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
  const prompt = prompts.prompts[process.env.AUT03_TRIAL_CASE_ID];
  assert.ok(prompt, 'Trial case ID is not in the frozen prompt manifest.');
  assert.equal(hash(Buffer.from(prompt.text, 'utf8')), prompt.sha256, 'Trial prompt hash mismatch.');
  const workspace = process.env.CODEX_WORKSPACE;
  const workspaceRoot = pins.trialEnforcement.workspaceRoot;
  assert.equal(path.resolve(workspace), fs.realpathSync(workspace), 'Trial workspace root must not be a symlink.');
  assert.ok(path.resolve(workspace).startsWith(`${path.resolve(workspaceRoot)}${path.sep}`), 'Trial workspace is outside the dedicated cohort root.');
  assert.ok(path.relative(root, path.resolve(workspace)).startsWith('..'), 'Trial workspace must be outside the repository.');
  const actualFiles = [];
  const walk = (directory, relative = '') => {
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      assert.ok(!child.isSymbolicLink(), `Workspace symlink rejected: ${childRelative}`);
      if (child.isDirectory()) walk(absolute, childRelative);
      else {
        assert.ok(child.isFile(), `Workspace entry is not a regular file: ${childRelative}`);
        actualFiles.push(childRelative);
      }
    }
  };
  walk(workspace);
  actualFiles.sort();
  assert.deepEqual(actualFiles, [], 'Trial workspace must be empty; frozen inputs are embedded in the prompt.');
  fs.chmodSync(workspace, 0o555);
  assert.equal(fs.statSync(workspace).mode & 0o222, 0, 'Trial workspace must be read-only.');
  assert.throws(() => fs.accessSync(workspace, fs.constants.W_OK), { code: 'EACCES' }, 'Trial workspace must not be writable by the server user.');
  for (const relativePath of prompt.inputs) {
    assert.equal(hash(fs.readFileSync(path.join(root, relativePath))), prompts.inputs[relativePath], `Repository input drift: ${relativePath}`);
  }
  return { settingsHash: settings.sha256, codexPath: pins.runtime.codexResolvedPath, codexHome: pins.runtime.codexHome };
}

async function main() {
  const preflight = verifyPinnedFiles();
  const { bootstrap } = require(path.join(root, 'server-bootstrap'));
  const { CodexAppServer } = require(path.join(root, 'src/codex-app-server'));
  const { LeadOrchestrator } = require(path.join(root, 'src/lead-orchestrator'));
  const { createLeadRole } = require(path.join(root, 'src/role-catalog'));
  const { AUT03_SKILL_ID, AUT03_SKILL_SHA256 } = require(path.join(root, 'src/aut03-lead-skill'));
  const { createHash } = crypto;
  const roleHash = (role) => createHash('sha256').update(JSON.stringify([
    role.name, role.sandbox, role.model, role.effort, role.instructions || '',
    role.tools?.mcpServers || [], role.tools?.skills === true,
  ])).digest('hex');
  const expectedRoleHash = pins.effectiveLeadProfile.sha256;
  assert.equal(roleHash(createLeadRole({ profilesDir: path.join(root, 'profiles') })), expectedRoleHash);
  const appServer = new CodexAppServer({ codexPath: preflight.codexPath, codexHome: preflight.codexHome });
  let accountAttestation = null;
  const originalGetAccount = appServer.getAccount.bind(appServer);
  appServer.getAccount = async function trialPinnedAccount(...args) {
    const result = await originalGetAccount(...args);
    const account = result?.account || result;
    assert.equal(account?.type, 'chatgpt', 'Pinned system CODEX_HOME is not authenticated to ChatGPT.');
    assert.equal(account?.planType, pins.runtime.codexAccountPlanType, 'Pinned system account plan type changed.');
    accountAttestation = { type: account.type, planType: account.planType || null };
    return result;
  };

  const instance = await bootstrap({
    start(server, runtimeIdentity) {
      return server.startServer({
        port: Number(process.env.PORT),
        workspace: process.env.CODEX_WORKSPACE,
        stateFile: process.env.CODEX_A2A_STATE_DB,
        tokenFile: process.env.CODEX_A2A_TOKEN_FILE,
        appServer,
        projectSettingsFile: settingPath,
        profilesDir: path.join(root, 'profiles'),
        roleOverridesFile: null,
        autoResume: false,
        runtimeIdentity,
        orchestratorFactory(options) {
          assert.equal(options.aut03LeadSkillEnabled, expectedEnabled, 'Effective project setting mismatch.');
          assert.equal(options.aut03TrialRunIds.size, 0, 'Unexpected run UUID restriction.');
          assert.equal(roleHash(options.leadRole), expectedRoleHash, 'Effective lead profile mismatch.');
          assert.equal(options.leadRole.model, pins.model.id);
          assert.equal(options.leadRole.effort, pins.model.reasoningEffort);
          assert.deepEqual(options.leadRole.tools, { mcpServers: [], skills: false });
          assert.equal(options.appServer, appServer, 'Trial must use the directly pinned Codex App Server instance.');
          assert.ok(options.appServer instanceof CodexAppServer, 'Account-switching App Server wrapper is not allowed.');
          assert.equal(options.appServer.codexHome, pins.runtime.codexHome);
          assert.ok(accountAttestation, 'Pinned system account was not verified before orchestrator construction.');
          assert.ok(options.roles instanceof Map, 'Effective worker roles must be a Map.');
          const removedWorkerRoleIds = [...options.roles.keys()].map(String).sort();
          options.roles.clear();
          assert.equal(options.roles.size, 0, 'Worker roles must be unavailable to the trial orchestrator and A2A routes.');
          assert.equal(typeof options.appServer._toolPolicy, 'function', 'Codex per-thread tool policy hook is unavailable.');
          assert.equal(typeof options.appServer._request, 'function', 'Codex request hook is unavailable.');
          const disabledFeatures = pins.trialEnforcement.disabledCodexFeatures;
          assert.ok(Array.isArray(disabledFeatures) && disabledFeatures.length > 0, 'Pinned native tool restrictions are missing.');
          let attestation = null;
          const originalToolPolicy = options.appServer._toolPolicy;
          options.appServer._toolPolicy = async function trialToolPolicy(role, cwd, selectedMcpTools) {
            const result = await originalToolPolicy.call(this, role, cwd, selectedMcpTools);
            for (const feature of disabledFeatures) result.config[`features.${feature}`] = false;
            result.config.web_search = 'disabled';
            result.policy.trialDisabledFeatures = [...disabledFeatures];
            result.policy.trialWebSearch = 'disabled';
            return result;
          };
          const originalRequest = options.appServer._request.bind(options.appServer);
          options.appServer._request = async function trialPinnedRequest(method, params, requestOptions) {
            if (method === 'thread/start' || method === 'thread/resume') {
              assert.equal(params.model, pins.model.id, `Unexpected model on ${method}.`);
              assert.equal(params.sandbox, 'read-only', `Trial sandbox is not read-only on ${method}.`);
              assert.equal(params.approvalPolicy, 'on-request', `Trial approval policy changed on ${method}.`);
              const config = params?.config || {};
              for (const feature of disabledFeatures) {
                assert.equal(config[`features.${feature}`], false, `Native Codex feature was not disabled for ${method}: ${feature}`);
              }
              assert.equal(config.web_search, 'disabled', `Web search was not disabled for ${method}.`);
              attestation.threadConfig = {
                method,
                model: params.model,
                sandbox: params.sandbox,
                approvalPolicy: params.approvalPolicy,
                disabledFeatures: [...disabledFeatures],
                webSearch: config.web_search,
                verifiedAt: new Date().toISOString(),
              };
              fs.writeFileSync(attestationPath, JSON.stringify(attestation, null, 2) + '\n', { mode: 0o600 });
            }
            return originalRequest(method, params, requestOptions);
          };
          const skill = options.skillCatalog.get(AUT03_SKILL_ID);
          assert.ok(skill, 'Pinned lead skill is missing from the catalog.');
          assert.equal(skill.audience, 'lead');
          assert.equal(skill.sha256, AUT03_SKILL_SHA256);
          assert.equal(skill.sha256, pins.skill.sha256);
          attestation = {
            schemaVersion: 'aut-03-arm-attestation/v1',
            arm: expectedEnabled ? 'skill-on' : 'skill-off',
            aut03LeadSkillEnabled: options.aut03LeadSkillEnabled,
            uuidAllowlistSize: options.aut03TrialRunIds.size,
            leadProfileSha256: roleHash(options.leadRole),
            model: options.leadRole.model,
            reasoningEffort: options.leadRole.effort,
            leadTools: options.leadRole.tools,
            workerRoles: { removedCount: removedWorkerRoleIds.length, remainingCount: options.roles.size },
            trialEnforcement: {
              disabledCodexFeatures: [...disabledFeatures],
              webSearch: 'disabled',
              workerRolesRemovedBeforeOrchestratorAndRouteRegistration: true,
              sourceInputsEmbeddedInPrompt: true,
              workspaceRoot: pins.trialEnforcement.workspaceRoot,
              workspaceEmptyAndReadOnlyRequired: true,
            },
            skill: { id: AUT03_SKILL_ID, sha256: skill.sha256, audience: skill.audience },
            settingsSha256: preflight.settingsHash,
            codexPath: preflight.codexPath,
            codexHome: preflight.codexHome,
            account: accountAttestation,
            accountSwitchingEnabled: false,
            sourceCommit: pins.repository.commit,
            attestedAt: new Date().toISOString(),
            pid: process.pid,
          };
          fs.mkdirSync(path.dirname(attestationPath), { recursive: true });
          fs.writeFileSync(attestationPath, JSON.stringify(attestation, null, 2) + '\n', { mode: 0o600 });
          return new LeadOrchestrator(options);
        },
      });
    },
  });
  process.stdout.write(`AUT-03 trial server ready at http://${instance.host}:${instance.port}\n`);
  const shutdown = () => instance.close().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
