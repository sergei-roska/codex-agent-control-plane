# A3/A4 internal planning recovery and typed owner boundary

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Start only after root
accepts/commits A2 and supplies exact baseline. Read worker.toml
at /home/sr/codex-home/agents/worker.toml developer_instructions, AGENTS.md,
docs/harness-autonomy-audit-2026-10-21.md A3/A4 and current A2 handoff.
Worker owns scoped source/tests/docs; root owns Git/coordination. Node CommonJS.
No live app/service/model/target actions, external writes or commits. Disposable
SQLite/fake-provider test stacks only. English/ASCII artifacts under this folder.

Implementation scope/design:
A3: Preserve two same-thread correction reminders for invalid Lead decisions.
After the third consecutive invalid decision, make exactly ONE internal fresh
planning-context attempt carrying bounded exact validation evidence and existing
run/owner/review context. Use the same selected model/profile. Do not dispatch
any invalid assignment. Persist the recovery state across checkpoint/restart.
If this fresh attempt is invalid, end with an honest bounded technical partial
ledger and one final acceptance run, not an owner continuation question. A valid
fresh decision continues normally and resets the streak/recovery allowance.
Fresh-context selection must override session-thread reuse without discarding
required review/owner context or resetting worker effects. Preserve owner pauses
and cancellation during this recovery. A transient infrastructure or budget
AUTO-resume is not new owner intent and must not reset validation recovery
allowances; pass explicit trusted resume origin from server to orchestrator
runtime as needed, with backwards-compatible defaults for direct callers.
Explicit owner continuation can retain current legacy reset behavior.

A4: Remove implicit owner escalation from repeated goalAchieved=false finish.
Keep first unmet-goal investigation/fix opportunity and required subsequent
investigation citation. A repeated investigated false finish without a ledger
produces an honest bounded partial ledger, not goal_not_achieved escalation.
Genuine owner questions must use existing typed request_human_input with the
closed owner-only reasons, options and investigation requirements. Update
contract errors/full+delta guidance to match. This is a deliberate alternative
to a broad new blocker schema: the typed owner path already exists; free-text
finish cannot imply owner responsibility. Keep legacy checkpointed escalations
resumable through their existing explicit-owner path.

Use/refactor existing noProgressPartialLedger and forced-no-progress acceptance
only where semantics remain accurate. Generalize explicit internal partial
reasons (planning_contract_failure, goal_unmet_exhausted, existing no_progress)
without allowing model prose to bypass gates. Accepted ledger checkpoints need
current-target passing receipts; unknown/failed/unreviewed scopes stay blocked.
Synthetic technical ledger must include unfinished goal and never claim goal
completion. Final acceptance does not launch another model repair/review loop
for a forced technical stop. Preserve owner defer/outside_run, changed-check
PRD approval, round caps, unresolved writers, review-wave gates and A1/A2.

Verification acceptance:
- 3 invalid outputs -> exactly1 fresh-context attempt -> valid recovery succeeds;
  4 invalid outputs -> partial technical result, zero invalid dispatch, no owner ask.
  Exact validation evidence, full review+owner context on fresh thread.
- Restart/automatic budget or transient resume during fresh recovery cannot
  replenish allowance; selected model never changes. Owner pause/cancel honored.
- Repeated false finish about engineer-fixable local bug with required later
  investigation becomes partial without owner pause; missing investigation still
  rejected; explicit typed owner-only request still parks and accepts manual answer.
- Legacy stored human escalation can resume; partial receipt/acceptance honesty
  remains under failed/missing checks, owner-blocked checkpoints and unknown writers.
- Update affected contract/graph/orchestrator/server tests with meaningful new
  end-to-end fake-provider scenarios; preserve assertions protecting gates.
- Docs/backlog state exact behavior, bounded recovery and unqualified live effects.
Run focused affected suites and syntax/diff checks, report commands/results and
remaining risks; freeze source for independent critic then concrete challenge.
