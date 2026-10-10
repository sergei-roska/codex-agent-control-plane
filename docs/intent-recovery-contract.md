# Intent recovery contract (WAL-01)

Status: frozen decision record for Phase B, contract `intent-recovery/v1`.
WAL-02 implements the gaps listed at the end. Facts verified at revision
`3d13217` (pragmas read from a fresh database opened through
`openStateDatabase`).

"Write-ahead intent" here means the orchestrator's own rule: a durable record of
what is about to happen is committed before the effect starts. It is distinct
from SQLite's WAL journal mode, which is only the storage engine's mechanism.

## Durability evidence

| Setting | Value | Source |
| --- | --- | --- |
| `journal_mode` | `wal` | `src/durable-store.js:133`; also set by SqliteSaver |
| `synchronous` | `1` (NORMAL), not set explicitly | better-sqlite3 default for WAL; no pragma in `src/` |
| `wal_autocheckpoint` | 1000 pages | default |
| `busy_timeout` | 5000 ms | `src/durable-store.js:16`, `:134` |
| Connection | one shared better-sqlite3 handle for the task store, checkpoints, journal, admission, ledger, evidence; every statement synchronous | `src/durable-store.js:143-145` |
| Lock files | separate `.lockdb`, `journal_mode=DELETE`, `synchronous=2`, an `EXCLUSIVE` transaction held for the process lifetime; they protect no data | `src/durable-store.js:169-197` |

What this gives today:

- Process crash (SIGKILL, Node crash): every statement that returned is in the
  WAL file and survives; multi-statement transactions are all-or-nothing.
- OS crash or power loss: under NORMAL the WAL is fsynced only at checkpoints, so
  a time-suffix of commits across all tables can be lost at once. An intent
  record (journal `submitting`, `writer_executions.active`, `turn_start_json`)
  can vanish while the Codex turn already changed workspace files. After reboot
  the replay then finds no `submitting` row and sends the writer again, with no
  fence and no execution row. Durable-before-effect does not hold.

## Decision D1: `synchronous = FULL` on the state database

The state database is opened with `PRAGMA synchronous = FULL`. Every commit is
fsynced before the statement returns, so each intent write is on stable storage
before the effect it guards begins (the journal row before `sendMessage`, the
execution row before the turn, `turn_start_json` before the `turn/start`
request). Rationale: the alternative, raising durability only around intent
writes, is not expressible on one shared synchronous connection without
reordering every user of it, and the commit rate is a few rows per turn, so the
fsync cost is small next to model latency. WAL-02 records a commit-latency
measurement before and after with the result in this document; if the measured
cost were prohibitive, the decision reopens rather than silently weakening.

Measured by WAL-02 (`node bench/journal-commit-latency.js 500`, 500
single-row journal commits on a temporary file database, two runs): median
0.022 / 0.021 ms with NORMAL, 0.568 / 0.588 ms with FULL. The added cost is well
under a millisecond per commit, so D1 stands.

WAL-02 note on G5: when a context's execution row exists only under another
workspace path, settlement returns `legacy_unverified` with reason
`execution_in_other_workspace` (UNKNOWN), never `never_executed`.

Power-loss durability is claimed only for storage that honors fsync. Lost
writes caused by a disk or filesystem that ignores fsync are out of scope.

## Identities

| Id | Format | Meaning |
| --- | --- | --- |
| Run | lead A2A task id (random UUID) | one lead run |
| Assignment | `<runId>:r<round>:a<index>` | one assignment in one round |
| Attempt (operation id) | `<assignmentId>:t1` | one delivery of one assignment. There is no automatic retry, so the suffix is always `t1`; a re-dispatch is a new assignment in a later round |
| Context | deterministic hash of the attempt id | specialist-side conversation id and fence key |
| Message | `<attemptId>:msg` | delivery id of the A2A message |
| Execution | writer admission execution id | one admitted writer turn |

## Intent states

Journal states, in order: `submitting` (intent committed, delivery may or may not
have happened), `submitted` (a specialist task id is known), `finished` (a result
is recorded). Transitions are monotonic: `finished` is terminal, `submitted`
never returns to `submitting`, and a recorded result is not overwritten by a
different one. Writer execution states stay as in `src/writer-admission.js`:
`active`, then `released` (known outcome) or `unresolved`, then `reconciled`.

## Crash-window matrix

Recovery is manual today: startup turns interrupted lead tasks into
`INPUT_REQUIRED` with pause `restart`, and a message resumes them.

