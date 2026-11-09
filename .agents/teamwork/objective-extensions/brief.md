# Objective extension worker brief

Own only `src/backlog-store.js`, `test/backlog-store.test.js`, and this local
notes directory. Preserve all accepted scheduler hooks and existing regressions.
Add the exact trusted `applyOwnerCorrection` and optional synchronous
`checkpointInventory` APIs specified in
`.agents/teamwork/concurrent-runtime-20261026/brief-objective-extensions.md`.
Do not add a general record setter or planner-granted owner authority. Verify
CAS, authorization, replay, task/objective state policy, checkpoint inventory,
event atomicity, and all affected backend tests. Root owns Git and durable docs.
