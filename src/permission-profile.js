const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILE_PREFIX = 'codex-a2a';

function resolveCodexInstallDir(codexPath, env = process.env) {
  if (typeof codexPath !== 'string' || !codexPath.trim()) {
    throw new TypeError('Codex executable path is required');
  }
  const candidates = path.isAbsolute(codexPath) || codexPath.includes(path.sep)
    ? [path.resolve(codexPath)]
    : (env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, codexPath));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return path.dirname(fs.realpathSync(candidate));
    } catch (_) { /* Try the next PATH entry. */ }
  }
  throw new Error(`Could not resolve Codex executable ${JSON.stringify(codexPath)} on PATH`);
}

function resolveTrustedNpmInstallDir(env = process.env) {
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'npm');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const realExecutable = fs.realpathSync(candidate);
      const npmBin = path.dirname(realExecutable);
      const installDir = path.dirname(npmBin);
      if (path.basename(realExecutable) !== 'npm-cli.js' || path.basename(npmBin) !== 'bin' || path.basename(installDir) !== 'npm') continue;
      const nodeRealPath = fs.realpathSync(process.execPath);
      const nodePrefix = path.dirname(path.dirname(nodeRealPath));
      const trustedInstallDirs = new Set([
        path.resolve(nodePrefix, 'lib', 'node_modules', 'npm'),
        path.resolve(nodePrefix, 'lib64', 'node_modules', 'npm'),
        path.resolve(nodePrefix, 'share', 'nodejs', 'npm'),
        '/usr/share/nodejs/npm',
        '/usr/lib/node_modules/npm',
        '/usr/local/lib/node_modules/npm',
      ]);
      const canonicalInstallDir = fs.realpathSync(installDir);
      if (!trustedInstallDirs.has(canonicalInstallDir)) continue;
      const packageJson = JSON.parse(fs.readFileSync(path.join(canonicalInstallDir, 'package.json'), 'utf8'));
      if (packageJson.name === 'npm') return { installDir: canonicalInstallDir, executable: realExecutable };
    } catch (_) { /* Only a validated npm installation gets a read grant. */ }
  }
  return null;
}

function realpathWithMissingTail(target) {
  const absolute = path.isAbsolute(target) ? target : path.resolve(target);
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  const missingTail = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (missingTail.length > 0) {
      if (segment === '..' && missingTail.length > 0 && missingTail[missingTail.length - 1] !== '..') missingTail.pop();
      else if (segment !== '..' || missingTail.length === 0) missingTail.push(segment);
      continue;
    }
    const candidate = `${current.endsWith(path.sep) ? current : `${current}${path.sep}`}${segment}`;
    try {
      current = fs.realpathSync(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) {
          throw new Error('Unable to resolve effective CODEX_HOME through a dangling symbolic link');
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT' && statError.code !== 'ENOTDIR') throw statError;
      }
      missingTail.push(segment);
    }
  }
  return path.resolve(current, ...missingTail);
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertWorkspaceOutsideApplicationRoot(workspace) {
  const applicationRoot = path.resolve(__dirname, '..');
  const workspacePath = path.resolve(workspace);
  const applicationRealPath = fs.realpathSync(applicationRoot);
  const workspaceRealPath = fs.realpathSync(workspacePath);
  const overlaps = (left, right) => isPathWithin(left, right) || isPathWithin(right, left);
  if (overlaps(applicationRoot, workspacePath) || overlaps(applicationRealPath, workspaceRealPath)) {
    throw new Error(`Workspace-write permission profile cannot use a workspace overlapping the application root (${applicationRoot})`);
  }
  return true;
}

function assertCodexHomeOutsideWorkspace(cwd, env = process.env) {
  const workspace = path.resolve(cwd);
  const workspaceRealPath = fs.realpathSync(workspace);
  const configuredHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME
    : path.join(typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : os.homedir(), '.codex');
  const codexHome = path.resolve(workspace, configuredHome);
  const codexHomeRealPath = realpathWithMissingTail(codexHome);
  if (isPathWithin(workspace, codexHome) || isPathWithin(workspaceRealPath, codexHomeRealPath)) {
    throw new Error('Effective CODEX_HOME must resolve outside the workspace');
  }
  return codexHomeRealPath;
}

