# Concurrent Harness implementation status

Updated 2026-10-28. Source changes are uncommitted. The running backend was not
restarted or upgraded; this is source qualification, not a live rollout report.

## Current integrated qualification

The current frozen affected suite passed1231/1231. The full suite completed1982 tests:
1981 passed,0 failed,0 canceled,1 explicitly prohibited test skipped. Both runs
used identical input manifests and reported no drift. V14 protocol and ordering
repairs have independent approval. CN-14/CN-15 bounded offline source
qualification is accepted for V01-V43; L6 remains unqualified. See [qualification-matrix.md](qualification-matrix.md) and
[verification-summary.json](verification-summary.json) for current evidence.

The sections below retain milestone history, including earlier incomplete and
failed checkpoints; they do not supersede this current qualification statement.
L6/live rollout is separately unqualified. No runtime was updated.

## Completed source milestones

- Dedicated full-width responsive Roles page; project selection/back navigation;
  compact main-page activity instead of bottom role settings.
- Core configured capacities: engineer4, explorer2, verifier2, auditor2, lead1.
  Capacity fields persist and round-trip; the legacy scheduler does not enforce
  the proposed pool. Optional roles have explicit small defaults.
- Correct inherited versus explicit reasoning effort, model-specific option data,
  reset and save semantics; Fast inherit/off/on through capability/request plumbing.
  Fast on requires one explicitly advertised canonical `fast` tier; unknown remains
  unavailable. No per-role account or new-provider support was added.
- Connectors in the unchanged-width left sidebar; central content uses the removed
  right-column space. Main and Roles mock fixtures exercised desktop/mobile Chrome.
- Manual account refresh feedback, UI stale-response handling and server cache
  precedence. Both forced/background completion orders and existing handshake
  invalidation are covered. The independent cache probe returns forced20/cached20.

Independent source review: APPROVE for this role/settings/refresh milestone.
The reviewer found and verified fixes for obsolete Escape handling, project/save
races, deceptive Fast descriptions, inherited effort display/serialization, and
forced-refresh cache authority. No acceptance is inferred merely from worker output.

## New-engine foundation, not wired

CN-01 adds `src/delivery-contracts.js`, `schemas/delivery-v1.schema.json` and
`test/delivery-contracts.test.js`: versioned records, task/dependency identities,
cycle/reference/CAS validation and immutable active/terminal task contracts.
Planner proposals cannot assert succeeded output or grant publication authority;
standalone trusted-record validation can represent settled records.

Independent critic: APPROVE after dependency-only and planner-authority fixes.
Targeted adversarial challenge exposed unchecked supersession lineage, missing
standalone dependency successors, malformed checkpoint containers and path grammar
differences. Repairs pass the original probes and 16 focused tests, including
paired JS/schema safe-path checks. Final critic APPROVE and challenge HOLDS.
CN-03/CN-04/CN-05/CN-08 have qualified local source gates. The shared owner-correction/checkpoint-inventory extension and CN-09/CN-10 now
have qualified local source gates; runtime activation remains absent.
These validators alone do not activate the engine, migrate old runs or supply
continuous planning/candidate review acceptance.

## CN-03: transactional backlog and events, not wired

`src/backlog-store.js` and `src/delivery-events.js` add immediate SQLite plan CAS,
materialized dependencies, project-wide role/turn ceilings, one claimed revision,
durable attempt intent, stable contexts/fences, selected-setting pins, heartbeat,
generation takeover and conservative recovery. Expired/unknown claims continue to
reserve capacity. Submission requires a known external identity and a live claim;
recovery requires an explicit terminal result plus trusted quiescence/effect facts.
State and monotonic/deduplicated events commit together. Consumer cursors persist
across reopen; project/objective backlog cursors round-trip through pagination.

Final critic APPROVE and targeted challenger HOLDS. Focused contracts/backlog/event
suite: 37 passed, 0 failed. Fixtures include simultaneous worker-thread connections,
rollback injection, project-wide limits across objectives, stale owner generation,
same-timestamp events, missing-outcome recovery and pagination. This module creates
its own additive tables only when constructed; project startup is unchanged.

## CN-04: immutable candidates and publication intents, not wired

`src/candidate-store.js` adds complete content-addressed Git manifests, immutable
candidate identity and delivery/v1 projection, lineage/reference retention, frozen
review copies and intent-before-apply with injected trusted admission/control/
quiescence adapters. Full candidate identity is pinned before effects and rechecked
on recovery. Existing role services do not yet supply these adapters.

