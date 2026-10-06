# Beta operator guide

Status: Operator procedure for the M9 release candidate; the M9 exit gate is met. See [acceptance](acceptance.md) for evidence and limits.

## Install and start

Use a trusted local checkout and a clean task repository. The beta is a single-operator,
loopback-only application. The M9 test host runs Node.js 24.21.0, npm 12.1.0, and
Codex CLI 0.160.0; this is a tested combination, not a support range.

1. Run `npm ci` in this project.
2. Run `codex login status` and confirm `Logged in using ChatGPT`. If needed, run
   `codex login` in a terminal. The dashboard does not collect an OpenAI API key.
3. Set `CODEX_WORKSPACE` to the absolute path of the task repository. Keep the
   state database, token file, attachment directory, and Codex credential/session
   paths outside that writable task repository. The server checks these paths at
   startup. The task repository must also be outside the application checkout;
   overlapping paths are rejected. Keep the task checkout clean before submission.
4. Start with `CODEX_WORKSPACE=/absolute/path/to/task-repo PORT=3000 npm start`.
   Open the printed dashboard pairing URL on the same machine. The one-time code
   creates a local session; do not share the URL or `.runtime/a2a-token`.

The server serves `web/dashboard`, the application working copy. The protected
`artifacts/dashboard` prototype is never a runtime output directory.

## Direct ticket

1. Select **New Ticket**, enter a bounded request and acceptance criteria, and
   save. Attach only the files needed for the task.
2. Check the saved ticket in **Board**, then submit it from Backlog. A saved plan
   and pinned inputs precede engineering dispatch. Answer any Intake question in
   **Decisions & Escalations**.
3. Inspect the ticket's run log, attempts, checks, and candidate diff. A failed or
   unavailable check is not a verified candidate. Use **Request corrections**
   with concrete findings when the candidate needs rework.
4. **Accept** only the candidate you reviewed. Commit and push are separate,
   candidate-bound operator actions. The owner creates the pull request; the app
   does not create one.

Pause, Resume, Stop, Cancel, Return to Backlog, and Release Repository are
state-checked commands. A stop retains file effects. Do not manually switch or
modify the leased checkout while a run is active or awaiting review. A second
ticket waits (`repository_busy`) for the checkout lease to clear.

The lease follows the ticket, not the run. Accept does not release it; a succeeded
Commit does. Return to Backlog releases the lease when no writer is active or unresolved and the ticket has no commit in progress or done; otherwise it keeps it. Release Repository is available
only for an accepted (done) ticket or a backlog draft. It frees the lease without
touching files: if an accepted candidate was not committed, its changes stay in the
checkout, and the next ticket's branch preflight refuses the dirty worktree until
you commit or clean those changes yourself. The normal order is review, Accept,
Commit, optional Push, then the next ticket.

## Jira ticket

Configure the read-only Atlassian OAuth connector using the dedicated app and
private secret files described in [connector setup](../m6/operator-setup.md).
Grant that account only the Jira projects and Confluence spaces approved for the
pilot; the application does not yet enforce project or space allowlists.
Without this optional connector, direct tickets still work. Connect in
**Connections**, select the granted site, and import an issue key or immutable
numeric ID. Inspect the saved issue, parent/epic, and available Confluence
provenance before submitting. Missing or inaccessible context stays marked as
such. Re-import opens the existing internal ticket; **Refresh Source** creates
pending context when available source content changed. Apply it through a new
revision rather than silently changing an active run.

