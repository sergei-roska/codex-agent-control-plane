# Artifact scope and snapshot schema batch review

Verdict: APPROVE source batch. Native target retry/acceptance remains unverified.

Read actual source/test diff. DeliveryRoleService.authorizeArtifactBinding compares sorted copies of record.writePaths and binding.declaredWritePaths. It preserves exact multiplicity, does not mutate contract arrays, and retains identity/fencing/lane/base candidate/current-control checks. DeliveryOutputArtifacts.bind separately validates path syntax and rejects duplicate input before normalization, then host authorization enforces full exact scope. Added composed TaskExecutor/role/artifact regression reaches captured publication with three originally unsorted paths and rejects subset, additional and duplicate declarations. This fixes ordering without broadening authority.

Read snapshot schema: production call uses the same turn.prompt.projection supplied in planner input. Add branch has revision enum [1] and no expectedRevision property. Eligible mutable task updates are generated one branch per task with coupled exact taskId/current expectedRevision/next revision and queued-or-blocked state. Active/terminal task states and host review roles are excluded. Empty projection produces one valid add branch, not empty enums/anyOf. No supersession feature was added. Validator, CAS application, persistent provider turn and recovery gates remain unchanged. Existing IDs can still be emitted via the generic add branch; unchanged validation correctly rejects that. Schema guidance is not a guarantee of admissible output.

Ran decisive independent checks:
- node --test --test-name-pattern='unsorted multi-path task' test/delivery-role-service.test.js: 1 pass, zero fail. Evidence: scope-binding-focused.tap.
- node --test --test-name-pattern='planner sends a strict usable schema' test/server-delivery-engine.test.js: 1 pass, zero fail. Evidence: snapshot-schema-focused.tap. Covers strict schema structure, empty snapshot, two differently revisioned mutable tasks, immutable/host exclusions and existing validator acceptance/rejection.
- git diff --check: pass.

Read root full-scope-schema.tap: 2096 pass, zero fail, one skip. No broad suite was repeated by this review. No removed/trivialized assertions, hardcoded product result or acceptance/recovery bypass found. No provider call, runtime DB access or frozen source edit performed.

Non-blocking limitation: repeated per-task schema branches grow with the eligible task inventory. This bounded trial has a small task inventory; provider schema size/capacity at large backlog size is not accepted by these focused checks.

Status: complete for source batch.
Scope expansion: none
