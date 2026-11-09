# Work package planning implementation

## Objective

Add loaded lead guidance for efficient, bounded workflow packages while
preserving review, dependency, ownership, session, and risk gates.

## Allowed files

- `profiles/TEAM.md`
- `src/role-catalog.js` (lead instructions only)
- `docs/workflow-efficiency.md`
- `.agents/teamwork/workflow-efficiency/planning/brief.md`
- `.agents/teamwork/workflow-efficiency/planning/handoff.md`

## Acceptance

- Guidance covers package boundaries, observable acceptance, exact context
  reuse, supported wave handoffs, and narrow infrastructure recovery.
- Guidance cannot merge unrelated checkpoints or bypass dependencies or gates.
- Documentation explains runtime loading and profile identity behavior.
- Run the existing role catalog test and relevant profile-loading checks only.
- Do not modify AUT-03 skill files or hashes; no live calls or state changes.