function assertSafeOptionalPath(workspace, target, expectedType) {
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  const segments = relative.split(path.sep);
  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Sensitive workspace path must not be a symbolic link: ${path.relative(workspace, current)}`);
    if (index < segments.length - 1 && !stat.isDirectory()) return;
    if (index === segments.length - 1 && expectedType
      && !(expectedType === 'directory' ? stat.isDirectory() : stat.isFile())) return;
  }
}

function addStablePath(entries, workspace, target, permission, expectedType = 'directory') {
  assertSafeOptionalPath(workspace, target, expectedType);
  entries[target] = permission;
}

// Optional carve-outs are realized only when the target exists with the expected type: Codex creates
// read-only placeholder files in the task repository for every missing carve-out target.
const OPTIONAL_PATH_RULES = [
  { relative: '.runtime', permission: 'deny', type: 'any' },
  { relative: '.env', permission: 'deny', type: 'any' },
  { relative: 'runtime', permission: 'deny', type: 'any' },
  { relative: 'data', permission: 'deny', type: 'any' },
  { relative: 'node_modules', permission: 'read', type: 'directory' },
  { relative: '.codex/AGENTS.md', permission: 'read', type: 'file' },
  { relative: '.codex/instructions.md', permission: 'read', type: 'file' },
  { relative: '.codex/TEAM.md', permission: 'read', type: 'file' },
  { relative: '.codex/config.toml', permission: 'read', type: 'file' },
  { relative: '.codex/settings.json', permission: 'read', type: 'file' },
];

function optionalPathExists(target, type) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  if (type === 'directory') return stat.isDirectory();
  if (type === 'file') return stat.isFile();
  return true;
}

function addOptionalPath(entries, workspace, rule) {
  const target = path.join(workspace, rule.relative);
  assertSafeOptionalPath(workspace, target, rule.type === 'any' ? undefined : rule.type);
  if (optionalPathExists(target, rule.type)) entries[target] = rule.permission;
}

function assertSafeCodexDirectory(workspace) {
  const target = path.join(workspace, '.codex');
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Workspace .codex path must be a real directory: ${target}`);
    }
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

const PROTECTED_WORKSPACE_DIRS = ['.codex', '.agents', '.claude'];

