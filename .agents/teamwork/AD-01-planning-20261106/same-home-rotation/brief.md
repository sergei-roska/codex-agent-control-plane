# AD-01 same-home auth rotation fencing

Role: junior_worker (Luna), follow-up to lead-binding implementation. Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `same-home-research/map.md`, the provider-binding contract, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Prevent a call from being attributed to a new `auth.json` account while using an App Server instance created before that same-home identity change. Pin the hashed configured account identity to each cached App Server generation. If the identity file changes and no call is active, close/recreate the same-home instance before the next bound provider call; if another call is active, fail the new call closed without disturbing it. Recheck identity after the awaited durable binding callback and immediately before target invocation.

This establishes a repository-enforced process-generation boundary. It does not prove the external CLI's credential reload behavior; document that remaining runtime assumption for AD-08 qualification. Do not claim that `call_bound` proves provider turn start/completion/effect.

## Allowed files

- `src/app-server-switch.js`
- `test/app-server-switch.test.js`
- this task's `handoff.md`
- the parent lead-binding handoff for a concise cross-link

Do not modify `src/codex-app-server.js` or its account/read schema unless a test proves this is unavoidable; report the exact required path before expanding. No other agent owns these source/test paths. No Git state changes, live provider calls, credential edits outside temporary test homes, or real quota use.

## Acceptance

- Initial call binds to the identity hash captured for the selected cached App Server generation.
- Rewriting `auth.json` from account A to B at the same home never invokes the old generation under B's hash; the wrapper creates a new generation and only then allows the new bound call.
- An identity change while another call is in flight does not close/kill that call and does not allow a second provider invocation on either ambiguous generation. After settlement, retry creates a fresh generation.
- An identity change during the awaited binding callback is detected before `target.run()`.
- Missing/invalid identity, recreation failure, close failure, or callback failure remains fail-closed. Account hashes only; do not retain raw IDs or tokens.
- Existing profile switching, expectedCodexHome checks, worker-call binding, and lead-call binding remain intact. Run focused wrapper, durable-store, and e2e checks where inputs remain applicable; report exact commands/counts.

Update the task handoff and note that official App Server docs describe `account/read` as current account information but do not specify same-home credential-file reload or expose a stable account ID in examples. No live account/read call is allowed in this task.
