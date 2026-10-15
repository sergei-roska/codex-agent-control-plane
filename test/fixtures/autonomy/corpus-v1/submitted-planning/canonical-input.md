# AUT-01 planning baseline — canonical feature input

Frozen canonical input for the representative feature selected for the AUT-01
planning baseline. Parent: `docs/aut-05-baseline-runbook.md` section 6.

## Feature

Bounded code repair of `bench/fixtures/f2-repair`. Goal (verbatim from
`GOAL.txt`): "Fix the failing price test without changing tests."

## Canonical source files (frozen with sha256)

| Path | SHA-256 |
|---|---|
| `bench/fixtures/f2-repair/GOAL.txt` | `666a1d5f055274475714f1e6fe8510079dc3bd787bdf079251525a5d39968bf7` |
| `bench/fixtures/f2-repair/CHECKS.json` | `df3aff1a7c0f972282e8b976d0cd05089eb06dff00793bd6f113941b31011860` |
| `bench/fixtures/f2-repair/FIXTURE.md` | `83aaa2fa7bf0b8c899c487c4589195295c8884b091faeb882ca7e83ce64d44f4` |
| `bench/fixtures/f2-repair/src/price.js` | `775708a5693f857c2493b6e662e1e3ebbb6da9050d05123222f9c817fff5acc0` |
| `bench/fixtures/f2-repair/test/price.test.js` | `f0532faca004df9074aed1f3094ee087851e689f3050e0389e26d8d03e0ef0b6` |

## Known defect

`applyDiscount(total, pct)` treats `pct` as a fraction (`total - total * pct`)
instead of a whole-number percentage. The failing test
`applyDiscount takes a whole-number percentage off` expects
`applyDiscount(200, 10) === 180`, but the current code returns `200 - 2000`.

## Known acceptance boundary

- Check: `npm test` (all tests green).
- Disposition: `accepted`; changed files are exactly `src/price.js`.
- `REFERENCE_FIX.patch` is a validation-only artifact and is never copied into a
  trial.
