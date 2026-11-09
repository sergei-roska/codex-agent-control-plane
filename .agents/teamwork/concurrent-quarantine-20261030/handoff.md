# Handoff

Status: M1-only eligibility refinement and the accumulated working-tree changes
were committed as `5fc60b4` at the user's request. No tests were run for the
commit request; pre-commit `git diff --cached --check` passed. The untracked
SQLite artifact `:memory:.lockdb` was left out. The M2 boot/wiring candidate is
present but frozen, unreviewed, and not accepted.

Historical runtime facts: launcher project `3d9c2e759c` was stopped with
`concurrent_startup_recovery_unsafe`; persisted phase was `draining`, with one
active planner turn and a gone local process group. No live server restart,
provider activity, or live DB mutation occurred during this work.

M1 root verification: `node --test test/server-delivery-engine.test.js`
(79 passed), `node --check src/server.js`,
`node --check test/server-delivery-engine.test.js`, and `git diff --check`
passed. Critic approved the paused/orphan refinement; challenger found no
counterexample. Existing ordinary routing regression confirms `paused_owner`
still returns busy outside quarantine.

The user selected an M1-only refinement. The exact state now classifies as
read-only `quarantine` on an isolated backup while the active planner row stays
active and uncertain. Quarantine is diagnostics eligibility only; normal legacy
task service remains unavailable under current routing, and this predicate
does not authorize a resume or task admission. Do not change the planner turn to
no-effect or replay it without trusted remote terminal proof. The `m2-brief.md`
remains historical design input, not current implementation scope.

Read-only evidence from the source `.runtime/projects/3d9c2e759c/state.sqlite`
was obtained through a disposable SQLite backup under `/tmp/opencode`; the
source was opened `readonly`, and the scratch copy was removed. A schema/row
snapshot on the copy was unchanged by the predicate. After the M1 refinement,
classification is `quarantine`. Summary: phase `draining`, empty attempts/identities;
8 concurrent mappings and 1 legacy; planner states active=1, complete=5,
reconciled_no_effect=4. All tasks were terminal or input_required (none
submitted/working); backlog/task-executor attempts, claims, role executions,
candidate/publication, writers, and dispatch evidence passed the project-wide
settlement checks; task-executor reservations were empty.

The canonical objective JSON omits `ownerGeneration`; `BacklogStore.getObjective()`
overlays the SQL `owner_generation`, and the predicate now requires SQL, pins,
and planner fact identity to agree while rejecting a conflicting optional JSON
field. The four paused-owner mappings are accepted only when run/objective/session,
planner, task state, and project-wide effects are settled. The orphan is accepted
only when request-derived IDs, the unique failed task, exact planner/fact/thread-read
proof, gone process group, and zero dispatch/effect rows bind. Hostile production-
schema regressions reject mismatched IDs/proofs, active tasks across owners,
dispatch rows, and unsettled effects. No live server/provider call or live DB
write was made.

An M2 candidate is present in root but frozen/unreviewed; do not extend it.
Current work is limited to M1 read-only eligibility and regressions. The
refinement accounts for the actual paused and terminal-orphan records only
under the proof gates in `predicate-brief.md`. It does not enable ordinary
startup or mutate the active planner turn. The full server-delivery-engine test
file passed locally after refinement; M2 remains unreviewed and unaccepted.

## Latest GET-only launcher diagnosis (2026-10-30)

The user reported that the launcher is open and the "Submit answer and
continue" button does not start Harness work. Read-only requests to
`http://127.0.0.1:8081` confirmed:

- `GET /api/projects/3d9c2e759c/status` reports `status: running`, PID
  `1545478`, port `3002`, and startup diagnostic `listening/started`.
- Authenticated `GET http://127.0.0.1:3002/control/quarantine` reports
  `state: quarantined`, reason `concurrent_startup_recovery_unsafe`;
  `GET /orchestrator/agent-card.json` returns 404. Source in `src/server.js`
  installs middleware returning 503 `concurrent_startup_quarantined` for all
  methods other than GET/HEAD. The launcher currently sets `running` from the
  generic stdout marker in `src/launcher-projects.js`, which the quarantine
  stub also emits. Therefore `running` here does not mean task-ready.
- The requested session GET reports one turn in
  `TASK_STATE_INPUT_REQUIRED`; its pause is `stopped`, with no decision ID,
  question, or options. The task detail GET agrees. The situation GET reports
  `phase: paused`, `pauseKind: stopped`, and zero open decisions.
- `GET /ui/app.js` has the same SHA-256 as the working-tree asset
  (`c787e99ff172248db1949429018214eb9650402033acb2269788e9a2aaf5a193`).

No decision-button click, task-send POST, provider request, restart, or live DB
write was made. The quarantine response to a POST is determined by the installed
middleware but was deliberately not exercised. The user subsequently authorized
a fail-closed launcher/UI source fix; its implementation and verification are
recorded below. Do not lift quarantine or resume/replay the unresolved planner
turn; ordinary recovery still requires trusted remote terminal proof. M2 remains
frozen, unreviewed, and unaccepted.

