# Legacy AD-01 implementation handoff

Status: implementation complete; lead review pending.

## Changes

- `src/server.js` now pins `{ projectId, workspace, taskId }` on each new legacy task and confirms the task record contains the binding and an explicit acceptance contract before starting the run.
- Legacy resume refuses to dispatch when the stored binding is absent or differs from the current project, canonical workspace, or task ID. The task remains input-required.
- The effective acceptance contract, including an empty `requiredChecks` list, is stored at intake. The graph checkpoint continues to own its existing goal and contract; dispatch journal rows and attempt IDs are unchanged.
- `test/e2e.test.js` covers close/reopen recovery of objective binding, pinned checks, checkpointed owner input, and journal attempt identity; no-check intake; and a changed-workspace refusal.

## Verification

- `node -c src/server.js && node -c test/e2e.test.js` - passed.
- `node --test test/e2e.test.js` - 12 passed, 0 failed, 0 skipped.
- No full suite, live provider, quota, or Git state operation was used.

## Limits and next action

- Existing legacy tasks without a persisted objective binding cannot safely prove their original workspace/project. Resume is refused even if a checkpoint has goal/check state; inventing the missing scope would violate the identity contract.
- `src/delivery-provider-identity.js` can safely hash `tokens.account_id` from auth metadata without storing raw credentials or email. However, the legacy journal intent is written in `src/lead-graph.js` before sending the A2A request; the actual worker `appServer.run()` happens later in `src/a2a-role-service.js`.
- `createSwitchingAppServer.getCodexHome()` returns its current home without settling profile changes. `tracked()` settles and may swap homes before the actual run. Existing `expectedCodexHome` protection can refuse a changed home, but the legacy role call does not pass that pin. Capturing the hashed identity at `recordSubmitting` can therefore record a different account from the one that executes the worker if the active profile changes before `appServer.run()`; hashing the profile home would not prove account identity.
- Attempt-time identity cannot be bound race-safely within the allowed files. A safe change needs a boundary at the actual role `appServer.run()` call (and a durable update/refusal path for the journal attempt), which is outside the authorized paths. No account field was added.
- Recheck evidence: `node --test test/delivery-provider-identity.test.js test/app-server-switch.test.js` - 12 passed, 0 failed. Existing tests confirm auth metadata replacement is detected when read by path, and that home changes are blocked only when `expectedCodexHome` is supplied.
- Lead: decide whether to authorize the role-service/switching boundary change in a follow-up.
