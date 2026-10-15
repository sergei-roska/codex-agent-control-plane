# AUT-01 planning baseline - current-workflow output (pre-AUT-01)

This is the planning output produced by the current harness workflow for the
frozen feature, captured BEFORE any AUT-01 checker or decomposition skill
exists. It is recorded verbatim and is not pre-corrected; its omissions are the
point of the baseline.

The current workflow emits a single, informal implementation task with no
requirement/acceptance traceability and no typed write scope:

```text
Task: fix applyDiscount in src/price.js so the price test passes.
```

That is the entire planning output. Notes recorded honestly:

- No requirement IDs (REQ-1..REQ-4) or acceptance criterion ID (AC-1) are
  enumerated.
- The forbidden path (do not modify `test/price.test.js`) is not stated as an
  explicit constraint; it is only implied by the fixture's grading rule.
- The bounded write scope (`src/price.js` only) is not stated as a typed
  boundary.
- There is no dependency chain, no parallel-task annotation, and no planned
  check beyond the goal's own mention of the failing test.
