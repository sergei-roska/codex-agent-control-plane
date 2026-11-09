# Independent core delta review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Delta evidence

- [ran] Repeated the previous JSON-token-error reproduction through `createProjectManager` with an injected `ensureToken` failure. The temporary `last-startup.json` and a new manager's `status()` contained `[REDACTED]` and neither contained the dummy credential. This resolves the blocker from `review-initial.md`.
- [read] `src/launcher-projects.js:73` adds redaction for quoted JSON and single-quoted mapping credential values. The same `sanitizeStartupText` path is used for token error messages and startup stderr before persistence. [ran] Two focused launcher redaction tests passed.
- [read] `src/loop-guard.js:176-207` now retains bounded recurrence records when an unrelated observation implemented a change. `recurrenceOf` keys observations by checkpoint, role class, and content target, so an actual target change starts a distinct count. [ran] Five focused threshold, unrelated-write, serialized-state, and changed-target tests passed.
- [read, prior ran] Original recovery brief preservation, current-target review gates, safe wave guidance, Git prompt restrictions, and launcher startup/old-child behavior were reviewed in `review-initial.md`; their scoped implementations were unchanged by these two deltas. Earlier focused checks passed: lead graph 3/3, role policy 1/1, launcher 4/4.

Native access inheritance and the typed authorized Git execution target remain in progress and require separate delta review before overall milestone acceptance.
