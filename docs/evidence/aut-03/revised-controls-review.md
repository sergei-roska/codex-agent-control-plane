# AUT-03 revised protocol review

Status: APPROVE for static pre-baseline protocol controls.

Scope reviewed:

- `paired-trial-declaration.md`
- `trial-entry.json`
- `trial-runtime-pins.json`
- `trial-prompts.json`
- `trial-server.js`
- `inspect-checkpoint.js`

The review confirmed that the trial server injects a direct `CodexAppServer`
pinned to the launcher system account home and Team plan. The same instance is
used for turns and receives both the tool-policy and thread-request hooks. The
helper clears worker roles before orchestrator construction and role-route
registration, asserts the model and per-thread restrictions, and disables
account-profile switching. The frozen prompt inputs and empty read-only
workspace controls remain in place.

Static review found no hash mismatches across the referenced runtime files,
binary files, helper files, prompt inputs, prompt text, or arm settings. The
previous invalid skill-off task remains excluded. At review completion,
`baselineCaptureAllowed` was still false.

This approval covers protocol controls before capture. Each task still requires
a fresh quota, source-pin, process, and workspace preflight, and compliance must
be observed during the cohort. No task, test, service, or model call was run as
part of this review.
