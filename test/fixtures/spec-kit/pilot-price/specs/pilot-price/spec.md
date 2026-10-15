# Pilot Price Repair

Status: candidate; lead acceptance pending.

## User story

As a caller of the price helper, I need a whole-number percentage discount so that `applyDiscount(200, 10)` returns `180`.

## Requirements

- REQ-1: interpret `pct` as a whole-number percentage.
- REQ-2: keep `product/test/price.test.js` unchanged.
- REQ-3: limit product changes to `product/src/price.js`.
- REQ-4: preserve zero-percent, subtotal, and withTax behavior.

## Acceptance

- AC-1: plan the existing four-test fixture check; no test is run by this checker.
