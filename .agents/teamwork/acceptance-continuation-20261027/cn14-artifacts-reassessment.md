# Artifact bridge reassessment after two rejected revisions

The original four findings are resolved and 8 focused tests pass, but the second
review found a distinct recovery design defect. `delivery_output_publications`
stores a separate current effect outcome from CandidateStore. Its cached unknown
result survives even after exact CandidateStore reconciliation establishes applied.
This is not a need to weaken quiescence or add retries; it is duplicated authority.

Decision: CandidateStore's exact pinned intent is authoritative for effect state.
Keep the bridge registry for immutable command/artifact identity and historical
observations. Exact bridge replay must project current truth from the matching
CandidateStore intent, validate every project/objective/attempt/base/candidate/
generation/manifest/delta binding, and return its applied/not_applied/refused/
unknown state without starting effects. A cached bridge state must never override
an unresolved intent or fabricate success. Validate the actual known candidate
before returning applied. Before candidate intent creation, a bridge prepared row
alone remains conservative; no automatic new apply after unknown or crash.

An explicit bridge reconciliation method may delegate to CandidateStore.reconcile
for the exact stored identity, then project the result; it must retain fresh host
control/authorization and existing strict quiescence/admission recovery. Avoid a
third variation of independent mutable outcome authority. No store schema or
CandidateStore source edit is needed. New regression: unknown -> CandidateStore
reconciles applied -> close/reopen -> bridge exact replay reports applied with
one effect execution and the original artifact/command identity unchanged.
