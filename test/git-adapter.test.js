'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGitAdapter, slugify, MAX_DIFF_BYTES } = require('../src/git-adapter');

// Identity and isolation via env only; never global config. The adapter spreads
// process.env, so setting these here keeps its own git calls isolated too.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-adapter-')));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  fs.writeFileSync(path.join(dir, 'old name.txt'), 'rename me please, long enough content\nline2\nline3\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

function setup(t) {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  return { ...repo, adapter: createGitAdapter({ workspace: repo.dir }) };
}

test('preflight passes on a clean checkout and notes ignored files', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'ignored.log'), 'x');
  const result = await adapter.preflight({ baseRef: 'main' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.head, head);
  assert.equal(result.branch, 'main');
  assert.equal(result.baseCommit, head);
  assert.ok(result.notes.some((n) => n.code === 'ignored_files_present'));
});

test('preflight reports dirty tracked, staged and untracked changes', async (t) => {
  const { dir, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  let result = await adapter.preflight({ baseRef: 'main' });
  assert.deepEqual(result.problems.map((p) => p.code), ['dirty_worktree']);
  git(dir, 'add', 'a.txt');
  result = await adapter.preflight({ baseRef: 'main' });
  assert.deepEqual(result.problems.map((p) => p.code), ['dirty_worktree']);
  git(dir, 'reset', '-q', '--hard');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n');
  result = await adapter.preflight({ baseRef: 'main' });
  assert.deepEqual(result.problems.map((p) => p.code), ['dirty_worktree']);
});

test('preflight reports a missing base ref', async (t) => {
  const { adapter } = setup(t);
  const result = await adapter.preflight({ baseRef: 'nope' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((p) => p.code), ['base_ref_missing']);
  const flag = await adapter.preflight({ baseRef: '--all' });
  assert.deepEqual(flag.problems.map((p) => p.code), ['base_ref_missing']);
});

test('preflight detects a merge in progress', async (t) => {
  const { dir, adapter } = setup(t);
  git(dir, 'switch', '-q', '-c', 'side');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'side\n');
  git(dir, 'commit', '-q', '-am', 'side');
  git(dir, 'switch', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
  assert.throws(() => execFileSync('git', ['merge', 'side'], { cwd: dir, env: process.env, stdio: 'ignore' }));
  const result = await adapter.preflight({ baseRef: 'main' });
  assert.ok(result.problems.map((p) => p.code).includes('operation_in_progress'));
});

test('preflight rejects a subdirectory of a repository and a non-repo', async (t) => {
  const { dir } = setup(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  const sub = await createGitAdapter({ workspace: path.join(dir, 'sub') }).preflight({ baseRef: 'main' });
  assert.deepEqual(sub.problems.map((p) => p.code), ['not_a_repo']);
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-adapter-plain-')));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const none = await createGitAdapter({ workspace: plain }).preflight({ baseRef: 'main' });
  assert.deepEqual(none.problems.map((p) => p.code), ['not_a_repo']);
});

test('preflight notes a detached HEAD', async (t) => {
  const { dir, head, adapter } = setup(t);
  git(dir, 'switch', '-q', '--detach', head);
  const result = await adapter.preflight({ baseRef: 'main' });
  assert.equal(result.ok, true);
  assert.equal(result.branch, null);
  assert.ok(result.notes.some((n) => n.code === 'detached_head_allowed'));
});

test('slugify and branchName', async (t) => {
  const { dir, adapter } = setup(t);
  assert.equal(slugify('Add  Login -- Page!'), 'add-login-page');
  assert.equal(slugify('   '), 'task');
  assert.equal(slugify('\u0416\u0443\u043a \u2603'), 'task');
  assert.equal(slugify('a'.repeat(60)).length, 40);
  assert.equal(await adapter.branchName({ classification: 'feature', title: 'Add Login Page', ticketId: 'TCK-ABCDEF123' }), 'feature/add-login-page-def123');
  assert.equal(await adapter.branchName({ classification: 'bugfix', title: '\u0411\u0430\u0433 in caf\u00e9 ~^:?', ticketId: 'x1' }), 'fix/in-caf-x1');
  assert.equal(await adapter.branchName({ classification: 'weird', title: '', ticketId: 'ab12' }), 'task/task-ab12');
  const policy = { feature: 'feat-', bugfix: 'bug/', docs: 'documents/' };
  assert.equal(await adapter.branchName({ classification: 'feature', title: 'Add Login', ticketId: 'TCK-ABCDEF', branchPrefixes: policy }), 'feat-add-login-abcdef');
  assert.equal(await adapter.branchName({ classification: 'bugfix', title: 'Fix it', ticketId: 'abcdef', branchPrefixes: policy }), 'bug/fix-it-abcdef');
  assert.equal(await adapter.branchName({ classification: 'docs', title: 'Doc', ticketId: 'abcdef', branchPrefixes: policy }), 'documents/doc-abcdef');
  // A classification the policy does not name falls back to the built-in mapping.
  assert.equal(await adapter.branchName({ classification: 'audit', title: 'Look', ticketId: 'abcdef', branchPrefixes: policy }), 'task/look-abcdef');
  assert.equal(await adapter.branchName({ classification: 'refactor', title: 'Tidy', ticketId: 'abcdef', branchPrefixes: policy }), 'refactor/tidy-abcdef');
  const name = await adapter.branchName({ classification: 'feature', title: 'x'.repeat(80), ticketId: 'ZZZZZZ' });
  assert.ok(name.length <= 60);
  git(dir, 'check-ref-format', '--branch', name);
});

test('prepareBranch creates from the base commit, reuses owned, refuses unowned', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c');
  git(dir, 'add', 'c.txt');
  git(dir, 'commit', '-q', '-m', 'second');
  const created = await adapter.prepareBranch({ name: 'feature/x-aaaaaa', baseCommit: head });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x-aaaaaa');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(await adapter.branchExists('feature/x-aaaaaa'), true);
  assert.equal(await adapter.branchExists('feature/none'), false);

  git(dir, 'switch', '-q', 'main');
  const reused = await adapter.prepareBranch({ name: 'feature/x-aaaaaa', baseCommit: head, ownedByThisTicket: true });
  assert.equal(reused.ok, true);
  assert.equal(reused.reused, true);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x-aaaaaa');

  git(dir, 'switch', '-q', 'main');
  const collision = await adapter.prepareBranch({ name: 'feature/x-aaaaaa', baseCommit: head, ownedByThisTicket: false });
  assert.equal(collision.ok, false);
  assert.equal(collision.problems[0].code, 'branch_collision');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  const bad = await adapter.prepareBranch({ name: '-bad', baseCommit: head });
  assert.equal(bad.problems[0].code, 'invalid_branch_name');
  const missing = await adapter.prepareBranch({ name: 'feature/ok', baseCommit: 'deadbeef' });
  assert.equal(missing.problems[0].code, 'base_ref_missing');
});

test('prepareBranch refuses a dirty checkout', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  const result = await adapter.prepareBranch({ name: 'feature/y-bbbbbb', baseCommit: head });
  assert.equal(result.problems[0].code, 'dirty_worktree');
  assert.equal(await adapter.branchExists('feature/y-bbbbbb'), false);
});

test('captureCandidate covers modified, added, deleted, renamed, untracked, binary and spaces', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
  fs.unlinkSync(path.join(dir, 'b.txt'));
  fs.writeFileSync(path.join(dir, 'added.txt'), 'added\n');
  git(dir, 'add', 'added.txt');
  git(dir, 'mv', 'old name.txt', 'new name.txt');
  fs.writeFileSync(path.join(dir, 'untracked file.txt'), 'hello\nworld');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0]));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
  fs.writeFileSync(path.join(dir, 'ignored.log'), 'skip');

  const c = await adapter.captureCandidate({ baseCommit: head });
  const by = Object.fromEntries(c.manifest.map((m) => [m.path, m]));
  assert.equal(by['a.txt'].status, 'M');
  assert.equal(by['b.txt'].status, 'D');
  assert.equal(by['b.txt'].sha256, null);
  assert.equal(by['added.txt'].status, 'A');
  assert.equal(by['new name.txt'].status, 'R');
  assert.equal(by['new name.txt'].oldPath, 'old name.txt');
  assert.equal(by['untracked file.txt'].status, '??');
  assert.equal(by['untracked file.txt'].size, 11);
  assert.match(by['untracked file.txt'].sha256, /^[0-9a-f]{64}$/);
  assert.equal(by['blob.bin'].size, 5);
  assert.equal(by['big.txt'].size, 256 * 1024 + 1);
  assert.equal(by['ignored.log'], undefined);
  assert.equal(c.headMoved, false);
  assert.equal(c.truncated, false);
  assert.equal(c.branch, 'main');
  assert.equal(c.head, head);
  assert.match(c.diffText, /\+TWO/);
  assert.match(c.diffText, /\+\+\+ b\/"?untracked file\.txt"?/);
  assert.match(c.diffText, /\+hello\n\+world\n\\ No newline at end of file/);
  assert.match(c.diffText, /# untracked file not inlined \(binary\): blob\.bin/);
  assert.match(c.diffText, /# untracked file not inlined \(larger than 262144 bytes\): big\.txt/);
  assert.ok(!c.diffText.includes('xxxxxxxxxx'));
});

