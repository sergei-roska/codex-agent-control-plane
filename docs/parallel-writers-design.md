# Parallel writers in isolated worktrees (PW)

Status: decided by the lead on 2026-10-10, owner-approved direction ("each writer gets
its own git worktree"). Revision 2 after an independent review (verdict: sound with
the changes below; R1 is a hard gate). PW-1 and PW-2 are done; PW-3 is split into
PW-3a..PW-3c.

## Problem

Writable specialists run strictly one at a time (`src/lead-graph.js` dispatch,
`src/writer-admission.js` unique holder per workspace). In a measured run three
engineers took 586 + 527 + 285 s back to back. The serialization exists because all
writers share one working tree: the sandbox does not confine a writer to its
`allowedFiles`, attestation diffs snapshots of the shared tree, and concurrent test
runs see each other's half-made edits.

## Core decision

A writer no longer edits the shared tree. It edits a private git worktree (a
"lane"). The only thing that writes the shared tree on a writer's behalf is a short,
server-run integration step that applies the lane's patch while holding the existing
workspace admission. The audited machinery (admission, snapshots, attested delta,
reconciliation) stays and now guards the integration step, which takes seconds
instead of a whole Codex turn.

This is only sound if a lane turn provably cannot write the shared tree, its `.git`,
or anything reachable through the lane's links. That is checked in code (R1); when
the check fails, the server runs in `shared` mode (today's behavior).

## Mode selection

`CODEX_A2A_WRITER_ISOLATION=worktree|shared`, default `worktree`. Worktree mode is
used for an attempt only when all of these hold; otherwise that attempt runs exactly
as today (`shared`: admission held for the whole turn):

- the workspace is the top of its git work tree (`rev-parse --show-prefix` is empty)
  and the repo has no submodules (R8);
- the confinement probe for the current App Server version passed (R1);
- the request carries a non-empty `allowedFiles` (structured assignment); plain-text
  legacy requests run in `shared` mode (R11);
- the role's sandbox is `workspace-write` (never for danger-full-access).

The server reports the effective mode once at startup and the lead prompt says
whether parallel writers are on (`parallelWriters` in the lead graph is true only in
worktree mode).

## Confinement probe (R1, hard gate)

At startup and whenever the App Server generation changes version, the server creates
a probe lane (same code path as a real lane, including links) and runs, through the
App Server RPC `command/exec` with `cwd` = lane and the exact `sandboxPolicy` a lane
turn uses, a fixed set of shell commands that try to:

1. create a file in the shared workspace root;
2. create a file in the shared repo's git common dir and in the lane's admin dir
   (`<common>/worktrees/<lane>`);
3. create a file through each environment link (`.venv/`, `node_modules/`, ...);
4. run `git commit --allow-empty` and `git stash` in the lane.

Every attempt must fail and the shared tree, `.git`, and link targets must be
unchanged afterwards (checked by the server outside the sandbox). Any success, or any
probe error, puts the server in `shared` mode with the reason recorded (`lane_probe`
row keyed by App Server version) and shown at startup. The probe covers shell
commands; Codex's own `apply_patch` tool enforces writable roots in-process and is
trusted to the same policy.

Lane turns send the sandbox policy with every field explicit:
`{ type: 'workspaceWrite', writableRoots: [], networkAccess: <effective config
sandbox_workspace_write.network_access, default false>, excludeTmpdirEnvVar: false,
excludeSlashTmp: false }`.

## Lane lifecycle (one writable attempt in worktree mode)

All git commands are run by the server (not the sandbox) with hardened options (R2):
explicit `GIT_DIR` / `GIT_WORK_TREE` for lane operations, `-c core.fsmonitor=false
-c core.hooksPath=/dev/null` on every call (inherited by child git processes), hooks
off for `worktree add`, plumbing for diffs (`diff-index --cached -p --binary
--full-index --no-renames --no-ext-diff --no-textconv`). None of them touch the
shared repository's index, HEAD, refs, stash, or config.

1. Prepare.
   - Refuse early if the attempt's context is fenced (`writer_fences`) (R10).
   - Durable row in `writer_lanes`, state `preparing`, written before any git (R11).
   - Inside the per-workspace shared-tree mutex: base = commit object of the shared
     tree's current content (temporary index; tracked changes, deletions, untracked
     non-ignored files; ignored excluded); `git worktree add --detach` under the lanes
     root; environment links (`CODEX_A2A_LANE_LINKS`, default `.venv,venv,node_modules`,
     only names that exist and are ignored in the shared tree) as symlinks.
   - Lanes root: `<stateDir>/lanes`, unless that is inside the workspace; then
     `~/.cache/codex-a2a/lanes/<workspace hash>` (R11).
   - Row state `prepared`.
