# AD-07 owner pause, resume, and cancel controls

Status: complete after composed account-control race qualification.

## Scope

Scoped concurrent pause/resume/cancel endpoints through host and launcher plus UI.
Cancellation remains nonterminal while downstream effects are draining.

## Changed files and decisions

Added authenticated, exact-scope host routes and launcher proxies for pause and
resume; cancel also requires the expected durable control revision. Resume is
accepted only from `paused_owner`. Cancellation reports `requested` while the
objective is `draining` and `applied` only after trusted settlement confirms
`canceled`. The UI enables actions from durable status/controller projection,
disables them while pending or draining, refreshes after stale or ambiguous
outcomes, and never blindly resends an action.

Changed product/test paths: `src/delivery-host-controls.js`,
`src/launcher-app.js`, `launcher-ui/backlog.html`, `launcher-ui/backlog.js`,
`launcher-ui/backlog.css`, `test/delivery-host-controls.test.js`,
`test/launcher-owner-delivery.test.js`, and `test/launcher-backlog-ui.test.js`.

## Verification

`node --test test/delivery-host-controls.test.js test/launcher-owner-delivery.test.js test/launcher-backlog-ui.test.js`
passed 16/16, including stale-revision rejection, unknown network outcome,
draining cancellation, and a late pause acknowledgement from a previously
selected objective. The real engine cancel-drain regression passed with the
admitted planner held until settlement. Combined seven-suite
cancellation/reconciliation command passed 177/177.
`node --test test/launcher-decision-browser.test.js` passed 1/1.
`git diff --check` passed.

## Integrated qualification

The real `startServer` concurrent composition now exercises authenticated pause
and cancel while automatic account B eligibility is pending. Both controls win
against the late eligibility result: the durable disposition and control
revision persist, the budget wait stays waiting, the account remains A, and no
switch, wake, or second worker attempt occurs. The suite is
`test/autonomous-delivery-control-races.test.js` and passed 3/3, including both
action subtests.

The full AD-08 release suite also passes the same-objective A/B exhaustion,
durable wait, server reopen, automatic resume, and accepted-check path. The
independent Luna review found no actionable defects.
