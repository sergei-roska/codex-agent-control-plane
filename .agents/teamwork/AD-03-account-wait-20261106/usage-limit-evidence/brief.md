# AD-03 preserve trusted worker usage-limit evidence

## Goal

Preserve the already-classified typed Codex usage-limit signal through the concurrent delivery role service into the durable attempt result. Do not add waiting, retries, account switching, or generic error inference in this task.

## Verified context

- Explorer trace: `.agents/teamwork/AD-03-account-wait-20261106/usage-limit-evidence/exploration.md`; `src/delivery-role-service.js` records `failureCode` from the provider exception and `resultAdapter()` currently converts every terminal non-success into a generic failure result.
- `classifyCodexError` in `src/contracts.js` recognizes provider typed usage-limit evidence (`codexErrorInfo` / typed HTTP 429). `CodexAppServer.classifyFailure` already uses it.
- Keep the full terminal/process/effects proof checks intact.
- Cwd `/home/sr/Projects/Workspace/codex-agent-control-plane`, HEAD `435afa3` plus active edits. Leave `:memory:.lockdb` untouched and do not change Git state.

## Ownership

Own only `src/delivery-role-service.js`, `test/delivery-role-service.test.js`, and this task directory. No controller, engine, watcher, server, or store edits.

## Acceptance

1. At the trusted terminal failure catch, persist a bounded `failureKind: 'usage_limit'` only when `classifyCodexError(cause) === 'usage_limit'`; do not infer from message text or bare status codes.
2. The terminal result adapter returns `failureKind: 'usage_limit'` for that record, while unrelated terminal failures retain their existing classifications.
3. Add deterministic regressions for typed provider usage-limit evidence versus an unrelated/bare 429 error.
4. Preserve all existing proof and settlement behavior.
5. Run the focused role-service tests (or named relevant tests if the file is long) and `git diff --check`.

Write exact evidence to `handoff.md`. This is only an evidence-preservation slice, not AD-03 waiting integration.
