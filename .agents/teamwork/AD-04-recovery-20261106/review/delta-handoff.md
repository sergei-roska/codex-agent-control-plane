# AD-04 repaired delta review

Date: 2026-11-06. Candidate HEAD: 435afa3. Baseline: ab5c195.
Mode: re-review of the two existing blocking findings only.
Verdict: REJECT.

## Blocking finding

1. `src/server.js:59-60`: the production engine router prevents the required
   pre-publication migration. `migrateLegacyRecoveryQuestion` only reads
   `orchestrator.graph`. Production `startServer` constructs a
   `DeliveryEngineRouter` at `src/server.js:1561` and passes it to `registerLead`
   at lines 1614-1617. The router exposes neither `graph` nor a migration method.
   Its `getPause` delegates to the legacy engine, so the old human question is
   still returned after migration silently returns false.

   Concrete failure: resume a persisted threshold-only recovery question with
   stale decision metadata. The executor publishes the old INPUT_REQUIRED task,
   retrieves the still-live question, rejects the mismatching decision ID, and
   republishes the same obsolete question. No graph migration or resume occurs.
   Even a valid answer publishes the obsolete task before the graph fallback
   can retire it.

   Evidence (read): checked the full router class for graph forwarding and
   migration delegation; none exists. Checked the server adapter and legacy
   orchestrator resume validation. The human_input fallback runs only after
   server/legacy input validation and cannot fix the pre-publication contract.

   Evidence (ran): an isolated Node probe instantiated the real
   DeliveryEngineRouter with in-memory SQLite and a legacy engine exposing a
   threshold-only graph snapshot. The actual helper returned
   `{routerGraph:"undefined", migrated:false, updates:0}`. Calling the actual
   makeLeadExecutor with this router and a stale decision ID produced
   `updates:0`, `resumes:0`, first state INPUT_REQUIRED, and
   `questionPublished:true`. The final status event remained INPUT_REQUIRED
   (SDK numeric enum 4). The probe changed no project files or runtime roots.

   Fix: expose an engine-aware migration operation through the router and call
   it before publishing/validating the resumed task, or otherwise resolve the
   correctly routed legacy graph at that boundary. Add a regression composing
   the real DeliveryEngineRouter with the executor, including stale decision
   metadata. Preserve engine and objective fences.

## Repaired criteria

- PASS: capped enabled transient recovery stores a finite next_attempt_at,
  schedules the bounded slow retry, and re-arms its persisted time on restart.
  Existing canResume checkpoint/effect admission remains intact.
- PASS: a legacy waiting row at the cap with null timestamp is repaired to
  now + maxDelayMs and scheduled. Independently ran an in-memory SQLite probe:
  now=1000 produced next_attempt_at=301000 and timer delay=300000.
- PASS: pause projection reports the stored next time and suppresses stale
  exhausted messaging for scheduled retries.
- PASS at direct graph/helper boundary: the threshold-only request is retired
  with a progress receipt and unchanged review/objective evidence; genuine
  evidence-backed owner grants retain checkpoint and receipt fences.
- FAIL in production composition: migration before task publication/resume,
  as described above.
- PASS: recovery-owner-grant ADR clearly marks the threshold-only contract
  historical and superseded, and describes the newer evidence requirement.

## Verification

Independently ran:

- `node --test test/transient-recovery.test.js`: 10 passed, 0 failed.
- `node --test --test-name-pattern='legacy threshold-only recovery question is migrated before a resumed task is published|transient recovery delivery updates durable pause text only while the task is still paused|transient recovery pause text follows a scheduled retry instead of a stale exhausted flag' test/server.test.js`: 3 passed, 0 failed.
- `node --test --test-name-pattern='restart across the human_input boundary|legacy threshold-only recovery question migrates after restart|evidence-backed owner dependency may authorize one recovery plan|a second owner grant on the same checkpoint is rejected|an owner grant on a checkpoint that is not at the limit|another owner choice at the limit is only recorded as text|recovery state beyond the cap is valid only with a matching owner grant|a granted checkpoint stops again at generation 3' test/lead-graph.test.js`: 8 passed, 0 failed.
- The two isolated in-memory probes described above.

Reused the reported full lead-graph 288/288 result for unchanged surrounding
coverage. The named server migration test uses an orchestrator with a direct
`graph` property; it does not cover the production router composition.
No test integrity weakening found in this repair delta. The separate AD-02
server adapter hunk is excluded from this verdict.

No source, tests, fixtures, config, or Git state changed. Only this requested
ignored report was written. Inherited :memory:.lockdb remained untouched.

Pitfall: test new legacy orchestration helpers through the production engine
router; a direct orchestrator mock can hide a missing delegation boundary.

Status: complete.
Scope expansion: none.
