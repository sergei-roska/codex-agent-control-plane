# ADR: Normalize mechanical lead-decision defects; fetch named Jira issues at intake

Status: implemented 2026-11-10 on main (`b4d7dbe`, `7198ca7`). Live
measurement pending the next CDB run.

## Context

Three runs of the same one-line task (CDB-390, a duplicate PHP array key)
cost 1.14-1.19M tokens each, and 8-18 lead calls. Most of the lead time was
not spent on planning:

- The harness rejected 3-5 lead decisions per run and retried each with a
  full lead call (30-110K input tokens, 30-90 s). The same codes recurred on
  both Sol and Luna: `decision_envelope_invalid` (non-empty `final` on a
  dispatch or human-input decision), `partial_ledger_invalid` (a partial
  finish whose checkpoints are all accepted), and `records_invalid` (a
  remedy or verification record naming no existing problem record).
- Every run spent one to three explorer rounds, plus one lead round each,
  fetching the Jira issue. The causes were a missing `cloudId`, and an
  explorer that read "do not ... contact others" as a ban on the Atlassian
  tool.

## Decision

1. **Normalization before validation.** `normalizeDecision` in
   `src/contracts.js` repairs exactly three defects whose correct form the
   validator already prescribes:
   - it clears `final` on dispatch and request_human_input;
   - it turns an all-accepted partial ledger into a finish with
     `goalAchieved: true`, but not when the owner deferred checkpoints;
   - it prunes, or drops, remedy and verification records without an
     existing problem relation.

   Each repair is recorded as a `decision_normalized` staging event. Every
   other violation still rejects and retries.
2. **Jira intake.** When the goal names Jira keys (at most 3) and a role may
   use `harness-atlassian`, the intake node runs one read-only gpt-6-luna,
   low-effort turn with only `getAccessibleAtlassianResources` and
   `getJiraIssue` (`src/intake-jira.js`). The result reaches the lead prompt
   as a delimited block marked external and untrusted, capped at 8000 chars
   per issue. Any failure leaves the run unchanged. The turn is recorded in
   the usage ledger as role `intake`.
3. **Role wording.** Role profiles define "contact others" as messaging
   people or writing to external systems; read-only lookups through
   assigned connector tools are allowed. Turns that select Atlassian tools
   get a cloudId note.

## Consequences

- The all-accepted normalization overrides a lead's explicit
  `goalAchieved: false`. This is acceptable for two reasons. The
  `goalAchieved: true` path enforces every review obligation, with no ledger
  exemption, and still runs the acceptance node. The retry could only have
  reached the same finish, or invented a blocked checkpoint. The lead's
  final text and the staging event still show what happened.
- Dropped records lose ledger documentation. Records are not read by any
  gate or route (`recordSemanticRecords` is their only consumer).
- Intake adds one cheap turn to every run whose goal contains a Jira-like
  key. A token that is not a Jira key costs one failed turn. A connector
  that is not signed in costs one failed turn; a disabled connector costs
  nothing.
- Jira text enters the lead prompt as data. Delimiters in the issue content
  are neutralized.

## Rejected

- Retrying with a better prompt only: Sol, the stronger model, failed the
  same rules.
- Giving the lead the Atlassian tools directly: the issue payload would sit
  in every later lead call, and the lead would need tool turns of its own.
