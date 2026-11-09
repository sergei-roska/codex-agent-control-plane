# Launcher execution-permissions default handoff

The launcher now reads `.runtime/launcher-settings.json` using the exact schema
`{version: 1, defaultExecutionPermissions: "inherit" | "strict" | "full-access"}`.
A missing file leaves project settings untouched. Malformed JSON, unsupported
values, unknown fields, or an invalid version fail with a startup diagnostic at
stage `launcher_settings`, before token setup or child spawn.

For a valid launcher default, startup uses the validated atomic owner project
settings writer only when the project document omits `executionPermissions`.
Existing fields are preserved; an explicit per-project mode is not rewritten.
This is one-time materialization: after writing the project field, changing or
removing the launcher default will not rewrite that now-explicit project value.
The materialized value persists even if a later startup step fails.
This is file-based owner configuration only. No API or model input exposes the
launcher default. No real launcher settings, project settings, process, provider,
database, or native Codex configuration were changed.

Changed source/tests: `src/launcher-projects.js`,
`src/launcher-project-settings.js`, `test/launcher-projects.test.js`. No edits to
the main worker's project-settings implementation or launcher UI.

Verification log: `launcher-projects.tap`.

- `env -u NODE_TEST_CONTEXT node --test test/launcher-projects.test.js`:
  37/37 pass.
- `git diff --check` for owned source/tests and `node --check` for the same JS
  files: pass.

The default is not enabled in the real `.runtime` directory by this worker. Root
owns actual launcher/project settings and runtime application after qualification.
