# AD-04 recovery acceptance review

Date: 2026-11-06. Final verdict: APPROVE after repair and delta review. The
initial rejection and intermediate router-composition finding are retained
below as review history.

## Blocking findings

1. At the transient retry cap, `src/transient-recovery.js` persists `waiting`
   with `next_attempt_at: null`, schedules no timer, and refuses capped rows on
   startup. No production caller starts another attempt. `src/server.js`
   nevertheless projects this as automatic and says the server will retry.
   Required: retain a durable scheduled recovery action using a bounded slow
   backoff and report the actual next action/time.
2. The persisted `supported_controller_replan` owner-grant question is
   threshold-only. It can be resumed with empty evidence and continues after
   restart. The newer AD-04 backlog rule supersedes the older ADR. Required:
   migrate/retire such pending questions into nonterminal technical replanning,
   preserve objective/checkpoint/receipt fences and genuine owner decisions,
   and mark the old ADR contract superseded.

## Criteria that passed in the reviewed delta

- Recovery, planning, loop, and default-round thresholds do not directly create
  accepted or terminal partial results.
- The stale-review tests assert nonterminal status, no partial/human request,
  and no acceptance run.
- The fresh cap prompt forbids threshold-only owner questions; no direct
  cap-to-question producer was found. The blocker is the persisted legacy path.
- Reused the reported full `test/lead-graph.test.js` 287/287 result. Ran the
  two decisive owner-grant/retry-limit named regressions, 1/1 each.

## Repair evidence

- Eligible capped transient retries now persist a finite, max-bounded next
  action and startup re-arms capped waits, including repair of legacy rows with
  a null timestamp. The existing checkpoint/effect gate remains unchanged;
  status text reports the stored next retry time.
- Legacy persisted threshold-only owner questions migrate to nonterminal
  technical replanning before task publication/resume. The graph also retires
  this path at `human_input`; valid evidence-backed owner-only decisions and
  receipt/checkpoint fences remain supported. The historical ADR is marked
  superseded.
- `node --test test/transient-recovery.test.js` - 10 passed.
- Named AD-04 server status/migration tests plus AD-02 adapter regression -
  4 passed.
- Named owner-grant/recovery restart tests - 8 passed.
- Full `test/lead-graph.test.js` - 288 passed in 19.2 seconds.
- Changed-file syntax checks and scoped `git diff --check` passed.

The stale full-file fixtures were repaired; the initial stall was not a live
production recovery dead end. See the [repair handoff](../handoff.md) for exact
commands.

## Final delta review

The first repaired delta review found that the production router did not expose
the legacy graph to migration. The follow-up fix added a mapping-aware graph
accessor, cleared stale stored pause metadata after migration, and added a
router/executor composition test. Sol approved the fix. See
[delta review](delta-fix-handoff.md) and [repair handoff](../review-fix-handoff.md).
Focused migration tests passed 2/2, router tests passed 13/13, and diff checks
passed. The full server suite remains incomplete due to a pending-promise stall.
