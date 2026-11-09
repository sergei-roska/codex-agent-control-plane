# AD-03 extract provider-reported blocking windows

## Goal

Add a pure helper that converts authoritative provider limit snapshots into the explicit blocker record format already accepted by `BacklogStore`. Reset times remain scheduling hints, and timestamps alone never create a blocker.

## Verified context

- `src/budget-watcher.js` exports `isBudgetAvailable()` and `parseResetsAt()`; its accepted snapshots use `ordinaryUsageAllowed`, `rateLimits`, `rateLimitsByLimitId`, `normalModelSlug`, `rateLimitReachedType`, and nested `primary` / `secondary` windows.
- `src/backlog-store.js` requires each blocker to have `accountIdHash`, `provider`, `model`, `windowId`, `reasonCode`, and millisecond `resetsAt` or null.
- Context trace: `.agents/teamwork/AD-03-account-wait-20261106/usage-limit-evidence/exploration.md`.
- Cwd `/home/sr/Projects/Workspace/codex-agent-control-plane`; preserve active files, do not change Git state, leave `:memory:.lockdb` untouched.

## Ownership

Own only `src/budget-watcher.js`, `test/budget-watcher.test.js`, and this task directory.

## Contract

Export `extractBudgetBlockers(response, { accountIdHash, provider, models })`.

- Validate the supplied SHA-256 account hash, bounded provider identity, and non-empty unique requested models.
- Emit blockers only when the provider explicitly indicates a limit is reached, or `ordinaryUsageAllowed === false`. Future/past `resetsAt`, usage percentages, missing responses, and unknown fields alone must emit no blockers.
- Consider the generic `rateLimits` snapshot and each `rateLimitsByLimitId` snapshot applicable to a requested model. Skip model-specific snapshots for another model.
- When a reached snapshot has `primary` / `secondary` window records, emit every such provider window. If it has no child window but explicitly indicates a limit, emit one stable source-level window ID. For `ordinaryUsageAllowed === false` without a reached snapshot, emit one stable generic blocked window per requested model.
- Normalize reset hints via `parseResetsAt()` to integer epoch milliseconds, else null. Use a stable valid `reasonCode`; do not copy raw response fields into durable records.
- Deduplicate exact account/provider/model/window records and preserve deterministic output ordering.

## Acceptance

Add tests for generic short/weekly windows, model-specific snapshots and unrelated-model exclusion, explicit no-window ordinary block, reset-only non-block, null/ambiguous response, malformed identity, and deterministic dedupe. Preserve existing watcher behavior.

Run `node --test test/budget-watcher.test.js` and `git diff --check`; write exact results in `handoff.md`. This helper is not full AD-03 integration.
