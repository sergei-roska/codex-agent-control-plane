# Native top-level dependency record version
Read active junior instructions. Same Harness cwd, root owns Git.
Only src/concurrent-delivery-engine.js and test/server-delivery-engine.test.js
may change. No live calls/replay/DB mutations. Baseline4192a08.

Actual second native output is saved at ../qualification/second-native-planner-output.json.
It follows the native schema but validatePlanDelta fails field_required at
$.schemaVersion because output.delta.dependencies contains records without the
schemaVersion required by validateRecord('dependency') (delivery-contracts.js367).
The native dependency schema currently reuses embedded reference shape for the
standalone delta dependencies. Embedded task.dependencies refs deliberately omit
schemaVersion; standalone delta.dependencies must require version delivery/v1.

Fix exactly this native shape mismatch: distinct standalone dependency schema
with pinned schemaVersion, retaining existing embedded reference shape, identity,
kind and expectedOutput constraints. Do not weaken domain validation or synthesize
successful results. Regression proves raw real native output rejects missing
record version, corrected standalone records pass actual domain validation, and
embedded refs stay valid. Keep target IDs synthetic in tracked tests, never add
private runtime evidence to Git. Focused schema test plus contracts/recovery suite,
then freeze for root full/critic. Keep scope small; report any extra discovered
obstacle before edits. No further intake/collector changes.
