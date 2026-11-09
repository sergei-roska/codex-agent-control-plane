# Legacy qualification repair

Changed launcher.js and six authorized legacy tests. Original snapshots under originals/. Launcher installs SIGINT/SIGTERM handlers before its ready log; the existing real child test checks listener presence at the exact log and sends SIGTERM. The scratch launcher-original-probe.cjs loads the preserved original without replacing shared source: exit 42, no signal, establishing the original readiness-order failure.

Review/writer continuation assertions retain exact thread/lane/home equality and include mcpToolPins: []. Same-target verifier failure was diagnosed before editing: original emitted tuple includes the empty pins while manually reconstructed request omitted them; the digest mismatch caused review_origin_stale before provider. Fixture now reuses the exact emitted tuple, retains forged and changed-target rejection and confirms same-target provider call. Diagnostic log: verifier-diagnosis.log.

Enumeration failure asserts request_rejected and no thread or turn; selected skill matches actor-model and exact hash. Role tests assert static curated per-role lists and genuinely malformed fields. E2E retains original in-flight SQLite snapshot, verifies cross-project refusal, closes original server and resumes against the same workspace with no resend. Eleven reported full-suite entries include the E2E parent and its failing subtest; no assertions on engine identity, no-resend or policy were weakened.

Commands/results:
- env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/a2a-role-service.test.js test/codex-app-server.test.js test/role-catalog.test.js test/writer-lanes.test.js test/launcher-startup.test.js: 238 pass, 0 fail (affected.tap).
- env -u NODE_TEST_CONTEXT node --test test/e2e.test.js: 9 pass, 0 fail (e2e.tap).
- env -u NODE_TEST_CONTEXT node .agents/teamwork/legacy-suite-repair-20261028/launcher-original-probe.cjs: exit 0, original child status 42 as expected.
- git diff --check -- launcher.js test/launcher-startup.test.js test/a2a-role-service.test.js test/codex-app-server.test.js test/role-catalog.test.js test/writer-lanes.test.js test/e2e.test.js: pass.

No other source modified; no full suite run. Independent review and frozen checks remain. Local evidence is ignored and may disappear.
