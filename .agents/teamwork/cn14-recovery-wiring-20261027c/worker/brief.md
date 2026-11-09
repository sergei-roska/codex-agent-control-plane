# Recovery wiring milestone

Goal: integrate the accepted trusted RoleService no-publication recovery API with
engine shutdown through existing lifecycle/executor APIs. Prove a drained terminal
attempt whose send acknowledgement was lost can be reconciled and permit safe
retry-close, while unknown effects remain fenced. No claim that whole CN14 is done.

Baseline: HEAD 65a970e, inherited dirty tree preserved in source-start.json.
Read predecessor cn14-continuation-20261027b/handoff.md and core/host follow-up
handoffs. Previous source accepted narrowly; do not redo architecture research.
No restart, real model calls, account/settings changes, Git mutations or live tasks.
Root owns Git/docs. Only disposable fixtures and fake providers for tests.

Worker owns src/concurrent-delivery-engine.js, src/delivery-role-service.js,
test/concurrent-delivery-engine.test.js, test/delivery-role-service.test.js and
new dedicated test file if useful. Request any additional product source scope.
Host scratch acceptance-draft.cjs can be read/copied to owned scratch, not edited.
Cooperative lane recovery remains unqualified. Never force strict permissions or
claim cooperative confinement; keep refusal if honest no-effect proof cannot be
established in this bounded milestone. Clearly report scope remaining.

Use existing prepareNoPublicationRecovery, requestLifecycleRecovery,
executor.recover, recoveryProofFor. No direct claim/state writes. Preserve exact
identity, immutable pins, owner generations, publication uncertainty, pending inbox
and durable reopened/canceled run fences. Include real engine integration positives
and unknown/publication negative controls, idempotent repeated shutdown/reopen.

All delivery-acceptance/full commands MUST include:
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'
Never execute that prohibited regression. Node CommonJS, use env -u NODE_TEST_CONTEXT.
Predecessor full baseline: 1869 tests,1858pass,10fail,1skip; affected 711/709/2.
No broad suite until focused milestone stable. Reports/logs in this directory.
Worker must maintain brief/handoff in its owned subdirectory, preserve original
snapshots of touched files for an independently inspectable delta, and give exact
commands/results, remaining uncertainties and changed files. ASCII English only.
