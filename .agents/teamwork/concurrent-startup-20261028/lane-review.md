# Native workspace-write lane review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Read: actual git diff and final frozen source/tests for the lane adapter,
selection, prepareThread/run, request send boundary, and both legacy and
concurrent role callers. Reviewed the new opaque capability module directly.
No assertion weakening, hardcoded production result, swallowed failure or
unfinished stub was found in the lane delta.

The adapter maps the implicit original workspace root to the exact current
host-admitted lane. Explicit native roots retain their separate provenance,
including an explicit duplicate of the original root. Native approval policy,
reviewer and temp exclusions remain intact. Ordinary writers preserve native
network access. The canonical writable verifier retains the existing IPC
network exception as the lead explicitly decided; this also preserves behavior
when legacy-engine verifiers begin using the newly supported lanes. Concurrent
scoped verifier handling remains separate.

Capabilities are opaque WeakMap identities. JSON cannot forge them. Source/cwd
canonical paths, prepared/running row, and unfenced context are checked. Native
settings refresh bypasses cached config reads before thread operations and
turn admission; policy drift rejects. The synchronous send callback rechecks
lane identity/fence after onTurnStart, preventing a newly fenced lane from
sending turn/start. Fresh, prepared, reused and resumed paths were inspected.
Modern named/custom workspace profiles retain the current unsupported selection
behavior; existing strict/full-access paths remain covered by focused tests.

Ran independently before the final discriminator-only correction:

- `env -u NODE_TEST_CONTEXT node --test test/writer-lanes.test.js test/codex-app-server.test.js`: 162/162 pass, zero failures/skips.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='concurrent setting fails closed when startup selects unsupported shared isolation|default server composition routes an authenticated steer into a held real concurrent lead turn' test/server-delivery-engine.test.js`: 2/2 pass.
- Scoped git diff --check: pass.

Re-reviewed the final discriminator correction: actual resolver output uses
profileApi=false for legacy and true for modern profiles. Capability binding
and the app-server legacy discriminator now require exactly false. The selector
delegates to that binding and rejects a modern missing-writer-profile shape.
Positive fixtures now match real legacy output; the new negative assertion
checks the mixed modern shape remains shared/unsupported.

Ran on the final hashes below:

- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='trusted inherited legacy workspace-write|native lane capability|actual legacy config selection|mode selection: shared' test/writer-lanes.test.js test/codex-app-server.test.js`: 5/5 pass.
- The same selected server startup command above: 2/2 pass.
- Scoped git diff --check: pass.

The earlier 162-test independent run is historical evidence on the preceding
freeze; the affected named checks above validate this small final correction.

Read regression evidence includes native extra roots and exclusions, prepared
and resumed outgoing policies, ordinary network=false versus verifier=true,
wrong source/cwd, forged JSON, changed native settings, integrated lane expiry,
and fencing from onTurnStart before the transport send. The actual-resolver
fake-RPC test constructs a real disposable Git lane, changes native config
after thread/start, and observes no turn/start. An earlier independent
same-realm fake-RPC probe also confirmed native approval drift rejection; its
pre-fix verifier network=false result was the basis for the resolved IPC issue.

Limits: this is offline source/wire-policy qualification. It does not prove a
live provider accepts the adapter, launch or resume the paused legacy run, or
establish dependency/cache availability. Cooperative lanes are not confinement;
explicit native roots may authorize access to the shared workspace. Root owns
the final integrated affected/full verification.

## Verified SHA-256

- src/lane-execution-policy.js: 5d9182e7c0899b529c0b492e84dffa70d02cf971917ca66f1fa2f95bc9c2483a
- src/writer-lanes.js: 12ae908f09065a9ad2e4e85f8914f3bc1a961baae3d826c2a7ccbe423b82ce6a
- src/codex-app-server.js: a2610224030ab97d58ec469763d44b2f6adb0dd3771220b4ac6f494ae88cf92c
- test/writer-lanes.test.js: 9005bc5a92d71e15dcba9cebfda71aed0881c6764fea98c365a6066bb76642e6
- test/codex-app-server.test.js: 1c3854f4b1eced4ce95761d8befb2a9f2675861a5444ae19934ff6486b6b4d42
- test/server-delivery-engine.test.js: 1dddef4bcede67cea456d1246292614ab73da39b817e1f20d0a0b4209857c25e

No live providers/services, config/application data changes, prohibited named
test, broad suite or Git mutation were performed by this review. Evidence
reports are local ignored teamwork artifacts and may disappear.

Pitfall: preserve explicit root provenance when remapping an implicit workspace
root, and retain established role-specific policy exceptions in the new path.
