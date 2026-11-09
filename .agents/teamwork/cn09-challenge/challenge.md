# CN09 challenge result

Verdict: HOLDS
Status: complete
Scope expansion: none

## Recheck of prior takeover failure

Probe: `.agents/teamwork/cn09-challenge/owner-takeover.cjs`

Input: A real BacklogStore objective and DeliveryInbox steering message start a LeadPlanner turn. A deterministic barrier holds `runTurn`. `advanceOwnerGeneration('p', 'o', 0)` advances owner generation to 1 while goal, control, authority, plan, and inbox revisions stay unchanged. The held planner returns a valid plan delta. The same old planner object is then invoked again while the steering message remains pending.

Expected and actual: The held turn returns `stale/owner_generation_changed`; no task is inserted; steering stays `received`. The later call on the old planner object also returns `stale/owner_generation_changed` without a second model call. The probe exits 0.

Reproduce: `node .agents/teamwork/cn09-challenge/owner-takeover.cjs`

Observed output: `{"result":{"state":"stale","reason":"owner_generation_changed",...},"ownerGeneration":1,"tasks":[],"messageState":"received"}` and `{"later":{"state":"stale","reason":"owner_generation_changed"},"modelCalls":1,"messageState":"received"}`.

## Code inspection and adjacent checks

The planner captures owner generation at construction, includes it in pins, and checks it before a turn, in acquisition, and inside application. The controller passes its fixed generation to the planner and validates a supplied planner's identity. Recovery eligibility checks the original turn generation, and reconciliation must echo it.

Previously ran three focused existing tests covering busy retry through stop/reopen, exact unknown-turn reconciliation, and active crash recovery authorization: 3 passed, 0 failed. They were not rerun after this fix because their behavior is outside the changed generation check; the worker reports the affected suite at 92 passed, 0 failed.

No project source, existing tests, fixtures, or configuration were changed. The probe uses an in-memory disposable database and no provider or transport calls.
