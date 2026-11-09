# AD-04 review fix: route recovery-question migration through the engine router

## Goal

Fix the blocking finding in `review/delta-handoff.md`: production `startServer` passes a `DeliveryEngineRouter` to the lead executor, but `migrateLegacyRecoveryQuestion` only reads `orchestrator.graph`. The old threshold-only question therefore survives and is republished. Add a regression composing the real router and lead executor with stale decision metadata.

## Verified context

- HEAD is `435afa3`; do not change Git state or the inherited untracked `:memory:.lockdb`.
- `src/server.js:58-76` contains `migrateLegacyRecoveryQuestion`; `executeLead` calls it before resume publication around line 801.
- `startServer` passes a `DeliveryEngineRouter` to `registerLead`; the router holds `legacyEngine` but has no graph/migration delegation.
- Current direct-graph migration tests in `test/server.test.js` do not cover the production router.
- AD-02 has a separate root-owned hunk in `src/server.js`; preserve it exactly.

## Ownership and allowed files

Own only:
- `src/server.js` (migration helper and relevant caller only; do not edit the AD-02 adapter hunk)
- `src/delivery-engine-router.js`
- `test/server.test.js` and/or `test/delivery-engine-router.test.js`
- this brief and a concise handoff under this directory

Do not edit other files. Do not stage, commit, activate services, or run live providers.

## Acceptance

1. Recovery migration resolves the graph from the selected legacy engine through an explicit router API and refuses to use the legacy graph for a run mapped to `concurrent-v1`.
2. Preserve direct orchestrator graph compatibility for existing tests/consumers.
3. A composed regression uses the real `DeliveryEngineRouter` and `makeLeadExecutor` with a threshold-only pending question and stale decision metadata; migration occurs before publication/validation, removes the obsolete request/interrupt, does not call stale resume, and does not republish the obsolete question.
4. Existing direct migration and AD-04 server regressions still pass.
5. Run the focused regression plus `node --test test/delivery-engine-router.test.js` (if router is changed), `node --test test/server.test.js` if practical, and `git diff --check`. Report exact results.

Keep the change narrow. If a required test cannot use the real router/executor composition, report the specific obstacle rather than substituting a shallow router mock.
