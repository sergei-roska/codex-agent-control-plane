# Workflow graph implementation

Baseline: `655bb47`. Offline source and focused fake Node tests only. Own
`src/lead-graph.js`, `test/lead-graph.test.js`, and this handoff directory.
Do not edit review policy, role catalog, profiles/TEAM.md, or workflow docs.

Implement safe repair receipt reuse without deleting history, with durable
pending and fresh-evidence guards; bounded deterministic next-step projection
in full and delta prompts; and same-batch fresh verifier handoff to matching
later-wave auditors. Preserve conservative negative audit behavior and the
exact six-field review context. No live API/model, DB, service lifecycle,
target-project or Git mutation.
