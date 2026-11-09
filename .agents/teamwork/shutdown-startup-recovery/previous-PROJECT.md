# Completed: restart engine classification

Fixed false other-engine busy: startup fallback classified all historical Lead tasks as legacy, including mapped concurrent tasks. INPUT_REQUIRED concurrent task cdb27a0c caused busy on every new intake after restart. Validated durable concurrent mappings now exclude those IDs from legacy fallback; genuine mapped/unmapped legacy tasks and all other fences stay intact.

Scoped delta: src/server.js and test/server-delivery-engine.test.js relative to saved inherited dirty baseline. Prior default-home fix remains. Preserve all other uncommitted work.
Acceptance: independent APPROVE; 67 full server tests, 14 reviewer focused server checks and 11 router tests passed. Exact production code on real read-only DB: before busy, fixed true, task rows unchanged. Regression exercises restart and first HTTP request with stub engine; no real model/UI execution claimed. Read restart-engine-classification/handoff.md, review.md and evidence/exact-startup-preflight.json.

Launcher and project server remain stopped at explicit owner request. No live service starts, model tasks, SQLite edits, history cleanup, commits or pushes. Next owner startup loads reviewed server.js SHA256 1c5d12d37661b1e882c96c93691719a0647fa2bb0e9b4818a0a0e9e39d3bf5c6. No workers or test services intentionally left active. No implementation pending. Prior context: restart-engine-classification/previous-PROJECT.md and lead-start-20261029/.
