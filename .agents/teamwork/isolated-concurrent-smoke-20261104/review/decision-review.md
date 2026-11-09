# Scoped native verifier context decision

Verdict: APPROVE the narrow design with the report-contract details below. Implementation and successful native rerun remain UNVERIFIED.

Read: scopedExecutionDetails already supplies host-bound candidatePath, candidateId, inputManifestDigest and scratchRoot. CodexAppServer validates capability, scratch cwd, selected policy and candidate integrity before thread/turn start, but _run developerInstructions never expose the bound candidate root. Concurrent #requestFor names only a generic prepared workspace. DeliveryRoleService runs scoped turns from scratchRoot. The retained native result is incomplete, with writer succeeded and review failed; it is not native task acceptance.

The context should be appended as trusted developer instructions only for validated scoped executions. Preserve the original specialist request bytes and digest. Include a defensive copy of task.readScope.paths (recommended as required for this fix), since the current request omits the actual declared review scope. Copy/freeze nested data rather than exposing mutable capability state. Serialize path values as data to avoid ambiguous instruction formatting.

Required report instructions: inspect the named frozen candidate root read-only; resolve declared relative scope paths under it; report filesInspected as candidate-relative paths. Only scratchRoot permits writes. Do not inspect or modify the shared workspace or publish. Report actual completed static checks as checks and an explicit verdict. The host runs pinned acceptance checks later and records authoritative results; never claim those checks ran or passed before that happens.

Reason: src/review-policy.js:169-181 rejects absolute filesInspected; :195-197 rejects empty checks and any not_run result. DeliveryRoleService:864-869 rejects invalid static reports before :939 calls the host check-evidence adapter. Merely providing an absolute root can leave the current failure unresolved if the model reports absolute paths or repeats deferred pinned checks as not_run. Explain both conventions without weakening validation.

Safety: retain existing request/capability identity, settings/policy selection, drift checks, readonly publication denial and host evidence requirements. This is a context repair, not additional OS confinement: full-access remains full-access and prompt instructions do not create a security sandbox. Do not change permissions, tools, roots or receipt criteria.

Validation required after implementation: mock native transport captures scoped thread instructions and unchanged request text/digest; unscoped turns receive no scoped context; context includes trusted scope and correct roots; capability/drift failures still prevent dispatch. Rerun bounded native smoke and verify actual inspected evidence, host checks, durable completion and safe close/restart. No product edits or provider calls were made by this review.

Status: complete for decision; runtime acceptance pending.
Scope expansion: none
