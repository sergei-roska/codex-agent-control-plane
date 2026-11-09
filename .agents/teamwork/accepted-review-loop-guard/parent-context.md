# Accepted review stopped by repetition guard

Owner standing scope: root repairs Harness; target source belongs to its lead.
Current target lead run e2c71938-b92f-4b70-a231-dc0088343016 is terminal Partial.
Three attempts: uv-cache failure, stale-origin recovery, successful current-target
verifier smoke. Accepted review_result for r3 exists, yet final Partial claims
no passing receipt and stops for three repeated settled attempts. Root assigned
bounded source repair to worker, independent review to critic. No target source,
receipt DB, Git or runtime changes authorized in worker scope. Preserve genuine
failure-loop stopping and all candidate/receipt freshness checks.

Related observation delivery issue is operational: send_message cannot start a
new parent turn after parent finalizes. Sentry polling detected terminal status;
root was idle until user resumed. During observation root must stay active in
interruptible wait_agent, not finalize. Sentry remains gpt-6-luna/low and only
alerts actionable events. Timestamped watcher detection/notification requested.

## Owner product direction

Minimize Partial termination for autonomously solvable local work. Before
termination exhaust supported environment repair, meaningful replanning and
appropriate role handoff within existing authority and finite limits. Preserve
truthful incomplete acceptance, user-only decisions, explicit budget/stop rules,
and termination of genuine repeated failures without progress. Do not merely
increase retry counts or replace Partial with an accepted label. Current narrow
false-stop repair first; critic audits next concrete premature stop afterward.

## Quota clarification

Owner clarified: stop launching new tasks when five-hour REMAINING quota reaches
10 percent (usedPercent >=90), let in-flight tasks finish and pause until reset.
Earlier interpretation of10 percent used was incorrect and is superseded.
Fresh native root profile check:83 percent used,17 percent remaining; reset
2026-10-22T14:42:02+03:00. Current work/deployment may continue below threshold.
Check fresh actual quota before new assignments; do not infer from elapsed time.
