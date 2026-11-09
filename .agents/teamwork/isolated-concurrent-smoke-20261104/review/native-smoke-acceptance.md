# Bounded synthetic native acceptance

Verdict: APPROVE the successful final-source startup/synthetic/restart sample only. DCCOURTS-182 remains unsubmitted/unaccepted by this review.

Acceptance criteria:
1. PASS. Read full-final-guidance.tap: 2095 pass, zero fail, one skip. Independently compared all 341 entries of final-source-manifest.json: zero drift. Prior focused source/integrity reviews remain valid.
2. PASS. Read accepted/native-smoke-result.json and actual runner: genuine CodexAppServer is passed to private startServer; loopback ephemeral port 37595 returns A2A card 200. Authenticated actual A2A task b2028dce-d355-4f0a-ab7b-40758791ea46 completed (state 3). Both implementation and verifier tasks succeeded; run/objective/finalization persisted accepted. Independently ran node verify-output.js in accepted/: PASS exact synthetic output, exit 0. Retained output is 20 bytes with SHA-256 5af9330850129a61b69ce46bab68efc6c46a267f8865fb4a907191911ba6bf25.
3. PASS. Retained snapshots show first safe close released, fresh port 34897/card 200, concurrent-v1 mapping and identical accepted candidate after reopening, then second close released. Legacy candidate schema and seeded row remain preserved alongside two Concurrent candidates. Successful private runtime was removed only after safe close.
4. PASS for bounded isolation evidence. Actual runner uses owned temp settings/auth/workspace/state/storage/locks and real native provider, not a fake provider. Existing production/shared runtime is excluded. Prior unsuccessful samples remain explicit; in particular xsowd6 unsafe-close DB is retained and not replayed. Full-access cooperative mode has confinement=none and is not a filesystem security sandbox.
5. PASS. Independent source, validator and final retained acceptance review recorded under review/.

Evidence limitations: final snapshot helper retained an empty finalization checks projection rather than actual check rows, and usage_ledger is empty. Host acceptance is supported by durable accepted state under previously reviewed fail-closed check/receipt gates plus an independently rerun exact output check; raw host check proofs cannot be re-read after successful temp cleanup. Configured low/low/high Luna overrides are retained, but actual per-role usage/settings provenance is not. These are retention gaps, not grounds for token/cost, L6, performance, autonomy or broad live qualification claims. Earlier native failures preclude treating this as a reliability measurement.

Additional read-only target adapter review: runner/run-dccourts-182.js uses the genuine native provider and A2A interface, checks clean exact trial baseline and host validator hash, captures role/check/finalization evidence, deletes only its owned temp runRoot after safe close, and retains state on unsafe close. It does not delete the external target workspace. No immediate interface blocker found. saveCandidateEvidence captures tracked diff plus only the prescribed untracked patch filename; root should check status and preserve any additional untracked deliverables before authorized cleanup. This does not accept the target implementation or authorize its submission.

Status: complete for bounded first-part acceptance.
Scope expansion: none
