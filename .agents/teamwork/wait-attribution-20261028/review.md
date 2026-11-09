# Independent V42 bounded timing review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

## Reviewed scope

Read the wait-attribution brief/handoff, actual narrow timing additions in the
four owned source files and their paired tests, BacklogStore creation-plan event
mechanism, and the role service/check-proof consumers. Ran Git status/diff inspection;
the owned product files are inherited untracked files and no starting snapshots
were preserved in the worker directory. This review approves the identifiable
bounded timing changes, not all inherited code in those files or the full milestone.
No source, tests, fixtures, config, services or Git state were changed by review.

## Criteria and evidence

PASS - Actual separately attributable processing intervals (read/ran).
- backlogMs: original task creation plan event to initial revision-1 first claim.
  backlog_tasks.created_seq stores insertion plan revision and is deliberately not
  overwritten on conflict. The visibility join uses event.objectRevision plus the
  task membership, not the latest plan event or event stream sequence.
- writerMs: CandidateStore publication admission.acquire invocation to its resolved
  lease, persisted separately from candidate intent/admission identity. Time spent
  validating controls/content after acquisition is not added to that interval.
- providerMs: actual appServer.run invocation to observed onTurnStart callback.
  Inference duration is excluded, and this is host-observed startup, not a provider
  reported queue/latency metric.
- settlementMs: observed terminal return/error to durable BacklogStore attempt
  settlement. This includes result validation/checks/publication and poll delay;
  it is not pure idle time or an independently summable latency partition.

PASS - Truthful labels and unknowns (read/ran).
The UI explicitly names creation-to-first-claim including dependency/control wait,
writer acquisition, provider startup-to-turn-start and terminal-to-settlement
including checks/publication. Old rows without fields/tables produce null, rather
than fabricated zero. Missing/nonfinite/reversed timestamps produce null. Backlog
is null for revised or retried attempts because exact revision creation is not
known from the original event alone. Multiple publication-intent timings for one
attempt produce null, rather than choosing an arbitrary interval. Unknown tokens
remain null. The independent probe exercised two task-creation plans, three
ambiguous writer timings, revision ambiguity and nullable tokens.

PASS - Publication/authority/hash contracts preserved (read/ran).
The telemetry table is additive and separate from candidate_intents, candidate
identity/manifests, publication controls and admission lease JSON. Timing writes
alone are best-effort with narrow catches; authorization, effect execution and
settlement errors retain their existing guards and are not swallowed. Role
observation timestamps are outer execution record fields; they do not change
request/settings/check proof pins or execution provenance identity. The real
candidate suite retains stale-control/base refusal, manifest/hash integrity,
unknown partial effects and durability ordering. Strict verifier proof rejection
and successful role publication still pass. No contract/schema validator edits
are part of this candidate; the separate timing table is intentional metadata.

PASS - Legacy readonly projection/rendering behavior retained (read/ran).
Existing visibility old-schema, bounded scope/cursor and readonly assertions pass;
Backlog stale-selection/pagination tests pass with additive waits fields. Reads
do not instantiate CandidateStore/RoleService or write timing. No legacy public
API fields were removed or reinterpreted by these timing additions.

## Independent checks

1. node --test --test-reporter=tap --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/candidate-store.test.js test/delivery-visibility.test.js test/launcher-backlog-ui.test.js
   PASS 31/31, exit 0; review-focused.tap.
2. node --test --test-reporter=tap --test-name-pattern='authenticated role card and returnImmediately TaskExecutor publish private output only through CandidateStore|verifier host check proof and frozen CandidateReview receipt require pinned passing checks' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/delivery-role-service.test.js
   PASS 2/2, exit 0; review-role.tap.
3. node --test --test-reporter=tap .agents/teamwork/wait-attribution-20261028/review-probe.cjs
   PASS 1/1, exit 0; review-probe.tap. Probe is owned scratch and uses real in-memory
   BacklogStore/visibility; copied fixture setup only, no reviewed source mutation.

## Matrix disposition and limits

V42 may change from FAIL to PASS for the bounded offline requirement: four
separate explicitly labeled intervals and nullable tokens are available through
the real visibility projection and Backlog UI. Do not call these pure idle waits,
four mutually exclusive phases, live provider latency, complete per-attempt
accounting, or an L6 performance measurement. Current in-progress durations remain
unknown until both endpoints exist. Missing failed acquisition duration remains
unknown. No broad suite was run. Final full/frozen integration and other unresolved
criteria still govern whole milestone acceptance.

## SHA-256 reviewed inputs

ebc9b0704624665f8fba636b968019cd945a3638058115c6706dacd43b41fcd6  src/candidate-store.js
1c39360f79a212453bdbab4a805b4957f684c360a36089a52cc8a2600ccdca1b  src/delivery-role-service.js
e4de17fa1be7a988902dbba26f4fe53e980b3c4397260ccca85bdb5e32c93d8e  src/delivery-visibility.js
1f241b4a502c5d111d9bea6027875955fc094c333a9587f736f21de5aa9dae7d  launcher-ui/backlog.js
49012561019e1bd3d4ea6f12945b7faa26a1cf11fd9f3afc228bd130ecd53eca  test/candidate-store.test.js
031745b89a59be27839a3e4e3dc7f14226074a5d686a34105986ebab1c61ed6e  test/delivery-role-service.test.js
d9916f2b2048d9aaed8d3f680a9a330e22b4b28dd688c8dafebed167ef0277c4  test/delivery-visibility.test.js
541a878d7ab261dca83a13f415beb427bf47e191e76b8f8473aae78b845254bc  test/launcher-backlog-ui.test.js

Evidence SHA-256:
7e2fa5e3011952277e0924871fa455d76567b6b55c942fd0f6e528a22e45e06c  .agents/teamwork/wait-attribution-20261028/review-focused.tap
4a60361ba5b019c93075054dc75036dc28c18d40cf2ee8d91c9eec2021aaafbf  .agents/teamwork/wait-attribution-20261028/review-role.tap
4297a8ecc52fbc6dc26c525918a98e0afa3bff2fe954575038bbbeaf7e3d95a9  .agents/teamwork/wait-attribution-20261028/review-probe.cjs
92cb03b592c1ef7709766070f44513b5ad3ae9cbe4798b7f5ed3b39a75056a55  .agents/teamwork/wait-attribution-20261028/review-probe.tap