test('captureCandidate truncates at 2 MiB', async (t) => {
  const { dir, head, adapter } = setup(t);
  for (let i = 0; i < 12; i += 1) {
    fs.writeFileSync(path.join(dir, `t${i}.txt`), `${'y'.repeat(200 * 1024)}\n`);
  }
  const c = await adapter.captureCandidate({ baseCommit: head });
  assert.equal(c.truncated, true);
  assert.ok(Buffer.byteLength(c.diffText) <= MAX_DIFF_BYTES);
  assert.equal(c.manifest.length, 12);
});

test('captureCandidate flags headMoved and includes committed changes', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n');
  git(dir, 'commit', '-q', '-am', 'later');
  const c = await adapter.captureCandidate({ baseCommit: head });
  assert.equal(c.headMoved, true);
  assert.notEqual(c.head, head);
  assert.deepEqual(c.manifest.map((m) => [m.path, m.status]), [['a.txt', 'M']]);
  assert.match(c.diffText, /\+committed/);
});

test('integrityHash is stable for identical state and changes after an edit', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  const one = await adapter.captureCandidate({ baseCommit: head });
  const two = await adapter.captureCandidate({ baseCommit: head });
  assert.equal(one.integrityHash, two.integrityHash);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
  const three = await adapter.captureCandidate({ baseCommit: head });
  assert.notEqual(one.integrityHash, three.integrityHash);
});

