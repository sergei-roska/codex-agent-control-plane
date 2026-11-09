# CN-05 challenge, final identity re-check

Verdict: HOLDS
Status: complete
Scope expansion: none

## Exact probes and results

- `node /tmp/cn05-task-identity-probe.js`: caller task mismatch returns `task_identity_mismatch`, zero sends, no intent.
- `node /tmp/cn05-control-pause-probe.js`: submitted work remains cancellable after pause; trusted poll settles and duplicate terminal is idempotent. Capacity releases only after settlement.
- `node /tmp/cn05-final-identity-probe.js`: natural send acknowledgement pins `thread-A`; terminal on `thread-B` returns `thread_identity_mismatch` and capacity remains 1. Two attempts requesting one known thread produce one send; second returns `provider_thread_busy` with capacity 2. The default project transport key groups engineer and verifier, so shared failure marks both uncertain and retains capacity 2. Explicit independent role keys isolate the failure: engineer uncertain, verifier submitted, capacity 2.
- `node --test test/task-executor.test.js test/backlog-store.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 65 passed, 0 failed.

I inspected only the new thread reservation, first-observed thread pin, project-default transport key, explicit key handling, and prior task/control repairs. The observed thread is stored on the local intent before later terminal validation. Known thread reservation is transactional; the duplicate known thread is refused before the second send. No additional failure was found in this bounded local fake transport gate. The `/tmp` probes may disappear. Real service and successor scheduler/wiring are not qualified.
