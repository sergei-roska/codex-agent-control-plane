# Harness runtime efficiency audit, October 18-19, 2026

The active run contains confirmed avoidable work. The strongest current defect
is loss of the execution brief during automatic verifier recovery: a detailed
socket-free assignment becomes a generic checkpoint review, and the replacement
verifier repeats known-blocked API tests. Repeated independent reviews also find
real product defects, so total review time cannot be classified as waste.

## Scope and capture

- Harness project: `c65886082e`, target `claude-harness`.
- Session: `cb7ddc85-ce74-4fb8-864b-0f71de97eb28`.
- Lead run: `9e2c8b53-458b-4ccf-924b-ee13639510df`.
- One session spans both dates; these are calendar-day buckets, not two runs.
- Frozen SQLite backup captured at `2026-10-19T08:33:51.211293Z`, or
  11:33:51 Europe/Chisinau. Source connection used SQLite `mode=ro`.
- Yesterday: October 18, 00:00-24:00 local. First recorded work was 16:27:24.
- Today: October 19, 00:00 through capture. Later activity is excluded.
- Separate process observation at 11:38:55 local is clearly identified below.
- No tests, runtime/task changes, service restart, target edits or Harness model
  dispatch were performed. Audit agents inspected data outside the target run.

## Measured workload

Elapsed is registered agent-call time, including tools and waits. It is not
pure model generation or calendar time. Completed intervals are clipped to
calendar boundaries; an auditor's 7.472-second midnight tail belongs to today.
Tokens are whole-row values assigned by turn start date and are not prorated.

| Metric | October 18 | October 19 through 11:33:51 |
| --- | ---: | ---: |
| Completed usage records | 218 | 55 |
| Lead turns | 111 | 28 |
| Dispatched role assignments | 107 | 27 |
| Registered active time, rounded | 5h22m | 1h44m |
| Engineering share of active time | 35.1% | 36.3% |
| Lead share | 19.2% | 15.2% |
| Explorer share | 3.8% | 5.1% |
| Verifier and Auditor share | 41.9% | 43.4% |
| Known total tokens | 95,640,725 | 33,853,032 |
| Input tokens | 94,593,584 | 33,563,488 |
| Cached input tokens, included above | 87,928,320 | 31,669,888 |
| Uncached input tokens | 6,665,264 | 1,893,600 |
| Output tokens | 1,047,141 | 289,544 |
| Rows with known total tokens | 214/218 | 52/55 |

At cutoff, one Lead turn had been active for another 15.519 seconds without a
completed usage record. It is excluded from the table. Total completed active
time is 7h06m09.281s. Sum versus union differs by only 8 ms, from overlapping worker
interval boundaries yesterday. There is no meaningful agent parallelism in
these records. This does not imply sequential shell tools within each role.

Across both days, known input is about 93.3% cached. The 129.49 million known
total tokens must not be treated as 129.49 million new input tokens or converted
directly into money. Known uncached input totals 8,558,864 and output 1,336,685.
Seven usage records have unknown token totals. Model-request counts are unknown
by protocol design; dispatches and Lead turns are not model-request counts.
Queue wait and startup durations are unrecorded for all 273 rows.

There are 134 dispatch records across 129 dispatch rounds. Some rounds contain
two assignments. No assignment has a second dispatch-journal attempt. This does
not exclude logical retries implemented as new assignments or rounds.

## Finding 1: automatic recovery loses useful context and repeats blocked work

After the R127 four-document repair, Lead supplied R128 with seven detailed
inputs, four evidence items, five checks and five stop conditions. It specified
implementation line ranges, historical failures, current document supersession,
an exact socket-free pytest command, and the owner-authorized evidence boundary.
It explicitly prohibited repeating known-blocked TestClient/full-sandbox tests.

R128 was refused as `review_origin_stale` before model execution: a 37 ms
dispatch interval and 7 ms recorded pre-turn elapsed, with no model usage
recorded. The controller automatically queued R129 with a fresh target.
However, its new brief contained only one checkpoint label, two opaque original
evidence IDs, a generic instruction to run relevant checks and one generic stop
condition. The immutable review context and allowed paths remained present;
the detailed execution guidance and known transport restriction did not.
The verifier later reported that the two evidence IDs were not discoverable in
the checkout.

This is directly explained by current source:

