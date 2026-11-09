# Owner full-access review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Read: actual source/test diffs and current execution paths for owner settings,
permission resolution, cooperative selection, fresh/prepared/resumed role turns,
scoped verifier capability binding, inspection candidate cwd, frozen final
checks, durable finalization pins, preflight and lead guidance. Reviewed the
separately assigned launcher-default delta. No integrity-test weakening,
hardcoded production success, swallowed denial or unfinished stub was found.

The explicit owner mode selects the allowed built-in :danger-full-access profile
and sends never approvals for model turns, including inspection roles. Unknown,
untrusted or denied permission contexts do not silently downgrade. Original
project trust lookup is separate from private execution cwd for inspectors and
frozen final checks. Loaded threads clear an old sandboxPolicy before applying
profile permissions. Scoped verifier capabilities bind the selected host mode
and retain current claim and frozen-candidate checks. Strict fixture correction
mints strict explicitly rather than weakening exact mode matching.

Final checks use threadless command/exec with permissionProfile, without inventing
an unsupported approval argument. Fresh managed-profile resolution before every
check prevents a later denied check from executing. Candidate mutation still
rejects acceptance. Pending commands still cause accept_check_effect_unknown
and retain the mirror; admission release alone is not treated as quiescence.
That wrapper and its limitation predate this owner-mode change.

## Independent evidence

- 16/16 targeted tests passed across permission/settings, app-server, delivery
  acceptance, role service, scoped capability, strict/scoped wire integration,
  writer selection, composed server acceptance, durable pins, preflight and lead.
  Command: `env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='full-access|defaults execution permissions|preflight hashes verifier IPC|scoped verifier run permits selected strict' test/execution-permissions.test.js test/project-settings.test.js test/codex-app-server.test.js test/delivery-acceptance.test.js test/delivery-role-service.test.js test/writer-lanes.test.js test/server-delivery-engine.test.js test/verification-preflight.test.js test/lead-graph.test.js test/delivery-role-capabilities.test.js test/backlog-store.test.js test/delivery-verifier-integration.test.js`.
- 4/4 acceptance compatibility/denial tests passed:
  `env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='full|inherited|strict' test/acceptance.test.js`.
- 37/37 launcher-project tests passed:
  `env -u NODE_TEST_CONTEXT node --test test/launcher-projects.test.js`.
- Independent same-realm fake-RPC probe using the existing app-server test
  transport: eight thread/start, thread/resume and turn/start requests for a
  prepared/resumed inspector, fresh coordinator and fresh writer all carried
  :danger-full-access, never approvals and user reviewer, without sandboxPolicy.
- All 25 source/test hashes in handoff.md matched the reviewed files. Scoped
  git diff --check passed. No broad suite or prohibited named test was executed.

The composed server test reaches coordinator, scoped verifier and candidate-bound
agent final checks before accepted disposition. Real app-server wire coverage
separately confirms scoped full-profile/never fields and candidate-mutation
rejection before another start. These are offline fake-provider proofs.

## Launcher default semantics

The owner-only launcher document is validated before token/spawn. Missing file
is a no-op; malformed/unsupported input fails. Existing explicit project values
win, and other settings survive the validated atomic merge.

Non-blocking: this default is sticky one-time materialization, not dynamic
inheritance. First start writes it into an omitted project field, even if startup
later fails. Changing/removing the launcher default does not revoke that project's
stored value. Root was notified to document this behavior.

Additional verified SHA-256:

- src/launcher-projects.js: 5ff099bc033ddf4348b68330f0573151050e0a81c3eaf6ae4defcb123a9f394d
- src/launcher-project-settings.js: 289dfafc74f1cb8f0c81e91ebc343a02e50c442a4305230c45d930e86f7091dd
- test/launcher-projects.test.js: 67807f8b7624b7482e6370b8acd072febc58f5c97b2017675ee01d698b3590ac

## Limits

Approval covers source behavior and the bounded offline evidence above. Root
owns final integrated verification, actual settings/process changes and paused
run recovery. This review made no live provider/service/config/application-data
or Git changes. It does not establish unrestricted model autonomy, live managed
profile availability, tamper-proof host state under full process access, or
authority for new spending, credentials or external publication. Role/task scope,
acceptance and current candidate/claim/publication fences remain required.

Pitfall: authorization lookup must use the original project even when commands
execute against a private candidate copy.
