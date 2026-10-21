# Harness critical incidents, 2026-10-20

## Scope and baseline

Owner reported serial assignments, nonterminating verification and repair,
unnecessary owner acceptance for routine development, and failed server startup.
Findings were preserved before implementation. The initial Git working tree
was clean, baseline c22528e7f47e2fc954ce7c032d51391baccc309f. Cause locations
below refer to this baseline; implementation changes move line numbers.
Prior accepted process cleanup: commit 8b3fbea. Baseline also includes October
19/20 partial-result, recurrence-guard, owner-check, and import-cycle repairs;
do not report those earlier fixes as new work.

This report records verified code and runtime evidence separately from reported
symptoms and hypotheses. Existing target-project work and paused sessions must
be preserved. No live model trial is needed for diagnosis.

## HAR-01: serial dispatch

Verified historical evidence: docs/harness-runtime-efficiency-2026-10-19.md
records no role overlap across the sampled run. Current code already includes
worktree writer lanes and wave validation. The specific reason they did not
produce overlap is localized below. These are baseline line numbers.

Confirmed scheduling dependency: src/contracts.js:877-889 executionGroups
creates a separate group for every null wave. src/lead-graph.js:3235-3243 and
:3331-3340 run mixed/writer batches by those groups. The lead prompt at :2617
describes waves but does not require grouping independent ready work. A lead
that emits one assignment or null waves therefore receives strictly serial
execution even with available lanes. This is an explicit scheduling behavior
with insufficient planning guidance, not evidence of a broken parallel RPC.

Read-only runtime evidence: .runtime/projects/c65886082e/state.sqlite,
lane_probe stores ok=1, reason=NULL, created_at=2026-10-18T13:26:27.907Z for
Codex 0.163.0. writer_lanes contains 64 integrated lanes, 103 no_changes and
3 turn_failed outcomes at inspection. A failed confinement probe is not the
observed cause for this project. Live mode was not queried: no Harness launcher
or project server process was running at inspection.

Saved assignment envelopes further localize the planning bottleneck: c658 has
249 null-wave assignments out of 273, and only 12 of 261 rounds have multiple
assignments; c874 has 325 null-wave assignments out of 418. Twenty-six of
c874's multi-assignment rounds contain two null waves and therefore serialize.
These counts describe old runs, not measured behavior after the prompt repair.

## HAR-02: nonconverging checks and recovery

Verified historical evidence: the October 19 report traces loss of inputs,
checks, and stop conditions in captureReviewRecoveryTemplates and
recoveryAssignment in src/lead-graph.js. R129 repeated seven known blocked API
pytest launches after an automatic review refresh. The additional confirmed
completion causes and their repairs are recorded below.

Confirmed HAR-02-1: src/lead-graph.js:831-867
captureReviewRecoveryTemplates saves role/scope/tool pins but omits objective,
inputs, evidence, acceptanceCriteria, checks, and stopConditions.
recoveryAssignment at :889-950 substitutes generic instructions. Automatic
fresh-target retry therefore loses exact commands, environment limits, prior
findings, and stopping conditions. The R128-to-R129 trace in the October 19
report is a concrete instance with seven known blocked pytest launches.

Existing recovery-generation, target-repetition, recurrence, and dispatch-round
guards are present in the baseline. Their existence does not establish that a
useful milestone converges, but they must not be removed or claimed as new fixes.

Confirmed HAR-02-2: src/loop-guard.js:176-185 advanceRecurrence clears every
checkpoint recurrence counter when any observation reports an integrated
implementation. An unrelated brief or database change therefore resets the
count for a repeatedly failing, unchanged checkpoint. The counter's key already
contains the checkpoint, role class, and target identity, so unrelated progress
must not erase that identity's recurrence history. Read-only runtime analysis
found the same verifier target across rounds 163, 165, 166, 173, 174, 176, 178
with intervening out-of-scope writes. That historical run predates the current
guard; it illustrates the failure pattern but does not prove historical causation.