// Protected config directories must exist as real directories before a profile is bound, so a
// writer can never create them (or files in them) that the unsandboxed App Server would later load.
function ensureProtectedWorkspaceDirs(workspace) {
  const missing = [];
  for (const name of PROTECTED_WORKSPACE_DIRS) {
    const target = path.join(workspace, name);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(target);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Workspace ${name} must be a real directory; remove ${name} before running`);
    }
  }
  for (const target of missing) fs.mkdirSync(target, { mode: 0o755 });
}

function readGitPathFile(filePath, prefix = '') {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const match = prefix
    ? content.match(new RegExp(`^${prefix}([^\\r\\n]+)\\r?\\n?$`))
    : content.match(/^([^\r\n]+)\r?\n?$/);
  return match?.[1]?.trim() || null;
}

function resolveGitMetadataPaths(workspace) {
  const dotGit = path.join(workspace, '.git');
  try {
    const stat = fs.lstatSync(dotGit);
    if (stat.isSymbolicLink()) return [];
    if (stat.isDirectory()) return [dotGit, fs.realpathSync(dotGit)];
    if (!stat.isFile()) return [];
    const pointer = readGitPathFile(dotGit, 'gitdir: ');
    if (!pointer) return [];
    const gitDir = fs.realpathSync(path.resolve(workspace, pointer));
    if (!fs.statSync(gitDir).isDirectory()) return [];
    const commonFile = path.join(gitDir, 'commondir');
    if (!fs.existsSync(commonFile)) return [];
    const commonPointer = readGitPathFile(commonFile);
    if (!commonPointer) return [];
    const commonDir = fs.realpathSync(path.resolve(gitDir, commonPointer));
    if (!fs.statSync(commonDir).isDirectory()) return [];
    const relativeGitDir = path.relative(commonDir, gitDir).split(path.sep);
    if (path.basename(commonDir) !== '.git' || relativeGitDir[0] !== 'worktrees' || relativeGitDir.length < 2) return [];
    return [...new Set([dotGit, gitDir, commonDir])];
  } catch (_) {
    return [];
  }
}

function trustedTeamRulesPath(instructions) {
  if (typeof instructions !== 'string') return null;
  const match = instructions.match(/(?:^|\n)Read the team rules at\s+(\/[A-Za-z0-9_./ -]*?\/TEAM\.md)(?=[\s.,;:!?)]|$)/i);
  if (!match) return null;
  const target = path.resolve(match[1]);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || path.basename(target) !== 'TEAM.md') return null;
    return fs.realpathSync(target);
  } catch (_) {
    return null;
  }
}

function createPermissionProfile({ role, cwd, codexPath, env } = {}) {
  if (!role || !role.name) throw new TypeError('role.name is required to create a permission profile');
  if (!cwd) throw new TypeError('cwd is required to create a permission profile');
  if (!['read-only', 'workspace-write'].includes(role.sandbox)) {
    throw new TypeError(`Unsupported role sandbox ${JSON.stringify(role.sandbox)}`);
  }
  const workspace = path.resolve(cwd);
  const canWrite = role.sandbox === 'workspace-write';
  if (canWrite) assertWorkspaceOutsideApplicationRoot(workspace);
  assertCodexHomeOutsideWorkspace(workspace, env);
  assertSafeCodexDirectory(workspace);
  ensureProtectedWorkspaceDirs(workspace);
  const id = `${PROFILE_PREFIX}-${canWrite ? 'workspace-write' : 'read-only'}`;
  const nodeExecutable = fs.realpathSync(process.execPath);
  const fsEntries = {
    ':root': 'deny',
    ':minimal': 'read',
    [workspace]: canWrite ? 'write' : 'read',
    [path.join(workspace, '.env.*')]: 'deny',
    [resolveCodexInstallDir(codexPath, env)]: 'read',
    [nodeExecutable]: 'read',
    [path.dirname(nodeExecutable)]: 'read',
  };
  const npmInstall = resolveTrustedNpmInstallDir(env);
  if (npmInstall) {
    fsEntries[npmInstall.installDir] = 'read';
    fsEntries[npmInstall.executable] = 'read';
  }
  addStablePath(fsEntries, workspace, path.join(workspace, '.git'), 'read', null);
  fsEntries[path.join(workspace, '.codex')] = 'read';
  fsEntries[path.join(workspace, '.agents')] = 'read';
  fsEntries[path.join(workspace, '.claude')] = 'read';
  assertSafeOptionalPath(workspace, path.join(workspace, '.codex', 'auth.json'));
  assertSafeOptionalPath(workspace, path.join(workspace, '.codex', 'sessions'));
  fsEntries[path.join(workspace, '.codex', 'auth.json*')] = 'deny';
  fsEntries[path.join(workspace, '.codex', 'sessions', '**')] = 'deny';
  const teamPath = trustedTeamRulesPath(role.instructions);
  if (teamPath) {
    const resolvedTeamPath = path.resolve(teamPath);
    const deniedRoots = ['.runtime', '.env', 'runtime', 'data', '.codex/auth.json', '.codex/sessions']
      .map((entry) => path.resolve(workspace, entry));
    if (deniedRoots.some((denied) => resolvedTeamPath === denied || resolvedTeamPath.startsWith(`${denied}${path.sep}`))) {
      throw new Error('Trusted TEAM.md path is inside a denied workspace path');
    }
    fsEntries[resolvedTeamPath] = 'read';
  }
  // The binding covers the always-present entries and the rule list, never which optional paths exist.
  const binding = JSON.stringify({
    id,
    entries: fsEntries,
    rules: OPTIONAL_PATH_RULES.map(({ relative, permission, type }) => [relative, permission, type]),
    network: false,
  });
  const realized = { ...fsEntries };
  for (const gitPath of resolveGitMetadataPaths(workspace)) realized[gitPath] = 'read';
  for (const rule of OPTIONAL_PATH_RULES) addOptionalPath(realized, workspace, rule);
  const config = {
    [`permissions.${id}.filesystem`]: realized,
    [`permissions.${id}.network.enabled`]: false,
  };
  return { id, binding, config };
}

function assertActivePermissionProfile(result, expectedId, method) {
  const activeId = result?.activePermissionProfile?.id;
  if (activeId !== expectedId) {
    throw new Error(`${method} did not activate permission profile ${expectedId} (received ${activeId || 'none'})`);
  }
}

module.exports = {
  createPermissionProfile, ensureProtectedWorkspaceDirs, resolveCodexInstallDir, assertActivePermissionProfile, assertCodexHomeOutsideWorkspace,
  resolveTrustedNpmInstallDir, assertWorkspaceOutsideApplicationRoot,
};
