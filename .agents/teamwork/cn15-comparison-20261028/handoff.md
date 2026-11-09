# CN15 V41 comparison implementation

Status: complete, pending independent review/challenge by lead.

Product file: test/concurrent-engine-comparison.test.js (new; no existing files edited).
Frozen SHA-256: 2206b648b63feb2fddefc366f7543ec9ec3b6f754b70ab9a11451e16227d6e61.
No Git mutation, service changes, provider calls, settings/account changes, or installs.

The fixture runs real LeadOrchestrator with registerRoleAgents over local HTTP and
real ConcurrentDeliveryEngine. Both use disposable Git workspaces/SQLite, cooperative
private lanes, identical frozen logical fast/slow/dependent workload, actual worker
payload field equality, and the same owner Node product check. Fake provider turns
have real disposable process identities and stop before terminal return; native
quiescence/publication/acceptance/review paths remain active.

Both paths start fast+slow concurrently. One shared barrier releases fast only after
all four initial provider turns start. Both slow turns wait on the same release.
After concurrent dependent output is authoritatively published and legacy fast is
integrated, the fixture verifies both slow turns remain active and legacy dependent
has not started, then releases both slow turns. The legacy wave finishes before its
dependent dispatch. Causal trace asserts all these relations and both peak worker
counts equal 2. This proves dependency progress/new overlap, not increased peak
capacity or measured wall-time/provider speedup.

Both results must complete with authoritative accepted disposition. The test checks
legacy current-target verifier receipt, concurrent durable accepted finalization and
candidate pins/mandatory check pins. All accepted product files/contents, verifier
check stdout, normalized authoritative check outputs, and required-check contracts
must match. Timeout/polling only bounds liveness; scheduling assertions use barriers
and event sequence, with no duration ratios.

API translations and limits:
- Legacy's verifier role metadata must be workspace-write to accept explicit routine
  review metadata; concurrent verifier uses its scoped read-only candidate route.
  Both fake providers only read and run the same mandatory check.
- Both adapters admit dependent after fast publishes: legacy in the next dispatch;
  concurrent in the next planner delta, preserving the frozen requires_output edge.
  This does not qualify pre-admitted successors rebasing onto predecessor output.
- Initial full-DAG experiment put all three tasks plus edge in delta 1. The dependent
  started after fast but retained candidate-base as baseCandidateId, so its provider
  could not read fast.txt; it remained running at the bounded observation deadline.
  Evidence: initial-dag-base-pin.log. Reproduce by changing plannedTasks to
  `plannerTurns === 1 ? tasks : []` in a disposable copy of the fixture. Leave the
  dependencies projection unchanged. The passing supported translation mirrors the
  existing overlapping-private-lanes engine test. No source fix was attempted.
- This is offline qualification only; no live speed/cost/quality/rollout claim.

Verification (final inputs):
- `node --test --test-reporter=tap test/concurrent-engine-comparison.test.js`
  PASS 1, FAIL 0. Evidence: focused.log (causal trace and accepted check stdout).
- `node --test --test-reporter=tap --test-name-pattern='overlapping private engineer lanes unlock dependent work|without parallelWriters waved writers still run one at a time|a not_integrated COMPLETED writer of wave 1 settles and wave 2 runs' test/concurrent-delivery-engine.test.js test/lead-graph.test.js`
  PASS 3, FAIL 0. Evidence: related.log.
- `node --check test/concurrent-engine-comparison.test.js`: PASS.
- `rg -n '[^\x00-\x7F]' test/concurrent-engine-comparison.test.js`: no matches.

Temporary Git/SQLite fixture directories are deleted by successful tests. Logs in
this ignored teamwork directory remain local evidence and may disappear.
Next: lead assigns independent review/challenge; root owns durable docs/Git.

Status: complete
Scope expansion: none
