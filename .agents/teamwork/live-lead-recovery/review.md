# Live lead recovery source review

Verdict: APPROVE
Blocking: none.
Status: complete
Scope expansion: none

This is source-review approval to proceed to the lead-owned live acceptance checkpoint. The owner's browser/model/engineer/output goal is NOT established by these stub-provider tests.

## Evidence (read)

Compared actual engine, Codex client, planner, controller, and test files with the exact evidence/baseline copies; inspected git diff where tracked. Read brief, finalized worker handoff, and the sanitized actual provider terminal response. The observed failure is a failed HTTP400 invalid_json_schema turn with exactly one userMessage item and no model/tool output.

The planner schema now defines closed objects and all declared properties are required, including expected pins, versioned task changes, read/write scope, dependencies, nullable metadata, and bounded owner-decision structure. A real engineer task can be represented; this is not limited to null delta. Host validators were not changed. Checked the surrounding sanitizer: it supplies the authoritative base candidate, owner check pins, denied publication authority, skills/tool/profile pins, and queued state. Thus the schema's omission of host-owned optional task fields does not remove the dispatch requirements. Worker/verifier output still uses WORKER_REPORT_SCHEMA, whose nested objects are already closed and required.

The Codex error path retains terminal turn ID/status/error/item types alongside the existing execution identity. The engine persists matching failed terminal evidence rather than discarding it. Planner no-effect classification requires failed invalid_json_schema, invalid_request_error, text.format.schema, terminal/start execution flags, matching terminal turn ID, process identity, and exactly one userMessage item. Generic failed or genuinely unknown execution does not satisfy this predicate. The controller carries the failure to the engine, which returns a visible INPUT_REQUIRED error pause instead of indefinite WORKING.

Historical recovery requires the bound canceled objective/run/thread/account/home/scope/generation and old start identity within the old shutdown phase, with its process group gone. thread/read must return that exact thread with one failed turn, one userMessage, and the exact observed HTTP400 schema error message. A second turn, tool/model item, changed error, or identity mismatch refuses recovery. Original failure remains in reconciliation evidence and missing terminal facts are filled from provider evidence. Existing all-run lifecycle/effect/process checks remain before release; the new provider is used only for read-only historical evidence and is not included in OLD shutdown identities or closed by successful OLD recovery.

## Checks (ran)

- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='planner sends a strict usable schema|restart settles a proven terminal schema failure|rejects when a turn fails|rejects a failed turn|keeps codexErrorInfo' test/server-delivery-engine.test.js test/codex-app-server.test.js: 3 selected tests passed. Covers real HTTP visible failure, strict schema/task/dependency structure, persisted terminal proof, and historical provider-read recovery followed by accepted HTTP completion.
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='surfaces failed turns with the server error' test/codex-app-server.test.js: 1 passed; directly verifies retained terminal execution/status/error/item types.
- git diff --check -- src/codex-app-server.js: passed.

No live services, tasks, models, or database mutations were performed by this review. No broad suite was run.

Non-blocking: The prior historical pre-dispatch positive regression was replaced by the historical terminal-schema positive; its mechanism was inspected, but dedicated positive coverage should be retained when the regression suite is next maintained.
Non-blocking: Actual browser request, real model-generated engineer plan, worker-produced file, host check, verifier, and visible accepted output remain the lead's required acceptance work. These tests establish repair mechanics only.

Pitfall: Provider-compatible schema shape and stub-provider acceptance do not establish that an actual model can plan, dispatch, and complete the owner's requested work.

## Follow-up delta review

Verdict: APPROVE
Blocking: none.
Status: complete
Scope expansion: none

Compared only src/concurrent-delivery-engine.js and test/server-delivery-engine.test.js with the exact checkpoint-before-followup copies. Role enum, prompt policy, and host sanitizer now exclude the same canonical verifier/auditor/review/coordinator roles. Configured engineer tasks remain allowed; host-owned verification is preserved. Dependency output guidance does not weaken validation.

Completed planning-only recovery still requires the original failure shape and matching project/session/thread/scope/account/home/owner generation. It additionally requires matched saved start and completed terminal identities, an old phase identity proven gone, terminal/start flags, and confirmed background-terminal cleanup bound to the same generation/process/thread/turn. Authoritative thread/read must contain exactly that sole completed turn and exactly userMessage, reasoning, agentMessage in order. Command, file, MCP/tool, additional-turn or additional-item evidence therefore refuses this path. Existing all-run lifecycle/effect checks remain. The branch accepts only paused_owner/canceled objectives and does not mutate their disposition; recoverStoredRuns starts only planning/executing objectives, so a paused diagnostic is not resumed.

Ran env -u NODE_TEST_CONTEXT node --test --test-name-pattern='restart settles a completed rejected plan for a paused objective|planner sends a strict usable schema' test/server-delivery-engine.test.js: 2 passed, 0 failed. The new real-engine/stub-provider HTTP regression proves a fresh task completes while the historical objective remains paused_owner. Role/schema check verifies engineer is allowed and host-only roles excluded. git diff --check -- src/concurrent-delivery-engine.js test/server-delivery-engine.test.js passed. No broad tests or live data/service operations were performed.

Actual model/worker/file/host-check/verifier/browser acceptance remains pending and is owned by the lead. This approval covers only the bounded source delta.
