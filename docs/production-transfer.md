# Transfer log for the production orchestrator

This repository is the model project. Everything here that must carry over to
the production orchestrator is recorded in two lists: architectural decisions
(each with an ADR) and problems found (symptom, cause, how the model handles
it, what to do in production). Add an entry in the same step a decision is
taken or a problem is found. UI-only decisions are not tracked.

## Architectural decisions

| Date | Decision | ADR |
|---|---|---|
| 2026-10-11 | Session token usage is attributed through lead run ids and the dispatch journal, not context ids | docs/adr/launcher-session-usage-attribution.md |
| 2026-10-11 | The launcher projects live run state read-only from the lead's LangGraph checkpoint | docs/adr/launcher-situation-from-checkpoint.md |
| 2026-10-11 | Owner questions go to the read-only scout role directly, bypassing the lead | docs/adr/launcher-scout-ask.md |
| 2026-10-11 | Owner pause via an `owner_pause` interrupt at safe boundaries; Stop leaves the lead resumable | docs/adr/owner-pause-and-resumable-stop.md |

Earlier ADRs: `docs/adr/phase-c-*.md`.

## Problems found

### P-01 Stop outcome depended on a kill/drain race

- Symptom: after Stop a lead task was sometimes resumable, sometimes CANCELED.
- Cause: the launcher SIGKILLed after 2 s, the server needed 5 s to drain;
  killed runs were reconciled to a restart pause, drained runs were cancelled
  (terminal).
- Model: STOP-01 parks active leads as a resumable `stopped` pause and waits
  for the drain before SIGKILL.
- Production: process supervisor grace must exceed the orchestrator drain
  timeout, and shutdown must persist runs as resumable, never terminal.

### P-02 Stopping the server killed the team mid-work

- Symptom: the only way to stop was to cancel running worker turns.
- Cause: no owner pause; graceful shutdown cancelled active runs.
- Model: PAUSE-01 owner pause at decide start / after collect, workers finish.
- Production: provide a soft pause distinct from the emergency stop from day one.

### P-03 The owner had no live view of a running session

- Symptom: the owner had to wait for the turn to end, or open Codex in the
  project, to learn the phase, the plan, and what changed.
- Cause: run state lived only in the checkpoint; the UI showed chat and
  activity rows.
- Model: SIT-1..3 situation projection and panel.
- Production: expose a first-class run-state read model (phase, batch,
  decisions, acceptance, changed files) instead of reading checkpoint internals.

### P-04 The owner could not ask anything while the lead worked

- Symptom: composer locked; the server rejects a second message to a running
  task; notes to a running lead (`pendingNotes`) are in memory only.
- Model: SIT-5 questions go to the read-only scout, not the lead.
- Production: support side questions without touching the lead, and decide
  separately whether durable owner notes to a running lead are needed (SIT-4).

### P-05 Worker usage rows cannot be found by session

- Symptom: filtering `usage_ledger` by session context id misses all worker usage.
- Cause: worker rows carry a per-attempt context id; only `dispatch_journal`
  links them to the lead run.
- Production: stamp a session/run id on every usage row at write time.

### P-06 Role names drift in persisted data

- Symptom: old lead usage rows use `orch-lead`, new ones `coordinator`.
- Model: fold legacy names at read time.
- Production: store canonical role ids only; keep an alias map for imports.

### P-07 Checkpoint state is incomplete for observers

- `batch` is null after verify, so the last round has to be rebuilt from
  `outcomes`; outcomes carry no objective; `progress` entries have no
  timestamps.
- Production: persist objective, timestamps and per-round results as part of
  the run-state read model (see P-03).

### P-08 Changed files are self-reported by workers

- Symptom: `report.filesChanged` can differ from what was actually written.
- Model: prefer engine-measured `writer_executions.delta_json.changedPaths`
  when `known = true`.
- Production: treat measured deltas as the source of truth; self-reports only
  as hints.

### P-09 Roles share one app-server child and the accounts

- Symptom: no worker pool cap; a hung or crashing extra run (e.g. a scout ask)
  can exhaust the app-server restart budget (3) or the account limits the lead
  needs.
- Model: one ask per project, hard timeouts, cancel.
- Production: isolate side runs (separate child or quota) and add explicit
  concurrency limits.

### P-11 Pause and stop can only act at graph boundaries

- Symptom: a pause waits for the slowest running worker turn (up to
  turnTimeoutMs) and for an in-progress lead decide turn; a pause requested
  after the last boundary (e.g. during finish) is lost and the run ends
  normally; a Stop parks only when the run reaches finish or throws, and if
  the drain timeout is exceeded the task is left WORKING (later reconciled to a
  restart pause).
- Cause: LangGraph routing functions cannot interrupt (a dedicated gate node
  was needed after collect); the pause flag is in memory.
- Production: make pause/stop requests durable and checked by the run loop at
  every step boundary, and show the owner the expected wait.

### P-12 Lead notes live only in memory

- Symptom: notes queued for the next decide (e.g. "your acceptanceChecks
  proposal was ignored") are lost whenever the run parks (owner, budget or
  human-decision pause) or the server restarts.
- Cause: `pendingNotes` is held in the orchestrator runtime, not the checkpoint.
- Production: persist lead notes with the run state.

### P-13 Shutdown budget spans several stages

- Symptom: drain (5 s) plus app-server and HTTP close (up to 5 s) exceeded the
  supervisor grace, so a clean lock release could be cut off; a run that
  completed during shutdown could still end FAILED ("cancellation could not be
  confirmed").
- Production: derive the supervisor grace from the orchestrator's total
  shutdown budget, and let a completed result win over a late abort.

### P-10 The worker report schema has no free-form details field

- Symptom: a Q&A answer must fit `summary` (3000 chars) plus checks /
  filesInspected / risks.
- Production: give non-assignment role modes (questions, inventories) their own
  output schema.
