const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createPermissionProfile, resolveCodexInstallDir, assertActivePermissionProfile, assertCodexHomeOutsideWorkspace,
  resolveTrustedNpmInstallDir,
} = require('../src/permission-profile');

test('creates workspace-write and read-only profiles with explicit restrictive rules', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-permission-profile-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const relative of ['node_modules', '.claude', '.agents', '.codex', '.codex/sessions', '.runtime', 'runtime', 'data']) {
    fs.mkdirSync(path.join(workspace, relative), { recursive: true });
  }
  fs.mkdirSync(path.join(workspace, '.git'));
  fs.writeFileSync(path.join(workspace, '.env'), 'fixture');
  fs.writeFileSync(path.join(workspace, '.codex/auth.json'), 'fixture');
  for (const relative of ['.codex/AGENTS.md', '.codex/instructions.md', '.codex/TEAM.md']) {
    fs.writeFileSync(path.join(workspace, relative), 'instruction');
  }
  fs.writeFileSync(path.join(workspace, '.codex/config.toml'), 'model = "gpt-6-sol"');
  const common = { cwd: workspace, codexPath: process.execPath };
  const write = createPermissionProfile({ ...common, role: { name: 'worker', sandbox: 'workspace-write', instructions: 'Read the team rules at /trusted/team/TEAM.md.' } });
  const read = createPermissionProfile({ ...common, role: { name: 'lead', sandbox: 'read-only' } });
  const writeFs = write.config[`permissions.${write.id}.filesystem`];
  const readFs = read.config[`permissions.${read.id}.filesystem`];

  assert.equal(write.id, 'codex-a2a-workspace-write');
  assert.equal(read.id, 'codex-a2a-read-only');
  assert.equal(writeFs[':root'], 'deny');
  assert.equal(writeFs[':minimal'], 'read');
  assert.equal(writeFs[workspace], 'write');
  assert.equal(readFs[workspace], 'read');
  assert.equal(writeFs[path.join(workspace, '.runtime')], 'deny');
  assert.equal(writeFs[path.join(workspace, '.git')], 'read');
  assert.equal(writeFs[path.join(workspace, '.env')], 'deny');
  assert.equal(writeFs[path.join(workspace, '.env.*')], 'deny');
  assert.equal(writeFs[path.join(workspace, 'node_modules')], 'read');
  assert.equal(writeFs[path.join(workspace, '.claude')], 'read');
  assert.equal(writeFs[path.join(workspace, '.agents')], 'read');
  assert.equal(Object.hasOwn(writeFs, path.join(workspace, 'artifacts/dashboard')), false);
  assert.equal(writeFs[path.join(workspace, 'runtime')], 'deny');
  assert.equal(writeFs[path.join(workspace, 'data')], 'deny');
  assert.equal(writeFs[path.join(workspace, '.codex')], 'read');
  assert.equal(readFs[path.join(workspace, '.codex')], 'deny');
  assert.equal(writeFs[path.join(workspace, '.codex/AGENTS.md')], 'read');
  assert.equal(writeFs[path.join(workspace, '.codex/instructions.md')], 'read');
  assert.equal(writeFs[path.join(workspace, '.codex/TEAM.md')], 'read');
  assert.equal(writeFs[path.join(workspace, '.codex/config.toml')], 'read');
  assert.equal(writeFs[path.join(workspace, '.codex/auth.json*')], 'deny');
  assert.equal(writeFs[path.join(workspace, '.codex/sessions/**')], 'deny');
  assert.equal(Object.hasOwn(readFs, path.join(workspace, '.codex/auth.json')), false);
  assert.equal(Object.hasOwn(readFs, path.join(workspace, '.codex/sessions')), false);
  assert.equal(readFs[path.join(workspace, '.codex/AGENTS.md')], 'read');
  assert.equal(readFs[path.join(workspace, 'node_modules')], 'read');
  assert.equal(readFs[path.join(workspace, '.claude')], 'read');
  assert.equal(readFs[path.join(workspace, '.agents')], 'read');
  assert.equal(Object.hasOwn(readFs, path.join(workspace, 'artifacts/dashboard')), false);
  assert.equal(writeFs[resolveCodexInstallDir(process.execPath)], 'read');
  const nodeExecutable = fs.realpathSync(process.execPath);
  assert.equal(writeFs[nodeExecutable], 'read');
  assert.equal(writeFs[path.dirname(nodeExecutable)], 'read');
  const npmInstall = resolveTrustedNpmInstallDir(process.env);
  if (npmInstall) {
    assert.equal(writeFs[npmInstall.installDir], 'read');
    assert.equal(writeFs[npmInstall.executable], 'read');
  }
  assert.equal(write.config[`permissions.${write.id}.network.enabled`], false);
  assert.equal(read.config[`permissions.${read.id}.network.enabled`], false);
});

