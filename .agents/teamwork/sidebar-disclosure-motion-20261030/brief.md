# Brief: Smooth sidebar disclosures

## Objective
Make sidebar disclosure opening/closing feel smooth without making it sluggish.

## Decision
Animate the details content block-size and opacity over about 180ms with a restrained ease-out, and animate the chevron as it already does. Use intrinsic-size interpolation where supported, discrete content-visibility transition for native details, and honor `prefers-reduced-motion`.

## Allowed files
- `launcher-ui/styles.css`
- `test/launcher-role-page.test.js`

## Acceptance criteria
- All sidebar details, including About Orchestrator and the card disclosures, animate open/closed smoothly.
- Transition is quick (roughly 150-200ms), with no abrupt content-height jump in supporting browsers.
- Reduced-motion preference disables the new animation.
- Existing Accounts width containment and collapsed quota preview styles remain intact.
- Focused launcher UI tests and `git diff --check` pass.
