# Parallel writers in isolated worktrees (PW)

Status: decided by the lead on 2026-10-10, owner-approved direction ("each
writer gets its own git worktree"). Implementation tasks PW-1..PW-3 below.

## Problem

Writable specialists run strictly one at a time (`src/lead-graph.js:1050`,
`src/writer-admission.js` unique holder per workspace). In a measured run three
engineers took 586 + 527 + 285 s back to back. The serialization exists because
all writers share one working tree: the sandbox does not confine a writer to its
`allowedFiles`, attestation diffs snapshots of the shared tree, and concurrent
test runs see each other's half-made edits.

## Core decision

A writer no longer edits the shared tree. It edits a private git worktree (a
"lane"). The only thing that ever writes the shared tree on a writer's behalf is
a short, server-run integration step that applies the lane's patch. The audited
single-writer machinery (admission, snapshots, attested delta, reconciliation)
stays and now guards the integration step, which takes seconds instead of the
whole Codex turn.

Consequences:

- Writers in the same group run concurrently; integrations stay serial (FIFO
  admission on the shared workspace, as today).
- A writer whose turn outcome is unknown (timeout, crash) has touched only its
  lane, so it no longer blocks other writers or pauses the run: it is reported
  `not_integrated` with effects `none`.
- Attestation is stronger: the lane patch is computed by the server outside the
  sandbox, and out-of-scope changes are refused before they reach the shared
  tree instead of being flagged after the fact.

## Scope

In: writable specialist roles (engineer, recovery-engineer, senior-engineer,
verifier) dispatched by the lead or called directly. Out (unchanged): the lead
(read-only, shared tree), read-only roles (shared tree), acceptance (shared tree
under admission), the App Server supervisor and turn timeout handling.

Mode: `CODEX_A2A_WRITER_ISOLATION=worktree|shared`, default `worktree`.
`worktree` requires the workspace to be inside a git work tree with no
submodules; otherwise the server falls back to `shared` (today's behavior) and
says so once at startup and in the lead prompt.

## Lane lifecycle (one writable attempt)

All git commands below are run by the server (Node `execFile`, not the Codex
sandbox). None of them touch the shared repository's index, HEAD, refs, stash,
or config. Writes into the shared `.git` are limited to new objects and the
`.git/worktrees/<lane>` admin directory that `git worktree add` creates.

1. Prepare (inside the shared-tree mutex, see below).
   - Base: a commit object of the shared tree's current content: tracked
     changes, deletions, and untracked non-ignored files; ignored files
     excluded. Built with a temporary index (`GIT_INDEX_FILE=<tmp>`:
     `read-tree HEAD` or empty for an unborn branch, `add -A`, `write-tree`,
     `commit-tree -p HEAD`).
   - Lane: `git worktree add --detach <stateDir>/lanes/<laneId> <base>`, where
     `stateDir` is the directory of `CODEX_A2A_STATE_DB` and `laneId` is a
     filesystem-safe form of the attempt id.
   - Environment links: for each name in `CODEX_A2A_LANE_LINKS` (default
     `.venv,venv,node_modules`) that exists in the shared tree and is ignored
     there, create a symlink in the lane pointing to the shared copy. Linked
     names are excluded by pathspec from every later git command on the lane,
     because a symlink does not match a `dir/` ignore pattern. The shared repo's
     `info/exclude` is never edited.
   - Durable row in `writer_lanes` (below), state `prepared`.
2. Turn. `appServer.run` with `cwd` = lane path and the role's sandbox
   (`workspaceWrite`, no extra `writableRoots`), so the turn can write only the
   lane and temp dirs. The worker input gets one leading line: the lane path,
   that paths are relative to it, and that the server integrates the changes.
   No admission is held during the turn. Lane state `running`.
3. Collect, only after a terminal turn (known outcome). Patch = diff of the
   lane content against the base, computed with a temporary index seeded from
   the base tree (`add -A` with the link exclusions, then
   `diff --cached --binary <base>` and `--name-status -z`). Lane state
   `collected`.
   Unknown outcome: no collect, no integration. Lane state `not_integrated`,
   reason `outcome_unknown`, lane kept.
4. Scope gate. Every changed path is checked with the existing
   `pathsOutsideAllowed` against the attempt's `allowedFiles`. Any violation
   refuses the whole patch: nothing is applied, lane kept, reason
   `scope_violation`, and `settle.attested_scope` is FAIL with the attempted
   paths (server-computed, so attested). An empty patch skips integration,
   reason `no_changes`.
5. Integrate (inside the shared-tree mutex).
   `admission.acquire` on the shared workspace with the attempt's context id
   and role (durable `writer_executions` row, `snapshot_before`), then
   `git apply --check --binary`, then `git apply --binary` (working tree only),
   then `admission.release` (`snapshot_after`, attested `delta`). The
   integration row never records a turn start, so after a crash mid-apply the
   existing restart path finds it quiescent and reconciles it with the actual
   delta (a partially applied patch is reported like any unknown writer
   effect). If `--check` fails: release with no changes, reason
   `integration_conflict` with the conflicting paths, lane kept.
   On success the lane is removed (`git worktree remove --force`) and the row
   becomes `integrated`.
6. Result. The attempt's `writerExecution` metadata keeps today's shape
   (`executionId`, `state`, `delta`, `reason`) plus `lane: { id, path, base,
   state, reason, conflicts?, attemptedPaths? }`. Non-integrated outcomes use
   `effects: 'none'`, so `isSettledWriter` treats them as settled and they never
   block dispatch. Worker-reported paths under the lane prefix are rewritten to
   workspace-relative before `settle.reported_scope`.

Shared-tree mutex: an in-process async mutex serializes base preparation and
integration, so a base never captures a half-applied patch. Admission is taken
inside it; acceptance takes admission without it (acceptance runs at finish,
when no lanes are active). One server per workspace is already enforced by the
workspace lock, so an in-process mutex is sufficient.

## Lanes table

```sql
CREATE TABLE IF NOT EXISTS writer_lanes (
  lane_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  task_id TEXT,
  workspace TEXT NOT NULL,
  path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL,      -- prepared | running | collected | integrated | not_integrated | orphaned | removed
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Startup: `git worktree prune` on the shared repo; rows of this workspace in
`prepared`, `running`, or `collected` become `orphaned` (their tasks are already
failed `interrupted` by `reconcileInterruptedTasks`). Kept lanes (orphaned,
not_integrated) are removed at startup once older than
`CODEX_A2A_LANE_RETENTION_HOURS` (default 72).

## Groups (waves) in a lead decision

New assignment field `wave`: integer >= 1 or null. The decision schema stays
strict: the field is required with type `["integer", "null"]`, and it is added
to the assignment key lists and to the keys a specialist accepts.

- Execution groups are maximal runs of consecutive assignments (array order)
  sharing the same non-null `wave`. A null `wave` is a group of one. Groups run
  in array order; the members of a group run concurrently.
- An all-read-only batch keeps today's behavior: everything runs in parallel.
- Within one group, writable assignments must have pairwise disjoint
  `allowedFiles` (no equal path, no path prefix of another, `.` overlaps
  everything). Violation: predicate `assignment.wave`, code
  `wave_scope_overlap`, fed back to the lead like other rejections.
- The next group starts only after every item of the current group finished and
  no writer of it is unsettled (the existing skip rule, applied per group).
- In `shared` isolation mode a group with more than one writer runs its writers
  serially in array order; the prompt tells the lead parallel writers are off.
- Prompt and TEAM.md text: same-wave writers each work in an isolated copy from
  the same starting state and do not see each other's changes; changes are
  integrated when each finishes; later groups (for example a verifier) see the
  integrated result; overlapping files across same-wave writers are refused;
  conflicts and refused patches come back as outcomes with the lane path.

## Known limits

- Sandbox confinement of a lane turn to its cwd is taken from the App Server
  protocol (`workspaceWrite` = cwd plus `writableRoots` plus temp dirs) and must
  be confirmed by a live turn before the default is switched on for the owner.
- Git commands that write the lane's index from inside the sandbox fail (the
  lane's admin dir is in the shared `.git`); workers are not supposed to change
  git state anyway.
- Python editable installs resolve imports to the shared tree outside pytest;
  pytest with `pythonpath = ["src"]` imports the lane's code.
- A turn timeout terminates the shared App Server and with it every concurrent
  turn: those lanes end `not_integrated`. Work is lost, the shared tree is safe.
- Each lane is a full checkout of tracked and untracked files (about 9 MB for
  the current target project).

## Tasks

- PW-1 `src/writer-worktree.js`: git mechanics only (base, lane add/remove,
  links, collect patch, check/apply, prune), tested on temporary repositories.
- PW-2 waves: schema field, validation, group dispatch in `src/lead-graph.js`,
  prompt and RULE_REMINDERS, tests.
- PW-3 lane execution in `src/a2a-role-service.js` (prepare, turn in lane,
  collect, scope gate, integrate under admission, result metadata, report path
  mapping), `writer_lanes` store, startup recovery and retention, server wiring,
  mode switch and fallback, tests. Depends on PW-1.
- After PW-3: update `docs/execution-boundary-contract.md` and
  `docs/hardening-spec.md` (admission now guards integration), README, TEAM.md.
