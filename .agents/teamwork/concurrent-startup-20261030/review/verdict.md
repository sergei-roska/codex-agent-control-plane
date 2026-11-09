# Review: concurrent startup settled replay

Verdict: REJECT
Status: complete
Scope expansion: none

## Blocking findings

1. src/delivery-role-service.js:269: Settled historical attempts do not pass the new replay gate after persistence. Read: backlog-store.js:37 defines stableDigest as SHA-256(JSON.stringify(value)), which preserves object insertion order. DeliveryRoleService.#set persists records via canonical(), sorting selectedSettings keys. Read: #recordInitial computes settingsDigest before canonical persistence. Ran: the new positive replay regression fails with delivery_role_recovery_proof_unavailable and its diagnostics show settingsDigestMatches=false while all terminal, executor, claim, and proof-reference conditions are true. Fix: validate the original settings digest using a compatible trusted representation/order while retaining historical pin integrity; do not equate this with a canonical digest.

2. test/delivery-role-service.test.js:694: The unsettled drift regression asserts backlog state submitted, but the fixture's attempt is running. Ran: this assertion fails after the intended drift refusal. Fix: assert the actual pre-call state is preserved, and retain the strict rejection assertion.

## Evidence

- Ran: node --test --test-name-pattern='settled terminal shutdown|terminal shutdown recovery|terminal failure requires|shutdown proof|shutdown observation' test/delivery-role-service.test.js
- Result: 5 tests, 3 passed, 2 failed; exit code 1.
- Log: role-service-focused.tap (local ignored evidence).
- Reviewed source hash: 1de150af8236f970e1670f2cfad7d2ba84d2c21cc53fab520b52cf90ef181da9
- Reviewed test hash: 584f1680a071a303375078215fc27c0498c10f6bbdab5872626af62c3b87fba9
- Read: unchanged identity, contract/request, publication/lane/start receipt, cleanup receipt, shutdown digest and process-group checks remain after the replay gate. The replay fast return calls terminalFailureProofFor, which revalidates shutdown snapshot/digest/process proof. No live service start or live DB write performed.
- Scope checked against task baseline only. Other inherited dirty files excluded.

Pitfall: Do not recompute an insertion-order-sensitive digest from a canonically serialized nested object.
