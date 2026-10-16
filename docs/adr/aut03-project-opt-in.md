# ADR: AUT-03 per-project owner opt-in

Date: 2026-10-16
Status: accepted for offline implementation; live trial remains pending

## Context

AUT-03 skill delivery already had a trusted pinned lead skill and an exact
startup UUID allowlist. The allowlist did not make the project owner's intent
to enable this experimental lead behavior explicit, and a server-generated run
UUID cannot usually be known before startup.

## Decision

Require the trusted project setting, with optional run narrowing:

1. The launcher-selected per-project `project-settings.json` contains the
   strict JSON boolean `aut03LeadSkillEnabled: true`.
2. If `CODEX_A2A_AUT03_TRIAL_RUN_IDS` is non-empty, the run ID must be an exact
   lowercase UUID member of that startup-parsed list. An empty list adds no
   run-level restriction.

The setting defaults to false when absent. A non-boolean value invalidates the
settings document and follows the existing warning plus all-disabled fallback.
The setting comes only from the trusted settings file and is loaded once when
the project server starts. Assignment JSON, task request metadata, and model
output cannot grant or override it. Existing skill audience, pin/hash checks,
Lead identity, read-only tools, worker isolation, and checkpoint/profile
identity rules remain authoritative.

## Trial and rollback

Qualification uses a disposable project copy, a separate settings file, and
only the intended run UUID in the environment allowlist. Do not enable the
active project as part of offline acceptance. To roll back an isolated trial,
set the field to false or remove it, stop and restart that project server, and
use a fresh run ID if a checkpoint recorded the previous effective context.

## Consequences and verification boundary

The project setting gives a usable opt-in boundary for an isolated trial
project. A populated allowlist can further narrow it when run IDs are known in
advance. A settings change has no effect until server restart. Offline checks
can verify schema validation, source isolation, gate composition, and rollover
behavior; they do not establish live trial safety, planning quality, or cost
savings.
