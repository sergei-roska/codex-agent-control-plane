# AUT-01 Phase 1 qualification

Status: accepted for the offline artifact pilot. The exact lead decision and
input/output/source hashes are in [acceptance.json](evidence/aut-01/acceptance.json).
Prior work was committed as `a3b28a5` before AUT-01 implementation.

The deterministic read-only CLI validates the accepted F2 context, task map,
requirement/acceptance coverage, dependency graph, Markdown projection, typed
scope, risk rules and every implementation/review proposal through both actual
harness contract boundaries. Its [report](evidence/aut-01/analysis-report.json)
has no findings, covers REQ-1 through REQ-4 plus AC-1, validates engineer and
verifier proposals, and keeps `implementationAcceptance: not_evaluated`.

The accepted context SHA-256 is
`44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf`.
The final analysis fingerprint is
`2f6accab6c0342b50bb61701555621bc51105cffdbf17be500028b284e015e25`.
Original product source/tests/check definitions remain byte-identical to the
intentionally unrepaired F2 fixture. Verifier operational scope is separate.

## Verification and review

[Final verifier](evidence/aut-01/final-verifier.md) and
[final auditor](evidence/aut-01/final-audit.md) approve the integrated candidate.
[Verification results](evidence/aut-01/verification-results.json) retain 38/38
focused leaf passes, 22/22 supplemental negative probes blocked, and the full
suite with 1183 tests: 1182 pass, zero failures and one optional skip.
The exact commands and source hashes are retained; temporary logs may disappear.

The [qualification mapping](evidence/aut-01/qualification-map.md) and retained
[probe source](evidence/aut-01/qualification-probes.cjs)/
[results](evidence/aut-01/qualification-probe-results.jsonl) cover Q01-Q28,
including previously missing malformed-field, item-count, vanished-input and
boolean-as-number variants. Initial P1.1 review also found nested TypeErrors
and in-root symlink aliases to denied writes; both were fixed and independently
reverified before dependent implementation.

## Comparison and limits

[The comparison](evidence/aut-01/comparison.json) retains the same accepted
AUT-05 v3 baseline and all original bytes. That manual artifact already scored
5/5 for semantic requirements. The supported gain is explicit machine
traceability, reproducible seeded-defect detection and validated proposals.
No new numeric semantic score or live-model quality/savings claim is asserted.
Measured checker duration describes one local process only.

Generated evidence remains under `artifacts/autonomy/aut-01-pilot-price/` and is
also retained in the durable evidence directory. The snapshot detects observed
drift but is not atomic under concurrent writers. Typed planning scopes require
separate candidate-effect enforcement before live prefix-based harness scopes
can be considered equivalent. No runtime gate, enrollment, installed skill,
model call, product repair, planned product test or live project action follows
from this offline acceptance.

Next: assess a separate intervention plan after the requested quota boundary.
AUT-01 source and evidence are retained as a separate change following the
AUT-05 baseline commit `a3b28a5`.
