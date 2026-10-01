# M4 implementation decisions

Date: 2026-09-30. Status: complete; evidence in [acceptance.md](acceptance.md). Scope: [beta plan M4](../beta-master-plan.md#m4-activate-the-delivery-team-and-pipeline-model).
Role contracts: [roles-tools.md](../m0/roles-tools.md); presets: [decisions.md, Initial presets](../m0/decisions.md#initial-presets-and-beta-jira-types).
Builds on [M3](../m3/implementation.md). Runs in parallel with [M5](../m5/implementation.md); the
shared integration contract is in M5 "D-M5-5". Lead decisions; workers implement them.

## Scope boundary

- A separate `delivery` role pack with the nine public roles, used for dashboard delivery runs.
  The legacy `orch-*` pack stays loaded and unchanged for CLI/A2A runs and remains selectable
  for delivery runs through project policy (`rolePack: "legacy-orch"`, M3 rules preserved).
- Four versioned presets: feature, bugfix, docs, audit. Security, performance, environment and
  debt presets are listed as unavailable ("needs its own contract and pilot").
- Pipelines tab driven by saved plan revisions and actual attempts; read-only preset registry.
- Capability cases for all nine roles: reproducible on the fake protocol; a `--live` mode exists
  but is run only on explicit owner request.
- No visual pipeline editor, no parallel writers, no new public roles beyond the nine.

## D-M4-1 Pack layout and identities

```
profiles/delivery/
  pack.json
  TEAM.md                      # delivery team rules (derived from roles-tools.md)
  agents/dlv-*.toml            # same TOML format as profiles/agents
  presets/{feature,bugfix,docs,audit}.json
```

`pack.json`:

```json
{
  "packId": "delivery", "version": "1.0.0",
  "coordinator": { "publicId": "project-manager", "runtimeId": "dlv-project-manager", "displayName": "Project Manager" },
  "roles": [
    { "publicId": "architect", "runtimeId": "dlv-architect", "displayName": "Architect" },
    { "publicId": "developer", "runtimeId": "dlv-developer", "displayName": "Developer" },
    { "publicId": "qa", "runtimeId": "dlv-qa", "displayName": "QA" },
    { "publicId": "reviewer", "runtimeId": "dlv-reviewer", "displayName": "Reviewer" },
    { "publicId": "security", "runtimeId": "dlv-security", "displayName": "Security" },
    { "publicId": "performance", "runtimeId": "dlv-performance", "displayName": "Performance" },
    { "publicId": "devops", "runtimeId": "dlv-devops", "displayName": "DevOps" },
    { "publicId": "tech-writer", "runtimeId": "dlv-tech-writer", "displayName": "Technical Writer" }
  ],
  "repairChains": { "dlv-developer": ["dlv-developer-xhigh", "dlv-developer-sol"] },
  "presets": ["feature", "bugfix", "docs", "audit"],
  "unavailablePresets": ["security", "performance", "environment", "debt"]
}
```

- Role name pattern becomes `^(orch|dlv)-[a-z0-9-]+$` everywhere it is enforced
  (role-catalog, a2a-role-service, server route regex). Repair executors
  (`dlv-developer-xhigh`, `dlv-developer-sol`) are runtime profiles, not public roles; their
  attempts count for the Developer stage they repair.
- The coordinator profile `dlv-project-manager.toml` holds the PM model/effort defaults and the
  PM instructions. It is the lead role for delivery runs and the Intake role (replacing
  `createPmLeadRole` for the delivery pack; the legacy pack keeps M3 behavior). It is read-only
  and never an A2A specialist endpoint.
- Profile defaults (M5 may override per role):

| Runtime id | Sandbox | Model | Effort |
| --- | --- | --- | --- |
| dlv-project-manager | read-only | gpt-6-sol | high |
| dlv-architect | read-only | gpt-6-sol | xhigh |
| dlv-developer | workspace-write | gpt-6-luna | high |
| dlv-developer-xhigh | workspace-write | gpt-6-luna | xhigh |
| dlv-developer-sol | workspace-write | gpt-6-sol | medium |
| dlv-qa | workspace-write | gpt-6-luna | high |
| dlv-reviewer | read-only | gpt-6-sol | high |
| dlv-security | read-only | gpt-6-sol | high |
| dlv-performance | workspace-write | gpt-6-luna | high |
| dlv-devops | workspace-write | gpt-6-luna | medium |
| dlv-tech-writer | workspace-write | gpt-6-luna | medium |

- Instructions: each profile encodes its row of the roles-tools.md contract (inputs,
  required outputs, authority and boundaries) plus the common assignment contract, in
  English and ASCII. Tools stay `mcp_servers = []`, `skills = false` (no unverified tools).
- Pack identity in snapshots: `rolePack: 'delivery'`, `rolePackVersion: '1.0.0'`,
  `rolePackHash` = sha256 over pack.json, TEAM.md, agents and presets (sorted paths).

## D-M4-2 Presets

Preset file format (strict; unknown keys rejected):

```json
{
  "presetId": "feature", "version": "1.0.0", "classification": "feature",
  "description": "...",
  "stages": [
    { "key": "design", "roles": ["architect"], "required": true, "dependsOn": [], "purpose": "Scoped technical plan, proportional to impact" },
    { "key": "implement", "roles": ["developer"], "required": true, "dependsOn": ["design"], "purpose": "..." },
    { "key": "review", "roles": ["reviewer"], "required": true, "dependsOn": ["implement"], "purpose": "..." },
    { "key": "qa", "roles": ["qa"], "required": true, "dependsOn": ["implement"], "purpose": "..." }
  ],
  "optionalRoles": ["security", "performance", "devops", "tech-writer"],
  "optionalDependsOn": ["implement"],
  "minChecks": 1
}
```

| Preset | Required stages (key: roles, dependsOn) | optionalRoles | minChecks |
| --- | --- | --- | --- |
| feature 1.0.0 | design: architect; implement: developer <- design; review: reviewer <- implement; qa: qa <- implement | security, performance, devops, tech-writer | 1 |
| bugfix 1.0.0 | reproduce: qa; implement: developer <- reproduce; review: reviewer <- implement; verify: qa <- implement | architect, security, performance | 1 |
| docs 1.0.0 | write: tech-writer; review: reviewer <- write | qa, architect | 1 |
| audit 1.0.0 | investigate: architect or security or reviewer; synthesis: reviewer <- investigate | security, architect | 0 |

- Optional stages depend on the stages named in `optionalDependsOn` (at least those; more allowed).
- audit is read-only: any stage whose role is writable is invalid. Read-only roles never get
  `allowedFiles`; writable roles need 1..20 (existing path and protected-path rules).

## D-M4-3 Plans against presets

- Intake plan output adds `presetId` (must equal the classification's preset id) and per stage
  `presetStageKey` (string for a required preset stage, null for an optional stage) and
  `roleId` as a PUBLIC role id. The server maps public ids to runtime ids from the pack before
  saving; saved stages keep both `publicRoleId` and `roleId` (runtime).
- Validation (`validatePlan(plan, { pack, preset, projectCheckIds })`): every required preset
  stage appears exactly once with a role from its `roles`; its dependencies include the mapped
  preset dependencies; optional stages only use `optionalRoles` and depend on the
  `optionalDependsOn` stages; stage count 1..12; acyclic; existing path, protected-path and check
  rules; `checkIds.length >= minChecks`. Saved plan revision records `presetId`, `presetVersion`,
  `rolePack`, `rolePackVersion`, `validatorVersion: 'm4-plan-v1'`.
- Graph enforcement (M3 D-M3-4) is unchanged except: role match uses runtime ids; repair
  eligibility comes from the pack `repairChains` (legacy chain built in for orch-builder); the
  "repair after rejected acceptance" rule applies to the Developer stage.
- The legacy pack path keeps `m3-plan-v1` rules unchanged.

## D-M4-4 API and UI

- `GET /roles` -> `{ activePack: { packId, version }, roles: [{ publicId|null, runtimeId,
  displayName, kind: 'coordinator'|'specialist'|'repair'|'legacy', pack, sandbox, model, effort,
  serviceTier|null, settingsSource: 'saved'|'profile', activeAttempts }] }` (model/effort/tier from
  M5 current defaults). Sidebar shows the nine public roles of the active pack with an activity
  indicator (`activeAttempts` from nonterminal dispatch_journal rows of active runs); no switches.
- `GET /presets` -> `{ presets: [preset files + available: true], unavailable: [{ presetId,
  reason }] }`.
- `GET /pipelines?limit=` -> `{ runs: [{ runId, ticketId, title, status, phase, presetId|null,
  presetVersion|null, rolePack, planRevisionId|null, stages: [{ stageId, publicRoleId, roleId,
  required, status, attempts }] }] }` for active runs plus the 20 most recent settled runs.
- Pipelines tab: per run a stage lane (status chips, attempts count, repair attempts marked),
  link to the ticket; a Presets section listing versions and stages; unavailable presets shown
  greyed with the reason. The prototype sample data is removed from this tab.
- requestedSpecialty (M2 field) is shown to the PM as a preference with the public role name.

## D-M4-5 Capability cases

`scripts/role-capability-check.js` and `test/role-capability.test.js` define one case per public
role (plus PM), each a tiny fixture repo + ticket + scripted fake behavior, asserting the role's
authority boundary and required outputs per roles-tools.md "Activation checks":
PM ready/not-ready with provenance; Architect scoped dependencies; Developer bounded delta within
allowedFiles; QA reports a seeded failing behavior with the executed check; Reviewer reports a
seeded contract violation with location; Security flags an unsafe access boundary without
writing; Performance labels measured vs hypothesis; DevOps setup evidence within scope; Writer
verifies an example against delivered behavior. On the fake protocol these prove plumbing,
routing, sandbox/scope enforcement and report validation, not model quality. `--live` runs the
same cases against the real App Server and is executed only on an explicit owner request.

## Verification plan

Fake-protocol integration: feature/bugfix/docs/audit tickets reach review through the
delivery pack with preset-bound plans; plan violations against the preset rejected; legacy pack
selectable and unchanged; Pipelines shows live stage progress consistent with Attempts and
Board; QA/Reviewer stages cannot be satisfied by the Developer role; capability cases pass.