Confirmed HAR-02-3: src/lead-graph.js:3742-3743 routes a fully settled no-progress
detector result through escalate('loop_detected'); afterVerify routes the
resulting humanRequest to human_input. It therefore waits for owner continuation
instead of concluding with the already supported honest partial result. The
repair concludes settled no-progress work with an explicit unfinished-goal
ledger and final acceptance, while preserving genuine authorization decisions,
owner pauses, and unresolved-writer reconciliation.

## HAR-03: unnecessary owner acceptance

The baseline uses on-request App Server approval and read-only, network-free
agent-proposed final acceptance checks. Project-configured ownerChecks already
provide a separate host execution path. The enforced capability mismatch and
role conflicts are localized below.

Confirmed HAR-03-1: profiles/TEAM.md:12 delegates authorized local Git actions
to workers, but profiles/agents/engineer.toml:11 and the corresponding recovery
and senior profiles categorically forbid changing Git state. No implementation
role can follow an explicitly authorized local commit request under these
conflicting instructions. A prompt correction does not by itself grant access
to protected Git metadata inside the actual sandbox.

Confirmed capability mismatch: src/acceptance.js:423-472 runs agent-proposed
final checks with a read-only workspace and networkAccess=false. Ordinary QA
has workspace-write but may still lack sockets or protected Git access.
src/codex-app-server.js:1296-1314 declines every approval request. These are
baseline enforced policies, not a model misunderstanding. The actual owner
profile grants broader permissions to the interactive Codex session, so the
baseline Harness does not reproduce its development capabilities.