test('workspace-write profiles reject application-root overlap, including symlink aliases', (t) => {
  const applicationRoot = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-app-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const alias = path.join(root, 'application-alias');
  fs.symlinkSync(applicationRoot, alias, 'dir');
  const role = { name: 'worker', sandbox: 'workspace-write' };
  for (const cwd of [applicationRoot, path.dirname(applicationRoot), path.join(applicationRoot, 'test'), alias]) {
    assert.throws(
      () => createPermissionProfile({ role, cwd, codexPath: process.execPath }),
      /workspace overlapping the application root/,
      cwd,
    );
  }

  const external = path.join(root, 'external-workspace');
  fs.mkdirSync(external);
  assert.doesNotThrow(() => createPermissionProfile({ role, cwd: external, codexPath: process.execPath }));
});

test('rejects CODEX_HOME and the default HOME/.codex when they resolve inside the workspace', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-in-workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const role = { name: 'worker', sandbox: 'workspace-write' };
  assert.throws(() => createPermissionProfile({ role, cwd: workspace, codexPath: process.execPath, env: { ...process.env, CODEX_HOME: path.join(workspace, 'credentials') } }), /CODEX_HOME must resolve outside/);
  const defaultHome = path.join(workspace, 'home');
  fs.mkdirSync(defaultHome);
  const env = { ...process.env, HOME: defaultHome };
  delete env.CODEX_HOME;
  assert.throws(() => createPermissionProfile({ role, cwd: workspace, codexPath: process.execPath, env }), /CODEX_HOME must resolve outside/);
});

test('rejects CODEX_HOME aliases that resolve into or through the workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const insideTarget = path.join(workspace, 'private-codex-home');
  fs.mkdirSync(insideTarget);
  const outsideAlias = path.join(outside, 'codex-home');
  fs.symlinkSync(insideTarget, outsideAlias, 'dir');
  const insideAlias = path.join(workspace, 'codex-home-alias');
  fs.symlinkSync(outside, insideAlias, 'dir');
  for (const CODEX_HOME of [outsideAlias, path.join(insideAlias, 'credentials')]) {
    assert.throws(
      () => assertCodexHomeOutsideWorkspace(workspace, { ...process.env, CODEX_HOME }),
      /CODEX_HOME must resolve outside/,
    );
  }
});

test('allows an effective CODEX_HOME outside the workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-outside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(workspace);
  assert.equal(assertCodexHomeOutsideWorkspace(workspace, { ...process.env, CODEX_HOME: codexHome }), codexHome);
});

test('resolves the Codex install directory from PATH and executable links', () => {
  const dir = path.dirname(process.execPath);
  assert.equal(resolveCodexInstallDir(process.execPath), dir);
  assert.equal(resolveCodexInstallDir(path.basename(process.execPath), { PATH: dir }), dir);
  assert.throws(() => resolveCodexInstallDir('codex-missing-for-test', { PATH: '' }), /Could not resolve Codex executable/);
});

test('rejects unsupported role sandbox modes', () => {
  for (const sandbox of [undefined, 'danger-full-access', 'unknown']) {
    assert.throws(
      () => createPermissionProfile({ role: { name: 'worker', sandbox }, cwd: '/workspace/project', codexPath: process.execPath }),
      /Unsupported role sandbox/,
    );
  }
});