2. Turn. `appServer.run` with `cwd` = lane and the explicit policy above. The worker
   input gets one leading line: the lane path, that paths are relative to it, and that
   the server integrates the changes. No admission is held. The turn's process
   identity is stored on the lane row (`turnStart`), as admission does today (R11).
   Row state `running`.
3. Decide whether to integrate (R6). Integrate only when the turn completed with
   status `completed` and the task's abort signal is not set. Otherwise: no
   integration, row `not_integrated`, reason `canceled`, `turn_failed`, or
   `outcome_unknown`; lane kept (BUD-2 continues usage-limited lanes later).
4. Collect. Refuse (reason `lane_unsafe`, lane kept) if the lane contains a nested
   `.git` (file or dir) below its root, a gitlink (mode 160000), or a symlink whose
   target is absolute or escapes the workspace (R2). Patch and changed-path list from
   the hardened diff against the base, link names excluded by pathspec. Empty patch:
   row `not_integrated`, reason `no_changes`.
5. Scope gate (R7). Any changed path outside `allowedFiles` (existing
   `pathsOutsideAllowed`, workspace-relative) refuses the whole patch: nothing is
   applied, row `not_integrated`, reason `lane_scope_refused`, lane kept. This is a
   new boundary predicate `settle.lane_scope` (code `lane_scope_refused`) that fails
   only this attempt; it is not `settle.attested_scope` and is not aggregated into
   acceptance, because nothing reached the shared tree.
6. Integrate (R3, R5, R9).
   - Row state `integrating`, written before acquire.
   - `admission.acquire` on the shared workspace with the attempt's context id, role,
     and the task's abort signal (FIFO, durable `writer_executions` row,
     `snapshot_before`). Refusals (`fenced`, `admission_blocked`, abort): no row was
     created, row `not_integrated` with that reason, lane kept.
   - Then the per-workspace mutex, only around check and apply.
   - `git apply --check --binary --whitespace=nowarn`; on failure: release (delta
     from snapshots, may contain owner edits made meanwhile), lane reason
     `integration_conflict` with the conflicting paths, lane kept.
   - `git apply --binary --whitespace=nowarn` (working tree only) runs as a detached
     process exactly like acceptance checks: record a pending turn start on the
     admission row before spawn, then the real process identity on spawn
     (`src/acceptance.js:374-380`). A crash mid-apply therefore leaves a row whose
     process group must be proven gone before restart reconciliation releases it.
   - `admission.release` (snapshot_after, attested delta). Lane removed, row
     `integrated`.
7. Result. `writerExecution` metadata keeps today's shape plus
   `lane: { id, path, workspacePath, base, state, reason, conflicts?,
   attemptedPaths? }`.
   - Rule (R5): `effects: 'none'` is claimed only when no `writer_executions` row
     exists for the attempt. Once admission was acquired, the outcome is that row
     (state and delta), whatever the lane reason.
   - Settlement (R4): `isSettledWriter` treats a writer result as settled when its
     execution row is released or reconciled, or when it has no `executionId` and
     `lane.state === 'not_integrated'`. This works for COMPLETED tasks too: the
     value is read from the artifact's `writerExecution`, not only from a status
     message. A `no_changes` or refused lane must not skip the next group.
   - Reported paths (R7): the lead strips `lane.workspacePath` from worker-reported
     paths before `settle.reported_scope`; `settle.reported_scope` is advisory for
     non-integrated lanes.

Lock order (R9): integration takes admission, then the mutex; prepare takes only
the mutex; acceptance takes only admission. One mutex per real workspace path,
shared by all executors. No cycle.

## Lanes table

