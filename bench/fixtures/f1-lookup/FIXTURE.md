# F1 read-only lookup

Class: read-only lookup. Acceptance: `not_required`. No checks.

Setup: `config/retry.js` defines `DEFAULT_RETRY_LIMIT` (line 4). Callers:
`src/http-client.js`, `src/queue-worker.js`, `src/sync-job.js`.

Expected answer: `config/retry.js:4` plus all three caller files.
Grader: `node bench/graders/f1.js --final <file> --workspace <dir>`.
