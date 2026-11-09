# AUT-05 finish repair brief

Create a new v3 cohort because the v2 failed-usage observation lacked joined provenance. Use read-only local performance/source state snapshots only; export sanitized identity, status, and usage fields; preserve source databases and v1/v2 JSON. Leave metric definitions and evaluator code unchanged. Keep the case inconclusive unless the lead approves an outcome-count change. Update focused autonomy tests to target v3 while retaining prior fixture validation. No live calls/services/DB writes or Git staging/commit.
