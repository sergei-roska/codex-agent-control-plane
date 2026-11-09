# Brief: Sidebar disclosures

## Objective
Make every card in the launcher sidebar collapsible and expandable. Keep Accounts expanded by default and retain Team activity above Connectors.

## Acceptance criteria
- About Orchestrator, Project, Accounts, Team activity, and Connectors all use keyboard-accessible native disclosure controls.
- Accounts has the `open` default state; the other cards remain collapsed by default.
- Account refresh controls and existing card content/IDs remain functional.
- Focused launcher UI test and scoped diff check pass.

## Scope
`launcher-ui/index.html`, `launcher-ui/styles.css`, `test/launcher-role-page.test.js`.
