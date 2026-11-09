# Recovery evidence challenge

Verdict: HOLDS within the real store trust boundary. The forged-reference probe demonstrates a bounded integrity limitation only under a fabricated return from the trusted evidence store; it does not establish an actual contract violation or a mandatory-check bypass.

## Probe and evidence

`forged-ref.test.js` copies the V43 composed fixture and wraps `engine.evidenceStore.put` while the investigation is held. It calls the real store, then replaces the first verifier stdout ref's ID with `ev_00000000000000000000000000000000` while retaining `contract: evidence-ref/v1`. The run executes the actual repaired-candidate check and completes accepted. Its persisted verifier proof contains the nonexistent ID. The assertion requiring the forged ID to be absent fails. No store row with this injected value is created by the wrapper. The engine checks only ID syntax and does not resolve the reference or confirm its run, check, and stream binding. Impact is a false durable evidence link in the accepted verifier proof, not proof that the check was skipped or failed.

Reproduce from repository root:

```
node --test --test-reporter=tap --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' .agents/teamwork/cn15-recovery-20261028/challenge/forged-ref.test.js
```

Hypothetical defense-in-depth expectation: reject or omit an unresolvable reference. Actual: accepted objective and persisted verifier proof containing the injected reference; assertion fails. This is not counted as a product failure because the real trusted producer does not return that fabricated object.

`malformed-ref.test.js` injects `ev_invalid` at the same point. No proof is persisted, objective remains executing and scheduler parks with `concurrent_owner_check_evidence_invalid`. The assertions succeed, but test command exits 1 in teardown with `concurrent_shutdown_unsafe` because the verifier is parked. This is not counted as a source failure or a clean test pass. Command is identical with `malformed-ref.test.js` substituted.

## Trust boundary and string compatibility

The real `createEvidenceStore.put` generates and validates an ID, inserts a row inside a database transaction or selects an existing row matching run, attempt, task, check, kind and content digest, then returns `refFromRow` from that actual row. Its errors are caught in `storeCheckStream`; a fabricated successful return is not produced by that implementation. Stored payloads can be omitted on quota or expire later, both explicit store states, so a valid reference does not itself promise permanent readable bytes. The normalization trusts this host-owned producer and validates object ID syntax rather than independently resolving it. Strings of 1-1000 characters remain accepted as preexisting compatibility references without `ev_` syntax or lookup checks. No user/provider path to choose these engine-owned check results was identified.

## Inputs

- `src/concurrent-delivery-engine.js`: afbdf9bdf0bea1001647c98b99e7e978eb60bc2f58ea5b76163cd6bd15c71280 before probing; 1509274e3fd57b0330a0caf7183624269464f71ff012f32e8f9a56ba575c2d1d after probing, due to concurrent terminal work. Exact source timing across probes is not frozen.
- `test/concurrent-recovery-acceptance.test.js`: a467ec0a8d70c8f924ca2593fb6df89c8e4bc4079292c95dd17c3650ea5dd137
- `src/delivery-role-service.js`: f2182cfef9df24484fe19020ac9ebbd27716ce090db8c75f8647ecc002d48346
- `src/acceptance.js`: 80a2d6760def4b806854c1670e7463c61bcab63f9120664413f1651b8bc8684a

Scratch probes remain available under this directory. No product or existing test files were changed. Disposable V43 fixture cleans its own files; no live services were used. The independent server shutdown work may change input hashes after this report.

Status: complete
Scope expansion: none
