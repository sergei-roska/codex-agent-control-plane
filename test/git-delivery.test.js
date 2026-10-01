'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createGitAdapter } = require('../src/git-adapter');
const { createGitDelivery, GitDeliveryError, stripUserinfo } = require('../src/git-delivery');

// Global and system config cannot leak in; identity lives in each temp repo's local config.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[key];

const BRANCH = 'feature/deliver-aaaaaa';

function git(cwd, ...args) {
  return childProcess.execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8' }).trim();
}

function realExec(cmd, argv, options) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(cmd, argv, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input === undefined ? '' : options.input);
  });
}

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, { remote = true, identity = true, delivery = {} } = {}) {
  const dir = tmp(t, 'git-delivery-');
  git(dir, 'init', '-q', '-b', 'main');
  if (identity) {
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@example.test');
  } else {
    git(dir, 'config', 'user.useConfigOnly', 'true');
  }
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', '-c', BRANCH);
  let bare = null;
  if (remote) {
    bare = tmp(t, 'git-delivery-bare-');
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', bare);
  }
  const adapter = createGitAdapter({ workspace: dir });
  const service = createGitDelivery({ workspace: dir, remotes: ['origin'], ...delivery });
  return { dir, bare, base, adapter, service };
}

async function capture({ adapter, base, dir }, extra = {}) {
  const c = await adapter.captureCandidate({ baseCommit: base });
  return { candidateId: 'cand-1', ticketId: 'tkt-1', baseCommit: base, branch: c.branch, ...c, ...extra, dir: undefined };
}

function dirtyUp(dir) {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.rmSync(path.join(dir, 'b.txt'));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');
  fs.writeFileSync(path.join(dir, 'ignored.log'), 'noise\n');
}

test('verifyCandidate accepts an unchanged candidate', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  assert.deepEqual(await ctx.service.verifyCandidate(candidate), { ok: true, problems: [] });
});

test('verifyCandidate detects a changed file, a moved head and a switched branch', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);

  fs.writeFileSync(path.join(ctx.dir, 'new.txt'), 'edited after capture\n');
  let verdict = await ctx.service.verifyCandidate(candidate);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems.map((p) => p.code), ['candidate_changed']);
  fs.writeFileSync(path.join(ctx.dir, 'new.txt'), 'brand new\n');
  assert.equal((await ctx.service.verifyCandidate(candidate)).ok, true);

  git(ctx.dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'moved');
  verdict = await ctx.service.verifyCandidate(candidate);
  assert.ok(verdict.problems.some((p) => p.code === 'head_changed'));
  git(ctx.dir, 'reset', '-q', '--hard', candidate.head);

  git(ctx.dir, 'stash', '-q', '-u');
  git(ctx.dir, 'switch', '-q', 'main');
  verdict = await ctx.service.verifyCandidate(candidate);
  assert.ok(verdict.problems.some((p) => p.code === 'branch_changed'));
});

test('verifyCandidate reports an operation in progress', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  fs.writeFileSync(path.join(ctx.dir, '.git', 'MERGE_HEAD'), `${candidate.head}\n`);
  const verdict = await ctx.service.verifyCandidate(candidate);
  assert.ok(verdict.problems.some((p) => p.code === 'operation_in_progress'));
});

test('commit stages exactly the manifest, adds trailers and parents on the candidate head', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  const { commitSha } = await ctx.service.commit({ candidate, message: 'Do the thing', deliveryId: 'del-1' });
  assert.equal(git(ctx.dir, 'rev-parse', 'HEAD'), commitSha);
  assert.equal(git(ctx.dir, 'rev-parse', 'HEAD^'), candidate.head);
  const changes = git(ctx.dir, 'show', '--name-status', '--format=', '--no-renames', 'HEAD').split('\n').sort();
  assert.deepEqual(changes, ['A\tnew.txt', 'D\tb.txt', 'M\ta.txt']);
  const message = git(ctx.dir, 'log', '-1', '--format=%B');
  assert.match(message, /^Do the thing\n/);
  assert.match(message, /^Ticket: tkt-1$/m);
  assert.match(message, /^Candidate: cand-1$/m);
  assert.match(message, /^Delivery-Id: del-1$/m);
  assert.equal(git(ctx.dir, 'status', '--porcelain'), '', 'ignored files stay ignored, nothing else is left');
});

