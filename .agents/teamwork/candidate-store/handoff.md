# CN-04 candidate store handoff

Status: repaired after critic REJECT; frozen for independent re-review. No legacy hook wiring or runtime rollout.

## Owned files

- `src/candidate-store.js`
- `test/candidate-store.test.js`
- This local teamwork directory

## API and contracts

Exports: `CandidateStore`, `CandidateStoreError`, `captureManifest`, `validateManifest`, `sha256`.

`captureManifest(workspace)` attests Git HEAD and every tracked plus nonignored untracked regular file. It hashes complete bytes, relative paths and executable mode. It does not change Git index/HEAD. It rejects unsafe paths, symlinks, submodules, unmerged index entries and special files. Ignored files are outside the source contract.

Construct `CandidateStore({ db, workspace, storageDir, admission?, controls?, quiescence?, apply?, eventHook?, clock? })`. The DB must be better-sqlite3; storage must resolve outside the workspace. `createCandidate` stores a content-addressed manifest/blob set and immutable identity; `materialize(candidateId,destination)` revalidates stored bytes and creates a read-only-by-default copy preserving executable mode. The copy is advisory filesystem protection, not a sandbox; consumers can chmod files. `readManifest` revalidates manifest and blob hashes and reconstructs a missing manifest cache only from the canonical SQLite row; an existing mismatched manifest remains an error. `addReference/removeReference` and `collectGarbage` retain referenced candidates and lineage. Pending intents pin base/result candidates and stored before/expected snapshots. A generation high-water survives candidate GC.

`get()` returns the internal record, including `checkIdentity`. `projectDeliveryCandidate(candidateId)` returns a separately validated `delivery/v1` candidate: it maps the manifest digest to both `snapshotRef` and `contentManifestDigest`, converts ISO `createdAt` to the contract's integer timestamp, and omits internal `checkIdentity`. Stored `environmentDigest` is required to be a SHA-256 digest accepted by the delivery contract.

`publish(input)` fails closed unless injected adapters exist. `controls({projectId,objectiveId,attemptId})` must return `allowed:true`, `fenced:false`, matching project/objective/attempt, a nonnegative safe-integer `controlRevision`, and a positive safe-integer `fencingToken`; it must return the same exact facts after admission. `admission.acquire` must return a durable lease with matching project/objective/attempt and the same numeric fencing token. The adapter must provide `release`, `markUnresolved`, `reconcile`, and `findByContextId` for restart-safe recovery. `quiescence(identity)` must prove process settlement. `apply({ ...intent, onSpawn(identity) })` performs the supplied effect. These are trusted adapter contracts; no existing product path is wired here.

The intent stores complete candidate identity (project/objective/candidate/parent/attempt/generation/environment/check/manifest), before/expected manifests, and explicit `deltaPaths` before external apply. Generation reservation and candidate identity are rechecked under immediate SQLite transactions before effect and at candidate commit. Recovery arguments are optional assertions only; mismatches are rejected and candidate metadata is rebuilt from the pinned intent. Recovery never reacquires or blindly reapplies. Exact before resolves not-applied; exact after can commit the pinned known candidate; partial, divergent, changed-control, or unquiesced effects stay unknown and retain the admission fence. Quiescence accepts only literal `true`; admission release/reconcile settles only explicit `released` or `reconciled` results. Candidate row, synchronous `eventHook`, and `settling` intent state share a SQLite transaction after exact current-manifest verification; admission release/reconciliation follows while the candidate snapshot is already frozen. Git/filesystem effects and SQLite are not atomic.

Storage race policy: `storeManifest` writes blob/cache files and snapshot metadata inside an immediate SQLite transaction. GC prunes unreferenced candidate/snapshot metadata, unlinks only the disposable manifest cache, then rechecks under an immediate transaction and restores the cache if a concurrent publisher recreated an active row. Startup and reads repair a missing cache from SQLite. Shared content-addressed blobs are deliberately retained for the lifetime of the state database; this gate makes no physical blob-GC claim, so unique blob storage can grow until a future safe offline/versioned collector exists.

Blob durability: storage directories are created and their parent entries synced before use. New blob bytes are written to an exclusive temporary file, file-synced before rename, then the blobs directory is synced before snapshot metadata can commit. Reused blobs are revalidated, file-synced and directory-synced before metadata publication. `commitCandidate` repeats blob validation and sync barriers inside its immediate transaction before writing a known candidate, including when called with an existing snapshot. Sync failures fail closed; a post-rename failure can leave only an orphan blob, which retry syncs before reuse. Manifest files remain reconstructible caches. SQLite must use FULL synchronous mode per the existing contract. This is ordering for immutable blob durability, not atomicity between Git/filesystem effects and SQLite. Tests inject sync callbacks and verify call order and failure state; no destructive power-loss test was run, so no hardware/filesystem power-loss guarantee is claimed.

## Verification

- `node --check src/candidate-store.js` - pass
- `node --check test/candidate-store.test.js` - pass
- `node .agents/teamwork/candidate-store-challenge/gc-race.cjs` - pass; second connection's referenced snapshot is readable after injected unlink
- `node --test test/candidate-store.test.js` - 17 tests passed, 0 failed, including blob file/directory sync ordering and injected sync failure staying unknown
- `node --test test/delivery-contracts.test.js` - 16 tests passed, 0 failed
- `git diff --no-index --check /dev/null src/candidate-store.js` and same for `test/candidate-store.test.js` - exit 1 because files are untracked; empty output means no whitespace errors

Critic's forged-recovery probe was reproduced from its evidence: generation 9/environment `env-forged`/check `check-forged` are now rejected without changing the pinned intent fields; correct recovery persists generation 2 and the original environment/check identities, and a correct replay is idempotent. Candidate intents now persist project, objective, candidate, parent, source attempt, generation, environment digest, check identity and content manifest digest before admission/effect. Candidate reservation and ordering are rechecked inside immediate transactions before effect and candidate commit. Invalid environment digests and existing candidate IDs fail before apply.

Disposable real Git fixtures cover full binary/untracked snapshots, frozen copies, symlink/submodule rejection and tamper detection, lineage/reference retention and durable generation ordering, event transaction rollback, invalid environment/candidate conflict rejection before apply, stale-base owner-edit refusal, crash before/during/after effect, forged recovery metadata rejection, exact restart reconciliation and idempotent correct replay, delivery/v1 projection, one application, and an owner edit injected during release/reconciliation.

## Limitations

No current legacy admission wrapper supplies the required project/objective/attempt/fence facts; future integration must adapt a trusted existing admission source without creating a competing lock. This module has no review consumer, evidence-store adapter, allowlist enforcement beyond caller-supplied expected manifest/delta scope, or runtime wiring. Read-only file modes are advisory. Filesystem/SQLite crash atomicity is not claimed. No full repository suite was run; lead has separate baseline suites.
