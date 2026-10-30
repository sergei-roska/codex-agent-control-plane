# Validation, comparison, migration and rollout

This is an acceptance plan, not a report that the proposed engine passed it.
Current research evidence is listed separately at the end.

## Test layers

L1: pure contracts/readiness/projections with a fake clock.
L2: two SQLite connections and disposable A2A/App Server fakes, durable restart
and duplicate/late event injection. Assert event order and identities rather than
unreliable elapsed-time sleeps.
L3: disposable Git repositories, private worktrees, real owned child processes,
workspace locks and simulated integration crashes. No real target repository.
L4: browser against an owned fixture server, current HTML/JS/CSS and mocked APIs.
Include keyboard use, small screens and delayed/out-of-order API responses.
L5: affected integration/full suite against a frozen candidate with recorded baseline.
L6: separately authorized live comparison with pinned task inputs and model settings.
No model response is required for L1-L5. Never turn an unrun L6 into qualification.

## Acceptance scenarios

| ID | Scenario and concrete expected observation | Layer |
| --- | --- | --- |
| V01 | Task IDs survive plan revisions; running revision/contract remains immutable | L1/L2 |
| V02 | Dependency cycle, missing reference and self-edge are rejected without partial rows/events | L1/L2 |
| V03 | Two simultaneous claimers obtain one attempt for a ready task; total/role capacity holds | L2 |
| V04 | Completion/state/event commit rolls back together on failure; duplicate event yields one dependent wakeup | L2 |
| V05 | Stale planner delta cannot overwrite owner revision, completed task or updated dependency | L2 |
| V06 | Configured four engineers start distinct task/context/thread instances within available capacity | L2/L3 |
| V07 | Ready task D starts after quick A completes while unrelated slow B is still running | L2 |
| V08 | Two independent auditors overlap with distinct identities, even when writer isolation is shared | L2 |
| V09 | Auditor for checkpoint C waits for C's passing verifier; independent checkpoint D has no invented edge | L1/L2 |
| V10 | Lead adds successor tasks while workers run; no collection barrier is used | L2 |
| V11 | Busy worker slots cannot consume reserved lead capacity; useful planning can run | L2 |
| V12 | No independent ready work produces a clear reason, no fabricated tasks or model-poll loop | L1/L2 |
| V13 | Lead can choose different role subsets and pipeline graphs for a small fix and parallel feature | L1/L2 |
| V14 | Routine reversible choice is resolved internally; named owner-required acceptance remains mandatory | L1/L2 |
| V15 | Failed worker creates investigation/repair/replan while unrelated ready work progresses | L2 |
| V16 | A failed reviewer retries only its valid scope/candidate; successful sibling receipt persists | L2 |
| V17 | Same failed hypothesis twice triggers a different plan; exhausted internal recovery stays resumable technical blockage | L2 |
| V18 | Reviewer reads frozen candidate G even while independent writer publishes G+1; receipt names G | L3 |
| V19 | Changed/unknown dependency/read manifest prevents promotion to G+1; allowedFiles alone cannot establish independence | L1/L3 |
| V20 | Unchanged validated input closure permits receipt reuse; historical receipt identity is never rewritten | L2/L3 |
| V21 | Verifier-created test/check change creates new candidate and cannot self-certify old target | L3 |
| V22 | Concurrent owner edits, escaping patch, scope violation and stale base are refused or reconciled accurately | L3 |
| V23 | Final stabilization freezes one exact candidate, drains relevant publication and runs required pinned checks | L3 |
| V24 | Soft pause before/after claim prevents new work at correct control revision; active work settles | L2/L3 |
| V25 | Explicit cancel versus integration intent has a linearized outcome; late result cannot publish after cancellation | L3 |
| V26 | Budget wakeup never resumes owner pause/cancel/technical blockage and never grants new authority | L2 |
| V27 | Crash at every dispatch/apply window reconciles remote task/process/content before replay or capacity release | L2/L3 |
| V28 | Shared App Server termination marks every affected attempt uncertain; live siblings are not silently retried | L2/L3 |
| V29 | Expired claim with a still-live process keeps fence/capacity; restart cannot produce a second writer | L3 |
| V30 | Counts4/2/2/2, role defaults, per-project overrides, inherited values and old JSON survive; invalid input changes nothing | L1/L4 |
| V31 | Effort UI and request agree for explicit/inherited/custom/model-changed values; unsupported value is explained | L1/L4 |
| V32 | Fast off uses default turn tier; Fast on uses explicit supported identity; negative descriptions cannot imply Fast | L1/L2/L4 |
| V33 | Failed catalog discovery preserves configured model/effort and truthful unknown Fast; no credential leakage | L2/L4 |
| V34 | Steering message is acknowledged while workers run; priority lead turn applies correction before new relevant claims | L2/L4 |
| V35 | Backlog UI explains dependency, review, budget, ownership, capacity, pause and recovery idle causes accurately | L2/L4 |
| V36 | Two independent project servers/state DBs progress concurrently; pause/review of A does not park B | L3 |
| V37 | Aliased/common-Git-dir workspace startup exclusion stays explicit; no new global project mutex | L3 |
| V38 | Legacy run/checkpoint and old role settings remain readable/resumable with feature disabled | L2/L3 |
| V39 | Additive migration and rollback preserve pending claims/evidence; disabling engine drains/reconciles safely | L3 |
| V40 | New and legacy scheduling cannot publish concurrently to one workspace; mixed-version failure is explicit | L3 |
| V41 | Matched deterministic workload shows critical-path scheduling gain with equal accepted output | L2 |
| V42 | UI/metrics separate backlog, writer, provider and settlement waits; unknown token data remains null | L2/L4 |
| V43 | Objective with one recoverable failure reaches honest acceptance without an owner reply, while status/steering remain available | L2 then L6 |

