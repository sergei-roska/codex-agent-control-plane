# AD-04 recovery repair

Status: complete; Sol approved the repaired delta after router-composition fix.

## Findings and changes

The transient retry cap previously left enabled recovery in `waiting` with a
null `next_attempt_at`, so the scheduler had no timer and startup refused to
resume it. Capped retries now persist a maximum-bounded backoff time and remain
scheduled after failure and restart. Startup also repairs a legacy capped
waiting record without a timestamp. The existing checkpoint/effect `canResume`
gate is unchanged. Server pause projection now reports an automatic retry only
when a finite next action is stored, and includes the scheduled time.

The persisted `supported_controller_replan` question was migratable only when
it named the recovery cap and lacked a validated owner-only dependency. The
server retires that question before publishing/resuming the task, clears only
the generic request and adds a progress receipt, then routes to technical
decision work. The graph applies the same rule when reaching `human_input`.
Goal, scope, checks, review receipts, and checkpoint state remain intact; no
partial or acceptance is created. A cited completed read-only investigation
of a separate owner-only dependency can preserve the real owner decision and
its bounded grant. The 2026-10-19 ADR contract is marked historical and
superseded by the 2026-11-06 AD-04 criterion.

## Changed files

- `src/transient-recovery.js`
- `src/server.js`
- `src/lead-graph.js`
- `test/transient-recovery.test.js`
- `test/server.test.js`
- `test/lead-graph.test.js`
- `docs/adr/recovery-owner-grant.md`

Root owns the AD-02 adapter hunk in `src/server.js`; its change is separate
from the AD-04 status and migration hunks above. Do not overwrite it.

## Verification

Passed:

- `node --test test/transient-recovery.test.js` - 10 passed, 0 failed.
- `node --test --test-name-pattern='legacy threshold-only recovery question is migrated before a resumed task is published|transient recovery delivery updates durable pause text only while the task is still paused|transient recovery pause text follows a scheduled retry instead of a stale exhausted flag|the server forwards the watch selection pin when an owner changes profiles during availability lookup' test/server.test.js` - 4 passed, 0 failed, including the root-owned AD-02 adapter regression.
- `node --test --test-name-pattern='restart across the human_input boundary|legacy threshold-only recovery question migrates after restart|evidence-backed owner dependency may authorize one recovery plan|a second owner grant on the same checkpoint is rejected|an owner grant on a checkpoint that is not at the limit|another owner choice at the limit is only recorded as text|recovery state beyond the cap is valid only with a matching owner grant|a granted checkpoint stops again at generation 3' test/lead-graph.test.js` - 8 passed, 0 failed.
- `timeout -k 1s 180s node --test --test-concurrency=1 --test-reporter=spec test/lead-graph.test.js` - 288 passed, 0 failed; completed in 19.2 seconds.
- `node --check src/transient-recovery.js && node --check src/server.js && node --check src/lead-graph.js && node --check test/transient-recovery.test.js && node --check test/server.test.js && node --check test/lead-graph.test.js` - passed.
- `git diff --check -- src/transient-recovery.js src/server.js src/lead-graph.js test/transient-recovery.test.js test/server.test.js test/lead-graph.test.js docs/adr/recovery-owner-grant.md .agents/teamwork/AD-04-recovery-20261106/handoff.md` - passed.

No live provider, activation, staging, or commit was used.

## Router-composition repair and final review

The first delta review found the production `DeliveryEngineRouter` hid the
legacy graph from `migrateLegacyRecoveryQuestion`, so the persisted obsolete
question could still be republished. The router now exposes a recovery graph
only for legacy mappings, and a successful migration suppresses stale stored
pause metadata before resume validation. The composed router/executor regression
also verifies the old interrupt is retired and stale decision metadata is not
forwarded. Sol approved this delta. Focused migration tests passed 2/2, router
tests 13/13, and diff checks passed. The full `test/server.test.js` run remains
incomplete: it stalled on a pending promise after 105 seconds (19 passed, 0
failed, 1 cancelled). Sol independently reran 3 focused server tests and the 13
router tests. No full server-suite success is claimed.
