# AD-05 legacy cancellation research

## Goal

Map legacy lead cancellation, pause, and automatic budget-resume reconciliation
against durable A2A writer effects. Identify exact gaps and a minimal
deterministic acceptance sequence; do not implement.

## Scope

Read `src/lead-orchestrator.js`, `src/server.js`, `src/durable-store.js`,
`src/budget-watcher.js`, `src/transient-recovery.js`, and focused tests. Exclude
the in-progress AD-02 auth UX; describe only existing pause/cancel versus
budget-resume behavior.

## Constraints

Research only. Do not edit source/tests, access live providers or credentials,
activate runtime services, stage, or commit. Use English and ASCII. Record
evidence paths and distinguish tested behavior from inference.