The targeted second-connection GC probe found a real retention race: a new
referenced snapshot could reuse a digest after metadata collection and before file
cleanup, which deleted the live manifest. The qualified repair retains immutable
blobs for the state database lifetime and makes SQLite's full manifest authoritative.
Manifest files are verified caches: missing files reconstruct from durable rows;
existing corrupt files are rejected. Metadata pruning and content publication use
immediate transactions; reuse during cache cleanup stays readable after restart.
Physical blob reclamation is not implemented by this gate.

The durability correction syncs blob bytes and their directory before durable
snapshot/known-candidate metadata, including reused/orphan blobs. Injected file/
directory sync failures fail closed; post-effect failures retain unknown effects.
Caller-supplied SQLite FULL durability remains required. Tests qualify ordering
and failure/retry behavior, not actual hardware power loss or Git+SQLite atomicity.

Final critic APPROVE and challenger HOLDS. Candidate tests: 17 passed, 0 failed;
the exact cross-connection/reopen/cache-tamper probe passes. Trusted quiescence
requires literal true; admission settlement requires an explicit released or
reconciled state. Known candidate status does not claim that the live workspace
still matches it. No runtime rollout is inferred.

## CN-05 and CN-08: execution and scheduling, not wired

`src/task-executor.js` commits exclusive per-attempt send intent before network
effects, pins real supplied settings/request identity, and reconciles deterministic
contexts without blind resend. Task/context/fence and first-observed thread identity
are checked on replay/results. A known continuation thread is reserved before send.
Shared transport failures fan out across roles by default project group; explicit
independent groups remain isolated. Pause fences new sends while permitting
cancellation, observation and trusted settlement of admitted work. Terminal A2A
status alone cannot supply output/process quiescence evidence.

`src/task-scheduler.js` and `src/task-resource-policy.js` admit eligible workers
through a synchronous frozen `canClaim` projection inside the store's immediate
transaction. Effective project/role/lead-reservation ceilings and source/read/
resource conflicts are checked against actual project-wide live claims, including
earlier claims in a batch. Submitted attempts poll independently; fast completion
can unlock a dependent while a sibling remains live. Unknowns retain capacity.
Full backlog eligibility does not stop at the first page. A frozen review input
proof cannot waive product-write conflicts, and verifier/auditor work retains the
critical barrier until trusted candidate binding exists.

Both local gates have final critic APPROVE and challenger HOLDS. Final related
store/executor/resource/scheduler/contracts/event command passed 81/81. These
interfaces use injected transport, role/settings/result adapters; legacy server
routing and real provider throughput remain unqualified.

## CN-09: available lead and steering, source-qualified

The shared owner-correction/checkpoint-inventory extension has independent critic
APPROVE and55 affected tests. Exact replay requires trusted literal-true
authorization on every invocation while preserving CAS exemption and idempotence.

CN-09 now exercises actual queue/scheduler/executor with fake model/transport:
immediate durable receipt during worker execution, atomic plan/steering and
correction/acknowledgement, project planner reservations, verified provider identity,
busy retry/reopen and correction-to-replacement execution. Owner pause prevents
new turns; stale held output is evidence only. Normal admission cannot retire a
live active turn; recovery requires exact identity and literal remote/process
quiescence through a default-deny trusted adapter.

The final owner-takeover probe showed that revision checks alone did not fence a
replaced owner. The repair pins ownerGeneration at construction, before model
admission and under acquire/apply; the controller aligns that fixed identity.
A held or subsequent old-owner turn cannot mutate tasks or acknowledge steering.
Final critic APPROVE, challenge HOLDS; related tests 92/92. CN-11 must provide actual
lifecycle/quiescence adapters; CN-14 must supply real thread/context bindings.

## CN-10: candidate-bound review, source-qualified

CN-10 uses actual claim/settings/thread binding, same-candidate independent
reviewers, exact receipt-bound promotion context and complete checkpoint
ancestry. Clock/reopen replay preserves original timestamps/records. Candidate
context/receipt/promotion refs commit atomically with their rows and events;
a conflicting loser cannot delete an independently committed winner's ref.
Final critic APPROVE; challenge HOLDS with seven actual API probes; focused 18/18,
adjacent contract/resource/scheduler/backlog tests 60/60.

