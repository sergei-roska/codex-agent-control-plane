# Candidate store worker brief

Implement CN-04 in `src/candidate-store.js` and `test/candidate-store.test.js` only. Do not modify shared legacy hooks, delivery files, Git state or live project state. Disposable owned Git fixture mutation is authorized. Preserve uncommitted work from other owners.

Required local gate: complete immutable source manifests and content-addressed copies; candidate identity, parent lineage and generation; safe paths and tamper detection; retention references; durable publication intent before injected effect; exact conservative recovery with trusted injected admission, controls and quiescence. Test with real disposable Git repos. No runtime rollout claim.
