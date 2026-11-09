# Native execution permission resolver tests

Added `test/execution-permissions.test.js` against the isolated resolver only.
Tests use temporary filesystem paths and fake `readConfig` and
`permissionProfile/list` responses; no native service, model, or project session
is started.

Coverage:

- Exact, ancestor, and canonicalized project paths honor the nearest explicit
  trust entry. A trusted path-prefix sibling does not inherit trust.
- A trusted project inherits its allowed configured writer profile and explicit
  owner approval settings.
- A trusted project with omitted permission fields uses the allowed implicit
  `:workspace` profile.
- A managed-denied writer profile and unavailable config both resolve strict.
- An explicit strict request does not inherit writable profile or approval
  settings.

Client mapping from the source project to `permissionWorkspace`, including
external lanes, is owned by the Codex client tests and is intentionally not
duplicated here.

Verification: `node --test test/execution-permissions.test.js` - 6 passed,
0 failed.
