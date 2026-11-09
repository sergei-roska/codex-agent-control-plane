# AD-07 chat status and steering

Status: status projection, revision-pinned owner controls, and browser acceptance
are implemented and verified; integrated account/budget race qualification
remains open.

## Ownership and next action

Luna explorer completed `map.md`. Durable objective status, scoped pause/resume/
cancel host and launcher routes, and the decision-card acceptance slice are
implemented. Revision-pinned controls and cancel-drain behavior have focused
and browser coverage. The remaining acceptance is composed pause/cancel behavior
against AD-02/03 account switching and budget wake, followed by integrated
AD-05 reconciliation qualification.

## Verification

- `node --test test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js` - 89 passed.
- `node --test test/delivery-host-controls.test.js test/launcher-owner-delivery.test.js test/launcher-backlog-ui.test.js` - 16 passed.
- Combined seven-suite cancellation/reconciliation command - 177 passed.
- `node --test test/launcher-decision-ui.test.js` - 17 passed; actual browser acceptance passed 1/1.

No runtime activation or live provider operations were used. See the
[pause-controls handoff](pause-controls/handoff.md),
[status-projection handoff](status-projection/handoff.md), and
[browser-acceptance handoff](browser-acceptance/handoff.md) for evidence.
