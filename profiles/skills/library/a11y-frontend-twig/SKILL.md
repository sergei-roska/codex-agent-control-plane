---
name: a11y-frontend-twig
description: Implement accessible HTML markup, ARIA roles, keyboard navigation, focus management, and screen-reader semantics within Drupal Twig templates and Single-Directory Components. Use when auditing or authoring component-level accessibility semantics, ARIA attributes, interactive widget behavior, focus order, or screen-reader compatibility in Twig templates.
---

# Accessibility for Frontend Twig & Components

## Goal

Ensure component and template markup meet WCAG AA frontend accessibility standards, including correct semantic elements, ARIA attributes, keyboard interaction patterns, and focus indicators.

## Activation Triggers

Activate this skill when the task involves any of the following:

- auditing or implementing HTML accessibility semantics in `*.html.twig` or SDC templates
- adding ARIA roles, states (`aria-expanded`, `aria-hidden`, `aria-controls`), or labels (`aria-label`, `aria-labelledby`)
- ensuring keyboard navigation order, focus trap, or focus indicator behavior for interactive Twig components
- pairing with `drupal-sdc-workflow` or `drupal-twig` for frontend accessibility reviews
- reviewing contrast, screen-reader text (`.visually-hidden`), or landmark accessibility within component markup

For site-wide accessibility scanning or automated browser testing, use `dev-validatecode`.

## Scope and Status

- Scope: component-level accessibility semantics and keyboard interaction patterns inside Twig/SDC templates.
- Status: active
- Bias: native semantic HTML elements (`<button>`, `<nav>`, `<main>`, `<dialog>`) over ARIA attributes.
- Excluded: broad design-system governance or automated accessibility scanner configuration.

## Retrieval Model

- Refer to W3C WAI-ARIA Authoring Practices Guide (APG) design patterns for interactive components (accordions, modals, menus, tabs).
- Inspect existing component markup for consistent `.visually-hidden` and focus styling patterns in the active theme.

## Legacy-Pattern Traps

- Do not use non-interactive elements (`<div>`, `<span>`) for clickable triggers without `role="button"`, `tabindex="0"`, and keydown handlers.
- Avoid redundant ARIA roles on native HTML elements (e.g. `role="button"` on a `<button>`).
- Never rely on visual color cues alone; pair visual states with accessible text or explicit ARIA state updates.

## Workflow

### 1. Evaluate Markup Semantics & Structure

1. Inspect HTML structure in `*.html.twig` or component template.
2. Replace non-semantic containers with semantic HTML5 landmark and sectioning elements (`<main>`, `<header>`, `<nav>`, `<article>`, `<aside>`).
3. Ensure heading hierarchy (`<h1>` through `<h6>`) is logical and non-skipping.

### 2. Implement ARIA Attributes & Keyboard Behaviors

1. Add appropriate ARIA roles and dynamic states (`aria-expanded`, `aria-selected`, `aria-controls`) bound to interactive component logic.
2. Ensure interactive controls support full keyboard operation (Tab, Enter, Space, Escape, Arrow keys as appropriate).
3. Verify visible focus indicators and correct use of Drupal `.visually-hidden` utility classes.

### 3. Verify Component Accessibility

1. Test keyboard tab navigation order across interactive elements within the component.
2. Verify screen-reader landmark navigation and dynamic live-region (`aria-live`) announcements if applicable.

## Validation Checklist

- [ ] Native semantic HTML elements used before applying ARIA attributes.
- [ ] Interactive elements reachable and operable via keyboard alone.
- [ ] Dynamic component states reflected accurately in ARIA attributes.
- [ ] Accessible names provided for icon-only buttons and form controls.

## References

- [WAI-ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
- [Drupal Accessibility Guidelines](https://www.drupal.org/docs/develop/accessibility)
