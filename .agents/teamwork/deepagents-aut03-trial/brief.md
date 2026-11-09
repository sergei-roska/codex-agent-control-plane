# Brief: isolated DeepAgents Explorer prototype and AUT-03 dogfood

## Objective
Use the Harness A2A project to add a project-scoped, owner-controlled AUT-03
trial switch, compare the same DeepAgents Explorer prototype planning task with
the lead skill off and on, then execute one selected plan and prototype
DeepAgents for Explorer only.

## Baseline
Clean main at dd3607aa9d2f0c791d03ab24718790c186245e6a. Project id
f69dd0e80b, port 3002, workspace
/home/sr/Projects/Workspace/codex-agent-control-plane.

## Acceptance
- Project-specific opt-in defaults off, is loaded from the existing per-project
  owner settings file, and cannot be supplied by the model or task request.
- Exact UUID allowlist behavior remains available; worker skill routing and
  permissions remain unchanged.
- AUT-03 paired planning uses identical inputs, distinct fresh task threads,
  no-skill baseline first, frozen rubric, independent scoring, and actual usage
  evidence where available.
- DeepAgents prototype targets Explorer only, preserves read-only tools,
  Codex account routing and the existing worker report contract; delegation is
  disabled for the initial prototype.
- Run `npm test` against the integrated candidate and retain exact result.

## Ownership and boundaries
Root owns A2A coordination, baseline/evidence, Git and final decision. The
Harness lead may dispatch bounded A2A work under its existing role controls.
No global enablement, production rollout, API-key path, external service, or
write authority for Explorer.