test('protects future .codex auth and sessions files without mounting an absent directory', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-no-codex-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const profile = createPermissionProfile({ role: { name: 'worker', sandbox: 'workspace-write' }, cwd: workspace, codexPath: process.execPath });
  const entries = profile.config[`permissions.${profile.id}.filesystem`];
  assert.equal(entries[path.join(workspace, '.codex')], 'read');
  for (const relative of ['.runtime', '.env', 'runtime', 'data']) {
    assert.equal(Object.hasOwn(entries, path.join(workspace, relative)), false, `absent ${relative} must have no entry`);
  }
  assert.equal(entries[path.join(workspace, '.codex', 'auth.json*')], 'deny');
  assert.equal(entries[path.join(workspace, '.codex', 'sessions', '**')], 'deny');
});

test('uses future-path patterns instead of exact deny entries for absent Codex credential files', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-empty-codex-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.codex'));
  const profile = createPermissionProfile({
    role: { name: 'worker', sandbox: 'workspace-write' },
    cwd: workspace,
    codexPath: process.execPath,
  });
  const entries = profile.config[`permissions.${profile.id}.filesystem`];
  assert.equal(Object.hasOwn(entries, path.join(workspace, '.codex', 'auth.json')), false);
  assert.equal(Object.hasOwn(entries, path.join(workspace, '.codex', 'sessions')), false);
  assert.equal(entries[path.join(workspace, '.codex', 'auth.json*')], 'deny');
  assert.equal(entries[path.join(workspace, '.codex', 'sessions', '**')], 'deny');
});

test('keeps workspace-write permission binding stable as protected workspace paths appear', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-stable-binding-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const role = { name: 'worker', sandbox: 'workspace-write' };
  const common = { role, cwd: workspace, codexPath: process.execPath };
  const before = createPermissionProfile(common);

  fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
  for (const relative of ['AGENTS.md', 'instructions.md', 'TEAM.md', 'config.toml', 'settings.json', 'auth.json']) {
    fs.writeFileSync(path.join(workspace, '.codex', relative), 'fixture');
  }
  fs.mkdirSync(path.join(workspace, '.codex', 'sessions'));
  const afterCodex = createPermissionProfile(common);
  assert.equal(afterCodex.binding, before.binding);

  for (const relative of ['.git', '.runtime', 'runtime', 'data', 'node_modules', '.claude', '.agents']) {
    fs.mkdirSync(path.join(workspace, relative), { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, '.env'), 'fixture');
  const afterProtectedPaths = createPermissionProfile(common);
  assert.equal(afterProtectedPaths.binding, before.binding);

  const entries = afterProtectedPaths.config[`permissions.${afterProtectedPaths.id}.filesystem`];
  assert.equal(entries[path.join(workspace, '.codex')], 'read');
  assert.equal(entries[path.join(workspace, '.codex', 'auth.json*')], 'deny');
  assert.equal(entries[path.join(workspace, '.codex', 'sessions', '**')], 'deny');
  for (const relative of ['.runtime', '.env', 'runtime', 'data']) {
    assert.equal(entries[path.join(workspace, relative)], 'deny');
  }
});

const MISSING_OPTIONAL = [
  '.runtime', '.env', 'runtime', 'data', 'node_modules', 'artifacts', 'artifacts/dashboard',
  '.codex/AGENTS.md', '.codex/instructions.md', '.codex/TEAM.md', '.codex/config.toml', '.codex/settings.json',
];

test('a bare repository workspace yields no entry for any missing optional path', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-bare-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.git'));
  for (const sandbox of ['workspace-write', 'read-only']) {
    const profile = createPermissionProfile({ role: { name: 'worker', sandbox }, cwd: workspace, codexPath: process.execPath });
    const entries = profile.config[`permissions.${profile.id}.filesystem`];
    for (const relative of MISSING_OPTIONAL) {
      assert.equal(Object.hasOwn(entries, path.join(workspace, relative)), false, `${sandbox} ${relative}`);
    }
    assert.equal(entries[path.join(workspace, '.git')], 'read');
  }
});

