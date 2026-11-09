# CN14 core engine handoff

Status: partial. Updated 2026-10-27. Root owns Git/docs and startup wiring. No startup wiring was made. Preserve inherited dirty work.

## Completed and verified

- `src/project-settings.js` selects `deliveryEngine: legacy|concurrent-v1`, defaults missing values to `legacy`, and follows the existing warning/safe-default path for invalid values.
- `src/app-server-switch.js` carries an optional Codex home pin through tracked `prepareThread`/`run` calls. Tests prove a post-prepare profile swap is rejected before invoking the wrong target.
- `src/delivery-acceptance.js` awaits `onChecksExecuted` after the real frozen checks and before `recordFinalizationChecks`; missing proof fails closed.
- `src/delivery-engine-router.js` persists per-run selection and deterministic concurrent objective/session IDs. This turn fixed async `isResumable` delegation and preserves omitted intake fields on partial replay; a conflicting provider `contextId` now fails with `run_intake_conflict`.
- Focused verification passed: `env -u NODE_TEST_CONTEXT node --test test/delivery-engine-router.test.js` (3/3); `env -u NODE_TEST_CONTEXT node --test test/delivery-acceptance-join.test.js test/app-server-switch.test.js test/project-settings.test.js test/delivery-role-service.test.js` (47/47); `node --check src/concurrent-delivery-engine.js` and module `require()` passed before the prototype was archived.

## Concurrent engine prototype - not accepted

- A real constructor/run prototype was attempted with shared SQLite, private role service SDK routes, candidate/review/output stores, fake AppServer, and finalization. Its exact source and dedicated failing test are preserved in ignored files `concurrent-delivery-engine.incomplete.js` and `concurrent-delivery-engine.test.incomplete.js` in this directory. Restore only for the next bounded implementation attempt. The prototype was removed from `src/` and `test/` so an unverified engine and failing test are not exposed as product code.
- Verification command: `env -u NODE_TEST_CONTEXT node --test test/concurrent-delivery-engine.test.js` failed after the 8-second diagnostic bound. The lead turn persisted as `unknown`; controller status reported `lastPlanner.reason='prior_turn_reconciliation_required'` and `lastRecovery.reason='planner_turn_effect_unknown'`. No verifier call occurred and no candidate was accepted. The earlier unbounded attempt was interrupted at about 34 seconds with the same pending planner state.
- Next concrete action: independently inspect the prototype's fake-AppServer/LeadPlanner turn identity and quiescence evidence contract, reproduce a trusted terminal lead turn, then rerun the real verifier/receipt/finalization path. Do not wire to `startServer` until recovery, controls, shutdown fences, and this path are reviewed.
- The prototype required explicit `providerIdentity: { accountId, codexHome }`; `startServer` already has the loaded account, but no production composition seam was added. Owner correction supersession integration was also incomplete and must fail closed.

## Handoff constraints

- Root should review completed router/settings/home-pin/acceptance-hook seams independently. They were not edited during the engine attempt.
- Do not claim CN14 activation or production concurrent routing. Existing mappings must remain authoritative if the default changes.
- Current router regressions cover async legacy resumability, preserving contract/context on partial intake replay, and rejecting context drift.
