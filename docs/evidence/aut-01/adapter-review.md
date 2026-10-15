# AUT-01 P1.3 assignment adapter technical review

Verdict: APPROVE
Status: complete
Scope expansion: none

Reviewed frozen `src/spec-assignment-adapter.js` SHA-256
`9a02d34d28a8fe9b19fdd4c82771aeb04ffd552cb7c97653dc15ed5239d194e3`
and `test/spec-assignment-adapter.test.js` SHA-256
`b0c2a8ff4f650e7df529c31fcba54f91dff4b15f2818c827b0af8936e477d588`.
Prior P1.1 context/schema and P1.2 analyzer approvals were reused. This review
does not qualify the later CLI or final report.

PASS [read/ran]: The adapter recompiles every map task and validates each
engineer, verifier, and gated auditor proposal against both exported harness
boundaries, `validateDecision` and `checkSpecialistRequest`, on defensive
copies. A bad sibling task leaves the feature `ok=false` while all task
proposals remain visible. Missing fields, bad references, denied paths, lowered
risk, malformed tasks, and oversized extracted source text produce findings or
failed proposals without truncating constraints.

PASS [read/ran]: Assignments carry explicit objective, source-derived
requirements/acceptance/evidence with pinned source identity, catalog-rendered
planned checks, bounded stop conditions, empty skills, null wave/continuation/
repair, and the complete six-field review context. Engineer `allowedFiles` is
the task product scope; verifier scope is the selected checks' independently
allowed paths; auditor scope is empty. Review paths are the sorted union and
the same context is copied across the checkpoint sequence. The auditor's check
strings explicitly say verifier execution evidence is pending.

PASS [read/ran]: Risk tags are a union of linked requirements, implementation
path rules, selected verifier-scope rules, and additional task tags, with
documented precedence. Routine gets engineer then verifier; gated kinds add
auditor in a later execution group. Future evidence dependencies remain
unavailable. `implementationAcceptance` is always `not_evaluated`, and the
offline assumptions require live-state validation before dispatch.

`node --test --test-isolation=none test/spec-context.test.js
test/spec-analyzer.test.js test/spec-assignment-adapter.test.js`: 27 pass,
0 fail. `node --check src/spec-assignment-adapter.js`: pass. No reviewed
source, tests, fixtures, or Git state were changed by this review.

Non-blocking integration obligation: current `loadRoles()` uses default harness
profiles, appropriate for this checkpoint. P1.4 explicit `--profiles` must
reach adapter role loading and pin actual loaded profile and TEAM bytes in the
report manifest. The final report must also state the typed planning scope
versus the current harness string-prefix write-scope limitation.
