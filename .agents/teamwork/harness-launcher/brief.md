# HAR-04 launcher diagnostics brief

Own only `src/launcher-projects.js`, `test/launcher-projects.test.js`, and this coordination directory. Root owns tracked docs and Git.

Diagnosis: `createProjectManager` stores child stdout/stderr only in `rt.logs` (currently around lines 112-114 and 345-377). `status()` reads only that map, so a new manager after launcher exit has no startup logs. Startup failures before spawn (token/port/setup) are only thrown to the immediate caller. `RUNNING_MARKERS` includes the generic string `Codex Universal A2A`, which can mark starting as running without the server's successful listen message.

Implement the narrowest safe fix: persist a bounded, sanitized structured per-project startup diagnostic under `runtimeDir/projects/<id>/`, mode 0600; expose it through `status()` after manager reinitialization; retain early token/spawn failures; preserve nonblocking `start()`. Do not persist raw App Server stdout or conversation data. Keep startup failure diagnostics actionable and ensure diagnostic-write errors cannot mark a project running. Tighten running detection to the actual successful listener marker. Add focused tests using FakeChild and disposable runtime directories only.

No real managed project start, live session, database mutation, service restart, model call, or full test suite.
