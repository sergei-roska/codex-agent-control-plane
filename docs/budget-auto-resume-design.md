# Automatic resume after a usage limit reset (BUD)

Status: direction decided by the lead on 2026-10-10 at the owner's request; detailed
design follows after the parallel-writers work (PW-3), because continuation reuses
writer lanes. Not started.

## Owner requirement

While the orchestrator is running, a run that stopped on a Codex usage limit must
continue by itself once the limit resets, including the agents that were cut off,
without a human message. The owner observed that up to four Luna agents can work
about five hours and use almost the whole window; the team also uses Sol.

## Today

- A lead turn that hits the limit, or a worker outcome with `failureKind:
  usage_limit`, routes the graph to `budget_pause` (`src/lead-graph.js:1329`), which
  interrupts with `{ kind: 'waiting_for_budget', source, resetsAt }`; `resetsAt` is a
  hint from `account/rateLimits/read` (`resetsAtHint`, `src/lead-graph.js:437`).
- The pause text asks a human to send a message to resume (`src/lead-graph.js:474`).
  Nothing resumes automatically.
- A worker cut off by the limit is a failed outcome; its partial turn and context
  are not continued. In shared mode its partial edits stay in the shared tree.

## Decisions

1. No throttling of agent count by budget. Running out of budget is harmless once
   resume is automatic; the cap on concurrency stays the decision size
   (`MAX_ASSIGNMENTS`, 4). A pacing policy (slowing down to leave budget for the
   owner's interactive use) is out of scope unless the owner asks for it.
2. Resume signal: the App Server's `account/rateLimits/read` response field
   `ordinaryUsageAllowed === true` and, for the bucket of the models the run needs
   (`rateLimitsByLimitId`, matched through `normalModelSlug` to role models), no
   `rateLimitReachedType`. The protocol says clients must not infer recovery from
   percentages or reset times, so `resetsAt` only schedules the next check.
3. Watcher in the server: for each run paused with `waiting_for_budget`, check at
   `resetsAt` plus a small margin when known, otherwise every 5 minutes, and on
   every `account/rateLimits/updated` notification. When allowed, resume the run
   through the same path as a human resume, with an automatic note. If the limit
   hits again, the run pauses again and the watcher re-arms. Paused runs are found
   again from checkpoints after a server restart.
4. Continuation instead of re-planning: a worker cut off by the limit is continued
   in its own Codex thread and, for writers, in its own lane (`thread/resume` plus a
   "continue the assignment" turn), as a new attempt linked to the old one, before
   the lead is asked to plan again. The lead re-plans only if the continuation fails.
5. Per-model buckets: if only one model's bucket is exhausted, the first version
   still pauses the whole run; dispatching around the exhausted model is a later
   option.

## BUD-2 detailed design (2026-10-10)

BUD-1 is done (`ddd0f4b`). BUD-2 continues usage-limited attempts before the lead
re-plans.

1. Specialist: when a turn ends with `failureKind: 'usage_limit'`, its failure metadata
   gains `continuation: { threadId, laneId, codexHome }` (`laneId` only for a lane
   writer; `codexHome` is the App Server home the thread lives in, null for the
   default). A usage-limited lane ends `not_integrated`, reason `turn_failed`, lane
   kept (already so).
2. Lead graph: after `budget_pause` resumes, a new node `continue_limited` runs before
   `decide`. It collects outcomes of the latest batch with `failureKind: 'usage_limit'`
   and a `continuation`, at most 2 continuations per original assignment, and
   dispatches them as one continuation batch without a lead turn: all of them
   concurrently when `parallelWriters` is on (they were already scheduled together),
   else serially. Continuation attempts get `assignmentId = <original>:c<n>`, a fresh
   attemptId and deterministic contextId, are journaled like any attempt (never
   re-sent), carry the original assignment unchanged plus `continuation` (new optional
   specialist key), and do not consume a lead round. Their outcomes are appended like
   any outcome; then `verify`, and on to `decide` (or `budget_pause` again).
3. Specialist with `continuation`:
   - Lane writer: adopt the lane only if its `writer_lanes` row is `not_integrated`
     with reason `turn_failed` or `outcome_unknown` and belongs to the attempt named by
     the lead (`continuation.ofAttemptId` / context). The old row becomes terminal
     `continued`; a new row (new lane id) records the same path and base with
     `continued_from = <old lane id>`. Retention never removes a path referenced by a
     non-terminal or newer row.
   - Thread: resume `threadId` only when the current App Server home equals
     `continuation.codexHome`; input "The usage limit has reset. Continue the
     assignment from where you stopped." If resume is impossible or rejected, start a
     fresh thread in the same lane (or workspace) with the original assignment plus a
     note that a previous attempt was cut off and its partial changes are already in
     the working directory.
   - Then the normal path: integrate a completed lane, settle a shared writer.
4. Non-lane writers in shared mode continue in the shared workspace (their partial
   edits are already there and attested by their settled row); read-only roles just
   resume their thread.

## Open for the detailed design

- Attempt identity and exactly-once rules for a continuation attempt (intent
  recovery contract W1-W5).
- How the dashboard shows "waiting for budget, auto-resume at ..." and lets the
  owner cancel auto-resume.