test('adapter passes the required exec options', async () => {
  const calls = [];
  const adapter = createGitAdapter({
    workspace: '/nowhere',
    execFile: async (cmd, argv, options) => {
      calls.push({ cmd, argv, options });
      throw new Error('fail');
    },
  });
  const result = await adapter.preflight({ baseRef: 'main' });
  assert.equal(result.problems[0].code, 'not_a_repo');
  assert.equal(calls[0].cmd, 'git');
  assert.equal(calls[0].options.cwd, '/nowhere');
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].options.env.LC_ALL, 'C');
  assert.equal(calls[0].options.env.GIT_ASKPASS, 'true');
  assert.equal(calls[0].options.env.SSH_ASKPASS, undefined);
  assert.equal(calls[0].options.timeout, 60 * 1000);
  assert.ok(calls[0].options.maxBuffer >= 4 * 1024 * 1024);
});

test('module source never uses forbidden git subcommands', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'git-adapter.js'), 'utf8');
  const forbidden = ['commit', 'push', 'stash', 'reset', 'clean', 'checkout', 'rebase', 'merge', 'cherry-pick', 'config', 'pull', 'fetch', 'add', 'rm', 'restore', 'tag', 'apply', 'am', 'revert', 'branch'];
  for (const word of forbidden) {
    assert.ok(!new RegExp(`['"\`]${word}['"\`]`).test(source), `forbidden subcommand: ${word}`);
  }
  assert.ok(!/['"`]-[dDfF]['"`]/.test(source), 'branch delete/force flags');
  assert.ok(!/shell\s*:/.test(source));
});