## Canonical scheduling trace

Use fake barriers, not model latency. Capacity permits two engineering workers
plus a planner. A and B are independent; D requires A's output; C is a read-only
investigation. B remains blocked on an explicit fake execution barrier.

1. Planner commits A, B, C and conditional successor D; scheduler claims A and B.
2. While both execute, lead accepts a steering message and adds task E without
   changing A/B's immutable contracts. Any changed requirement is versioned.
3. A settles and emits a durable event. D or other eligible work gets the freed
   slot before B's barrier is released, without a new all-sibling collect.
4. B fails recoverably. Its repair is queued; A's output and unrelated evidence
   remain. The lead chooses a new bounded repair/investigation path.
5. Compatible independent verifiers/auditors overlap on frozen candidates.
6. Relevant publication drains; the final candidate has exact checks/receipts.
   Goal acceptance succeeds with no owner response after initial scope/steering.

A second trace uses shared writer fallback: only one product writer executes, but
independent auditors and planning still overlap. Degraded mode is visible rather
than making the whole team serial.

## Crash injection matrix

For each row, assert task/claim/event/journal/candidate identity, effect state,
capacity accounting and next permitted operation after restart.

| Crash window | Required recovery |
| --- | --- |
| Before claim commit | No claim/intent/effect exists |
| After claim+intent commit, before send | Determine whether send actually occurred before replay; no invented acknowledgement |
| After remote send, before task-ID persistence | Lookup by deterministic context; uncertain writer stays fenced |
| After task-ID persistence, before result | Reattach/poll known task; no duplicate context |
| After terminal result, before local settlement | Idempotently settle from trusted result/journal |
| Before apply, after publication intent | Inspect admission/process/manifest; do not infer effects from intent alone |
| During apply | Prove process quiescence and exact content delta; ambiguous effects stay unresolved |
| After apply, before candidate/event commit | Match resulting content to intended patch/base; record once or remain unknown |
| After candidate/event commit, before consumer cursor | Replay event safely; one dependent transition/receipt |
| After pause/cancel request, before worker result | Recheck durable control revision at publication, preserve actual effects |
| After lease expiry while process lives | Reconcile; no new writer/slot reuse until safe |
| During final acceptance or rollback | Never report accepted without the exact stored candidate fingerprint |

