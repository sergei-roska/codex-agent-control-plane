# Concurrent startup quarantine

## Objective

Keep the launcher-managed HTTP server available in a strictly read-only
quarantine when startup recovery cannot resolve an interrupted concurrent
planner turn, without clearing the shutdown phase, changing planner/task rows,
claiming no-effect, or resuming any work.

## Verified context

- Workspace: `/home/sr/Projects/Workspace/codex-agent-control-plane`.
- Project: `3d9c2e759c`; launcher8081 reports stopped, port3002.
- Read-only DB snapshot: shutdown phase `draining`, no saved shutdown attempts
  or process identities; one `active` planner turn has matching durable identity
  and start fact, and `isProcessGroupGone(start.processIdentity)` returned true.
- Current objective is `canceled`; claims are released, backlog attempts are
  terminal, all delivery role executions are settled, and publication is applied.
- Existing settled historical-provider replay repair is already present and
  reviewed in `src/delivery-role-service.js`; its service suite passes49/49.
- Current startup recovery correctly refuses to infer remote terminal/no-effect
  from local process death. Explorer and challenger both reject converting this
  case to `reconciled_no_effect` or enabling replay.
- Do not restart the project/server, contact a provider, submit/resume tasks,
  or mutate the live DB. No commits.

## Lead decision

Add a conservative maintenance boot path, not a ledger recovery. A worker
identified that checking after normal startup is too late: `startServer()`
starts the provider before opening state, `openStateDatabase()` migrates, and
the concurrent-engine constructor executes DDL. The quarantine decision must
therefore be an independent preflight before all three.

1. Leave ordinary `recoverInterruptedShutdown()` unchanged/fail-closed. Preserve
   the ordinary `provider_closing` recovery path. Before provider start, classify
   a persisted `draining` phase: quarantine only when the exact supported
   predicate passes; otherwise fail startup immediately without normal recovery
   or provider connection. Unknown/malformed/prepared phases fail closed.
2. Use a separate SQLite read-only handle, before `openStateDatabase()` or the
   concurrent-engine constructor. Acquire/hold the existing state and workspace
   ownership locks while inspecting/serving. Do not create/chmod/migrate the
   state DB. Lock-file creation is allowed; close releases locks (never unlink
   lock files). No `appServer.start()` / `getAccount()` in quarantine.
3. Eligibility narrowly checks exact `draining` phase shape with empty attempts
   and identities; exactly one active planner turn and no other active/unknown
   turn; matching project/session/thread/scope/turn/ownerGeneration identity and
   pins; matching start fact and process identity, with the process group proven
   gone; exactly one corresponding concurrent run/objective; canceled objective;
   terminal/released claims and attempts; settled role executions; terminal
   publication/candidate intents; and no active/unresolved workspace writer or
   A2A task execution. Missing tables/rows, malformed JSON, live/unprovable
   process, or any mismatch refuses quarantine.
4. If eligible, preserve every DB row exactly as-is. Do not instantiate the
   concurrent engine/router/role services, call recovery, register normal A2A or
   role routes, or start watchers. Serve only a minimal authenticated
   `/control/runtime` and `/control/quarantine` GET/HEAD diagnostic surface.
   Every non-GET/HEAD request receives explicit
   `concurrent_startup_quarantined` 503 before route parsing/provider dispatch.
   If an existing safe token cannot be read without chmod/create, fail closed.
5. Quarantine close closes only its HTTP/read-only DB handles and releases
   ownership locks; it must not advance/rewrite persisted phase. This is degraded
   observability, not task readiness or successful recovery.

If these invariants cannot be implemented without broadening the writable
surface, return a design-only result instead of weakening the recovery fence.

## Ownership and allowed files

Worker owns: `src/concurrent-delivery-engine.js`, `src/server.js`,
`test/concurrent-delivery-engine.test.js`, `test/server-delivery-engine.test.js`.
Do not edit other source/docs or the live SQLite database. Lead owns synthesis
and acceptance. Existing dirty changes must remain untouched.

## Acceptance

- Positive disposable regression boots in quarantine for an exactly bound,
  process-gone interrupted planner-only state; DB phase, planner facts, objective,
  attempts, claims, candidates and publications are byte/row-equivalent before
  and after startup/close.
- Quarantined server serves only minimal read-only diagnostics and rejects every
  mutation route before task dispatch/provider call. Provider start/account,
  identity pinning, engine construction, and normal startup recoveries are not
  called.
- Negative cases refuse quarantine for missing/corrupt/mismatched start facts,
  live/unprovable process groups, unresolved role execution/claims/effects, or
  other shutdown attempts.
- Regular successful `provider_closing` recovery path and existing
  unknown-effect fences remain.
- Focused tests pass; no live provider work or live server operation.

## Relevant code

- `src/concurrent-delivery-engine.js:257-414` interrupted shutdown recovery.
- `src/concurrent-delivery-engine.js:653-747` durable shutdown phases.
- `src/delivery-lifecycle.js:361-393` shutdown projection.
- `src/server.js:1012-1125` readiness, engine recovery and route wiring.
- `src/server.js:1200-1292` shutdown and startup cleanup.
- `src/lead-planner.js:167-183` active/unknown prior turn replay fence.
