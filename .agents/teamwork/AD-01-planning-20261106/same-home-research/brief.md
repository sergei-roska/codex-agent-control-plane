# AD-01 same-home credential identity boundary

Role: explorer (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, the provider-binding contract/handoff, `src/delivery-provider-identity.js`, `src/app-server-switch.js`, `src/codex-app-server.js`, and `/home/sr/codex-work/agents/explorer.toml`.

## Goal

Resolve the remaining factual question: when `auth.json` changes to another account inside the same Codex home while an App Server instance is running, what account identity does the provider process actually use for the next `run`? Determine whether existing account-read protocol output can authoritatively identify that process's loaded account and whether the wrapper's current file hash could misattribute it.

## Report

Write only `map.md` in this directory, under 700 words. Trace the real child-process lifecycle, auth loading/configuration, account/read request and response shape, wrapper instance reuse/settle/swap rules, and any existing tests for credential changes. Use file:line evidence. Label confirmed facts versus inference. Recommend the smallest implementation/test files needed to close the identity guarantee, but do not edit code/tests/config or tracked docs and do not call a live provider. No tests or Git operations.

Return under 150 words, ending with `Status: complete | partial | blocked` and `Scope expansion: none`.
