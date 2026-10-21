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
policy. Native managed requirements continue to apply. Account switching uses
the selected account's Codex configuration; no credentials or complete native
configuration are written into result artifacts.

## Workers, inspection, and acceptance

In inherited mode, writable roles use the native project policy and configured
approval behavior. Existing continued threads must receive the current policy
too; leaving an old thread's sandbox in place is not inheritance. The original
workspace remains the permission lookup root when a worker runs in a lane.

Inspection roles retain read-only permissions. The Lead remains an inspection
role. Role scope, external-action authorization, and filesystem capability are
different constraints: permission to execute a local command does not authorize
publishing, pushing, deployment, or editing another assignment's files.

Agent-proposed final checks still execute through Codex App Server. Inherited
access changes their execution capability, while their `source: "agent"`, argv,
script pins, writer admission, and candidate snapshot checks remain enforced.
There is no fallback from a denied check to an unrestricted host command.
The strict policy retains its read-only workspace, disabled network, and optional
isolated scratch directory. Owner checks keep their existing separate contract.

## Concurrent lanes and local Git

Inherited native full access uses worktrees for cooperative ownership and patch integration.
It must not be reported as sandbox confinement when the native profile permits
access outside a lane. Strict worktree mode still requires its confinement
probe. Both modes retain scope validation, integration checks, and writer
admission for shared workspace changes.
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
