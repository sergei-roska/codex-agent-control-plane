# ADR: AUT-03 per-project owner opt-in

Date: 2026-10-16
Status: accepted for offline implementation; live trial remains pending

## Context

AUT-03 skill delivery already requires the trusted pinned lead skill and exact
membership in the startup UUID allowlist. The allowlist alone did not make the
project owner's intent to enable this experimental lead behavior explicit.

## Decision

Require both gates:

1. The launcher-selected per-project `project-settings.json` contains the
   strict JSON boolean `aut03LeadSkillEnabled: true`.
2. The run ID is an exact lowercase UUID member of
   `CODEX_A2A_AUT03_TRIAL_RUN_IDS`, parsed once at server startup.

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

The two independent owner-controlled values make the cohort explicit while
retaining exact run scoping. A settings change has no effect until server
restart. Offline checks can verify schema validation, source isolation, gate
composition, and rollover behavior; they do not establish live trial safety,
planning quality, or cost savings.
