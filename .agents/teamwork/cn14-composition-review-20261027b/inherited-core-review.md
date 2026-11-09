# Frozen inherited core bounded review

Verdict: APPROVE for the requested pin, steering and overlapping-work composition dimensions.
Blocking: none in this bounded review.
Status: complete
Scope expansion: none

## Lead role and provider pins: PASS

Evidence (read): ConcurrentDeliveryEngine constructor requires a fresh providerIdentityFor function, deep-copies/freezes the startup provider identity and configured lead/worker roles. #prepareLeadThread snapshots settings, passes a separate role copy, verifies its effective model/effort/Fast settings before and after preparation, checks fresh provider identity before/after the await and prepared home, and persists settings/account/thread/transport identity. #runLeadTurn makes a separate role copy, compares its effective settings to the durable pins, checks the fresh provider before and after the call, supplies expectedCodexHome, and rejects changed role/settings/thread/process facts before consuming output. #providerIdentity rejects Promise results and any account/home change from the startup pin. The actual CodexAppServer uses the supplied role to form execution; the switching wrapper enforces expected home after settling its pending swap. This resolves the original review's mutable-role/persisted-model discrepancy without trusting static constructor account identity as freshness evidence.

Evidence (ran/read): core tests mutate the actual role supplied to prepareThread and assert rejection before any provider run; same-home account replacement during preparation also rejects before any provider turn. The underlying real auth metadata helper's same-home replacement tests passed in the previous independent host review. Constructor snapshotting also prevents external original-role mutation from altering execution pins. No claim is made that simultaneous malicious replacement and restoration of credential files is solved by these bounded boundary checks.

## Steering replay and atomic revision check: PASS

Evidence (read): exact durable replay is resolved through inbox.receive before current-revision rejection, so an acknowledged message remains replayable after revisions/disposition advance. Same-ID changed body fails its durable digest comparison. New messages check scope/revisions before asynchronous controller setup, then an immediate SQLite transaction rechecks current scope, inserts/deduplicates the inbox message, and rechecks current plan/goal/control revision. Nested inbox writes roll back with a stale outer transaction; controller.wake runs only after successful commit and never on duplicate replay.

Evidence (ran/read): tests reach accepted finalization, replay after plan revision and message state advance without new provider work, reject changed body, and deliberately change control revision during controller setup. The stale request rejects and the new message is absent from both replacement and original controller inbox views. The test uses real store/inbox transactions, not a mock receipt.

## Actual RoleService/artifact/acceptance overlap composition: PASS

Evidence (read): engine connects real BacklogStore, DeliveryOutputArtifacts, CandidateStore, CandidateReviewStore, authenticated DeliveryRoleService and TaskExecutor, with host publication authority and exact check/finalization proof callbacks. Final acceptance requires closed review projection, scheduler/controller drain and actual lifecycle safeToRelease, current live manifest matching the candidate, a persisted controller fence, frozen review qualification and host finalization. Empty checks do not remove the mandatory verifier/checkpoint gate.

Evidence (ran/read): overlapping fixture starts fast and slow engineers in distinct actual private worktrees using real SDK/RoleService execution. It observes fast succeeded while slow remains running with an active claim, plans dependent work while slow is still held, asserts the dependent work starts from generation 2 and sees fast.txt, then publishes generation 3 before releasing slow. Final shared candidate includes fast.txt/final.txt and excludes slow.txt. Real verifier executes verify-source.js against the frozen generation-3 candidate. Assertions bind verifier receipt, manifest, owner checkpoint, host check proof, final check result and durable accepted finalization to generation 3 and current owner/control/goal/plan/authority/requirements/check pins. Provider calls alone are faked; shared publication, proof issuance and host checks are real. The fake's leftover cleanupSucceeded field is not consumed by this path; the separate production-shape recovery correction was already independently accepted.

## Zero-owner-check acceptance adapter: PASS

Evidence (read): delivery-acceptance.js validates runner result arrays and pending host effects, then measures frozen candidate integrity before converting not_required to accepted. Conversion requires zero pinned required checks and empty checks/issues/reasons. Other not_required results reject; required checks still require exact pinned IDs/argv/passing results. Real engine composition above and the base empty-check test retain actual verifier and checkpoint qualification.

Evidence (ran): six adapter variants independently passed: real empty runner result accepted; a required check, unexpected check output, issue, reason or candidate mutation each rejected.

## Exact independent commands

`env -u NODE_TEST_CONTEXT node --test test/concurrent-delivery-engine.test.js`
16 pass, 0 fail, 0 skipped. Includes requested mutation, steering and overlap cases plus prior core safety cases.

`env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='empty|not_required|not.required' test/delivery-acceptance.test.js`
6 pass, 0 fail, 0 skipped. The prohibited hostile Git-filter test was excluded and did not execute.

Reviewed source/test files and Git state were not changed. Only this owned ignored report was written. No live provider/model/account/shared service or dependency install used.

## Explicit boundaries

This closes the requested inherited lead/provider pin, atomic steering and trusted overlapping-work composition dimensions, including the narrow empty-check adapter. It does not approve all standalone artifact/capability policies beyond the actual composed overlap path exercised here. Pause/resume, owner-correction synchronization, full run/reopen facade behavior, successful retry-close, unwired recovery integration and whole CN14 remain pending. Root's broader frozen baseline regression report was not rerun or promoted into independent evidence by this review.
