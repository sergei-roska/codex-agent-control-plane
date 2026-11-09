# Bounded startup review and permission decision

Verdict: REJECT
Status: complete
Scope expansion: none

## Launcher review

Blocking: src/launcher-projects.js:520-522. Ran a disposable fake-child probe
against createProjectManager, without spawning a provider or changing source.
Two stderr chunks, `OPENAI_API_KEY=first-half-` and
`second-half-private\n`, produce status.logs containing
`OPENAI_API_KEY=[REDACTED]second-half-private`. The UI renders these logs directly.
The final persisted startupDiagnostic.stderr is redacted correctly; that later
sanitization does not protect the already appended log chunks. This violates
the no-raw-secrets requirement of the diagnostic fix. Buffer/redact complete
records across chunk boundaries before publishing them, with a bounded carry
and explicit safe behavior on overflow/close; add a split-chunk regression.
Do not expose the raw pending carry through status or persistence.

Read: actual git diff for the assigned launcher source/tests, current startup
lifecycle, status persistence, API projection, UI polling and retry reset.
Inherited unrelated diff was present and preserved. No integrity manipulation
was found in the reviewed startup delta. Persistent error propagation and
replacement after successful retry otherwise match the bounded requirement.

Ran independently:

- `env -u NODE_TEST_CONTEXT node --test test/launcher-projects.test.js`: 34 pass.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='returns status with logs|status polling shows persistent startup failures|concurrent setting fails closed when startup selects unsupported shared isolation' test/launcher-app.test.js test/launcher-startup.test.js test/server-delivery-engine.test.js`: 3 pass.
- Inline Node fake-child probe using createProjectManager and a disposable
  /tmp directory: logsLeak=true; final diagnostic stderr remains redacted.

No prohibited test, broad suite, live service, provider, config or Git mutation
was executed.

## Compatibility decision

Reject the proposed use of the existing lane sandbox override unchanged.
Read: src/writer-lanes.js:209 rejects inherited non-full-access policy;
src/writer-lanes.js:370 returns null for cooperative lanes. Thus enabling
cooperative selection and honoring that existing override would still leave
the lane unwritable. The non-cooperative laneSandboxPolicy at
src/codex-app-server.js:1949-1951 supplies only the lane writable root, with
both temp exclusions false. It drops native configured extra writable roots
and can widen temp authority when native exclusions are true.

Read: nativeSandboxPolicy in src/execution-permissions.js:9-21 correctly
captures original workspace, configured extra roots, network and temp flags.
prepareThread/run resolve trust and approvals using permissionWorkspace and
ignore override in the nativeLegacy branch. a2a-role-service passes original
workspace for that lookup and the lane path as cwd. Keep that separation.

Smallest supportable implementation direction: limit admission to trusted
legacy workspace-write, mint a host-owned policy for the exact prepared lane,
and remap only the implicit workspace root to that lane while preserving
explicit native roots, network, temp flags, approval policy and reviewer.
Do not make arbitrary caller sandboxPolicy override native inheritance. Keep
read-only roles read-only and named/custom/managed profiles unsupported by
this compatibility path. Test both prepareThread and run, including reuse
policy checks and native roots overlapping the original workspace.

The lane path is deliberately outside the original root
(writer-lanes.js:129-137), so replacement is authority relocation, not a
mathematical narrowing of writable paths. Project authorization to execute in
host-owned lanes can justify that exact mapping, but it must be explicit in
the supported concurrent execution contract. Do not silently add the shared
root, the lane parent, all cache directories, or full access. Explicit native
roots may still permit shared writes: describe this as cooperative execution,
not confinement. Built-in modern :workspace equivalence is unverified here;
leave its current fail-closed behavior intact.

No implementation or provider-level validation of this direction was reviewed.
The current concurrent rejection remains correct until the bounded adapter,
selection and offline wire-policy tests are implemented together.

## Paused legacy verification

The lead supplied evidence that the actual verifier received workspace-write,
network=true, temp exclusions=false, approval=on-request. Its default uv cache
and sibling checkout were outside the original writable workspace. A later
read-only investigator's all-read-only mounts do not establish the verifier's
write capability. local-verification/v1 is a fingerprint, not a callable tool.
Retrying an authorized disposable cache/scratch under the same verifier policy
is the appropriate diagnostic direction; no automatic resume, sandbox
promotion or active-run repair claim follows from this source review.

Pitfall: sanitize subprocess output as a stream; arbitrary data-event chunks
are not complete credential records.
