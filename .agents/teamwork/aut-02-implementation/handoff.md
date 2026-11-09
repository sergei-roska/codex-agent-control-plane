# AUT-02 implementation handoff
Status: active, R0 baseline frozen, R1 next.
User corrected previous scope: implementation is requested.
Read brief.md and docs/aut-02-fresh-review-runbook.md.
Baseline source/tests copied to artifacts/autonomy/aut-02/baseline/.
39 accepted artifact hashes verified, four named leaf controls pass.
No runtime edits yet. Need source/config hash manifest, qualification probes,
R2 mechanism decision, implementation, full verification, independent reviews.

R1/R2 milestones:
- Existing baseline four focused files: 310 leaf tests pass, no skips/failures;
  retained docs/evidence/aut-02/existing-baseline.tap.
- Direct identical stale-verifier probe fails archived baseline (3 App Server
  calls and accepted stale continuation vs required 2 calls). Replay utility
  overlays final tests onto exact baseline archive; embedded manifest hashes.
- Graph automatic-selection baseline fails: only initial verifier/auditor pair,
  no fresh selection after stale preflight. Graph baseline TAP retained.
- R2 deterministic graph selection approved with independent design constraints.
  Two-generation cap per checkpoint; versioned checkpoint JSON; no DB migration.
- Direct service origin enforcement implemented and independently APPROVED after
  mixed-corrupt/saturated-history fixes. Final source hash and review retained
  docs/evidence/aut-02/direct-review.md. Assigned suites: 115 pass, 0 fail/skip.
- Graph worker owns src/lead-graph.js and test/lead-graph.test.js. Core automatic
  fresh pair, verifier-only, skill pins and recovery usage/restart controls pass
  per worker; full graph regression and remaining mandatory matrix pending.
- Direct baseline/final sanitized traces retained under docs/evidence/aut-02/traces/.
- Active workers/review notes: aut02_graph/handoff.md, aut02_direct/handoff.md,
  aut02_design/handoff.md. Root owns docs/evidence/Git; no commit/live actions.
Next: finish graph Q05/Q04/Q09/Q11/Q14 probes, independent verifier/challenger/
auditor, full integration, same-input baseline/final comparison and R5 acceptance.
Do not mark complete based on direct repair or scripted graph controls alone.

Direct partial APPROVE superseded: challenger proved valid B origin combined
with A's stale thread runs A context and accepts B receipt. Repro/report under
aut02_direct_challenge/. Durable report and design retained in docs/evidence.
Direct worker now owns same-attempt continuation tuple binding fix, with v1
staging digest evidence before publication and legacy fail-closed behavior.
New direct review/challenger rerun mandatory; do not reuse earlier approval as
final acceptance. All-null fresh fallback retains target origin checks.

Direct tuple binding needs final publication-order repair before acceptance:
lead read found initial event emission before lane completion, while published
continuationMetadata can change laneId after integration. Worker instructed to
cache final emitted tuple after settlement and test lane disappearance/resume.
Earlier direct tuple source hashes remain intermediate, not accepted final.
Challenger regression passes on intermediate code but must bind final hashes.
Original stale-target baseline retained as direct-stale-baseline-original.tap;
current direct-baseline.tap may fail earlier in extended tuple regression.

Direct final freeze now accepted independently:
service SHA256 e3ca7ce3a37e43f6950fe47b1915c2a52a2bfe5ea9b8f343b2ebf044160104cf;
test SHA256 bbfbc584054d938599840e6683e21e34d9dddeca4b3fc343f2c4ea1a2b607bfd.
Critic APPROVE: docs/evidence/aut-02/direct-tuple-review.md. Challenger HOLDS:
docs/evidence/aut-02/challenge/regression-report.md; same/cross-run forged
threads rejected, no extra App Server calls, 3 named controls pass.
Graph remains active: original receipt invalidation control restored and passes;
full graph suite repeat plus Q08/Q09/Q11/Q14 probes and graph reviews pending.
Critic identified trusted unstable verifier test-write receipt incorrectly
scheduling redundant recovery; graph worker fixing with post-write accepted gate.

Current direct freeze after Q06 classification:
service 95281c89bdab68f0aae8e0375b2f72930d9e4fa3868670f66600056144717234;
test ab5408a7be89c86bc42c6e70be2e7ef171e3c9255c6ff47da5eb349760076089.
Known valid binding mismatch = stale; missing/corrupt/ambiguous/unavailable/
unknown-version binding = unknown (not automatic retry authorization).
Challenger HOLDS at these hashes, four controls pass; durable report updated.
Need final independent verifier/auditor on final graph+direct, not older e3ca
partial approval. Direct worker idle, no more source changes planned.

Graph active: full suite 204/204 before latest added cases. Added restart before
fresh submission, generation exhaustion, accepted verifier-test-write controls.
Lead rejected expanding ordinary accepted test-write into automatic auditor:
use existing accepted receipt, and test write inside actual recovery marker
path; preserve ordinary lead-managed behavior. SafeRelativePath and duplicate
checkpoint validation added after critic findings. blockedReason is durable and
prompt-visible. Q08 nonempty prerequisites, Q11 boundaries, Q06 real-service
unknown binding and graph trace exports still being completed.
Critic aut02_design currently probing legacy and baseline-reader rollback using
disposable state. No final graph source approval yet. Remaining full R4/R5 work
is unchanged; no completion claim, commit or live lifecycle actions.
User asked subagent models: answered Luna high workers, Sol medium critic and
challenger; no Astra. This did not replace implementation objective.
