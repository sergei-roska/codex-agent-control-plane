# Workflow efficiency guidance

The source-created lead instructions favor a bounded, independently reviewable
package for closely related changes sharing state and invariants. The lead
must declare observable acceptance criteria, dependencies, ownership, and the
integration boundary before dispatch. This avoids splitting one capability
into micro-diffs that trigger repeated review of unchanged scopes.

Package planning preserves user and project session limits, dependency order,
worker ownership, independent review, risk gates, and intermediate checkpoints.
It does not authorize combining unrelated critical checkpoints or dropping
dependencies. Successive implementation, verifier, and auditor waves are
appropriate only when the runtime carries the required handoff data. Supplied
deterministic workflow state and still-valid immutable contexts should be
reused. On infrastructure failure, fix the failed delivery or admission
prerequisite. Classify a failure as infrastructure-only only when evidence
supports it. Follow deterministic controller invalidation and recovery state,
which can require a fresh verifier run even when candidate bytes are unchanged;
instruction prose cannot override that state. Batching cannot imply completion
or bypass a required gate.

## Runtime delivery and profile identity

`createLeadRole` reads `profiles/TEAM.md` and appends its rules directly to the
source-created lead instructions. The added lead instruction also summarizes
the package planning rule. `loadRoles` embeds the same team rules into runtime role
instructions for profiles that request team rules. The source-file callback
records `TEAM.md` alongside profile TOML files. Effective role and lead
instructions feed the team-rules identity hash; each role's effective
instructions feed its role profile hash. Therefore changing these rules
changes the loaded team identity and relevant role hashes, so resumed sessions
cannot silently reuse an old instruction profile.

The guidance is planning advice, not runtime enforcement. It does not change
assignment validation, permissions, tool delivery, review-verdict handling,
session limits, or checkpoint state transitions. The trial-pinned AUT-03 skill
and its hash were not changed.

## Review verdict correction

`reviewResult` rejects a verifier report whose first line explicitly starts with
`VERDICT: fail` or `VERDICT: inconclusive`, including a following explanation.
A completed execution and passing commands cannot override that negative
verdict. Existing scope, check, writer-settlement and coverage guards still run
first. Positive or verdict-free verifier reports keep their previous contract;
the auditor still requires its strict standalone first-line verdict.

This closes the observed mismatch where a verifier reported a product defect
but its review metadata appeared accepted. It is a consistency correction, not
a reason to remove independent review. It does not parse arbitrary prose into
a verdict or migrate previously stored live receipts.

## Evidence reuse after repair

Repair dispatch preserves the receipt history and records a persistent pending
guard. Review cannot use those receipts while the writer is pending. Once the
result is integrated, reuse requires the same immutable review context and exact
target identity, a complete trusted delta, and no reported or attested scope
violation. Eligible settlement is either a released/reconciled execution or the
specific attested empty lane with `reason: no_changes`, `source: lane_collection`,
no head change, and zero changed paths.

Changed, unknown or unsafe effects advance a persistent receipt floor. Earlier
receipts stay in history but cannot satisfy the gate, including after a later
unchanged repair or a return to earlier file contents. Pending state and the
floor live in checkpointed obligations, not a process cache. Concurrent repair
admission is conservative and does not regain earlier evidence eligibility.

Receipt selection also re-evaluates the corresponding stored report under the
current review policy. Missing original outcome evidence prevents reuse.
Negative audit evidence and controller recovery requirements still require a
fresh verifier. No text-based infrastructure-failure exemption was introduced.

### Source-traced avoided dispatch

Consider a checkpoint with an accepted verifier, no accepted auditor, and a
shared repair that proves no change to that checkpoint's target or context.
Previously repair dispatch cleared the verifier receipt, so the auditor gate
required another verifier. With the new guard, the original eligible verifier
receipt remains usable after settlement, allowing the auditor to run next.
This removes one required duplicate verifier dispatch in that case. It is a
static control-flow example, not an executed comparison or measured time saving.

## Handoff and next-step advice

A matching auditor in a later execution group receives the exact current
verifier report and receipt through the existing bounded handoff format. The
selection binds checkpoint context, target, assignment, attempt and execution
order. It does not substitute historical reports when the fresh handoff is
unavailable. Existing recovery restrictions continue to apply.

Full and delta lead prompts include bounded deterministic checkpoint advice:
wait for the writer, reconcile unknown effects, obtain a verifier, obtain an
auditor, handle blocked recovery, or observe a completed checkpoint gate. This
is not product task completion or automatic dispatch. Both prompt sections use
one prompt-local projection so adding advice does not hash each review target
a second time. No cross-turn cache bypasses current target computation.

## Delivery and measurement limits

These are source changes. No managed service was restarted and no live run was
modified to load them. The earlier review-policy worker reported eight passing
tests from `node --test test/review-policy.test.js`. Subsequent changes receive
static review only: runtime verification is pending under the current instruction
not to add or run tests without an explicit request.

Independent static review approved the changes after corrections to receipt
floor persistence, recovery admission, and production delta compatibility.
Syntax and diff checks passed. This approval does not qualify runtime behavior.

Runtime qualification should cover unchanged empty-lane and unrelated-scope
repairs, changed/unknown effects, pending writers, repeated repairs and restart,
negative audit invalidation, fresh receipts after later writes, ordinary and
recovery handoffs, and both prompt forms. These cases have not been executed
for the graph changes in this delivery.

The audit measured avoidable failure mechanisms alongside necessary review
work. It did not establish a single-agent performance baseline. This change
does not establish a percentage speedup, saved wall-clock minutes, or equal
acceptance confidence. Package guidance is expected to reduce repeated planning,
but its effect needs a comparable authorized measurement after deployment.
