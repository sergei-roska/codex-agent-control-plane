# CN14 server and startup composition

Own `src/server.js`, `src/launcher-projects.js`, new `test/server-delivery-engine.test.js`, and narrowly extend `src/delivery-engine-router.js` plus its test only if needed for legacy task lineage. Do not edit the core engine, UI, dependencies, or accepted shared tests. Root owns Git and durable docs.

Compose selected concurrent-v1 runs only from validated project settings; legacy is the safe default. Existing router mappings remain authoritative, and startup-snapshotted old lead task IDs must keep using legacy without provider work. Use shared SQLite, admission, lanes, auth, and bounded persistent storage outside the source workspace. Match launcher project identity and supply a synchronous fresh provider identity getter from the actual settled home.

Protect publication exclusivity and fail closed on unknown/unsafe stored state or incompatible worktree isolation. Preserve executor/recovery/core shutdown outcomes before closing the shared DB or releasing locks; unsafe drain must permit a retry while retaining ownership.

Qualify legacy behavior plus the default actual router/core/service/fake AppServer path with disposable resources and authenticated controls. No live settings, services, accounts, models, targets, dependencies, or Git changes.
