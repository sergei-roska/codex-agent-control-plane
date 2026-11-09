# AUT-02 graph worker

Owns `test/lead-graph.test.js`, `test/fixtures/autonomy/aut-02/*`, and, after
the lead's R2 approval, `src/lead-graph.js`. Do not edit direct service source,
docs/evidence, the accepted AUT-01/AUT-05 artifacts, or runtime services.

R1 freezes the stale-review baseline. R2 approved a versioned checkpointed graph
annotation and deterministic pre-lead recovery for trusted stale review
signals, capped at two generations per checkpoint. Use validated templates,
normal fresh dispatch IDs and rounds, verifier before auditor, and preserve all
existing gates, budget, pause, cancellation, round and writer controls. Lead
review and AUT-02 runbook define the full constraints.
