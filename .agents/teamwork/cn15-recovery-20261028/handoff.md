# V43 integrated recovery qualification

Status: implemented and focused checks pass; independent review/challenge pending.

Owned product file: test/concurrent-recovery-acceptance.test.js (new only).
Frozen SHA-256: a467ec0a8d70c8f924ca2593fb6df89c8e4bc4079292c95dd17c3650ea5dd137.
V41 file remains unchanged at SHA-256
2206b648b63feb2fddefc366f7543ec9ec3b6f754b70ab9a11451e16227d6e61.
No existing files/source edits, Git mutation, installs, live provider calls, or
existing service/account/settings changes were made by this worker.

Actual path: real startServer/A2A intake and routing -> failed no-write engineer ->
read-only explorer investigation -> distinct superseding engineer repair -> actual
candidate publication -> independent scoped verifier -> authoritative mandatory
checks/evidence -> current-candidate review receipt -> durable accepted finalization.
Disposable Git/SQLite/process/server fixtures; successful cleanup removes them.

Retained assertions:
- One failed attempt, known terminal/quiescent no-publication report. Full failed
  attempt/contract and role execution/report/evidence remain unchanged afterward.
- Read-only investigation consumes retained failed-execution evidence and inspects
  the broken source. New repair supersedes original task with expectedRevision;
  distinct attempt/provider context, no obsolete original resend.
- While investigation is held at a native promise barrier: authenticated status,
  invalid-token GET/POST 401, stale-revision steer 409, valid durable received/applied
  steering, and unchanged goal/control/plan revisions. Two idle controller cycles
  cause no additional model calls; no planner/provider thread overlaps.
- No owner correction, owner decision response, or weakened acceptance contract.
- Accepted product bytes and untouched mandatory check script are verified. Real
  mandatory check output is read through its durable stdout evidence. Verifier proof
  string evidence IDs resolve to the correct stored stdout/stderr check artifacts.
- Final revisions are goal 1, control 1, plan 4: initial, investigation, repair,
  automatic owner review. Independent current-candidate receipt/finalization pins
  reference the repaired candidate and exact required check.

Source dependency found and resolved by source owner:
Composed evidenceStore supplies stdoutEvidence/stderrEvidence as evidence-ref/v1
objects. Engine #checkEvidenceFor initially spread these into evidenceRefs, while
role service requires string references. Verifier check passed but settlement
parked with delivery_role_check_evidence_invalid. Terminal senior worker normalized
supported objects to validated durable string IDs, preserving strict proof/digest
validation. V43 passes with that source repair; this worker did not edit source.
Evidence: evidence-ref-blocker.json and evidence-ref-blocker-proof.json (actual
pre-fix proof copied from disposable SQLite). The old temporary DB may disappear.
Engine source hash observed after passing check:
afbdf9bdf0bea1001647c98b99e7e978eb60bc2f58ea5b76163cd6bd15c71280.

Exact verification:
- `node --test --test-reporter=tap test/concurrent-recovery-acceptance.test.js`
  PASS 1, FAIL 0 on final frozen fixture. Evidence: focused.log.
- `node --test --test-reporter=tap --test-name-pattern='failed work prompts one bounded internal investigation turn without owner reply or model fallback' test/project-delivery-controller.test.js`
  PASS 1, FAIL 0. Evidence: related-controller.log. Its controller/test inputs were
  unchanged by the engine evidence-reference repair.
- `node --check test/concurrent-recovery-acceptance.test.js`: PASS.
- `rg -n '[^\x00-\x7F]' test/concurrent-recovery-acceptance.test.js`: no matches.

Limits: offline scripted providers and one bounded known no-effect failure. This
proves host recovery composition and authoritative acceptance, not model diagnosis
quality, live provider speed/cost, arbitrary uncertain-effect recovery, or rollout.
No broad suites run. Source normalization and this fixture still require independent
review/challenge. Next action belongs to lead; root owns durable docs and Git.

Status: complete
Scope expansion: none
