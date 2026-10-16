# AUT-02 independent verifier report

Verdict: APPROVE
Date: 2026-10-15
Scope: final AUT-02 source, tests, fixture, qualification evidence, and baseline/final comparison.

The final source and evidence hashes are pinned in
[qualification-status.json](qualification-status.json). The verifier
confirmed that all nine listed source, test, and fixture hashes match the
current files, including the runtime and lead graph test hashes. It
independently reran Q01; the remaining matrix cases were checked against their
named focused tests, Q11 TAP, and retained traces.

| Case | Verified evidence |
| --- | --- |
| Q01 | Stable verifier and auditor continuations pass 2/2 in [qualification-q01.tap](qualification-q01.tap). The pre-fix auditor test fails in [qualification-q01-baseline.tap](qualification-q01-baseline.tap); the verifier baseline control passes in [qualification-q01-verifier-baseline.tap](qualification-q01-verifier-baseline.tap). |
| Q02 | `a stale usage-limited auditor recovers before another lead decision`; [automatic-selection.json](traces/final/automatic-selection.json) |
| Q03 | `a stale verifier selected alone retains skill pins and receives a read-only auditor recovery` |
| Q04 | `a stable review scope continuation keeps its origin and exact checkpoint context`; `owner pause parks before recovery selection after a stale scope continuation rejection` |
| Q05 | `a direct-service origin that goes stale after graph preflight recovers automatically`; [service-origin-race.json](traces/final/service-origin-race.json) |
| Q06 | `an unknown direct-service continuation origin blocks recovery without guessing staleness`; `direct review resumable context distinguishes unknown bindings from proven tuple mismatches`; missing, cross-run, corrupt, and ambiguous origin controls for direct verifier/auditor paths |
| Q07 | `every normalized review field is part of matching and target identity`; `prerequisite links are part of immutable scope and target identity`; specialist context validation tests |
| Q08 | `full and resumed delta prompts carry the complete stored review context`; `recovery preserves nonempty prerequisites for multiple pending checkpoints through restart` |
| Q09 | `a stale limited continuation survives restart after recovery is queued but before submission`; `a usage-limited recovery verifier keeps its generation through restart before auditor dispatch` |
| Q10 | `resumed finalization rechecks critical receipts against the current target`; `owner accept_as_is cannot make a pending critical review gate accepted`; ordered reviewer gate tests |
| Q11 | Budget, retry exhaustion, cancellation, unresolved writer, and owner pause controls pass 5/5 in [qualification-q11.tap](qualification-q11.tap). |
| Q12 | Direct verifier/auditor origin controls and pinned-check fallback origin controls; [qualification-direct-trace.tap](qualification-direct-trace.tap) |
| Q13 | `routine material work gets a verifier without a periodic auditor`; `matching verifier and auditor receipts are reused without another model call`; ordinary verifier test-write controls |
| Q14 | `verifier binds coverage to the post-verification target after an authorized test-file write`; `an ordinary accepted verifier test write leaves the auditor decision to the lead`; the service-origin race trace confirms the auditor accepts the verifier's settled post-write target. |

The final focused qualification passed 333/335 with 0 failures and 2
sandbox-specific skips. The required full project suite passed 1207 tests, with
0 failures and one explicitly gated live confinement probe skip. Baseline to
final behavior is compared in [comparison.md](comparison.md): the frozen graph
probe now selects fresh current-target reviewers, the direct stale continuation
is rejected before App Server execution, and the stable usage-limited auditor
continuation no longer invalidates the accepted verifier receipt.

Limitations: evidence uses fake transports and disposable state. Live model
decision quality, tokens, cost, owner escalations, production duration, and
service rollout are unmeasured. Rollback must retain review history and the
direct origin guard, or quiesce continuations before reverting the service.

No blocking verifier findings remain. A separate independent auditor decision
and the lead's final acceptance record are still required.
