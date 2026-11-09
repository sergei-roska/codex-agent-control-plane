# Handoff

## Status

Source repair and focused regressions are ready for independent review. Lead owns live runtime/browser acceptance. Worker did not start services or mutate the live database.

## Changes

- `src/concurrent-delivery-engine.js`: planner response schema now uses closed objects with every property required, including expected pins, usable task deltas and dependencies. Interrupted old schema failures can be reconciled only from exact Codex `thread/read` terminal evidence, matched provider identity/process group, canceled objective, and settled effects.
- `src/codex-app-server.js`: failed-turn errors retain bounded terminal turn ID, status, provider error details, and item types.
- `src/lead-planner.js`: provider failure evidence is persisted. Only failed `invalid_json_schema` with terminal identity/process facts and exactly one `userMessage` item is immediately marked `reconciled_no_effect`; other failures remain unknown.
- `src/project-delivery-controller.js`: terminal failure identity is exposed in controller status.
- Tests cover strict schema shape, useful task/dependency delta support, visible A2A `INPUT_REQUIRED`, retained failure evidence, old-row thread/read recovery before first HTTP intake, and Codex error propagation.

The worker report schema used by concurrent worker/verifier turns was inspected: its object schemas are closed and require every declared property. The planner is the schema that caused the observed 400.

## Verification

- `node --test --test-name-pattern='restart settles a proven terminal schema failure before first HTTP intake|planner sends a strict usable schema and exposes a failed terminal provider turn' test/server-delivery-engine.test.js` - 2 passed, 0 failed.
- `node --test --test-name-pattern='surfaces failed turns with the server error' test/codex-app-server.test.js` - 1 passed, 0 failed.

No broad suite was run. No live provider probe was run by worker.

## Baselines

Exact before-edit copies are in `evidence/baseline/` for each touched source/test file. Hashes:

- `concurrent-delivery-engine.js.before-worker-edit`: `bd22f45da39a801c924fdf19921e87c4f7650b9265c20c95427545b3203c44b7`
- `lead-planner.js.before-worker-edit`: `b2b0a0e7da70ccec2944de9d7dbcb3feaeae725d2d2aadcc53a74ba5c32af03f`
- `codex-app-server.js.before-worker-edit`: `67ce0c32b2e37816f79dc5bd1ad3b587292af8030d56278e72cb545005d699c1`
- `project-delivery-controller.js.before-worker-edit`: `5e23660dd07c25cc6ca28ca7345a977e3b270039df0e245d8714288ae95c7b89`
- `server-delivery-engine.test.js.before-worker-edit`: `dbac4d9ef27db14ecdac238dcefccfb01c809705c3262e91c1b8029ca1762c62`
- `codex-app-server.test.js.before-worker-edit`: `74b3337a56f5fff1ae0b9aeb1e7ae2be970c03df7b617615ee0891a2d4a30c0e`

Existing inherited dirty changes remain. Do not restore or overwrite them.

## Next

Independent review, then lead may load the repaired source and run the authorized real browser task. Existing canceled task must not be resumed. Startup recovery relies on the exact provider response saved at `evidence/provider-terminal.json`; no raw rollout is copied here.

## Live browser checkpoint by Lead (goal not achieved yet)

- Real browser used the owner's launcher8081 and project3d9c2e759c. Startup safely recovered actual previous schema400 rejection and loaded new code.
- First actual model request task47e2acbc-b0a0-46d9-877c-ee522686c28a, context97c06130-72e7-40fc-b78d-8138b9f12a7f. Provider accepted the new schema and completed turn01a186c8-3331-7902-b9cd-e2c0af86818a in thread01a186c8-329e-7a62-ae15-4717959b914a.
- Model planned engineer AND verifier. Host prohibits planner-created verifier tasks, so sanitizer returned null and planner_output_invalid. No backlog tasks or role execution occurred. UI now visibly returned INPUT_REQUIRED rather than indefinite WORKING. Evidence browser-task-attempt1.json and .png contain only the generated diagnostic conversation.
- Trusted thread/read for this one completed turn has only userMessage, reasoning, agentMessage; no commands/tools/file edits. Existing terminal_json binds exact thread/turn/process and confirmed thread/backgroundTerminals/clean receipt.
- Lead paused only its diagnostic via authenticated /control/pause; objective is paused_owner/controlRevision2. Then stopped only its project server through existing launcher. Current phase provider_closing for old group185211/startTime284363, attempts[], unknown completed planner lead-0413d152b4ad01d7b22027762596da19. Run envelope paused. No direct SQL writes. Launcher8081 stays running; project3002 stopped. Canceled owner tasks preserved.
- Worker now repairing role enum/prompt and safe recovery of this planning-only completed rejection while preserving genuine unknowns. Do not auto-resume this diagnostic: its pinned Python check was incorrectly whitespace-tokenized. Next fresh browser task uses a standalone Node check (no quoting) verifying exact diagnostic file content.
- Acceptance still requires actual engineer write, candidate publication, real verifier, host exact-byte check and visible accepted completion. Never mark goal complete based on current prior tests. Remaining work and current worker context are active.

## Follow-up checkpoint

Lead's first real model plan completed but was rejected because it included a planner-created verifier task. The diagnostic was paused through the owner control endpoint; its immutable acceptance check is not resumed.

- Planner role schema now enumerates only configured task roles. The prompt says the host creates the mandatory verifier and forbids verifier/auditor/review/coordinator planner tasks. Host sanitizer applies the same role exclusions.
- Dependency `expectedOutput` now asks for the exact known candidate ID or null, never narrative text.
- Startup can reconcile a narrowly validated `planner_output_invalid` only when the run/objective is owner-paused (or canceled), the saved terminal JSON proves a completed turn with confirmed `thread/backgroundTerminals/clean` receipt matching the start identity, and authoritative `thread/read` contains exactly one turn with userMessage/reasoning/agentMessage and no tool items. The original error remains in the reconciliation record. Other unknown turns remain fenced.
- Regression recreates this paused completed-output rejection, verifies recovery before first HTTP intake, and confirms the diagnostic remains paused while a fresh request completes.
- `node --test --test-name-pattern='restart settles a completed rejected plan for a paused objective before first HTTP intake|restart settles a proven terminal schema failure before first HTTP intake|planner sends a strict usable schema and exposes a failed terminal provider turn' test/server-delivery-engine.test.js` - 3 passed, 0 failed.
- `git diff --check -- src/concurrent-delivery-engine.js test/server-delivery-engine.test.js` - passed.

Pre-follow-up checkpoints (exact accepted source immediately before these edits) are in `evidence/checkpoint-before-followup/`:

- `concurrent-delivery-engine.js`: `7fe698d2e725fb3df079fabb27b9589b67a9dbf8ad813d070597f2e05d6d22f3`
- `server-delivery-engine.test.js`: `648cf2fb33a0dddb54c831cdb662f2d33712ed9eed17fec6c02f3f5bdf77a0aa`

Current source hash changes are limited to those two files; no service or database was touched by worker.
