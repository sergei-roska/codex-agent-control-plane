# AUT-03 implementation brief

Implement the lead-only, versioned decomposition skill and its trusted delivery path under `docs/aut-03-lead-decomposition-runbook.md`. Preserve the existing AUT-02/AUT-01 changes and do not start a live model trial, service restart, or rollout.

## Acceptance

- A dedicated `audience: lead` skill is excluded from ordinary worker candidate selection and assignment resolution. Existing skills without an audience field remain worker-available.
- A runtime-owned, versioned SHA-256 pin is attached to every lead turn only for exact owner-allowlisted trial run IDs. The default is off; no model-proposed field can opt in or choose the skill ID, path, or hash.
- Freeze the selection and pin in the run checkpoint at first intake; a resume whose allowlist or skill pin differs fails before a model call. Skill-enabled runs roll over from legacy session rows with a null profile hash.
- Pin validation occurs before every turn through the existing App Server selected-skill validation. Missing or changed skill content prevents the model turn.
- Skill-on and skill-off lead sessions cannot reuse the same thread. Full, delta, same-run retry, resume, rejection rollover, and context rollover retain the correct pin.
- Lead tools remain disabled; no worker/tool policy expands.
- Tests prove delivery and worker isolation with fake App Server calls. They do not claim planning quality, savings, or live behavior.
- Add a bounded skill file with proposal-only guidance, and record the offline qualification/defer decision in evidence and project docs.

## Scope boundary

Runtime/code owner: assigned worker after S1 design review. Lead owns evidence/docs and final verification. No service lifecycle, live model call, shared DB, or Git mutation is in scope.
