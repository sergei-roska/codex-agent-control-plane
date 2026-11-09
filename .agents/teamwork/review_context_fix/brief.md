# Review context fix

Objective: Include complete canonical immutable review metadata in full and delta lead prompts. Preserve gate behavior and other dirty changes.

Ownership: `src/lead-graph.js`, `test/lead-graph.test.js`; local notes in this directory.

Acceptance: Prompt serialization contains all six review fields, arrays and empty arrays, defaults legacy `prerequisiteFor` to `[]`, and instructs the lead to reuse the exact stored context.
