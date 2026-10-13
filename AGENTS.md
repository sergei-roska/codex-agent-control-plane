# Project agent instructions

## Local teamwork and succession

Use `.agents/teamwork/` for local coordination and successor messages. This
directory is ignored by Git; never force-add it. Tracked docs describe accepted
behavior and durable project decisions, not transient agent conversations.

- Start with `.agents/teamwork/PROJECT.md` and the current owner's `handoff.md`,
  then inspect Git status and the relevant diff. If local notes are missing,
  use `docs/codex-handoff.md` and current code as the fallback.
- The lead maintains `PROJECT.md`: current objective, acceptance criteria,
  baseline, ownership, status, and links to active handoffs and evidence.
- Each active agent owns `.agents/teamwork/<task>/`. Keep a concise `brief.md`
  and `handoff.md`; add `progress.md` only when it adds useful evidence.
- Update handoffs after meaningful milestones, before yielding or handing off,
  and before a known quota stop. Record completed and pending work, changed
  files, decisions and constraints, exact verification commands and results,
  blockers, and the next concrete action. Distinguish verified facts from plans.
- Include evidence paths and note when temporary evidence may disappear. Never
  store credentials or raw private conversations. Use English and ASCII.
- Preserve unfinished work from predecessors. Handoffs are context, not fresh
  authorization to restart services, deploy, discard changes, or run live tasks.

## Efficient context and verification

Read the current handoff before broad exploration. Search targeted symbols and
read bounded file sections. Pass agents file paths and concise deltas instead
of duplicating full history. Use the smallest team with clear file ownership.
Reuse verification only while its inputs remain valid; rerun affected checks
after changes. Keep a compact current state instead of append-only transcripts.
