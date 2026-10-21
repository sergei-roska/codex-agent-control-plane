# Execution boundary contract (DBC-01)

October 20 execution extension: trusted projects default to native Codex
permission inheritance for writable roles and agent-origin final checks.
Contract source, pins, writer admission, and snapshot gates remain enforced.
The read-only-workspace/no-network check policy below describes `strict` mode;
see [execution-permissions.md](execution-permissions.md) for current selection.

Status: Phase A record frozen as `boundary-contract/v1`; historical facts below
were verified at `db61957`. The additive selective-review extension dated
2026-10-12 reopens related runtime qualification without changing
`worker-report/v1`. Its focused/full-suite and independent review evidence is
recorded in `docs/auditor-routing-plan.md`.

## Purpose and limits

The runtime already has deterministic checks at dispatch, settlement, and
acceptance (inventory below). This contract gives them stable identities, a
uniform result model, and a failure policy, and closes four gaps:

1. A failed lead-decision predicate throws out of the `decide` node
   (`src/contracts.js:296-298` via `src/lead-graph.js:492`); nothing catches it
   until `src/server.js:397-422`, which pauses the run with an error. The lead is
   never told what was wrong, the failed turn's `threadId` is lost
   (`src/lead-graph.js:443`, `:476`), and a human retry re-samples blind.
2. Direct `/agents/<role>` requests skip every assignment predicate, and the
   executor labels any Codex-completed result `contract: worker-report/v1`
   without validating it (`src/a2a-role-service.js:402`).
3. Acceptance hides a failed check behind `unverifiable` when the snapshot is
   unavailable (`src/acceptance.js:172`), and a restart silently drops an invalid
   stored acceptance contract (`src/server.js:341`).
4. No contract version is pinned per attempt; `state.pinned` is overwritten on
   every intake and resume (`src/lead-graph.js:433`, `:449`).

