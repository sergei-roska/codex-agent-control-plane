# Resilient orchestration implementation spec

Status: implementation spec for `resilient-orchestration.md` steps 1-5. Written by the
reviewing lead (Claude) so the implementation can be reviewed against explicit decisions.
Where this file and the design disagree, this file records the chosen behavior.

## Decisions at a glance

| Topic | Decision |
| --- | --- |
| Run ID | The lead A2A task ID. `LeadOrchestrator.run()` without a run ID uses `randomUUID()`. |
| Graph thread | LangGraph `thread_id` = run ID. |
| Checkpointer | `SqliteSaver` from `@langchain/langgraph-checkpoint-sqlite` (better-sqlite3). Unit tests may use `MemorySaver`; restart tests use a file database. |
| A2A task store | SDK `DatabaseTaskStore` (`@a2a-js/sdk/server/database`) on Kysely + better-sqlite3, one shared table, scoped per agent through `ownerResolver` returning the agent namespace (`orchestrator`, `orch-builder`, ...). |
| Dispatch journal | Own SQLite table, written immediately (not via graph state). |
| State file | `.runtime/state.sqlite` next to the token (`CODEX_A2A_STATE_DB` overrides), mode 0600. One file holds checkpoints, tasks, and journal. |
| Resume trigger | Explicit: an A2A message to the existing lead task. No timers, no auto-resume on startup. |
| Pause representation | Lead A2A task in `TASK_STATE_INPUT_REQUIRED`, `task.metadata.pause = { kind, ... }` and a readable status message. Kinds: `human_decision`, `waiting_for_budget`, `restart`, `owner_pause`, `stopped`, `error` (a node failed but the checkpoint is resumable; a follow-up message retries the failed step). The pending checkpoint interrupt decides the resume path; task metadata is only a fallback. |
| Auto re-dispatch | Only a read-only assignment whose journal row is `submitting` and whose context has no A2A task. Everything else uncertain goes to the lead as an outcome. |
| Graceful shutdown | Cancels running worker turns and parks each active lead run as a resumable `stopped` pause (STOP-01, `docs/owner-pause-design.md`); an explicit task cancel stays terminal. |
| Single instance | Exclusive `<stateFile>.lock` (pid, stale lock replaced). Order: account check, open state, lock, listen, reconcile, mount routes. |
| Bad follow-up input | A malformed message to a paused task keeps it `INPUT_REQUIRED` with the same pause; it never becomes terminal. |
| State content | Plain JSON only (no Error, Map, Set, class instances). |

## Step 1 - contracts (`src/contracts.js`)

### Worker report (`WORKER_REPORT_SCHEMA`, contract id `worker-report/v1`)

Strict structured-output schema: every property required, `additionalProperties: false`,
nullable object via `anyOf [..., {type: "null"}]`.

```text
outcome: "completed" | "blocked" | "needs_decision" | "failed"
summary: string
filesChanged: string[]
filesInspected: string[]
checks: [{ command: string, result: "passed" | "failed" | "not_run", detail: string }]
risks: string[]
scopeExpansion: [{ path: string, reason: string }]
decisionRequest: null | {
  question: string
  options: [{ id: string, description: string }]
  evidenceChecked: string[]
  recommendation: string        // an option id
  consequenceIfWrong: string
}
```

`validateWorkerReport(value)` -> `{ ok, report, errors[] }`. Rules: `needs_decision` iff
`decisionRequest` is non-null; options >= 2 with unique non-empty ids; recommendation is one
of the ids; `evidenceChecked` non-empty. `parseWorkerReport(text)` never throws; it returns
`{ report | null, error | null }`. A bad report becomes an outcome with `reportError`, not a
crashed run.

Specialists run with `outputSchema: WORKER_REPORT_SCHEMA`. The result artifact keeps the raw
JSON text and gets `metadata: { contract: "worker-report/v1", threadId }`.

### Lead decision (`DECISION_SCHEMA` v2)

```text
action: "dispatch" | "finish" | "request_human_input"
assignments: [ ...unchanged 8-field assignment... ]
final: string
resolutions: [{ decisionId: string, choice: string, rationale: string }]
humanInput: null | {
  reason: "missing_authority" | "irreversible_or_external" | "product_choice"
  question: string
  options: [{ id: string, description: string }]
  recommendation: string        // an option id
  evidenceChecked: string[]
  independentWork: string
  relatedDecisionIds: string[]
}
```

`validateDecision(decision, ctx)` with
`ctx = { roles, attemptedRoles: Set, outcomeCount, openDecisionIds: Set }`:

- exact key set; all current assignment and escalation-order rules are kept;
- `finish`: no assignments, non-empty final, `humanInput` null;
- `dispatch`: 1-4 assignments, empty final, `humanInput` null;
- `request_human_input`: no assignments, empty final, valid `humanInput` (options >= 2,
  unique ids, recommendation among them, non-empty `evidenceChecked`, `relatedDecisionIds`
  subset of open ids);
