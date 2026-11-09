# AD-04 router migration repair re-review

Date: 2026-11-06. Baseline HEAD: 435afa3. Candidate: current working-tree
changes in src/server.js, src/delivery-engine-router.js,
test/server.test.js, and test/delivery-engine-router.test.js.
Verdict: APPROVE.

## Findings

Blocking: none. The previous production router-composition blocker is resolved.

Evidence (read): the helper now resolves getLegacyRecoveryGraph(runId) before
falling back to the direct graph interface. DeliveryEngineRouter exposes the
legacy engine graph for legacy/previously unmapped legacy resumes, and returns
null for a pinned concurrent-v1 mapping. A concurrent mapping cannot fall back
to the legacy graph. This matches the router's existing legacy resume fallback.
The accessor does not change mappings or dispatch work. Existing resume engine
admission and objective/workspace validation remain in place.

Evidence (read): migration still happens before AgentEvent.task publication and
stale decision validation. On successful migration the first task has WORKING
status and a cleared pause. The executor now suppresses the stale task metadata
fallback when the authoritative graph has no pause, so it does not recreate the
retired human decision or forward its stale decisionId or choice. Genuine live
pauses continue to take precedence.

Evidence (ran): the new regression composes the real DeliveryEngineRouter and
actual executor with an isolated legacy graph stub. It verifies the old request
is cleared, its interrupt is removed, the first published task is WORKING, the
obsolete question is absent, and stale decision metadata does not prevent or
contaminate resume. Prior real-graph migration tests remain valid because the
graph patch and human_input behavior did not change in this repair.

No test integrity weakening or unrelated scope change found. Existing tests
were retained and new assertions exercise the missing composition boundary.

## Verification

Independently ran:

- `node --test test/delivery-engine-router.test.js`: 13 passed, 0 failed.
  Includes pinned engine graph selection and existing engine admission fences.
- `node --test --test-name-pattern='production router migrates a legacy recovery question before stale decision validation|legacy threshold-only recovery question is migrated before a resumed task is published|input problems on a paused task republish the same pause instead of failing' test/server.test.js`: 3 passed, 0 failed.
- `git diff --check`: passed.

Reused previous successful real-graph/restart and transient recovery evidence;
those inputs are unchanged. No full server-suite success is claimed: the
reported earlier full run was incomplete (19 passed, 1 cancelled).

Only this requested ignored review report was written. No reviewed source,
tests, fixtures, config, or Git state changed. Inherited :memory:.lockdb remained
untouched. This verdict covers only the router migration repair and closes the
previous AD-04 delta blocker; it does not qualify the entire server suite or
other AD work.

Status: complete.
Scope expansion: none.
