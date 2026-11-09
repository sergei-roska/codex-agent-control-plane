# DCCOURTS-182 validator review

Verdict: APPROVE as a bounded code-level validator, with integration limits below. No whole-ticket or browser acceptance.

Reviewed script: /home/sr/Projects/dccourtscode-harness-trial-20261104/scripts/harness/validate-dccourts-182.sh
Reviewed SHA-256: edcef16ecc374f34266d9a9d300141b00324542d5f5e41e8eb07bbcba9759c0b
Invocation from any frozen candidate project cwd: bash /home/sr/Projects/dccourtscode-harness-trial-20261104/scripts/harness/validate-dccourts-182.sh
The script has no executable bit; invoke through bash. Pin this host-owned script digest in the acceptance contract. Do not resolve the validator from candidate-controlled cwd or include its path as a writable deliverable.

Read: candidate root is pwd -P. composer.json, composer.lock, patches.lock.json and registered patch are read from that root. It requires SHS 2.0.7 and composer-patches registration, exactly one local SHS patch, matching package/URL/depth/SHA lock metadata, then copies the patch and rechecks its SHA. The isolated fixture receives these candidate patch bytes, not a fixed solution. The external Harness must retain its existing frozen-candidate/digest guards; the script itself does not authenticate candidateId or manifest digest.

Read: pristine fixture is independent of target vendor code. Composer config and lock and SHS manifest are cached with hashes; every run compares the actual copied SHS tree against the pristine source manifest before applying the candidate patch. The kernel test added by that patch must match the fixed public MR59 test SHA before execution. Independently reconstructed the added 216-line test from upstream-mr59.diff and obtained b54b6e6017e0d056491e2279eb31977c24324e6d040f4a7255cda90c0439da37, exactly the pinned value. This prevents replacing the declared test with a trivial passing test.

Read evidence: /tmp/dccourts182-evidence.K4ivlR/result.txt and commands.log show test-only control failed with 5 tests, 56 assertions, 4 failures. /tmp/dccourts182-evidence.Acnlu3 shows full public MR59 passed with 5 tests, 59 assertions, one deprecation, exit 0. Both record matching candidate/copied patch hashes and complete successful Lando destroy logs. These runs predate the oracle guard; independent SHA reconstruction validates the new constant. Post-guard controls are complete and independently read: /tmp/dccourts182-evidence.M8bMFN fails with 5 tests, 56 assertions, 4 failures and exit 1; /tmp/dccourts182-evidence.lCTzW1 passes with 5 tests, 59 assertions and exit 0. Both record the pinned upstream test SHA and successful app cleanup.

Read cleanup: app name is derived from the dedicated per-UID cache path, with flock serializing this validator. Only the matching exact private .lando.yml is accepted. EXIT trap destroys the cache-owned Lando app with a timeout, retains logs, removes only the run-owned scratch directory after successful cleanup, and returns failure if cleanup fails. It does not invoke project Lando or touch original project services/DBs. Temporary /tmp evidence can disappear and should be copied before concluding the trial.

Ran: bash -n passes. No cold installs or target services were run by this review; no held-out implementation was inspected.

Limits: checks exercise the candidate patch on pristine SHS 2.0.7 with Drupal 11.4.11 and an in-memory SQLite kernel fixture. They do not run candidate Composer install/plugin integration or validate its composer.lock content-hash; inspect resulting Composer metadata independently. They do not test actual Forms content, production node preservation/audit, or browser AJAX behavior. Unique app isolation relies on honoring the script flock; it is serial per cache, not one concurrent app per run. Those limits match code-only trial scope and must remain explicit.

Status: complete for validator source review; generated candidate acceptance pending; post-guard controls verified.
Scope expansion: none
