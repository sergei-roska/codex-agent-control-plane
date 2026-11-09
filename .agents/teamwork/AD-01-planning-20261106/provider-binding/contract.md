# Legacy provider invocation binding contract

Luna lead owns scope, integration, and acceptance. This contract uses the bounded Sol recommendation in `../provider-binding-brief.md`; implementation remains assigned to Luna.

## Identity event

- A provider invocation is one call to `appServer.run`, including a fresh call after a rejected continuation. It is not the same as a lead dispatch attempt and does not prove a model turn was sent or completed.
- Allocate a unique invocation ID for each call. Append a durable `call_bound` record linked to the run, attempt, and assignment. A2A role attempts require their real worker task ID. A lead-planning coordinator attempt has no worker task, so its task ID is null and its coordinator role/assignment are validated explicitly; never fabricate a worker ID.
- Capture the identity only after `createSwitchingAppServer` settles and selects its target, while its `inFlight` reservation is held, immediately before the target run. Do not sample `getCodexHome()` in `lead-graph` before A2A dispatch or after the call.
- Store the existing hash of `tokens.account_id`; do not persist auth tokens, account email, raw account ID, or raw Codex home path. The identity is the selected configured credential identity, not proof of provider transmission or effect.
- If identity cannot be read or the durable callback fails, do not invoke the target provider. Preserve the existing error classification and report no turn success.
- Binding without terminal execution evidence remains outcome-unknown after restart. A coordinator attempt is terminal only after its App Server call resolves or rejects; this does not establish turn start/completion/effect. Never overwrite an earlier binding from the currently active profile. Rejected-continuation then fresh-call paths get separate invocation records.
- Do not change account selection, profile switching policy, budget waiting, or cross-account context transfer. Those remain AD-02/03.

## Coordination

The legacy task owner has the first implementation scope. If code requires an unlisted file, stop that edit and report the exact path and mechanism. Do not edit concurrent-path files or tracked planning documents. Preserve the already accepted objective binding and all inherited user changes. No live provider/quota use or Git operations.
