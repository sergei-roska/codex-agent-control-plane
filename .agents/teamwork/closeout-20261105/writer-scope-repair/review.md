# Writable-role scope schema repair review

Verdict: APPROVE the bounded source delta and matched intake clarification.
Root full-suite/source freeze remains a separate prerequisite to dispatch.

Read actual git diff against committed42af839: only concurrent-delivery-engine.js
and server-delivery-engine.test.js changed. Production delta is capability-derived
planner role groups, matching policy guidance, and nested role/scope variants in
create/update/supersede. No specialist guard, executor, recovery, held claim,
publication authority, check/candidate binding or CAS validator was modified.

Frozen SHA256:
- engine: 2c5d35f0d7c5653a263657f01cfb2349cf2f334470b41823ecab0fd02afffa8a
- test: 14f731ca1bf323f2935ad1f7212e1066056d4a32d72b6fdbe4793f567e308930

PASS - Read role grouping at :2056-2060 and roleScopedTask at :2091-2101:
roleFor(role).sandbox === read-only selects the read-only group; all remaining
planner roles require minItems1 productWritePaths. This agrees with the unchanged
checkSpecialistRequest writer_scope_missing guard at contracts.js:658-662.
Read-only tasks retain valid empty and nonempty scopes. Host-controlled roles
remain excluded; no trial identifiers or paths are hardcoded in production.

PASS - All ordinary create, exact-revision update and superseding-create branches
use the same role-dependent task shape. Prior target/revision, immutable task,
lineage and publication restrictions remain unchanged in the actual diff.
Strict objects retain additionalProperties:false and all declared properties
required. Extending the schema-test keyword allowlist for minItems adds a real
positive-integer assertion; it does not weaken existing checks.

PASS - Ran actual focused server regressions with independent preload probe
schema-probe.cjs in this directory. The probe wraps actual plannerOutputSchema
only in the disposable test process and validates every emitted role/task variant
with Ajv, rather than merely inspecting minItems presence. Eighteen variants
checked across create/update/supersede: empty writer scope rejected, nonempty
writer scope accepted, empty/nonempty read-only scope accepted. Both regression
tests passed,0 failed. Existing test also invokes actual checkSpecialistRequest
and store supersession/history checks. Ran git diff --check: clean.
Command:
node --require ./.agents/teamwork/closeout-20261105/writer-scope-repair/schema-probe.cjs --test --test-name-pattern='planner sends a strict usable schema|planner schema represents a distinct repair superseding a failed task' test/server-delivery-engine.test.js

PASS - Independently hashed and diffed archived/current collectors. Archive SHA
07a10b02b703776036ca0ae7de4fa1e84eb87f9fc5d7d67b972e9e64314a86c6
matches accepted first-GO collector. Only two goal strings differ: explicit
read-only failed probe, investigation from actual failure evidence, and normal
distinct supersession without requiring successful failed-probe output. Checks,
fixture, model settings and collector logic are unchanged. Both future arms use
the same revised literal input. This is an openly controlled diagnostic failure,
not a claimed natural reliability result. Earlier incomplete arm stays incomplete.

No live/provider calls, production service actions, DB/Git mutations or source
edits performed. This acceptance proves local schema/contract agreement; genuine
remote schema acceptance, recovery history, ownership release and final scenario
acceptance still require actual retained evidence. The earlier held runtime is
not authorized for replay or recovery by this review.

Status: complete
Scope expansion: none
