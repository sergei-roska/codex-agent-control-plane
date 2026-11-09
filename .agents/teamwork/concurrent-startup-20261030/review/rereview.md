# Re-review: concurrent startup settled replay

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

## Findings resolved

- Read: src/delivery-role-service.js:269-278 now requires identical current/saved settings key sets and reconstructs historical values in the trusted settings resolver insertion order before validating the existing settings digest. The ordinary persisted sorted-key record passes without rewriting or migrating its digest. Shape/order incompatibility refuses the exemption.
- Read: test/delivery-role-service.test.js now snapshots the actual backlog/executor states before unsettled provider-drift refusal and asserts those states remain unchanged. Its shutdown fixture pins accountId consistently before dispatch in both the service and executor.

## Verification

- Ran independently: node --test test/delivery-role-service.test.js
- Result: 49 passed, 0 failed, exit code 0.
- Evidence: role-service-rereview.tap (local ignored evidence).
- Confirmed unchanged source/test hashes before and after the run:
  - src/delivery-role-service.js: e7bfab214a10eb166c0f719a4230588efd0bcf94ab8aa0d906e5ab6f4a655f43
  - test/delivery-role-service.test.js: b286cc769f1eea0533958ad7f2200a6c134e1b24ae300f90bc0994320d604c04
- The run includes successful settled replay under provider/role settings drift without role-record rewrite/provider reinvocation; rejection before settlement; tampered settled cleanup receipt and shutdown digest refusal; original group-death, drift-preservation and executor replay checks; historical recovery identity/publication/pin negative checks.
- Read: terminal replay exemption is restricted to settled/proven role record, failed/canceled attempt with exact shutdown proof reference, released claim and settled executor row. Identity/request/contract, publication/lane/start receipt, cleanup receipt, shutdown digest and process-group validation remain in the call path. The fast replay return re-enters terminalFailureProofFor and prepareTerminalShutdown, so digest and original process-group death still run.
- Reviewed delta limited to the two frozen files. No reviewed files, live services or live database data changed by this review.

## Acceptance boundary

This approves the scoped startup recovery code repair. It does not attest launcher-managed live startup or full delivery acceptance. Root owns the live startup and state-preservation checks.

Non-blocking: The insertion-order compatibility rule intentionally fails closed when the settings resolver key schema/order changes; future settings migrations must account for historical shutdown proofs.
