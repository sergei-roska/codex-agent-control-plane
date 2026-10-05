# Supervisor recovery contract (SUP-01)

Status: frozen for Phase B, contract `supervisor-policy/v1`. A change reopens
SUP-01 and marks SUP-02 and SUP-03 stale. Facts verified at revision `1b107f4`.

## Scope and limits

One `CodexAppServer` instance supervises one shared `codex app-server` child
that hosts every lead and specialist turn. This contract bounds how that child is
restarted after failures. It does not introduce per-worker processes, one-for-one
restarts, or any automatic replay of a turn or an assignment: a process failure
fails every in-flight turn on that process, and only the lead may dispatch new
work. Safety for writers comes from writer admission and reconciliation
(`docs/hardening-spec.md`), not from the supervisor.

Current behavior (verified):

- Replacement is lazy: the next `start()` caller spawns a new generation
  (`src/codex-app-server.js:125-150`). There is no restart counter, window,
  backoff, or deadline; a crash-looping binary is respawned once per caller.
- Replacement waits for the old leader's exit with no deadline
  (`src/codex-app-server.js:146`); a leader that never exits blocks every start.
- The unexpected-exit path SIGKILLs the group (`:184-195`) but records no
  survivors; only `_terminateProcess` / `_delayedKill` do (`:820-851`).
- `_failAll` sets `outcomeUnknown` on one shared error for all pending requests
  whenever any run exists (`:860-870`), so a sibling run that never sent
  `turn/start` is also treated as unknown.
- `classifyCodexError` returns only `usage_limit` or `other`
  (`src/contracts.js:524`). `this.generation` exists (`:117`) but is not exposed.
- No fake clock exists; the module uses `Date.now`, `performance.now`, and global
  timers directly.

## Failure classes

A deterministic classifier assigns exactly one class to every failure observed by
`CodexAppServer`. Classes are stable strings.

| Class | Detected by | Process restarts? | Turn outcome |
| --- | --- | --- | --- |
| `process_exit` | child `exit`/`error`/`close`, stdio error, invalid JSONL | yes (counts) | unknown for runs with `turn/start` sent and no terminal event; known (nothing ran) otherwise |
| `spawn_failed` | spawn error (e.g. ENOENT), `initialize` error or timeout | yes (counts) | known: no turn started |
| `turn_start_unknown` | `turn/start` RPC timeout; the group is terminated (`:594-604`) | yes (counts) | unknown for that run; per-run rule above for siblings |
| `turn_timeout` | turn completion timeout; interrupt, then terminate (`:737-766`) | yes (counts) | unknown |
| `interrupt_unconfirmed` | cancel fail-safe: no `turn/completed` within the interrupt timeout (`:768-783`) | yes (counts) | unknown |
| `rpc_timeout` | any other request timeout | no | known: request failed, process kept |
| `request_rejected` | JSON-RPC error response (e.g. `thread/resume` failed, `turn/start` rejected) | no | known |
| `usage_limit` | `classifyCodexError` result `usage_limit` | no; budget pause as today | known |
| `domain_failure` | turn completed with a failed status; permission denials stay in `permissionEvents` | no | known |
| `supervisor_exhausted` | restart budget exhausted (below) | no spawn | known: no turn started |
| `closed` | `close()` during shutdown | no | as today |

"Counts" means the generation ended by failure and is charged to the restart
budget. `close()` is never charged.

Per-run outcome rule: when a process fails, a run's error carries
`outcomeUnknown: true` only if that run had sent `turn/start` and had not seen a
terminal event. Every other run on that process gets `outcomeUnknown: false`, so
a writer that never started a turn is released at once instead of going through
reconciliation.

## Restart policy

| Parameter | Default | Meaning |
| --- | --- | --- |
| `maxRestarts` | 3 | charged generation endings allowed inside the window |
| `windowMs` | 60000 | sliding window for `maxRestarts` |
| `backoffMs` | 0, 1000, 4000, then x4, capped at 30000 | delay before spawning the next generation after the 1st, 2nd, 3rd... charged ending inside the window |
| `exitWaitMs` | 5000 | deadline for the old leader to exit after termination |
| `cooldownMs` | 60000, doubling per failed probe, capped at 600000 | exhausted period before one probe start is allowed |

States: `stopped` (no child), `starting`, `running`, `backoff` (waiting before a
spawn), `exhausted`.

1. Concurrent callers share one pending start (the existing memoized
   `startPromise`); backoff and probes never spawn twice.
