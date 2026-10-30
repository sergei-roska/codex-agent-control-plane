# ADR: Explicit owner-authorized full local execution

Date: 2026-10-28. Status: implemented, independently reviewed, offline qualified,
and applied with live permission probes. Related problem: P-40 in
[production-transfer.md](../production-transfer.md).

## Context

Routine verification failed on uv cache access and became an owner question.
Native inheritance and role sandbox rules did not provide a single explicit
owner choice covering lead, inspection, scoped verifier and final checks. A
preflight fingerprint was also mistaken for a callable verification tool.
The owner explicitly authorized full local harness execution without local
permission questions. That changes execution authority, not required acceptance.

## Decision

Add owner-only per-project `executionPermissions: full-access`. Resolve the actual
allowed `:danger-full-access` profile and send `approvalPolicy: never` for all
model role turns, including inspection and scoped verifier. Threadless checks
use the allowed full profile; command/exec has no model approval-policy field.
Resolve policy against the original project while retaining private execution
cwd. Managed denial/unavailable policy fails explicitly, never silently
constrains execution or bypasses managed requirements. Inherit/strict unchanged.

An optional `.runtime/launcher-settings.json` default is materialized only when
project settings omit the mode. Explicit project choices win. Materialization
persists even after a later startup failure; changing the default does not
rewrite previously configured projects. Worker output does not select this mode.

Keep task/edit scope, exact candidate/check pins, publication and owner-correction
fences, and unknown-effect handling. Full process access is not a tamper-proof
sandbox. It neither supplies credentials nor authorizes unrelated external
publication/spending. Preflight route IDs are non-callable fingerprints, and
read-only inspector mounts are not proof of a writable verifier's permissions.

## Evidence and limits

Independent review approved the mode and launcher-default changes. Frozen
qualification: affected1231/1231; full1982 total,1981 passed,0 failed/canceled,
1 explicitly prohibited test skipped, identical manifests and no drift.
Real App Server0.165.0 accepted full/never preparation for coordinator, explorer,
engineer and verifier. A full-profile command wrote and removed disposable files
in /tmp and uv cache successfully. Launcher/project were restarted after verifying
no active runs/unreleased writers, with task state retained. Actual resumed lead
context reports danger-full-access and never approvals.

The previous local-verification pause was answered under the owner's authorization
and the old mapped legacy task resumed. A later review-base ancestry mismatch is
being investigated inside that task; final target acceptance is not claimed.
This is live permission/recovery evidence, not general autonomous completion or
comparative model quality/throughput qualification. See P-40 and
[execution-permissions.md](../execution-permissions.md) for operational details.
