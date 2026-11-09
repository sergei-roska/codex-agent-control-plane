# Native supersession schema repair acceptance

Verdict: APPROVE the scoped source repair. The live runner remains separately
blocked by live-runner/review.md; this verdict does not authorize live dispatch.

## Scope and integrity

Read actual git diff for concurrent-delivery-engine.js and server-delivery-engine.test.js,
separating inherited accepted changes from the new supersession delta. Independently
compared all 341 entries in the inherited final-source-manifest.json: only these
two files differ. No validator, store, authority, provider or fixture production
behavior was changed. Existing tests remain substantive; the added test creates
and settles a real failed store attempt, applies a distinct repair through real
validation/store APIs, and checks that the failed attempt is exactly unchanged.
No trivialized assertions or weakened verification found.

Scoped SHA-256 pins:
- src/concurrent-delivery-engine.js: 8e12df603f1c89ca119cfc85130fa14aa6d686a355c97c9974cf81f01010cf75
- test/server-delivery-engine.test.js: 68a3dbb7ce2a8eff9c10b59c3a6f82e45a1d5f7768962cb10878562a7fba1da6

## Criteria

1. PASS - Native representability. Read :2083-2121: ordinary create requires
   revision1/null lineage and no expectedRevision; eligible update pins exact
   current ID/revision, next revision, queued/blocked state and prior lineage;
   superseding create pins old target ID/current revision and new revision1.
   Prompt :1252 now explains all three operations and retains failed history.
2. PASS - Exact CAS, immutable tasks and scope. Eligibility excludes active and
   terminal states and host review roles; target IDs/revisions are enumerated
   from the current projection. Unchanged delivery-contracts.js remains final
   authority for identity novelty, target eligibility and domain CAS. Sanitizer
   copies lineage while retaining host candidate/check/publication controls.
3. PASS - Lineage and history. Added store regression verifies the failed task
   becomes superseded and its attempt remains byte-equivalent as an object. The
   existing validator rejects lineage erasure/change and same-ID masquerading.
   Existing supersession lineage is representable in the native update branch.
4. PASS - Independent schema evidence. Ran actual plannerOutputSchema through
   Ajv with complete native output objects: ordinary create, lineage-preserving
   update and distinct supersession all pass full schema plus validatePlanDelta.
   Stale target revision, unknown target, lineage erasure and host verifier role
   all fail schema. Same-ID misuse passes broad taskId string shape but is
   rejected by unchanged domain validator with task_revision_step_invalid; this
   is a deliberate host gate, not an authority bypass. First probe hit a Node
   stdin lexical self binding collision; rerun with renamed local passed.
5. PASS - Independent decisive regressions. Ran:
   node --test --test-name-pattern='planner sends a strict usable schema|planner schema represents a distinct repair superseding a failed task' test/server-delivery-engine.test.js
   Result: 2 passed,0 failed.
   node --test test/delivery-contracts.test.js test/concurrent-recovery-acceptance.test.js
   Result: 17 passed,0 failed, including real composed offline V43 recovery,
   distinct repair, verifier, host checks, steering and durable acceptance.

## Limits and next action

These are native structured-output representability and offline integration
proofs, not a new live provider recovery result. Remote schema acceptance still
requires genuine dispatch evidence; the local strict-schema regression passed.
Worker full affected/planner results are corroborating reports, not substituted
for the decisive checks run here. Root owns the frozen broad suite and source
manifest verification before live dispatch. No production service or provider
turn was operated; only disposable test runtimes were used by requested tests.

Status: complete
Scope expansion: none
