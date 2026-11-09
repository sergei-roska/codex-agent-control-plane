# CN14 host preparation handoff

Status: complete for preparation scope; startup composition remains pending root grant.

Owned product files are limited to `src/delivery-host-controls.js`, `test/delivery-host-controls.test.js`, `src/delivery-provider-identity.js`, and `test/delivery-provider-identity.test.js`.

Stable intended APIs:

- `registerDeliveryHostControls(app, { authMiddleware, router })`
- `providerIdentityFor(codexHome, { metadataLoader })`
- `createProviderIdentityPin(codexHome, { metadataLoader })`, returning `{ providerIdentity, providerIdentityFor }`

No startup composition has been added. Host controls resolve only persisted mappings and an available concurrent engine; unknown runs return typed 404, legacy mappings return typed 503, and unavailable controls return typed 503. POST delegates revision and replay decisions to core, validates its durable acknowledgement shape, and returns it without waiting for the held run turn.

Verification: `node --test test/delivery-host-controls.test.js test/delivery-provider-identity.test.js` passed 7/7. `git diff --check` passed. Tests use a real in-memory SQLite router and authenticated Express HTTP with a held fake engine turn, plus fake metadata in disposable temporary homes.
