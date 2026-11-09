# AD-06 acceptance milestone review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Evidence and scope

Read the actual diffs in test/backlog-store.test.js and test/concurrent-delivery-engine.test.js, the implementation brief/handoff, AD-06, and the production gates. No reviewed source/tests or Git state were changed. Unrelated composed-router restart coverage and concurrent status projection changes were excluded from acceptance scope; the latter do not change the inspected finalization gates.

Reused the implementation's 134/134 focused-suite result as supporting evidence. Independently ran:

`node --test --test-name-pattern='a stale dependent target output identity|a queued successor blocks accepted finalization|stale check receipts and missing mandatory checks|unknown worker effects survive SQLite reopen|concurrent engine accepts its pinned base candidate with required owner checks|overlapping private engineer lanes unlock' test/backlog-store.test.js test/concurrent-delivery-engine.test.js`

Result: 6 passed, 0 failed, 0 skipped (3274.623533 ms).

## Criterion evidence

1. PASS. test/backlog-store.test.js:1210 creates required queued work, calls the real accepted-finalization boundary, expects finalization_blocked, and asserts no finalization was recorded. At :322 a settled, trusted predecessor with an output contract different from the dependency's expected output cannot unlock the queued successor. Read source: src/backlog-store.js:1735 includes pending tasks and unsettled attempts in readiness blockers, and :89 compares the expected output against trusted settled output.
2. PASS. test/backlog-store.test.js:1226 executes real frozen checks before altering only the decisive receipt field: empty checkResults rejects with finalization_required_checks_not_passed; a different candidate identity rejects with finalization_check_result_pins_stale. Both barriers stay checking. At :1041 an expired submitted attempt remains unknown after SQLite reopen, its task remains settling, and accepted finalization is blocked with no terminal record. The existing unknown-check reopen test also now asserts commitFinalization fails. Read source: :1850-1874 pins result identity and requires every mandatory check to pass; :1735-1739 rejects unknown attempts.
3. PASS. test/concurrent-delivery-engine.test.js:284 saves the accepted terminal and full finalization records, closes SQLite, reconstructs the engine/stores, asserts current qualification, compares the full finalization record (including terminalDigest), resumes the same run with identical result, and compares the terminal record again. This verifies durable fingerprint and result replay against real reopened stores.
4. PASS. Existing executable overlapping-lanes test at test/concurrent-delivery-engine.test.js:454 reads fast.txt from the dependent worker's private workspace, asserts its content at :626, verifies candidate generation 2, and at :643 compares the worker's baseCandidateId to the published predecessor candidate. It subsequently publishes and verifies the combined candidate. The separate stale-output test at test/backlog-store.test.js:322 supplies the required negative target-output identity case. This is component/composed-engine evidence, not a live release-path qualification.
5. PASS. AD-06 adds real negative assertions, executes checks, reconstructs durable stores, and compares complete records. No finalization production gates were changed or weakened. Test adapters are isolated dependencies; the decisive store and engine gates execute normally.

## Non-blocking limitations

- The queued-successor test title says "after a finish claim", but the body directly requests kind=accepted; it does not submit a worker goalAchieved narrative. Its executable evidence establishes the finalization gate, not a separate narrative parser path.
- The unknown-worker reopen test also supplies effectsSettledForShutdown=false, so the blocker assertion does not isolate the unknown-attempt predicate from the shutdown-effect predicate. Persistence is directly asserted and both independent production blockers were inspected.
- Full release-path integration, live provider behavior, and AD-08 qualification remain outside this milestone; this approval does not close the full autonomous-delivery backlog.

Next action: lead may accept this AD-06 test milestone and preserve the explicit AD-08 release-proof requirement.
