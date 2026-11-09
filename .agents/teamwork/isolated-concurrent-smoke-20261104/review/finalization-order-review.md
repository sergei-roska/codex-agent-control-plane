# Finalization checkpoint pin ordering repair

Verdict: APPROVE source repair and unchanged fresh verification-only intake. Native accepted outcome remains pending.

Read remaining frozen delta against prior approvals: finalization authorization derives original contract IDs and sorts a separate copy for comparison with normalized checkpoint.checkPins. It does not mutate contract execution order, normalize away duplicate membership, change request.requiredCheckIds or complete contract digest, or alter any owner/control/profile/environment/candidate/current-tree/fence/receipt/check-proof gate. This corrects the exact order-only failure independently measured in the retained native backup.

Read composed regression: three deliberately nonlexical check IDs flow through no-change coordinator, scoped verifier, actual fixture checks and accepted finalization. It confirms checkpoint sorted pins and retained original request.requiredCheckIds ordering, then rejects missing/extra/duplicate checkpoint pins. Prior Unicode owner-context/input/capability/permission checks remain intact. No test is weakened to conceal a product failure.

Ran independent decisive check: node --test --test-name-pattern='owner full-access carries lossless owner context' test/server-delivery-engine.test.js: 1 pass, zero fail. Evidence: finalization-order-focused.tap. Scoped diff check passes. SHA-256 matches worker freeze: engine 9a613d802bf4e19e41fcec38475760fb4b91aee5828419eb64674e1d63191528; test edb92c00b5962b3d5e65294f1d1bff07cf5115da07b01d10ff9ab53a76aeb6a0. Root full-finalization-order.tap now completes with 2105 pass, zero fail, one skip; read its final summary.

Re-review: requested positive authorization control is now present immediately before negative pin variants and asserts true. This resolves the negative-test validity concern. The only subsequent change is this test assertion; product source remains frozen. Updated test SHA-256: 5be9ddbeb45cc27846c512e1164c15ff27f226cc17acc045a2541349da74303d. Root/worker report focused 1/1 passes. No redundant test rerun performed by critic.

Fresh intake remains a new verification of unchanged preserved candidate with all three new proofs and static passing receipt required. Do not restore prior canceled/failed tasks or count earlier host proofs as current proof. No retained DB/provider/native action performed in this review.

Status: complete for source/admission review.
Scope expansion: none
