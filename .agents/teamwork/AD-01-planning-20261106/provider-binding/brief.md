# AD-01 legacy provider invocation identity

Role: junior_worker (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Baseline source: `ab5c195` plus the lead-reviewed, uncommitted legacy objective binding. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `contract.md`, the Sol consultation in `../provider-binding-brief.md` and your handoff at `../legacy-implementation/handoff.md`, then re-read `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Implement the legacy provider invocation binding contract at the real `appServer.run` boundary. A provider/account identity must not be sampled before A2A dispatch and later misattributed after a profile switch. Persist an append-only `call_bound` record for every provider call linked to the existing dispatch attempt and role task. A separate call after rejected continuation gets a new invocation ID. A missing identity or failed durable bind must prevent the provider call. Do not add automatic account switching/failover or infer turn success from a binding record.

## Allowed files

- `src/app-server-switch.js`
- `src/delivery-provider-identity.js` (read-only unless the integration requires a narrowly justified extension)
- `src/durable-store.js`
- `src/server.js`
- `src/a2a-role-service.js`
- `src/lead-graph.js`
- `test/app-server-switch.test.js`
- `test/delivery-provider-identity.test.js`
- `test/durable-store.test.js`
- the existing A2A role service test file(s) identified by `rg --files test`
- `test/e2e.test.js`

Inspect current code and edit only the minimum needed. No other worker owns these legacy files. Do not edit concurrent path files or tracked docs.

## Acceptance

- A callback/receipt at `createSwitchingAppServer.tracked('run')` captures the selected target's hashed account identity after settle and while in-flight is held, before `target.run`. It is awaited; a failed callback prevents dispatch. Preserve `expectedCodexHome` checks and cleanup of the reservation on every path.
- Durable call records are append-only, reopen-safe, unique by attempt/invocation, idempotent only for identical replay, and reject conflicting replay. They link runId, attemptId, assignmentId, worker taskId, invocationId, hashed accountId, and bound time. No raw token, raw account ID, email, or raw Codex home path is stored.
- The role service and lead dispatcher pass the existing attempt correlation to the actual provider call and durably bind it before the provider can run. Continuation fallback uses separate invocation IDs.
- Tests cover profile switch before selection, attempted switch while binding is held, auth identity unavailable, persistence callback failure, idempotent/conflicting replay, SQLite reopen, and one A2A attempt with two provider calls. No live provider is used.
- Run focused tests for touched modules and the legacy e2e suite; report exact commands/counts. No full suite unless focused results justify it.

Update only `.agents/teamwork/AD-01-planning-20261106/provider-binding/handoff.md`. Report any test adapter that cannot provide the required boundary instead of silently skipping the requirement. No Git state changes. Final under 200 words, with `Status` and `Scope expansion`.
