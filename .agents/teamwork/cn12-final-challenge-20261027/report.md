# CN12 bounded join challenge

Verdict: HOLDS
Status: complete
Scope expansion: none

Command: `node .agents/teamwork/cn12-final-challenge-20261027/probe.js`
Result: exit 0; three PASS lines.

- Two independent SQLite handles and full typed adapter stacks called finalizeCandidate with the same request while the first runner was held at admission.acquire. The second returned checking, the first accepted after release, and exactly one admission occurred.
- Owner authorization was revoked from inside admission.acquire after begin/start checks. The actual runner result reached ready, but commit and a later replay both raised finalization_unauthorized. Objective remained validating and no terminal candidate reference appeared.
- A SQLite trigger rejected insertion of objective.accepted at the terminal event boundary. The call failed, the record stayed ready, the objective stayed validating, the barrier reference remained, and no terminal reference appeared. After removing the trigger, replay committed accepted without running checks again.

No failure was observed. The probe reuses the join test fixture setup copied into scratch, with source imports adjusted only for the scratch location. It does not run the excluded hostile Git filter test or change product source, existing tests, fixtures, or configuration.
