# Independent qualification checkpoint review

Verdict: APPROVE for the bounded test and launcher candidates.
Blocking: none in these candidates.
Status: complete
Scope expansion: none

Full V39 acceptance remains INCONCLUSIVE because safe engine-disable drain and
unknown recovery after reopen are outside these fixtures and not yet qualified.
This is a limit on milestone evidence, not a defect in the preserved tests.

## Outcome 1: V41 matched actual execution comparison

Verdict: APPROVE

Read the complete new test/concurrent-engine-comparison.test.js and the worker
brief/handoff; checked actual legacy review gates and concurrent candidate/check
paths relevant to its assertions. Independently ran the test successfully.

| Criterion | Result | Evidence |
| --- | --- | --- |
| Actual legacy and concurrent execution | PASS | Real LeadOrchestrator/registerRoleAgents over local HTTP and real ConcurrentDeliveryEngine, Git/SQLite, lanes, publication/review/acceptance; only providers are fakes. |
| Same logical task/DAG/check payloads | PASS | One frozen three-task workload; both provider boundaries compare payload fields; concurrent requires_output edge is asserted; mandatory check contracts and authoritative check outputs match. |
| Deterministic scheduling gain | PASS | All four initial sibling starts precede common release; concurrent dependent publishes before slow release, both slow turns remain live, legacy dependent starts only after its slow finishes. Peak concurrency equals two for both. |
| Equal accepted output | PASS | Both authoritative accepted dispositions required; durable concurrent accepted finalization pins candidate ID; current candidate verifier/check projection required; real legacy acceptance gate and accepted verifier outcome required. Materialized concurrent candidate equals legacy product file-for-file; check stdout/results match. |
| Honest proof limits | PASS | Later planner admission is explicit in code and handoff. No duration ratio, provider speed/cost/quality or higher peak-capacity claim. |

The dependent is admitted after predecessor publication in both translations.
This meets the stated matched-workload causal comparison, but does not establish
pre-admitted dependent base rebasing. The retained initial full-DAG failure is
not fixed by this test and must not be described as fixed. The slow sibling is
a matched no-change inspection; this is a deliberately bounded workload, not
a general throughput benchmark. Fake turn identities come from disposable groups
that are actually stopped before terminal return; no fabricated live-process
quiescence is used for successful publication.

## Outcome 2: V39 migration and V40 exclusion fixtures

Verdict: APPROVE for the new bounded fixtures and V40 intake exclusion evidence.
Full V39 safe-disable acceptance: INCONCLUSIVE pending the source milestone.

Read all test/delivery-migration-qualification.test.js, router migration and
intake-before-pin ordering, actual server publication/intake fence, and relevant
existing server downgrade fixtures. Independently ran the new tests plus router
suite and four selected existing downgrade test families.

| Criterion | Result | Evidence |
| --- | --- | --- |
| Migration preserves pending claims, attempts, evidence and immutable mappings | PASS | Actual old router schema and BacklogStore active claim; exceptions before ALTER and after real committed ALTER; reopen compares all original rows; added default persists and retry reads mapping/rejects changed goal. |
| Transactional DDL rollback | UNVERIFIED, not claimed | Post-ALTER interruption retains the added column. Test proves additive data preservation and routing recovery, not rollback of committed schema. |
| Mixed engine intake cannot overlap publication | PASS, bounded | Real server/router canRun fence refuses concurrent intake while held legacy publisher owns the run; real concurrent engineer writes its private lane while legacy intake is refused before mapping/provider invocation; canonical workspace remains unchanged. |
| Workspace alias exclusion and project independence | PASS | Alias startup denied by actual lock, legacy-default second host denied while writer held, separate workspace publisher succeeds, legacy-default restart preserves mapping. |
| Stored unsafe state fences downgrade | PASS for tested durable states | Independently ran existing unknown claim/publication, planner-session, candidate/role/writer effect and unknown engine-selection cases: 35/35 tests passed. These exercise actual server restart/fence with seeded durable facts. |
| Safe disable drains/reconciles and unknown reopen recovery | UNVERIFIED | New held-concurrent fixture intentionally uses forced teardown if safe close refuses. No positive cooperative close/recovery proof is asserted. Pending terminal worker source must qualify this separately. |
| New canonical publication under mixed-version restart | UNVERIFIED, not claimed | Concurrent writer is held before publication. New fixture proves preventative admission gates, not a completed mixed-version canonical publish sequence. |

