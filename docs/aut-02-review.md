# AUT-02 review: fresh-target review recovery

Status: accepted 2026-10-15. The mandatory Q01-Q14 controls, required full
project suite, and independent verifier and auditor reviews passed. The durable
decision is [acceptance.json](evidence/aut-02/acceptance.json); the live
qualification state and final hashes are in
[qualification-status.json](evidence/aut-02/qualification-status.json).

AUT-02 qualifies bounded recovery when a review continuation becomes stale.
The lead preserves the stored review obligation, rejects stale work before
model execution, and obtains fresh current-target verifier evidence followed
by the required auditor. Review context, origin, and thread/lane/home bindings
remain explicit. Recovery uses normal admission and keeps budget, owner pause,
cancellation, round, unresolved-writer, and generation limits in force.

The final regression repair also keeps a continuable usage-limited auditor
receipt from invalidating an already accepted verifier receipt while the
auditor continuation is pending. Once the auditor completes, its actual receipt
still determines the gate.

The comparison is deliberately bounded to frozen graph and direct-service
probes. The baseline stale-auditor graph probe omitted the fresh review pair;
the final trace records a fresh verifier and auditor accepted against the new
target. The baseline direct verifier continuation reached the App Server on a
stale target; the final endpoint returns `review_origin_stale` before that
execution. The stable usage-limited auditor control failed on the pre-Q01
runtime hash and passes on the accepted candidate. Full details and artifact
paths are in [comparison.md](evidence/aut-02/comparison.md).

Validation results:

- Focused qualification: 333 passed, 0 failed, 2 sandbox-specific skips.
- Q01 stable continuation controls: 2 passed; the pre-fix auditor control
  failed while its verifier control passed.
- Q11 boundary controls: 5 passed, 0 failed, 0 skipped.
- Required full project suite: 1207 passed, 0 failed, 1 explicitly gated live
  confinement probe skip.
- Independent verifier: APPROVE. Independent auditor: APPROVE.

The verifier and auditor reports list the Q01-Q14 controls and verify the
current file hashes. Qualification uses fake transports and disposable state;
live model decision quality, token use, cost, owner escalations, production
recovery duration, and a service rollout are not measured. Rollout requires a
separate authorization. Rollback must preserve review history and the direct
origin guard, or quiesce active continuations before reverting the service.

AUT-03's independently approved runbook is ready at its S0 entry gate now that
AUT-02 is accepted. AUT-03 implementation has not started.