The final interleaving probe commits a winner after a stale preflight but before
the loser's BEGIN. A nested same-connection savepoint after BEGIN is part of the
outer transaction, not an independent winner; that old injection is historical.
These modules are not wired into project startup. CN-12 and CN-14/CN-15, final
acceptance, migration and live provider throughput remain unqualified.

## Performance repair: accepted source correction

`launcher-ui/performance.js` and `test/launcher-performance-ui.test.js` repair the
per-task token view using attributable detailed usage. It retains real unknowns,
known snapshot aggregates and timing-source distinctions. The final adverse case
was an incomplete live subtotal replacing a more complete snapshot. Its correction
now passes the exact probe: task12tokens/100ms and session12 remain intact.

Independent continuation review exposed two remaining session-level inconsistencies:
a finite partial live total replaced the known snapshot total, and the live attempt
count replaced the snapshot count even when its token aggregate was retained.
The accepted repair treats token components and coverage counts as a coherent
aggregate, replacing known values only after attributable complete coverage.
Final critic: APPROVE. UI tests 12/12, related backend tests 21/21, and the original
adverse probe pass. Sanitized read-only DB evidence found 98 ledger rows,
95 with known totals and 3 unavailable; no model call or state write was used.

## Verification and limits

Frozen affected new-engine command:

```sh
env -u NODE_TEST_CONTEXT node --test test/delivery-contracts.test.js test/backlog-store.test.js test/delivery-events.test.js test/candidate-store.test.js test/task-executor.test.js test/task-resource-policy.test.js test/task-scheduler.test.js test/delivery-inbox.test.js test/lead-planner.test.js test/project-delivery-controller.test.js test/candidate-review.test.js test/delivery-review-policy.test.js
```

Result: 152 passed, 0 failed. Temporary log:
`/tmp/concurrent-continuation-final-affected-20261026.tap` (may disappear).
Full `env -u NODE_TEST_CONTEXT npm test` was run against frozen source:
1633 tests, 1623 passed, 9 failed, 1 skipped. Eight failures match previously recorded
legacy continuation/tool/profile expectations; one additional launcher startup
shutdown assertion failed in the concurrent full run. Isolated startup rerun
passed 2/2. This is NOT a green full suite or proof that the startup flake is fixed.
Temporary logs: `/tmp/concurrent-continuation-full-20261026.tap` and
`/tmp/concurrent-continuation-launcher-rerun-20261026.tap`.

App Server focused4/4 evidence is reused only for unchanged inputs. Syntax/ASCII,
source-preservation and diff checks accompany the checkpoint. All original dirty
work remains; no commit, live provider turn, restart, account/connector action,
external publication or target mutation occurred. The backend has not reloaded.

## Next executable sequence

1. Check fresh actual quota. At2026-10-26T19:20:05Z only 8% five-hour quota remained
   (weekly55%); no new tasks/agent turns after the threshold.
2. Start CN-11 lifecycle and durable recovery from the prepared continuation brief.
   CN-09/CN-10 local gates are complete; do not repeat their architecture research.
3. Preserve the full-suite failure evidence. Investigate the launcher startup
   flake as a distinct scoped followup if needed; do not claim all tests green.
4. Continue package dependencies through CN-12/13/14/15. Explicitly qualify the
   configured verifier's source/scratch adapter at CN-14 before real execution.
5. Apply backend changes only with actual lifecycle authorization that preserves
   active project work. Launcher stop can stop managed children.

## CN-13: backlog and team visibility, source-qualified

The additive read-only launcher routes and Backlog page discover objectives and
show paginated tasks, conservative dependency readiness, project-wide role
occupancy and detailed idle causes. Unknown checkpoint/runtime admission remains
explicit, configured ceilings are not presented as active limits, and planner
activity is labeled session-wide. Scoped cursors and selection generations protect
project/session/objective changes. Loaded pages refresh without a pagination stall.

Independent critic APPROVE after semantic and browser corrections. Focused50/50 after the readable task-summary followup;
real Chrome desktop1440/mobile390 has matching theme colors, no JavaScript errors
and no document overflow. UI loads at most10 pages; API pagination continues.
New engine startup remains inactive. CN-11 and CN-12 are qualified; CN-14/CN-15 remain.

## CN-11: lifecycle and scoped recovery, source-qualified

Durable owner pause/stop/cancel, generation/control-pinned budget waits and
scoped finite retries preserve intent across reopen. A task's retry/recovery
exhaustion blocks its own scope while unrelated ready work stays admissible.
No-effect recovery requires exact trusted attempt/context/intent/fence/generation
and remote/process/effect proof; unknowns retain capacity. Planner validation
retries require host-confirmed terminal quiescence; thrown errors stay held.

