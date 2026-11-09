# Work package planning handoff

Status: source changes complete; focused tests not run in this continuation.

Changed `profiles/TEAM.md` with constrained work-package planning guidance and
added a lead-only summary to `createLeadRole` in `src/role-catalog.js`.
`docs/workflow-efficiency.md` documents runtime delivery, profile identity, and
the conservative limits; its measured-code-changes section is reserved for the
lead. The trial-pinned AUT-03 skill and hash were not touched. The guidance
requires following deterministic controller invalidation/recovery state,
including a required verifier refresh when bytes are unchanged. It also says
not to classify an infrastructure-only failure without evidence. Documentation
describes source-created instructions and does not claim a live runtime reload.

Runtime trace: `createLeadRole` reads and inlines `TEAM.md` into lead
instructions. `loadRoles` embeds it for profiles that request team rules and
passes the source to the profile hash callback. The effective lead/role
instructions feed team identity and role profile hashes.

Static inspection completed: source construction in `src/role-catalog.js`,
team rule insertion, and hash call sites in `src/lead-graph.js` and
`src/runtime-identity.js` were reviewed. No tests or live checks were run in
this continuation per lead instruction. Pending verification remains
`node --test test/role-catalog.test.js` and any lead-selected profile-loading
check. `git diff --check -- profiles/TEAM.md src/role-catalog.js` passed.
Preserve pre-existing dirty `docs/skill-routing-audit.md`,
`src/review-policy.js`, `test/review-policy.test.js`, and untracked audit report.
