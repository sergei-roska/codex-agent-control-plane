# M7 implementation decisions

Date: 2026-10-01. Status: complete on the fake protocol; evidence in [acceptance.md](acceptance.md). Scope: [beta plan M7](../beta-master-plan.md#m7-give-the-operator-real-control).
Contracts: [contracts.md, Commands and atomic effects](../m0/contracts.md#commands-and-atomic-effects);
Git rules: [decisions.md, Repository execution and Git](../m0/decisions.md#repository-execution-and-git).
Builds on [M3](../m3/implementation.md) (runs, lease, candidate) and [M4](../m4/implementation.md).
Owner delegated M7 to Claude after local M6 acceptance ([M6 checkpoint](../m6/pause-checkpoint.md)).
Lead decisions; workers implement them and do not re-decide them.

## Scope boundary

- Commands: Pause, Resume, Stop run, Cancel ticket (now also for active work), Edit (staged
  revision for non-backlog tickets), Return to Backlog, Review (accept / request corrections),
  Commit, Push, Release repository. Board drag/drop maps to Submit and Return to Backlog only.
- Commit/push run in a deterministic Git delivery service, never through agents. No force push,
  no PR creation, no branch deletion, no reset/stash/checkout of user files.
- No Reopen of done/cancelled tickets, no Apply-revision-to-running-run (a staged revision
  applies only through Return to Backlog or a new Submit), no parallel writers.

## D-M7-1 Data model (migration 6 `operator_controls`)

```sql
ALTER TABLE runs ADD COLUMN control_request TEXT;          -- null | pause | stop | cancel | return_to_backlog
ALTER TABLE runs ADD COLUMN control_command_id TEXT;
ALTER TABLE runs ADD COLUMN control_requested_at TEXT;
ALTER TABLE runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'initial';  -- initial | resubmit | rework
ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE runs ADD COLUMN rework_review_id TEXT;
ALTER TABLE tickets ADD COLUMN staged_revision_id TEXT;
CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, plan_revision_id TEXT, candidate_id TEXT, integrity_hash TEXT,
  verdict TEXT NOT NULL,              -- accepted | corrections
  findings TEXT, actor TEXT NOT NULL, command_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX reviews_one_per_run ON reviews (run_id);
CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL, review_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- commit | push
  state TEXT NOT NULL,                -- intended | succeeded | failed | unknown
  parent_delivery_id TEXT,            -- push -> its commit delivery
  branch TEXT NOT NULL, base_head TEXT NOT NULL, commit_sha TEXT,
  remote TEXT, remote_ref TEXT, message TEXT, error_json TEXT,
  command_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

- New run status `stopped` (terminal). New wait reason `operator_pause`. Ticket statuses
  `paused` and `done` are now actually set.
- `runs_one_active_per_ticket` stays as is (`stopped` is terminal).
- Every command bumps `tickets.version` and is idempotent through `product_commands` (M2).

## D-M7-2 Repository lease and dirty checkout

- A ticket holds the lease from first acquisition until it is `cancelled`, or its accepted
  candidate is committed, or the operator runs Release repository on a `done` ticket. Exception
  kept from M3: a run that settles without any repository effect (no branch prepared, no lead
  task) releases it. Stop and Return to Backlog keep the lease when there was a repository effect.
- `acquireLease` for a run whose ticket already holds the lease transfers it to the new run.
- Preflight takes `ownedBranch` (the ticket's `ticket_branches` row, if any). When the checkout's
  current branch equals `ownedBranch`, a dirty worktree is allowed and reported as the
  informational code `owned_branch_dirty` (`ok` stays true). Any other dirty checkout stays
  `dirty_worktree`. Branch reuse keeps the earlier run's `base_commit` (M3). The new candidate
  therefore contains the carried-over delta; the UI says so.

## D-M7-3 Control requests and settlement

Control is stored on the run (`control_request`), shown as "Pause requested" / "Stop requested"
and never as a settled state. The controller checks it at the head of every step and before
`acquireLease`, `stepBranch`, `startLead`, and each Intake turn.

| Command | Allowed when | Immediate effect | Settled effect |
| --- | --- | --- | --- |
| Pause | run `queued` or `running` (phases queued, intake, branch, engineering with lead task working/submitted) and no control pending | `control_request=pause` | run `paused`, `wait_reason=operator_pause`, ticket `paused`, control cleared. Queued: immediately. Intake: after the in-flight turn is saved. Engineering: when the lead task pauses with kind `operator_pause` (D-M7-4). |
| Resume | run `paused` (any wait reason) or `interrupted`; no stop/cancel pending | clear `operator_pause`; engineering: send A2A resume message to the lead task (same path as CLI resume, text "Resumed by the operator from the dashboard.") | run back to `queued`/`running` at its stored phase; ticket `pending`/`in_progress` |
| Stop run | nonterminal run | `control_request=stop` | run `stopped`, ticket `blocked`, `wait_reason=run_stopped` |
| Cancel ticket | ticket not `done`/`cancelled` | settled ticket: as M3; active run: `control_request=cancel` | run `cancelled`, ticket `cancelled`, lease released, pending decisions `stale` |
| Return to Backlog | ticket `pending`, `in_progress`, `paused`, `waiting_human`, `blocked` | active run: `control_request=return_to_backlog`; settled: immediate | run `stopped` (if it was active), ticket `backlog`, staged revision promoted to current |

Stop / cancel / return-to-backlog settlement by phase:

- queued, awaiting_answer, settled-without-execution: settle immediately; pending decisions `stale`.
- intake: abort the in-flight Intake turn through its AbortSignal; discard its output; settle.
- branch, candidate: let the step finish, then settle.
- engineering: lead task `working`/`submitted`/paused for `human_decision`, `waiting_for_budget`
  or `operator_pause` -> `leadClient.cancel` (existing abort chain interrupts worker turns via
  `turn/interrupt`). Lead task paused for `restart` or `writer_unresolved` -> send the resume
  message instead; the graph reconciles writers first and then honours the stop (D-M7-4).
  Settle only when the lead task is terminal AND WriterAdmission reports no active or unresolved
  writer for the workspace. Otherwise the run keeps the control request, `wait_reason=
  writer_unresolved`, ticket `blocked`, detail "Stop requested; writer outcome unresolved".
- File changes are never reverted. Stop/cancel evidence (attempts, partial candidate) is retained.
- A completed run under review is not "stopped": Cancel/Return to Backlog on `waiting_human`
  marks the latest review-pending run's decisions stale, keeps the run `completed` (fixes the M3
  overwrite of `completed` to `cancelled`), and moves the ticket.

## D-M7-4 Operator control inside the lead graph

- `LeadOrchestrator` / `createLeadGraph` take an optional `operatorControl(leadTaskId)` returning
  `null | 'pause' | 'stop'`. Synchronous, side-effect free. Legacy runs pass none.
- Checked at every safe boundary: before every `decide` (edges from intake, verify, reconcile,
  human_input, budget_pause, operator_hold) and inside `dispatch` before submitting any item
  (covers resuming from a checkpoint into a mid-batch dispatch). A hold never interrupts a
  submitted worker; it only prevents new submissions.
- On hold the graph routes to a new node `operator_hold`:
  - `stop`: status `canceled`, result reason `operator_stop`, then `finish`. Acceptance for a
    stopped run is whatever the existing canceled path produces; the product never treats it as
    accepted.
  - `pause`: `interrupt({ kind: 'operator_pause', message })` (side-effect free before the
    interrupt). On resume, re-check control: `stop` -> as above; otherwise route to `dispatch`
    when the current batch still has pending items, else `decide`.
- Writer reconciliation (verify/reconcile) always runs before the hold check, so a pause or stop
  never settles while a writer outcome is unknown inside the graph.
- The server lead executor wires `operatorControl` to the product store (lead task id -> run
  `control_request`: `pause` -> 'pause'; `stop`/`cancel`/`return_to_backlog` -> 'stop').

## D-M7-5 Review

- `POST review` with `verdict: 'accept'` requires: ticket `waiting_human`, latest run
  `completed` with `wait_reason=human_review`, body `runId`, `candidateId`, `integrityHash` equal
  to the stored candidate, no review for that run, and a fresh checkout verification
  (`verifyCandidate`, D-M7-6) when the candidate has a non-empty manifest. Effect: review
  `accepted`, ticket `done`. Read-only runs with an empty manifest bind the same fields and
  release the lease. A changed checkout -> 409 `candidate_changed`, nothing recorded.
- `verdict: 'corrections'` requires the same binding plus `findings` (1..8000 chars). Effect:
  review `corrections`; new run `run_kind=rework`, `parent_run_id`, `rework_review_id`, same
  revision (corrections keep the reviewed revision; a staged revision is not applied),
  phase `branch`, a new plan revision copied from the parent with `parent_plan_revision_id` and
  reason `rework: <reviewId>`, lease transferred. The lead goal appends the operator findings
  (framed as operator review findings) and the previous candidate manifest summary.
  Bound: at most 3 rework runs per ticket revision; the 4th request -> 409 `rework_exhausted`.
- Every new candidate invalidates older reviews/authorizations implicitly: commit/push bind to
  the accepted review's candidate and integrity hash only.

## D-M7-6 Git delivery service (`src/git-delivery.js`)

Same execution rules as `git-adapter.js`: `execFile`, hardening `-c` flags, `GIT_TERMINAL_PROMPT=0`,
`GIT_LITERAL_PATHSPECS=1`, fixed argv, bounded timeouts. It owns the only `add`/`commit`/`push`
calls in the codebase. Exports `createGitDelivery({ workspace, remotes })`:

- `verifyCandidate({ baseCommit, branch, head, integrityHash })` -> `{ ok, problems }`: current
  branch, HEAD and recomputed integrity hash (same algorithm as `captureCandidate`) must match.
  Codes `branch_changed`, `head_changed`, `candidate_changed`, `manifest_truncated`,
  `operation_in_progress`.
- `commit({ candidate, message, deliveryId })`: verifyCandidate; refuse truncated manifests;
  stage exactly the manifest paths (`add -A -- <paths>`); the staged name set must equal the
  manifest path set, else unstage those paths (`restore --staged -- <paths>`) and fail
  `staged_set_mismatch`; `commit --no-verify -F -` with message plus trailers
  `Ticket: <ticketId>`, `Candidate: <candidateId>`, `Delivery-Id: <deliveryId>`. Missing
  user identity -> `git_identity_missing`. Returns `{ commitSha }`; verifies new HEAD's parent
  is `candidate.head`.
- `reconcileCommit({ candidate, deliveryId })`: HEAD's parent is `candidate.head` and HEAD's
  message carries the trailer -> `{ state: 'succeeded', commitSha }`; HEAD equals
  `candidate.head` -> `{ state: 'failed' }`; else `{ state: 'unknown' }`.
- `remotes()`: configured allowlist intersected with `git remote`; URL with userinfo stripped.
- `push({ commitSha, branch, remote })`: remote must be allowlisted; local `refs/heads/<branch>`
  must equal `commitSha`; `push --no-verify --porcelain <remote> <commitSha>:refs/heads/<branch>`
  (no `+`, no `--force*`), timeout 120 s. Rejection -> `failed` with the porcelain reason. Network
  error/timeout -> `reconcilePush`.
- `reconcilePush({ commitSha, branch, remote })`: `ls-remote <remote> refs/heads/<branch>`;
  equals sha -> `succeeded`; differs/absent -> `failed`; ls-remote error -> `unknown`.
- Project policy (`project.json`) gains `delivery: { remotes: ["origin"] }` (default `["origin"]`).

## D-M7-7 Commit and push commands

- Commit: ticket `done`, accepted review, body `candidateId` + `integrityHash` equal to the
  review's, no `succeeded`/`intended` commit delivery for that candidate, no active writer,
  lease held by this ticket. Message 1..2000 chars, no NUL; default suggested by UI
  "<title>". Persist delivery `intended` before Git; then `succeeded` with sha (release lease) or
  `failed` with error. On startup an `intended` commit is reconciled with `reconcileCommit`.
- Push: succeeded commit delivery, body `deliveryId`, `commitSha`, `remote` matching; push
  delivery `intended` -> result. `unknown` and `failed` allow a new Push command (new delivery
  row, new commandId). Startup reconciles `intended` pushes with `reconcilePush`.
- Release repository: ticket `done` without a succeeded commit; releases the lease, records an
  event; changes stay in the checkout.
- Commands are executed by the delivery controller (single tick lane) so Git delivery never
  overlaps a branch/engineering step.

## D-M7-8 API (`/api/dashboard/v1`)

All POST bodies carry `{ commandId, expectedVersion }` plus:

| Endpoint | Extra body |
| --- | --- |
| `/tickets/:id/pause` | `runId` |
| `/tickets/:id/resume` | `runId` |
| `/tickets/:id/stop` | `runId` |
| `/tickets/:id/cancel` | - (extended to active work) |
| `/tickets/:id/return-to-backlog` | - |
| `/tickets/:id/revisions` | as M2; non-backlog open tickets create a staged revision |
| `/tickets/:id/review` | `runId`, `candidateId`, `integrityHash`, `verdict`, `findings?` |
| `/tickets/:id/commit` | `candidateId`, `integrityHash`, `message` |
| `/tickets/:id/push` | `deliveryId`, `commitSha`, `remote` |
| `/tickets/:id/release-repository` | - |

- `GET /tickets/:id` adds `stagedRevision|null`, `review|null` (latest), and run summaries add
  `controlRequest|null`, `runKind`, `parentRunId|null`. `availableActions` / `unavailableActions`
  are computed from the state tables above (no more static M7 list).
- `GET /tickets/:id/delivery` -> `{ candidate|null, review|null, commitPlan|null: { branch,
  baseCommit, head, files: manifest.length, manifestTruncated, remoteRef }, remotes: [{ name,
  url }], deliveries: [...] }`.
- Action names in `availableActions` / `unavailableActions`: `revise`, `submit`, `cancel`,
  `pause`, `resume`, `stop`, `return_to_backlog`, `accept`, `corrections`, `commit`, `push`,
  `release_repository`.
- Shapes: review `{ reviewId, runId, candidateId|null, integrityHash|null, verdict:
  'accepted'|'corrections', findings|null, createdAt }`; delivery `{ deliveryId, kind:
  'commit'|'push', state: 'intended'|'succeeded'|'failed'|'unknown', parentDeliveryId|null,
  branch, commitSha|null, remote|null, remoteRef|null, error: { code, message }|null, createdAt,
  updatedAt }`; `stagedRevision` uses the existing revision shape.
- New error codes: `candidate_changed`, `rework_exhausted`, `git_failed` (409/409/502).
- Board cards: `controlRequest`, and `dragActions: [submit|return_to_backlog]` per card.

## D-M7-9 UI (`web/dashboard/**` only)

- Ticket record: Pause/Resume/Stop/Cancel/Return to Backlog from `availableActions`, each with a
  confirm; pending control requests shown as a banner; staged revision notice.
- Run panel review banner: Accept and Request corrections (findings textarea) bound to the shown
  candidate id/hash; delivery panel with branch, base/head, file count, remote select, commit
  message, Commit then Push, delivery history and states (`unknown` explained).
- Board drag/drop: ticket cards draggable when they advertise a drag action; drop on Pending ->
  submit, on Backlog -> return to backlog; anything else is rejected and the board re-renders
  from backend state. Keyboard alternative: the record actions.

## Verification plan

Fake protocol with a temp git repository and a local bare remote. Cases: pause during a held
writer (pause requested visible, no new dispatch, paused after settle, resume continues the same
plan); stop during a writer (interrupt, stopped, files retained); cancel/return during
queued/intake/awaiting_answer/engineering/review/blocked; restart then resume from the
dashboard; accept, commit, push to the bare remote; stale integrity hash, changed file after
accept, commit without accept, push of a different sha -> no effect; corrections create a rework
run and a new candidate; drag rejects invalid moves; protected reference hash check.
