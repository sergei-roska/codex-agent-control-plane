# Excluded prototype screen: Battle Pass

**Explicit beta exclusion:** preserve `artifacts/dashboard/**` unchanged. Battle Pass is fully deferred. Do not specify or implement it for beta; this note records the exclusion and explains the expected red coverage only.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory

| Control (`id` / selector) | Declared in | Prototype behavior (`file:line`) | Beta disposition |
| --- | --- | --- | --- |
| Purchase button | `modals/battlepass.html` | Shows a hardcoded \"Pass activated\" alert (`js/modals/battlepass.js:14-18`). | Excluded; no purchase behavior. |
| Daily XP button | `modals/battlepass.html` | Changes its label to Claimed and disables itself (`js/modals/battlepass.js:20-25`). | Excluded; no XP behavior. |
| Modal wrapper | `modals/battlepass.html` | Header button opens modal (`js/modals/battlepass.js:8-12`); content is a static season, level, XP and reward fixture (`modals/battlepass.html:11-66`). | Fully deferred; no implementation or design specification. |

Controls: **3**. Coverage intentionally remains **0/3**. The full prototype is out of beta scope; keeping these identifiers out of other specs preserves an honest red gate.
