# AUT-02 legacy graph reader replay

Verdict: PASS for the three disposable reader cases at the recorded source hashes.

Run from the repository root:

```sh
node docs/evidence/aut-02/legacy-reader/probe.cjs > docs/evidence/aut-02/legacy-reader/result.json
```

The probe uses `git archive` of baseline commit
`cc0958edd54a5c7ddaab02e4844fa69b823af365`, a disposable SQLite database
per case, and disposable workspaces. It does not replace shared source or run a
live task. The archived tree uses the repository's installed dependencies.

Recorded input hashes:

- Probe: `acd2025574cd213f5b21e9e6e4ea6c1bededecc1df477df94ff556a93c5dab1d`
- Current `src/lead-graph.js`: `6b93da685d44afeadbc573cd84fae2169e0dfc2e949f86c5187bd1a31fb1dd9b`
- Archived `src/lead-graph.js`: `c982762654c32f295ccc1893f0f3c878922b9b61928cb1c74221e5d3493c136a`
- Archived `src/contracts.js`: `be1966aea45abdaaf498fd53feef0a738b6bb2a642504d70539e45fc9f6d1698`

The exact structured result is in [result.json](result.json).

1. An archived checkpoint without `reviewRecovery`, with two accepted A
   receipts, resumed under the current graph after A changed to B. The current
   reader defaulted to `{version:1,checkpoints:[]}`, retained both historical
   receipts, sent no worker request, and rejected finish with
   `review_receipt_missing`.
2. A current checkpoint with version-1 `reviewRecovery`, but no pending
   assignment, resumed under the archived graph after A changed to B. The
   archived reader ignored the annotation, retained both historical receipts,
   sent no worker request, and rejected finish with `review_receipt_missing`.
3. The current graph actually dispatched a verifier for A, received a
   usage-limit result, then resumed after A changed to B. Its stale
   continuation preflight did not send the old context. Its verify checkpoint
   contained a generation-1 `verifier_pending` recovery record and a pending
   fresh verifier with `_reviewRecovery`. The archived graph resumed that same
   SQLite checkpoint and serialized `_reviewRecovery` into its outbound
   specialist request. The archived `checkSpecialistRequest` rejected the
   unknown key with `request_invalid`; worker model calls were zero. Its
   subsequent finish decision was rejected with `review_receipt_missing` and
   there were no accepted receipts or unresolved writers.

For case 3, the A2A client in the probe invokes the actual archived specialist
contract on the exact outbound JSON and returns a terminal failure carrying
the contract rejection, `failureKind=request_invalid`, and `effects=none`.
This checks the trust boundary and graph continuation without starting a role
service or model. It does not measure a real service lifecycle, writer
admission implementation, or production rollback. Rollback of the direct role
service remains unsafe unless review continuations are quiesced or the origin
guard is retained, as specified in `docs/evidence/aut-02/recovery-design.md`.
