# Orchestration benchmark plan (MEA-01)

Status: frozen trial definitions for Phase A and later efficiency claims.
Tolerances below were fixed before any result was seen. Facts verified at
revision `bfdc1c9`.

This plan supersedes `docs/efficiency-comparison.md` on one point: that document
compares accepted trials only and reports failures only as a rate
(`docs/efficiency-comparison.md:99-100`). Here, failed attempts, planning turns,
and recovery count in total resource use, and accepted-trial latency is reported
separately. Its other rules stay: unknown is null, never zero; subscription
usage is not monetary cost; no token claim when token coverage is partial on
either side. Two of its statements are stale: lead turns are recorded
(`src/lead-graph.js:391-423`) and objective hashes exist
(`src/lead-graph.js:576`, `:695`).

## Questions the trials answer

1. Does a change keep the acceptance rate on each task class?
2. What does a task class cost end to end (wall time, tokens, retries, repeated
   work), including failed attempts and planning?
3. How long does recovery take after a worker failure or an interrupted writer,
   and does recovery duplicate work?

No live model run is needed to adopt this plan. Live trials are optional and run
only in disposable workspaces.

## Arms and pinning

An arm is one orchestrator revision with one configuration. A comparison has
two arms (baseline and candidate) on the same fixtures. Each trial records:

| Pin | Source |
| --- | --- |
| Orchestrator revision | `git rev-parse HEAD` of the orchestrator checkout; the tree must be clean |
| Fixture revision | commit of the fixture repository at trial start |
| Profiles | SHA-256 of each `profiles/agents/*.toml`, `profiles/TEAM.md`, and the coordinator block in `src/role-catalog.js` (model and effort are hardcoded at `src/role-catalog.js:177-178`) |
| Requested and served model, effort | profiles (requested); usage ledger `model` (served, `src/codex-app-server.js:422`) |
| Runtime | Node version, `codex --version`, ledger `app_server_version` |
| Acceptance checks | exact argv list sent with `--check` |
| Permissions | role sandbox values; approvals are always declined (`approvalsReviewer: "user"`) |
| Skills | pins recorded in the lead checkpoint |
| Timeouts | `CODEX_A2A_TURN_TIMEOUT_MS` (default 600000) |

Model and effort are pinned through the profile files. A candidate arm that changes
profiles uses its own orchestrator checkout, since `npm start` always loads the
bundled `profiles/` (`src/server.js:51-52`).

## Trial isolation

Each trial gets a fresh environment and shares nothing with other trials:

- A fresh clone of the fixture repository at its pinned commit in a new temporary
  directory, used as `CODEX_WORKSPACE`. Acceptance requires a git checkout.
- A new state database `CODEX_A2A_STATE_DB=<trial>/state.sqlite`, token file
  `CODEX_A2A_TOKEN_FILE=<trial>/a2a-token`, and lock directory
  `CODEX_A2A_WORKSPACE_LOCK_DIR=<trial>/locks`.
- A unique `PORT`, and a new server process started for the trial and stopped
  after it, so the first turn is always cold. Process startup is folded into the
  first turn's `elapsed_ms` (`src/codex-app-server.js:368`, `:544`); a cold start
  in every trial keeps arms comparable.
- No shared Codex App Server between trials; the trial's server owns its child.

## Fixtures

Fixture repositories live outside this repository and are small Node projects
with `node --test` suites. Each fixture states its class, its goal text (sent
verbatim), its checks, and its grader. The grader is a deterministic script run
by the harness after the trial; it never calls a model.

| Id | Class | Setup | Goal and checks | Grader |
| --- | --- | --- | --- | --- |
| F1 | read-only lookup | Fixture with a config constant defined in one file and used in three | "Report the file and line that define the default retry limit and every caller." No checks. | Final text names the defining `file:line` and all three callers; acceptance `not_required` |
| F2 | bounded code repair | One seeded bug in `src/price.js`; one failing test in `test/price.test.js` | "Fix the failing price test without changing tests." Check `npm test` | Disposition `accepted`; `git diff --name-only` is exactly `src/price.js` |
| F3 | large tool output | `scripts/emit-log.js` prints about 20 MiB of log lines with one `ERROR E4711` line at a random depth | "Run scripts/emit-log.js and report the error code it prints." No checks. | Final text contains `E4711`; lead `inputTokens` per turn recorded for the payload comparison |
| F4 | concurrent reads with a failed worker | Fake runtime: `makeFakeAppServer` in the e2e stack (`test/e2e.test.js:72`) with two read-only assignments in one round, one of which fails | Lead script dispatches both, then finishes | Both outcomes present; the failed one has `failureKind`; the run completes; no retry storm (at most one re-dispatch) |
| F5 | interrupted writer | Fake runtime: the e2e restart case (`test/e2e.test.js:278-344`): the server dies during a writer turn and a second server boots on the same state file | Resume the lead task | Pause kind `restart`, writer `interrupted`, the writer is not re-sent, and resumed work reaches a terminal state |

F1 to F3 are live-model fixtures. F4 and F5 are deterministic harness fixtures:
they measure orchestration overhead and recovery behavior, and their token
fields are not applicable (reported as `n/a`, not zero). A live variant of F5
kills the trial server with SIGKILL once the ledger shows the writer turn
started, restarts it, and resumes with `npm run ask -- --task <id> "continue"`.

## Metrics

