'use strict';

const childProcess = require('node:child_process');
const { createGitAdapter, computeIntegrityHash, nonInteractiveEnv } = require('./git-adapter');

// Operator-driven delivery: the only module allowed to stage, commit and push. Agents never reach it.
// Same execution rules as git-adapter.js: execFile with fixed argv, no shell, hardening overrides.
// Never forces a push and never builds a "+" refspec.
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const LOCAL_TIMEOUT_MS = 60 * 1000;
const DEFAULT_PUSH_TIMEOUT_MS = 120 * 1000;
const HARDENING_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external='];
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_MESSAGE = 2000;
const MAX_ERROR_TEXT = 500;
const IDENTITY_PATTERN = /author identity unknown|committer identity unknown|unable to auto-detect|empty ident name|please tell me who you are/i;

class GitDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitDeliveryError';
    this.code = code;
    // The message is operator-facing; a stack would only add paths.
    this.stack = `${this.name}: ${code}`;
  }
}

// Drops everything up to the last "@" of the authority (so "user:p@ss@host" is fully removed) and
// redacts query strings in scheme://... URLs.
function stripUserinfo(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#]*@/g, '$1')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/g, '$1?<redacted>');
}

function describeFailure(error) {
  const text = stripUserinfo((error && (error.stderr || error.message)) || 'git failed').trim();
  return text.slice(0, MAX_ERROR_TEXT) || 'git failed';
}

function defaultExec(cmd, argv, options) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(cmd, argv, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input === undefined ? '' : options.input);
  });
}

function splitZ(raw) {
  return raw.split('\0').filter(Boolean);
}

function manifestPaths(manifest) {
  const paths = new Set();
  for (const entry of manifest) {
    paths.add(entry.path);
    if (entry.oldPath) paths.add(entry.oldPath);
  }
  return [...paths];
}

