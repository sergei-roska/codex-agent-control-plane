# AUT-03 S1 design review

Decision: APPROVE after re-review.

An independent critic first rejected the proposed design for three concrete lifecycle risks:

1. Existing worker skill files omit audience metadata. Treating only explicit `audience: worker` entries as workers would remove 33 existing skills. The design now defaults missing metadata to `worker` and excludes only explicit `audience: lead` entries.
2. Existing session rows can have a null profile hash. A skill-enabled lead must not reuse such a thread. The design requires rollover when the selected skill is enabled and the profile hash is missing.
3. A server restart could change the trial allowlist while a run is paused. The design freezes opt-in and the exact skill pin at first intake; resume rejects allowlist or pin drift before a model call.

The independent re-review approved the revised design with no blockers. The critic read the runbook and source paths, confirmed the compatibility and lifecycle controls, and ran a focused App Server test showing explicit skill input still works with the lead's disabled skill-tool policy. Implementation and lifecycle tests remain pending.

Scope: design review only. No product code, live model call, service restart, or session lifecycle action was performed.
