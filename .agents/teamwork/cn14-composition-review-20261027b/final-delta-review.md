# CN14 final bounded delta review

Three separate Review verdicts. No whole CN14 acceptance.

## 1. Host durable admission correction

Verdict: APPROVE
Blocking: none in the reviewed correction.

Evidence (read): src/server.js concurrentRunSettled now validates mapped project/objective/session identifiers against actual run and objective records, rejects every planner-ledger state outside complete/stale/reconciled_no_effect for that exact project/session, checks all authoritative candidate intents against terminal states, and checks role-execution identity/state plus literal true effectsSettled. Cached applied/not_applied publication rows require an authoritative intent with the same intent ID and exact project/objective identity and a settled state. The refused cache without intent exception matches DeliveryOutputArtifacts.projectPublication's explicit behavior. Unrelated session and foreign project planner rows do not fence this run. Gates remain before router intake writes and preserve the prior mapping.

Evidence (ran):
`env -u NODE_TEST_CONTEXT node --test test/server-delivery-engine.test.js test/delivery-engine-router.test.js test/delivery-host-controls.test.js test/delivery-provider-identity.test.js`
70 pass, 0 fail. Reviewed added restart matrices: unknown/active/unrecognized planner states, missing/corrupt scope identity, authoritative candidate/role uncertainty, missing/mismatched publication intent, terminal positive cases, unrelated project/session isolation. Positives use CandidateStore-created candidate manifests. Seeded fault teardown removes fabricated rows only after refusal and immutable mapping assertions; it does not claim successful production shutdown. Previous host helper/default/auth/lock-retention evidence remains valid and passed in this run.

The original unknown-planner downgrade blocker and authoritative publication concern are resolved for this delta. Successful held-worker retry-close is still UNVERIFIED and not approved here.

## 2. Core missing-settlement SQL repair

Verdict: APPROVE
Blocking: none in the reviewed correction.

Evidence (read): src/concurrent-delivery-engine.js:1075 uses json_extract(...effectsSettled) IS NOT 1, so SQL NULL no longer drops an unresolved record. Existing terminal-state and durable shutdown-projection policy remains in force.

Evidence (ran):
`env -u NODE_TEST_CONTEXT node --test --test-name-pattern='settlement attestation|database reopen|planner-recovery|planner recovery holds uncertain host facts' test/concurrent-delivery-engine.test.js`
8 pass, 0 fail. Missing and false terminal role settlement attestations reject without controllers; prior real reopen and recovery safety tests remain green.

Evidence (ran): replayed challenger .agents/teamwork/cn14-safety-challenge-20261027b/probe.cjs through Module._compile, modifying only its old final observation assertion in memory to assert the corrected rejection. Original probe file unchanged. Actual SQLite reopen for multiple stored runs still rejects unknown planner ledger and pending inbox; explicit false and absent settlement both reject with publication_effect_settlement_unproven. Exit 0. Scratch fixture artifacts were generated inside the challenge's designated ignored directory. This expectation adjustment verifies the intended fix; it does not alter reviewed tests or production code.

## 3. Unwired RoleService no-publication recovery API

Verdict: APPROVE for the isolated API; engine wiring remains UNVERIFIED.
Blocking: none in this bounded API contract.

Evidence (read): src/delivery-role-service.js:253-380 reads durable records rather than trusting caller snapshots. It requires nonactive completed provider work with settled effects and matching observed start/terminal identity; exact attempt/claim/executor context, request, settings, contract, account/home, fencing and recovery generation; and no produced candidate, candidate intent or publication. Writer recovery requires an owned real private worktree, matching binding and lane start identity, and rejects cooperative lanes. It changes state to recovering_no_publication before awaiting lane completion, which closes producer authorization and late result handling. LaneManager.complete(integrate:false) only marks retained private evidence not_integrated and never applies output. The API re-reads all facts after the await and on proof retrieval. Digest-bound preparation replay is idempotent, proof is frozen with frozen evidenceRefs, and proof requires unknown attempt plus expired/fenced claim. TaskExecutor.recover independently enforces its exact proof fields and current claim/attempt identity before settlement. No claims are released or candidate output published by preparation itself.

Evidence (read): noEffect is backed by absence of any publication/candidate and retained owned private output plus actual terminal provider receipt, not by model text. Nonterminal/failed/unknown effects cannot reach preparation. The existing real AppServer completed-result contract awaits terminal cleanup; this API does not invent a new cleanup flag or claim that an uncertain live turn is stopped. A private worktree output can be abandoned without being integrated.

Evidence (ran):
`env -u NODE_TEST_CONTEXT node --test test/delivery-role-service.test.js`
30 pass, 0 fail. Reviewed tests use actual TaskExecutor execute/recover, real private lanes and durable records. They prove no_effect_requeued and canceled-generation settlement, retained private bytes and unchanged shared tree, duplicate prepare, exact/frozen proof keys, account mutation revalidation, late terminal delivery refusal and twelve negative identity/effect/publication cases. Prior role-service behavior remains green.

This does not qualify asynchronous recovery wiring into engine shutdown, cooperative recovery, full retry-close, or a broader no-effect mechanism for work with publication intents.

## Shared limits

`git diff --check` passed. No source, reviewed tests/config, or Git state changed; only owned ignored reports and disposable generated challenge fixtures were written. No excluded hostile Git-filter test, dependency installation, live model/account/shared service, or subagent used. Inherited core pin mutation/provider enforcement, atomic steering, cooperative capability, artifact and overlap dimensions remain UNVERIFIED for approval by this reviewer. Pause/resume, correction synchronization and full CN14 remain pending.

Status: complete
Scope expansion: none
