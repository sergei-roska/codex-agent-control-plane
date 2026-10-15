# AUT-01 planning baseline — mandatory inventory (projection IDs)

Independently reviewed mandatory requirement and acceptance-criterion inventory
for the frozen feature in `canonical-input.md`. These projection IDs are stable
and are the denominator of the `requirement_preservation` metric.

## Mandatory requirements

- **REQ-1** — `applyDiscount(total, pct)` must interpret `pct` as a whole-number
  percentage: `applyDiscount(200, 10) === 180`.
- **REQ-2** — the failing test `test/price.test.js` must remain unchanged (an
  explicitly forbidden write path).
- **REQ-3** — the change is bounded to `src/price.js`; no other file changes.
- **REQ-4** — existing behavior is preserved: `applyDiscount(200, 0) === 200`
  (zero-percent is a no-op), and `subtotal`/`withTax` are unaffected.

## Mandatory acceptance criteria

- **AC-1** — `npm test` passes (all four tests, including the failing
  "applyDiscount takes a whole-number percentage off" and the zero-percent
  no-op).

## Scoring rule

`requirement_preservation` = number of mandatory IDs (REQ-1..REQ-4, AC-1)
explicitly satisfied by the current-workflow planning output, divided by 5.
An ID is "explicitly satisfied" only when the output states the constraint
as a bound on the task; an implicit or unstated constraint is not satisfied.
