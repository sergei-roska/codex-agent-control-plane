# Planner revision guidance delta review

Verdict: APPROVE. Supersession wording correction is verified. Native runtime acceptance remains UNVERIFIED.

Read actual diff: only planner input guidance, taskChange/expectedRevision schema descriptions and existing schema regression assertions change. anyOf branches, required fields and integer type remain unchanged. No validator, recovery, request authorization or quarantine gate changes. New assertions exercise validator acceptance of a new revision-1 task without expectedRevision and rejection of expectedRevision:0, preserving the existing validation contract.

Ran: node --test --test-name-pattern='planner sends a strict usable schema' test/server-delivery-engine.test.js: 1 pass, zero fail. Evidence: planner-guidance-focused.tap. git diff --check passes. No provider call or full suite rerun.

Re-review, read only: all three guidance strings now distinguish a newly added task without supersession from a newly added task superseding an existing task. The latter explicitly uses the existing/superseded task revision of at least 1, matching src/delivery-contracts.js:341-351. Matching regex assertions were updated; no assertion or validation gate was removed. Current strict plannerTask still does not expose supersedesTaskId, and this prose correction does not broaden that schema. Prior non-blocking finding is resolved. No tests were repeated for this prose-only delta; prior targeted verification applies to unchanged schema/validator behavior. Root owns final suite evidence.

The suggested metadata describes current validation; it does not establish that the next native model output will conform. Unknown historical planner turn remains outside this review and must not be replayed through a gate change.

Status: complete for narrow metadata review.
Scope expansion: none
