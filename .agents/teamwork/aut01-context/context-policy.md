# Lead context policy for AUT-01

Prepared while AUT-05 re-verification is pending. Implementation may start only
after the lead records AUT-05 baseline_ready and A0 succeeds.

Representative feature is the frozen F2 repair. Mandatory inventory is REQ-1
whole-number percentage, REQ-2 protected tests, REQ-3 exact product file scope,
REQ-4 zero-percent/subtotal/withTax compatibility; AC-1 plans unchanged npm test
and candidate/protected-byte review. Shared AC-1 may link all four requirements.
No product code or protected fixture is repaired in this milestone.

Copy bench/fixtures/f2-repair/{GOAL.txt,CHECKS.json,FIXTURE.md,package.json,
src/price.js,test/price.test.js} byte-for-byte into the isolated fixture.
Retain sources under canonical/ for goal/inventory as needed. Do not copy
REFERENCE_FIX.patch into an implementation input. Fixture root is the caller's
trusted workspace; all context/map paths are relative to that root.

Allowed scope is file product/src/price.js and directory verification/checks.
Deny file product/test/price.test.js, file product/CHECKS.json and file
product/package.json; no implementation proposal requests verification paths.
Verifier's approved operational scope is directory verification/checks. This
operational permission is outside the product and does not permit test edits.
Document that typed paths are planning policy; live harness prefix scopes are
weaker and require later candidate-effect enforcement.

Routine risk is independently reviewed for this simple arithmetic repair.
Explicit riskRules classify both allowed paths with riskTags=[]; unknown paths
or decisions block. Synthetic tests add separate security/performance tags and
graphs; do not attribute them to F2 requirements or the frozen planning capture.
Prior evidence is the pinned goal, original mismatch and fixture acceptance.
Approved planned check: argv=["npm","--prefix","product","test"], timeoutMs=60000,
with explicit verifierWritePaths. It is never executed by the checker.

One engineer task T001 covers REQ-1..REQ-4 and AC-1, no dependencies, parallel=false,
review kind routine, explicit checkpoint/reason/stops and prior evidence.
Independent review must confirm context completeness, source spans, scope and
risk interpretation before accepted-context.json records the context digest.
The worker can prepare candidate context/map, but cannot accept its own context.

The semantic baseline is already 5/5; improvement claims concern explicit
traceability, deterministic defect detection and proposal validation only.