2. When a charged ending would be the `(maxRestarts + 1)`-th inside the window,
   the supervisor enters `exhausted`: `start()` rejects immediately with
   `CodexAppServerError` code `supervisor_exhausted`, class `supervisor_exhausted`,
   `outcomeUnknown: false`, and a message naming the last failure classes and
   `nextProbeAt`. No child is spawned.
3. After `cooldownMs`, the next `start()` is a probe: one spawn. If the probe
   reaches `running`, the window and cooldown reset. If it fails, the supervisor
   returns to `exhausted` with the cooldown doubled (capped).
4. Before spawning a replacement, the supervisor terminates the old group (if
   not already) and waits up to `exitWaitMs` for the old leader to exit. On
   timeout it records an `unreaped` event with the survivors found by
   `listGroupMembers` and proceeds: writer admission keeps any unresolved writer
   held until reconciliation proves quiescence.
5. The unexpected-exit path records survivors the same way as `_delayedKill`
   (`lastTermination`), so every charged ending has a termination record.
6. `usage_limit`, `rpc_timeout`, `request_rejected`, and `domain_failure` never
   restart the process and are never charged.
7. Operator reset: restarting the server process creates a fresh supervisor. An
   explicit `resetSupervisor()` method clears the window and exhaustion for tests
   and future operator tooling.

All timing uses an injected clock (`now`, `setTimeout`, `clearTimeout`;
default real), so tests drive windows, backoff, deadlines, and cooldowns
deterministically.

## Generation identity and events

- `generation` is a monotonic integer per `CodexAppServer` instance, incremented
  on each spawn. Every run's `execution` metadata and every error carry
  `generation` alongside `processIdentity`.
- `supervisorState()` returns `{ policy: "supervisor-policy/v1", state,
  generation, chargedInWindow, nextStartAt, nextProbeAt, events }`. `events` is a
  ring of the last 50 entries `{ at, generation, kind, class, detail, survivors }`
  with kinds `started`, `start_failed`, `exited`, `terminated`, `unreaped`,
  `backoff`, `exhausted`, `probe`, `recovered`, `reset`.
- The executor maps class `supervisor_exhausted` to task `failureKind:
  "supervisor_exhausted"`, effects `none`. A lead turn that fails with it pauses
  the run with the existing resumable error pause; a human or a later resume
  retries after the cooldown.

## Replay rules

- Restarting a process never replays a turn. Every in-flight turn fails with
  its class and outcome per the per-run rule.
- Replaying an assignment is a lead decision (a new dispatch), never automatic.
- A writer assignment may be dispatched again only after its earlier attempt is
  authoritatively settled (`released`, or `reconciled` with a known delta) and
  the lead decides to dispatch it; the existing guards stay
  (`src/lead-graph.js` never re-sends `outcome_unknown` writers; dispatch refuses
  writable roles while writers are unresolved).
- Budget (`usage_limit`) and permission problems are never crash-restart loops.

## Cancellation

Cancellation semantics stay as implemented: an A2A cancel interrupts the turn;
"confirmed" means `turn/completed` before the interrupt timeout, otherwise the
fail-safe terminates the shared child (class `interrupt_unconfirmed`, charged).
The lead's cancel-confirmation deadline must exceed the specialist's worst case
(interrupt timeout + 1 s force kill + writer reconcile retry), so its default
rises from 10 s to 20 s (`src/lead-orchestrator.js:17`).

## Known gaps not addressed here

- Lead-turn ledger rows omit `startupMs`/`coldStart` (`src/lead-graph.js:723-757`);
  a lead turn that claims a cold start hides it from worker rows. MEA follow-up.
- `threadTotals` resets on every process start (`src/codex-app-server.js:166`),
  so the first resumed turn reports `tokens: null`. Reported as unknown, never 0.
- Setsid/daemonized descendants escape group tracking (`docs/hardening-spec.md`).

## Tests required (SUP-02, SUP-03)

Fake-clock tests: repeated crashes inside and outside the window, backoff
delays, exhaustion and probe recovery, a failed probe doubling the cooldown,
concurrent callers during backoff and probe (one spawn), a leader that never
exits (`exitWaitMs` then `unreaped`), the per-run outcome rule for a sibling that
never sent `turn/start`, and non-charged classes not restarting. SUP-03: a shared
process failure with concurrent read turns and an active writer, replacement, a
resumed lead flow, the writer still holding admission until reconciled, no
duplicate dispatch, and exhaustion visible in `supervisorState().events`.