Shutdown now latches an admission generation and fences queued/entered cycles
around awaits. It reports unsafe until cycles and planner reservations drain;
a held planner output becomes stale before applying. Independent critic APPROVE
after reproducing/fixing the pre-planner shutdown race. Owned suite98/98; targeted
challenger HOLDS with3 actual second-connection/reopen probes and7 focused tests.
These are local source gates, not startup wiring or live provider qualification.

## CN-12: final acceptance join, source-qualified

The production `finalizeCandidate` entrypoint joins the durable finalization
barrier, real owner checks on the exact frozen candidate, and atomic objective,
event and candidate-retention commit. Exact contract/settings/receipt/revision
pins and fresh trusted authorization govern completion and replay. Checking or
unknown effects retain their fence across reopen; ready records can commit
without rerunning checks. Failed checks and modified candidate bytes reject
acceptance. Partial completion requires trusted investigated remainder facts.

Independent whole-package critic APPROVE; focused safe suite 81 passed, 0 failed.
Targeted challenger HOLDS with three disposable real-SQLite probes: two-handle
check admission, authorization revocation during checks, and terminal-event
rollback followed by zero-check commit recovery. The earlier runner Git-control
dimension reuses its independent defensive review; its separately blocked hostile
probe was not repeated. One named hostile regression was excluded from these
runs. The recovered predecessor full run recorded 1,691 tests: 1,681 passed,
9 failed and 1 skipped; those failures match the previously recorded baseline.
This is source qualification, with engine composition and broader integrated
qualification still pending in CN-14/CN-15.

## CN-14: qualified prerequisites, core integration pending

Configured scoped verifier execution, physical planner-thread preparation and
immutable private-output publication have independent critic approval after race,
policy, durability and recovery corrections. Targeted artifact admission/duplicate
publication probes hold. The verifier pause probe originally found a callback-to-send
race; the corrected actual write-boundary check passes the original probe with zero
turns after pause and no receipt. Focused wrapper/verifier tests22/22; artifact8/8.

Installed Codex0.164.0 standalone command/exec permits scratch writes and candidate
reads while denying candidate/outside/TMPDIR writes. Actual model-turn confinement
and live provider qualification remain unverified. Core engine/server/settings,
engineering A2A publication routing, trusted closure/result composition and shutdown
integration remain pending. CN-14 as a whole and CN-15 are not accepted or activated.

Current frozen affected checks:320 passed,0 failed. Full suite:1723 tests,
1714 passed,8 failed,1 skipped. The eight failure names match the known legacy
baseline. The previously observed launcher shutdown flake did not fail this run;
no flake repair is claimed. One named hostile Git filter regression was excluded,
reusing its prior independent defensive review. Source inputs did not change during
these runs. Local evidence may disappear; permanent regression tests preserve the
accepted behavior.

## CN-14 current composition continuation

The source now composes the selected engine through the shared server/router,
SQLite state, admission, lanes and authenticated controls. This supersedes the
previous unwired-startup checkpoint; no running project has loaded this source.
Stored mappings retain their engine, and previously existing lead tasks remain
legacy when the default changes. Whole CN-14 and CN-15 remain unaccepted.

Owner UI/API/settings and durable acknowledgement fixes passed independent
re-review, 69/69 focused tests. Steering retains scoped drafts and exact uncertain
retry bodies; settings require the project to be exactly stopped. The requested
Roles layout now has three desktop columns, two at intermediate widths and one
on narrow screens. Chrome checked 1440, 1920, 900, 600 and 390 pixels without
horizontal document overflow; the Roles suite passed 10/10.

The core milestone has actual two-engineer publication overlap and successor
planning, immutable role/provider pins, atomic steering replay and exact frozen
acceptance. Empty owner-check contracts now preserve the mandatory verifier gate
while normalizing the legacy empty-check disposition after manifest validation.
The focused core/acceptance/artifact/capability suite passed 46/46 with the named
hostile Git-filter regression excluded. The result-schema mismatch in invalid planner recovery was corrected and passed
independent safety review, 6/6 focused tests. Recovery still requires genuine
process-group quiescence; a live persistent AppServer remains held. The same
review approved durable shutdown inspection of canceled runs after database
reopen. A targeted challenge then found missing settlement attestations could
pass a SQLite NULL comparison. The repair passed independent review and the
original reopened-database probe: missing, null and false attestations now block
release. Two persisted runs with unknown planning or pending inbox also stay
fenced; a known literal-true settlement is the positive control.
Inherited core pins, atomic steering and actual overlapping engineer/dependent
composition also passed independent review (16/16 core tests); empty-check
normalization passed six independently run focused acceptance tests.

