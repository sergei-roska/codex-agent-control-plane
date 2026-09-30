# M3 implementation decisions

Date: 2026-09-30. Status: complete; evidence in [acceptance.md](acceptance.md). Scope: [beta plan M3](../beta-master-plan.md#m3-execute-a-direct-task-through-intake).
Builds on [M2](../m2/implementation.md) and [M1](../m1/implementation.md). Contracts:
[contracts.md](../m0/contracts.md); Git and lease rules:
[decisions.md, Repository execution and Git](../m0/decisions.md#repository-execution-and-git);
interim role mapping: [roles-tools.md, PM mapping](../m0/roles-tools.md#pm-mapping-and-repair-routing).
Lead decisions; workers implement them and do not re-decide them.

## Scope boundary

- M3 commands: `submit` (backlog -> pending), `answer` (answer a pending decision), and
  `cancel` extended to settled tickets (`waiting_human`, `blocked`) with no active execution.
- Out of M3, moved to M7 with the other candidate-bound review commands: Accept result,
  Request corrections (rework), Pause, Resume, Stop, Return to Backlog, Commit, Push. In M3 the
  flow ends when a ticket reaches review (`waiting_human` / `human_review`) or `blocked`.
  Rework "against the same ticket" therefore lands in M7; this is a recorded scope decision.
- Interrupted/budget/error/writer-unresolved lead pauses make the ticket `blocked` with the raw
  reason and the existing CLI resume command shown; the controller picks the run up again
  when the lead task progresses. Dashboard Resume is M7.
- No commit, push, stash, reset, or branch deletion anywhere in M3. The candidate stays as
  uncommitted changes on the task branch.

## Module layout

| Module | Responsibility | Wave |
| --- | --- | --- |
| `src/git-adapter.js` | preflight, branch preparation, candidate capture (read + `git switch -c` only) | 1 |
| `src/project-config.js` | operator project policy file: base ref, branch prefixes, approved checks | 1 |
| `src/intake.js` | PM Intake prompt, `INTAKE_SCHEMA`, output validation, requirement rendering | 1 |
| `src/plan-validator.js` | deterministic plan validation and stage progress rules | 1 |
| `src/lead-graph.js`, `src/contracts.js`, `src/lead-orchestrator.js`, `src/role-catalog.js`, `src/server.js` (lead executor) | plan pinning and enforcement, PM lead role, delivery routing | 1 |
| `src/product-migrations.js` (migration 2), `src/product-store.js`, `src/delivery-controller.js` | runs, plans, decisions, candidates, lease, state machine | 2 |
| `src/dashboard-api.js`, `src/dashboard-projection.js` | commands, run/plan/candidate reads, board statuses | 2 |
| `web/dashboard/**` | submit, run panel, questions, plan, candidate diff and evidence | 2 |

## D-M3-1 Project policy

File `CODEX_PROJECT_CONFIG` (default `<state dir>/project.json`), operator-owned, outside
the workspace so agents cannot edit it. Read at startup; its sha256 is `projectPolicyRevision`.
Missing file = defaults with no checks.

```json
{
  "baseRef": "main",
  "branchPrefixes": { "feature": "feature/", "bugfix": "fix/", "docs": "docs/" },
  "checks": [ { "id": "unit", "argv": ["npm", "test"], "timeoutMs": 600000, "description": "Unit tests" } ]
}
```

Validation reuses `validateAcceptanceContract` rules for each check (id, argv, timeout).
Check ids are the only way a plan names a check; Intake cannot invent argv.

## D-M3-2 Intake (PM coordinating entry point)

- One Codex turn with the PM lead role: `createPmLeadRole()` = the lead role (same model,
  effort, read-only sandbox, team rules) with a PM responsibility preamble: owns requirements,
  readiness, scope, coordination and delivery report; must not implement; asks the operator
  only when missing information materially changes the deliverable or required authority.
  `promptVersion = 'pm-intake-v1'`.
- Input: rendered requirement revision (title, description, criteria, references marked
  "not retrieved", extracted text of `extracted` attachments with a 100,000-char cap per file
  and a note for `stored_not_read`/`reference_only` files that content was NOT read), previous
  intake questions and operator answers, the M3 role mapping, the approved check list, and
  the base ref. Content from tickets and attachments is framed as untrusted evidence.
- Output `INTAKE_SCHEMA` (strict JSON schema; every property required, nullable where noted):

```json
{
  "readiness": "ready | needs_input | unsupported",
  "classification": "feature | bugfix | docs | audit",
  "requirements": { "summary": "", "scope": [""], "outOfScope": [""], "unknowns": [""], "expectedOutcomes": [""] },
  "questions": [ { "id": "q1", "question": "", "why": "" } ],
  "unsupportedReason": "string | null",
  "plan": { "stages": [ { "stageId": "", "roleId": "", "objective": "", "dependencies": [""],
            "allowedFiles": [""], "required": true } ], "checkIds": [""] } | null
}
```

  `needs_input` requires 1..5 questions and `plan: null`; `ready` requires a plan and no
  questions; `unsupported` requires `unsupportedReason`.
- At most 3 Intake turns per run (initial + 2 after answers); a `needs_input` on the 3rd turn ->
  blocked `intake_exhausted`. Invalid output (schema or plan validation) gets one corrective retry with
  the errors, then blocked `intake_invalid`.
- Intake runs with the repository lease held (it reads the checkout) but before branch
  preparation; it never writes.

## D-M3-3 Plan validation (`src/plan-validator.js`)

- Allowed stage roles (interim mapping): `orch-explorer`, `orch-scout`, `orch-architect`
  (read-only), `orch-builder` (Developer), `orch-verifier` (QA), `orch-auditor` (Reviewer).
  `orch-repair-xhigh` / `orch-repair-sol` are never stage roles; their attempts count toward
  the `orch-builder` stage they repair.
- 1..12 stages; `stageId` `^[a-z0-9-]{1,40}$` unique; dependencies reference earlier-declared
  stage ids; acyclic; objectives 1..2000 chars.
- Writable stages (`orch-builder`, `orch-verifier`) need 1..20 `allowedFiles` passing the same
  `safeRelativePath` rule as assignments; read-only stages have `[]`.
- Classification rules: feature/bugfix need a required `orch-builder` stage, a required
  `orch-verifier` stage and a required `orch-auditor` stage, both depending (directly or
  transitively) on the builder stage, and >= 1 `checkIds`. docs needs a required builder and a
  required auditor stage. audit must be read-only (no writable stage) with a required auditor stage.
- `checkIds` must be a subset of the project policy ids; feature/bugfix with an empty project
  check list -> invalid with reason "no approved acceptance checks configured".
- The saved plan revision is immutable: `plan_revisions` + ordered stages JSON, `validatedAt`,
  `validatorVersion: 'm3-plan-v1'`. Only a validated plan is ever dispatched.

## D-M3-4 Plan enforcement in the lead graph

- `LeadOrchestrator.run({ goal, runId, contract, plan, signal })`: `plan` is pinned in graph
  state like `contract`; resume cannot change it. `plan` null = legacy behavior unchanged.
- `DECISION_SCHEMA` assignments gain `stageId: string | null` (required, nullable). Legacy
  prompts say "use null"; fake fixtures default to null.
- With a plan, in `decide` after `validateDecision`: each assignment's `stageId` must name a
  stage whose dependencies have all succeeded, and that has not succeeded yet; its role must be
  the stage role (or a repair role for a builder stage that has an attempt); its `allowedFiles`
  must be a subset of the stage's; `finish` is allowed only when every required stage has
  succeeded. A violation is not an exception: the decision is discarded, a note listing the
  violations is added for the next decide, and it counts as a round. After 2 consecutive
  violating decisions the run ends with status `plan_violation` (a failed run, not resumable).
- Stage success: the latest attempt for the stage finished with a valid worker report whose
  status is the report schema's success value, and no reported/attested scope violations.
  (Worker reads the report schema in src/contracts.js to pin the exact success value.)
- The decision prompt shows the plan, stage statuses and the next eligible stages.
- `result` gains `stages: [{ stageId, status: pending|succeeded|failed, attemptIds }]`.
- `maxRounds` for planned runs = max(6, 2 x stage count), capped at 16.
- Lead executor (src/server.js): a new run whose message metadata has `delivery: { runId, plan }`
  uses a second `LeadOrchestrator` instance built with the PM lead role (`promptVersion
  'pm-lead-v1'`); task metadata stores `delivery.runId` so resume uses the same instance. The
  plan is re-validated server-side with plan-validator before `run`.

## D-M3-5 Git adapter (`src/git-adapter.js`)

All via `execFile('git', argv, { cwd: workspace })`, never a shell, fixed argv.

- `preflight({ baseRef })`: workspace realpath is a git work tree root; not in rebase/merge/
  cherry-pick (check `.git` state files via `git rev-parse --git-path`); `git status
  --porcelain=v1 -z --untracked-files=all` empty (ignored files allowed and noted); current
  branch and HEAD; `baseRef` resolves via `rev-parse --verify <baseRef>^{commit}`.
  Result `{ ok, problems: [{ code, message }], head, branch, baseCommit }`; codes
  `not_a_repo, operation_in_progress, dirty_worktree, base_ref_missing, detached_head_allowed`.
- `branchName({ classification, title, ticketId })`: prefix from policy + slug(title, max 40,
  `[a-z0-9-]`) + `-` + last 6 chars of ticketId lowercased; validated with `git check-ref-format`.
- `prepareBranch({ name, baseCommit, ownedByThisTicket })`: if the branch does not exist ->
  `git switch -c <name> <baseCommit>`; if it exists and is recorded as this ticket's branch ->
  `git switch <name>` only when clean; otherwise `branch_collision` (never reuse or overwrite).
- `captureCandidate({ baseCommit })`: HEAD, branch, porcelain entries, `git diff --binary
  <baseCommit>` for tracked changes, untracked non-ignored files listed with sha256 and size
  and their text content appended as a synthetic diff if UTF-8 and <= 256 KiB each; total diff
  capped at 2 MiB (`truncated` flag). Returns `{ baseCommit, head, branch, headMoved,
  manifest: [{ path, status, sha256|null, size|null }], diffText, truncated, integrityHash }`
  where integrityHash = sha256 of head + manifest. Diff stored as an artifact
  (kind `candidate_diff`, media type `text/x-diff`, extraction `reference_only`).

## D-M3-6 Durable runs and the delivery controller

Migration 2 `delivery_runs` adds:

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  revision_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
  wait_reason TEXT, wait_detail_json TEXT, plan_revision_id TEXT, lead_task_id TEXT,
  lead_context_id TEXT, branch_name TEXT, base_commit TEXT, candidate_id TEXT,
  settings_snapshot_json TEXT NOT NULL, intake_turns INTEGER NOT NULL DEFAULT 0,
  command_id TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX runs_one_active_per_ticket ON runs (ticket_id)
  WHERE status IN ('queued','running','paused','interrupted');
CREATE TABLE intake_results (
  intake_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn INTEGER NOT NULL, output_json TEXT NOT NULL,
  valid INTEGER NOT NULL, errors_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (run_id, turn)
);
CREATE TABLE plan_revisions (
  plan_revision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_plan_revision_id TEXT,
  classification TEXT NOT NULL, stages_json TEXT NOT NULL, check_ids_json TEXT NOT NULL,
  checks_json TEXT NOT NULL, requirements_json TEXT NOT NULL, validator_version TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket_id TEXT NOT NULL, run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, plan_revision_id TEXT, state TEXT NOT NULL, request_json TEXT NOT NULL,
  answer_json TEXT, actor TEXT, created_at TEXT NOT NULL, answered_at TEXT
);
CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL,
  base_commit TEXT NOT NULL, head TEXT NOT NULL, branch TEXT NOT NULL, head_moved INTEGER NOT NULL,
  manifest_json TEXT NOT NULL, diff_artifact_id TEXT, truncated INTEGER NOT NULL,
  acceptance_json TEXT, integrity_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE repository_leases (
  project_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ticket_id TEXT NOT NULL, acquired_at TEXT NOT NULL
);
CREATE TABLE ticket_branches (
  branch_name TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL
);
```

Run `status` uses the contract run states; `phase` is one of `queued, intake, awaiting_answer,
branch, engineering, candidate, settled`. Ticket statuses now use the full contract set.

Controller (`src/delivery-controller.js`): a single in-process loop, `tick()` every 2 s and on
startup and after each command. Each step reads durable state, performs one idempotent action,
persists the next phase in a transaction, then records events. Never two concurrent ticks.

| Phase | Action | Next |
| --- | --- | --- |
| queued | acquire lease (insert if no row; FIFO by run `created_at`) | intake; else stay queued (ticket `pending`, waitReason `dependency` "Repository in use by <ticket>") |
| intake | run an Intake turn (D-M3-2) | ready -> save plan revision -> branch; needs_input -> decision + awaiting_answer; unsupported/invalid/exhausted -> settled failed, ticket blocked |
| awaiting_answer | wait for answer command | intake |
| branch | preflight + prepareBranch (read-only plans skip branch creation but still preflight) | engineering; problems -> settled failed, ticket blocked `dependency` with the problem codes |
| engineering | if no lead task: send A2A `SendMessage` to the in-process lead endpoint with the rendered requirements as goal, `acceptance` = checks from the plan, `delivery: { runId, plan }`, `returnImmediately: true`; store task/context ids. Else read the lead task state from the task store | completed -> candidate; input_required human_decision -> decision (kind `lead_decision`) + ticket waiting_human; other pauses -> ticket blocked (raw reason, CLI resume command); failed/canceled -> settled failed/cancelled |
| candidate | captureCandidate + store diff artifact + acceptance from the lead result artifact | settled completed: disposition `accepted` (or `not_required` for read-only plans) -> ticket `waiting_human` / `human_review`; anything else -> ticket `blocked` / `execution_error` with the disposition |

- The lease is held from `intake` until the ticket is cancelled (M3) or accepted (M7). Exception:
  a run that settles failed before any branch was prepared and without a lead task (intake
  failure, preflight problems, collision before switching) releases the lease at settle, since
  it had no repository effect. A
  cancelled run's changes stay on the branch; the next ticket's preflight then reports
  `dirty_worktree` until the operator deals with the checkout. Honest by design.
- Restart: `tick()` resumes from the stored phase. Intake mid-turn is repeated (read-only; the
  turn number is reused, `UNIQUE (run_id, turn)` prevents double results). Engineering relies on
  the existing lead reconciliation (restart pause -> ticket blocked `restart`).
- Settings snapshot at submit: `{ provider: 'openai', runtimeAdapter: 'codex-app-server',
  rolePack: 'legacy-orch', rolePackHash (sha256 of TEAM.md + profile files), leadModel,
  leadEffort, roles: { id: { model, effort, sandbox } }, promptVersions: { intake:
  'pm-intake-v1', lead: 'pm-lead-v1' }, projectPolicyRevision, appServerVersion|null }`.
- Intake turns are recorded in `usage_ledger` with a new kind `intake_turn`, `run_id` = product run id.
- Events (ticket_id + run_id correlated): `run_queued, lease_acquired, intake_completed,
  decision_requested, decision_answered, plan_saved, branch_prepared, preflight_failed,
  engineering_started, candidate_captured, run_settled`. Payloads: ids, codes, counts only.

## D-M3-7 Commands and API

- `POST /tickets/:id/submit` `{ commandId, expectedVersion }`: backlog (or blocked with a settled
  run) -> pending; creates a queued run bound to the current revision; idempotent like M2.
- `POST /tickets/:id/decisions/:decisionId/answer` `{ commandId, expectedVersion, answers:
  [{ questionId, answer }] }` (intake) or `{ ..., answer, choice }` (lead decision). Stale or
  answered decisions -> 409 `stale_decision`. A lead-decision answer resumes the lead task via
  in-process A2A `SendMessage` with `decisionId`/`choice` metadata.
- `POST /tickets/:id/cancel`: backlog as in M2; `waiting_human`/`blocked` with no active lead
  execution -> cancelled, run cancelled, lease released. Active execution -> 409 `invalid_state`
  "Stopping active work arrives in M7".
- `GET /tickets/:id` adds `runs: [summary]`, `activeRun`, and `availableActions` per status.
- `GET /runs/:runId` -> `{ run, intake: [results], plan: planRevision|null, decisions,
  stages (from the lead result or live journal), leadTaskCardId, candidate|null, settings }`.
- `GET /runs/:runId/candidate/diff` -> the diff artifact content (as M2 downloads, but
  `Content-Type: text/plain; charset=utf-8` and inline-safe for the viewer: served as text only).
- Pinned read shapes:
  - Run summary `{ runId, ticketId, revisionId, status, phase, waitReason|null, waitDetail|null,
    planRevisionId|null, branchName|null, baseCommit|null, candidateId|null, createdAt,
    startedAt|null, finishedAt|null, updatedAt }`. `waitDetail` is `{ code, message,
    problems?: [{ code, message }], resumeCommand?: string, disposition?: string }`.
  - Intake result `{ turn, valid, errors: [{ path, message }], readiness|null,
    classification|null, requirements|null, questions: [{ id, question, why }], unsupportedReason|null, createdAt }`.
  - Plan revision `{ planRevisionId, classification, stages: [{ stageId, roleId, objective,
    dependencies, allowedFiles, required }], checks: [{ id, argv, timeoutMs, description }],
    requirements, validatorVersion, createdAt }`.
  - Decision `{ decisionId, kind: 'intake_clarification'|'lead_decision', state:
    'pending'|'answered'|'stale', request, answer|null, createdAt, answeredAt|null }`; intake
    `request` = `{ questions: [{ id, question, why }] }`; lead `request` = the lead pause
    payload `{ question, reason, options: [{ id, description }], recommendation }`.
  - Stage `{ stageId, roleId, required, status: 'pending'|'eligible'|'running'|'succeeded'|'failed',
    attempts: [{ attemptId, role, journalState, outcome|null }] }`.
  - Candidate `{ candidateId, baseCommit, head, branch, headMoved, manifest: [{ path, status,
    sha256|null, size|null }], truncated, diffArtifactId|null, acceptance: { disposition,
    reasons, checks: [{ id, exitCode|null, timedOut, durationMs, outputTail }] }|null,
    integrityHash, createdAt }`.
  - `settings` = the settings snapshot object; `leadTaskCardId` = M1 card id or null.
  - Ticket board card adds `ticketStatus` (contract status), `phase` (active run phase or
    null), `classification` (latest valid intake or null), `disposition` (latest candidate's
    acceptance disposition or null), and `waitReason` from the active or latest run.
  - Lead decision `request.recommendation` is an option id string.
  - Answer bodies: intake `{ commandId, expectedVersion, answers: [{ questionId, answer }] }`
    with every pending question answered, each answer 1..4000 chars; lead `{ commandId,
    expectedVersion, choice, answer }` with `choice` one of the option ids and `answer` 1..4000
    chars (required because the lead resume needs non-empty text).
  - `GET /tickets/:id` `runs` are ordered newest first.
  - Dispositions are the five existing values: accepted, rejected, unverifiable, unverified, not_required.
- Board: ticket cards use the contract column mapping for all statuses; `waitReason` shown.
  A legacy orchestrator task linked to a run (`runs.lead_task_id`) is not a separate card; it
  appears as the run's execution in the ticket detail.

## D-M3-8 Audit hardening (decided after the M3 audit)

- Repair after rejected acceptance: while the latest acceptance disposition is `rejected`, a
  succeeded `orch-builder` stage may be dispatched again (builder or eligible repair role); that
  stage and all its transitive dependents reset to pending. Nothing else reopens a stage.
- Candidate gates before review (else ticket `blocked`, `execution_error`, with code):
  acceptance `requiredCheckIds` equal the plan's check ids (`check_set_mismatch`); every required
  stage succeeded in the lead result (`stages_incomplete`); captured branch equals the run's
  branch (`branch_mismatch`); HEAD did not move from the base commit (`head_moved`: agents must
  not commit); the acceptance candidate fingerprint equals the checkout fingerprint at capture
  (`candidate_changed`); a writable plan has a non-empty manifest (`empty_candidate`).
- Lead task adoption after a crash: delivery metadata carries `planRevisionId` and `planHash`
  (sha256 of canonical plan JSON); a found task is adopted only if both match and its acceptance
  contract equals the plan's checks, else blocked `lead_task_mismatch`.
- Protected paths: plan validation rejects `allowedFiles` with any segment `.git`, `.codex` or
  `.claude` (case-insensitive) or basename `AGENTS.md` / `CLAUDE.md`.
- Git hardening: every adapter command runs with `-c core.fsmonitor=false -c core.hooksPath=/dev/null
  -c diff.external= `; diffs use `--no-ext-diff --no-textconv`. File hashing uses lstat size
  first and streams; manifest capped at 2000 entries (`manifestTruncated`).
- Git adapter operations (preflight, branch, capture) require no active or unresolved writer for
  the workspace (WriterAdmission); otherwise the phase waits (preflight/branch) or blocks
  `writer_unresolved` (capture after a settled lead run).
- Cancel refuses a paused lead task whose pause kind is `writer_unresolved` or `restart`
  (409 `invalid_state`, "Writer outcome is unresolved; resume from the CLI first").
- Owned-branch reuse keeps the earlier run's `base_commit`.
- Docs plans also require >= 1 check id, like feature/bugfix.
- Untrusted blocks in prompts use a per-prompt random delimiter; the engineering goal frames
  ticket title/criteria as untrusted operator-supplied content.
- The server passes the normalized validated plan (not the raw metadata) to `run`.

## Verification plan

Fake-protocol integration: a temp git repo workspace with an approved `node --test` check;
scripted Intake output; a fake builder that edits files within allowedFiles. Cases: feature and
bugfix reach `human_review` with a saved plan, branch, candidate diff and accepted checks;
needs_input -> waiting_human -> answer -> proceeds; a failing check -> blocked with rejected
disposition; dirty checkout -> blocked `dirty_worktree`; second ticket queued while the lease is
held; restart mid-intake and mid-engineering; plan violation feedback and `plan_violation` end.
A live model run is separate evidence, only if the owner asks for it.
