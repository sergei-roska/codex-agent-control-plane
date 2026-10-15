# Chuck Norris system repair

Status: Removed on 2026-10-14.

## Decision

The Chuck Norris system repair agent and its lead route were removed after
their first live use exposed four defects that mocked tests had missed:
oversized request inputs, failed lane confinement because runtime paths were
inside the repaired repository, an unusable retry after a confinement refusal,
and a stale phase display. The service modified the same control-plane tree
that hosted it, making safe isolation difficult to establish.

Control-plane incidents are now handled by the owner or a development session.
The orchestrator no longer has a system repair role, profile, launcher card,
service, API endpoint, client, or dispatch action.

## Existing sessions

An older checkpoint may still be parked at the removed `system_pause` node.
On resume, that legacy path discards the pending system repair request, records
that the route was removed, and continues with ordinary lead planning. New runs
cannot dispatch to the removed service.

## History

The original implementation notes, live-use findings, and production action
remain in [the production transfer log](../production-transfer.md#p-36-a-new-service-passed-mocked-tests-but-failed-on-first-live-use),
under SYS-REPAIR-01 and P-36.
