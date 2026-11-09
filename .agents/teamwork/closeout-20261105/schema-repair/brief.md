# Native planner supersession schema repair
Read active junior_worker TOML developer_instructions and development-access.md.
Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Root owns Git.
Allowed source edits: src/concurrent-delivery-engine.js and
 test/server-delivery-engine.test.js ONLY. Preserve all inherited accepted dirty
changes. Write evidence/brief/handoff in this directory. No model tasks, runtime
restarts, Git mutations, validator/gate edits or other source/test changes.

Root and independent critic demonstrated the schema gap, not a model failure:
../qualification/schema-supersession-before.json and design-review.md.
Native strict planner schema forbids supersedesTaskId and expectedRevision for
new IDs, but validatePlanDelta src/delivery-contracts.js341-350 legitimately
requires both to replace an eligible task with a distinct new task. The offline
V43 test uses this supported domain path; native cannot express it. Prompt also
currently says all new task IDs omit expectedRevision. Fix representability,
not validator semantics. Critic APPROVE required before live dispatch.

Implement create/update/supersede output branches matching existing domain CAS
rules. Supersession uses new task ID, revision1, exact eligible superseded task
ID and its current revision. Eligibility excludes running/settling/claimed,
succeeded/canceled/superseded, host review/verifier/auditor/coordinator; preserve
existing task lineage exactly on updates. Ordinary creates cannot set lineage
or expectedRevision. Handle nullable required fields correctly for the strict
native JSON schema; do not grant publication authority. Prompt distinguishes all
three cases. Do not hardcode trial tasks/IDs or acceptance results.

Add meaningful regression that fails before repair: current generated schema
can represent a legitimate supersession, normal validatePlanDelta/store apply
retires failed task without changing original failed-attempt history. Include
stale revision, missing/active/terminal/foreign target, lineage mutation and
ordinary create revision guards where affected; reuse existing domain tests
rather than duplicate every case. Existing add/update branch tests must remain
meaningful under new branches. Independently confirm strict output-schema shape.

Run focused test first and affected suite test/server-delivery-engine.test.js,
test/delivery-contracts.test.js,test/concurrent-recovery-acceptance.test.js,
test/lead-planner.test.js. Root owns broad full suite and review. Report exact
commands/results, original failing regression evidence and concise handoff.
Stop on accepted scoped fix or demonstrated blocker; do not expand.
