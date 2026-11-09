# V14 independent source review

Verdict: REJECT
Status: complete
Scope expansion: none

Reviewed current six production sources and scoped owner decision tests against
v14-decision-final.md and its replacement amendment. Git diff/status inspected;
six production files are inherited untracked additions, so no tracked per-file
patch exists. Current source hashes match the worker freeze message.

## Blocking

1. src/backlog-store.js:763 and :1421: direct public requestControl bypasses
   pending-decision resume protection. Ran an in-memory probe using the existing
   owner-decision fixture: register -> requestControl pause revision2 ->
   requestControl resume revision3 produced executing/cause active/pending true.
   A valid current-pinned answer then failed owner_decision_controlled. Checked
   transitionLifecycleControl:781: its protection covers only that wrapper;
   claimReady, planner and finalization guards still prevent admission but do not
   repair this dead-end control state. Add the resume protection to shared
   #requestControl and cover direct public calls.
2. test/owner-decision-restart.test.js:199: same-run pending SQLite reopen ->
   valid answer -> mandatory acceptance remains unverified. Read: the reopened
   owner-restart-run is corrected/replaced/resolved only. Acceptance is asserted
   on a new owner-restart-acceptance-run created after restart. Restart again while
   this second run is pending, verify immutable request and no provider calls,
   then answer and accept that same run.

## Integrity and bounded evidence

Read: concurrent engine replacement/reopen fixture assertions remain meaningful:
resolved ledger, active disposition, no finalization, and no verifier invocation.
The changed-goal fixture requires replanning; swapping an engine under existing
Express role routes is not a faithful resource restart. Their narrower assertions
are honest, provided the missing same-run real host restart acceptance is added.
No evidence of production hardcoding, swallowed test failures, or trivialized
assertions was found in the reviewed paths.

Read: source implements exact authenticated request/replacement scope and pins,
committed message duplicate lookup before revision checks, pause/stop retention,
cancel rejection, pending planner/claim/finalization guards, and separate immutable
investigator provenance for replacement. Selecting an option does not write
publication authority or requirement correction.

No broad tests ran. The decisive independent direct-store probe above reproduced
the blocker. Worker reported 160 scoped passes; this report does not treat an
author's run as independent verification. Further focused tests await the fix.
