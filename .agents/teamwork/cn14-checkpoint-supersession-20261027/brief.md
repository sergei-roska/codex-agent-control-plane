# CN14 checkpoint supersession worker brief

Implement the narrow trusted durable owner checkpoint supersession seam in
`src/candidate-review.js` and focused cases in `test/candidate-review.test.js`.
Preserve immutable checkpoint and receipt rows. A dedicated synchronous
`authorizeCheckpointSupersession` callback defaults to deny. Exact owner
correction source/revision pins and a complete one-to-one replacement mapping
must be authorized before the active checkpoint set changes. History and
supersession mappings remain queryable. Do not edit BacklogStore, controller,
engine, role service, acceptance, or other files.

Proposed API sent to the core engine worker before editing:

```js
reviewStore.supersedeCheckpoints({
  projectId, objectiveId, sourceMessageId, expectedOwnerGeneration,
  expectedControlRevision, priorGoalRevision, currentGoalRevision,
  replacements: [{ checkpointId, replacementCheckpointId }],
}, authorization)
```

Read methods: `checkpointHistory({ projectId, objectiveId })` and
`checkpointSupersessions({ projectId, objectiveId })`, plus
`isCheckpointActive({ projectId, objectiveId, checkpointId })` for the engine's
intermediate acceptance callback. Supersession authorization receives frozen
input, owner inventory, current objective, exact prior/replacement checkpoint
records and digests, and the mapping. Keep current inventory, finalization, and
graph consumers on one active projection. Verify with targeted real
CandidateReview/BacklogStore/CandidateStore tests, using
`env -u NODE_TEST_CONTEXT`.

Constraints: root owns Git and project docs; no Git writes, agents, live/account/
shared-service/target actions, or startup/finalization acceptance claims. Freeze
source for independent review when meaningful targeted tests pass.
