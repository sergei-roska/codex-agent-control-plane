# Harness execution permissions

Trusted local projects use the active Codex account's configured development
permissions by default. This implements the owner's October 20 decision to
use the same configured access as interactive Codex without asking again for
already authorized local work.

## Owner configuration

The optional per-project setting is read at project-server startup:

```json
{
  "version": 1,
  "executionPermissions": "inherit"
}
```

`inherit` is the default, including existing version-1 settings files. The
resolver checks the native effective configuration and allowed permission
profiles for the original project workspace. Canonical paths and the nearest
configured project determine trust. Untrusted or unavailable configuration
falls back to the Harness strict policy. The setting is not a worker-report
field and cannot be enabled by a model's output.

Set `executionPermissions` to `strict` to keep the previous Harness sandbox
policy. Explicit owner opt-in `full-access` selects the allowed built-in
`:danger-full-access` profile and `approvalPolicy: never` for all role turns,
including lead, inspection and scoped verifier. Threadless final checks use that
allowed full-access profile; their RPC has no model approval-policy field. Native managed requirements continue to apply. Account switching uses
the selected account's Codex configuration; no credentials or complete native
configuration are written into result artifacts.

## Workers, inspection, and acceptance

In inherited mode, writable roles use the native project policy and configured
approval behavior. Existing continued threads must receive the current policy
too; leaving an old thread's sandbox in place is not inheritance. The original
workspace remains the permission lookup root when a worker runs in a lane.

In `inherit` and `strict`, inspection roles retain read-only permissions.
The Lead remains an inspection role by task contract. Under explicit owner
`full-access`, OS execution is unrestricted for those roles too, while their
assigned edit scope, candidate integrity and publication/acceptance rules remain. Role scope, external-action authorization, and filesystem capability are
different constraints: permission to execute a local command does not authorize
publishing, pushing, deployment, or editing another assignment's files.

Agent-proposed final checks still execute through Codex App Server. Inherited
access changes their execution capability, while their `source: "agent"`, argv,
script pins, writer admission, and candidate snapshot checks remain enforced.
There is no fallback from a denied check to an unrestricted host command.
Other strict roles retain their current policies. Owner checks keep their
existing separate contract.

Writable verifier turns and agent-proposed checks receive sandbox network access
where the legacy workspace-write or Harness strict policy can express it. This
supports verifier IPC, including local socketpair use, while preserving writable
roots and candidate-bound review receipts. Codex exposes a general network access
switch rather than an IPC-only capability, so this also permits other sandbox
network traffic. Modern managed permission profiles remain unchanged because the
App Server does not expose a safe per-turn IPC override for them; verification
preflight reports custom profile network capability as unverified. The built-in
`:danger-full-access` profile remains unchanged and is recognized as
network-capable.

## Concurrent lanes and local Git

Inherited native full access uses worktrees for cooperative ownership and patch integration.
It must not be reported as sandbox confinement when the native profile permits
access outside a lane. Strict worktree mode still requires its confinement
probe. Both modes retain scope validation, integration checks, and writer
admission for shared workspace changes.
Inherited legacy workspace-write also supports cooperative lanes. A host-owned
opaque capability binds the original project, exact admitted lane, current lane
fence and original native policy. The implicit project writable root maps to that
private lane; explicit native writable roots remain, including an explicit root
equal to the original project. Native approvals, reviewer and temp restrictions
remain unchanged. Ordinary writers preserve native network access; writable
verifiers retain their existing IPC network exception. The scoped concurrent
verifier uses its separate candidate/scratch capability.

This support requires the resolver's explicit legacy discriminator
`profileApi: false`; named/managed profiles with missing metadata, read-only and
unknown modes do not inherit this mapping. Native policy is refreshed before
thread operations and turn start; changed policy, substituted paths, revoked or
replaced lane fences fail closed. Cooperative mode is not a confinement claim.
Other inherited profiles use the shared workspace when compatibility with
isolated lanes cannot be established; that fallback is reported explicitly.

Normal assignments use `executionTarget: null`. For an already authorized local
Git operation that must affect the shared project branch, the Lead uses
`executionTarget: "shared"` with `review: null` and `repair: null`. Only writable
engineering roles can use this administrative route, and it cannot share an
execution group with another writer. It executes in the shared workspace under
writer admission. A commit inside an ordinary lane changes only that lane's
Git metadata and does not commit the shared branch.

Older stored assignments without the field normalize to `null`. New model
output declares the nullable field as required so the decision schema remains
compatible with strict structured output.

## Qualification and incident evidence

See [the October 20 incident report](harness-critical-incidents-2026-10-20.md)
for confirmed defects, baseline source locations, implemented repairs, test
results, and remaining limitations. No paused task is resumed merely because
its configured permissions change.

Native protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).


## Verification preflight identity and environment diagnosis

The `local-verification/v1` preflight identifier is a fingerprint, not a callable
model tool. Projection includes `routeType: fingerprint` and `routeCallable: false`.
Configured checks execute through their existing harness path; this metadata does
not grant execution authority or prove that checks passed.

An inspection role's read-only mounts do not establish a writable verifier's
runtime permissions. Dependency/cache failures should be investigated using the
actual verifier execution and already authorized disposable cache/scratch under
the unchanged policy, preserving pinned commands and required acceptance. This
guidance does not create new permissions, guarantee model recovery, or authorize
resuming a paused owner-decision run.


## Persistent full local autonomy opt-in

The owner can set a launcher default in `.runtime/launcher-settings.json`:

```json
{
  "version": 1,
  "defaultExecutionPermissions": "full-access"
}
```

At project start this default is materialized only if the project settings omit
`executionPermissions`. Existing explicit project modes win. Materialization is
persistent even if a later startup step fails; changing/removing the launcher
default does not rewrite already configured projects. Missing default configuration
preserves prior behavior. Invalid schema/version/mode fails before token setup or
child spawn and never grants full access. Project settings remain the authoritative
owner selection; worker JSON does not select this mode.

Full access is checked against the configured project's actual allowed permission
profiles. An unavailable context or denied full profile is an explicit failure,
not a silent downgrade or managed-policy bypass. Lookup uses the original trusted
project when execution cwd is a private inspector or frozen check mirror. Scoped
verifier capabilities bind the owner-selected execution mode and policy digest;
forged/stale capabilities and candidate mutation still fail. Pending check commands
retain unknown-effect handling rather than becoming passing evidence.

This opt-in removes local sandbox/approval obstacles to authorized execution. It
does not make full-access processes tamper-proof or supply missing credentials,
change required acceptance, authorize arbitrary external publication/spending,
or guarantee a model will never ask an unnecessary question.
