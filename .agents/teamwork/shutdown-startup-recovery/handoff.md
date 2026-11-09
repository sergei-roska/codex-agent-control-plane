# Startup recovery implementation handoff

## Status

Implementation and focused verification are complete. No live service, live database, or model task was started or changed. Source files are frozen for independent review.

## Change

- `ConcurrentDeliveryEngine.recoverInterruptedShutdown()` runs before stored-run recovery and server readiness.
- Recovery accepts only a `provider_closing` phase with no pending shutdown attempts and all recorded old process groups gone. It evaluates every active/unknown planner row and all stored run shutdown projections before changing history.
- A legacy planner row with only `errorCode=provider_home_changed` is eligible only when its fact identity, pins, canceled objective, running/canceled run envelope, saved thread/account/home/transport identity, default-home state, and old-process quiescence all match. New rows carry an opaque switching-wrapper preflight marker; explicitly untrusted rows are not eligible. Original error data is retained in reconciliation evidence.
- Other planner/effect/lifecycle uncertainty remains fenced. Refusal is normalized to `concurrent_startup_recovery_unsafe`; startup cleanup closes the newly started provider/listener and releases new locks without changing the old shutdown phase.
- The real-engine HTTP regression includes the observed `running` run envelope with canceled objective and a dangling concurrent mapping. It returns a completed accepted task through stub coordinator/verifier calls, preserves the old A2A task state, reconciles the old planner record, and releases the old phase.

## Verification

- `node --test --test-name-pattern='restart settles a proven pre-dispatch shutdown planner before first HTTP intake|startup refuses unsafe interrupted shutdowns and releases new server resources' test/server-delivery-engine.test.js` - 4 passed, 0 failed.
- `node --test test/app-server-switch.test.js` - 8 passed, 0 failed.
- `node --test --test-name-pattern='trusted local pre-dispatch|unknown turns require exact no-effect' test/lead-planner.test.js` - 2 passed, 0 failed.
- Negative startup cases prove live old process groups and started unknown planner turns remain unchanged/fenced, invoke no provider work, and close the newly opened provider and listener.
- Exact before copies are in `evidence/baseline/`; app-server-switch baseline hash matches the lead-provided accepted hash `301609bd1cfb67d46b05f5ab8f3b434497d6d0913199c34c4ae4e56a7b0aed18`.

## Remaining review point

No new startup-specific test was added for pending publication/writer effects or identity mismatch. Recovery checks the existing `DeliveryLifecycle.shutdownProjection()` for every stored run before reconciliation and rejects any reason besides the exact eligible planner rows; review should confirm this covers those fences.

## Lead acceptance and original-state verification

- Independent review APPROVE, no blocking findings; review.md records focused checks and an independently reproduced baseline failure. No broad suites were rerun.
- After review, root used the existing project manager to perform a normal startup of original project3d9c2e759c on its original state database, authenticated /control/runtime inspection, and graceful stop. The helper inherited the original default provider home by unsetting root CODEX_HOME; CODEX_A2A_AUTO_RESUME=0 prevented background task resumption. No model task was submitted.
- Evidence: evidence/live-startup-cycle.cjs and evidence/live-startup-cycle.json. Startup recovered the actual provider_closing state, released its gate, reconciled the exact historical local rejection while retaining original error, and loaded hashes matching all five reviewed source files. Original A2A task rows were unchanged; planner count remained1. Clean graceful stop succeeded and left phase released.
- Ports8081/3002 have no listeners; registry project status stopped. No task test processes remain. Do not leave or invent a server for the owner; next normal startup now begins from released phase.
- Normal application startup performed the reviewed durable reconciliation. No direct live SQLite edits, task-history deletion, new live tasks, commits or pushes occurred. Do not misreport the live DB as wholly unchanged: recovery intentionally updates shutdown phase and old planner reconciliation evidence, while preserving historical A2A tasks and original failure.
- Scoped production delta: src/concurrent-delivery-engine.js, src/server.js, src/app-server-switch.js, src/lead-planner.js, src/project-delivery-controller.js. Scoped regressions: test/server-delivery-engine.test.js, test/app-server-switch.test.js, test/lead-planner.test.js. Preserve all inherited dirty work.
- No implementation work pending. No real model/live UI task was run; HTTP completion/acceptance was verified with the real engine and stub provider, and startup/recovery/clean stop was verified on the actual original database with real App Server process lifecycle.