| Window | On disk | Recovery action | Guarantee |
| --- | --- | --- | --- |
| W0 in `decide` before its checkpoint | previous checkpoint | `decide` re-runs (a new lead turn) | no external effect |
| W1 checkpoint written, before journal `submitting` | nothing for the attempt | dispatch replay recomputes identical ids, writes intent, sends | exactly once |
| W2 `submitting`, delivery never arrived | journal only | writer: lookup finds nothing, `outcome_unknown`, never re-sent; reconcile fences the context and proves `never_executed`. Read-only: re-sent with the same context | writer not duplicated; the fence blocks a late arrival |
| W3 delivery in flight, execution row `active`, no task row yet | `active`, no `turn_start` | startup `reconcileStale` marks `unresolved` then proves no turn started, `reconciled` | no effects; known delta |
| W4 task row exists, journal still `submitting` | task SUBMITTED | startup fails the task `interrupted`; resume finds it by context and reconciles by execution row | sound when an execution row exists; gap G2 when it does not |
| W5 admitted, before `turn_start_json` | `active`, no turn start | reconciled as "no turn started" | no effects (turn start is recorded before the request is written) |
| W6 turn running or finished, result not published | `active` with process identity | task failed `interrupted`; orphan group killed or proven gone, then `reconciled` with a delta; otherwise `unresolved` holds the workspace and the run pauses `writer_unresolved` | effects known by diff only; the report is lost; unknown never means no effects |
| W7 before the usage ledger row | as W6 | as W6 | tokens for that turn unknown |
| W8 ledger row, execution not released | as W6 | as W6 | result lost, usage kept |
| W9 execution `released`, result not published | released row with delta | lead reconciles by context and finds the released row | sound; report lost |
| W10 result artifact, status not terminal | artifact present, task failed `interrupted` | lead reads `writerExecution` from artifact metadata | result kept; status interrupted |
| W11 task terminal, journal `submitted` | terminal task | resume polls and finishes | sound |
| W12 journal `submitted`, before the dispatch checkpoint | `submitted` | replay returns the stored task id without resending | sound |
| W13 journal `finished`, before the collect checkpoint | `finished` | collect replays: re-polls an immutable terminal task, idempotent evidence put | benign; gap G4 removes the re-poll |
| W14 evidence row, journal not `finished` | orphan evidence | replay's idempotent put returns the same row | sound |
| W15 in `verify`/`reconcile` | batch finished | reconcile re-runs its side-effect-free pre-interrupt code; settle is deduplicated | sound |
| W16 OS crash or power loss, any window | suffix of commits lost | not detected | closed by D1 |

Acceptance contract: durable from the lead task's WORKING update
(`metadata.acceptanceContract`, OPS-02) and from the first input checkpoint;
OPS-02 makes the run wait for the persisted contract before it starts.

Duplicate delivery: the specialist side does not deduplicate by context or
message id. Writers are never re-sent, and fences close the late-arrival race
for them. A re-sent read-only attempt can create a second read-only task; this
costs tokens but has no workspace effect, and is accepted.

## Gaps for WAL-02

| Id | Gap | Required behavior |
| --- | --- | --- |
| G1 | `synchronous` is NORMAL (`src/durable-store.js:133-134`) | set FULL at open (D1); test reads the pragma back; record commit latency before and after here |
| G2 | settle returns `legacy_unverified` (UNKNOWN) when this call's fence insert proves the attempt can never run but `entry.taskId` is set (`src/lead-graph.js:1199-1202`) | return `never_executed` when the fence was inserted by this call and no execution row exists |
| G3 | journal transitions are unguarded updates (`src/durable-store.js:297-300`) | enforce monotonic transitions in SQL (`WHERE state` guards); a refused transition is reported as `journal_transition_refused` with from/to states; a different result for a `finished` row is refused, an identical one is a no-op |
| G4 | `pollItem` re-polls attempts already `finished` (`src/lead-graph.js:1096-1121`) | read the journal first and return the stored result, as `submitItem` does |
| G5 | the `never_executed` proof filters execution rows by workspace (`findByContextId`) | look up execution rows by context id regardless of workspace before proving `never_executed` |
| G6 | the server listens before startup reconciliation completes (`src/server.js:572-579`) | answer 503 with a retry hint until reconciliation is done, instead of 404 |

No schema migration is needed: the journal keeps its columns; guards are in
statements, and the pragma is set per connection. Old databases open unchanged.

## Not provided

- Automatic resume of interrupted runs after a restart.
- Recovery of a lost report in W6/W8 (only the attested delta survives).

Worktree mode (2026-10-10, [parallel writers design](parallel-writers-design.md)): W5
and W6 apply to the integration row, not to the Codex turn, which runs in a lane without
admission. A lane turn interrupted by a restart leaves a `writer_lanes` row that startup
marks `orphaned` (lane kept, nothing integrated); an interrupted integration is resolved
through its `writer_executions` row. G2's "never executed" also covers "never
integrated": no execution row exists for the attempt.
- Exactly-once delivery for read-only attempts.
- Effects outside the workspace (network, other directories) are not observed or
  reconciled by any of these records.