- `resolutions`: each `decisionId` open, no duplicates, non-empty `choice` and `rationale`
  (`choice` is free text; an option id is recommended);
- every open decision is either resolved or, for `request_human_input`, listed in
  `relatedDecisionIds`.

A decision ID is the attempt ID of the worker attempt that raised it. Human decision IDs are
`<runId>:h<n>`.

### Budget classification

`classifyCodexError(error)` -> `"usage_limit" | "other"`. `usage_limit` when a
`codexErrorInfo` equal to `usageLimitExceeded` or `rateLimitExceeded`, or an object variant
with `httpStatusCode: 429`, is found at `error.codexError.codexErrorInfo`,
`error.rpcData.codexErrorInfo`, or along the `cause` chain. No message regexes. Values come
from `codex app-server generate-ts` (`v2/CodexErrorInfo.ts`, codex-cli 0.159.0).

A specialist that fails with `usage_limit` publishes FAILED with the status message
`metadata: { failureKind: "usage_limit", codexErrorInfo }` (other failures:
`failureKind: "other"`). A transport failure or turn timeout during an active Codex turn
marks the outcome as unknown; the specialist publishes `failureKind: "interrupted"` so the
lead checks workspace effects before assigning another writer.

## Step 2 - durable IDs, storage, reconciliation (`src/durable-store.js`)

IDs:

- `assignmentId = <runId>:r<round>:a<index>` (round 1-based, index 0-based);
- `attemptId = <assignmentId>:t1` (the attempt counter stays 1: retries are new lead
  assignments; the field exists so a later automatic retry does not change the format);
- A2A `contextId` = UUID-formatted string derived from sha256(attemptId), so a lost
  submission can be found with `listTasks({ contextId })`.

Journal table `dispatch_journal`: `attempt_id` PK, `run_id`, `assignment_id`, `role`,
`sandbox`, `context_id`, `task_id` nullable, `state` in `submitting | submitted | finished`,
`result_json` nullable, `created_at`, `updated_at`. API: `recordSubmitting(row)` (idempotent,
returns the existing row if present), `recordSubmitted(attemptId, taskId)`,
`recordFinished(attemptId, result)`, `get(attemptId)`, `listByRun(runId)`. An in-memory
implementation with the same API serves unit tests.

Startup reconciliation (after the lock and a successful listen, before routes are mounted): every stored task in `SUBMITTED` or `WORKING`
state is rewritten.

- Specialist namespaces -> `FAILED`, status message "Interrupted by server restart before
  completion; workspace effects are unknown.", message metadata
  `{ failureKind: "interrupted" }`.
- Lead namespace -> `INPUT_REQUIRED`, `task.metadata.pause = { kind: "restart" }`, message
  "Run interrupted by server restart. Send a message to this task to resume."

## Step 3 - LangGraph lead (`src/lead-graph.js`, `src/lead-orchestrator.js`)

Nodes and edges:

```text
START -> intake -> decide -+-> finish -> END
                           +-> human_input -> decide
                           +-> dispatch -> collect -+-> dispatch   (serial batch, more left)
                                                    +-> verify -+-> decide
                                                                +-> budget_pause -> decide
decide --(usage_limit on lead turn)--> budget_pause
```

- `intake`: validate the goal; on first entry pin `{ workspace, teamRulesSha256,
  projectInstructions: [{ path, sha256 }] }` for `AGENTS.md` and `CLAUDE.md` at the workspace
  root when present. On a later pass, report changed hashes to the lead as a note.
- `decide`: one lead Codex turn (thread kept in state), then parse, validate, and apply
  resolutions. A `usage_limit` error routes to `budget_pause` with `source: "lead"`; other
  errors retain their existing recovery behavior. LL-8 removes the default
  dispatch-round limit. An explicit caller cap pauses with `round_limit`;
  repeated work after a recovery warning pauses with `loop_detected`. Neither
  pause marks work accepted. Repeated invalid decisions also pause with their
  validation evidence after the bounded correction attempts.
- `dispatch`: materialize the round's assignments once (IDs, `round += 1`, attempted roles).
  When every role is read-only, submit all pending assignments. Otherwise submit only the next
  one whose predecessors are finished. Per attempt, check the journal first:
  - no row: `recordSubmitting`, `sendMessage` (`returnImmediately`), `recordSubmitted`;
  - `submitting`: `listTasks({ contextId })`. Found: `recordSubmitted`. Not found and
    read-only: send again with the same contextId. Not found and writable: finish the attempt
    as `outcome_unknown` without sending;
  - `submitted` / `finished`: do not send.
  - A thrown `sendMessage` error is reconciled with `listTasks` the same way. If no task is
    visible yet, a writable attempt becomes `outcome_unknown`: the server may still accept
    the request after the lookup. A read-only attempt may become `dispatch_error`.
- `collect`: poll the current attempts until each is finished (existing `isTaskFinished`).
  Task not found gives `outcome_unknown`. Abort uses the existing cancel-until-confirmed
  logic. Each finished attempt goes to `recordFinished`.
