# Interrupted shutdown startup recovery review

Verdict: APPROVE
Blocking: none.
Status: complete
Scope expansion: none

## Scope (read)

Read brief.md, finalized handoff.md, and evidence/real-state.json. Inspected actual git diff and scoped file comparisons against evidence/baseline, including the later before-worker-edit copies for app-server-switch.js, lead-planner.js, project-delivery-controller.js and their changed tests. Wrapper baseline hash matches the accepted prior implementation. Production delta is confined to the authorized engine/server recovery and opaque local-error proof forwarding. No reviewed source, fixtures, config, or Git state was edited by this review.

## Acceptance evidence

PASS - Observed persisted shape is represented: provider_closing with old process identity gone and no pending shutdown attempts; canceled objective with a still-running run envelope; unknown provider_home_changed row with no marker; matched identity fact with null start/terminal; default selected profile; and an additional dangling concurrent mapping. The regression uses the real server, HTTP transport, router, concurrent engine, planner/controller, verifier, and acceptance flow. Only provider calls are stubbed.

PASS - First fresh authenticated HTTP SendMessage returns TASK_STATE_COMPLETED with accepted run disposition and reaches stub coordinator and verifier. Old A2A INPUT_REQUIRED state is preserved. Original planner error is retained in reconciliation evidence, the old turn becomes reconciled_no_effect, and the old shutdown phase becomes released.

PASS - Unsafe startup refuses live old groups and genuinely unknown/started planner state with concurrent_startup_recovery_unsafe before provider work. Final tests assert the NEW provider is closed exactly once and its listener is closed, while the old provider_closing phase and unknown planner status remain unchanged.

PASS - Existing released-phase reopen still completes a fresh request.

PASS (read) - Historical proof is narrow: unknown status; exact error/optional source shape; null start/terminal facts; matching project/session/turn/thread/scope/generation; pinned account/home; saved lead thread/transport identity; mapped concurrent run; canceled objective; and old process-group quiescence. Missing start alone is not accepted. Source search found provider_home_changed generated only by the switching wrapper, whose rejection precedes provider forwarding. CodexAppServer invokes onTurnStart before issuing turn/start, and the concurrent engine persists that callback's start fact synchronously.

PASS (read and targeted tests) - Future errors are labeled through a wrapper-private WeakSet, forwarded via controller to LeadPlanner. A matching error code on a different error object is not trusted. All future untrusted errors persist preDispatchSource:null, which startup refuses; absence of the field is reserved for the narrowly bound historical path. Existing generic unknown-turn proof checks still pass.

PASS (read) - Effect and process fences remain: every stored run must have a safe DeliveryLifecycle.shutdownProjection, or exactly the eligible planner turns with no other refusal reason. Claims, unsettled attempts, pending inbox, unsettled role/publication/candidate effects, and active/unresolved workspace writers introduce other reasons and refuse recovery before any planner update. The final finishShutdown repeats process and lifecycle checks. Recovery calls finishShutdown directly, never prepareShutdown or appServer.close, so it does not add the NEW provider to the OLD phase or close the NEW provider. The positive real-engine accepted request verifies admission is reopened. Server recovery refusal skips engine shutdown and closes only newly allocated startup resources.

## Independent commands (ran)

- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='restart settles a proven pre-dispatch shutdown planner|startup refuses unsafe interrupted shutdowns|released shutdown phase permits fresh host intake' test/server-delivery-engine.test.js: final frozen tests 5 passed, 0 failed.
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='unknown turns require exact|trusted local pre-dispatch' test/lead-planner.test.js: 2 passed, 0 failed.
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='prepared thread carries its home pin' test/app-server-switch.test.js: 1 passed, 0 failed, including opaque-proof versus spoofed error assertion.
- Exact baseline server.js and concurrent-delivery-engine.js compiled in memory at their normal module filenames, then the same current HTTP regression required with node --test-name-pattern='restart settles a proven pre-dispatch shutdown planner': expected failure, TASK_STATE_FAILED with concurrent_shutdown_admission_closed instead of TASK_STATE_COMPLETED. Baseline code cannot drain this fabricated old state; an inline timer closed only the probe's disposable HTTP handles so the original assertion could be reported and the process exited 1. An earlier identical probe was stopped with SIGINT for its same retained disposable listener; no production process was signaled.
- git diff --check -- src/server.js src/app-server-switch.js: passed.

## Limits and non-blocking notes

No new startup-specific identity-mismatch or pending-effect matrix was run; those fences were verified through the exact recovery predicates, unchanged lifecycle/effect helpers, and their callers. No broad suite rerun was needed. This review did not access or mutate live databases, restart live services, or execute model work. It establishes tested recovery/HTTP acceptance with a stub provider, not an actual model or live UI task.

Pitfall: Recover an OLD shutdown against its saved identities before reopening admission; do not collect or close the NEW provider as part of that recovery.
