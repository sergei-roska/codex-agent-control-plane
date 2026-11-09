# CN-10: immutable candidate reviews and scoped gates

Project /home/sr/Projects/Workspace/codex-agent-control-plane. Read worker TOML
developer_instructions/access policy under /home/sr/codex-work, project AGENTS.md.
Root owns Git/docs. Node24/deps available. ASCII English artifacts. No real model,
target/shared DB/service/account/network/Git actions. Disposable Git/SQLite tests.
Dispatch only after accepted CN-04/CN-08 local gates.

Own new src/candidate-review.js, src/delivery-review-policy.js and their two new
tests; notes under candidate-review/. Do not edit candidate/backlog/scheduler/
controller/legacy review-policy files. Request any necessary expansion. Root has
a separate owner for optional shared backlog checkpointInventory API; use injected
registry/admission hooks at local gate rather than writing its SQL directly.

Read CN-10/local gate, target-design parallel review/scoped gates and role-policy,
actual CandidateStore/projectDeliveryCandidate APIs, src/review-policy.js and
acceptance.js as existing policy context. Preserve legacy mandatory gates until
their qualified replacement is explicitly selected. This is new-engine policy.

Implement durable immutable checkpoint/context definitions, independent review
task planning and trusted receipt settlement. Binding tuple is project/objective/
checkpoint/candidate/context/input-manifest/check/tool/profile pins/role/attempt.
Freeze and verify candidate input before a review. Reviewer scratch may be writable
but its product source is frozen/read-only; test/check changes create a new
candidate and cannot self-certify old target. Distinct same-role reviewers must
have distinct task/attempt/thread identities. Verifier->auditor dependency exists
only where evidence actually flows; independent checkpoints may overlap.

Contexts include owner goal/requirements/check identity, exact candidate manifest,
controller-attested dependency closure/read manifest, environment, pins and trusted
attempt provenance. allowedFiles or a planner's claimed readScope alone are not
proof of semantic independence. Unknown/unattested scope keeps the conservative
critical barrier. Provide a synchronous isFrozenReview(task) capability for the
CN-08 admission policy that validates registry/candidate binding, not merely the
presence of baseCandidateId on a model task.

Trusted settlement validates actual attempt/task/role/thread/candidate identities,
passing checks and unchanged frozen inputs before creating one receipt/event in
the same SQLite transaction. Model self-report alone is never receipt authority.
Receipt history is immutable. Promotion to a later candidate requires validated
identical input closure, goal/check/pin/environment identity and explicit trusted
attestation. Store a distinct promotion relation/record; never rename historical
receipt candidate or context. Changed/unknown dependency invalidates promotion;
unrelated attested unchanged-closure work continues. Prevent dependency laundering
by excluding neither read dependencies nor required checkpoint ancestors.

Expose checkpoint inventory/acceptance projections for BacklogStore injection,
review task proposals for planner/scheduler, receipt lookup/current qualification,
candidate-bound review input preparation, and a final-stabilization query for
CN-12. Candidate references protect every live checkpoint/receipt/promotion/
acceptance input from metadata GC. Keep event hooks synchronous, bounded and
same-transaction; external model/check execution stays outside transactions.
Use existing receipt pure validator or an explicit validated v1 projection.

Local tests with real frozen disposable Git snapshots and fake trusted execution:
review G while writer creates G+1 without changing read bytes; two independent
auditors and independent checkpoint graphs; evidence-bound verifier ordering;
wrong/stale/duplicate receipt identity; owner/dependency/check drift; unchanged
attested closure can promote without historical mutation; unknown scope cannot;
test author changes candidate and cannot certify old target; referenced snapshots
survive GC/reopen. Use actual scheduler frozen-review injection where possible,
with successors faked honestly. Full lifecycle/final acceptance/engine routing are
later gates, not circular local prerequisites.

Create brief/handoff early, send API to root/controller worker, run meaningful
focused checks, freeze for independent authority/concurrency critic and targeted
dependency/snapshot challenge. Source qualification only; no live rollout claim.
