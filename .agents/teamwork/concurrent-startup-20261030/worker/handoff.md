# Worker handoff

Status: scoped repair implemented; product files frozen pending critic re-review.

Read-only evidence from `.runtime/projects/3d9c2e759c/state.sqlite`: both `provider_closing` attempts have settled role/executor records, terminal shutdown proofs in `proven` phase, failed backlog attempts with matching terminal proof references, and released claims. Current account/home differs from both saved provider pins; model, effort, fast mode, execution permissions, skills, and MCP selections match. The rejection was `canonical(provider) !== canonical(record.providerIdentity)` in `#noPublicationRecoverySnapshot`, before receipt replay.

Historical replay is permitted only when the role record is settled and proven, the executor row is settled, the backlog attempt is failed/canceled with its exact proof reference, the claim is released, and historical provider/settings pins validate. The saved settings key set must match the current resolver; saved values are rebuilt in resolver insertion order before checking the legacy insertion-order-sensitive digest. Canonical record persistence sorts object keys. Unsettled or unproven attempts keep current provider/settings validation. Successful replay returns the prior proof without rewriting role history; task, execution, receipt, digest, lane, publication, and process checks still run.

Focused verification: `node --test --test-name-pattern='settled terminal shutdown|terminal shutdown recovery still rejects provider drift|terminal failure requires independent original group death' test/delivery-role-service.test.js` passed 5/5. This covers settled replay under provider/role drift, drift refusal before settlement, tampered cleanup receipt, tampered shutdown digest, and the existing process-death/drift proof path. Read-only resolver-order reconstruction matched both persisted settings digests and historical provider pins; current provider mismatched both records. No broad suite, service start, live DB write, or model call was performed.

Frozen product hashes: `src/delivery-role-service.js` e7bfab214a10eb166c0f719a4230588efd0bcf94ab8aa0d906e5ab6f4a655f43; `test/delivery-role-service.test.js` b286cc769f1eea0533958ad7f2200a6c134e1b24ae300f90bc0994320d604c04. Critic re-review and root-owned launcher validation remain pending.

Live database was opened read-only for diagnosis. Do not start services or write the live DB; root owns runtime validation.
