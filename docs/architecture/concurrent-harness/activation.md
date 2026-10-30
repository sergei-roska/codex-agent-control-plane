# Engine selection and activation

This is an operator procedure, not an activation report. CN-14/CN-15 bounded
offline source qualification passed the integrated V01-V43 matrix and frozen
affected/full checks. L6/live qualification remains separate. No production
project has been switched by this implementation work.

## Source application

Finish independent CN-14 review and the affected/full regression gates before
using the new engine. Record the exact source revision and any local changes;
passing tests against a different working tree do not qualify the active source.
Retain the project's existing state database and settings. Additive delivery
tables preserve the original A2A task and legacy checkpoint records.

The launcher and project backend load source separately. Applying updated source
requires restarting each affected process through its existing lifecycle after
owner authorization. Restarting a project can interrupt work; a source test does
not authorize that restart or a model trial.

## Select an engine for new runs

1. Stop the intended project through the launcher and wait for exact `stopped`
   status. A running, starting, stopping or unknown project cannot save engine
   selection. Confirm the intended project on its Roles page.
2. Select `concurrent-v1` in the delivery engine setting and save. The settings
   writer preserves owner checks, permissions and other saved project fields.
   Absent engine selection defaults to `legacy`.
3. Start the project only after the activation is authorized. The backend reads
   settings at startup. Project identity is bound to the canonical workspace;
   a foreign state database or incompatible writer isolation fails closed.
4. Start only the separately authorized bounded objective. Inspect Backlog for
   tasks, planning state and steering receipts. A received steering message is
   durable but does not imply its plan correction has already been applied.

The setting applies to new runs. Stored `delivery_run_engines` mappings retain
their engine, objective, session and original intake. Existing legacy runs stay
legacy; a concurrent run stays concurrent after the default is changed.

## Stop, restart and revert

Pause prevents further admissions while current work settles. Shutdown must
prove provider/controller work and publication effects safe before closing the
database or releasing the workspace lock. A shutdown error or timeout can retain
ownership intentionally. Keep its evidence and reconcile through the existing
recovery path; do not remove locks or edit durable claims to force a restart.

To return new runs to legacy, first stop and safely drain the project, then save
`legacy` in Roles and start the project using the qualified source. Existing
concurrent state is retained and still requires concurrent-capable source for
resume/reconciliation. Changing the default does not migrate or cancel a run.
Do not treat older source that ignores concurrent tables as a safe downgrade.

Unresolved claims, provider effects or publication intents fence conflicting
work across engines. Recover that work before admitting a conflicting new run.
Independent projects continue to use separate databases and workspace locks.

## Native workspace-write compatibility and startup failures

Inherited legacy workspace-write is supported through host-owned cooperative lane
mapping. Original native approvals, explicit writable roots and temp policy are
retained; the existing writable-verifier IPC exception remains supported. Named
or custom managed profiles are not treated as equivalent to this legacy policy.
Read-only or unqualified isolation still rejects concurrent startup.

The launcher projects the persistent sanitized startup diagnostic in status and
renders the failed stage/message after polling or page reload. A new attempt
replaces stale diagnostics; successful readiness clears the failure. Long stderr
records are bounded/omitted, and chunk boundaries cannot expose partial secrets.
Applying launcher code requires its lifecycle restart; applying project-server
code requires a project restart. Existing mapped legacy runs remain legacy.

## Live qualification boundary

L1-L5 fixtures use disposable state, Git repositories and fake provider turns.
They can qualify source integration, not provider throughput or live quality.
L6 needs separate owner authorization, pinned inputs/model settings, a bounded
cost allowance and comparable accepted legacy work. Follow
[validation.md](validation.md) and retain the resulting evidence before claiming
the new engine is qualified for live use.
