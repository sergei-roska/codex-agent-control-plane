# Role settings implementation milestone

Cwd: /home/sr/Projects/Workspace/codex-agent-control-plane.
Read /home/sr/codex-home/agents/worker.toml developer_instructions and relevant
project AGENTS.md. Root owns Git, docs/architecture/concurrent-harness/, and
coordination. You own this cohesive product milestone in the existing dirty
checkout. Do not stage, commit, discard, or overwrite predecessor changes.

Owner now authorizes implementation. Deliver an independent Roles page and
correct role execution settings, preserving existing project/session behavior.
Owner explicitly asks to remove the ugly role section from the bottom of main
page, use a separate page, add 'number of agents' per role, fix reasoning-effort
display, and add Fast off/Fast on. No per-role accounts or Claude integration.

Read context reports (maps, not substitutes for current source):
- .agents/teamwork/concurrent-harness-plan-20261026/role-settings.md
- docs/architecture/concurrent-harness/target-design.md (role cards/capacity)
- docs/architecture/concurrent-harness/source-baseline.json

Allowed source/config/UI: src/role-overrides.js, src/role-catalog.js,
src/launcher-app.js, src/codex-app-server.js, src/role-names.js if needed,
launcher-ui/index.html, launcher-ui/app.js, launcher-ui/styles.css,
new launcher-ui/roles.html, roles.js, roles.css, new src/model-capabilities.js
or similarly narrowly named helper; relevant test/role-*.test.js,
test/launcher-app.test.js, test/codex-app-server.test.js, and new focused
role-page/model-capability tests. Do not modify lead-graph/server scheduling,
accounts, permissions or existing dirty handshake/startup tests. Report any
necessary extra path to root, continue independent scope. Existing role overrides
and effective settings must survive.

Implementation decisions:
1. Dedicated /roles page with clear nav/back link and selected project preserved
   (query param plus current selection only as appropriate). Main page links to it,
   no duplicate bottom role-card/modal section. Preserve team LEDs/activity if
   meaningful elsewhere; distinguish compact activity status from settings UI.
   Reuse current visual language and project role APIs, no new framework/deps.
2. Role capacity maxConcurrentAgents is finite positive integer per project.
   Effective defaults engineer4/explorer2/verifier2/auditor2/coordinator1,
   recovery-engineer1/senior-engineer1/architect1/scout2. Counts are capacity ceilings,
   not auto-start requests. Overall project scheduler cap12 and lead reserve1 are
   future scheduler scope; label counts truthfully as configured capacity, do not
   claim old engine enforces a pool. Add field to normalized overrides, effective
   role projection and defaults/API. Old TOMLs/JSON must continue loading; malformed
   new requests must not erase unrelated model/effort/rules. Keep stop-required
   override saving; no live restart or profile changes.
3. Fix effort display by testing inherited vs explicit value, saved roundtrip,
   model-specific valid options, and unknown/custom-model fallback. Local finding:
   model/effort fields are separately wired but options static; user-reported visual
   defect not yet reproduced. Do not assert a swapped-field root cause without proof.
4. Discover installed/account model capabilities using existing authenticated
   Codex App Server read-only model/list, no real model turn. Existing account
   subscription is the configured auth; do not introduce API keys or ask for them.
   Inspect installed schema first. Model options must preserve configured custom
   choices and clearly show unknown capability on discovery failure. Do not leak
   email, tokens, raw config, home paths or auth into UI/logs.
5. fastMode = inherit|off|on internally, with Fast off/Fast on UI plus inherited
   indication/reset. Installed protocol supports model serviceTiers/default tier,
   turn serviceTier/serviceTierForTurn; tier IDs are advertised, not hard-coded by
   schema. 'off' explicitly uses standard/default turn tier; 'on' resolves an actual
   advertised fast tier and reports unavailable/unknown without pretending it works.
   Carry resolved setting into thread/turn requests/continuation and attempt usage
   provenance where feasible in owned files; never silently charge a different tier
   than explicit selection. Unknown Fast can be disabled with explanation until
   supported metadata is available. Read local code/schema; use official OpenAI docs
   only if local evidence cannot establish semantics (read relevant skill if used).
6. Preserve same-task/thread guards, stop/cleanup behavior and existing permission
   policy. Read-only model metadata is authorized, live model calls/services aren't.

Verification: meaningful tests for persistent override compatibility, count bounds
and defaults, selected/inherited effort rendering, Fast request shape and unsupported
capability, page navigation/project selection/legacy main-page layout, and failed
catalog recovery. Run affected existing tests, inspect baseline failures rather
than weakening tests. Node CommonJS/node:test, current dependencies installed.
Use disposable temp outputs/services for tests only. No broad full-suite run until
root freezes integrated milestone. English/ASCII in code, comments, files.

Keep .agents/teamwork/role-settings-implementation/{brief,handoff}.md current.
Return concise summary, actual changed files, precise checks/results, remaining
limitations, and any uncertainty requiring review. A critic will independently
review contracts/UI/request behavior; challenger follows concrete risk probes.
Fresh native quota 2026-10-26T16:36:43Z: 81% five-hour, 81% weekly remaining.
