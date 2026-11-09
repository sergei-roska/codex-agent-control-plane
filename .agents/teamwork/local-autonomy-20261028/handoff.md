# Local autonomy implementation handoff

## Status

Implementation is in progress. Existing native lane code is preserved. Root owns live settings and service operations; no live settings, process, account, provider, or Git changes were made by this worker.

## Implemented in this continuation

- Acceptance comments now describe App Server command execution without claiming read-only workspace behavior. Unknown pending App Server commands remain protected by `trackAppServer` and preserve the mirror for reconciliation.
- Full-access agent acceptance resolves against the original project workspace while check execution and snapshots stay on the frozen mirror. Tests cover allowed profile use, mirror mutation rejection, and pending-command retention.
- Full-access read-only role requests keep the private candidate cwd while policy trust resolves against the original project workspace.
- Added targeted checks for real permission resolver allow/deny behavior, App Server loaded-thread policy upgrade and denial, scoped verifier policy binding, writer lane selection, finalization setting persistence, preflight, and truthful lead prompt projection.
- Added a composed fake-provider server test that starts under full-access settings, reaches coordinator and scoped verifier, executes the agent final check with `:danger-full-access`, and accepts only after candidate-bound checks.

## Latest verification

Passed:

- `env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='explicit full-access requires|defaults execution permissions|owner full-access upgrades|owner full-access final checks|pending full-access App Server|owner full-access read-only roles|owner full-access selects|owner full-access composes|preflight hashes verifier IPC|owner full-access prompt|owner full-access is host-bound' test/execution-permissions.test.js test/project-settings.test.js test/codex-app-server.test.js test/delivery-acceptance.test.js test/delivery-role-service.test.js test/writer-lanes.test.js test/server-delivery-engine.test.js test/verification-preflight.test.js test/lead-graph.test.js test/delivery-role-capabilities.test.js` - 11 passed, 0 failed.
- `env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='finalization pins preserve the owner-selected full-access setting' test/backlog-store.test.js` - 1 passed, 0 failed.
- `env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/acceptance.test.js test/delivery-acceptance.test.js` - 69 passed, 0 failed; required filter test skipped by pattern.

## Remaining

- Add final-check test proving managed policy is re-resolved before every full-access check; second-check denial must stop before the second exec and never downgrade.
- Run affected focused checks after that change, inspect final diff/source ownership, write exact hashes and final test evidence, then request critic freeze review.

## Final scoped deltas

- Full-access final-check policy is freshly resolved immediately before each agent command. If the managed profile is denied between checks, the next command is not sent and no restricted fallback is used.
- The scoped-verifier strict regression fixture now mints a strict capability, preserving exact mode binding. Added a real App Server wire test for scoped full-access verifier permissions, never approvals, and rejection of candidate mutation before another thread/turn request.
- Acceptance error wording now describes the configured App Server route and does not claim a sandbox when full-access is selected.

## Latest post-change verification

- `env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/acceptance.test.js test/delivery-acceptance.test.js` - 70 passed, 0 failed. The named prohibited test was excluded by the skip pattern.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='owner full-access composes coordinator' test/server-delivery-engine.test.js` - 1 passed, 0 failed.
- `env -u NODE_TEST_CONTEXT node --test test/delivery-verifier-integration.test.js` - 14 passed, 0 failed.
- Earlier scoped set remains 11 passed, 0 failed; finalization pin test remains 1 passed, 0 failed.
- `git diff --check` for owned implementation and test paths passed.

## Review state

`startup_permissions_critic` approved with no remaining blocker; review evidence is in `review.md`. Critic reports 16 cross-path tests and 4 acceptance policy tests passed, and all 25 listed handoff hashes match. Root's account permission probe is separately reported by root; this worker did not call a real model or change live settings.

## Freeze hashes

Source:

- `src/acceptance.js` ba03fd0473b32317fb6eddc4b3ff283d5f5512f5990bc61aacc8d0e5fd84c768
- `src/delivery-acceptance.js` 09f0ce7f6fb720a70b58e794f1e763edebc7b5210cedf976516ecd57d1b6a166
- `src/delivery-role-service.js` 76e5aacdcbc453e8c188e3272f8cc19af313b046043281d134fdf81e00f36df0
- `src/backlog-store.js` 9b828e3c47687c28c54c644a730249df8d08aba6056836d88e086ec59640e4cb
- `src/lead-graph.js` 5c3156c8dcaf6068fe33e301eefbda81082eb88c049a487dad1b9c8915ca291e
- `src/project-settings.js` 8c7724d4b82f2698a0fafcbd95b0123120aa9b672bcd581b399e9c5f0f0c2d9d
- `src/execution-permissions.js` 54a40ddd1c4bdeedbddaff2b5b9aefdc1450c966ae256251130c99b91d780349
- `src/codex-app-server.js` 67ce0c32b2e37816f79dc5bd1ad3b587292af8030d56278e72cb545005d699c1
- `src/concurrent-delivery-engine.js` 4de277782459c45c387148893d7d5a111a25636656ed1f04b4e0864f4198e6ff
- `src/delivery-role-capabilities.js` be50198950858ed59287f5c33563ed33a36141b4aee434bac3e1e30051409ca9
- `src/verification-preflight.js` d1fd4baf7593484082bc3ac08ca97f6b83d6d069563850f0ddf7ce66d69400eb
- `src/writer-lanes.js` 3c8409a8815c51dc64c5bd31e1fd3f85199871ac336e64ad3cfce63c47bc93b2

Tests:

- `test/acceptance.test.js` 9e7b1fd46953a0f5357b42385ce142e50d34bcef25e57fafe5edf6e7d7432b01
- `test/backlog-store.test.js` b7fa40b23876a144f714afc24ef2266d929dd3415a68306c04e50bf987682656
- `test/codex-app-server.test.js` 74b3337a56f5fff1ae0b9aeb1e7ae2be970c03df7b617615ee0891a2d4a30c0e
- `test/delivery-acceptance.test.js` 08a6588055d460955f83d5f0574bcce71084e4eda5ed12aebd33d342de43dcd1
- `test/delivery-role-capabilities.test.js` 761b64fe154ae148d20f8e602fb8d7f8430c997f1cb566667dcf9eecdfa09028
- `test/delivery-role-service.test.js` 32756537883f13ba8012a791a7209439a5869ddca44724df13a03274753ccbf7
- `test/delivery-verifier-integration.test.js` 6a352a36be4c700504148f1d28f1423230e82f744ed3db5f8d8ab3aed8e30ad8
- `test/execution-permissions.test.js` 2fb727aa8fe26130627e0b96fc371e935b38555def0a2d95d24b89606474c09a
- `test/lead-graph.test.js` 802150c5ee409eeb3eba897312ead527a0a7c724f1a0f52a9a2486a53e4fbe14
- `test/project-settings.test.js` 29ae8bf2146840a9d214567241cc69bbd2fbd5a8e7c2cc5a88b9163dc6113f82
- `test/server-delivery-engine.test.js` f72bec701363fc440de6ff55c67bed12eb39c70b84029fb5d8915c5ad8ab7bb1
- `test/verification-preflight.test.js` 0ce812f952a4a1eefd9e06b9a7c809d809407d089586cf036d40bbb00c5aa2e1
- `test/writer-lanes.test.js` 5ba0593353c5ca51315e08bee669d942b3dda49555f6359bf26aba5a3266fd71