test('commit refuses a changed candidate, a truncated manifest and bad input before touching the index', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  fs.writeFileSync(path.join(ctx.dir, 'new.txt'), 'edited\n');
  await assert.rejects(ctx.service.commit({ candidate, message: 'm', deliveryId: 'd' }), (error) => error instanceof GitDeliveryError && error.code === 'candidate_changed');
  assert.equal(git(ctx.dir, 'diff', '--cached', '--name-only'), '');
  await assert.rejects(ctx.service.commit({ candidate: { ...candidate, manifestTruncated: true }, message: 'm', deliveryId: 'd' }), (error) => error.code === 'manifest_truncated');
  await assert.rejects(ctx.service.commit({ candidate, message: '', deliveryId: 'd' }), (error) => error.code === 'git_failed');
  await assert.rejects(ctx.service.commit({ candidate, message: 'x\0y', deliveryId: 'd' }), (error) => error.code === 'git_failed');
  await assert.rejects(ctx.service.commit({ candidate, message: 'm', deliveryId: 'bad id' }), (error) => error.code === 'git_failed');
});

test('a staged set that differs from the manifest is unstaged and fails staged_set_mismatch', async (t) => {
  let sneaked = false;
  const ctx = {};
  const exec = async (cmd, argv, options) => {
    const result = await realExec(cmd, argv, options);
    if (!sneaked && argv.includes('add') && argv.includes('-A')) {
      sneaked = true;
      fs.writeFileSync(path.join(ctx.dir, 'sneaky.txt'), 'x\n');
      git(ctx.dir, 'add', 'sneaky.txt');
    }
    return result;
  };
  Object.assign(ctx, setup(t, { delivery: { execFile: exec } }));
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  await assert.rejects(ctx.service.commit({ candidate, message: 'm', deliveryId: 'd' }), (error) => error.code === 'staged_set_mismatch');
  assert.equal(sneaked, true);
  assert.equal(git(ctx.dir, 'rev-parse', 'HEAD'), candidate.head, 'no commit was made');
  assert.equal(git(ctx.dir, 'diff', '--cached', '--name-only'), 'sneaky.txt', 'manifest paths are unstaged again');
  assert.equal(git(ctx.dir, 'status', '--porcelain', '--', 'a.txt', 'b.txt', 'new.txt'), 'M a.txt\n D b.txt\n?? new.txt');
});

test('a candidate whose head moved off the base is refused with nothing staged', async (t) => {
  const ctx = setup(t);
  git(ctx.dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'moved');
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  assert.notEqual(candidate.head, candidate.baseCommit);
  await assert.rejects(ctx.service.commit({ candidate, message: 'm', deliveryId: 'd' }), (error) => error.code === 'head_moved');
  assert.equal(git(ctx.dir, 'diff', '--cached', '--name-only'), '');
});

test('a manifest path missing from the staged set fails staged_set_mismatch and restores the index', async (t) => {
  const ctx = {};
  const exec = async (cmd, argv, options) => {
    const result = await realExec(cmd, argv, options);
    if (argv.includes('--cached') && argv.includes('--name-only') && argv.includes('-z')) {
      const kept = result.stdout.split('\0').filter((name) => name && name !== 'new.txt');
      return { stdout: kept.map((name) => `${name}\0`).join(''), stderr: '' };
    }
    return result;
  };
  Object.assign(ctx, setup(t, { delivery: { execFile: exec } }));
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  await assert.rejects(ctx.service.commit({ candidate, message: 'm', deliveryId: 'd' }), (error) => error.code === 'staged_set_mismatch');
  assert.equal(git(ctx.dir, 'rev-parse', 'HEAD'), candidate.head);
  assert.equal(git(ctx.dir, 'diff', '--cached', '--name-only'), '');
});

