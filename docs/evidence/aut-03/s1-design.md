# AUT-03 S1 trusted delivery design

Status: independently approved and implemented for offline lead-skill delivery. No live trial or effectiveness claim is authorized.

## Decision

Deliver one versioned decomposition skill explicitly to the coordinator through the existing `selectedSkills` input to `CodexAppServer.run`. Keep the lead role's tool policy unchanged (`skills: false`, no MCP servers, apps, or plugins).

## Trust and selection

- Store the skill under the canonical skills root with `audience: lead` metadata.
- Parse an explicit `audience` field as `worker` or `lead`, defaulting missing metadata to `worker` so all existing skill files preserve their current availability. The default worker catalog excludes only explicit `audience: lead` entries; that ID is absent from worker candidate prompts and cannot resolve through worker assignment selection.
- Pin the lead skill ID and exact SHA-256 in trusted runtime code. Resolve its canonical path from the lead-only catalog. Never accept ID, path, or hash from a model response.
- Require two independent gates: `aut03LeadSkillEnabled === true` in the trusted launcher-selected per-project `project-settings.json`, and exact membership in `CODEX_A2A_AUT03_TRIAL_RUN_IDS`. The project setting is strict boolean, defaults false when absent, and is loaded once at server startup with the other settings. Invalid documents use the existing warning-and-disabled fallback. The UUID allowlist remains strict, startup-parsed, and unavailable to A2A request or lead output; neither gate can replace the other.
- Pass the trusted pin to the coordinator on each applicable full, delta, retry, resumed, or rollover turn for an allowlisted run. The App Server revalidates canonical path and file hash before each turn; drift blocks the turn.

## Thread and evidence binding

- Freeze the skill-on/off choice and exact pin at first intake in the checkpointed pinned run context. On resume, reject an allowlist or pin mismatch before a model call; a changed cohort needs a new run ID.
- Freeze the effective conjunction of owner opt-in and allowlist membership. Changes to either setting or cohort invalidate the checkpointed context before a lead call.
- Include the selected pin (or explicit off state) in the effective lead profile fingerprint stored with `SessionThreads`. Skill-on and skill-off runs therefore cannot share a thread. For skill-enabled runs, a legacy session row with a null profile hash is a mismatch and must roll over to a new thread; do not preserve the old null-hash compatibility shortcut.
- Existing usage records capture each run and model turn. The selected skill pin remains available in the run's pinned checkpoint context and session fingerprint.

## Qualification boundary

Offline tests must exercise the actual coordinator `appServer.run` options and App Server `turn/start` input shape for full/delta/resume/retry/rollover paths, verify default-off and worker isolation, and prove hash drift blocks before a model turn. Do not enable a live run or claim planning quality/economy. The lead remains read-only, all assignment/review contracts remain authoritative, and the skill produces proposals only.

## Source evidence

- `src/lead-graph.js`: full/delta prompts and lead turn call; worker assignment skill validation.
- `src/skill-catalog.js`: catalog parsing, canonical paths, hashes, and selection resolution.
- `src/a2a-role-service.js`: worker-only assignment skill processing.
- `src/codex-app-server.js`: explicit `selectedSkills` validation and per-turn attachment.
- `src/role-catalog.js`: lead's fixed read-only role and `skills: false` policy.
- `src/session-threads.js`: persisted profile fingerprint used for lead thread reuse.

## Offline implementation result

The assigned runtime and tests implement this design. Independent verification
approved the AUT-03 delta. Focused tests pass, and the trusted skill pin matches
the file hash. Exact final source/test hashes and whole-suite results are
recorded in `docs/evidence/aut-03/delivery-decision.json` after final audit.

## Owner opt-in follow-up

The offline delivery remains default-off. A disposable trial project must set
`aut03LeadSkillEnabled` to the literal JSON boolean `true` and supply the
intended exact run UUID through the existing environment allowlist. Both values
are read at server startup; stop the server before editing the settings file.
Never enable the active project as part of qualification. See
`docs/adr/aut03-project-opt-in.md` for the authority decision and rollback.
