# V14 independent delta review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

This supersedes the two blocking findings in decision.md for the reviewed frozen
inputs. This is V14 code review, not final V01-V43 matrix acceptance.

## Findings resolved

- Read src/backlog-store.js:1427: shared #requestControl now rejects resume while
  any owner decision is pending, before changing disposition/control. Both the
  direct public requestControl and transitionLifecycleControl use this method.
  Read and ran test/owner-decision.test.js:108: direct pause/resume regression
  requires owner_decision_pending and preserved paused_owner/owner_pause/pending.
- Read and ran test/owner-decision-restart.test.js:207: the acceptance run now
  closes its actual host and SQLite while its own decision is pending. A new
  startServer opens a different database object; exact pending request and reply
  pins survive; resume returns the same owner wait without preparation/provider
  calls. Authenticated reply and duplicate then precede accepted disposition,
  one verifier invocation, passed mandatory product check and durable accepted
  finalization bound to the recorded candidate.

## Independent verification

Ran, exit0, PASS20 FAIL0 SKIP0:

    env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/owner-decision.test.js test/owner-decision-restart.test.js

Evidence: delta-focused.tap in this directory (ignored local scratch; temporary).
Hashes below were identical before and after this run. No broad suites, live
providers, existing service restarts, installs or source/test edits performed.

Integrity: the delta strengthens the previously missing guards and composed
restart acceptance evidence. No trivial assertions, removed required checks,
hardcoded production answers or swallowed failures were introduced. Earlier
bounded replacement/engine-swap fixture conclusions remain limited as documented
in decision.md; real same-run host reconstruction now supplies missing evidence.

## Stable reviewed SHA-256

    beb2e697bf9cb1f6c1a5e88dbe2f7d2e61bcc2815ad03e7a63d205104496545e src/backlog-store.js
    d02839dfbebe00eb108e42085cbfa80228c5d70a8d221701001102efbd3211a0 src/lead-planner.js
    9608ec482ee582628b81bf1dcdb3dc0749a49df4c8ba310148be56d57292988a src/project-delivery-controller.js
    f3dbc6dd5a25e068752159e01fd7339511727132dcbb42f5e54c3b68dbc1dd4e src/delivery-lifecycle.js
    c62538436b71fb68a88a216f03152fc72c30f122c522d29345c782f875ed1975 src/concurrent-delivery-engine.js
    7b93cd502f522d3fb2e24e2e338edbb81c505d660b684717819ddd25da135df3 src/delivery-host-controls.js
    8faee50eeb64814c9046f57f207ba2ffdaa8313db5b2672407d632193d4b2420 test/owner-decision.test.js
    3c981604f40845b11e14e1046ac7264fdc83c34c1452587018ff7a268d294958 test/owner-decision-restart.test.js
