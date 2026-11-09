# CN14 host controls and provider identity preparation

Own only `src/delivery-host-controls.js` and its test, plus `src/delivery-provider-identity.js` and its test. The root owns composition, Git, and durable project docs. Do not edit server/bootstrap/router/core/UI files before an explicit composition grant.

Provide authenticated fixed routes backed only by persisted router mappings and the concurrent engine facade. Require exact steering shape, scope and revision agreement, bounded values, and relay the core's durable acknowledgement. Legacy, missing, and unavailable mappings fail closed.

Capture account identity only from `tokens.account_id` in an explicit Codex home. Hash the value, canonicalize the home, read fresh metadata on demand, and never expose credentials or infer identity from email. Tests use fake metadata in disposable homes and actual router/SQLite/authenticated HTTP with a fake engine.

No live provider, account, service, target, dependency, Git, or restart actions.
