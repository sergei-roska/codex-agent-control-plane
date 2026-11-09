# Planner ledger assertion repair

Owner: junior worker. Scope: update only the inherited assertion in
`test/lead-planner.test.js` and maintain this handoff directory.

Acceptance: retain strict checks for the error code and trusted pre-dispatch
source, and assert the complete bounded provider diagnostic record emitted by
`src/lead-planner.js`. Do not change product behavior or weaken safety checks.

Root runs the broad suite after this repair. No live runtime activity or Git
mutations are authorized.
