# Lead findings

All aggregate metrics use the frozen SQLite snapshot at 2026-10-19T08:33:51.211293Z.
Rollout events are also cut off at that timestamp. A separate process observation
at 08:38:55Z is identified below and is not mixed into the aggregate window.

## Direct Lead/worker duplicate exploration is absent in this sample

Four matching Lead rollout threads cover 139 completed turns and one active
turn. Counts by thread (started/completed/tool calls):
- 01a14f32-15f6-7f62-a95f-7e438cde5d92: 58/58/0.
- 01a1501f-6045-71b1-b8fc-f5021498aeca: 38/38/0.
- 01a150ab-af1f-7151-aa40-afbcb657106a: 34/34/0.
- 01a15328-02a4-71f3-9326-06cfbabfee24: 10/9/0 at cutoff.

This contradicts a claim that the Lead itself broadly reads code before
delegating in this run. It consumes reports and plans. It does not establish
that workers never reconstruct facts already supplied by other workers.
Trace coverage includes 116 distinct worker threads serving 129 assignments.
The other five assignments have no continuation thread recorded; they are
three preflight failures and two no-usage auditor dispatches.

## Recovery/senior handoffs usually include useful context

All 16 recovery/senior assignments have concrete inputs/evidence. Serialized
JSON character counts using Python json.dumps default escaping: 4342-7934,
5-10 input strings, 3-5 evidence strings. Seven use continuation metadata.
Prompt size is not a measure of adequacy. Manual r73 inspection shows exact
scheduler line ranges, failing regression, persistence/API contracts and prior
attempt references. Nevertheless a required numbered SQL migration path is
missing from write scope, so r73 cannot complete the proposed production repair.

## High-confidence context-loss mechanism in automatic verifier recovery

R128 Lead-authored verifier assignment contains seven inputs, four evidence
items, five exact checks, and five stop conditions. It names the four-document
repair, relevant implementation line ranges, historical failed review, exact
socket-free pytest command and the owner-authorized evidence boundary. It
explicitly says not to repeat full sandbox pytest or known-blocked TestClient.

R128 is refused before model execution as review_origin_stale. R129 is
automatically queued and does not continue the previous thread. Its input is
reduced to one checkpoint label, two opaque original checkpoint evidence IDs,
one generic check and one generic stop condition. The full immutable review
context and allowed paths remain present, but the execution brief and known
transport limitation do not. Its report says the two IDs are not discoverable
in checkout.

Source mechanism matches the live payload exactly:
- src/lead-graph.js:802 captureReviewRecoveryTemplates saves role, allowedFiles,
  skills/tool pins and profile hash, omitting inputs/evidence/checks/stopConditions.
- src/lead-graph.js:895 recoveryAssignment reconstructs a generic assignment
  from immutable review metadata, not the original execution brief.

R129 uses 466132 ms and 1156678 known total tokens (the whole assignment,
including useful lifecycle/identity work; not a pure-waste measurement).
Its rollout contains SEVEN actual pytest execution commands involving
tests/api/test_server.py, excluding collect-only:
08:26:33.788Z, 08:27:09.255Z, 08:29:08.719Z, 08:30:29.328Z,
08:31:20.582Z, 08:32:05.204Z, 08:32:47.181Z.
The final report is incomplete because TestClient hangs and required coverage
is unfinished. This directly connects dropped context with repeated blocked
work; the fraction of assignment tokens attributable only to the retries is
not measurable from assignment-level usage.

The first command outputs only r.output and exit_code=undefined, losing the
exec_command session_id. A second identical command is launched 35.467 seconds
later. In a separate read-only /proc observation at 08:38:55Z, PID124021 was
still sleeping in the R129 lane lane-mvezp50w-e25ac59e, elapsed741s, running
the original combined daemon/API/identity pytest targets. R129 had finished
at08:33:35.638Z. This supports an orphaned child-process lifecycle issue. No
process was stopped. The other pytest processes in that observation belonged
to the new active R130 lane and are not classified as leaks.

## Classification limits

Repeated audits also exposed real distinct defects and several concrete
repairs. Failed review counts do not equal infrastructure failures or wasted
work. No direct-Codex control exists; no speedup multiplier or monetary cost
is established. Queue/provider/tool wait breakdown is incomplete. Rollout
search-command counts are inspection diagnostics, not a waste metric.