## Readiness guard implementation

Implemented locally, not loaded into the live launcher:

- `src/launcher-projects.js` now reports process lifecycle separately from
  `readiness`/`taskReady`. It identifies an authenticated quarantine response,
  treats a missing A2A card as not task-ready, and keeps a responding process
  manageable rather than treating its listen banner as task readiness.
- `src/launcher-app.js` returns readiness in the status API and rejects task
  sends with 503 `project_not_task_ready` before creating the A2A client unless
  the project is task-ready.
- `launcher-ui/app.js`, `launcher-ui/index.html`, and `launcher-ui/styles.css`
  label quarantine/not-ready distinctly, disable task actions until readiness,
  hide decision cards for `pause.kind === 'stopped'`, and require explicit
  answer/choice input rather than defaulting an empty answer to `Approved`.
- Regression coverage added/updated in `test/launcher-projects.test.js`,
  `test/launcher-app.test.js`, `test/launcher-decision-ui.test.js`, and
  `test/launcher-startup.test.js`.

Verification: `node --test test/launcher-projects.test.js test/launcher-app.test.js test/launcher-decision-ui.test.js test/launcher-startup.test.js`
(100 passed); changed-file `node --check` and targeted `git diff --check` passed.
Full `npm test` produced 2060 passed, 1 skipped, and one unrelated failure in
the inherited untracked `test/lead-planner.test.js:176`; isolated rerun reproduces
the same expected-vs-actual `providerFailure` metadata mismatch. The root source
change is not active until an authorized launcher restart. No launcher/project
restart, live request, provider work, or live DB mutation was made.

Commit `5fc60b4` contains 136 files (47,983 insertions, 457 deletions). The only
remaining untracked path is `:memory:.lockdb`, a SQLite runtime artifact that was
not committed. The isolated M1 worktree
`/home/sr/.local/share/opencode/worktree/69c4bd/concurrent-quarantine-predicate`
is review evidence only.

## Read-only engine startup diagnosis (2026-10-30)

No implementation or runtime mutation was performed for this diagnosis.

- Live launcher GETs to port 8081 report project `3d9c2e759c` at
  `/home/sr/Projects/Workspace/agent-harness`, port 3001, PID 1738369,
  `status=running`, `readiness=ready`, and `taskReady=true`. The engine endpoint
  reports `deliveryEngine=legacy`, `running=true`, `stopped=false`; the A2A
  agent-card GET returns 200. Launcher PID 1712226 listens on 8081.
- `.runtime/projects/3d9c2e759c/project-settings.json` currently selects
  `legacy` with `executionPermissions=full-access`. It was updated at
  2026-10-30T15:19:57Z; registry `lastUsedAt` is 15:19:59Z and
  `last-startup.json` records a successful `started/listening` at 15:20:00Z
  with no stderr. Current status logs contain only the successful Legacy start.
  The retained earlier concurrent failure is not available in logs. The
  launcher process started at 17:13 local and current child at 17:19 local.
- `launcher-ui/roles.html` labels the control "Delivery engine for new runs".
  `launcher-ui/roles.js` loads the setting from GET and disables selection/save
  unless `stopped === true`; Save sends PUT `/api/projects/:id/delivery-engine`.
  The PUT route also rejects unless the project is stopped and writes
  `project-settings.json`. The dashboard Start button POSTs `/start`; the
  launcher spawns `server-bootstrap.js` with the project settings path. The
  server reads the engine once at startup; existing runs retain their stored
  engine mapping. Served `roles.js` and `app.js` SHA-256 hashes match the current
  working-tree assets.
- The current registry points to `.runtime/state.sqlite`. Read-only SQLite
  inspection found one `legacy` engine mapping, no concurrent run rows, no
  concurrent shutdown phase, and no `delivery_planner_turns` table. The separate
  older `.runtime/projects/3d9c2e759c/state.sqlite` has one `legacy` and eight
  `concurrent-v1` mappings, a `draining` shutdown phase with empty attempt and
  process-identity arrays, and planner states active=1, complete=5,
  reconciled_no_effect=4. Do not switch the registry to this DB or replay its
  unresolved active planner turn without trusted remote terminal proof.
- Source confirms startup inspects the configured DB read-only before provider
  startup. A `draining` state is only admitted through the narrow M1 predicate;
  the exact old DB state classifies as quarantine. Quarantine serves only GET/
  HEAD and intentionally has no task A2A card. Concurrent mode also requires
  `worktree` or `cooperative` lane isolation. The current full-access setting is
  not by itself a blocker: source supports owner full-access cooperative mode,
  and the current Legacy server already starts with that setting. Current
  settings, DB schema, and role overrides show no other statically evident
  blocker, but this does not prove a fresh concurrent startup will succeed.
- Available logs were checked: current status API logs, `last-startup.json`, and
  `.runtime` log files. `.runtime/local-autonomy/launcher.log` contains only
  older MCP OAuth transport errors (2026-10-28), unrelated to project startup;
  `.runtime/launcher-port-8081.log` is empty. No tests or provider calls were
  made during that diagnosis. Its conclusion that the current error was unknown
  is superseded by the following user-triggered startup diagnostic.