The initial host milestone passed focused tests, including real server restart,
persisted concurrent-to-legacy downgrade fencing, mixed unknown claim/publication
states, symmetric legacy fencing and independent projects. Startup rejects an
unknown stored engine without overwriting its mapping. The corrected admission package passed independent review and 70/70 host tests.
It checks mapped project/session identity, planner terminal state, authoritative
candidate/role effects and exact publication intent linkage before cross-engine
admission. A cached publication result alone cannot establish settlement. A separate default real-composition
fixture reached ordinary acceptance with empty owner checks. With inherited
cooperative permissions, safe shutdown retry after a held worker completes still
has a reproduced unresolved-claim failure.
A scoped RoleService recovery preparation/proof API passed independent review
and 30/30 tests. Engine shutdown now uses that API and the existing lifecycle and
executor settlement path to recover completed owned-worktree attempts whose send
acknowledgement was lost. Six real HTTP integration cases qualify safe repeated
shutdown, canceled SQLite reopen, retained private evidence, and refusal for
cooperative lanes, unknown provider/publication effects and pending owner messages.
This bounded wiring milestone passed independent review (23/23 focused tests) and
two adversarial probes for multi-run fencing and provider identity drift during
cleanup. Ordinary inherited cooperative retry-close remains refused and unqualified.
The facade checkpoint below supersedes the pause/resume and trusted correction
limitations. Broader shutdown recovery remains pending.

The affected suite exposed a drain regression: polling durable unknown execution
rows consumed the host shutdown timeout without any local work to await. Shutdown
now waits only for active in-process role calls and keeps durable release guards.
The deterministic regression reproduced before repair; independent re-review
approved the fix. Final engine/host checks passed 74/74, and both adversarial probes
passed again on the repaired source.
The host review findings about terminal-objective planner and authoritative
publication/role effects are resolved within the reviewed admission package.

Previous frozen affected regression: 717 tests, 715 passed and the same two
ordered baseline failures, with no input drift or timeout. The initial affected
attempt timed out on the drain regression and also observed an intermittent
launcher signal-exit failure; the isolated launcher case and final affected run
passed. No launcher source changed in this milestone. The full suite was not rerun
for this bounded change. The retained prior full result is 1,869 tests, 1,858 passed,
ten failed and one skipped, with no input drift. The ordered ten full failure names match the actual
retained predecessor run (1,792 tests, 1,781 passed, ten failed, one skipped),
with the same source locations and reported failure categories. Earlier
1,751/eight-failure documentation was stale. These suites are not green, and no
new failure names were observed. The named hostile Git-filter regression was
excluded; its earlier independent defensive evidence was reused.

CN-14 still needs ordinary cooperative safe retry-close qualification, broader
terminal reconciliation after unsafe shutdown, and integrated final core acceptance. CN-15 comparative/live qualification is not complete. Follow the
[activation procedure](activation.md) for source application and separately
authorized restart/trial boundaries.


## CN-14 facade, correction and recovery scope checkpoint

Owner pause now returns an honest `input_required` facade result while admitted
planner/worker calls remain observed. Legal resume transitions reused and reopened
controllers, without overlapping provider turns or blanket budget/technical resume.
Independent review approved seven facade regressions and 35 selected adjacent
checks; three independent race probes held. Worker related checks passed 65/65.

Trusted typed owner corrections are drained before resume changes the control
revision. A synchronous controller hook composes correction, replacement checkpoint
registration, existing supersession validation, current inventory and applied
acknowledgement in one transaction. Historical checkpoints, original goal/contract
and intake requirement digest remain unchanged. Current objective pins drive
planner context and finalization. Repeated correction/reopen reaches acceptance
with mandatory owner checks and independent current verifier evidence. Registration,
supersession, hook and acknowledgement failure roll back the complete change.
This qualifies the injected trusted correction API; production authentication and
correction authorization still default to deny, and no new control route was added.

