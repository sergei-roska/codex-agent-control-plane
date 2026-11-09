# V14 amended protocol decision

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Delta review against v14-decision.md. Read the amended request, response,
replacement and verification sections. The earlier blocking ambiguity is resolved:

- Immutable request pins follow the registration increment. Ordinary replies bind
  the request decision pins and current reply pins; committed duplicates return
  their original receipt before checking now-current revisions.
- Answer-after-pause/stop retains the explicit owner cause and cannot start work.
  Cancel rejects new answers/replacements and cannot resurrect execution.
- Changed plan/goal/authority/owner pins supersede ordinary answering while keeping
  admission/acceptance blocked. An authenticated, current-pinned replacement
  validates obligations/evidence anew, retains history, issues a new immutable
  digest and rejects old replies. No model turn is required for replacement.
- Other later control causes default to refusal unless an explicit tested
  retain-control transition is implemented. There is no active-state fallback.
- Reopen/status/input_required avoid model loops; valid active resolution creates
  one transactional wakeup. Default null preserves routine autonomous execution.
  Selecting an option grants no effect capability or requirement change.

Approval is for bounded whole-objective V14 implementation in the proposed six
production files and paired tests. It does not claim obligation-selective deferral
from target-design.md:299-300. Mandatory owner acceptance, publication authority,
checks and terminal release guards remain separate and unchanged. Actual source
needs independent review and the specified control/race/reopen tests afterward.

No source edits or broad tests were performed for this decision.
Canonical plan: .agents/teamwork/owner-decision-20261028/plan.md
Plan SHA-256: e5e7933320cbe2554ef3edcbc36d9bfbb024091526f57c16e151549825647264

## Implementation-time evidence replacement amendment

Decision: APPROVE the bounded evidence revalidation amendment below.

Read current draft: validateOwnerDecision at backlog-store.js:605-606 requires
investigation executionGeneration and captured goal/authority to equal current
objective pins, including authenticated replacement (:655). Pending decisions also
block applyPlan (:719) and claimReady (:1173). Therefore a correction/takeover can
make every retained investigation invalid while preventing any new one. The prior
protocol approval's required successful replacement path is not satisfied by
that strict draft. Do not forge a current-pin investigator in tests to conceal it.

The lead relays the worker's bounded remedy; approve it for implementation:

- Initial request registration keeps strict current investigator pin validation.
- Add default-deny synchronous ownerDecisionEvidenceAuthorized used exclusively
  inside authenticated replacement, bound to exact current replacement body/pins.
- Reuse only the original pending question's immutable successful read-only
  investigation attempt/receipt/report/evidence binding. Preserve its real original
  goal/authority/owner pins; never relabel it as a current investigation.
- Engine verifies retained baseCandidate manifest against actual current shared
  tree with measureCandidateTree. Drift or unavailable observations deny. Recheck
  current obligations and exact old/new request digest and scope in the transaction.
- The authenticated owner explicitly reselects/adopts those evidence refs for the
  replacement question. Tree equality proves observation continuity, not semantic
  relevance or authority to perform new effects. Record owner-revalidated evidence
  provenance separately from the investigator's original immutable provenance.
- No ordinary task/planner admission exception, no blanket investigator bypass,
  no weakening of unresolved-decision or final acceptance guards.

Required decisive positive: actual old-pin completed investigator -> registered
question -> real goal/authority correction -> ordinary reply refused -> explicit
current-pinned authenticated replacement succeeds from unchanged retained
observation -> one valid new answer. Test wrong original refs/report binding,
changed tree, unavailable snapshot, stale pins and unauthenticated replacement
as retained-gate negatives. No fresh current-pin investigator may be fabricated.

This addendum is read-only design review, not approval of unfinished source or
claim that the proposed hook is already correctly implemented. No tests ran here.
