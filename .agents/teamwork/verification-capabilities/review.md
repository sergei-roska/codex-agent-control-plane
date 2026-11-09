# A2 local milestone review

Verdict: APPROVE
Status: complete
Scope expansion: none

Re-review of the frozen digest repair: the previous blocking saturation repro is resolved. `renderRunDigest` now places the scoped owner-decision section before goal and final text; `_sessionDigest` places bounded earlier-run owner decisions before prior-run narratives. [ran] The exact previous 2000-character goal and 4000-character final text repro now retains both the decision ID and historical-scope label in the 6000-character current-run digest. The two new saturation tests check current and earlier-run decisions. `node --test test/lead-orchestrator.test.js`: 25 passed, 0 failed. `node --check src/lead-orchestrator.js` and `git diff --check` passed.

Acceptance criteria:
- Command-free local capability preflight: PASS [read/ran in initial review]. Filesystem/PATH inspection runs no project command; agent checks require `execCommand` and resolved policy. Unknown dependencies, sockets, test results, and external CI remain labeled unverified.
- Stable route and fresh candidate evidence: PASS [read/ran in initial review]. The graph test observed one route across two candidate changes and two distinct acceptance executions; candidate snapshots and review gates remain in place.
- Owner answer provenance and authority: PASS [read/ran in initial review]. Versioned records retain the question, reason, explicit option, answer, evidence, related IDs, and round. Existing grant, defer, and check-change tests passed without broadening authority.
- Bounded run/thread/session decision continuity: PASS [read/ran]. The repaired ordering preserves scoped current-run and historical decisions under saturated narratives; exact previous repro and both regressions pass.
- Docs and external CI limit: PASS [read in initial review]. The local route is documented as capability-only; external CI remains unsupported.
- Focused verification and integrity: PASS [ran/read]. Initial affected suites: 299 passed, 0 failed. Revised orchestrator suite: 25 passed, 0 failed. No required verification was removed or weakened.

Non-blocking: Native policy resolution is cached for 30 seconds; acceptance independently resolves policy again, so a short-lived projection mismatch can follow an external policy edit.
