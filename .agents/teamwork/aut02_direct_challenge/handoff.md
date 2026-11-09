# AUT-02 direct challenger handoff

Status: complete for scoped direct origin/thread regression. Final verdict HOLDS; graph validation remains separate.

Frozen pre-repair failure at source SHA-256 `481dd650ad801b25fa968e157e8f408086b7592ab90ca65e41cac31d412d1f85`: valid B origin paired with A thread reached App Server and produced an accepted B receipt. Archived in `docs/evidence/aut-02/challenge/report.md`, `thread-origin-baseline.cjs`, and `thread-origin-baseline-output.txt`.

Final direct source SHA-256 `95281c89bdab68f0aae8e0375b2f72930d9e4fa3868670f66600056144717234`; test SHA-256 `ab5408a7be89c86bc42c6e70be2e7ef171e3c9255c6ff47da5eb349760076089`, matched before and after validation. `node docs/evidence/aut-02/challenge/thread-origin-regression.cjs` passed: same-run and cross-run forged threads rejected before App Server with nonaccepted review and `review_origin_stale`. Four named direct controls passed 4/4, including unknown versus proven tuple mismatch classification. Full commands and outputs in `docs/evidence/aut-02/challenge/regression-report.md`, `thread-origin-regression-output.txt`, and `direct-controls.tap`.

No source, existing test, or graph file edits from this challenger.
