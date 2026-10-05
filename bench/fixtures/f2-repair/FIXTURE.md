# F2 bounded code repair

Class: bounded code repair. Acceptance required. Check: `npm test`.

Setup: `src/price.js` `applyDiscount` treats a whole-number percentage as a
fraction. Failing test: "applyDiscount takes a whole-number percentage off".

Expected: disposition `accepted`; changed files are exactly `src/price.js`.
`REFERENCE_FIX.patch` is for our validation test only; never copy it into a trial.
Grader: `node bench/graders/f2.js --final <file> --workspace <dir> --disposition accepted`.
