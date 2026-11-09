# Brief: AUT-03 per-project owner opt-in

## Objective

Add a trusted, strict, default-off per-project setting that must be combined
with the existing exact run UUID allowlist to activate the pinned AUT-03 skill
for the Lead. Keep worker routing, tools, accounts, permissions, and skill pins
unchanged.

## Constraints

- Read the setting only from the launcher-selected project settings file.
- Do not accept authority from task requests, assignment JSON, or model output.
- Preserve checkpoint, profile, and thread identity on new and resumed runs.
- Do not enable the active project setting or restart its server during source
  implementation.

## Acceptance

- Focused setting, server, Lead graph, and worker-isolation regressions pass.
- The full-suite result is compared with the clean baseline.
- Documentation records source, default, UUID conjunction, startup loading, and
  isolated trial rollback.