```sql
CREATE TABLE IF NOT EXISTS writer_lanes (
  lane_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  task_id TEXT,
  workspace TEXT NOT NULL,
  path TEXT NOT NULL,
  base_commit TEXT,
  state TEXT NOT NULL,   -- preparing | prepared | running | integrating | integrated | not_integrated | orphaned | removed
  reason TEXT,
  turn_start_json TEXT,  -- { processIdentity, threadId } of the lane turn
  execution_id TEXT,     -- writer_executions row of the integration, once acquired
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Startup recovery, per row of this workspace:

- `preparing`, `prepared`, `running`: kill an orphaned lane process group from
  `turn_start_json` with the existing quiescence helpers; row `orphaned`, lane kept.
- `integrating`: resolve through `execution_id` / the context's `writer_executions`
  row (the existing restart reconcile handles the admission row); row `integrated`
  if that row ends released or reconciled with the lane's paths applied, else
  `not_integrated` with reason `integration_interrupted`.
- Retention: kept lanes (`orphaned`, `not_integrated`) older than
  `CODEX_A2A_LANE_RETENTION_HOURS` (default 72) are removed.
- Never run a repo-wide `git worktree prune` (it would drop admin dirs of the owner's
  own worktrees). Remove lanes with `git worktree remove --force <path>`; for a lane
  whose directory is gone, delete only its admin dir `<common>/worktrees/<name>`
  after checking that its `gitdir` file points into the lanes root (R11).

Launcher session deletion is refused while a run has non-terminal `writer_lanes`
rows, in addition to today's `writer_executions` guard (R11).

## Groups (waves) in a lead decision

Done in PW-2: assignment field `wave` (integer >= 1 or null, required in the strict
schema); execution groups are maximal runs of consecutive assignments sharing a
non-null wave; writers in one group need pairwise disjoint `allowedFiles`
(`assignment.wave` / `wave_scope_overlap`); with `parallelWriters` a group is
submitted together and the next group starts after it finishes; old checkpoints
without groups keep the previous behavior.

## Known limits

- The probe covers shell commands through `command/exec`; `apply_patch` confinement
  is Codex's own in-process policy.
- Python editable installs resolve imports to the shared tree outside pytest; pytest
  with `pythonpath = ["src"]` imports the lane's code.
- A turn timeout terminates the shared App Server and every concurrent turn; those
  lanes end `not_integrated` (`outcome_unknown`). Work is lost, the shared tree is
  safe.
- An `integration_conflict` or a partial apply attributes concurrent owner edits to
  the writer's delta, as snapshots do today.
- Each lane is a full checkout of tracked and untracked files.

## Review resolutions (R1-R11)

| Id | Finding | Resolution |
| --- | --- | --- |
| R1 | Confinement assumed; links can escape | Probe via `command/exec` per App Server version; failure forces `shared`; explicit sandbox policy |
| R2 | Server git trusts lane content | Hardened git options, explicit GIT_DIR/WORK_TREE, plumbing diff, refuse nested `.git`, gitlinks, escaping symlinks |
| R3 | Crash mid-apply looked quiescent | Detached apply with pending then real turn start on the admission row; lane state `integrating` |
| R4 | `effects: 'none'` not seen for COMPLETED | Settlement reads lane state from `writerExecution`; test `no_changes` lets the next group run |
| R5 | `not_integrated` untrue after acquire | `effects: 'none'` only without a `writer_executions` row |
| R6 | Which turns integrate | Only `completed` and not aborted; abort signal passed to acquire |
| R7 | Refused patch poisoned acceptance | New predicate `settle.lane_scope`; lead strips lane prefix; reported scope advisory for non-integrated lanes |
| R8 | Nested workspaces | Worktree mode only at the work tree top, no submodules |
| R9 | Mutex held while waiting for admission | Admission first, mutex only around check/apply and prepare; one mutex per workspace |
| R10 | Fences checked late | Check at prepare; define fenced and admission_blocked outcomes |
| R11 | Minor gaps | Launcher guard, no global prune, row before `worktree add`, legacy requests in shared mode, lane process identity, lanes root outside the workspace |

## Tasks

- PW-3a `src/writer-worktree.js` hardening: R2 options and refusals, detached apply
  with spawn identity callback, no repo-wide prune, admin-dir removal for vanished
  lanes.
- PW-3b confinement probe: `CodexAppServer.execCommand` (`command/exec`), probe
  module, version-keyed result, one live run against the installed App Server.
- PW-3c lane execution and integration (`src/a2a-role-service.js`), `writer_lanes`
  store and startup recovery, settlement and reported-path changes in
  `src/lead-graph.js`, predicate `settle.lane_scope` in `src/contracts.js`, launcher
  deletion guard, server wiring and mode selection, `parallelWriters` on in worktree
  mode. Depends on PW-3a and PW-3b.
- After PW-3c: update `docs/execution-boundary-contract.md`,
  `docs/hardening-spec.md`, `docs/intent-recovery-contract.md` (W3, W5, W6; G2 now
  means "never integrated"), the supervisor replay rule, README, TEAM.md.
