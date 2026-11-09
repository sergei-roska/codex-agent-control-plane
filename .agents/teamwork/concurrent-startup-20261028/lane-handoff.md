# Native workspace-write lane handoff

Status: implementation complete and frozen for independent review. No live
services, providers, configs, accounts, databases, installs, or Git writes were
touched.

## Implemented

- `src/writer-lanes.js` admits inherited legacy workspace-write as cooperative
  with no confinement claim. Modern profiles, read-only, unknown policies and
  unsupported shared modes remain unsupported. Capabilities require a current
  prepared/running lane row and an unfenced context. Eligibility requires the
  resolver's explicit `profileApi: false` legacy discriminator; modern or
  malformed profile bindings fail closed.
- New `src/lane-execution-policy.js` uses a WeakMap-backed opaque capability,
  binds the canonical original workspace and exact lane cwd, and preserves
  explicit native roots separately from the implicit source root. Mapping
  replaces the implicit root with the lane path while retaining explicit roots,
  including an explicit root equal to the source workspace.
- `src/codex-app-server.js` applies the mapping to prepared, fresh, reused and
  resumed native legacy turns. It refreshes the native permission binding
  before thread operations and immediately before turn/start, with a synchronous
  capability/path/lane-row check at the actual send callback. Native approval,
  temp policy and explicit roots are retained. The canonical verifier keeps the
  existing IPC network-access exception; ordinary writers retain the exact
  configured network flag. Non-capability overrides fail closed for legacy
  native workspace-write.
- Tests cover disposable Git startup selection, capability mint/revoke,
  prepared/fresh/resumed policy, explicit duplicate root and flags, mismatched
  source/cwd, forged JSON, stale policy, fence changes at send, full-access,
  read-only/shared reject, and actual resolver refresh detecting native
  approval/network changes after thread start. A profileApi=true missing-profile
  selection fixture remains shared.

## Verification

- `env -u NODE_TEST_CONTEXT node --test test/writer-lanes.test.js test/codex-app-server.test.js`:
  162/162 pass, 0 fail, 0 skipped.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='concurrent setting fails closed when startup selects unsupported shared isolation|default server composition routes an authenticated steer into a held real concurrent lead turn' test/server-delivery-engine.test.js`:
  2/2 pass, 0 fail, 0 skipped.
- `node --check` on the three source and three test JavaScript files: pass.
- `git diff --check` on all six owned source/test files: pass.
- Prohibited candidate-filter test was not run.
- Exact commands and counts are recorded in `lane-verification.log`.

Changed owned files: `src/lane-execution-policy.js`, `src/writer-lanes.js`,
`src/codex-app-server.js`, `test/writer-lanes.test.js`,
`test/codex-app-server.test.js`, `test/server-delivery-engine.test.js`.

## Frozen SHA-256

- `src/lane-execution-policy.js`: `5d9182e7c0899b529c0b492e84dffa70d02cf971917ca66f1fa2f95bc9c2483a`
- `src/writer-lanes.js`: `12ae908f09065a9ad2e4e85f8914f3bc1a961baae3d826c2a7ccbe423b82ce6a`
- `src/codex-app-server.js`: `a2610224030ab97d58ec469763d44b2f6adb0dd3771220b4ac6f494ae88cf92c`
- `test/writer-lanes.test.js`: `9005bc5a92d71e15dcba9cebfda71aed0881c6764fea98c365a6066bb76642e6`
- `test/codex-app-server.test.js`: `1c3854f4b1eced4ce95761d8befb2a9f2675861a5444ae19934ff6486b6b4d42`
- `test/server-delivery-engine.test.js`: `1dddef4bcede67cea456d1246292614ab73da39b817e1f20d0a0b4209857c25e`
