const fs = require('node:fs');

// Process-group quiescence helpers. A detached App Server child leads its own
// process group; when that group is gone no descendant can still mutate the
// workspace. Identity = pid + pgid + kernel start time (guards pid reuse).

function parseProcStat(text) {
  // /proc/<pid>/stat: "pid (comm) state ppid pgrp ..."; comm may contain ')' or spaces.
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  // fields[0] = state (overall field 3), so overall field N is fields[N - 3].
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !startTime) return null;
  return { ppid, pgid, startTime };
}

function readProcStat(pid, fsImpl = fs) {
  try {
    return parseProcStat(fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readProcessIdentity(pid, fsImpl = fs) {
  const stat = readProcStat(pid, fsImpl);
  if (!stat) return { pid, pgid: pid, startTime: null };
  return { pid, pgid: stat.pgid, startTime: stat.startTime };
}

function groupAnswers(pgid, killImpl) {
  try {
    killImpl(-pgid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    return true; // EPERM or anything else: the group may exist
  }
}

function groupState(identity, killImpl, fsImpl) {
  const answers = groupAnswers(identity.pgid, killImpl);
  const leader = readProcStat(identity.pid, fsImpl);
  return { answers, leader };
}

function validPgid(pgid) {
  return Number.isInteger(pgid) && pgid > 1;
}

function procReadable(fsImpl) {
  try {
    return Boolean(fsImpl.readFileSync('/proc/self/stat', 'utf8'));
  } catch (_) {
    return false;
  }
}

function isProcessGroupGone(identity, { killImpl = process.kill.bind(process), fsImpl = fs } = {}) {
  if (!validPgid(identity?.pgid)) return false; // unproven: never signal or trust pgid 0/1/garbage
  try {
    killImpl(-identity.pgid, 0);
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH');
  }
  // The group still answers. A new leader with the same id but another start
  // time proves the old group was empty: a group id cannot be reused while any
  // member of the old group exists.
  const leader = readProcStat(identity.pid, fsImpl);
  if (leader && identity.startTime != null && leader.startTime !== identity.startTime) return true;
  return false;
}

function killOrphanProcessGroup(identity, { killImpl = process.kill.bind(process), fsImpl = fs } = {}) {
  // Our App Server child always leads its own group, so pgid must equal pid.
  if (!validPgid(identity?.pgid) || identity.pgid !== identity.pid) return false;
  if (!procReadable(fsImpl)) return false; // cannot verify identity: never kill blind
  if (isProcessGroupGone(identity, { killImpl, fsImpl })) return false;
  const { answers, leader } = groupState(identity, killImpl, fsImpl);
  if (!answers) return false;
  let allowed = false;
  if (leader) {
    allowed = identity.startTime != null
      && leader.startTime === identity.startTime
      && leader.ppid !== process.pid;
  } else {
    allowed = true; // leader dead, but the group (grandchildren) still answers
  }
  if (!allowed) return false;
  try {
    killImpl(-identity.pgid, 'SIGKILL');
  } catch (error) {
    return false;
  }
  return true;
}

module.exports = { readProcessIdentity, isProcessGroupGone, killOrphanProcessGroup, parseProcStat };