Independent review initially rejected a real composed safety defect: shutdown's
trusted no-effect recovery requeued an old-goal task, and resume sent it again
without explicit replanning. New claims now capture goal revision. Recovery closes
the proved attempt but blocks stale goal or authority scope for explicit replanning;
legacy missing goal capture may retry only at the original goal revision 1.
Same-goal pause/resume retries and cancellation retain their behavior. The repair
passed independent re-review: nine store/executor checks, eleven combined correction
checks and an actual engine/HTTP/Git/SQLite probe demonstrating no obsolete resend
and successful execution of a distinct task explicitly planned at corrected pins.
Worker correction related checks passed 92/92; recovery related checks passed 88/88.

AppServer execution metadata now includes a versioned cleanup receipt only after
confirmed cleanup on the original generation, child and observed process identity.
Its scope is explicitly provider-managed background terminals. Missing identity
cannot mint a receipt; generation/process drift and cleanup errors fail closed.
Independent review approved fourteen adapter checks and four additional boundary
probes. This is evidence plumbing, not proof of arbitrary escaped-process absence,
confinement, no effects or safe cooperative release.

A separate retained fixture still refuses ordinary resume after correction, unsafe
shutdown and terminal drain: lifecycle recovery makes the attempt unknown, while
the normal terminal adapter requires running identity. Claims and private bytes
remain retained. This broader terminal reconciliation and cooperative retry-close
are not claimed fixed. CN-14/CN-15 remain incomplete and the running backend has
not been upgraded.

Final frozen affected checks: 748 tests, 746 passed, the same two ordered baseline
failures, no skips/cancellations, no timeout or input drift. Full checks: 1,906 tests,
1,893 passed, twelve failed and one skipped, no cancellations, timeout or input
drift. All ten retained baseline failures remain. Additional observations were the
known intermittent launcher signal-exit assertion and the new direct-resume
correction fixture's acceptance timeout. Both isolated cases passed 1/1; neither
failure is claimed fixed by an isolated pass. The full suite is not green.

Bounded diagnosis reproduced a separate deterministic scheduler defect: a poll
timer firing before its deadline clears itself without rearming; the attempt stays
active with no in-flight call or future timer. This matches the failed fixture's
shape, but the full run did not retain timer evidence to prove causality.

The scheduler repair now rearms future submitted polls after an early callback
and prunes stale or parked deadlines. Independent review found and rejected an
initial Promise completion race: a wake between result publication and finalizer
cleanup discarded a future deadline and polled twice immediately. The repaired
version retains in-flight deadlines while excluding them from timer selection.
Retained regressions fail against the original early-callback implementation and
the rejected race implementation, respectively. Final independent review approved
44 scheduler/executor tests; adversarial probes held for multiple deadlines,
in-flight completion, early callbacks, stop/restart, removal and unknown parking.

The final frozen affected run has 752 tests: 749 passed, three failed, with no
skips or cancellations. It retains the two predecessor affected failures and the
known intermittent launcher signal-exit assertion. The final frozen full run has
1,910 tests: 1,898 passed, eleven failed and one skipped, with no cancellations.
Neither run timed out or changed its input hashes. No new full-suite failure names
appeared. The earlier direct-resume correction timeout did not recur in either
run; this does not prove its historical cause. The suite remains non-green, and
broader unsafe-shutdown terminal reconciliation, cooperative retry-close and final
CN-14/CN-15 integrated qualification remain pending. No backend was upgraded.

## Matched scheduling and legacy regression qualification

The matched offline workload in `test/concurrent-engine-comparison.test.js`
executes the real legacy and concurrent paths against equal logical task payloads,
mandatory checks and accepted product bytes. Shared barriers show concurrent
dependent publication while both slow siblings remain active; legacy dependent
dispatch waits for its wave. Both peak worker counts are two. Independent review
approved this bounded V41 comparison. It proves causal scheduling progress, not
real-provider speed, cost, quality or higher peak capacity. The dependent enters
through a later planner delta after predecessor publication. Pre-admitted successor
rebasing is not qualified by this fixture.

`test/delivery-migration-qualification.test.js` preserves real pending claims,
attempts, events and immutable mappings across interruptions before and after an
additive ALTER, SQLite reopen and idempotent retry. Composed runtime fixtures
prevent legacy publication while a concurrent private writer is held and prevent
concurrent intake while a legacy publisher owns the run; aliases remain excluded
while an independent workspace progresses. Independent review approved these
bounded preservation and exclusion checks. They do not prove transactional DDL
rollback or positive safe-disable drain/reconciliation; complete V39 remains open.

