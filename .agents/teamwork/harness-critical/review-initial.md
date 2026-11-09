# Independent review: completed scoped changes

Verdict: REJECT
Status: complete
Scope expansion: none

## Blocking

- `src/launcher-projects.js:72` [ran, read]: A startup error containing a common JSON credential field, `{"OPENAI_API_KEY":"review_dummy_credential_123456"}`, is written with the full value to `last-startup.json`. The sanitizer expects `=` or `:` immediately after the key, so the quoted JSON key bypasses it. I reproduced this through `createProjectManager` with an injected `ensureToken` failure and read the persisted diagnostic; `leaked` was true. The error path at lines 435-437 and 540-550 sends the message through `recordStartup`; `writeStartupDiagnostic` and `readStartupDiagnostic` apply the same sanitizer, so neither prevents the leak. Fix: redact quoted JSON key/value forms for common credential names before writing, and cover both token failures and stderr in focused tests.

## Verified scope

- [read, ran] Recovery stores the bounded original objective, inputs, evidence, criteria, checks, and stop conditions in the checkpoint template. Its recovered assignment retains the stored review context and existing target/generation gates. Focused lead graph tests: 3 passed, 0 failed.
- [read] Wave change is prompt guidance only. It directs grouping disjoint, independent writers and preserves serial fallback; existing contract and dispatch checks remain in place.
- [read, ran] The three implementing role prompts require an exact lead-authorized local Git operation and App Server permission, and prohibit retry or host fallback after denial. Focused role test: 1 passed, 0 failed. Native access inheritance is still in progress outside this review and needs a later delta review.
- [read, ran] Launcher saves structured startup state, including token/spawn/pre-readiness failures, and recovers it after manager reinitialization. Running requires the actual listener marker on stdout, assembled across chunks. Old-child ownership is checked. Focused launcher tests: 4 passed, 0 failed. These tests do not cover the JSON secret failure above.

## Minimal reproduction

Create a temporary project manager with injected `ensureToken: () => { throw new Error('{"OPENAI_API_KEY":"review_dummy_credential_123456"}'); }`, add a temporary workspace, call `start()`, then read `runtime/projects/<id>/last-startup.json`. Its `message` contains the full dummy credential. This uses only a temporary directory and starts no child process.
