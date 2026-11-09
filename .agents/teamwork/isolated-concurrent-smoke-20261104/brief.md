# Isolated Concurrent readiness and task smoke

Owner: root. Date: 2026-11-04. Baseline: c67bf68; Git status only
untracked `:memory:.lockdb`. Node v24.22.1.

## Authorization and boundaries

The user authorized the first verification part while locating a real project
and task: isolated Concurrent startup and synthetic tasks. Existing projects,
launcher services, production/runtime databases, settings and the old unresolved
planner turn must remain untouched. Do not register a project in the live launcher.
Use owned disposable workspace, database, token, locks and storage. Native Codex
provider calls through the existing account mechanism are in scope for a bounded
synthetic smoke, not a performance or savings trial. Do not expose credentials.
No commits, pushes or deployments. M2 quarantine work remains out of scope.

## Acceptance

1. Current focused regressions and broad suite results are recorded honestly.
2. A separate Concurrent server binds a loopback ephemeral port with isolated
   settings and storage, returns an A2A card, and performs a bounded synthetic
   task using the native provider if available. Verify output and durable state,
   rather than inferring success from a listening banner or provider prose.
3. Demonstrate safe close and restart of the isolated server and retain exact
   evidence. Verify Legacy candidate schema coexistence using disposable state.
4. Preserve existing runtime state and distinguish fake-provider checks from
   native model evidence. No general autonomy, throughput or economy claim.
5. Independent critic checks acceptance and any unresolved limits.

## Ownership

Root: coordination, regression suite, baseline inspection, acceptance and notes.
Worker: isolated probe script, synthetic workspace and evidence under this task
directory or owned temporary paths. No product source edits without a narrowed
repair brief. Maintain worker brief/handoff in its own child directory.

## Starting points

`src/server.js:startServer`, `server-bootstrap.js`, `src/cli.js`,
`test/server-delivery-engine.test.js:639` fixture and candidate coexistence tests,
`test/delivery-e2e.test.js`, native `src/codex-app-server.js` and account wrapper.
Read `.agents/teamwork/concurrent-quarantine-20261030/handoff.md` for previous
failure and namespace fix; do not repeat its historical live operations.