test('existing optional paths get entries with the expected permission', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-existing-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const relative of ['.runtime', 'runtime', 'node_modules', '.claude', '.agents', '.codex']) fs.mkdirSync(path.join(workspace, relative));
  fs.writeFileSync(path.join(workspace, '.env'), 'x');
  fs.writeFileSync(path.join(workspace, 'data'), 'x');
  fs.writeFileSync(path.join(workspace, '.codex', 'AGENTS.md'), 'x');
  fs.mkdirSync(path.join(workspace, '.codex', 'TEAM.md'));
  const profile = createPermissionProfile({ role: { name: 'worker', sandbox: 'workspace-write' }, cwd: workspace, codexPath: process.execPath });
  const entries = profile.config[`permissions.${profile.id}.filesystem`];
  for (const relative of ['.runtime', '.env', 'runtime', 'data']) assert.equal(entries[path.join(workspace, relative)], 'deny', relative);
  for (const relative of ['node_modules', '.claude', '.agents', '.codex/AGENTS.md']) assert.equal(entries[path.join(workspace, relative)], 'read', relative);
  assert.equal(Object.hasOwn(entries, path.join(workspace, '.codex/TEAM.md')), false, 'wrong type is skipped');
  assert.equal(Object.hasOwn(entries, path.join(workspace, '.codex/config.toml')), false);
});

test('binding ignores optional path existence while config follows it, and differs by sandbox mode', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-binding-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const common = { cwd: workspace, codexPath: process.execPath };
  const write = { name: 'worker', sandbox: 'workspace-write' };
  const before = createPermissionProfile({ ...common, role: write });
  fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.codex', 'AGENTS.md'), 'x');
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.env'), 'x');
  fs.mkdirSync(path.join(workspace, 'data'));
  const after = createPermissionProfile({ ...common, role: write });
  assert.equal(after.binding, before.binding);
  assert.notDeepEqual(after.config, before.config);
  const read = createPermissionProfile({ ...common, role: { name: 'lead', sandbox: 'read-only' } });
  assert.notEqual(read.binding, after.binding);
});

test('a symbolic-link optional path is still refused when present', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(workspace, 'node_modules'), 'dir');
  assert.throws(
    () => createPermissionProfile({ role: { name: 'worker', sandbox: 'workspace-write' }, cwd: workspace, codexPath: process.execPath }),
    /must not be a symbolic link/,
  );
});

test('grants read-only access to linked worktree gitdir and common dir', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-linked-worktree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commonDir = path.join(root, 'repository', '.git');
  const gitDir = path.join(commonDir, 'worktrees', 'feature');
  const worktree = path.join(root, 'feature-worktree');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);

  const profile = createPermissionProfile({
    role: { name: 'worker', sandbox: 'workspace-write' },
    cwd: worktree,
    codexPath: process.execPath,
  });
  const entries = profile.config[`permissions.${profile.id}.filesystem`];
  assert.equal(entries[worktree], 'write');
  assert.equal(entries[gitDir], 'read');
  assert.equal(entries[commonDir], 'read');
});