| Metric | Definition | Source |
| --- | --- | --- |
| Acceptance rate | trials whose grader passes and whose disposition is `accepted` (F2) or `not_required` (F1, F3) / all trials | harness, lead artifact `acceptance` |
| End-to-end wall time | from CLI submit to terminal or `INPUT_REQUIRED` state, measured by the harness clock | harness |
| Accepted-trial latency | wall time over accepted trials only, reported separately | harness |
| Tokens | sums of `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens` over all ledger rows of the run, lead and workers, all outcomes | `npm run usage -- --run <taskId>` |
| Token coverage | known-token rows / all rows of the run | `tokensUnknownRows` in the usage report |
| Planning cost | the same token sums restricted to `lead_turn` rows | usage report `byRole.coordinator` |
| Failed-attempt cost | token sums and elapsed time over worker rows with outcome `failed`, `interrupted`, or `canceled` | ledger |
| Retries | ledger `retries` plus re-dispatched attempts | ledger, dispatch journal |
| Repeated work | `repeatedAssignments` (identical objective hashes in one run) | usage report |
| Queue wait | journal `created_at` to the worker row `started_at`, per attempt (approximation; includes submission time) | dispatch journal, ledger |
| Recovery time | from server restart to the first lead turn after resume (F5), or from the failed outcome to the next dispatch (F4) | harness timestamps, ledger `started_at` |
| Lead payload size | bytes of `JSON.stringify(state.outcomes)` in the last lead prompt (fake runtime), and lead `inputTokens` (live) | test hook in F3 fake variant; ledger |

Known gaps, to be closed by MEA-02 before results are claimed for those metrics:
refused or canceled-before-run worker attempts write no ledger row
(`src/a2a-role-service.js:294-302`, `:321-342`, `:352-360`), so failed-attempt
counts are a lower bound; acceptance check run time (`durationMs`,
`src/acceptance.js:89`) is not in the ledger; there is no explicit queue-wait or
startup field. Until then these metrics are reported with a "lower bound" or
"approximate" label.

Total resource use for a task class is the sum over all trials, accepted or not:
planning, worker turns, failed attempts, retries, and recovery. A change that
lowers accepted-trial cost by failing more trials is a regression.

## Design and statistics

- Matched pairs: each fixture runs on both arms with identical goal text,
  checks, and fixture revision.
- Order: ABBA blocks (baseline, candidate, candidate, baseline), repeated. For
  live fixtures N >= 6 trials per arm per fixture (three ABBA blocks); N = 3 is
  too weak for claims. For fake-runtime fixtures N >= 20 per arm.
- Report per fixture and arm: success count, median and interquartile range of
  wall time and of each token sum, min and max, and token coverage. Report
  failed-trial costs in their own rows.
- Uncertainty: show all per-trial values in the result file; claim a difference
  only when the medians differ beyond the tolerance and the interquartile ranges
  do not overlap. Otherwise report "no detectable difference".
- Incomplete token coverage on either arm forbids any token claim for that
  fixture; wall time and acceptance claims may still be made.

## Regression tolerances (fixed before results)

A candidate arm regresses on a fixture when any of these holds:

| Metric | Tolerance |
| --- | --- |
| Acceptance rate | any drop in accepted trials (live: candidate accepted count lower than baseline at equal N) |
| Correctness invariants (F4, F5) | any violation: an accepted contract violation, a re-sent writer, a lost outcome, or a second active writer |
| Median wall time (live) | more than 15 percent slower |
| Median wall time (fake runtime) | more than 20 percent slower |
| Median total tokens (live, full coverage) | more than 10 percent more |
| Recovery time (F5) | more than 25 percent slower |
| Repeated work, retries | any increase in the median |

An improvement claim needs the same margins in the other direction plus an
unchanged acceptance rate.

## Procedure

1. Pin: record both orchestrator revisions and the fixture revisions; confirm
   both orchestrator trees are clean.
2. For each fixture and each trial in ABBA order:
   1. Create the trial directory, clone the fixture, set the environment from
      "Trial isolation".
   2. Start the arm's server; wait for `/orchestrator/agent-card.json`.
   3. Submit the goal with `npm run ask -- [--check <argv>] "<goal>"` from the
      arm's checkout, recording the harness clock at submit and at exit.
   4. For F5 live: kill the server once the writer turn has started, restart it,
      and resume the printed task id.
   5. Run `npm run usage -- --run <taskId> --state <trial>/state.sqlite` and the
      grader; stop the server; keep the trial directory.
3. Aggregate with the statistics above and compare against the tolerances.

## Result record

One JSON object per trial, kept with the raw state database and usage report:

```json
{
  "fixture": "F2",
  "arm": "candidate",
  "trial": 3,
  "orchestratorRevision": "<sha>",
  "fixtureRevision": "<sha>",
  "profilesSha256": { "engineer.toml": "<sha>", "coordinator": "<sha>" },
  "runtime": { "node": "v24.21.0", "codex": "0.160.0", "appServer": "<userAgent>" },
  "checks": [["npm", "test"]],
  "taskId": "<lead task id>",
  "submittedAt": "<ISO>",
  "endedAt": "<ISO>",
  "wallMs": 0,
  "terminalState": "TASK_STATE_COMPLETED",
  "disposition": "accepted",
  "graderPassed": true,
  "usage": { "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0, "coverage": 1.0 },
  "planningTokens": { "inputTokens": 0, "outputTokens": 0 },
  "failedAttempts": 0,
  "retries": 0,
  "repeatedAssignments": 0,
  "recoveryMs": null,
  "notes": ""
}
```

Unknown values are `null`; values that do not apply are `"n/a"`.