test('a missing git identity fails with git_identity_missing and stages nothing', async (t) => {
  const ctx = setup(t, { identity: false });
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  await assert.rejects(ctx.service.commit({ candidate, message: 'm', deliveryId: 'd' }), (error) => error.code === 'git_identity_missing');
  assert.equal(git(ctx.dir, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(ctx.dir, 'rev-parse', 'HEAD'), candidate.head);
});

test('reconcileCommit reports succeeded, failed and unknown', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  assert.deepEqual(await ctx.service.reconcileCommit({ candidate, deliveryId: 'del-1' }), { state: 'failed' });
  const { commitSha } = await ctx.service.commit({ candidate, message: 'm', deliveryId: 'del-1' });
  assert.deepEqual(await ctx.service.reconcileCommit({ candidate, deliveryId: 'del-1' }), { state: 'succeeded', commitSha });
  assert.deepEqual(await ctx.service.reconcileCommit({ candidate, deliveryId: 'other-delivery' }), { state: 'unknown' });
  git(ctx.dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'later');
  assert.deepEqual(await ctx.service.reconcileCommit({ candidate, deliveryId: 'del-1' }), { state: 'succeeded', commitSha });
  assert.deepEqual(await ctx.service.reconcileCommit({ candidate, deliveryId: 'other-delivery' }), { state: 'unknown' });
});

test('reconcileCommit finds the delivery commit after the checkout moved to another branch at the candidate head', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  const { commitSha } = await ctx.service.commit({ candidate, message: 'm', deliveryId: 'del-1' });
  git(ctx.dir, 'switch', '-q', '-c', 'other', candidate.head);
  assert.equal(git(ctx.dir, 'rev-parse', 'HEAD'), candidate.head);
  assert.deepEqual(await ctx.service.reconcileCommit({ candidate, deliveryId: 'del-1' }), { state: 'succeeded', commitSha });
  assert.deepEqual(await ctx.service.reconcileCommit({ candidate: { ...candidate, branch: 'nope' }, deliveryId: 'del-1' }), { state: 'unknown' });
});

test('chmod after capture makes verifyCandidate report candidate_changed', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  fs.chmodSync(path.join(ctx.dir, 'new.txt'), 0o755);
  const verdict = await ctx.service.verifyCandidate(candidate);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems[0].code, 'candidate_changed');
});