- [captureReviewRecoveryTemplates](../src/lead-graph.js#L802) retains role,
  allowed files, skills/tool pins and profile identity, omitting the execution
  inputs, checks and stop conditions.
- [recoveryAssignment](../src/lead-graph.js#L895) generates generic text from
  checkpoint metadata rather than carrying forward that brief.

The R129 rollout records seven pytest execution commands involving
`tests/api/test_server.py`, excluding collection-only commands. They start at
08:26:33, 08:27:09, 08:29:08, 08:30:29, 08:31:20, 08:32:05 and 08:32:47 UTC.
The assignment ends incomplete with repeated TestClient hangs.

Whole-assignment cost: 466,132 ms (7m46s), 1,156,678 known total tokens,
95,884 uncached input tokens and 7,098 output tokens. This includes useful
lifecycle/identity checks and cannot all be counted as waste. The repeated
transport work was avoidable given the original brief; assignment-level usage
cannot isolate its exact token cost.

## Finding 2: duplicate test execution also leaves a child process behind

In R129 the first long-running pytest invocation prints only its output and
`exit_code=undefined`, omitting the returned execution session ID. An identical
command is launched 35.467 seconds later. This is a concrete duplicate launch,
not an inference from repeated role names.

A separate read-only process snapshot at 08:38:55 UTC found PID 124021 sleeping
in the R129 lane `lane-mvezp50w-e25ac59e`, after 741 seconds, with the original
combined daemon/API/identity pytest targets. R129 had finished at 08:33:35.638.
This supports a child-process cleanup gap. Newly running tests from the R130
lane were present too and are not classified as leaked. No process was stopped.

## Finding 3: Lead itself does not duplicate source searches in this run

All four matching Lead rollout threads contain zero tool calls. They cover 139
completed Lead turns and the one active turn at cutoff. Lead consumes reports
and produces decisions; the theory that it broadly reads code and then makes
the worker repeat that same direct exploration is not supported here.

Worker rollout coverage includes 116 distinct threads serving 129 assignments.
The remaining five assignments have no recorded continuation thread: three
preflight failures and two auditor dispatches without model usage. Source
inspection and repeated commands between workers are observable, but repeated
reading is not sufficient to classify that work as avoidable.

The 16 Recovery/Senior assignments generally have substantive handoffs: 5-10
input items, 3-5 evidence items and serialized JSON sizes of 4342-7934 characters
under the audit serializer. Seven carry continuation metadata. For example,
R73 has exact scheduler line ranges, a failing persisted-graph regression and
persistence/API contracts. Its actual blocker is a missing numbered SQL
migration path in write scope, not a demonstrated lack of all useful context.
R74 then performs the durable repair after scope is expanded.

## Finding 4: repeated acceptance work mixes real defects with coordination cost

| Episode, local time | Observed work | Recorded assignment cost |
| --- | --- | ---: |
| R9-R22, Oct 18 16:56-17:52 | Focused completion tests pass; full/API acceptance is blocked by TestClient, EPERM and candidate identity mismatches; investigations distinguish runner topologies | 39m19s;5,664,026 tokens |
| R47-R55, Oct 18 20:20-21:31 | Lifecycle audit and verifier identify real startup/cleanup defects; repairs are followed by candidate/CI reconciliation | 28m45s;7,233,367 tokens |
| R71-R85, Oct 18 22:12-23:15 | Distinct rework-intent, persistence and test-synchronization findings; migration scope expansion; eventual verifier/auditor pass | 55m23s;24,526,661 tokens |

Costs are sums of the selected role assignments, excluding intervening Lead
turns, and are not pure overhead. Their quoted time spans are calendar bounds,
including gaps. Later reviews found new product defects, so suppressing all
repeated review would remove useful checks. Current logs also record 16 evidence
reuse events; the controller is not unconditionally rerunning every review.

## Priorities supported by this evidence

1. Preserve the complete bounded execution brief in automatic review recovery,
   including environment restrictions, exact checks, stopping rules and current
   evidence references. Refresh target identity separately from the execution
   instructions. Resolve evidence payloads or provide supported retrieval.
2. Preserve long-running tool handles and require cleanup of owned unfinished
   subprocesses before a role reports completion. Avoid launching an identical
   test merely because its session ID was omitted from the visible output.
3. Carry forward proven runner capability limits. Route required unavailable
   checks through the already-authorized evidence path; do not repeatedly
   rediscover the same transport blocker or silently weaken acceptance.
4. Keep independent review for the actual lifecycle/persistence/concurrency
   defects. Batch closely related repairs where possible, and reuse evidence
   only when target, dependencies and controller state still establish validity.

There is no comparable direct-Codex control run, no supported percentage of all
tokens that were wasted, and no measured speedup from these proposed changes.
This audit establishes specific avoidable mechanisms and their surrounding
costs, not a general multiplier or a recommendation to remove verification.

## Evidence and reproducibility

Local coordination directory:
`.agents/teamwork/runtime-audit-20261019/` (ignored by Git).
It contains `brief.md`, `metrics.py`, `metrics.json`, `metrics-handoff.md`,
`trace_audit.py`, `traces.json`, `cases.md`, `cases-handoff.md` and
`lead-findings.md`, `process-observation.json` and `review.md`. These retain
aggregates, IDs and paraphrased observations,
not raw private conversations or credentials.

The private temporary snapshot is
`/tmp/harness-audit-20261019-jlcuqqwq/snapshot.sqlite`; it may disappear.
Original rollout files under `/home/sr/.codex/sessions/2026/10/18` and `/19`
are read directly by the trace script and are not copied. Aggregate metrics
are reproducible with `python3 .agents/teamwork/runtime-audit-20261019/metrics.py`.
Trace diagnostics use `python3 .agents/teamwork/runtime-audit-20261019/trace_audit.py`.
Both scripts read source data; they do not mutate runtime state. Audit-local
outputs can be regenerated. Source Git state was clean before this audit.

The native `sessionPerformance` report, executed read-only against the same
snapshot, independently reproduces all aggregate elapsed/token totals.
Independent evidence review: APPROVE, no blocking findings. The transient
process observation is preserved as sanitized values transcribed from the
original tool output; it does not establish the process's later state.
