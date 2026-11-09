# UI re-review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Read: revised delta adds request/decision ownership tokens and a request epoch, invalidates them on project/session changes, and rechecks scope after awaited session polling before clearing pending/session state. Stale completion cannot release newer sending or decisionSubmitting guards. Pending decision identity/selection now survives intermediate working polls; a genuinely changed decision renders after settlement.

Ran independently:
- node --test test/launcher-decision-ui.test.js test/launcher-session-controls.test.js ->25 passed0failed, exit0. Evidence rereview-tests.tap.
- node .agents/teamwork/concurrent-resume-20261030/review-ui/probe-races.cjs ->exit0. Evidence rereview-races.jsonl: old completion preserves newer sending=true; intermediate working poll plus same semantic error retains choice keep and draft.
- Frozen blob hashes confirmed before/after: app888b12f681f0097dc398be8889abac4567203a44; test aa90ecd85e4fa517ee13a977a2d6161230dd231d.

Both prior blockers resolved. Added tests exercise newer project decision ownership, changed decisions, and scope changes while post-response polling is deferred. Backend checkpoint remains separate and pending; this review makes no claim about live continuation or full delivery acceptance. No product/test edits or live actions performed.