test('a malicious core.fsmonitor and diff.external in the repository config never execute', async (t) => {
  const { dir, head, adapter } = setup(t);
  const marker = path.join(dir, '..', `marker-${path.basename(dir)}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const script = path.join(dir, '..', `evil-${path.basename(dir)}.sh`);
  t.after(() => fs.rmSync(script, { force: true }));
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
  git(dir, 'config', 'core.fsmonitor', script);
  git(dir, 'config', 'diff.external', script);
  // Sanity: without the adapter's overrides the config really fires.
  git(dir, 'status', '--porcelain');
  assert.ok(fs.existsSync(marker), 'the fsmonitor vector is live');
  fs.rmSync(marker);

  await adapter.preflight({ baseRef: 'main' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  await adapter.captureCandidate({ baseCommit: head });
  assert.ok(!fs.existsSync(marker), 'no repository-configured program ran');
});

test('every command carries the hardening overrides and diffs disable external tools', async () => {
  const calls = [];
  const adapter = createGitAdapter({
    workspace: '/nowhere',
    execFile: async (cmd, argv) => {
      calls.push(argv);
      if (argv.includes('rev-parse')) return { stdout: 'abc\n' };
      return { stdout: '' };
    },
  });
  await adapter.captureCandidate({ baseCommit: 'abc' });
  assert.ok(calls.length > 0);
  for (const argv of calls) {
    assert.deepEqual(argv.slice(0, 6), ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=']);
  }
  const diffs = calls.filter((argv) => argv.includes('diff'));
  assert.ok(diffs.length > 0);
  for (const argv of diffs) {
    assert.ok(argv.includes('--no-ext-diff') && argv.includes('--no-textconv'));
  }
});

test('a large untracked file is hashed by streaming, never read whole', async (t) => {
  const { dir, head, adapter } = setup(t);
  const big = path.join(dir, 'big.bin');
  const size = 20 * 1024 * 1024;
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, size);
  const reads = [];
  const original = fs.readFileSync;
  fs.readFileSync = function spy(file, ...rest) {
    reads.push(String(file));
    return original.call(this, file, ...rest);
  };
  let c;
  try {
    c = await adapter.captureCandidate({ baseCommit: head });
  } finally {
    fs.readFileSync = original;
  }
  assert.ok(!reads.some((file) => file.endsWith('big.bin')), 'big file was not read with readFileSync');
  const entry = c.manifest.find((m) => m.path === 'big.bin');
  assert.equal(entry.size, size);
  const expected = require('node:crypto').createHash('sha256');
  for (let i = 0; i < 20; i += 1) expected.update(Buffer.alloc(1024 * 1024));
  assert.equal(entry.sha256, expected.digest('hex'));
});

test('the manifest is capped at 2000 entries and flagged', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.mkdirSync(path.join(dir, 'many'));
  for (let i = 0; i < 2100; i += 1) fs.writeFileSync(path.join(dir, 'many', `f${String(i).padStart(4, '0')}.txt`), 'x\n');
  const c = await adapter.captureCandidate({ baseCommit: head });
  assert.equal(c.manifest.length, 2000);
  assert.equal(c.manifestTruncated, true);
  fs.rmSync(path.join(dir, 'many'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'one.txt'), 'x\n');
  const small = await adapter.captureCandidate({ baseCommit: head });
  assert.equal(small.manifestTruncated, false);
});

test('preflight allows a dirty checkout on the owned branch with an informational note', async (t) => {
  const { dir, head, adapter } = setup(t);
  await adapter.prepareBranch({ name: 'feature/own-aaaaaa', baseCommit: head });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n');
  const owned = await adapter.preflight({ baseRef: 'main', ownedBranch: 'feature/own-aaaaaa' });
  assert.equal(owned.ok, true);
  assert.deepEqual(owned.problems, []);
  assert.deepEqual(owned.notes.map((n) => n.code), ['owned_branch_dirty']);
  assert.equal(owned.branch, 'feature/own-aaaaaa');
  const other = await adapter.preflight({ baseRef: 'main', ownedBranch: 'feature/other-bbbbbb' });
  assert.deepEqual(other.problems.map((p) => p.code), ['dirty_worktree']);
  const none = await adapter.preflight({ baseRef: 'main' });
  assert.deepEqual(none.problems.map((p) => p.code), ['dirty_worktree']);
  assert.ok(!none.notes.some((n) => n.code === 'owned_branch_dirty'));
});

test('prepareBranch is a no-op success on the owned branch even when dirty', async (t) => {
  const { dir, head, adapter } = setup(t);
  await adapter.prepareBranch({ name: 'feature/own-aaaaaa', baseCommit: head });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  const again = await adapter.prepareBranch({ name: 'feature/own-aaaaaa', baseCommit: head, ownedByThisTicket: true });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/own-aaaaaa');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'changed\n');
});

test('manifest entries carry the file mode and a chmod after capture changes the integrity hash', async (t) => {
  const { dir, head, adapter } = setup(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
  fs.unlinkSync(path.join(dir, 'b.txt'));
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync('a.txt', path.join(dir, 'link'));
  const one = await adapter.captureCandidate({ baseCommit: head });
  const by = Object.fromEntries(one.manifest.map((m) => [m.path, m]));
  assert.equal(by['a.txt'].mode, 'file');
  assert.equal(by['b.txt'].mode, null);
  assert.equal(by['run.sh'].mode, 'exec');
  assert.equal(by.link.mode, 'symlink');
  assert.deepEqual(Object.keys(by['a.txt']), ['path', 'status', 'sha256', 'size', 'mode']);
  fs.chmodSync(path.join(dir, 'a.txt'), 0o755);
  const two = await adapter.captureCandidate({ baseCommit: head });
  assert.equal(two.manifest.find((m) => m.path === 'a.txt').mode, 'exec');
  assert.notEqual(one.integrityHash, two.integrityHash);
});

test('the adapter honours a custom timeout and keeps a user GIT_SSH_COMMAND', async () => {
  const calls = [];
  const saved = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'ssh -i /custom/key';
  try {
    const adapter = createGitAdapter({
      workspace: '/nowhere',
      timeoutMs: 1234,
      execFile: async (cmd, argv, options) => {
        calls.push(options);
        throw new Error('fail');
      },
    });
    await adapter.preflight({ baseRef: 'main' });
  } finally {
    if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = saved;
  }
  assert.equal(calls[0].timeout, 1234);
  assert.equal(calls[0].env.GIT_SSH_COMMAND, 'ssh -i /custom/key');
});