test('ignores a .git pointer that does not resolve to validated worktree metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-invalid-git-pointer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(workspace);
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${unrelated}\n`);

  const profile = createPermissionProfile({
    role: { name: 'worker', sandbox: 'workspace-write' },
    cwd: workspace,
    codexPath: process.execPath,
  });
  const entries = profile.config[`permissions.${profile.id}.filesystem`];
  assert.equal(Object.hasOwn(entries, unrelated), false);
  assert.equal(entries[path.join(workspace, '.git')], 'read');
});

test('grants only the exact trusted TEAM.md path and accepts sentence punctuation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-team-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const trustedProfiles = path.join(root, 'profiles');
  fs.mkdirSync(workspace);
  fs.mkdirSync(trustedProfiles);
  const teamPath = path.join(trustedProfiles, 'TEAM.md');
  const unrelatedPath = path.join(root, 'secrets', 'TEAM.md');
  fs.mkdirSync(path.dirname(unrelatedPath));
  fs.writeFileSync(teamPath, 'Trusted team rules');
  fs.writeFileSync(unrelatedPath, 'Untrusted text target');

  const accepted = createPermissionProfile({
    role: { name: 'worker', sandbox: 'workspace-write', instructions: `Read the team rules at ${teamPath}. Follow them.` },
    cwd: workspace,
    codexPath: process.execPath,
  });
  const rejected = createPermissionProfile({
    role: { name: 'worker', sandbox: 'workspace-write', instructions: `An untrusted note mentions ${unrelatedPath}.` },
    cwd: workspace,
    codexPath: process.execPath,
  });
  assert.equal(accepted.config[`permissions.${accepted.id}.filesystem`][teamPath], 'read');
  assert.equal(Object.hasOwn(rejected.config[`permissions.${rejected.id}.filesystem`], unrelatedPath), false);
});

test('fails closed when App Server omits or changes the active profile ID', () => {
  assert.throws(() => assertActivePermissionProfile({}, 'codex-a2a-read-only', 'thread/start'), /received none/);
  assert.throws(() => assertActivePermissionProfile({ activePermissionProfile: { id: ':workspace' } }, 'codex-a2a-read-only', 'thread/resume'), /received :workspace/);
  assert.doesNotThrow(() => assertActivePermissionProfile({ activePermissionProfile: { id: 'codex-a2a-read-only' } }, 'codex-a2a-read-only', 'thread/start'));
});

test('a bare repository workspace gets real empty protected directories and a clean status', (t) => {
  const { execFileSync } = require('node:child_process');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-ensure-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  createPermissionProfile({ role: { name: 'worker', sandbox: 'workspace-write' }, cwd: workspace, codexPath: process.execPath });
  for (const name of ['.codex', '.agents', '.claude']) {
    assert.equal(fs.lstatSync(path.join(workspace, name)).isDirectory(), true, name);
    assert.deepEqual(fs.readdirSync(path.join(workspace, name)), [], name);
  }
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }), '');
});

test('writer profiles read-protect .codex, .agents and .claude; read-only profiles deny .codex', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-perms-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const common = { cwd: workspace, codexPath: process.execPath };
  const write = createPermissionProfile({ ...common, role: { name: 'worker', sandbox: 'workspace-write' } });
  const writeEntries = write.config[`permissions.${write.id}.filesystem`];
  for (const name of ['.codex', '.agents', '.claude']) assert.equal(writeEntries[path.join(workspace, name)], 'read', name);
  const read = createPermissionProfile({ ...common, role: { name: 'lead', sandbox: 'read-only' } });
  assert.equal(read.config[`permissions.${read.id}.filesystem`][path.join(workspace, '.codex')], 'deny');
});

test('a non-directory protected path fails closed and nothing else is created', (t) => {
  const common = { role: { name: 'worker', sandbox: 'workspace-write' }, codexPath: process.execPath };
  const fileWs = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-ensure-file-'));
  const linkWs = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-ensure-link-'));
  t.after(() => {
    fs.rmSync(fileWs, { recursive: true, force: true });
    fs.rmSync(linkWs, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(fileWs, '.claude'), '');
  assert.throws(() => createPermissionProfile({ ...common, cwd: fileWs }), /\.claude/);
  assert.deepEqual(fs.readdirSync(fileWs).sort(), ['.claude']);
  fs.symlinkSync(os.tmpdir(), path.join(linkWs, '.agents'));
  assert.throws(() => createPermissionProfile({ ...common, cwd: linkWs }), /\.agents/);
  assert.deepEqual(fs.readdirSync(linkWs).sort(), ['.agents']);
});

test('binding stays identical when node_modules, .env, data and .codex/AGENTS.md appear later', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-ensure-binding-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const common = { role: { name: 'worker', sandbox: 'workspace-write' }, cwd: workspace, codexPath: process.execPath };
  const before = createPermissionProfile(common);
  fs.mkdirSync(path.join(workspace, 'node_modules'));
  fs.mkdirSync(path.join(workspace, 'data'));
  fs.writeFileSync(path.join(workspace, '.env'), 'x');
  fs.writeFileSync(path.join(workspace, '.codex', 'AGENTS.md'), 'x');
  assert.equal(createPermissionProfile(common).binding, before.binding);
});
