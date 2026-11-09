# CN14 core engine handoff

Status: partial, source frozen for independent review. Updated 2026-10-27.
Root owns Git/docs/startup. No staging or commits were made. This worker edited:

- `src/concurrent-delivery-engine.js`
- `test/concurrent-delivery-engine.test.js`
- `src/delivery-role-capabilities.js`
- `test/delivery-role-capabilities.test.js`
- `src/delivery-output-artifacts.js`
- `test/delivery-output-artifacts.test.js`

## Verified

- Initial reproduction: `env -u NODE_TEST_CONTEXT node --test
  test/concurrent-delivery-engine.test.js` failed at the 8.08-second bound;
  planner turn status was unknown with `turn_error`. Root cause was the engine
  omitting AppServer `onTurnStart`; the fake AppServer required it, and the real
  AppServer uses it to capture process/thread identity. The engine now validates
  host turn/thread/process facts before consuming planner output.
- Actual lead -> authenticated SDK/private verifier -> exact candidate review
  receipt -> frozen host checks -> accepted finalization is covered. Role config
  is independently snapshotted for preparation and turn. A required synchronous
  `providerIdentityFor` is checked at boundaries against immutable startup
  account/home identity. Tests cover prepare-time model mutation and same-home
  account replacement before provider work.
- Steering exact replay returns the durable original acknowledgement before
  checking changed revisions. Same-ID changed body conflicts. A new message
  checks revisions and appends atomically after controller setup; wake occurs
  after commit. `controlStatus` includes bounded message receipt state.
- Cooperative writer isolation preserves mode `cooperative`, inherited
  permissions, real private worktrees, and `confinement:none`; shared mode stays
  unsupported. Planning-phase verifier capabilities are admitted only with the
  existing claim, owner/generation/control/settings/registry/candidate and
  source-write-denial checks intact. Pause, budget, draining, validating and
  terminal rejections remain covered.
- Artifact bindings retain captured planRevision as provenance and permit a
  legitimate later plan while the actual bound task contract, attempt, fence,
  owner, goal, requirements/checks, authority and controls remain unchanged.
  Owner correction, takeover and task contract drift remain rejected. A valid
  bare or `sha256:`-prefixed environment digest now keeps its representation
  through binding and candidate publication rather than being normalized by a
  filesystem digest helper.
- The engineering integration test uses two actual RoleService private
  worktrees and fake AppServer barriers. The fast task publishes candidate
  generation 2 while the slow sibling is still running with an active claim.
  Planner adds dependent work; it starts from generation 2 before slow release
  and publishes generation 3. A fresh verifier receipt, owner checkpoint,
  verifier check proof, final check proof and durable accepted finalization all
  pin to generation 3 and current owner/control/goal/plan/authority pins.

## Verification

Command:
`env -u NODE_TEST_CONTEXT node --test test/concurrent-delivery-engine.test.js test/delivery-output-artifacts.test.js test/delivery-role-capabilities.test.js`

Result: 26/26 pass, 0 fail, 0 skipped. This includes cooperative provenance,
base-candidate acceptance, pin mutation regressions, steering replay/atomicity,
overlapping engineering, bare/prefixed artifact publication, lookahead plan
capture, negative artifact fence cases, and planning capability admission.

## Pending full-core criteria

- Invalid-then-corrected planner output remains unimplemented. Root explicitly
  stopped this component at the quota cutoff. Any recovery must prove the exact
  persisted planner turn using actual host thread, process and terminal turn
  facts plus lifecycle proof APIs; never infer quiescence from error/model text.
- Root reported the host default empty-owner-checks path has a real
  `delivery_role_check_evidence_invalid` defect. Do not bypass check evidence or
  treat it as a fixture-only issue.
- Run/resume/owner-correction/reopen and shutdown behavior are not fully
  qualified. Preserve existing attempt fences and all unknown provider effects;
  no true completion with unresolved work, pending corrections, or uncertain
  effects.
- The latest pin, steering, cooperative, overlap and artifact deltas still need
  independent review. Whole CN14 and CN15 remain pending; production startup is
  not wired by this worker.

## Boundaries

No router/server/startup source was edited. No blocked hostile Git probe,
additional agent, dependency install, live model/provider/account, shared
service or target was used. Git was inspected but not mutated. Shared dirty
paths from other workers were left untouched.