The rest of the delivery lifecycle is the direct-ticket flow. Internal progress
never publishes issue changes, comments, status, or pages to Atlassian. Use the
[egress audit](../m6/operator-setup.md#egress-audit) after a pilot.

## Recovery and upgrade

Follow [state upgrade, backup and restore](../operations/state-upgrade.md). Stop
the server before an offline backup or restore, retain the database and attachment
directory together, and preserve the old state until the restored copy is checked.
Do not copy a live SQLite database as a plain file. On restart, an interrupted
writer is reconciled before another writer is admitted. Inspect the retained
ticket, run, plan, attempts, and candidate state before Resume. Resume is an
explicit operator action; it does not promise continuation at the exact model
token where a process stopped.

Before a planned stop, Pause active runs and wait for Paused, or let them reach
review. A clean stop (Ctrl+C or SIGTERM) cancels a run that is still executing;
Resume is then unavailable, and Return to Backlog followed by Submit starts a new
run on the same ticket branch with the history retained. A crash leaves the run
`interrupted`, and Resume continues it after restart.

## Adaptive bugfix route

A `bugfix` ticket always has the same four stages (reproduce, implement, review,
verify). The route decides how many of them execute. Decision record:
`docs/adr/adaptive-delivery-route.md`.

- **full**: all four stages, as before. This is the default.
- **lean**: implement (the Developer also records the failing baseline evidence
  first) and an independent QA verify. `reproduce` is skipped and `review` runs
  only after a promotion. A clean lean run needs no lead model calls: the lead's
  decisions are derived from the plan.

Policy key `adaptiveRoute` in `project.json`:

| Value | Behavior |
| --- | --- |
| `off` (default) | Nothing changes: same Intake prompt, same plan, full route. |
| `shadow` | The PM proposes a route and code computes the verdict, both recorded, but the full route executes. Use it first to see what would have been lean. |
| `on` | A ticket runs lean when code accepts it. |

Code decides, the PM only proposes: lean needs the PM to propose it AND all of
these: classification `bugfix`, at most `maxFiles` allowed files, no protected path
(auth and permissions, config, migrations and install hooks, dependency manifests,
environment and CI files, database schema, routing and permission definitions), at
least one approved check, only single-file allowed entries with an extension (no
directories or extensionless names), no optional stage in the plan, and policy `on`.
The server re-checks this itself.

A lean run is promoted to full, never back, when the attested change is unknown,
leaves the allowed files, touches a protected path, exceeds `maxChangedLines` or
`maxChangedBytes` (counted cumulatively over every writer so far), changes a file
mode, is empty after the implement stage, any stage does not succeed, a conditional
stage (the Reviewer) is dispatched, a stage reports scope expansion or a needed
decision, or the acceptance gate does not accept. The check runs after every
writable stage, not only the implement stage. A promoted run cannot finish before the Reviewer
has approved. The route, its reasons, and any promotion are shown in the ticket
run details and the Monitor events `route_decided` and `route_promoted`.

Measure cost with `npm run usage -- --task <ticketId> --state <state.sqlite>`; it
now includes Intake, lead, and worker rows and a per-run breakdown.

## Troubleshooting

| Symptom | Operator action |
| --- | --- |
| Startup rejects account | Run `codex login status`; sign in with ChatGPT OAuth and restart. API-key mode is unsupported. |
| Startup rejects a path | Move state, attachments, token, or Codex credential/session storage outside the writable task repository; do not weaken the path check. |
| Dashboard shows unpaired or unauthorized | Use a fresh printed pairing URL on the same loopback host and port. `localhost` and `127.0.0.1` have different cookies. |
| Ticket waits on a repository lease | Commit the owning ticket's accepted candidate, or Release Repository for an accepted ticket or backlog draft. Return to Backlog also frees it when no writer is active and no commit exists (see the lease note above). Inspect unresolved writer/reconciliation state before retrying. |
| Branch preflight reports `dirty_worktree` | The checkout holds uncommitted changes, often an accepted candidate released without Commit. Commit or clean them in the task repository, then resubmit. |
| Resume is unavailable after a restart | The run was cancelled by a clean stop. Return the ticket to Backlog, then Submit. |
| Check failed or evidence unavailable | Read the recorded command and output; correct the candidate or rerun after the underlying check is available. Do not treat unavailable as pass. |
| Atlassian reports `reconnect_required` | Reconnect the dedicated app. A failed import/refresh preserves the last valid snapshot and ticket revision. |
| Model quota or rate limit pauses a run | Wait for capacity, inspect the retained run, then Resume with the same task. |
| Run paused or ticket blocked with 'Sign in to Codex' | Run `codex login` (ChatGPT), then Resume (or Submit again if it failed at Intake). No server restart is needed: the server refreshes its Codex session on the next run. Do not sign in again in another window while runs are active. |
| Restore loses later edits | Return to the preserved pre-restore state only if it is still available. A backup intentionally excludes changes made after it. |

## Current limits

This beta is local and single-operator. The project supports a trusted task
workspace and one writer at a time. Other local services on the same loopback
hostname can receive host-scoped browser cookies across ports; operate it on a
trusted local machine. Atlassian access is read-only; linked issue
traversal and inaccessible/missing live-source cases still need explicit pilot
coverage. MLflow Tracking export is optional and production adoption is deferred;
there is no verified GenAI trace ingestion. Usage may be partial and monetary cost
is unavailable without measured cost data. The prompt candidate evaluated in M8
was not promoted. See [M8 acceptance](../m8/acceptance.md) and M9
[acceptance](acceptance.md) for the evidence boundary.