Launcher readiness is now announced after SIGINT/SIGTERM handler registration.
A deterministic real-child check fails on the original ordering and passes on the
repair. Legacy fixtures now preserve exact continuation tool pins, enforce MCP
enumeration refusal, validate curated role allowlists, and exercise same-workspace
restart without resending alongside cross-project refusal. Independent checks
passed 247 legacy tests and 35 selected existing downgrade/effect tests. Final
frozen affected/full checks are still required after terminal source integration.

## Terminal shutdown and integrated matrix checkpoint

Staged shutdown now fences admissions, drains local callbacks, persists original
provider groups, closes the provider, and independently checks original-group
absence before failure-only retirement. Qualified managed-terminal receipts alone
do not prove group absence. Terminal retirement preserves private output, original
reports and measured shared-workspace drift as failed/canceled not_published; it
does not publish, assert noEffect, or requeue old goals. Final lifecycle and effect
guards still decide whether state and workspace ownership can be released.

Independent review found a retry bug: an internally completed shutdown after a
caller timeout could be reset from released to draining by the next close. The
repair preserves completion for the same host lifecycle while a fresh lifecycle
can begin a new drain. Independent review approved 32 targeted checks and bounded
challenge held for overlapping callers, late completion and safe rejection
retention. Rejected provider-close recovery within the same host remains
unqualified; the safe negative retains ownership.

The real composed V43 offline scenario now runs failure, investigation, a distinct
repair, candidate publication, independent verifier, mandatory checks and durable
acceptance without an owner decision reply. Authenticated status and steering
remain available while investigation is held. Independent review approved this
bounded known terminal no-write failure; challenge held within the real evidence
store contract. Live diagnosis quality, cost and uncertain-effect retry are not
established.

A frozen affected checkpoint passed 896/896 with no input drift. Its full-suite
checkpoint timed out at 300 seconds without a TAP summary, with no input drift;
it is not a passing run. A retained server fixture exposed delayed Promise
rejection handling and failed-path cleanup that deleted lanes before closing the
owned HTTP server. Test repair and final frozen requalification remain required.

Independent V01-V43 matrix inspection also found missing required-owner-decision
enforcement (V14), missing failed-reviewer retry/sibling preservation evidence
(V16), and missing four-way wait attribution (V42). Scoped corrections are under
implementation/review. CN-14/CN-15 acceptance remains open; no runtime was updated.


## Matrix gap corrections before final qualification

V16 now has independent approval for retry after a failed review verdict. The
real store allocates a distinct retry task/attempt for the same frozen candidate,
manifest and checks. The successful sibling receipt and failed receipt remain
byte-identical; a newer candidate receives no qualification from the old receipts.
The focused file passed 20/20. This is a trusted completed execution returning a
failed verdict, not a provider/process failure recovery claim.

V42 now projects and renders four labeled processing intervals for backlog,
writer, provider and settlement. Missing, ambiguous, negative, reversed and invalid
calendar endpoints remain unknown. Independent review passed 17/17 including four
adversarial cases. Intervals can overlap and include processing; they are not pure
idle time, exclusive latency partitions or real-provider measurements.

V14 now enforces a durable required-owner-decision gate and scoped authenticated
response/replacement. The HTTP503 baseline exposed an oversized inbox trigger;
a bounded digest suffix repairs that failure. Independent review also exposed a
public requestControl resume bypass; the shared transition now refuses resume
while a decision is pending. Named obligations, current pins, duplicate replay,
pause/stop/cancel precedence and original investigator evidence remain enforced.

The real composed fixture closes the host and SQLite while the same acceptance
run is waiting, preserves exact request/digest/reply pins with no provider resend,
then requires authenticated reply, verifier, mandatory checks and durable accepted
candidate. A separate corrected-goal scenario verifies explicit replacement,
original investigator pins and drift/unavailable-evidence refusal. Its unresolved
new-goal planning obligations are not represented as accepted. Engine-only swaps
with old Express role routes establish durable resolution, not reconstructed-host
acceptance. Related tests passed161/161; independent delta review passed20/20.
Final challenge, frozen affected/full verification and independent V01-V43
acceptance remain required. No running backend was updated.


The subsequent frozen affected run passed923/923 with unchanged inputs. Its full
run completed1961 tests:1959 passed,1 failed and the prohibited filter probe was
skipped. The failed V14 composed fixture returned completed before a fresh run
reached its expected required owner question. This is not attributed to an old
baseline or a timeout. Completion/callback/planner ordering is under investigation;
final offline acceptance remains blocked until a verified correction and frozen
requalification. Independent V14 boundary probes passed3/3 but do not supersede
this composed regression.


