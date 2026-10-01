# M8 acceptance

Date: 2026-10-01. Status: complete for the beta M8 gate. Production MLflow adoption is deferred.

Evidence: [offline experiment](experiment-result.json), [live prompt comparison](live-eval-result.json), [M8 release note](release-notes.md), and the [M8 exit gate](../beta-master-plan.md#m8-finish-the-application-views-and-learning-foundation).

## Delivered

- Monitor projects correlated, durable journal events. Category and role filters use available values; severity stays explicitly unavailable when events have no level. Polling reconnects with backoff. Clear Log hides the current view through a sequence watermark and leaves journal records intact. Diagnostic secrets are redacted on write and read.
- Decisions includes pending and answered PM intake clarifications, lead decisions, reviews, and operator actions. Questions and responses retain ticket, run, revision, plan, candidate, and ticket-version context where available. Stale or unbound actions cannot authorize a changed candidate. Existing guarded review routes handle acceptance and corrections.
- Docs reads the loaded project configuration and real role and preset artifacts. Unreadable, absent, or unsupported content is marked unavailable; displayed text is redacted.
- Ticket activity includes a paginated Run Log with explicit continuation, load-more, and retry states, plus Turns/events, Attempts, and Tokens. Partial and unavailable coverage is labeled. Cached-input share uses paired cached/input counts by role, ticket, and run. Monetary cost remains unavailable without measured cost data; hypothetical API cost is separate. Reviews, acceptance, and rework retain versioned execution binding.
- The offline M8 experiment runs four application contracts covering sanitized trace content, correlation and feedback, manual adoption, and isolated artifact cleanup. It reports prompt comparison as `not-evaluated`, since this command does not invoke a model.
- `node scripts/m8-experiment.js --live` runs baseline and candidate prompts against the same two curated cases using fresh `gpt-6-luna` turns at low effort. File-writing cases use temporary isolated workspaces that are removed afterward. The saved run evaluated 4/4 turns: baseline 2/2, candidate 2/2, no improvement observed, and no promotion.
- The optional MLflow exporter creates a Tracking run and logs bounded, sanitized trace and outcome/feedback fields as run parameters. It preserves ticket, run, attempt, outcome, and trace IDs. Failure or timeout defers export while local evidence remains. This is Tracking-run logging, not MLflow GenAI trace ingestion or a dedicated feedback record.

## Verification

- `env -u NODE_TEST_CONTEXT npm test`: 846 pass, 0 fail, 0 skipped.
- Browser acceptance on the working dashboard with a local fake delivery server: all six tabs loaded; a direct ticket progressed through intake clarification to a version-bound pending review. Answering in Decisions moved the clarification to history and exposed the next pending action. The Run Log displayed the resulting journal sequence, and Tokens marked missing counts and cost unavailable. Monitor's role filter showed only three developer dispatch events. Clear Log did not delete the event from the API. Docs displayed real project, role, and preset content.
- A temporary local MLflow 3.16.1 Tracking server accepted `runs/create` and `runs/log-batch`. A `runs/search` readback found all 11 expected sanitized parameters and the correlation and outcome fields in the created run. The temporary server and data were removed after verification.
- `sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt` and `git diff --check` passed. The protected `artifacts/dashboard/**` reference stayed unchanged; generated dashboard output is under `web/dashboard/**`.

## Decision and limits

Production MLflow adoption is `defer`: no persistent tracking service or production configuration was supplied, and the bounded exporter does not implement GenAI trace ingestion. The [release note](release-notes.md) makes this visible. The prompt candidate has no measured quality gain, so it is not promoted. M9 still owns release-candidate live pilots, recovery and security checks, and packaging.
