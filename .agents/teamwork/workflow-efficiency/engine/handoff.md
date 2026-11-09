# Workflow graph implementation handoff

Status: source implementation complete; independent static review approved;
graph regression work remains pending. Baseline was `655bb47`. The lead
committed the six task paths in `f590a66` (`Reduce repeated review and planning
work in Harness`); this engine portion changed `src/lead-graph.js`.
`test/lead-graph.test.js` was not changed. Unrelated dirty paths
`docs/skill-routing-audit.md` and `harness-performance-audit-2026-10-16.md`
remain outside the commit.

Repair admission now retains receipt history and installs a durable per-
obligation guard with an immutable context hash, captured target identity, and
monotonic receipt floor. Pending IDs block reuse, including repairCapture IDs
and checkpoint IDs. On integration, old receipts remain eligible only when the
repair context and target are unchanged, effects have a complete known delta,
there are no scope violations, and effects are either released/reconciled or
the exact attested empty lane result (`not_integrated`, `no_changes`,
`lane_collection`, no head change, and zero changed paths). Unknown, changed,
unsettled, mismatched, or violating effects require receipts at or above the
raised floor. Stored verifier/auditor outcomes are re-evaluated through current
`reviewResult`; missing outcomes cannot authorize reuse. This is conservative
for legacy receipts whose trusted report is no longer available.

The canonical complete delta may omit `changedPathCount`; in that case the
changed-path array length is used. An explicit count must be a nonnegative exact
match, so truncated arrays do not qualify. The empty-lane proof still requires
its explicit zero count.

Both full and delta prompts now share a prompt-local projection, so current
target/gate hashing is done once per obligation. It emits bounded next steps:
`wait_writer`, `reconcile_unknown`, `obtain_verifier`, `obtain_auditor`,
`recovery_blocked`, or `checkpoint_complete`. Advice does not assert task or
product completion. The assignment rule now describes retained history,
pending/unsettled blocking, controller-attested unchanged reuse, and the fresh
evidence path.

Same-batch verifier handoff now covers ordinary later-wave auditors and the
existing authorized recovery replan. It requires a valid recovery state; an
absent checkpoint entry in the valid, capped recovery catalog is allowed, while
context mismatch and active `verifier_pending`, `auditor_pending`, or
`replan_required` phases block ordinary handoff. The recovery exception remains
limited to `replan_required` with `fresh_verifier_not_accepted` or
`fresh_auditor_not_accepted`. Assignment/attempt, target, context, prior group,
and bounded handoff evidence remain exact; no historical fallback is used.

Saved-dispatch source trace only, not executed: for one critical checkpoint
with an eligible verifier receipt and an attested empty no-change repair, the
pre-change fake sequence is expected to be `[repair, verifier, auditor]`; the
new path is expected to be `[repair, auditor]`, saving one verifier call. No
runtime call-count or live speedup claim is made. The requested focused
regression was not added or run because the lead directed no test additions or
execution in this continuation. The previously requested focused command is
still pending: `node --test --test-name-pattern=... test/lead-graph.test.js`,
followed by the affected graph suite once tests are authorized.

Static checks after the latest edits: `node --check src/lead-graph.js`,
`git diff --check -- src/lead-graph.js`, and the staged diff check all exited 0.
No graph tests were run. The lead reports independent static approval,
including the final optional changedPathCount correction. No live API/model,
DB, service lifecycle, or target-project edit was used.
