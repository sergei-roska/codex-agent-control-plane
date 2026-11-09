# A2 local challenger result

Verdict: HOLDS
Status: complete
Scope expansion: none

Probe: `.agents/teamwork/verification-capabilities/probes/challenge-a2.js`.
Command: `node .agents/teamwork/verification-capabilities/probes/challenge-a2.js`.
Result: PASS. An owner check with an executable marker was reported available without executing it. Candidate content changed without changing route identity. Removing the executable immediately changed capability to unavailable. Agent preflight never called `execCommand`; an aborted pending policy read returned unknown, a late policy result caused no command execution, a thrown policy read returned unknown, and a never-settling policy read returned unknown after about two seconds. All dependencies and test outcomes remained unverified.

Integration command: `node --test --test-name-pattern='configured local route survives|deferred critical checkpoint|another owner answer, or a defer|owner grant at the recovery generation limit|session digest prioritizes' test/lead-graph.test.js test/lead-orchestrator.test.js`.
Result after the worker's assertion-case repair: 5 passed, 0 failed. These fake-provider/SQLite cases exercise two candidate changes with two fresh acceptance executions, deferred checkpoint boundaries, explicit owner grant provenance over restart, and current/historical decision retention under saturated digest narratives. No live application or model was started.

During the first integration run, the new owner-grant test failed because `/prior owner decisions/` was case-sensitive while the correct digest heading starts with `Prior`. The root and worker were notified; the worker changed the assertion to `/prior owner decisions/i`, preserving the substantive scope and context checks. The five focused cases then passed. This was a test assertion defect, not an observed product behavior failure.

Limits: Policy projection may be cached for 30 seconds by design; acceptance independently resolves policy again. These probes did not exercise a real App Server, external CI, or a live target project. The root owns the full suite and Git.
