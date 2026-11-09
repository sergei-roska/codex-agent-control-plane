# Runtime workflow audit

User request: audit yesterday and today for duplicated work, workflow overhead,
and token waste in the active Harness. Read-only source/runtime inspection only.
No model calls in Harness, task changes, restarts, tests, target edits or Git mutation.

Project c65886082e (claude-harness), session cb7ddc85-ce74-4fb8-864b-0f71de97eb28,
run 9e2c8b53-458b-4ccf-924b-ee13639510df. One session spans both dates.
Frozen SQLite backup captured 2026-10-19T08:33:51.211293Z from mode=ro source.
Private temporary snapshot: /tmp/harness-audit-20261019-jlcuqqwq/snapshot.sqlite.
Temporary snapshot contains runtime records and may disappear; do not copy raw
prompts/private conversations into durable evidence. Preserve aggregate and
sanitized event/assignment metrics only.

Calendar windows Europe/Chisinau (UTC+03): yesterday starts 2026-10-17T21:00Z,
today starts 2026-10-18T21:00Z; end is snapshot capture. Clip elapsed intervals
to boundaries; token attribution cannot be prorated without per-request data.

Lead owns report, coordination and Git. Metrics explorer owns metrics.json and
metrics-handoff.md. Cases explorer owns cases.md and cases-handoff.md. Distinct
ownership, no source edits. Inspect real reports to classify useful review,
product rework and infrastructure overhead. Do not infer waste from role/count
alone. Independent review of calculations and conclusions before final.
