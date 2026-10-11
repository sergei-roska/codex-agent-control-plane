# Owner pause (soft stop)

Status: PAUSE-01 in progress (2026-10-11).

## Problem

Stop kills the team mid-work. Today the launcher SIGTERMs the project server,
the server cancels every lead run (`executor.cancelAll`), workers get A2A
cancelTask, and the lead task ends TASK_STATE_CANCELED (terminal). The launcher
SIGKILLs after 2 s (`launcher-projects.js:69`), before the server's 5 s drain
(`server.js:32`); a SIGKILLed lead is later reconciled to a resumable restart
pause, a drained one is terminal. The owner wants a respectful soft stop;
Stop stays as the emergency brake.

## Decision

Reuse the budget-pause path with a new interrupt kind `owner_pause`.

- Request: a per-run `pauseRequested` flag in the orchestrator runtime
  (`lead-orchestrator.js` ~359, next to signal/pendingNotes), set by a new
  orchestrator method and cleared by a cancel-request method.
- Check points: start of `decide` (before any new dispatch is planned) and
  `afterCollect` (after every running worker turn is terminal). When the flag
  is set, interrupt with `{ kind: "owner_pause", message: "Paused by the
  owner" }`. Running worker turns are never cancelled; the pause waits for the
  slowest one, and for an in-progress lead decide turn.
- Parked state: TASK_STATE_INPUT_REQUIRED with metadata.pause, checkpoint as
  the source of truth, survives a server restart like other pauses. The budget
  watcher only resumes `waiting_for_budget` (`server.js` budgetRunResumable,
  `budget-watcher.js:218`), so it never auto-resumes an owner pause.
- Resume: the existing message path to the paused task; resume input for
  `owner_pause` means "continue" (like budget).
- Pause requested while the flag is only in memory and the server stops: the
  run falls back to the restart pause, still resumable.

## Interfaces

Project server (loopback token, same protection as other control routes):
- request pause of the active lead run(s): sets the flag; idempotent.
- cancel a pending pause request (before the lead has parked).
- status: `pauseRequested` per active run, exposed where the launcher already
  reads project status.

Launcher:
- `POST /api/projects/:id/pause`, `POST /api/projects/:id/pause/cancel`,
  `POST /api/projects/:id/resume` (sends the continue message to the paused
  lead task of the given or latest session).
- SIT-1 situation: phase `pausing` while requested and not yet parked,
  `paused` for an `owner_pause` interrupt.

UI: a Pause button between Start and Stop, visible while the lead works;
"Pausing..." (with the count of running workers, click again to cancel the
request); when parked the situation panel shows a "Paused" pill and a Resume
primary button. Stop is unchanged.

## Out of scope / known gaps

- Stop semantics (drain vs SIGKILL race, terminal CANCELED) are unchanged;
  see `docs/resilient-orchestration-spec.md:245`.
- Pause latency equals the longest running worker turn (up to turnTimeoutMs).