## Latest user-triggered Concurrent startup failure (2026-10-30)

- The user reloaded the launcher and saved `concurrent-v1`. The project setting
  is now `concurrent-v1`, updated 2026-10-30T15:31:00Z. Launcher PID 1776703
  listens on 8081. Project startup at 15:31:58Z failed; current project status
  is stopped, PID null, readiness stopped, taskReady false. `last-startup.json`
  reports `outcome=failed`, `stage=server_startup`, exit code 1,
  `stderr="no such column: project_id"`. In-memory status logs contain the
  same error. Port 3001 is no longer listening.
- The active registry DB is `/home/sr/Projects/Workspace/codex-agent-control-plane/.runtime/state.sqlite`.
  Its `candidates` table is the legacy shape:
  `candidate_id,run_id,plan_revision_id,base_commit,head,branch,head_moved,
  manifest_json,diff_artifact_id,truncated,acceptance_json,integrity_hash,created_at`;
  it has no `project_id`, `objective_id`, or `integration_generation`.
- Exact source collision: `src/concurrent-delivery-engine.js:197-211` constructs
  `CandidateStore`; `src/candidate-store.js:185-196` runs
  `CREATE TABLE IF NOT EXISTS candidates` with the new delivery schema, then
  creates `candidates_generation_idx` on `(project_id, objective_id,
  integration_generation)`. `IF NOT EXISTS` does not transform the existing
  legacy table, so SQLite raises the observed `no such column: project_id` at
  index creation. `server-bootstrap.js:58-60` prints only `error.message`, so
  the retained log has no stack.
- This failure is distinct from the older project-specific DB quarantine: the
  current registry uses root `.runtime/state.sqlite`, whose shutdown phase was
  absent; the old `.runtime/projects/3d9c2e759c/state.sqlite` still contains the
  draining phase and unresolved active planner turn. Do not switch back to that
  DB or attempt recovery/replay. Preserve the legacy `candidates` data.
- Read-only confirmation: DB candidate table SQL/columns were inspected through
  SQLite `mode=ro`; no source edits, tests, task POSTs, or second startup attempt
  occurred. The failed user-triggered startup may have attempted earlier startup
  DDL; no claim of a full before/after DB snapshot is made. Next safe work is to
  design a backward-compatible concurrent candidate table/schema separation or
  explicit migration preserving legacy candidates, then verify on a disposable
  copy before any authorized retry.

## Candidate-table namespace review (2026-10-30)

- Read-only inspection confirms the older project DB's `candidates` table has
  the concurrent schema and eight rows; the active root DB's `candidates` table
  has the Legacy schema and zero rows. `candidate_snapshots` has the same
  digest/manifest/timestamp shape in both DBs. Do not modify either DB during
  this review.
- Recommendation: namespace all engine-private tables consistently. The
  user's `candidates_concurrent` suffix is suitable; `concurrent_candidates`
  prefix is another option, but choose one convention. Keep genuinely shared
  tables (engine routing, task journal, writer admission/lanes) shared.
- A table rename alone is insufficient: concurrent SQL also refers to
  `candidates` in `backlog-store.js`, `concurrent-delivery-engine.js`, and
  `delivery-role-service.js`. Route these through a centralized schema/table
  mapping or repository. The old Concurrent DB needs a verified compatibility
  migration preserving its eight candidate records; the active Legacy DB must
  retain its existing `candidates` table untouched. Validate migration on
  disposable copies before any authorized live retry.

## Concurrent candidate table namespace implementation (2026-10-30)

- Implemented `concurrent_candidates` as the Concurrent-owned candidate record
  table through `src/concurrent-table-names.js`; updated CandidateStore,
  BacklogStore, ConcurrentDeliveryEngine and DeliveryRoleService SQL references.
  Legacy `candidates` remains untouched. Existing unprefixed tables matching
  the full Concurrent candidate shape are transactionally renamed to
  `concurrent_candidates`; a conflicting dual schema fails closed.
- Added two full startup scenarios in `test/server-delivery-engine.test.js`:
  Legacy starts/routes a run while preserving the legacy schema; Concurrent
  starts beside that legacy schema, writes a candidate only to
  `concurrent_candidates`, and leaves the legacy row intact. Added CandidateStore
  tests for legacy coexistence and preservation of an existing Concurrent-shaped
  table during rename. Updated direct candidate queries in affected tests.
- Verification: `node --test test/candidate-store.test.js
  test/server-delivery-engine.test.js test/concurrent-delivery-engine.test.js
  test/backlog-store.test.js` — 212 passed, 0 failed, 58.3s. `git diff --check`
  passed. Full `npm test` not run.
- No runtime DB or live project process was touched. Current project remains
  stopped with `concurrent-v1` selected; do not restart without authorization.
  The older per-project DB still has the unresolved planner turn and remains
  quarantined. Source changes are uncommitted.
