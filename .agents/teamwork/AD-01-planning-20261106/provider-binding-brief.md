# AD-01 provider-attempt identity consultation

Role requested by owner: Sol is a bounded architectural consultant. Luna remains lead and owns any implementation, integration, and acceptance. Return a recommendation only; do not edit or run commands.

Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, this file, and `/home/sr/codex-work/agents/senior_worker.toml` before answering. Source baseline: `ab5c195`; current code includes the uncommitted AD-01 objective binding and test changes. Do not modify any files or Git state.

## Question

What is the narrowest safe boundary to record the effective provider/account identity for each legacy worker attempt, so identity cannot be misattributed if the active profile changes between dispatch intent and the actual model call, and the identity remains recoverable after a crash/restart?

## Verified facts to check

- `DispatchJournal.recordSubmitting` is called before A2A send in `src/lead-graph.js` around lines 3335, 3507, 3546, and 3729.
- The actual worker provider call is `appServer.run()` in `src/a2a-role-service.js` around line 1045.
- `createSwitchingAppServer.tracked()` in `src/app-server-switch.js` settles profile changes and selects its target only when the method is invoked; its `getCodexHome()` accessor returns currentHome without settling. `expectedCodexHome` can fence a changed home when supplied.
- `src/delivery-provider-identity.js` hashes the auth metadata `tokens.account_id` and pairs it with canonical codexHome. Do not expose raw auth tokens or email.
- AD-01 needs attempt-account binding. AD-02 owns automatic account selection/context transfer. Do not blend those outcomes.

## Deliverable

Give the recommended event/binding boundary, the minimum data that must be durably attached to the attempt, crash windows and recovery rules, and a disjoint implementation/test file set. Identify whether the stored binding should be journal intent, actual-call receipt, or both. Keep under 600 words, cite `file:line`, label read facts versus inference, and list at most two viable alternatives if the evidence does not support one answer. Return findings to Luna only; do not change scope or take over team coordination.