Not claimed: per-tool prevention (assignment-level checks constrain what is
dispatched and what is accepted, not each tool call inside a turn), proof of
agent correctness, or safety of effects the snapshot cannot see (see "Snapshot
limits").

## Selective review extension, 2026-10-12

Policy `auditor-routing/v1` adds bounded nullable assignment review context and
bounded decision `records`. Legacy values remain readable; absent old review
metadata does not prove current-target coverage. Semantic risk classification
belongs to the lead. The runtime evaluates declared obligations and never
evaluates a model-authored predicate expression.

| Registry ID | Codes |
| --- | --- |
| `assignment.review` | `review_context_invalid`, `review_context_missing`, `review_wave_conflict` |
| `decision.records` | `records_invalid` |
| `decision.review_gate` | `review_receipt_missing`, `review_checkpoint_pending`, `review_context_mismatch`, `verifier_receipt_missing` |
| `review.continuation` | `review_origin_unknown`, `review_origin_stale` |
| `review.concurrent_writer` | `review_writer_unsettled` |
| `review.reservation` | `review_reservation_unavailable` |
| `review.target` | `review_target_unknown` |

Declarations cannot downgrade an existing checkpoint. Required verifier/auditor
receipts bind scoped content and check/requirement context. Critical audit and
read-only pinned-check review reserve the workspace against managed writers
without receiving filesystem write authority. Unknown/stale receipts and failed
durable recording cannot authorize acceptance, including alternate finish paths.
Full metadata, cleanup, mutation exception, and record semantics are frozen in
`docs/auditor-routing-contract.md`.

## Result model

Each predicate evaluation yields one result:

| Result | Meaning |
| --- | --- |
| `PASS` | Evaluated on its authoritative source and holds. |
| `FAIL` | Evaluated and violated. |
| `UNKNOWN` | The authoritative source is unavailable (snapshot unavailable, delta unknown, writer unsettled, evidence missing). |
| `ERROR` | The evaluator itself failed (unexpected exception). |

A predicate that does not apply (for example a report check on a task that did
not complete) records nothing.

Policy:

- Safety-critical predicates fail closed: `UNKNOWN` and `ERROR` never certify.
  At acceptance, any safety-critical `FAIL` gives `rejected`; otherwise any
  safety-critical `UNKNOWN` or `ERROR` gives `unverifiable`; otherwise
  `accepted`. FAIL wins over UNKNOWN, so a failed check is never hidden.
- Advisory predicates are recorded and shown, and never change a disposition.
- A violation record is
  `{ predicate, result, code, boundary, detail, evidence, advisory }`:
  `predicate` is the registry id, `code` is a stable snake_case string,
  `boundary` is `dispatch`, `settlement`, or `acceptance`, `detail` is at most
  500 chars, `evidence` is a list of evidence refs
  (`docs/evidence-artifact-contract.md`) or source pointers such as
  `writer_executions:<executionId>`, and `advisory` is true only for advisory
  predicates. Records are kept for `FAIL`, `UNKNOWN`, and `ERROR` results only.

## Predicate registry

Predicates are code in a fixed registry. No model-provided expression is ever
evaluated. Ids and codes are part of the contract.

### Dispatch, lead-managed (evaluated in `decide`, before any side effect)

| Id | Codes | Source | Safety |
| --- | --- | --- | --- |
| `decision.parse` | `decision_empty`, `decision_not_json`, `decision_not_object` | lead turn text (`src/lead-graph.js:527-535`) | gate |
| `decision.envelope` | `decision_envelope_invalid`, `assignment_count_invalid` | decision JSON (`src/contracts.js:338-385`) | gate |
| `decision.resolutions` | `decision_unresolved` | checkpoint `openDecisions` | gate |
| `assignment.shape` | `assignment_shape_invalid`, `role_unknown`, `field_invalid` | decision JSON, role map (`src/contracts.js:260-279`, `:291-301`) | gate |
| `assignment.writer_scope` | `writer_scope_missing` | role profile sandbox (`src/contracts.js:293-295`) | safety-critical |
| `assignment.paths` | `path_unsafe`, `path_glob_unsupported` | decision JSON (`src/contracts.js:151-156`, `:296-298`) | safety-critical |
| `assignment.skills` | `skill_invalid` | catalog and candidate ids (`src/contracts.js:280-290`) | gate |
| `assignment.role_ladder` | `role_ladder_violation`, `architect_constraint` | `state.attemptedRoles`, outcome count (`src/contracts.js:302-315`) | gate |
| `dispatch.writer_unresolved` | `writer_unresolved` | `state.unresolvedWriters` (`src/contracts.js:375-378`) | safety-critical |
| `assignment.wave` | `wave_scope_overlap`, `wave_invalid` | decision JSON (PW-2) | safety-critical |
| `assignment.continue_from` | `continue_from_unknown`, `continue_from_role`, `continue_from_duplicate` | finished outcomes of the run (LL-5) | gate |
| `decision.goal` | `goal_unstated` | decision JSON: `finish` needs `goalAchieved` true or false (LL-1) | gate |
| `decision.acceptance_checks` | proposal refusals (vacuous or unsafe argv, invalid check) | decision JSON, `validateAgentChecks` in `src/acceptance.js` (LL-4) | safety-critical |
| `decision.investigate_first` | `investigation_missing` | `request_human_input` (owner-only reasons: `paid_resources`, `credentials_or_access`, `external_write`, `irreversible_operation`, `prd_requirement_change`) or a repeated unmet-goal finish must cite a read-only investigation finished after the blocker appeared (LL-6) | gate |

Lead loop fixes ([design](lead-loop-fixes-design.md)): `finish` with
`goalAchieved: false` requires investigation before an owner decision. LL-8
(2026-10-12) removes the default dispatch-round limit. Only an explicitly
configured positive `maxRounds` can cause a `round_limit` pause. A repeated-work
warning followed by an unchanged recurrence produces a bounded technical partial
result. Invalid lead decisions retain two same-thread correction turns, then get
one fresh planning context with bounded validation evidence and the current
run, owner, and review context; another invalid decision produces a technical
partial result. Both technical stops run acceptance once and do not request
owner continuation. A later `goalAchieved: false` after required investigation
also produces a technical partial ledger rather than implying owner
responsibility. Genuine owner decisions use typed `request_human_input` with a
closed owner-only reason. These technical results never satisfy an acceptance or
review gate themselves. Worker decision requests with a
recommendation outside the option ids, and over-long report strings, are normalized
(`report.normalizations`) instead of invalidating the report.

Path rules: `allowedFiles` entries are repository-relative paths or directory
prefixes. Scope matching supports only exact paths and directory prefixes
(`src/lead-graph.js:219-226`), so entries containing `*`, `?`, or `[` fail with
`path_glob_unsupported`. For read-only roles, the entries `.` and `./` are
normalized away before validation (an empty list is already legal for
read-only roles, `src/contracts.js:293`); for writable roles they still fail
with `path_unsafe`, because a dot must never grant whole-repository write scope.

### Dispatch, executor (both paths)

| Id | Codes | Source | Safety |
| --- | --- | --- | --- |
| `dispatch.skill_pins` | `skill_pin_drift` | skill files on disk vs pins (`src/lead-graph.js:566`, `:657`; `src/codex-app-server.js:31-60`) | safety-critical |
| `dispatch.writer_admission` | `fenced`, `admission_blocked` | SQLite `writer_executions`, `writer_fences` (`src/writer-admission.js:121-189`) | safety-critical |
| `dispatch.request_input` | `request_invalid`, `guarantee_unavailable` | A2A message (`src/a2a-role-service.js:28-78`) | gate |

### Settlement (evaluated in `verify` / `reconcile`)

| Id | Codes | Source | Safety |
| --- | --- | --- | --- |
| `settle.report_valid` | `report_invalid` | worker text (`src/contracts.js:190-258`) | safety-critical for writers, advisory for read-only roles |
| `settle.reported_scope` | `reported_scope_violation` | `report.filesChanged` (self-reported) | safety-critical for writers, advisory for read-only roles |
| `settle.attested_scope` | `attested_scope_violation`, `delta_unknown` | git delta (`src/workspace-snapshot.js:366-399`) | safety-critical |
| `settle.writer_settled` | `writer_unresolved` | `writer_executions.state` (`src/lead-graph.js:235-238`, `:808-873`) | safety-critical |
| `settle.report_outcome` | `writer_reported_failure` | `report.outcome` of a writer (`failed`, `blocked`) | advisory |
| `settle.lane_scope` | `lane_scope_refused` | server-computed lane patch paths (`src/writer-lanes.js`) | fails the attempt only; not aggregated by `accept.writers` |

Worktree mode (2026-10-10, [parallel writers design](parallel-writers-design.md)): a
writer that ran in a lane and was never integrated has no `writer_executions` row and
`effects: "none"`; `settle.writer_settled` treats it as settled, `settle.attested_scope`
is PASS (nothing reached the shared tree), and `settle.reported_scope` is advisory. A
lane whose patch was applied (or whose integration acquired admission) is attested by
the integration row's delta exactly like a shared-mode writer.

`settle.report_outcome` is advisory on purpose: writers are collected across
rounds, and a later attempt may repair an earlier failed one, so a self-report
cannot gate acceptance. The authoritative signals are the checks and the delta.

`settle.reported_scope` gates acceptance for writers, as `docs/hardening-spec.md`
section 3 requires ("no reported scope violation"): the snapshot cannot see
ignored files, write-then-restore, or writes outside the tree, so a writer's own
report of an out-of-scope change is the only signal for those cases. (Corrected
2026-10-05 after the M1 audit; the first frozen version marked it advisory.)

### Acceptance (evaluated in `assess`)

| Id | Codes | Source | Safety |
| --- | --- | --- | --- |
| `accept.contract_valid` | `contract_invalid` | pinned acceptance contract (`src/acceptance.js:16-56`) | safety-critical (UNKNOWN: the required checks cannot be known) |
| `accept.checks` | `check_missing`, `check_failed`, `check_error`, `check_changed` | host runs for owner checks; Codex sandbox runs (`command/exec`, read-only workspace, no network) for agent-proposed checks. `check_error` (UNKNOWN): the sandbox was unavailable or failed. `check_changed` (UNKNOWN): a workspace script named in a pinned agent check changed after pinning; an independent auditor reviews it (preserve: re-pin; weaken: `check_weakened`, FAIL); only a required PRD change reaches the owner (LL-6) | safety-critical |
| `accept.snapshot` | `snapshot_unavailable` | `takeSnapshot` (`src/workspace-snapshot.js:345-363`) | safety-critical (UNKNOWN) |
| `accept.candidate_stable` | `candidate_changed` | fingerprints around checks (`src/acceptance.js:165-170`) | safety-critical |
| `accept.writers` | aggregates `settle.writer_settled`, `settle.attested_scope`, `settle.report_valid` over all writers of the run | outcomes | safety-critical |
| `accept.run` | `acceptance_canceled`, `acceptance_error`, `acceptance_not_run` | lead graph (`src/lead-graph.js:950-989`) | safety-critical (UNKNOWN) |

#### Opt-in acceptance scratch directory (owner-side)

Strict agent checks run with no writable root, /tmp writable, no
network. A project owner can opt a project in to a per-run scratch directory in
`<runtime>/projects/<id>/project-settings.json` (read once at server start; the
launcher passes the path as `CODEX_A2A_PROJECT_SETTINGS`):

```json
{ "version": 1, "acceptanceScratch": { "env": ["TEAMWORK_TEST_SCRATCH_ROOT"], "baseDir": "/var/tmp/cp-acceptance-scratch" } }
```

- `env`: up to 8 extra variable names (`^[A-Z_][A-Z0-9_]*$`, reserved names such
  as PATH, HOME, TMPDIR and the LD_/PYTHON/NODE_/GIT_/CODEX_ families refused)
  that receive the scratch path. `baseDir` is optional (absolute); the default is
  `<runtime>/projects/<id>/acceptance-scratch`, which lies under the owner's
  home and is rejected by checks that treat home as protected, so set it
  elsewhere in that case.
- Each acceptance run creates `<baseDir>/run-XXXXXX` (0700, real path, outside
  the workspace and /tmp) as the only writable root: `writableRoots: [run]`,
  `excludeSlashTmp: true`, `excludeTmpdirEnvVar: true`, `networkAccess: false`.
  Its sibling subdirectories `tmp/` (TMPDIR) and `scratch/` (each configured
  variable) never nest. Variables travel in the `env` field of `command/exec`.
- The directory is removed after the run, also after failure, timeout, cancel
  and errors. A failed removal is recorded (`acceptance.scratch`, advisory issue
  `scratch_cleanup_failed`) and never changes the disposition. If the directory
  cannot be created the run is `acceptance_error` (UNKNOWN), never a run without it.
- Disabled by default: policy and request are unchanged. Only the owner file
  enables it; contracts and check proposals reject unknown fields. Owner
  (`runCheck`) checks are unaffected.

#### Default owner checks per project (owner-side)

The same settings file can declare default owner checks, so the owner sets them
once instead of per task. Like `acceptanceScratch`, the file is read once at
server start: restart the project to apply a change.

```json
{ "version": 1, "ownerChecks": ["uv run pytest -q", "node --check src/server.js"] }
```

- `ownerChecks`: 1 to 8 command strings, each split on whitespace into argv (no
  shell) exactly like a CLI `--check`. Absent, `null`, or `[]` disables the
  default. A non-array, a non-string or blank entry, more than 8 entries, or a
  command the owner contract refuses makes the whole file invalid (ignored with a
  warning, so nothing is enabled).
- Owner checks run on the host outside the Codex sandbox, so they can use
  loopback sockets and the network; agent-proposed checks stay sandboxed.
- When a new run starts and its message carries no acceptance contract
  (`metadata.acceptance` absent or null), the server pins an owner contract
  (no `source`) built from `ownerChecks` through the same validation and durable
  pinning path as a CLI `--check` contract (`src/server.js`, `makeLeadExecutor`).
  The launcher UI, the CLI, and the launcher API all get it. Follow-up runs
  (`referenceTaskIds` / `continueFrom`) are new runs and get the defaults too.
- Explicit checks (`--check`, the `checks` field of `/task/send`, or
  `metadata.acceptance`) replace the defaults and are never merged with them. An
  explicit empty `requiredChecks` is kept as a choice of no checks.
- A resume never repins: the contract pinned when the run started stays.
  Agent-proposed checks are ignored while an owner contract is pinned, and an
  agent check is never upgraded to an owner check.

`contract_invalid` replaces the silent drop at `src/server.js:341`: a stored
contract that fails validation on restart yields `unverifiable` with that code;
the run never continues as if no checks were required.

#### Verification capability preflight

Before each lead planning turn, a bounded local preflight reports whether each
pinned check's local execution interface or `argv[0]` executable is observable.
It performs filesystem and PATH lookups only: it does not run project commands,
install packages, probe sockets, contact external CI, or check test dependencies.
Agent checks require the App Server `execCommand` interface and the already
configured resolved policy; they never fall back to host execution. Policy or
executable availability is reported as capability only, not a test result,
review receipt, or complete evidence. Candidate changes keep the route identity
when project, policy setting/resolution, source, and command arguments are the
same, while acceptance and review evidence remain fresh for each candidate.
Executable checks refresh before planning. Native policy reads are bounded and
briefly cached for the App Server generation, account, project, and setting;
strict sandbox policy is a supported restricted route. An unavailable
executable is an internal environment repair task; it does not create an owner
pause.

External CI is unsupported by this route. It is neither selected nor queried,
and CI access, external writes, credentials, or new spending still need the
owner's decision where applicable.

Owner answers are retained as bounded, versioned context containing the question,
reason, explicit selected option and description, related evidence, round, and
answer. Legacy answer records remain readable. Digests preserve recent context
across thread rollover and follow-up runs as historical guidance only; changed
goals and new spending, access, credentials, or external writes are never
automatically authorized by an earlier answer.

Disposition mapping is unchanged except for the FAIL-over-UNKNOWN rule above:
`not_required` and `unverified` keep their meaning when no checks are required
(`src/acceptance.js:247-266`).

## Dispatch rejection (lead-managed)

A `FAIL` of any lead-managed dispatch predicate is a rejected decision, not a
run error:

1. Nothing is submitted, journaled, or admitted for the rejected decision.
2. The failed turn's `threadId` and its usage row are kept.
3. The graph records `{ round, at, violations }` in `state.rejections` (last five
   kept) and returns to `decide`. The next lead prompt contains a "Rejected
   decision" section listing each violation's predicate, code, and detail, and a
   short rule reminder for the failed predicate.
4. At most two consecutive rejections are retried automatically. A third
   consecutive rejection pauses the run as today (`kind: 'error'`), and the pause
   message names the violation codes. Any accepted decision resets the counter,
   and so does any resume of the run (human answer, restart, or budget resume).
5. Rejections are not outcomes: they do not count toward rounds, writers, or
   acceptance.

Executor predicates (`dispatch.*` in the executor table) keep their current
behavior: the task fails with `effects: none` and the lead receives it as a
failed outcome (`src/a2a-role-service.js:321-342`).

## Contract pinning per attempt

At dispatch, every batch item gets
`contract: { id: "boundary-contract/v1", reportContract: "worker-report/v1",
allowedFiles, sandbox, roleProfileSha256, skillPins }`, copied to its outcome.
`roleProfileSha256` uses the same hash as `state.pinned`
(`src/lead-graph.js:174`). The run-level acceptance contract keeps its single
pin in `state.contract`, now with `id: "acceptance-contract/v1"`.

Settlement evaluates an outcome against its own pinned contract, never against
the current profile. An outcome or checkpoint without `contract` is legacy: its
predicates run with today's logic, its results are labeled
`contract: "legacy"`, and it never carries a `boundary-contract/v1`
certification.

## Direct specialist requests

The executor (`makeExecutor.execute`, `src/a2a-role-service.js:214`) is the only
chokepoint shared by both paths, so DBC-03 enforces the specialist contract there.

- Structured request: a JSON object with the assignment fields (`objective`,
  `allowedFiles`, `inputs`, `acceptanceCriteria`, ...) as the lead already sends
  (`src/lead-graph.js:590-595`). Before the model is invoked, the executor runs
  `assignment.shape`, `assignment.writer_scope`, `assignment.paths`, and the
  skill pin check; a failure fails the task with `request_invalid`, effects none.
  After the turn it evaluates `settle.report_valid` and, for writers,
  `settle.attested_scope` against the request's `allowedFiles`, and records the
  results in artifact metadata `boundary: { contract, results }`.
- Legacy plain text: runs as today under the role's sandbox, approval policy, and
  writer admission. It gets no assignment predicates and no certification; its
  artifact metadata says `boundary: { contract: "legacy" }`.
- In both cases the artifact carries `contract: "worker-report/v1"` only when
  the text validates as a worker report; otherwise `contract: null` and
  `reportError`.
- A request that asks for a guarantee the executor cannot establish (for
  example `"requireAcceptance": true`, which only the lead path provides) fails
  with `guarantee_unavailable`.
- Task completion is not acceptance. A direct request never receives an
  acceptance disposition.

## Transition obligations

Hoare-style obligations for one writable attempt, checked by the predicates above:

- Before dispatch: `{ paths safe, writer scope non-empty, no unresolved writer,
  skill pins match }`.
- Admission: `{ single holder for the workspace, snapshot_before recorded }`.
- After settlement: `{ writer released or reconciled, delta known,
  delta.changedPaths within allowedFiles }`; an unknown outcome keeps the
  workspace held (`unresolved`) until quiescence is proven.
- At acceptance: `{ all required checks pass on a stable candidate, every writer
  of the run satisfies the settlement obligation }`.

Snapshot limits (`src/workspace-snapshot.js`): ignored files, files written and
restored within a turn, writes through symlinks to targets outside the tree or to
ignored targets, content inside submodules or nested repositories, and external
effects (network, other directories, services) are not observed. Their safety is
not proven by any predicate here. A non-git workspace makes every
snapshot-backed predicate `UNKNOWN`.

## Examples

Unknown writer effects: a writer's turn times out with no terminal event. The
execution row becomes `unresolved`; `settle.writer_settled` is `UNKNOWN` with
`writer_unresolved` and evidence `writer_executions:<executionId>`; the run pauses
with `writer_unresolved`; writable dispatch is refused by
`dispatch.writer_unresolved`. After reconciliation proves quiescence,
`settle.attested_scope` evaluates the recorded delta.

Unavailable snapshot: required checks fail in a non-git workspace.
`accept.checks` is `FAIL` (`check_failed`) and `accept.snapshot` is `UNKNOWN`
(`snapshot_unavailable`); the disposition is `rejected` (FAIL wins), not
`unverifiable`, and both violations are listed.

Rejected decision: the lead dispatches `explorer` with `allowedFiles: ["src/*"]`.
`assignment.paths` fails with `path_glob_unsupported`; nothing is submitted;
the next lead prompt shows the violation; the lead re-issues `["src"]`.

The local A2 implementation passed independent review and focused adversarial
probes, including saturated decision digests. Full suite: 1,412 tests, 1,403
passed, 8 unchanged baseline failures, 1 skipped; no new failures. This does not
qualify a live provider, target project, external CI route, or deployed service.
