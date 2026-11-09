# Migration qualification worker handoff

Changed only test/delivery-migration-qualification.test.js. A real BacklogStore fixture retains an active claim, attempt and delivery events with an old router mapping schema. Failure is injected before ALTER and after actual ALTER has committed; each reopen preserves all original claim, attempt, event and mapping fields. The post-ALTER default column is retained, retry is idempotent, legacy-default router reads the original mapping and rejects changed immutable intake. This establishes safe data preservation and selection rollback, not transactional DDL rollback.

Real server/router/concurrent-engine composition tests both directions: a held fake legacy publisher blocks concurrent intake; a real concurrent engineer writes a private lane and is held while legacy intake is blocked before mapping or publication. A legacy-default second server cannot acquire the held workspace. An independent workspace publishes; a legacy-default restart preserves the legacy mapping. Provider turns are local fakes; the actual concurrent lane has not published into the canonical workspace during this test.

Unknown effects after disabling and reopening are not newly established by this fixture. Existing server-delivery-engine.test.js downgrade fixtures test selected stored unknown claim, publication, planner and authoritative intent states. The held-writer fixture's teardown follows the existing forced cleanup pattern if shutdown cannot drain, so it does not claim a safe shutdown or recovery result.

Command: env -u NODE_TEST_CONTEXT node --test test/delivery-migration-qualification.test.js test/delivery-engine-router.test.js
Result: 14 tests pass, 0 fail; worker.tap. Evidence is in ignored local coordination storage and may disappear. No production defect identified. Independent review pending.