test('push and reconcilePush put the remote after -- and refuse option-like remote names', async (t) => {
  const ctx = await committed(t);
  const calls = [];
  const service = createGitDelivery({
    workspace: ctx.dir,
    remotes: ['origin', '-x'],
    execFile: (cmd, argv, options) => {
      calls.push(argv);
      return realExec(cmd, argv, options);
    },
  });
  assert.deepEqual(await service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' }), { state: 'succeeded', remote: 'origin' });
  await service.reconcilePush({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  const pushArgv = calls.find((argv) => argv.includes('push'));
  assert.ok(pushArgv.indexOf('--') > pushArgv.indexOf('--porcelain') && pushArgv[pushArgv.indexOf('--') + 1] === 'origin');
  const lsArgv = calls.find((argv) => argv.includes('ls-remote'));
  assert.equal(lsArgv[lsArgv.indexOf('--') + 1], 'origin');
  await assert.rejects(service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: '-x' }), (e) => e.code === 'remote_not_allowed');
});

test('git calls are non-interactive and commit disables signing', async (t) => {
  const ctx = setup(t);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  const seen = [];
  const service = createGitDelivery({
    workspace: ctx.dir,
    remotes: ['origin'],
    execFile: (cmd, argv, options) => {
      seen.push({ argv, env: options.env });
      return realExec(cmd, argv, options);
    },
  });
  await service.commit({ candidate, message: 'm', deliveryId: 'del-1' });
  assert.ok(seen.length > 0);
  for (const { env } of seen) {
    assert.equal(env.GIT_ASKPASS, 'true');
    assert.equal(env.SSH_ASKPASS, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  }
  const commitCall = seen.find(({ argv }) => argv.includes('commit'));
  assert.ok(commitCall.argv.join(' ').includes('-c commit.gpgsign=false commit'));
});

async function committed(t, options) {
  const ctx = setup(t, options);
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  const { commitSha } = await ctx.service.commit({ candidate, message: 'm', deliveryId: 'del-1' });
  return { ...ctx, candidate, commitSha };
}

test('push publishes the committed sha to the bare remote', async (t) => {
  const ctx = await committed(t);
  const result = await ctx.service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  assert.equal(result.state, 'succeeded');
  assert.equal(git(ctx.bare, 'rev-parse', `refs/heads/${BRANCH}`), ctx.commitSha);
  assert.deepEqual(await ctx.service.reconcilePush({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' }), { state: 'succeeded' });
});

test('push never forces: a non-fast-forward is rejected and the remote stays untouched', async (t) => {
  const ctx = await committed(t);
  const other = tmp(t, 'git-delivery-other-');
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'config', 'user.name', 'O');
  git(other, 'config', 'user.email', 'o@example.test');
  fs.writeFileSync(path.join(other, 'z.txt'), 'z\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'divergent');
  git(other, 'push', '-q', bareUrl(ctx), `HEAD:refs/heads/${BRANCH}`);
  const remoteSha = git(ctx.bare, 'rev-parse', `refs/heads/${BRANCH}`);
  const result = await ctx.service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'push_rejected');
  assert.equal(git(ctx.bare, 'rev-parse', `refs/heads/${BRANCH}`), remoteSha);
  assert.deepEqual(await ctx.service.reconcilePush({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' }), { state: 'failed' });
});

function bareUrl(ctx) {
  return ctx.bare;
}

test('push refuses a remote that is not allowlisted or not configured', async (t) => {
  const ctx = await committed(t);
  git(ctx.dir, 'remote', 'add', 'mirror', ctx.bare);
  for (const remote of ['mirror', 'nope', '--force', undefined]) {
    await assert.rejects(ctx.service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote }), (error) => error.code === 'remote_not_allowed', String(remote));
  }
  await assert.rejects(ctx.service.reconcilePush({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'mirror' }), (error) => error.code === 'remote_not_allowed');
  assert.equal(git(ctx.bare, 'for-each-ref', '--format=%(refname)'), '');
});

test('push refuses when the local ref moved or the input is malformed', async (t) => {
  const ctx = await committed(t);
  git(ctx.dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'moved');
  await assert.rejects(ctx.service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' }), (error) => error.code === 'ref_mismatch');
  await assert.rejects(ctx.service.push({ commitSha: 'HEAD', branch: BRANCH, remote: 'origin' }), (error) => error.code === 'git_failed');
  await assert.rejects(ctx.service.push({ commitSha: ctx.commitSha, branch: '-x', remote: 'origin' }), (error) => error.code === 'git_failed');
  assert.equal(git(ctx.bare, 'for-each-ref', '--format=%(refname)'), '');
});

test('reconcilePush is unknown when the remote cannot be queried', async (t) => {
  const ctx = await committed(t);
  git(ctx.dir, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'git-delivery-does-not-exist'));
  assert.deepEqual(await ctx.service.reconcilePush({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' }), { state: 'unknown' });
  const result = await ctx.service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.code, 'git_failed');
});

test('hooks planted in the repository are not executed by commit or push', async (t) => {
  const ctx = setup(t);
  const marker = path.join(ctx.dir, '..', `hook-marker-${path.basename(ctx.dir)}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    fs.writeFileSync(path.join(ctx.dir, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  }
  dirtyUp(ctx.dir);
  const candidate = await capture(ctx);
  const { commitSha } = await ctx.service.commit({ candidate, message: 'm', deliveryId: 'del-1' });
  const result = await ctx.service.push({ commitSha, branch: BRANCH, remote: 'origin' });
  assert.equal(result.state, 'succeeded');
  assert.ok(!fs.existsSync(marker), 'no hook ran');
});

test('remotes lists only allowlisted remotes with userinfo stripped from the url', async (t) => {
  const ctx = setup(t);
  git(ctx.dir, 'remote', 'set-url', 'origin', 'https://user:s3cret@example.test/org/repo.git');
  git(ctx.dir, 'remote', 'add', 'mirror', 'https://example.test/mirror.git');
  assert.deepEqual(await ctx.service.remotes(), [{ name: 'origin', url: 'https://example.test/org/repo.git' }]);
  assert.equal(stripUserinfo('fatal: unable to access https://u:p@h.test/x: boom'), 'fatal: unable to access https://h.test/x: boom');
  assert.equal(stripUserinfo('/local/path'), '/local/path');
});

test('stripUserinfo removes everything up to the last @ of the authority and redacts queries', () => {
  assert.equal(stripUserinfo('https://user:p@ss@host/x'), 'https://host/x');
  assert.equal(stripUserinfo('ssh://git@host:22/a@b.git'), 'ssh://host:22/a@b.git');
  assert.equal(stripUserinfo('https://host/x?token=abc&b=1'), 'https://host/x?<redacted>');
  assert.equal(stripUserinfo('see https://u:p@h.test/x?k=v boom'), 'see https://h.test/x?<redacted> boom');
  assert.equal(stripUserinfo('https://host/x#frag'), 'https://host/x#frag');
});

test('git errors never leak credentials from remote urls', async (t) => {
  const ctx = await committed(t, { remote: false });
  git(ctx.dir, 'remote', 'add', 'origin', 'ssh://user:s3cret@127.0.0.1:1/none.git');
  const service = createGitDelivery({ workspace: ctx.dir, remotes: ['origin'], timeoutMs: 20000 });
  const result = await service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  assert.notEqual(result.state, 'succeeded');
  assert.ok(!JSON.stringify(result).includes('s3cret'));
});

test('only git-delivery.js stages, commits or pushes; it never forces', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const delivery = fs.readFileSync(path.join(srcDir, 'git-delivery.js'), 'utf8');
  assert.ok(/'commit'/.test(delivery) && /'push'/.test(delivery) && /'add'/.test(delivery));
  assert.ok(!/--force|--mirror|--delete/.test(delivery.replace(/never forces[^\n]*/g, '')), 'no force flags');
  assert.ok(!/`\+|'\+/.test(delivery), 'no plus refspec');
  assert.ok(!/shell\s*:/.test(delivery));
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.js') || name === 'git-delivery.js') continue;
    const source = fs.readFileSync(path.join(srcDir, name), 'utf8');
    if (!/execFile|spawn/.test(source) || !/\bgit\b/.test(source)) continue;
    for (const word of ['commit', 'push', 'add']) {
      assert.ok(!new RegExp(`['"\`]${word}['"\`]`).test(source), `${name} must not contain git ${word}`);
    }
  }
});

test('network calls use batch-mode ssh unless core.sshCommand or GIT_SSH_COMMAND is set', async (t) => {
  const saved = process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH_COMMAND;
  t.after(() => {
    if (saved !== undefined) process.env.GIT_SSH_COMMAND = saved;
  });
  const ctx = await committed(t);
  const seen = [];
  const service = createGitDelivery({
    workspace: ctx.dir,
    remotes: ['origin'],
    execFile: (cmd, argv, options) => {
      seen.push({ argv, env: options.env });
      return realExec(cmd, argv, options);
    },
  });
  await service.reconcilePush({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  assert.equal(seen.find(({ argv }) => argv.includes('ls-remote')).env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  seen.length = 0;
  git(ctx.dir, 'config', 'core.sshCommand', 'ssh -i /custom/key');
  await service.reconcilePush({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  await service.push({ commitSha: ctx.commitSha, branch: BRANCH, remote: 'origin' });
  const network = seen.filter(({ argv }) => argv.includes('ls-remote') || argv.includes('push'));
  assert.equal(network.length, 2);
  for (const { env } of network) assert.equal(env.GIT_SSH_COMMAND, undefined);
});
