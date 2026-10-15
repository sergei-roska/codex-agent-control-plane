# Current lead planning artifact before AUT-01

Capture kind: manual planning artifact authored by the current lead during the
owner-authorized AUT-05 review. This is actual newly authored planning output,
not a historical harness/A2A result and not a paid model benchmark.

## Goal and source inspection

Repair bench/fixtures/f2-repair so applyDiscount accepts a whole-number
percentage. Canonical goal: "Fix the failing price test without changing tests."
The inspected source returns total - total * pct, while the existing test expects
applyDiscount(200, 10) to equal 180. The existing zero-percent test expects 200.

## Proposed task T001

Role: engineer. This is a planning proposal; no writer is dispatched.

Objective: correct applyDiscount in src/price.js for whole-number percentages,
preserve the zero-percent case and existing subtotal/withTax behavior, and pass
the existing fixture checks without modifying tests.

Implementation write scope: exactly src/price.js within an isolated copy of the
fixture. No other product file may change. test/price.test.js and CHECKS.json are
read-only inputs; REFERENCE_FIX.patch is validation-only and is not an input to
the implementation worker.

Read GOAL.txt, CHECKS.json, FIXTURE.md, src/price.js, and test/price.test.js.
Prior evidence is the inspected source/test mismatch at the frozen input revision.

Acceptance: the percentage example yields 180, a zero-percent discount yields
200, subtotal and withTax remain compatible with their existing tests, and the
unchanged test suite passes. The candidate diff changes only src/price.js.

Planned checks: run npm test from the isolated fixture root; inspect the actual
diff and compare protected test/check inputs to their original digests. These
checks have not been executed as part of this planning artifact.

Review plan: routine implementation followed by independent verifier on the
integrated candidate. The effective workspace-write verifier needs a separately
authorized check scratch path; do not grant writes to the protected product tests
to satisfy its contract. Resolve that operational scope before actual dispatch.

Dependencies: T001 is the only implementation task. No parallel execution is
proposed. Stop if a test modification, additional product path, unresolved product
decision, or changed canonical input is required.

## Coverage limitations

This proposal states the substantive requirements but is not a machine task map:
there are no stable canonical requirement/acceptance links, typed context schema,
validated assignment envelope, or automated traceability report. AUT-01 can be
compared on those structural capabilities against these frozen bytes. Missing
literal IDs must not be scored as loss of the substantive constraints above.

No claim is made about historical harness planning quality, first-pass acceptance,
model identity, token usage, cost, or elapsed execution time.
