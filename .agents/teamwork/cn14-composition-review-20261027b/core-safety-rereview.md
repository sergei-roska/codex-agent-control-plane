# CN14 core safety delta re-review

Verdict: APPROVE
Blocking: none within this delta.
Status: complete for the bounded safety delta.
Scope expansion: none.

Scope: only production execution-shape recovery correction and durable shutdown scan after canceled-run database reopen. This supersedes the initial schema blocker for this delta; it does not approve whole CN14 or all inherited core changes.

## Schema blocker resolved

Evidence (read): concurrent-delivery-engine.js #plannerRecoveryProof no longer requires cleanupSucceeded. It still requires the persisted project/session/ledger turn/thread/scope/owner generation, observed matching start/terminal process identity, trusted completed terminal status, start sent/not rejected, terminal flag, and actual process group gone. Terminal facts are written only after the appServer.run result passes those validations. A thrown provider/cleanup error never writes terminal success.

Evidence (read): CodexAppServer.run :1016 awaits _run; _run :1209 awaits _cleanupTerminal, :1211 throws terminalError, and :1212 only then returns. _cleanupTerminal rejects wrong/exited generations, malformed responses, and cleanup request failures. Thus successful completed return is source-backed cleanup evidence without an invented flag. Persistent live AppServer processes remain held by the independent process-group check; this approval does not claim ordinary live-process invalid-output retries are now eligible.

Evidence (ran/read): the positive planner-recovery test now omits cleanupSucceeded and explicitly asserts that persisted terminal execution lacks it. It uses an actual detached disposable process stopped before return. Exact prior lifecycle reconciliation and accepted finalization pass; live-process/missing-terminal/wrong-thread/provider-exception negatives remain held with one provider call and unknown ledger.

## Durable canceled/reopen shutdown blocker resolved

Evidence (read): ConcurrentDeliveryEngine.shutdown :376 onward scans every persisted project run absent an in-memory controller, including terminal/canceled records. It uses the actual DeliveryInbox and DeliveryLifecycle.shutdownProjection, passing durable objective owner/control identity and actual #effectsSettled resolver. It does not start controllers, clear fences or mutate uncertain claims. Lifecycle projection independently checks active/unknown planner rows by project/session, unsettled attempts/claims, pending inbox, and host effect settlement. Missing objective rejects.

Evidence (ran/read): new database reopen regression creates a real unknown planner error, verifies unsafe shutdown, owner-cancels, closes the actual SQLite connection, opens the same database and constructs a new engine. recoverStoredRuns returns [], provider calls remain exactly one, shutdown rejects with disposition canceled and live_or_unknown_planner_turn, and the ledger remains unknown. This exercises the precise previously unprotected no-controller path rather than a seeded fake return value.

Verification command:
`env -u NODE_TEST_CONTEXT node --test --test-name-pattern='database reopen|planner-recovery|planner recovery holds uncertain host facts' test/concurrent-delivery-engine.test.js`
Result: 6 pass, 0 fail, 0 skipped. No delivery-acceptance suite, prohibited hostile Git-filter test, shared service or live provider/account used. Only this owned ignored report was written.

## Explicit remaining scope

Inherited pin mutation/provider enforcement, atomic steering, cooperative capabilities, artifact provenance and overlap remain UNVERIFIED for approval in this review. Their earlier source reads are not promoted to accepted behavioral evidence. Empty-check adaptation and complete host/core facade acceptance remain outside this delta. Canceled/reopen unknown claims/publications use the existing lifecycle/effect policy by source inspection, but this new focused engine regression directly exercises only unknown planner persistence. The separate role-service recovery bridge, successful retry-close, pause/resume, correction synchronization and whole CN14 remain pending. Host downgrade admission fence is independently under repair and is not accepted by this verdict.
