# F3 large tool output

Class: large tool output. Acceptance `not_required`. No checks.

Setup: `node scripts/emit-log.js` prints 20 MiB (override with EMIT_LOG_MB) of
128-byte INFO lines plus exactly one `ERROR E4711` line at a fixed-seed depth.

Expected answer: the final text contains `E4711`. Also record lead
`inputTokens` per turn for the payload comparison.
Grader: `node bench/graders/f3.js --final <file> --workspace <dir>`.
