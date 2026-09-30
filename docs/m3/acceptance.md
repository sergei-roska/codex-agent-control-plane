# M3 acceptance record

Date: 2026-09-30. Candidate: uncommitted working tree on `feature/dashboard-integration`
(base 9235431). Decisions: [implementation.md](implementation.md), including the audit
hardening in D-M3-8.

Evidence uses the fake Codex protocol, both in the dev harness
(`DASHBOARD_DEV_SCENARIO=delivery npm run dashboard:dev`) and in the integration tests. The
fake Intake, lead and builder are scripted. Git operations, branch creation, candidate capture
and acceptance checks are real: `node --test` runs in a real temp repository. No live OpenAI
model run was performed; that remains separate evidence for M9 or an explicit owner request.

## Exit gate

Gate: one direct bugfix and one direct feature reach review with inspectable changes, prior
saved plans and actual acceptance evidence. Insufficient requirements produce a specific
waiting state. A failed model or check cannot be reported as accepted work.

| Item | Result | Evidence |
| --- | --- | --- |
| Feature to review | pass | Pending -> In Progress (Intake, Branch, Engineering) -> Needs Attention "Waiting for your review"; 4 plan stages succeeded; branch `feature/add-farewell-helper-f1-clsyya` from main 8b9e4c1; check `unit` exit 0, disposition accepted; diff shows the edit to `src/greet.js` |
| Plan before dispatch | pass | `plan_saved` and `engineering_started` at 15:16:53; the first dispatch comes one scripted 3 s turn later; candidate at 15:17:22 |
| Bugfix to review | pass | `[bug]` ticket classified bugfix; branch `fix/bug-fix-greeting-b2-azzycg` (policy prefix); accepted, diff present |
| Insufficient requirements | pass | `[ask]` ticket -> waiting_human "Waiting for your decision" with 2 questions; answered in the UI -> Intake turn 2 -> review, accepted |
| Failed check not accepted | pass | `[break]` ticket -> Needs Attention, "Checks did not pass - not ready for review", disposition rejected (check_failed), exit 1 with the failing assertion tail |
| Repository serialization | pass | second ticket Pending "Repository in use by tkt_..."; after cancelling the first, the lease is released and the second blocks with truthful `dirty_worktree` (the first candidate is still uncommitted) |
| No Git mutations beyond branching | pass | `git log --all` shows only the base commit; `git status` shows the uncommitted candidate; branch names match the plans |
| Reload and restart in review | pass | same run, branch and candidate integrity hash `b9506800419fafd6` after a page reload and a server restart |
| Console, tests, reference | pass | no CSP violations or JS errors; `npm test` 506/506; reference manifest OK |

Integration tests also cover: intake_exhausted, intake_invalid, lead human decision during
engineering, plan violations and `plan_violation`, repair after a rejected acceptance, each
candidate gate (empty_candidate, head_moved, candidate_changed, branch_mismatch,
check_set_mismatch, stages_incomplete), adoption mismatch, cancel with a paused lead task,
the cancel refusal for restart/writer_unresolved pauses, restart mid-intake and mid-engineering,
and malicious `core.fsmonitor`/`diff.external` configuration not executing.

## Independent audit

The M3 audit found three major and six minor defects, all addressed per D-M3-8:

- a planned run could not repair after a rejected check;
- candidates were not re-verified against the plan and the checkout;
- protected paths such as `.git` were writable through a plan;
- plus base reuse, streamed hashing and manifest cap, prompt delimiters, lease/writer interlock,
  docs checks, and the normalized plan.

The final lease-release refinement (runs that settle before any branch release the lease) is
covered by tests.

## Scope decisions and limits

- Accept result, Request corrections (rework), Pause/Resume/Stop, Return to Backlog,
  Commit and Push are M7. In M3 the flow ends in review or blocked; rework on the same
  ticket lands with the M7 review commands.
- A reviewed or blocked ticket that touched the repository holds the lease until cancelled.
  Its uncommitted candidate then makes the next ticket's preflight report `dirty_worktree`
  until the operator handles the checkout. This is by design and not hidden.
- A graceful server shutdown during engineering cancels the lead task (existing shutdown
  semantics). The run then settles stopped and needs a new Submit. Only a crash takes the
  restart-pause path.
- Settings are pinned per run as a snapshot of the configured legacy role pack. Editable
  models are M5, and the nine-role pack is M4.
- The dev harness `SIGUSR2` reset runs `git reset --hard`/`clean` only on its own generated
  workspace under the dev directory. It is dev tooling, never used against an operator
  checkout.
