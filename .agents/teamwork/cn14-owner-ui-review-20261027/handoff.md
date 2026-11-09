# CN14 owner UI review

Verdict: REJECT. Root records the independent critic's final findings; no product
changes by critic. Focused66/66 passed but did not cover/preserved wrong behavior.

1. launcher-app.js delivery-engine PUT permits starting/unknown states by checking
   only running. Require exact stopped before settings file mutation.
2. Steering response validates scope only. Require exact sent messageId, literal
   acknowledged true and valid durable received/applied/blocked state before200.
3. Backlog selection changes delete text/retry ID, including uncertain sends; one
   test asserts deletion. Preserve per-scope draft and pending delivery evidence.
4. Retry ID survives but request body is rebuilt from refreshed revisions/edited
   text, conflicting with inbox digest. Preserve exact pending request or reconcile
   its exact ID before another payload. Late ack must not erase later edits.

Root clarified cross-module replay semantics: backend resolves durable exact replay
before current revision CAS; proxy validates current mapping/scope but must not
pre-reject stale revisions that belong to a received duplicate. Core owns atomic
new-message/revision check. Backend returns409 only for genuinely new stale input.
## Re-review 2026-10-27

Verdict: APPROVE for the owner UI/API/settings revision and narrow host-control
acknowledgement fix. Read: launcher-app.js now requires exact `stopped` status
for engine setting PUT, validates message ID, acknowledged true, scope, and a
received/applied/blocked state on steer responses, and forwards the unchanged
revision body so the backend can resolve durable replay first. Read:
backlog.js keeps draft, pending send, and the exact retry body per scoped
project/session/objective record; acknowledgement only clears the submitted
draft when it has not since changed. Read: delivery-host-controls.js maps
message_id_conflict to 409 and accepts only recognized durable ack states.
Ran: `node --test test/launcher-app.test.js test/launcher-pause.test.js
test/launcher-backlog-ui.test.js test/launcher-role-page.test.js
test/launcher-owner-delivery.test.js test/launcher-owner-ui.test.js
test/delivery-host-controls.test.js` - 69 tests passed, 0 failed.
No Chrome check was needed for the resolved state and request invariants.
