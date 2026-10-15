# AUT-01 planning baseline - mandatory inventory (projection IDs)

Mandatory requirement and acceptance-criterion inventory for the frozen feature
in `canonical-input.md`. These IDs identify semantic criteria; a planning artifact
does not need to repeat literal IDs to preserve a criterion.

## Mandatory requirements

- **REQ-1** - `applyDiscount(total, pct)` must interpret `pct` as a whole-number
  percentage: `applyDiscount(200, 10) === 180`.
- **REQ-2** - the failing test `test/price.test.js` must remain unchanged (an
  explicitly forbidden write path).
- **REQ-3** - the change is bounded to `src/price.js`; no other file changes.
- **REQ-4** - existing behavior is preserved: `applyDiscount(200, 0) === 200`
  (zero-percent is a no-op), and `subtotal`/`withTax` are unaffected.

## Mandatory acceptance criteria

- **AC-1** - `npm test` passes (all four tests, including the failing
  "applyDiscount takes a whole-number percentage off" and the zero-percent
  no-op).

## Scoring rule

`requirement_preservation` = mandatory semantic criteria preserved by the
current-workflow planning artifact divided by five. An independent reviewer
maps each criterion to artifact evidence. Missing literal IDs are reported as a
separate structural traceability gap, not as semantic requirement loss. AC-1 is
scored as a stated planned acceptance criterion; no test execution is inferred.
