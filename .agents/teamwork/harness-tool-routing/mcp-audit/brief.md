# Drupal MCP audit brief

Read-only audit of the six current Drupal MCP packages in `/home/sr/Projects/Workspace/mcp-forge`: `drupal-static`, `drupal-config`, `drupal-content`, `drupal-ops`, `drupal-render`, and `drupal-db-ops`. Explicitly exclude `drupal-browser`.

The source repo has pre-existing user changes, including deletion of `drupal-browser` and edits to these packages. Inspect the working tree as-is; never restore, edit, stage, or test source files. Read `/home/sr/Projects/Workspace/mcp-forge/.agents/AGENTS.md` first.

For every package, inspect README, composer/runtime entrypoint, each registered tool, arguments, effects (read/write/execute/network/database), root resolution, confirmation or destructive safeguards, required services/secrets, and package dependencies. Report actual code behavior, not README claims alone. Assess whether each package is suitable for task-level Harness routing, with risk and an explicit recommendation. Note any changes in the source worktree that materially affect the audit.

Write a concise English/ASCII handoff to this directory. Do not expose secret values. Do not modify project files or run tests.
