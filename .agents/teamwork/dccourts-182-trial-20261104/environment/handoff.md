# Handoff

Status: complete. Root owns review/commit of the new trial-only runner at
`/home/sr/Projects/dccourtscode-harness-trial-20261104/scripts/harness/validate-dccourts-182.sh`.
It has no arguments and runs from candidate root. It reads Composer metadata,
requires exactly one local drupal/shs patch registration matching
`patches.lock.json`, verifies the patch SHA and retained shs 2.0.7 lock, then
copies/hash-checks candidate bytes into private `/tmp` storage. Candidate files
are never written. The runner applies the patch to pristine shs 2.0.7 in a
minimal Composer fixture, lints all PHP, and runs the test file only when its
SHA matches the independent upstream MR59 test-file hash
`b54b6e6017e0d056491e2279eb31977c24324e6d040f4a7255cda90c0439da37`.

Exact command for Harness: `bash scripts/harness/validate-dccourts-182.sh`.
Pinned fixture: PHP 8.3 service, Composer 2.11.1, drupal/core and core-dev
11.4.11, drupal/shs 2.0.7, composer/installers 2.2.0. Composer lock SHA-256:
`f3b3eee31cdcbea026e76654ec9612a3baa9ac79144bb012abda09a0484bf35d`.
Pristine SHS source manifest SHA-256:
`529d7a03f222e40974553258d0569d31cca8ccf9fca87505e0fe0a4c833a69b2`.
Reusable private fixture/cache: `/tmp/dccourts182-pristine-1000` (289 MB); its
Lando app is destroyed after every run and no matching containers, networks, or
volumes remain.

Control evidence:
- Upstream regression-tests-only patch on pristine SHS: expected failure,
  PHPUnit 5 tests / 56 assertions / 4 failures; log and result:
  `/tmp/dccourts182-evidence.M8bMFN`.
- Public upstream MR59 proposal: patch dry-run/apply passed, 22 PHP files linted,
  PHPUnit 5 tests / 59 assertions passed with one existing Drupal annotation
  deprecation; log and result: `/tmp/dccourts182-evidence.lCTzW1`.
- `bash -n scripts/harness/validate-dccourts-182.sh` passed.

Limit: this validates patch applicability and the upstream kernel behavior on
SQLite only. It does not boot the DCCourts site, use its database/content, or
verify browser rendering. Probe files are public MR59 controls under
`environment/probes/`, not a candidate implementation. No product Composer
files or module code were changed; root retains Git ownership and has not yet
committed the validator.

## Read-only metadata evaluator

Added the separate helper `evaluate-composer-patches-v2.sh` in this directory.
Root command after the generated result exists:
`bash .agents/teamwork/dccourts-182-trial-20261104/environment/evaluate-composer-patches-v2.sh <candidate-root>`.
It reads candidate metadata, verifies composer.lock pins SHS 2.0.7 and a v2
composer-patches package, checks the SHS registration against its one locked
record and local patch bytes, snapshots metadata/patch assets to the private
`/tmp/dccourts182-pristine-<uid>` cache, bootstraps only the exact locked
composer-patches version, then runs the actual `patches-relock` plugin command
in scratch and compares the full regenerated lock (all records and top-level
`_hash`) with the candidate lock. It does not install the candidate's Drupal
dependencies or write candidate files. The plugin's resolver may fetch patch
URLs listed in candidate metadata; any URL access failure is retained in the
evidence log.

Probe: a synthetic candidate with two root patch records passed real
`patches-relock` and full-lock comparison, including `_hash`
`b9bbadb1090d14d636f20ed5320c34a2a55132b1a490fac5249943bd3b5d7c99`.
Evidence: `/tmp/dccourts182-metadata-evidence.iS8Elu`. The helper and probes are
under this harness-owned ignored directory; the frozen candidate validator's
SHA-256 remains `939d0d1e13734e4f6267fbab7337e99eded5f4d98f697d15db6a031a1c333fe6`.
No original project service, database, native model, or ticket product file was
used or changed.

## Composer project lock freshness diagnostic

