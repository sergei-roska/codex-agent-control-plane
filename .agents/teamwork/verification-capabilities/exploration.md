# A2 verification capability map

Baseline: HEAD 2a9f65a, clean. No runtime, provider, or project command was run. Conclusions below are source-read evidence.

## Current contracts

- [read] Project owner configuration is `.runtime/projects/<id>/project-settings.json`, version 1. `src/project-settings.js:3-16,100-147` validates it strictly, defaults owner opt-ins off, and reads it once at server startup. Existing `ownerChecks` is a durable owner-selected list of up to eight parsed acceptance commands. It is a local execution contract, not an external CI route.
- [read] `src/server.js:414-434` uses explicit intake acceptance when present; otherwise it pins project `ownerChecks`. `src/server.js:480-504` persists the contract in task metadata and refuses to start until that metadata is readable. Resume ignores new acceptance metadata (`:477-483`) and does not repin. Owner settings already survive candidate changes and restarts; each task gets a fresh acceptance run.
- [read] Source determines the execution route: owner contracts run via `runCheckImpl` (`src/acceptance.js:652-665,702-730`); lead-proposed contracts carry `source: agent`, pin workspace check files (`:25-35,99-105,142-180`), and run only through App Server sandbox (`:660-665,724-730`). Acceptance snapshots the candidate before and after checks and records fingerprint, check outcomes, and verifiedAt (`:742-755`). This is the existing separation between durable check requirements and fresh candidate-bound evidence.
- [read] Execution policy is owner-controlled by `executionPermissions` (`src/project-settings.js:15-16,105-116`) and threaded through server, orchestrator, and acceptance. `src/execution-permissions.js:35-104` reads native config and permission profiles, returning conservative strict mode on missing/invalid context. `src/codex-app-server.js:635-650` exposes config read/resolution. HAR-03 is complete; do not add a permission bypass.
- [read] Server startup already selects writer isolation using `selectWriterIsolation` (`src/server.js:879-883`), but this can run the confinement probe (`src/writer-lanes.js:170-221`). That is not a safe no-command preflight to reuse for an intake gate. `readPermissionContext` is the closest existing read-only capability inventory (`src/execution-permissions.js:35-75`), though it starts App Server and checks policy, not whether arbitrary project test dependencies are installed.
- [read] Lead human answers and resolved decisions are checkpointed only in that run (`src/lead-graph.js:680-686,3964-4007`); stage records also capture open/resolved decisions. No cross-run reusable decision store is shown by this path. Project settings are the existing durable owner-scoped, cross-candidate configuration boundary.

## Concrete gaps and extension points

1. There is no intake preflight that compares required check routes with available execution capability before a long run. Existing `ownerChecks` is syntactically validated, but dependencies/credentials/provider route availability are not probed (`src/project-settings.js:81-98`; contract is only parsed at `src/server.js:417-424`). Agent checks are only validated/pinned when proposed during the run (`src/acceptance.js:142-180`).
2. A project check contract has no route identity or capability declaration. External CI cannot be selected, queried, or triggered through this path. `acceptance.js` supports local owner execution and sandboxed agent execution only.
3. Repeated owner answers persist within the graph run but not across separate runs. `ownerChecks` is durable configuration, but does not encode an owner-authorized reusable external route or its scope/expiry.

## Smallest safe implementation recommendation

- Add a bounded, read-only intake preflight after acceptance selection, before dispatch. Inspect only contract shape, configured local route, and policy APIs; it must not execute workspace scripts, install dependencies, contact CI, write remotely, or spend resources. Report `ready`, `unavailable`, or `unknown` with a concrete reason. A trusted worker can repair local environment within existing authority; route choice, access, spend, and external-write authorization remain owner decisions.
- Keep durable authorization separate from `acceptanceContract` and acceptance result. Extend existing versioned owner settings only for a route the owner explicitly selected and bounded (project, allowed check IDs/commands, capability, optional expiry). One blocker answer is not global authorization. If runtime answers must persist before settings change, use a versioned project record with explicit scope and provenance, not graph prose.
- Preserve backward compatibility: absent route settings mean current behavior; malformed settings enable nothing and warn; per-run acceptance replaces defaults; resume cannot change pinned acceptance; each candidate reruns checks and produces current fingerprint-bound evidence. Route authorization never counts as a passing check or review receipt.

## Relevant tests and traps

- `test/project-settings.test.js:90-159`: settings defaults, strict validation, ownerChecks, fail-closed malformed config.
- `test/server.test.js:1318-1425`: owner defaults, explicit override, follow-up run, resume immutability, durable contract and restart recovery.
- `test/acceptance.test.js` and `test/lead-graph.test.js` cover source-specific execution, pinned check integrity, candidate snapshots and acceptance disposition.
- Trap: startup writer-isolation probe is an execution probe; do not call it from a supposedly command-free preflight. Native permission availability does not prove toolchain or external CI readiness. Preserve fresh candidate evidence and review receipts.

## Open questions for lead

- Which reusable route is in scope: local ownerChecks only, or a specific already-supported external route? Current source has no external CI integration, so implementing its execution would exceed safe preflight scope.
- Should persistent route authorization be owner-edited project settings only, or should a human answer create a scoped durable record? The latter needs an explicit revocation/expiry and project identity contract.
