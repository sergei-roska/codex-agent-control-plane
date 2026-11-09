# CN-10 candidate review

Own new `src/candidate-review.js`, `src/delivery-review-policy.js`, their new focused tests, and these local notes only. Root owns Git/docs. Preserve all existing source and legacy review behavior. No live model/service/target/shared DB/network/Git mutation.

Implement durable immutable review checkpoints/contexts, candidate-bound review proposals, actual read-only frozen source preparation with before/after attestation, trusted receipt settlement and immutable history, separately recorded trusted promotions, conservative dependency closure, candidate retention, and synchronous scheduler `isFrozenReview(task)`. Do not infer independence from allowed files or planner scope. Use injected trusted registry/attempt adapters and existing CandidateStore/BacklogStore APIs.

Read the exact CN-10 brief, architecture local gate, role policy, accepted CN-04/CN-08 APIs and legacy policy context. Verify using disposable Git/SQLite fixtures and fake trusted execution. Freeze for independent critic and targeted snapshot/dependency challenge.
