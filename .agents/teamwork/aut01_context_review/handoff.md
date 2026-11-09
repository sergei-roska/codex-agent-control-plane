# AUT-01 semantic context review

Verdict: REJECT
Status: partial
Scope expansion: none

Target hashes: `pilot-context.json`
865bd81913a2efbdc9e60bd9998c807aa287bc4e5612db16ced714754f7d87ff;
`traceability.json`
65e5d12a1eff0a757b264fc12804325b4d213804ab58eea9d1ca039697974b19.
The lead has not authored `accepted-context.json`; this report reviews the
candidate semantics only.

Blocking: `test/fixtures/spec-kit/pilot-price/context/pilot-context.json:240`
[read] `EVID-ACCEPTANCE-TESTS` describes whole-number discount, zero-percent,
subtotal, and withTax, but its cited product-test span is lines 11-21.
The subtotal test is at lines 7-9, so the cited evidence does not substantiate
one claimed behavior. The separate REQ-4 mandatory-inventory span correctly
identifies the behavior, but does not fix this priorEvidence source location.
Set this evidence span to lines 7-21, then recompute the context digest and
update the task map's `contextSha256` before lead acceptance.

Other reviewed criteria: PASS [read]. Frozen F2 GOAL, CHECKS, FIXTURE, package,
source, and test copies are byte-identical to `bench/fixtures/f2-repair/`.
Canonical input/inventory bytes are unchanged. REQ-1 through REQ-4 and AC-1
cover the accepted five semantic criteria with correct inventory line ranges;
shared AC-1 links all four. The only product write allow is the exact price
source; product test, check definition, and package paths are denied. The
separate verifier directory is allowed for operational artifacts. Two explicit
empty-tag risk rules classify the permitted paths as routine; no auth or
performance risk is invented for F2. CHECK-1 plans the npm product suite with
timeout and verifier write scope; no execution is claimed. T001 links all four
requirements and AC-1, has no dependencies or parallel execution, stays within
the product write scope, and references pinned prior evidence. The map's
context digest matches the candidate context bytes.

Verification [ran/read]: `sha256sum` confirmed current context and map hashes
and byte-preserving product/canonical copies. `nl -ba` on the F2 product test
showed subtotal lines 7-9, discount lines 11-13, zero-percent lines 15-17,
and withTax lines 19-21. No product tests were run; the original defect is
intentional. Source modules and test implementation were outside this review.
