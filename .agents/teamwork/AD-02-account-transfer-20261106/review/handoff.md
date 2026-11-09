# AD-02 legacy account-transfer qualification review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Scope

Reviewed the new `test/account-failover-context.test.js` in full, its implementation brief/handoff, current project/backlog acceptance, and the production continuation, account selection, thread rollover, acceptance, and binding paths. The test is untracked, so its full contents were inspected directly; existing tracked diffs show no AD-02 changes to budget-watcher/session-threads. The lead-graph diff is the separately reviewed AD-01 binding work. Approval is for this deterministic settled-read-only legacy milestone, not all AD-02 scenarios or live provider qualification.

## Criterion evidence

1. PASS (read + ran): lines 81-99, 126-140, and 160-183 instantiate real account profiles, switching wrapper, SQLite DispatchJournal/checkpointer, SessionThreads, LeadOrchestrator, and budget watcher. The fake seams are provider responses, A2A client responses, timer scheduling, and the acceptance command executor. No mock orchestrator replaces continuation.
2. PASS (read + ran): account A returns a dispatch then throws a classified usage limit. The test observes waiting_for_budget, captures the stored completed outcome/contract/session, and invokes the watcher's scheduled check. Production `budget-watcher.js:135-211` selects an available alternative under autoSwitch and invokes resumeRun; the injected callback calls real orchestrator.resume without owner input. Production `lead-orchestrator.js:461-486` resumes the checkpoint rather than calling run again. Assertions verify the same run/context/check ID, a new checkpoint, and exactly one retained outcome for the settled assignment; provider call sequence is A, A, B.
3. PASS (read + ran): production `lead-graph.js:2915-2946` only reuses the stored session thread when profile/home still match, otherwise sends the full decision prompt. The fixture asserts A retry uses A's thread, B receives no thread ID, B's prompt includes the completed worker summary, and B keeps the original workspace. The durable session is updated to B's home/thread with exactly one rollover. Production assess routes the pinned owner contract through runAcceptance (`lead-graph.js:4395-4422`), whose required-check loop invokes the injected check executor (`acceptance.js:721-786`) before computing accepted disposition. Final contract/check ID and accepted status are asserted.
4. PASS (read + ran): real journal call bindings for the run contain the SHA-256 account-A/account-B hash set, and no binding value equals either synthetic raw ID (test lines 215-219). The wrapper supplies captured generation hashes and separate lead attempt IDs via the already reviewed AD-01 boundary. This is configured identity evidence, not provider-loaded identity proof.
5. PASS with explicit evidence limits (read + ran): temporary workspace/profile/state data is registered for cleanup; SQLite and wrapper have teardown hooks. No real CLI, quota, credential, account/read, or external provider thread is used. Existing source mechanisms were sufficient; no production source fix is represented as part of this milestone.

## Verification

Independently ran:

`node --test test/account-failover-context.test.js test/budget-watcher.test.js`

Result: 33 passed, zero failed/skipped. The new integration test passed in approximately 188 ms. Reused the prior independently passing wrapper 17/17 result; wrapper inputs have no AD-02 changes. The implementation handoff additionally reports a combined 50/50 transfer/budget/wrapper run and honestly records one isolated-wrapper deadline failure before its passing rerun.

No reviewed source/tests, fixtures, or main repository Git state were changed during review. The only review write is this report. Test-internal Git operations are confined to its disposable temporary workspace.

## Non-blocking evidence boundaries

- `test/account-failover-context.test.js:136-139` injects a passing check executor. This proves retention and traversal of the pinned acceptance pipeline, not actual execution of verify.js. Interpret the implementation handoff's phrase "runs the pinned check" accordingly; no command-execution qualification is established here.
- The fixture uses a settled read-only worker. No live writer, uncertain effect, authentication recovery, all-account exhaustion, concurrent-engine failover, or process restart is exercised; the backlog appropriately leaves broader cases open.

Blocking: none.
Next action: lead records this scoped milestone and continues remaining AD-02/03/08 qualification without broadening the evidence claim.
