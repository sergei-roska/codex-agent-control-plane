# AUT-02 graph handoff

Status: R1 baseline frozen; R3 graph implementation authorized by lead.

## Verified baseline

- Baseline source snapshot equals current `src/lead-graph.js` at SHA256
  `c982762654c32f295ccc1893f0f3c878922b9b61928cb1c74221e5d3493c136a`.
- Automatic-selection probe TAP:
  `artifacts/autonomy/aut-02/baseline/graph-automatic-recovery.tap`, SHA256
  `d68ad038b3cccb38ecd4a665c6315853e833fc45fe292f5e98e94e84145dd31b`.
  It fails with 2 submitted reviewer inputs (initial verifier/auditor pair),
  expected 4, after the graph skips `stale_review_continuation`.
- Probe source SHA256 `068b1337f108dd672552c0741bb6bb998632143a1498a35fcece89bb1e67984e`.
- Fixture SHA256 `dd573afec0a8e74ddfb315f5a18aa04f2828fce0eeb35aaa5bfe7060484e3f00`.
- Seven focused retained controls pass, 0 fail: stale scripted recovery,
  complete full/resumed review context, receipt reuse, routine no-auditor,
  resumed finalization freshness, owner-pause restart, unresolved-writer gate.
- Exact control command is in the AUT-02 runbook. Node is v24.21.0.
- No runtime source changed before the failing TAP and hashes were frozen.

## R2 constraints

Lead and critic approved deterministic pre-lead recovery. Use a versioned
internal graph annotation with absent defaults and fail-safe invalid-state
handling. Keep exact review scope in the obligation; retain only validated
reviewer role/permission/skill/profile pins. Do not retain thread, origin,
target, result, or old-target prose for a fresh attempt. Max two generations
per checkpoint including candidate churn. Fresh verifier then auditor use
normal rounds and dispatch IDs. Respect budget, owner pause, cancellation,
round limit, unresolved writers and current-target receipt gates. Do not retry
generic failed or inconclusive reviews. Direct service code is owned elsewhere.

## Next

Implement the scoped graph state capture/trigger/selection path in
`src/lead-graph.js`, then rerun the frozen probe, focused controls, and add the
lead-requested restart, cap, boundary and test-write probes as available.