## UI regression appendix

The first settings/UI milestone must demonstrate:

- Main page has one unchanged-width left sidebar; Connectors work there and central
  content uses the removed right column. No obsolete role-modal Escape handler.
- Roles page occupies available width, preserves project navigation and has readable
  cards at 1440px, 1024px and 390px. No horizontal overflow in inputs/card actions.
- Delayed A response after project B selection never replaces B's cards. Save/reset
  bind to the card's rendered project; stale mutations do not display false success.
- Manual account refresh keeps `force=1`, displays busy/success/error, and cannot be
  overwritten by a slower cached request or stale failure. No handshake/model turn.
- Per-task token chart enriches unknown/stale snapshot values only with attributable
  task/assignment data, preserves unknowns, handles retries without double counting,
  and does not combine unrelated sessions/projects.

Browser screenshots and interaction logs use disposable local fixtures. They do
not require restarting the user's launcher or touching account credentials.

## Measures and comparison protocol

Record accepted candidate/input/requirement/check identities, effective runtime,
role/model/effort/Fast settings, capacity, tokens and environment for both engines.
Use the same tasks and acceptance obligations; do not compare a partially verified
run with an accepted run. Keep historical unknown fields null.

Primary scheduling measure: eligible slot idle time while ready independent work
and required resources exist. Secondary measures: critical-path wall time, planner
turn count/tokens, first-pass acceptance, repeated unchanged review, repair work,
owner-only interventions and total tokens per accepted objective.

Deterministic reference: equal-duration independent A/B must overlap when capacity
permits; D starts on A completion rather than B completion. Assert causal event
order and peak concurrency. Do not set a universal live speedup percentage from
synthetic durations. Live qualification should report observed improvements and
quality/cost tradeoffs with source traces, not only agent count or test volume.

## Migration and rollback gates

1. Additive schemas and validators land with new engine disabled. Old tasks and
   graph state are untouched; new optional API fields remain backward compatible.
2. Offline scheduler/shadow projections may observe new records but perform no
   external dispatch or hidden source publication.
3. Disposable end-to-end execution qualifies claims, candidates, owner controls,
   cross-project isolation and UI before any real objective uses the engine.
4. Owner-side engine selection applies to new objectives only. Active legacy
   runs remain on their engine. The workspace has one publication authority.
5. Before source application, identify the exact project/launcher processes and
   owner authorization. Plan acceptance is not permission to stop live target work.
6. Roll back by stopping new claims, draining/reconciling attempts, checkpointing,
   and disabling new-objective selection. Preserve backlog/candidates/events.
   Old binaries must reject unsupported live new-engine objectives explicitly;
   they must not reinterpret them as empty legacy work or drop unknown settings.

## Evidence collected during this investigation

Source inspection and independent traces established the current barriers and
extension points. The source snapshot includes pre-existing dirty work.

Command run on 2026-10-26:

```sh
node --test --test-name-pattern='parallelWriters submits a group together|without parallelWriters waved writers|reviewers need matching contexts|two writers of one wave run concurrently|executionGroups groups' test/contracts.test.js test/lead-graph.test.js test/writer-lanes.test.js
```

Result: 5 tests passed, 0 failed. This qualifies those existing local behaviors only.
Temporary log: `/tmp/concurrent-harness-baseline-20261026.log` (may disappear).

Installed-protocol inspection command from role-settings investigation:

```sh
codex app-server generate-json-schema --out /tmp/codex-app-schema-runtime-role-audit-20261026
```

It established model effort/tier metadata and per-turn service-tier fields, not
account entitlement or real Fast throughput. Regenerate when protocol changes.
Implementation milestone tests/review outcomes belong in their handoffs until
accepted; do not treat transient worker reports as durable completion claims here.
