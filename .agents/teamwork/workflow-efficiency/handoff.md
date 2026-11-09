# Workflow efficiency handoff

Status: source implementation complete; independent static review APPROVE.
User authorized committing the task changes. Committed by engine worker as
f590a666f7832c39fb605684a60bc6050a794fd5, "Reduce repeated review and planning work
in Harness". Lead inspected commit contents and remaining status: exactly six
task files committed, two preserved unrelated/audit files remain outside it.
Read PROJECT.md for scope and baseline.
Implementation workers used gpt-6-luna; critic used gpt-6-sol medium.
Read delegate skill and lead/development access policies. No live action.
Evidence baseline: harness-performance-audit-2026-10-16.md.
Verified existing recovery-auditor handoff fix in baseline; do not rewrite it
without a demonstrated remaining issue. review-policy accepts completed
verifier reports with passing checks even when summary explicitly says fail.
Shared-checkpoint repair currently clears all listed receipts at dispatch;
review targets already bind scoped bytes, run, goal, check pins and context.
Negative-verdict guard is implemented. Earlier worker evidence reports
`node --test test/review-policy.test.js`: 8 passed, 0 failed. Current continuation
does not add/run tests under developer constraints; workers were notified.
Planning guidance and engine changes complete. Persistent receipt floor and
pending/unchanged/fresh_required repair guard preserve history while blocking
unsafe reuse. Stored outcomes are revalidated; exact target/context plus trusted
attested settlement are required. Normal later-wave auditor handoff is enabled
without widening recovery exceptions. Both prompt forms share one target
projection and give bounded deterministic next steps. Full behavior and limits:
docs/workflow-efficiency.md. Detailed worker evidence: engine/handoff.md and
planning/handoff.md. Independent review: review/handoff.md, APPROVE including
the final production delta correction (producer omits changedPathCount).

Review corrections: enforce floor in both settled phases; preserve invalidation
through later repairs; permit fresh receipts after later target changes; block
pending repair writers; retain specific recovery bypass reasons; handle absent
entry in capped recovery catalog; avoid duplicate target hashing; make missing
serviceReview failure null-safe; accept complete production delta without
explicit count while rejecting truncated counts. No broad tests were added/run.
Worker `node --check src/lead-graph.js` and scoped diff check exited 0. Lead final
`git diff --check` exited 0. Runtime graph/profile verification remains pending.
Final reviewed src/lead-graph.js SHA256:
62dbf606b393ed21a37011fedf707acd8b27763e952ab8e2321115e03c717a4b.
Source-traced avoided dispatch: accepted verifier plus eligible unchanged repair
can proceed to auditor without a duplicate verifier. Not executed or timed.

No live action, restart, deployment, target-project edit, or API benchmark.
Commit scope: profiles/TEAM.md, src/lead-graph.js, src/review-policy.js,
src/role-catalog.js, test/review-policy.test.js, docs/workflow-efficiency.md.
Leave docs/skill-routing-audit.md and harness-performance-audit-2026-10-16.md
outside this commit. Initial index was empty. No further work is active.
Runtime validation and loading remain future steps; no restart or deployment
was authorized. Worker removed one extra EOF blank line from the documentation
before commit; no behavioral edits followed static approval.
