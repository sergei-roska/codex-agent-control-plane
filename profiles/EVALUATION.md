# Evaluation Checklist

## Pack acceptance

- Preview causes no target changes.
- Installation touches only `.codex`, preserves unrelated files, and is repeatable.
- Existing managed-file conflicts stop installation unless update is requested.
- Update requires prior pack ownership for a conflicting path and does not claim a same-path file from another source.
- Existing target configuration remains valid and retains unrelated settings.
- Every profile parses as TOML and has a clear role, scope, model, and instructions.
- Each skill has valid frontmatter and can be used by reading its installed path.
- A new target project can use the pack without the parent repository, a product-specific guide, LangGraph, a memory graph, or a specific A2A protocol.

## Orchestrator acceptance

Choose cases from the target product's requirements. At minimum, show evidence for a successful run, a rejected or failed run, interruption and restart, and a protected action if the product has one. As features are added, exercise duplicate and stale results, cancellation, retry exhaustion, dependency failure, conflicting outputs, and revised plans where applicable.

For each case, record the goal and input revision, expected outcome, actual task and artifact transitions, checks run, human decisions, cost and latency where relevant, and defects found. Compare the complete workflow, not just one agent's answer. Stop adding mechanisms when the current workload is met.
