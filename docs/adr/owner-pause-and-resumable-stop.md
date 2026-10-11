# ADR: Owner pause and a resumable emergency stop

Status: accepted 2026-10-11; implementation in progress. Design:
`docs/owner-pause-design.md` (PAUSE-01, STOP-01).

## Decision

Pause (soft stop, owner request): reuse the budget-pause path with a new
interrupt kind `owner_pause`. A per-run `pauseRequested` flag is checked only
at safe boundaries (start of `decide`, after `collect`), so running worker
turns always finish and are never cancelled. The lead parks as
TASK_STATE_INPUT_REQUIRED with `metadata.pause`; resume is the existing
message path (input = continue). The budget watcher only auto-resumes
`waiting_for_budget`, so an owner pause is never resumed automatically.

Stop (emergency brake, owner: do not postpone): worker turns are still
cancelled at once, but server shutdown parks each active lead run as
INPUT_REQUIRED with `pause { kind: "stopped" }` instead of TASK_STATE_CANCELED.
The launcher waits for the server drain (SHUTDOWN_TIMEOUT_MS + 3 s) before
SIGKILL. Explicit task cancel stays terminal.

## Context

Before this change Stop's outcome depended on a race: the launcher SIGKILLed
after 2 s, before the server's 5 s drain; a killed lead was later reconciled to
a resumable restart pause, a drained one ended CANCELED (terminal).
`docs/resilient-orchestration-spec.md:245` listed "graceful shutdown cancels
active runs" as a known gap.

## Alternatives considered

- Raise the launcher grace only: rejected; makes every Stop terminal (worse
  than today's accidental resumability).
- Pause by cancelling workers and re-dispatching later: rejected; wastes work
  and is what the owner called disrespectful.
- A server-wide dispatch gate: rejected; decide/dispatch are the only
  submitters, a per-run flag at node boundaries is enough.

## Consequences

- Pause latency equals the longest running worker turn (up to turnTimeoutMs)
  plus an in-progress lead decide turn.
- The pause flag is in memory; a pause requested when the server stops falls
  back to the stopped/restart pause, still resumable.
- After a Stop, the next round re-plans cancelled assignments like
  interrupted ones.
