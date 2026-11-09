# Milestone 2: early read-only startup quarantine

## Objective

Wire the approved M1 `inspectConcurrentStartupQuarantine()` predicate into an
early startup preflight. An eligible `draining` state must boot only a strictly
read-only authenticated diagnostics server while retaining state/workspace
ownership locks. Unsafe or malformed persisted phases must fail before any
provider startup. Preserve ordinary, validated `provider_closing` recovery.
This is diagnostic availability, not normal task readiness or successful
recovery of the unknown planner turn.

## Decisions and constraints

- Follow `brief.md`; do not infer a no-effect result or change persisted rows.
- Preflight must happen before `appServer.start()`, `getAccount()`, writable
  state open/migrations, engine construction/recovery, route registration,
  watchers, and provider identity pinning.
- Use a separate SQLite read-only handle for persisted state. Never use
  `openStateDatabase()` for preflight. Do not chmod/create a missing token in
  quarantine; if a safe existing token cannot be read unchanged, fail closed.
- Hold state and workspace ownership locks from before inspection through
  quarantine serving/close. Close only HTTP/read-only DB handles and release
  locks; never unlink lock files or mutate the state DB.
- Quarantine exposes only authenticated GET/HEAD `/control/runtime` and
  `/control/quarantine`; every other method returns JSON 503
  `concurrent_startup_quarantined` before parsing or dispatch.
- Before normal `provider_closing` recovery, validate phase/attempt/identity
  shapes consistent with `ConcurrentDeliveryEngine.#prepareShutdown()` output.
  Keep recovery fail-closed and preserve the provider-closing path for valid
  records.
- No live server restart, provider task submission/resume, live DB mutation, or
  commits. Preserve all inherited dirty/untracked files.

## Allowed files

- Worker: `src/server.js`, `test/server-delivery-engine.test.js` only.
- Lead owns local teamwork notes and acceptance.

## Acceptance

1. An exactly eligible file-backed `draining` fixture starts quarantine without
   starting/reading the provider, pinning provider identity, constructing the
   concurrent engine, or running normal recoveries. Read-only SQLite snapshots
   of durable rows and schema are identical before startup and after close.
2. Authenticated GET and HEAD diagnostics work; unauthenticated diagnostics are
   rejected. Every non-GET/HEAD method returns 503 with
   `concurrent_startup_quarantined`; arbitrary GET paths expose no application
   routes.
3. Quarantine close retains persisted phase/facts/objective/task/effects exactly,
   closes HTTP/read-only DB handles, and releases both ownership locks.
4. Missing/corrupt auth token, malformed draining evidence, unsupported phase,
   live/unprovable process identity, and malformed provider-closing attempts
   fail before provider startup. Valid provider-closing state continues through
   normal recovery.
5. Run focused server tests, syntax checks, and diff checks. No live operations.

## Handoff format

Report exact changed files, commands/results, uncertainty, and status.