Read-only runtime evidence: latest task 9e2c8b53-458b-4ccf-924b-ee13639510df
in project c65886082e remains owner-paused and carries source='agent' checks
for pytest and ruff. Its project-settings.json has ownerChecks=['bash
scripts/ci.sh'], but src/server.js only uses that default for new requests
without explicit checks. The setting does not replace this run's existing
pinned agent contract. No contract, pause, or database was changed.

Confirmed HAR-03-2: src/a2a-role-service.js:861-862 selects a private worktree
for structured workspace-write assignments. src/writer-worktree.js:278-289
collectPatch exports only content changes against the base. A local commit
inside a lane changes that lane's Git metadata, not the shared project's branch.
Permitting Git in the role prompt cannot fix this routing defect. Authorized
administrative Git work needs an explicit shared-workspace assignment executed
under writer admission, separate from simultaneous writers.

Owner decision during diagnosis: trusted local projects must inherit their
configured native Codex permissions without repeated confirmations. This is
explicit authorization to repair policy selection, not authorization to push,
publish, deploy, or resume paused work. A zero-inference native config/read
probe for this workspace returned default_permissions=':danger-full-access',
approval_policy='never', trust_level='trusted'; permissionProfile/list returned
allowed :read-only, :workspace, and :danger-full-access profiles. The repair
retains read-only inspection roles and acceptance provenance. Its policy and
fallback behavior are specified in [execution-permissions.md](execution-permissions.md).
Official protocol/config references:
[App Server](https://learn.chatgpt.com/docs/app-server),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

## HAR-04: launcher startup

The exact owner-reported failure cannot be reconstructed from the lost log.
Current startup was qualified in an isolated disposable project; no managed
project restart or session resume was performed.

Verified prior startup defect: commit c07d7f2 fixes the import cycle
project-settings -> acceptance -> acceptance-scratch -> project-settings by
loading acceptance lazily inside normalizeOwnerChecks. The current server and
launcher modules load successfully with Node v24.21.0 and Codex 0.163.0.
This earlier defect is already fixed in baseline; it is not yet proven to be
the exact launcher incident reported by the owner. Existing launcher logs are
memory-only (src/launcher-projects.js:95-116, :345-377), so an exit/restart loses
the original server stderr. That diagnostic limitation is confirmed.

Confirmed HAR-04-2: src/launcher-projects.js:18 accepts generic product branding
as a running marker in either output stream. A startup failure such as the OAuth
requirement message in src/server.js:724 contains that branding and can briefly
be marked running before process exit. Success must use the actual listener
readiness message or a successful readiness probe.

## Implementation and qualification status

- HAR-01: lead now explicitly groups independent writers with disjoint scope
  into concurrent waves. Existing conflict and ordering checks are retained.
  Focused graph and contract checks pass. This changes planning guidance;
  a real-model comparison has not been run, so improved live overlap is not
  yet measured.
- HAR-02-1: automatic fresh-target recovery preserves all six original bounded
  brief fields. Focused lossless-brief and unchanged-target retry tests pass.
- HAR-02-2: recurrence history now survives unrelated writes; a changed target
  begins its own count. Five focused tests pass, including serialized restart.
- HAR-02-3: a settled no-progress loop now ends with an honest partial result,
  a bounded ledger using the latest integrated review outcomes, and one final
  acceptance run. Failed or unverifiable checks remain explicit; this path
  cannot dispatch another automatic repair or pinned-check reviewer. Owner
  pauses, budget limits, cancellation, and unresolved writers retain their
  existing handling. Focused termination and current-receipt tests pass.
- HAR-03: role Git conflict and shared Git assignment routing fixed. Native
  permission inheritance is implemented under the owner's explicit policy
  choice, with strict fallback for untrusted projects or unavailable policy.
  Client, settings, resolver, acceptance, and routing regressions pass except
  for the pre-existing MCP test failures listed below. Administrative Git
  assignments use an explicit shared-workspace target under writer admission;
  a private lane commit is not represented as a shared branch commit.
- HAR-04: durable bounded startup diagnostics and exact readiness implemented;
  32 launcher tests pass. Independent review found a quoted-JSON secret
  redaction gap before acceptance; it was fixed with two focused regressions
  and passed independent re-review. Exact cause of the
  owner's original failed launch remains unproven because its log was lost.
- Independent review approved the core changes and then the expanded native
  permission, shared Git, and terminal partial-result changes. The initial
  startup redaction rejection was resolved before approval.

Actual native qualification without model inference:

- The active owner configuration and permitted profile list were read through
  Codex App Server 0.163.0, without printing its complete configuration.
- A production runAcceptance invocation in an owned disposable repository
  inherited :danger-full-access/never, bound a loopback socket, passed its
  pinned agent-origin check, and reported accepted.
- Native command/exec created a local commit in that disposable repository.
  The shared project branch and target-project branches were not changed.
- Actual startServer startup with native account/config and an empty disposable
  state database exposed the Lead agent card with HTTP 200. It reported
  cooperative lanes, confinement='none', and no claimed passing probe.
- Ephemeral thread/start and thread/settings/update requests accepted the
  explicit read-only profile and legacy-strict/native-profile transitions.
  No turn/start or inference request was issued. All owned servers were closed
  and disposable workspaces removed. This is startup/capability qualification,
  not a long-running model or throughput comparison.

Final regression qualification:

- Isolated baseline `npm test`: 1,356 tests, 1,344 passed, 10 failed, 2 skipped.
- Final `npm test`: 1,385 tests, 1,376 passed, 8 failed, 1 skipped. Every
  remaining failing test also fails on the baseline; there are no new failures.
  Two stale contract expectations were updated while adding the required
  nullable execution target; recursive strict-schema validation is retained.
- Remaining baseline failures concern direct review continuation MCP metadata
  (two in `test/a2a-role-service.test.js`), MCP enumeration and selected-skill
  expectations (two in `test/codex-app-server.test.js`), role MCP allowlists and
  malformed tool tables (two in `test/role-catalog.test.js`), and lane
  continuation MCP metadata (two in `test/writer-lanes.test.js`). They remain
  verification debt, not a passing suite or established new runtime defects.
- Syntax checks pass for all 25 changed/new JavaScript files; `git diff --check`
  passes. Independent review is approved. The owned baseline worktree was
  removed after retaining its evidence.
- Detailed raw evidence is in ignored local coordination directory
  `.agents/teamwork/harness-critical/`: `final-comparison.json`, full test logs,
  `review-core.md`, `review-final.md`, and `native-*-evidence.json`. These local
  artifacts may disappear; the durable findings and results are recorded here.

No target-project source, live session, saved acceptance contract, or owner
pause has been changed. Local coordination reports are ignored by Git; this
tracked report and the backlog preserve findings for future work.
