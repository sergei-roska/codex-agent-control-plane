# Blocker extraction handoff

Status: complete.

Implemented and exported `extractBudgetBlockers()` in `src/budget-watcher.js`.
It validates the account hash, provider, and requested model list; emits blockers
only from explicit reached-limit or ordinary-usage-blocked evidence; normalizes
reset hints; filters unrelated models; and deterministically deduplicates stable
window records. Source keys for model-limit snapshots are represented by a
stable digest, so raw response fields are not copied into durable records.

Added focused coverage in `test/budget-watcher.test.js` for generic primary and
secondary windows, model filtering, no-window reached limits, ordinary blocks,
reset-only and ambiguous responses, invalid identities, and deduplication.
Delta repair: child window IDs now include their source ID, including the stable
digest for each `rateLimitsByLimitId` key. This preserves primary/secondary
windows from distinct limit snapshots while retaining deterministic exact-record
deduplication.

Verification:

- `node --test test/budget-watcher.test.js` - passed after the delta, 45 tests, 0 failures.
- `git diff --check` - passed, no output.

This helper/test slice does not implement full AD-03 integration. No Git state
was changed; inherited `:memory:.lockdb` was left untouched.
