# AUT-02 direct continuation tuple binding design review

Verdict: REJECT current direct behavior; conditional design recommendation pending implementation review.

Decisive repro: [read] `.agents/teamwork/aut02_direct_challenge/report.md` and `thread-origin-probe.cjs`. A valid B `ofAttemptId` paired with A's `threadId` passes the current target lookup. [read] `src/a2a-role-service.js:477-505` returns only target identity, while `src/a2a-role-service.js:902-926` independently passes the requested thread ID to App Server. A stale A-context report can therefore be marked accepted for B. The challenger ran the probe and recorded 3 App Server calls; I did not rerun it.

Minimal durable contract:

1. After the originating role turn settles its actual thread/lane outcome, persist a versioned append-only staging event before publishing any terminal success/failure or accepted artifact. Its columns must bind run ID, attempt ID, role, and target; payload must bind review kind/checkpoint and a SHA-256 digest of the exact continuation tuple emitted to the caller. Canonical input uses a domain/version separator and explicit nulls for threadId, laneId, and codexHome. Store no raw tuple fields or secret-bearing paths. The origin started event and emitted tuple event must correlate to one run/attempt/role/checkpoint/target.
2. For an incoming review continuation with any nonnull threadId/laneId/codexHome, require a nonempty run ID and the matching complete v1 event. Recompute the digest over the normalized requested tuple and compare before lane adoption or App Server execution. Missing, malformed, ambiguous, saturated, or unavailable evidence fails closed. Keep the prior target freshness comparison. A fully null tuple has no resumable context and may retain the existing fresh-thread fallback with target validation.
3. Record the tuple for both completed and usage-limited/error turns that actually return continuation metadata. The event must describe the thread actually returned after any rejected-resume fallback, not the requested thread. If staging persistence fails, do not issue an accepted review with usable continuation metadata. A crash after event write but before terminal reply can leave history; replay must either reproduce the same event id/content or treat conflicting events as ambiguous and stop.
4. Legacy origins without a binding may use all-null fresh fallback only. Older service versions cannot enforce the new tuple guard; a live rollback to the prior binary would reopen the defect. No live deployment/rollback is in this offline milestone. Any future rollback plan must retain a guard-capable reader or stop review continuations before downgrading.

Requested probes: A and B valid origins, forged `ofAttemptId=B` plus A thread/lane/home stops before model; exact B tuple succeeds; missing/corrupt/mixed/duplicate/saturated binding stops; usage-limit origin binds returned metadata; all-null fallback succeeds without resume; restart with durable SQLite staging retains binding; legacy origin without binding fails resumable continuation; no raw tuple values in persisted event.

Status: partial
Scope expansion: none
