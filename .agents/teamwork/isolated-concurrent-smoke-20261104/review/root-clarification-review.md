# Scoped candidate-root clarification delta

Verdict: APPROVE. Prior implementation review remains applicable outside this narrow prompt/assertion delta. Native runtime acceptance remains UNVERIFIED.

Read: scopedVerifierInstructions now explicitly distinguishes intentionally empty scratch cwd from the separate frozen candidate root, requires candidate-root workdir or absolute candidate paths for inspection, and prohibits missing-file conclusions based on scratch. Temporary writes are explicitly scratch-only. Candidate remains read-only and declared read scope remains binding. This resolves the previously noted clarity gap without changing any path, tool, selected permission or capability gate.

Read: checks instructions require genuine personally observed static/inspection checks, observed result/detail and a completed passing check; inability to inspect or complete it must be reported as a blocker/failure. Only deferred host-owned acceptance checks are omitted; no instruction permits inventing passes or concealing failed review checks. This preserves existing nonempty/all-passed static report validation and separate host check receipts.

Read: exact turn input construction, policy selection, request digest and receipt validation remain unchanged. Tests retain exact input and scratch-only policy assertions and now assert every new instruction. src/delivery-role-capabilities.js remains at the previously approved digest 809e3da3273bcd5380a7cfb0cfdb8ffd150cf0084d209883e2ae6067a08dea90.

Ran: node --test --test-name-pattern='scoped verifier run uses only' test/delivery-verifier-integration.test.js: 1 pass, zero fail. Evidence: root-clarification-focused.tap. git diff --check passes. No provider call or broad suite rerun.

Reviewed digests:
- src/codex-app-server.js: 8afe15a782c615a94cd155810fbd6a86113b3a58a8f81e370a3c06741138cdbe
- test/delivery-verifier-integration.test.js: a5d4781c40b6990df8421b0f7fbd84dfc97bfe260ac27a7072d3fa2660845e39

Status: complete for narrow source delta; fresh native smoke pending.
Scope expansion: none