The full-run failure was reproduced deterministically with real project-wide
planner reservation contention. While a corrected first run held its planner slot,
a fresh second run reported busy and retained its run.initial wakeup. The engine
nevertheless inserted verifier work and advanced planRevision from0 to1 before
its first planner turn, preventing the fixture's initial investigated plan.
The source now waits for durable inbox wakeup consumption before adding reviews
or beginning finalization; owner-correction synchronization still runs first.
The retained fixture proves unchanged revision/empty tasks while busy, then
releases the slot, reaches the owner wait, closes/reopens the same run and requires
reply, verifier, mandatory checks and durable acceptance. Focused repair checks
passed20/20 and correction regressions7/7. Independent delta review and new frozen
broad checks must supersede the failed full checkpoint before final acceptance.


## Final offline closeout

The repaired frozen affected run passed923/923; full1961 total completed with
1960 passed,0 failed/canceled and1 explicitly prohibited test skipped. Identical
input manifests and no drift qualify the repaired source. Independent matrix
inspection accepts all V01-V43 within their documented offline boundaries. This
supersedes earlier pending/failure statements retained above as milestone history.
CN-14 source is accepted; CN-15 offline qualification is accepted with L6/live
still unqualified. No backend, launcher or production project was restarted.


## Concurrent startup and verification followup

A real user startup failed under the default inherited legacy workspace-write
policy: lane selection fell back to shared, which concurrent delivery correctly
refused. Source now supports a host-owned admitted-lane mapping for this specific
native policy while preserving explicit roots, native approvals/temp restrictions
and established verifier IPC behavior. Unknown/managed profile data remains
unsupported; no full-access promotion or confinement claim is introduced.

Launcher API/UI now retain sanitized startup diagnostics across polling/reload.
Independent review caught a secret suffix leak across stderr chunks; complete-
record buffering and bounded omission repair it. Verification preflight identifies
its route as a non-callable fingerprint and distinguishes inspector mounts from
actual verifier capability when diagnosing cache/scratch failures. This is not
proof of autonomous model recovery or a live repair of the user's paused run.

Both source deltas have independent approval. Final frozen affected/full followup
verification is pending; the earlier1960-pass full run remains a historical
baseline rather than evidence for these new deltas. No existing service, live
provider, native/project setting or paused task was changed by this followup.


## Accepted startup followup verification

The final frozen followup affected run passed1218/1218. Full1968 total completed
with1967 passed,0 failed/canceled and1 explicitly prohibited test skipped. Both
runs used identical input maps and reported no drift. Independent launcher/
preflight approval and native lane approval qualify these bounded source deltas.
This supersedes the pending followup verification paragraph above. The previous
1960-pass full checkpoint remains historical. No model recovery, live-provider
startup, running-service update or paused legacy run resume is claimed.


## Owner-authorized full local autonomy followup

The owner explicitly requested full local execution without permission questions.
Source adds an owner-only full-access project mode and an optional persistent
launcher default. Lead, inspection, engineering and scoped verifier turns select
the allowed full profile with never approvals; agent checks use the same allowed
profile via threadless RPC. Original-project trust lookup is retained for private
cwd/mirrors. Managed denial fails explicitly, while candidate/claim/check settings
and unknown-effect guards remain enforced. Existing inherit/strict are unchanged.

The real App Server capability probe returned allowed full-access/never for the
active default account without a model turn or configuration mutation. Source
freeze is under independent review and broad followup qualification is pending.
Owner settings/runtime application and recovery of the previous paused verification
remain root-owned subsequent steps, not already accomplished results.


## Applied owner-authorized local execution

Source review APPROVE and final frozen checks passed: affected1231/1231, full1981
passed0failed1prohibitedskip, identical manifests/no drift. Owner full-access was
applied to both registered projects and the persistent launcher default. The
launcher and active concurrent-default server were safely restarted; paused task
state was preserved. Real App Server0.165.0 accepted all four role preparations
with full profile/never approvals and proved writable /tmp and uv cache. The
previous legacy verification pause was answered under explicit owner authority;
its resumed lead reports danger-full-access/never and the task continued internal
work. Final target acceptance and general model autonomy are not claimed. P-40 in
production-transfer.md and the owner-full-local-execution ADR retain the incident.
This supersedes pending followup/runtime application statements above.
