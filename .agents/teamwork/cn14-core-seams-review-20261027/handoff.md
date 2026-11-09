# CN14 completed core seams review handoff

## Router delta re-review, 2026-10-27

Verdict remains REJECT for the intake-preservation finding. The async
`isResumable()` delegation is fixed, omitted `contract`/`contextId` are
preserved, and changed `contextId` fails without a provider call. The new
`env -u NODE_TEST_CONTEXT node --test test/delivery-engine-router.test.js`
passed 3/3. A focused real SQLite probe found that `run()` still passes
`newRequest: input.newRequest || null` to `#pin` on a mapped replay
(`src/delivery-engine-router.js:99`). Replaying the same goal with omitted
`newRequest` changed persisted original `newRequest:'original follow-up'` to
`null`. This loses owner intake context. Preserve omission, and reject any
conflicting explicit replacement without mutating the mapping. The three
router tests do not cover this case. No broader suite or product edit.

The original review findings follow; the async item there is resolved.

Verdict: REJECT. Status: complete. Scope expansion: none. Review covers only
completed seams, not unfinished engine or startup wiring. No reviewed source,
tests, config, Git state, live model/account/service, or target was changed.

## Blocking

1. `src/delivery-engine-router.js:145` (read and ran): `isResumable()` compares
   delegated result to literal `true` synchronously, but the actual legacy
   `LeadOrchestrator.isResumable()` is async (`src/lead-orchestrator.js:411`).
   The router always returns false for a legacy Promise, so server error
   recovery (`src/server.js:629`) treats a resumable legacy run as terminal.
   Make the router method async and await the delegated boolean. Keep server's
   existing await. A real SQLite/fake-engine probe observed false when the
   delegated async method returned true.

2. `src/delivery-engine-router.js:68,94-99` (read and ran): replaying `run()`
   with the same goal but omitted `contract` or `contextId` merges undefined
   fields over the pinned intake. JSON persistence then removes the stored
   owner check contract and context. A later caller can also change contextId
   while `sessionId` stays pinned, breaking original owner/session identity.
   A real SQLite/fake-engine probe first stored a required check and context-A;
   replay with only the same goal deleted both, and a later call set context-B
   under the original session. Normalize only fields actually supplied, reject
   any different immutable field, preserve omitted fields, and make conflicts
   nonmutating. Route with the stored authoritative intake.

## Verified nonblocking seams

- Settings missing/invalid select legacy, with invalid document warning and
  strict permission fallback (read; focused tests passed).
- Provider-home pin compares the captured prepared home after `settle()` and
  before invoking the tracked target. Fake swap test showed zero wrong-home
  `run` calls (read; focused tests passed).
- `finalizeCandidate` awaits `onChecksExecuted` after host checks and before
  `recordFinalizationChecks`; literal-false denial leaves `checking` and no
  recorded check result (read; focused tests passed). Durable host proof
  persistence remains the engine's composition responsibility.

Verification: `env -u NODE_TEST_CONTEXT node --test
test/project-settings.test.js test/app-server-switch.test.js
test/delivery-acceptance-join.test.js` passed 32/32. An in-memory real SQLite
router probe independently reproduced both blockers. There is no dedicated
router test file yet. No broad suite was run.

Next action: worker fixes only router intake/async facade and adds persistent
router regressions for omitted fields, context conflict, reopen, and async
legacy resumability. Re-review only this delta.
