# CN-01 contract repair

Owned product files: `src/delivery-contracts.js`,
`schemas/delivery-v1.schema.json`, and `test/delivery-contracts.test.js`.

Repair supersession lineage updates, malformed checkpoint containers, safe path
schema mismatch, and standalone dependency successor/duplicate validation.
Preserve trusted settled records and legacy schemas. No Git mutation, live
services/state/provider/target actions. See `handoff.md` for implementation
choices, exact verification, and storage projection boundary.