function createGitDelivery({ workspace, remotes: allowedRemotes, timeoutMs = DEFAULT_PUSH_TIMEOUT_MS, execFile } = {}) {
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required');
  if (!Array.isArray(allowedRemotes) || !allowedRemotes.length) throw new TypeError('remotes must be a non-empty array');
  const allowlist = new Set(allowedRemotes);
  const exec = execFile || defaultExec;
  const env = {
    ...nonInteractiveEnv(),
    GIT_LITERAL_PATHSPECS: '1',
    GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh',
  };
  const adapter = createGitAdapter({ workspace, execFile: exec });

  async function git(argv, { input, timeout = LOCAL_TIMEOUT_MS, callEnv = env } = {}) {
    const result = await exec('git', [...HARDENING_ARGS, ...argv], {
      cwd: workspace, env: callEnv, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', timeout, input,
    });
    return typeof result === 'string' ? result : result.stdout;
  }

  // Network calls only: batch-mode ssh unless the operator configured an ssh command (env or core.sshCommand).
  async function networkEnv() {
    if (env.GIT_SSH_COMMAND) return env;
    const configured = await gitOrNull(['config', '--get', 'core.sshCommand']);
    if (configured && configured.trim()) return env;
    return { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  }

  async function gitOrNull(argv) {
    try {
      return await git(argv);
    } catch (_) {
      return null;
    }
  }

  async function revParse(ref) {
    const out = await gitOrNull(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return out ? out.trim() : null;
  }

  function requireSha(value, label) {
    if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new GitDeliveryError('git_failed', `${label} is not a full commit id`);
  }

  async function requireBranch(branch) {
    if (typeof branch !== 'string' || !branch || branch.startsWith('-')
      || (await gitOrNull(['check-ref-format', '--branch', branch])) === null) {
      throw new GitDeliveryError('git_failed', 'The branch name is not a valid Git branch name');
    }
  }

  async function verifyCandidate({ baseCommit, branch, head, integrityHash } = {}) {
    const problems = [];
    const problem = (code, message) => problems.push({ code, message });
    const state = await adapter.preflight({ baseRef: baseCommit || 'HEAD' });
    for (const item of state.problems) {
      if (item.code === 'operation_in_progress' || item.code === 'not_a_repo') problems.push(item);
    }
    if (state.branch !== branch) problem('branch_changed', 'The checkout is no longer on the candidate branch');
    if (state.head !== head) problem('head_changed', 'The branch head moved after the candidate was captured');
    if (!problems.length) {
      try {
        const current = await adapter.captureCandidate({ baseCommit });
        if (current.manifestTruncated) problem('manifest_truncated', 'The candidate manifest was truncated');
        if (computeIntegrityHash(current.head, current.manifest) !== integrityHash) {
          problem('candidate_changed', 'The working tree no longer matches the accepted candidate');
        }
      } catch (_) {
        problem('candidate_changed', 'The candidate could not be recomputed');
      }
    }
    return { ok: problems.length === 0, problems };
  }

  async function stagedNames() {
    return splitZ(await git(['diff', '--cached', '--name-only', '--no-renames', '-z']));
  }

  async function commit({ candidate, message, deliveryId } = {}) {
    if (!candidate || typeof candidate !== 'object') throw new GitDeliveryError('git_failed', 'candidate is required');
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE || message.includes('\0')) {
      throw new GitDeliveryError('git_failed', `message must be 1..${MAX_MESSAGE} characters without NUL`);
    }
    if (typeof deliveryId !== 'string' || !ID_PATTERN.test(deliveryId)) throw new GitDeliveryError('git_failed', 'deliveryId is invalid');
    if (candidate.manifestTruncated) throw new GitDeliveryError('manifest_truncated', 'The candidate manifest was truncated');
    // A candidate with committed entries would never stage equal to its manifest; none is deliverable.
    if (candidate.head !== candidate.baseCommit) throw new GitDeliveryError('head_moved', 'The candidate head differs from its base commit');
    const verdict = await verifyCandidate(candidate);
    if (!verdict.ok) throw new GitDeliveryError(verdict.problems[0].code, verdict.problems[0].message);
    const paths = manifestPaths(candidate.manifest || []);
    if (!paths.length) throw new GitDeliveryError('git_failed', 'The candidate has no changed paths to commit');
    for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      if ((await gitOrNull(['var', ident])) === null) throw new GitDeliveryError('git_identity_missing', 'Git user name and email are not configured');
    }

    try {
      await git(['add', '-A', '--', ...paths]);
    } catch (error) {
      throw new GitDeliveryError('git_failed', describeFailure(error));
    }
    const allowed = new Set(paths);
    const staged = await stagedNames();
    if (staged.length !== allowed.size || staged.some((name) => !allowed.has(name))) {
      await gitOrNull(['restore', '--staged', '--', ...paths]);
      throw new GitDeliveryError('staged_set_mismatch', 'The staged paths do not match the candidate manifest');
    }

    const body = `${message.trim()}\n\nTicket: ${candidate.ticketId}\nCandidate: ${candidate.candidateId}\nDelivery-Id: ${deliveryId}\n`;
    try {
      await git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--cleanup=whitespace', '-F', '-'], { input: body });
    } catch (error) {
      await gitOrNull(['restore', '--staged', '--', ...paths]);
      if (IDENTITY_PATTERN.test(String((error && error.stderr) || '') + String((error && error.message) || ''))) {
        throw new GitDeliveryError('git_identity_missing', 'Git user name and email are not configured');
      }
      throw new GitDeliveryError('git_failed', describeFailure(error));
    }
    const commitSha = await revParse('HEAD');
    const parent = await revParse('HEAD^');
    if (!commitSha || parent !== candidate.head) {
      throw new GitDeliveryError('ref_mismatch', 'The new commit is not a direct child of the candidate head');
    }
    return { commitSha };
  }

  // Looks for the delivery commit on the candidate branch itself, so a moved checkout or a later
  // user commit on top does not hide it.
  async function reconcileCommit({ candidate, deliveryId } = {}) {
    if (!candidate || !SHA_PATTERN.test(String(candidate.head || ''))) return { state: 'unknown' };
    try {
      await requireBranch(candidate.branch);
    } catch (_) {
      return { state: 'unknown' };
    }
    const tip = await revParse(`refs/heads/${candidate.branch}`);
    if (!tip || !(await revParse(candidate.head))) return { state: 'unknown' };
    const out = await gitOrNull(['log', '--first-parent', '--max-count=50', '-z', '--format=%H%x1f%P%x1f%B', `${candidate.head}..${tip}`, '--']);
    if (out === null) return { state: 'unknown' };
    for (const record of splitZ(out)) {
      const [sha, parents, ...rest] = record.split('\x1f');
      if (parents !== candidate.head) continue;
      if (rest.join('\x1f').split('\n').some((line) => line.trim() === `Delivery-Id: ${deliveryId}`)) {
        return { state: 'succeeded', commitSha: sha };
      }
    }
    if (tip === candidate.head) return { state: 'failed' };
    return { state: 'unknown' };
  }

  async function remotes() {
    const names = splitLines(await gitOrNull(['remote']));
    const out = [];
    for (const name of names) {
      if (!allowlist.has(name)) continue;
      const url = await gitOrNull(['remote', 'get-url', name]);
      out.push({ name, url: stripUserinfo((url || '').trim()) });
    }
    return out;
  }

  function splitLines(text) {
    return (text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  }

  async function requireRemote(remote) {
    if (typeof remote !== 'string' || !allowlist.has(remote) || !splitLines(await gitOrNull(['remote'])).includes(remote)) {
      throw new GitDeliveryError('remote_not_allowed', 'The remote is not configured for delivery');
    }
  }

  async function push({ commitSha, branch, remote } = {}) {
    requireSha(commitSha, 'commitSha');
    await requireBranch(branch);
    await requireRemote(remote);
    if ((await revParse(`refs/heads/${branch}`)) !== commitSha) {
      throw new GitDeliveryError('ref_mismatch', 'The local branch no longer points at the committed sha');
    }
    try {
      await git(['push', '--no-verify', '--porcelain', '--', remote, `${commitSha}:refs/heads/${branch}`], { timeout: timeoutMs, callEnv: await networkEnv() });
      return { state: 'succeeded', remote };
    } catch (error) {
      const out = String((error && error.stdout) || '');
      const rejected = out.split('\n').find((line) => line.startsWith('!'));
      if (rejected) {
        const reason = stripUserinfo(rejected.split('\t').slice(2).join(' ') || rejected).trim();
        return { state: 'failed', code: 'push_rejected', message: `Push rejected: ${reason}`.slice(0, MAX_ERROR_TEXT) };
      }
      const detail = describeFailure(error);
      const outcome = await reconcilePush({ commitSha, branch, remote });
      if (outcome.state === 'succeeded') return { state: 'succeeded', remote };
      return { state: outcome.state, code: 'git_failed', message: detail };
    }
  }

  async function reconcilePush({ commitSha, branch, remote } = {}) {
    requireSha(commitSha, 'commitSha');
    await requireBranch(branch);
    await requireRemote(remote);
    let out;
    try {
      out = await git(['ls-remote', '--', remote, `refs/heads/${branch}`], { timeout: timeoutMs, callEnv: await networkEnv() });
    } catch (_) {
      return { state: 'unknown' };
    }
    const line = splitLines(out).find((item) => item.split(/\s+/)[1] === `refs/heads/${branch}`);
    if (line && line.split(/\s+/)[0] === commitSha) return { state: 'succeeded' };
    return { state: 'failed' };
  }

  return { verifyCandidate, commit, reconcileCommit, remotes, push, reconcilePush };
}

module.exports = { createGitDelivery, GitDeliveryError, stripUserinfo };
