# Actual Composer project validation helper

Verdict: APPROVE normal validation mode as the third pinned host check. Optional scratch-refresh mode is diagnostic only, never candidate acceptance.

Read actual environment/validate-composer-project.sh at SHA-256 2da27fcc63feb86021d75fe6220c6db1c444eebfb5fef6abf4406caa6bd40f05. Normal argv is bash, absolute host-owned helper, dot. Candidate root resolves from that argument; original checkout and descendants are explicitly excluded. Only regular nonsymlink composer.json/composer.lock are copied, and both hashes are compared with candidate source before execution. No candidate write, dependency installation/update or resolution is performed. Official Composer Locker computes expected content hash and actual pinned Composer 2.11.1 validate --no-check-publish determines exit status on the copied files.

Read cleanup: helper requires exact private PHP-only Lando config hash and serializes cache use with flock. Lando start/tool/destroy operations are timeout-bounded and run only from that cache. EXIT destroys the owned app, validates scratch realpath parent and name before deletion, and forces failure on cleanup failure. Logs and exact source copies remain under a unique /tmp evidence directory. Runtime source binding/drift guards remain necessary outside this helper; it is not a general filesystem sandbox.

Read actual controls and destroy logs:
- /tmp/dccourts182-composer-validation.ZR6xGd: baseline normal mode exit 0, computed/stored hash 4ff23405c51255a7d30b60debfc0c8f4, inherited warnings, cleanup 0.
- /tmp/dccourts182-composer-validation.RXWPgD: current candidate normal mode exit 2, computed b11ee237605d169df4d354b37fbe9781 vs stale stored baseline hash, actual lock-out-of-date error, cleanup 0.
- /tmp/dccourts182-composer-validation.dEiCaN: diagnostic scratch-only refresh exit 0, content hash fresh, all non-hash fields and package arrays unchanged, cleanup 0. This validates the proposed narrow remedy, not current candidate acceptance.

Ran: bash -n passes; independently checked helper SHA. No container/provider run repeated, no candidate file edited. Actual negative check is relevant introduced lock staleness and must remain failing until native engineer corrects only content-hash. The next accepted candidate must pass normal mode alongside kernel and patches-relock checks. Existing baseline warnings are not converted into unrelated dependency work.

Status: complete for helper source/control review; native corrected candidate remains pending.
Scope expansion: none
