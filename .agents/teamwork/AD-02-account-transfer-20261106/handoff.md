# AD-02 legacy account failover context transfer

Status: focused legacy qualification test implemented; no source fix required.

## Verified behavior

- `test/account-failover-context.test.js` runs one real `LeadOrchestrator` over
  SQLite checkpoints and the real switching wrapper, with disposable profile
  homes and deterministic fake providers.
- Account A completes a read-only worker task, then reports a model usage limit.
  The budget watcher selects available account B and resumes the same run and
  context without owner input.
- The pinned check and settled worker outcome remain in the checkpoint; the
  workspace scope stays the same; the settled outcome is not duplicated.
- The A retry uses A's thread. B receives no thread ID, writes a fresh B thread
  with B's home to `session_threads`, and its durable provider-call binding has
  B's account hash. Durable bindings include both A and B hashes only; raw IDs
  are absent.
- Acceptance runs the pinned check against a disposable committed workspace;
  it returns `accepted`.

## Verification

Command: `node --test test/account-failover-context.test.js test/budget-watcher.test.js test/app-server-switch.test.js`

Result: 50 tests passed, 0 failed, 0 skipped. `node --test
test/app-server-switch.test.js` also passed 17/17 when run alone after one
combined-run timeout in its existing cross-home race test; the combined command
then passed 50/50 on rerun.

Changed paths: `test/account-failover-context.test.js` and this handoff. No
production source changes were needed. The test's temporary workspace Git repo
and account/state fixtures are removed after the test. Main repository Git
state was not changed by this worker.

## Limits and next action

No live provider, real account state, real quota, runtime activation, or external
provider thread was exercised. This qualifies deterministic legacy context
transfer and call binding through fake providers; live provider integration
remains unqualified. AD-03 durable all-account waiting remains separate.

Next: lead reviews the test and records AD-02 qualification status.

## Existing-profile auth and switch-selection repair

The existing-profile re-login UI/API and typed auth classification are
implemented in `src/launcher-app.js` and `launcher-ui/app.js`. The follow-up
auth recovery integration preserves explicit auth state and the existing
run/checkpoint. An independent review found stale active-profile mutations on
busy and thrown automatic switches. The repair adds persisted selection
revisions and compare-and-set in `src/account-profiles.js`; the switching
wrapper owns selection and rejects stale expected profiles; the watcher no
longer preselects or rolls back candidates. Tests cover delayed busy/throw
results while owner selection changes to C, target creation failures, and
explicit auth recovery.

Verification after repair:

- `node --test test/account-profiles.test.js test/app-server-switch.test.js test/budget-watcher.test.js test/account-failover-context.test.js test/launcher-accounts.test.js` - 97 passed, 0 failed.
- `node --test --test-name-pattern='explicit auth failures|only explicit account auth state|unknown lead error' test/lead-graph.test.js` - 3 passed, 0 failed.
- `node --test --test-name-pattern='describePause gives an auth pause|startup registers INPUT_REQUIRED lead tasks paused for budget or auth|an auth pause waits for explicit account recovery|budget auto-resume metadata cannot resume' test/server.test.js` - 8 passed, 0 failed.
- Full `test/server.test.js` remains unqualified after its earlier 110.29-second stall; it was not rerun.

The independent delta review is pending. No provider was contacted; no files
were staged or committed.