Added `validate-composer-project.sh` for the exact Composer freshness gate:
`bash /home/sr/Projects/Workspace/codex-agent-control-plane/.agents/teamwork/dccourts-182-trial-20261104/environment/validate-composer-project.sh .`.
It copies only `composer.json` and `composer.lock` into the pinned PHP 8.3
Lando scratch, confirms Composer 2.11.1, calls Composer's genuine
`Composer Package Locker::getContentHash`, and runs
`composer validate --no-check-publish`. It does not install, update, resolve,
or write candidate files. The optional `--refresh-hash-control` mode changes
only `content-hash` in the scratch lock copy and proves every other lock field
and both package arrays remain identical; do not use that mode as a candidate
acceptance check.

Helper SHA-256:
`2da27fcc63feb86021d75fe6220c6db1c444eebfb5fef6abf4406caa6bd40f05`.
Controls on 2026-11-04:
- dccr-master `4b526e7e3e4f727c99f02fd44a655df595adfe0c`: exit 0; stored and computed content hash `4ff23405c51255a7d30b60debfc0c8f4`; existing schema warnings only. Evidence: `/tmp/dccourts182-composer-validation.ZR6xGd`.
- Candidate `42266cb100b6386510e049da161d2d0b8ab940ed`: expected exit 2; computed `b11ee237605d169df4d354b37fbe9781`, stored baseline hash; new freshness error plus same inherited warnings. Evidence: `/tmp/dccourts182-composer-validation.RXWPgD`.
- Scratch-only hash refresh control: exit 0 with `b11ee237605d169df4d354b37fbe9781`; all non-hash lock fields and package arrays unchanged. Evidence: `/tmp/dccourts182-composer-validation.dEiCaN`.

The candidate Composer JSON adds only the SHS patch registration relative to
baseline, while `composer.lock` is byte-identical. The stale content hash is a
new defect and should be corrected in the next metadata-only continuation.
All three private Lando runs destroyed the owned PHP-only app successfully.
Trial target remained clean at commit `42266cb`; no model call or candidate
write occurred.

## Final candidate independent validation

Fixed the Composer Patches relock scratch copier for frozen read-only inputs.
If a normalized destination already exists, it must be a regular non-symlink
file with the same SHA-256; identical copies are skipped and conflicts fail
closed. Full lock comparison is unchanged. Updated helper SHA-256:
`b099b2568458eba0e6d0f93074d872e225abff4ec195d730d3fc940f896a71df`.

Independent controls passed on a fixture whose three local patch assets were
mode `0444`: `patches-relock` exit 0, 13 records, `_hash`
`dfc37cfe6cd7e4cdd678e03a170003d2398cea74c9e5967cae5244b0c203869d`.
Evidence: `/tmp/dccourts182-metadata-evidence.6PDeCU`; fixture:
`/tmp/dccourts182-relock-readonly-fixture.hresvY`.

After the helper fix, all three pinned checks passed against the final candidate
from its worktree: kernel oracle exit 0 (5 tests, 59 assertions, one existing
Drupal deprecation), Composer Patches v2 relock exit 0, and Composer
`validate --no-check-publish` exit 0. Combined logs and hashes:
`environment/final-candidate/20261104T144022Z/`. Standalone scratch outputs:
`/tmp/dccourts182-evidence.SfDjDP`,
`/tmp/dccourts182-metadata-evidence.KLRK3u`, and
`/tmp/dccourts182-composer-validation.0BELV9`.

The candidate `composer.lock` parses equal to dccr-master after excluding only
the top-level `content-hash`; baseline and prior hash are
`4ff23405c51255a7d30b60debfc0c8f4`, final is
`b11ee237605d169df4d354b37fbe9781`. The sole differing top-level lock key is
`content-hash`; both package arrays are identical. The four ticket files
(`composer.json`, `composer.lock`, `patches.lock.json`, and the SHS patch) diff
to 316 insertions and 2 deletions. The full seven-file diff including trial
infrastructure is 649 insertions and 2 deletions. Root committed the hash-only
correction as `7470074adf82284dc9f3614f0ee0259aef6d027b`; final target is clean.
No candidate bytes changed during validation. The owned Lando PHP-only app was
destroyed after each run; no original project service or database was used.
