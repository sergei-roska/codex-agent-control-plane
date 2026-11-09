Verdict: HOLDS
Status: complete
Scope expansion: none

Owned probe: /tmp/ll8-edge-probe.js
Exact command: node /tmp/ll8-edge-probe.js
Result: Both prior failures are repaired. Identical write_refused failures with changing report.risks prose now have one evidence key, warn after round 3, and pause after round 4. Four completed research reports, each with the same 20 inspected paths plus a distinct 21st path, now have four evidence keys and no warning or pause. Both complete report shapes pass parseWorkerReport (null schema errors).

Graph-path verification: `analyzeWorker` computes `loopEvidenceIdentity` from the full parsed report before `projectReport` cuts the displayed path list to 20. `outcomeSummary` retains that hash, `verify` supplies it to `makeObservation`, and prompt construction excludes the hash. The focused graph test `novel inspected paths after the projected report cap still prevent a false loop pause` passed and asserted four episodes while the displayed report held 20 paths.

Accept-as-is gates: `resolveEscalation` routes every escalation's accept_as_is choice to status completed, then `afterHumanInput` routes to `accept`. `accept` runs `assess`, enforces pending review obligations, and then finishes. `assess` supplies unresolvedWriterCount to runAcceptance, whose issue builder emits writer_unresolved. A loop pause is generated only after a settled batch; no active unresolved writer can be hidden by that path. Focused graph tests for acceptance execution and a pending critical review gate passed. This is shared routing for loop_detected, round_limit, and goal_not_achieved; no escalation-specific bypass was found.

Focused command: env -u NODE_TEST_CONTEXT node --test-name-pattern='novel inspected paths after the projected report cap|three repeated research rounds warn the lead|accept_as_is finishes with the lead final text and acceptance still runs|owner accept_as_is cannot make a pending critical review gate accepted|the round limit pauses for the owner instead of ending with max_rounds' test/lead-graph.test.js
Result: 5 passed, 0 failed.

Tried: Structured failure prose churn, accepted 21-path reports, full-report graph evidence propagation, warning/pause, and acceptance/review/writer routing.
