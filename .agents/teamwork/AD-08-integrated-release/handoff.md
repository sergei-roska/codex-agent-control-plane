# AD-08 integrated release handoff

Status: complete for deterministic functional qualification.

## Primary release scenario

`test/autonomous-delivery-release.test.js` starts the real `startServer`
concurrent-v1 composition in an isolated Git workspace with local A/B account
fixtures, fake App Servers, deterministic limit reads, and trusted typed usage
limit failures. The fixture proves A exhaustion, automatic transfer to B on a
fresh lead thread, B exhaustion, durable wait across real server close/reopen,
restored B availability, automatic continuation of the same objective, and
accepted finalization with the pinned mandatory verifier check. No owner message
or `resume()` call is used after restart.

Assertions cover the stable run/objective/session/check identity, two durable
waits and wake events, three implementation attempts with traceable account and
thread bindings, one applied candidate publication, successful verifier work,
and one accepted finalization. The two B implementation attempts reuse the
same B-bound worker thread; their distinct durable attempt IDs and outcomes are
asserted. The A-to-B lead rebind event must use `objectRevision` equal to its
payload `controlRevision + 1`, which is required by verifier profile lineage
authorization.

The scenario exposed that budget rebind events previously wrote the current
control revision as their event revision. That caused the original A-pinned
verifier checkpoint to fail authorization after the valid A-to-B transfer. The
budget transition now records `current.controlRevision + 1`; the full release
test proves that lineage authorizes the unchanged pinned check after restart.

## Control and recovery cases

- `test/autonomous-delivery-control-races.test.js` exercises authenticated
  pause and cancel through real host routes while the automatic B eligibility
  read is held. Owner control persists; the wait stays waiting, A stays active,
  and no switch, wake, or second attempt occurs.
- `test/autonomous-delivery-auth-recovery.test.js` exercises the supported
  legacy auth wait: the existing-profile fake login shares the profile home,
  explicit authenticated state completes the login, and the production watcher
  resumes the same task/check and reaches accepted without owner continuation.
  Concurrent-v1 does not currently implement an auth-specific durable wait, so
  this recovery case deliberately covers the existing legacy auth path.
- Concurrent engine coverage verifies reset hints alone do not wake a wait,
  missing/unknown auth state does not authorize resume, unknown dispatch effects
  do not resend, a genuine owner decision is applied without fabricated
  acceptance, and shutdown preserves held effects. Failed mandatory checks and
  repeated invalid planning remain nonaccepted in the acceptance and lead-graph
  suites.

## Verification

- `node --test test/autonomous-delivery-release.test.js` - 1 passed.
- `node --test test/autonomous-delivery-control-races.test.js` - 3 passed,
  including pause and cancel subtests.
- `node --test test/autonomous-delivery-auth-recovery.test.js` - 1 passed.
- Combined release/control/auth qualification command - 5 passed:
  `node --test test/autonomous-delivery-release.test.js test/autonomous-delivery-control-races.test.js test/autonomous-delivery-auth-recovery.test.js`.
- `node --test test/concurrent-delivery-engine.test.js` - 72 passed.
- Named legacy cancel/server restart race cases - 2 passed;
  `node --test test/budget-watcher.test.js` - 45 passed.
- Existing-profile login tests - 4 passed; auth-watcher reference cases - 3
  passed.
- Failed check and failed audit tests - 2 passed; repeated invalid planning -
  1 passed; unknown worker effect reconciliation - 1 passed.
- Changed JavaScript syntax checks and `git diff --check` passed.
- Independent Luna review: APPROVE, no actionable defects.

No live provider, credential, real quota consumption, runtime activation,
staging, or commit was used. The inherited `:memory:.lockdb` remains untouched.
