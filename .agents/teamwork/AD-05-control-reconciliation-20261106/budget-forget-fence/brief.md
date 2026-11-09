# AD-05 budget-watcher cancellation fence

## Goal

Prevent a forgotten legacy budget-paused run from being automatically resumed
when owner cancellation races an in-flight account-switch operation.

## Ownership

Own only `src/budget-watcher.js`, `test/budget-watcher.test.js`, and this task
handoff. Do not edit server/orchestrator/account UI or AD-04 lead-graph files.

## Acceptance

1. `runCheck` revalidates that the exact pause entry is still current
   immediately before invoking `resumeRun`.
2. A deterministic deferred `accounts.switchTo` test calls `forget()` while the
   switch is in flight, releases the switch, and proves `resumeRun` is not
   called.
3. Existing successful account-switch/resume and retry behavior remains intact.
4. Run `node --test test/budget-watcher.test.js`; report the result and changed
   paths. Do not stage or commit.

## Constraints

No live providers, accounts, credentials, quota use, or runtime activation.
Keep output in English with ASCII punctuation.
