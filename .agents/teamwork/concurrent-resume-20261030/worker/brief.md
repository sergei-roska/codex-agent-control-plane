# Worker brief

Repair explicit resume after a current provider account change. Preserve concurrent-v1 routing, task and planner history, candidates, acceptance, owner controls, and uncertainty fences. No live DB writes, model tasks, service restarts, Git changes, or commits; root owns runtime and final UI/API acceptance.

Allowed files from the original brief: `src/concurrent-delivery-engine.js`, `src/server.js`, `test/concurrent-delivery-engine.test.js`, `test/server-delivery-engine.test.js`, and `test/delivery-engine-router.test.js`. Root expanded scope for a justified blocked lifecycle transition to `src/backlog-store.js`, `src/delivery-lifecycle.js`, and `src/project-delivery-controller.js` with corresponding tests only if needed. Do not touch `src/delivery-role-service.js` or launcher UI.

Before editing, obtain lead review of a bounded design for safe dormant provider-drift recovery, explicit current-provider planner rebind with history preservation, and guarded recovery from the obsolete `blocked_technical` state. Read `.agents/teamwork/concurrent-resume-20261030/brief.md` for full acceptance.
