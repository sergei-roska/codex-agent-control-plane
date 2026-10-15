# AUT-05 implementation review and correction record

Status: corrected cohort v3 is accepted as `baseline_ready` for bounded offline
artifact comparison. Submitted v1 and corrective v2 remain unaccepted.

## Reviewed input

The submitted AUT-05 implementation was untracked on top of harness commit
`63eb95918c3986f3ad5ac237c22a6bafc5ef5530`. The initial cohort was
`test/fixtures/autonomy/corpus-v1/` with these input digests:

- Corpus: `87b3f2bc9292e92d71607096a932f9090069dc45a27453943728d8d1ac0f8e7b`.
- Observations: `a1ed7344cad8f4fece77436ac3022fd25194999ab1d4255ca9e93f7881431417`.
- Baseline: `6a9f015f2707658fc516c3c63e5226ae8f95a9bbbe17b2cdf278f11761389cea`.

The review assessed source, strict schemas, CLI behavior, corpus provenance,
metric definitions, tests, generated report, and the implementation handoff
against [the accepted runbook](aut-05-baseline-runbook.md).

## Confirmed findings before repair

| ID | Finding and observed consequence |
|---|---|
| A05-R01 | `acceptedResults` counted any real `pass`, including a stale-review rejection and a planning assessment. Empty checks or `not_run` still counted. This contradicted the frozen accepted-implementation metric. |
| A05-R02 | Baseline case-observation references were not joined. Unknown case/observation IDs or an empty membership list still produced valid/assessed output. |
| A05-R03 | CLI hashed only corpus bytes. Modified observations, stale source/output digests, and arbitrary metric/evaluator version labels could pass unchanged baseline metadata. |
| A05-R04 | Source snapshot mismatch was only advisory even when the claimed config/source binding was absent. Historical target-orchestrator cases used the harness commit SHA and cited the wrong source modules. |
| A05-R05 | A null metric entry threw TypeError before the object guard. Negative requirement ratios were accepted. Numeric/token constraints and aggregation coverage needed independent controls. |
| A05-R06 | Baseline readiness cited prose verification/audit claims with no durable receipt artifact references. The generated evaluator report could not substitute for those reviews. |
| A05-R07 | The planning sample claimed a verbatim pre-AUT-01 workflow capture without provenance. Its literal-ID scoring conflated missing machine traceability with loss of substantive constraints. |
| A05-R08 | Corrective review found additional missing joins between the assessment, reviewed planning bytes, capture provenance, and canonical source list. Pinning each file alone did not validate these relationships. |
| A05-R09 | Final v2 audit found that the failed/incomplete usage case combined Oct 15 failure summaries with an Oct 13 unknown-usage snapshot without a concrete attempt join. V2 remains unaccepted; a new cohort revision must retain joined failure/usage evidence. |
| A05-R10 | A late v3 metadata edit dropped scope limitations. Final review rejected that target; the accepted manifest restores all six limitations with the correct historical-case count. |

Reproductions used defensive copies of the submitted JSON and the unmodified
submitted evaluator. Examples included setting `baseline.caseObservations` to a
nonexistent case, replacing version labels, removing the supplied corpus digest,
setting a requirement metric to -5/5, and setting `metrics` to `[null]`.

The original focused suite did pass all 32 leaf tests under the explicit
same-process test runner. That success did not cover the reproduced failures.
A default process-isolated run in this environment reported only three file-level
cases; review evidence uses explicit leaf-level execution instead.

## Evidence interpretation and correction policy

- A case-oracle result and an accepted implementation result are separate facts.
  Offline corpus evaluation does not invent current-target acceptance receipts.
- Hash verification proves which bytes were assessed, not that a prose claim is
  true. Historical technical summaries remain summaries, with exact provenance
  and explicit limits on runtime conclusions.
- A new manual planning artifact was authored during this review before AUT-01
  implementation. It is labeled as a current-agent artifact, not a historical
  harness/model run. It supports frozen-artifact structural comparison only.
- The submitted sample remains distinguishable from the corrected cohort. Its
  unsupported readiness and measurement claims must not silently become accepted
  history after metadata is regenerated.
- Final baseline acceptance belongs to the lead after independent review; the
  evaluator's `eligibility.ready` remains false.

## Final qualification and next step

The lead accepts `aut-05-baseline-offline-v3` as `baseline_ready` for
`offline_contract_and_artifact`, limited to frozen manual-artifact structure,
requirement traceability, and offline analyzer capability. The exact decision
and all retained references are in [acceptance.json](evidence/aut-05/acceptance.json).
The captured baseline stays `captured`; evaluator `eligibility.ready` stays false.

| Artifact | Raw SHA-256 |
|---|---|
| V3 baseline | `4fe46b3cc7d7a67e5bc1df2c5347f5bcd007fccb808a8294671d0a0ee0183786` |
| V3 corpus | `bf180584c4ee3620b2c676f42e0c09be8d977dec2d82cbd39e3fd90cf60485fc` |
| V3 observations | `99b50d7b5c2983ca3d380507120d08ac3caf4965ab3daede3832d263fe24defa` |
| Joined failed-attempt export | `24a1f47bc94051775ebb988a3d56a56581c8de56a176348f818a084f1d834c88` |

Final independent [technical verification](evidence/aut-05/v3-verification.md)
and [integrity audit](evidence/aut-05/v3-integrity-audit.md) approve these bytes.
The auditor independently checked the concrete r33 failed task/attempt against
its usage ledger, performance row and frozen snapshot. Tokens remain null;
5573 ms is one attempt duration, not a complete workflow measurement.

The final [verification record](evidence/aut-05/verification-results.json) retains
49/49 focused passes and 1144 full-suite passes, zero failures and one optional
skip (1145 total), using Node v24.21.0 with leaf-level same-process execution.
The final limitations-only metadata restoration was separately reviewed and
replayed after that suite; implementation and test bytes were unchanged.
[The retained evaluator report](evidence/aut-05/evaluation-report.json) has four
case passes, two historical failures and one inconclusive result. These are
case-oracle outcomes, not accepted implementation results.

Generated evidence is under `artifacts/autonomy/aut-05-baseline-offline-v3/`
(ignored); its report is also retained above, so readiness does not depend on
`/tmp` or ignored files. Rejected targets and review corrections remain in this
evidence directory and the submitted/corrective fixture cohorts.

The manual planning baseline already preserves all five semantic criteria.
AUT-01 can qualify explicit links, proposal validation and seeded-defect
detection; this baseline supports no claim about live model quality, token or
cost savings, first-pass acceptance, or production runtime behavior.

Next: commit the completed prior work as requested by the owner, then execute
A0 in [the AUT-01 runbook](aut-01-traceability-runbook.md). Preserve every frozen
baseline artifact and use the exact accepted v3 reference above.