First-direction legacy publication uses an injected implementation behind the
real router/fence; the opposite direction uses the real concurrent engine worker.
This is actual composition exclusion evidence, not a mocked canRunEngine counter.
Forced fixture teardown does not establish safe production release and must stay
excluded from acceptance claims. Existing stored-state tests also do not simulate
a real provider continuing unknown effects across reopen.

## Outcome 3: legacy assertions and launcher readiness repair

Verdict: APPROVE

Inspected exact diff -u for launcher.js and all six assigned legacy test files
against .agents/teamwork/legacy-suite-repair-20261028/originals/. Also inspected
Git status/diff for context; inherited changes and the active terminal worker's
source were not misclassified as this candidate's scope.

- Continuation tests retain exact thread/lane/home equality and add explicit
  empty mcpToolPins. Same-target verifier reuses the exact emitted tuple, asserts
  a second provider call and accepted unchanged target, and retains forged/stale
  target rejection. This repairs the fixture's digest mismatch, not the policy.
- MCP enumeration refusal matches current _toolPolicy fail-closed branch;
  assertion requires request_rejected and no thread/resume/turn start. The old
  permissive expectation conflicted with the current production contract.
- Skill fixture already explicitly selected actor-model. Updated exact provenance
  assertion now matches its selected ID and hash; scoped developer instructions
  and turn-input/config assertions remain intact.
- Curated role allowlists are static expected per-role arrays, checked against
  actual profiles, with lead empty list and skills disabled. Malformed fixtures
  now truly replace nonempty allowlist fields. No profile/policy was changed.
- E2E retains an in-flight durable snapshot, explicitly rejects cross-project
  reuse, releases the original server, then opens that snapshot against the same
  workspace. Interrupted row/restart pause, resumed context, one total writer
  invocation, no resend and unverified acceptance remain asserted.
- Launcher only moves readiness logging below SIGINT/SIGTERM handler install.
  No timeout increase or shutdown policy change. Real child fixture checks handler
  presence at the exact log boundary and then sends SIGTERM, requiring code zero
  and no terminating signal. Independent original preload probe reproduces exit
  42 with no signal; repaired child tests pass.

No removed verification, trivial assertions, hardcoded production answers or
error swallowing introduced to make these tests green. Existing forced teardown
in migration is expressly not a safe-close assertion.

## Independent commands and results

```
env -u NODE_TEST_CONTEXT node --test --test-reporter=tap test/concurrent-engine-comparison.test.js test/delivery-migration-qualification.test.js test/delivery-engine-router.test.js
```

15 passed, zero failed. qualification-composition-review.tap contains the actual
causal trace and accepted mandatory check output.

```
env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/a2a-role-service.test.js test/codex-app-server.test.js test/role-catalog.test.js test/writer-lanes.test.js test/launcher-startup.test.js test/e2e.test.js
```

247 passed, zero failed. qualification-legacy-review.tap.

```
env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-name-pattern='restart with legacy default fences|restart refuses unknown stored engine|legacy downgrade checks the exact durable planner|legacy downgrade fences authoritative effect' test/server-delivery-engine.test.js
```

35 passed, zero failed. qualification-downgrade-review.tap.

```
env -u NODE_TEST_CONTEXT node .agents/teamwork/legacy-suite-repair-20261028/launcher-original-probe.cjs
```

Probe exit zero; original child status 42, signal null, as expected.

Ran scoped git diff --check for launcher plus six legacy test files: passed.
Recorded nine candidate SHA-256 values in qualification-reviewed-files.json.
No broad suite, live provider, existing service, source/test mutation or Git
mutation was performed by this review. Scratch evidence is ignored and may vanish.

## Required source-sensitive final recheck

Terminal worker is changing server/engine/executor/RoleService behavior while
this checkpoint is reviewed. Before final milestone acceptance, freeze source
and rerun comparison, migration/router, selected downgrade families and relevant
E2E/launcher checks against those final inputs. This approval does not qualify
that unfinished source, safe shutdown/disable, V43 recovery-to-acceptance, live
CN15 rollout, or the pre-admitted dependent base behavior.

Non-blocking: V39 positive safe-disable drain/recovery remains pending.
Non-blocking: Pre-admitted dependent base rebasing remains outside V41 evidence.
