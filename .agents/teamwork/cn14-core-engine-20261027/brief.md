# CN14 core engine worker

Implement the production concurrent delivery engine and server/settings composition from `engine-integration-20261027/brief-core-worker.md`.

Owned source paths: new `src/concurrent-delivery-engine.js`, new `src/delivery-engine-router.js`, narrow `src/server.js`, narrow `src/project-settings.js`, and the explicitly granted `src/app-server-switch.js` plus `test/app-server-switch.test.js` seam. Owned tests: new `test/concurrent-delivery-engine.test.js`, new `test/server-delivery-engine.test.js`, narrow `test/project-settings.test.js`. Root owns Git/docs. Preserve all inherited dirty work and other worker ownership.

No agents, Git writes, dependencies, service/launcher restart, live model/account/target action. Use the real stores, controller, planner, lifecycle, candidate publication and role service with fake AppServer/A2A fixtures. Run focused checks with `env -u NODE_TEST_CONTEXT`; never run the named hostile Git-filter regression.

Current contract direction: router persists a run-to-engine mapping before dispatch. Existing unmapped resume is pinned to legacy before fallback `run`; new intake uses startup setting. Concurrent engine owns a per-run objective/session and an orchestrator-compatible result/control facade. The role service API and home-pin details must be reconciled with root before integration.
