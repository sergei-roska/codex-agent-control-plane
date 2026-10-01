# M8 beta release note

M8 completes the Monitor, Decisions, Docs, and ticket activity views, including correlated events, version-bound decisions, paginated run history, cached token coverage, and explicit unavailable states. The six dashboard tabs now support their planned beta contracts.

The bounded MLflow experiment successfully logged sanitized correlation, outcome, and feedback fields to a temporary MLflow Tracking server. Production MLflow adoption remains deferred: no persistent tracking service is configured, and the current exporter logs run parameters rather than GenAI traces or dedicated feedback records. Local telemetry remains available when export is skipped or fails.

The model-backed prompt comparison evaluated four turns. Baseline and candidate each passed both curated cases, so no improvement was observed and neither prompt was promoted automatically. See [M8 acceptance](acceptance.md) for evidence and verification.
