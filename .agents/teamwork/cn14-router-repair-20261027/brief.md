# CN14 router repair

Own only `src/delivery-engine-router.js` and `test/delivery-engine-router.test.js`.
Repair immutable intake for `goal`, `contract`, `contextId`, and `newRequest`;
preserve omitted fields; reject explicit conflicts before writes or engine calls;
route persisted intake; and support one-time legacy resume-placeholder backfill.
Keep async legacy resumability and existing controls. Use real disposable SQLite.
Do not activate routing or modify live/shared services, dependencies, Git, or
other files. Root owns Git and durable docs.
