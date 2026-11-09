# CN-09 implementation

Own only `src/project-delivery-controller.js`, `src/lead-planner.js`, `src/delivery-inbox.js`, their three focused test files, and this note directory. Build an explicit local composition boundary over the accepted BacklogStore, TaskScheduler, and TaskExecutor. Use disposable SQLite and fake turn/worker adapters only. No live service, model, network, shared database, target, Git, or account actions. Root owns Git and tracked docs.

Required behavior is specified in `.agents/teamwork/concurrent-runtime-20261026/brief-cn09.md`, with accepted planning semantics in `docs/architecture/concurrent-harness/target-design.md`, `role-policy.md`, and implementation-plan CN-09. Do not modify backlog/scheduler/executor/candidate modules; shared objective primitives have another owner. Report missing interfaces rather than bypassing them.
