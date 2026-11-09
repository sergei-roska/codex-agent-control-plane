# AD-05 budget-watcher cancellation fence

Status: complete.

## Changes

- `src/budget-watcher.js`: revalidate the current entry identity and stopped
  state immediately before recording resume history and invoking `resumeRun`.
- `test/budget-watcher.test.js`: hold `accounts.switchTo`, forget the run while
  the switch is pending, then release it and assert that no resume occurs.

## Verification

- `node --test test/budget-watcher.test.js`: 33 tests passed, 0 failed.
- No staging or commit performed.
