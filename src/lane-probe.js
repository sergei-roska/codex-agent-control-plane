'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { laneSandboxPolicy } = require('./codex-app-server');
const { inspectRepo, createBase, addLane, removeLane } = require('./writer-worktree');

// Confinement probe (R1) from docs/parallel-writers-design.md. Commands run in a probe lane
// under the exact lane sandbox policy; the server, outside the sandbox, then checks for
// any observable effect. Any effect means the sandbox leaks and lane mode must stay off.

function readGit(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-C', cwd, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
}

function tryGit(cwd, args) {
  try { return readGit(cwd, args); } catch (_) { return null; }
}

function exists(target) {
  try { fs.lstatSync(target); return true; } catch (_) { return false; }
}

// path -> "size:mtimeMs" for every entry below dir, skipping the given absolute paths.
function snapshotTree(dir, skip, out = new Map()) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (skip.has(full)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch (_) { continue; }
    out.set(full, `${stat.size}:${stat.mtimeMs}`);
    if (entry.isDirectory()) snapshotTree(full, skip, out);
  }
  return out;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [key, value] of after) if (before.get(key) !== value) changed.push(key);
  for (const key of before.keys()) if (!after.has(key)) changed.push(key);
  return changed.sort();
}

async function runConfinementProbe({ appServer, workspace, lanesRoot, links = [], networkAccess = false } = {}) {
  const checks = [];
  const version = () => (typeof appServer?.getVersion === 'function' ? appServer.getVersion() : null) || null;
  const finish = (ok, reason) => ({ ok, version: version(), reason, checks });
  const rand = crypto.randomBytes(6).toString('hex');
  const markerName = `pw-probe-${rand}`;
  const cleanup = [];
  let lane = null;
  try {
    const repo = inspectRepo(workspace);
    if (!repo.ok) return finish(false, 'not_eligible');
    const base = createBase(workspace);
    fs.mkdirSync(lanesRoot, { recursive: true });
    lane = addLane({ root: workspace, base: base.commit, dir: path.join(lanesRoot, `probe-${rand}`), links });
    const adminDir = lane.adminDir;
    const gitRoot = repo.gitRoot;
    const commonDir = path.resolve(gitRoot, readGit(gitRoot, ['rev-parse', '--git-common-dir']));
    const sharedWorkspace = path.resolve(workspace);
    // /tmp stays writable on purpose (pytest tmp_path etc.); a shared workspace under /tmp shows up as an escape.
    const policy = laneSandboxPolicy({ workspacePath: lane.workspacePath, networkAccess });
    const run = (script, ...args) => appServer.execCommand({
      command: ['sh', '-c', script, 'sh', ...args], cwd: lane.workspacePath, sandboxPolicy: policy,
    });

    // Positive control: a write inside the lane must work, else "nothing escaped" proves nothing.
    const control = path.join(lane.workspacePath, `${markerName}-control`);
    cleanup.push(control);
    await run('touch "$1"', control);
    if (!exists(control)) {
      checks.push({ name: 'control_lane_write', escaped: false, detail: 'write inside the lane did not take effect' });
      return finish(false, 'sandbox_unusable');
    }
    checks.push({ name: 'control_lane_write', escaped: false, detail: 'lane write works' });

    // Baseline of the shared tree and repo internals (the probe lane's own admin dir excluded).
    const sharedSkip = new Set(links.map((name) => path.join(sharedWorkspace, name)));
    const commonSkip = new Set([path.join(commonDir, 'worktrees', path.basename(adminDir))]);
    const sharedBefore = snapshotTree(sharedWorkspace, sharedSkip);
    const commonBefore = snapshotTree(commonDir, commonSkip);
    const refsBefore = tryGit(gitRoot, ['for-each-ref']);
    const headBefore = tryGit(lane.workspacePath, ['rev-parse', 'HEAD']);
    const adminHeadBefore = fs.readFileSync(path.join(adminDir, 'HEAD'), 'utf8');

    // Attempts to create `target` from inside the sandbox; the effect is looked for at `observe`.
    const writeCheck = async (name, target, observe = target) => {
      cleanup.push(target, observe);
      await run('touch "$1" 2>/dev/null && echo wrote', target);
      const escaped = exists(observe);
      checks.push({ name, escaped, detail: escaped ? `created ${observe}` : 'blocked' });
    };

    await writeCheck('shared_workspace_write', path.join(sharedWorkspace, `.${markerName}`));
    await writeCheck('git_common_dir_write', path.join(commonDir, markerName));
    await writeCheck('lane_admin_dir_write', path.join(adminDir, markerName));
    for (const name of lane.linked || []) {
      await writeCheck(`link_write:${name}`, path.join(lane.workspacePath, name, markerName), path.join(sharedWorkspace, name, markerName));
    }

    const identity = '-c user.name=probe -c user.email=probe@localhost -c commit.gpgsign=false';
    await run(`git ${identity} commit --allow-empty -m probe 2>/dev/null && echo committed`);
    const headAfter = tryGit(lane.workspacePath, ['rev-parse', 'HEAD']);
    const adminHeadAfter = fs.readFileSync(path.join(adminDir, 'HEAD'), 'utf8');
    const committed = headBefore !== headAfter || adminHeadBefore !== adminHeadAfter;
    checks.push({ name: 'git_commit', escaped: committed, detail: committed ? `lane HEAD moved ${headBefore} -> ${headAfter}` : 'blocked' });

    // Something must be stashable, so the server drops an untracked file and uses stash -u.
    const stashFile = path.join(lane.workspacePath, `${markerName}-stash`);
    cleanup.push(stashFile);
    fs.writeFileSync(stashFile, 'probe\n');
    await run(`git ${identity} stash push -u -m probe 2>/dev/null && echo stashed`);
    const stashRef = tryGit(gitRoot, ['rev-parse', '--verify', '-q', 'refs/stash']);
    checks.push({ name: 'git_stash', escaped: Boolean(stashRef), detail: stashRef ? `refs/stash appeared: ${stashRef}` : 'blocked' });

    // Shared tree, .git and refs must be unchanged (checked before marker cleanup).
    const changed = [
      ...diffSnapshots(sharedBefore, snapshotTree(sharedWorkspace, sharedSkip)),
      ...diffSnapshots(commonBefore, snapshotTree(commonDir, commonSkip)),
    ];
    const refsChanged = refsBefore !== tryGit(gitRoot, ['for-each-ref']);
    const unchanged = !changed.length && !refsChanged;
    checks.push({
      name: 'shared_state_unchanged',
      escaped: !unchanged,
      detail: unchanged ? 'workspace, .git and refs unchanged' : `changed: ${changed.slice(0, 10).join(', ')}${refsChanged ? ' (refs changed)' : ''}`,
    });

    const leaked = checks.filter((check) => check.escaped).map((check) => check.name);
    return finish(!leaked.length, leaked.length ? `escaped: ${leaked.join(', ')}` : null);
  } catch (error) {
    return finish(false, `probe_error: ${error && error.message ? error.message : String(error)}`);
  } finally {
    for (const target of cleanup) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
    if (lane) {
      try { removeLane({ root: workspace, lane: lane.path, lanesRoot }); } catch (_) { /* best effort */ }
    }
  }
}

function createLaneProbeStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lane_probe (
    version TEXT PRIMARY KEY,
    ok INTEGER NOT NULL,
    reason TEXT,
    checks_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  const selectRow = db.prepare('SELECT version, ok, reason, checks_json, created_at FROM lane_probe WHERE version = ?');
  const upsert = db.prepare(`INSERT INTO lane_probe (version, ok, reason, checks_json, created_at)
    VALUES (@version, @ok, @reason, @checks_json, @created_at)
    ON CONFLICT(version) DO UPDATE SET ok = excluded.ok, reason = excluded.reason,
      checks_json = excluded.checks_json, created_at = excluded.created_at`);
  return {
    get(version) {
      const row = selectRow.get(version || 'unknown');
      if (!row) return null;
      return { version: row.version, ok: row.ok === 1, reason: row.reason, checks: JSON.parse(row.checks_json), createdAt: row.created_at };
    },
    put(result) {
      upsert.run({
        version: result.version || 'unknown',
        ok: result.ok ? 1 : 0,
        reason: result.reason ?? null,
        checks_json: JSON.stringify(result.checks || []),
        created_at: new Date().toISOString(),
      });
    },
  };
}

module.exports = { runConfinementProbe, createLaneProbeStore };