- `verify` (deterministic, no model): build outcomes `{ assignmentId, attemptId, role,
  sandbox, status, report, reportError, text (only without a report), failureKind,
  scopeViolations }`. `scopeViolations` lists reported `filesChanged` outside
  `allowedFiles`. Open decisions are registered from `decisionRequest`. Any
  `failureKind: "usage_limit"` routes to `budget_pause` with `source: "worker"`.
- `human_input`: `interrupt({ kind: "human_decision", decisionId, ...humanInput })`. The
  resume value `{ answer, choice?, decisionId? }` is appended to `humanAnswers`, and related
  decisions are closed with `by: "human"`. A supplied `choice` must match a pending option
  ID; a free-text answer without `choice` is allowed.
- `budget_pause`: best-effort `appServer.readRateLimits?.()` for a `resetsAt` hint (only a
  hint; the protocol says not to infer recovery from it), then
  `interrupt({ kind: "waiting_for_budget", source, message, resetsAt })`.
- Code before `interrupt()` re-runs on resume, so it must stay side-effect free.

The lead prompt adds open decisions, human answers, resume notes, and these rules. The lead
resolves worker decision requests itself when evidence supports a choice. It uses
`request_human_input` only for the three reasons, after investigation, and with options, a
recommendation, and the evidence checked. Before re-dispatching a writer, it inspects a
writable outcome that is `interrupted`, `outcome_unknown`, or `usage_limit` with a read-only
role. Specialist briefs gain `assignmentId` and a line requiring the JSON report and
`needs_decision` only after checking evidence.

`LeadOrchestrator` API:

- `run({ goal, runId?, signal, onEvent })`: fails if a checkpoint for `runId` already
  exists.
- `resume({ runId, input?, signal, onEvent })`: when an interrupt is pending, invoke
  `Command({ resume: input })`; when `next` is non-empty, invoke `null`. No checkpoint gives
  `RunNotFoundError`. A finished run returns the stored result.
- Result: `{ runId, status: completed | max_rounds | canceled | failed | input_required |
  waiting_for_budget, text, rounds, assignments, pause? }`.
- Test hook: `interruptAfter` option passed to graph invocation to stop at a node boundary.

## Step 4 - A2A surface (`src/server.js`, `src/cli.js`, `src/codex-app-server.js`)

- The lead executor calls `resume()` for a message to an existing non-terminal lead task
  (`requestContext.task` present), and `run()` otherwise. `input_required` and
  `waiting_for_budget` publish `INPUT_REQUIRED` with `task.metadata.pause` and a readable
  message (question, options, recommendation, decision ID, how to answer). A `decisionId` in
  message metadata that does not match the pending one, or a `choice` outside the pending
  option IDs, keeps the task in `INPUT_REQUIRED` with an explanatory message.
- `CodexAppServer.run()` with a `threadId` not loaded in this process first calls
  `thread/resume`. `readRateLimits()` wraps `account/rateLimits/read` and returns `null` on
  error. After an unexpected child exit or turn timeout, a later call starts a replacement
  App Server process; it does not replay the failed turn automatically.
- CLI: `npm run ask -- --task <id> [--choice <optionId>] [--decision <decisionId>] "<answer>"`
  continues a paused task. An `INPUT_REQUIRED` result prints the pause and the resume command
  and exits 3.

## Step 5 - tests (no Codex, no network)

All tests use fake App Server and fake A2A clients. Required scenarios:

- a restart after each node boundary (`intake`, `decide`, `dispatch`, `collect`, `verify`,
  `human_input`, `budget_pause`) using `interruptAfter` plus a new orchestrator over the same
  file checkpointer and journal: the same final result and at most one `sendMessage` per
  contextId;
- a usage-limit failure during the lead turn and during a worker turn gives
  `waiting_for_budget`, and resume completes;
- a delayed A2A result (WORKING for several polls, across a restart) is collected, not
  re-sent;
- an uncertain write outcome (journal `submitting`, no task for the context) gives
  `outcome_unknown` with zero sends, and the lead sees it;
- reopening the file database preserves tasks, journal, and checkpoints; startup
  reconciliation rewrites stale tasks;
- the server maps pauses to `INPUT_REQUIRED` and resumes through a message to the same task.

Live adapter smoke test on 2026-09-29: Codex App Server 0.159.0 accepted
`account/rateLimits/read` with `{}`, structured output, and `thread/resume` through a
ChatGPT OAuth account. A deliberately stopped child was replaced on the next call, which
continued the same thread. A live A2A request through the local server and CLI read
`package.json`, returned the package name, and completed with exit code 0.

## Known limits left for review

- A crash inside a lead Codex turn repeats that turn on resume (one extra lead turn).
- Worker `filesChanged` is self-reported; `scopeViolations` is a signal, not enforcement.
- A budget resume while quota is still exhausted pauses again after one failed lead call.
- A crash before the first checkpoint restarts the run from the goal in the lead task history.
- The SDK task-store migration DDL is replicated from the `a2a-db` CLI (not exported by the SDK); the migration name matches so the CLI treats it as applied.
