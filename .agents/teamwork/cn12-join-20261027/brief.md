# CN-12 join worker notes

## Scope

Implement the single `finalizeCandidate` adapter in `src/delivery-acceptance.js` and its real-module join coverage in the new `test/delivery-acceptance-join.test.js`. Root owns Git and tracked docs. Do not edit the typed stores, run hostile inherited-Git filter test, start services, or stage/commit.

## Contract

Validate the acceptance contract and its source, digest, required check IDs, and settings against the request before the runner. Join only through the typed `BacklogStore` APIs and actual `runFrozenCandidateChecks`. Keep trusted store callbacks default-deny. Durable `checking`/`unknown` states cannot be retried absent trusted typed reconciliation. Unknown runner effects must retain and record workspace/control paths. Terminal replay must reauthorize and run zero checks. Partial acceptance stays within trusted store provenance.

## Owned files

- `src/delivery-acceptance.js`
- `test/delivery-acceptance-join.test.js`
- `.agents/teamwork/cn12-join-20261027/brief.md`
- `.agents/teamwork/cn12-join-20261027/handoff.md`
