# Bounded live comparison design

Status: draft intake for independent review before model dispatch.
Authorization: user resumed remaining CN-15 work on2026-11-05. This is a
local disposable fixture, not production. Existing account only; no API keys.

## Equal workload

Seed the same small CommonJS repository for each engine. Broken implementations
in format-label.js, sum-positive.js and report.js; immutable verify-product.js
checks independently specified outputs, edge cases and invalid-input behavior.
No network, external package installs or generated answer artifact inputs.
Implement formatLabel(string) -> trimmed uppercase string (TypeError otherwise);
sumPositive(array) -> sum only positive finite numbers (TypeError if not array);
report(label, values) -> { label: formatLabel(label), total: sumPositive(values) }.
Preserve input arrays and imported module exports. Three allowed product paths.

The revised goal pins a single first read-only diagnostic probe: run the existing
failing product check, make no edits, and honestly report structured outcome failed.
Only after that failure settles does the model plan an investigation from retained
failure evidence, followed by independent repairs and normal failed-task supersession. Then inspect
its failure evidence through an explorer before repair tasks. format-label.js
and sum-positive.js can be repaired independently; report.js follows both.
No owner decision is required. The task requests distinct task identities for
investigation/repair, preserving the first failed attempt as historical evidence.
This is a deliberately controlled test failure, not a natural reliability sample.

## Controls and measures

Use actual native CodexAppServer, actual planner and specialist output, normal
A2A intake, host acceptance gates, private homes/runtime/workspace/token.
No response substitution, DB edits, acceptance bypass or reused product patch.
Roles: coordinator/engineer/explorer gpt-6-luna low, verifier high, Fast off;
reserve specialist escalation roles only on observed need. Capture actual
resolved settings and each actual run result/usage via pass-through observer.

After the first actual non-coordinator onEvent turn/started notification, send a
neutral steering message
via Concurrent's supported API: preserve the pinned goal, immutable checks and
three-file scope. This is the sole post-intake steering input. Legacy has no supported live
steering API, so its control coverage is unavailable and no input is fabricated. Do not answer
owner questions or resume tasks with invented replies. Capture received/applied
receipt and worker-active timing bounded by actual started/completed events;
onTurnStart precedes turn/start send and is not evidence of execution. The host
observer does not change model results.

Limits per engine: wall bound900s, turn bound180s, maximum20 native turns and
300000 observed total tokens. Turn/token limits stop further admission; active
turns can overshoot and actual usage must be retained. Check current quota before each new live run;
stop new work at90% 5h used. A quota/cost/deadline stop is incomplete, not pass.
Metrics: elapsed wall time, native planner/specialist counts and token details,
first failed attempt, investigation/repair identities, worker overlap and steering
latency, acceptance/check/candidate identity and safe shutdown. Unknowns null.
Ready-slot idle time remains unknown unless actual eligibility/resource intervals
can be proved. Matched accepted outputs/check obligations required for ratios.
Order is Concurrent then Legacy; report this nonrandomized single-case limitation.

Preserve read-only DB backup, candidate patch/source/check hashes, check streams,
actual role reports, provider facts and sanitized result before cleanup. Safely
close; cleanup private auth/token only after confirmed provider quiescence.
Unsafe shutdown preserves ownership/runtime and blocks replay.

## Acceptance

Both engines must independently accept identical product semantics under the same
pinned checks. Concurrent must also show failure -> investigation -> distinct
repair -> fresh verifier -> host checks -> durable acceptance with no owner reply,
and steering received/applied while native worker execution was active. Preserve
all incomplete attempts without describing staged completion as continuous.
Root/critic evaluate actual evidence; broader quality/economy remains unproved.

## First-arm boundary and intake clarification

The first native arm39a9d0e3 stopped after one genuine planner turn, before any
specialist call: its writable engineer task had an empty productWritePaths scope,
which the specialist contract correctly rejects. The source schema/capability
mismatch is under repair. No fabricated failure or recovery is claimed. Failed
state/backup are retained, owned provider groups are gone, and only the verified
owned runner process was terminated; engine shutdown was not released.

Intake clarification for the next matched pair is recorded in live-runner/
intake-clarification.json. Both arms use the same revised goal. The old incomplete
arm remains historical and is excluded from accepted-output ratios. Collector
logic/fixture/check/model settings remain the reviewed versions. The script emits
only preliminary objective acceptance; root/critic judge the actual recovery
history and final qualification from raw native/evidence/DB records.
