const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const {
  readProcessIdentity, isProcessGroupGone, killOrphanProcessGroup, parseProcStat,
} = require('../src/process-quiescence');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

function spawnLeader(code = 'setInterval(()=>{},1000)') {
  return spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
}

function cleanup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* gone */ }
}

test('parseProcStat handles parentheses and spaces in the command name', () => {
  const rest = ['S', '10', '20', '20', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1', '0', '987654', '0'];
  const parsed = parseProcStat(`42 (we) ird ) name) ${rest.join(' ')}`);
  assert.deepEqual(parsed, { ppid: 10, pgid: 20, startTime: '987654' });
  assert.equal(parseProcStat('garbage'), null);
});

test('readProcessIdentity reads pgid and start time of a detached child', async (t) => {
  const child = spawnLeader();
  t.after(() => cleanup(child));
  const identity = readProcessIdentity(child.pid);
  assert.equal(identity.pid, child.pid);
  assert.equal(identity.pgid, child.pid);
  assert.match(identity.startTime, /^\d+$/);
});

test('readProcessIdentity falls back for an unreadable pid', () => {
  assert.deepEqual(readProcessIdentity(2 ** 30), { pid: 2 ** 30, pgid: 2 ** 30, startTime: null });
});

test('isProcessGroupGone is false while alive and true after the group dies', async (t) => {
  const child = spawnLeader();
  t.after(() => cleanup(child));
  const identity = readProcessIdentity(child.pid);
  assert.equal(isProcessGroupGone(identity), false);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  process.kill(-child.pid, 'SIGKILL');
  await exited;
  assert.equal(isProcessGroupGone(identity), true);
});

test('a grandchild keeps the group alive after the leader dies; orphan kill removes it', async (t) => {
  const code = "const { spawn } = require('node:child_process');"
    + "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });"
    + 'console.log(g.pid); setInterval(()=>{},1000)';
  const leader = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => cleanup(leader));
  await new Promise((resolve) => leader.stdout.once('data', resolve));
  const identity = readProcessIdentity(leader.pid);
  const exited = new Promise((resolve) => leader.on('exit', resolve));
  process.kill(leader.pid, 'SIGKILL'); // leader only, not the group
  await exited;
  assert.equal(isProcessGroupGone(identity), false, 'grandchild still holds the group');
  assert.equal(killOrphanProcessGroup(identity), true);
  assert.equal(await waitFor(() => isProcessGroupGone(identity)), true);
  assert.equal(killOrphanProcessGroup(identity), false);
});

test('killOrphanProcessGroup refuses a group led by our own child', async (t) => {
  const child = spawnLeader();
  t.after(() => cleanup(child));
  const identity = readProcessIdentity(child.pid);
  assert.equal(killOrphanProcessGroup(identity), false);
  assert.equal(isProcessGroupGone(identity), false);
});

test('a wrong start time proves the group gone and is never killed', async (t) => {
  const child = spawnLeader();
  t.after(() => cleanup(child));
  const real = readProcessIdentity(child.pid);
  const stale = { ...real, startTime: String(Number(real.startTime) + 1) };
  assert.equal(isProcessGroupGone(stale), true);
  assert.equal(killOrphanProcessGroup(stale), false);
  assert.equal(isProcessGroupGone(real), false);
});

test('killOrphanProcessGroup never kills a live leader with unknown start time', async (t) => {
  const child = spawnLeader();
  t.after(() => cleanup(child));
  const unknown = { pid: child.pid, pgid: child.pid, startTime: null };
  assert.equal(killOrphanProcessGroup(unknown), false);
  assert.equal(child.exitCode, null);
});

test('EPERM is treated conservatively as not gone', () => {
  const killImpl = () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; };
  assert.equal(isProcessGroupGone({ pid: 1, pgid: 1, startTime: '1' }, { killImpl }), false);
});

test('isProcessGroupGone is unproven (false) for pgid <= 1 or non-integer', () => {
  const killImpl = () => { const e = new Error('none'); e.code = 'ESRCH'; throw e; };
  for (const pgid of [0, 1, -5, 1.5, '20', null, undefined, NaN]) {
    assert.equal(isProcessGroupGone({ pid: 5, pgid, startTime: '1' }, { killImpl }), false, String(pgid));
  }
  assert.equal(isProcessGroupGone({ pid: 5, pgid: 5, startTime: '1' }, { killImpl }), true);
});

test('killOrphanProcessGroup requires pgid === pid and pgid > 1', () => {
  const calls = [];
  const killImpl = (pid, signal) => { calls.push([pid, signal]); };
  for (const identity of [
    { pid: 10, pgid: 20, startTime: '1' },
    { pid: 1, pgid: 1, startTime: '1' },
    { pid: 0, pgid: 0, startTime: '1' },
    { pid: 7.5, pgid: 7.5, startTime: '1' },
  ]) {
    assert.equal(killOrphanProcessGroup(identity, { killImpl }), false);
  }
  assert.deepEqual(calls, []);
});

test('killOrphanProcessGroup never kills when /proc is unreadable', () => {
  const calls = [];
  const killImpl = (pid, signal) => { calls.push([pid, signal]); };
  const fsImpl = { readFileSync() { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } };
  assert.equal(killOrphanProcessGroup({ pid: 4242, pgid: 4242, startTime: '1' }, { killImpl, fsImpl }), false);
  assert.equal(calls.some(([, signal]) => signal === 'SIGKILL'), false);
});
