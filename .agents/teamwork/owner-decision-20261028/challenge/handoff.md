# V14 boundary challenge

Verdict: HOLDS
Status: complete
Scope expansion: none

Three independent store-level probes passed (3/3). Disposable in-memory SQLite
trigger aborts receipt insertion after decision mutation: answer and stopped-owner
replacement both roll back decision, control and revision, and exact retry
succeeds. Replacement retry retains owner_stop through resolution. Two successive
corrections and replacements retain the original attempt and controls, preserve
superseded history, reject the old reply and accept the current one. The first
probe draft used incorrect second-correction pins; it was corrected to use the
actual current pins, and was not a product defect.

Reproduce from project root:

    env -u NODE_TEST_CONTEXT node --test --test-reporter=tap .agents/teamwork/owner-decision-20261028/challenge/probe.cjs

Inputs and TAP are ignored temporary evidence and may disappear:

    280b0b6a7cb96d8b37c047e5a974384db3100313dbc0c4b6cdbc136efbf48431  probe.cjs
    b4562c38f5231a70394b8a9eaaade0d68f95c587fe90ca677bad704ca1f38529  probe.tap

Source SHA-256 after probe; identical to critic frozen source:

    beb2e697bf9cb1f6c1a5e88dbe2f7d2e61bcc2815ad03e7a63d205104496545e  src/backlog-store.js
    d02839dfbebe00eb108e42085cbfa80228c5d70a8d221701001102efbd3211a0  src/lead-planner.js
    9608ec482ee582628b81bf1dcdb3dc0749a49df4c8ba310148be56d57292988a  src/project-delivery-controller.js
    f3dbc6dd5a25e068752159e01fd7339511727132dcbb42f5e54c3b68dbc1dd4e  src/delivery-lifecycle.js
    c62538436b71fb68a88a216f03152fc72c30f122c522d29345c782f875ed1975  src/concurrent-delivery-engine.js
    7b93cd502f522d3fb2e24e2e338edbb81c505d660b684717819ddd25da135df3  src/delivery-host-controls.js

No broad suites, prohibited test, live calls, source changes, or Git writes.
This does not qualify public HTTP routes or the complete matrix.
