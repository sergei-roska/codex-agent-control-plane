#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: bash validate-composer-project.sh CANDIDATE_ROOT [--refresh-hash-control]\n' >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
candidate_root=$(cd "$1" && pwd -P)
mode=${2:-validate}
[[ "$mode" == 'validate' || "$mode" == '--refresh-hash-control' ]] || usage
[[ "$candidate_root" != '/home/sr/Projects/dccourtscode' ]] || fail 'The original checkout is excluded.'
[[ "$candidate_root" != /home/sr/Projects/dccourtscode/* ]] || fail 'The original checkout is excluded.'
for file in composer.json composer.lock; do
  [[ -f "$candidate_root/$file" && ! -L "$candidate_root/$file" ]] || fail "Candidate $file must be a regular file."
done

command -v lando >/dev/null || fail 'Lando is required.'
command -v flock >/dev/null || fail 'flock is required.'
command -v timeout >/dev/null || fail 'timeout is required.'
command -v node >/dev/null || fail 'Node.js is required for scratch control checks.'
command -v python3 >/dev/null || fail 'Python 3 is required for safe scratch cleanup.'

cache="${TMPDIR:-/tmp}/dccourts182-pristine-${UID}"
[[ -f "$cache/.lando.yml" ]] || fail "Isolated PHP-only Lando cache is missing: $cache"
[[ "$(sha256sum "$cache/.lando.yml" | awk '{print $1}')" == 'f7e3417d2e015a9a656e82b16e3c7e47cc1463bc565dd5997a00e044aac28cdc' ]] \
  || fail 'Refusing an unexpected Lando configuration.'
exec 9>"$cache/lock"
flock 9
run_lando() {
  duration=$1
  shift
  (cd "$cache" && timeout --signal=TERM --kill-after=10s "$duration" lando "$@")
}

evidence=$(mktemp -d "${TMPDIR:-/tmp}/dccourts182-composer-validation.XXXXXX")
run_id="composer-validate-$(date -u +%Y%m%dT%H%M%SZ)-$$"
run="$cache/$run_id"
mkdir -p "$run"
lando_start_attempted=0
validation_status=1
cleanup() {
  status=$?
  set +e
  cleanup_status=0
  if [[ $lando_start_attempted -eq 1 ]]; then
    (cd "$cache" && timeout --signal=TERM --kill-after=10s 60s lando destroy -y) \
      >"$evidence/lando-destroy.log" 2>&1 || cleanup_status=$?
  fi
  if [[ $cleanup_status -eq 0 ]]; then
    python3 - "$cache" "$run" <<'PY'
import os
import shutil
import sys

cache, run = map(os.path.realpath, sys.argv[1:])
if os.path.dirname(run) != cache or not os.path.basename(run).startswith("composer-validate-"):
    raise SystemExit("refusing unexpected scratch cleanup path")
if os.path.exists(run):
    shutil.rmtree(run)
PY
    cleanup_status=$?
  fi
  if [[ $cleanup_status -ne 0 ]]; then
    printf 'cleanup=failed; scratch_preserved=%s\n' "$run" >>"$evidence/result.txt"
  fi
  if [[ -f "$evidence/result.txt" ]]; then
    printf 'cleanup_status=%s\n' "$cleanup_status" >>"$evidence/result.txt"
    printf 'validation_status=%s\n' "$validation_status" >>"$evidence/result.txt"
  fi
  printf 'evidence_dir=%s\n' "$evidence" >&2
  trap - EXIT
  if [[ $cleanup_status -ne 0 ]]; then exit 1; fi
  exit "$status"
}
trap cleanup EXIT

for file in composer.json composer.lock; do
  cp "$candidate_root/$file" "$run/$file"
  cp "$candidate_root/$file" "$evidence/source-$file"
done
node - "$candidate_root" "$run" "$evidence" "$mode" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, run, evidence, mode] = process.argv.slice(2);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const file of ['composer.json', 'composer.lock']) {
  if (sha(path.join(root, file)) !== sha(path.join(run, file))) throw new Error(`scratch copy hash mismatch: ${file}`);
}
const input = {
  candidateRoot: root,
  mode,
  sourceHashes: { composerJson: sha(path.join(root, 'composer.json')), composerLock: sha(path.join(root, 'composer.lock')) },
  scratchHashes: { composerJson: sha(path.join(run, 'composer.json')), composerLock: sha(path.join(run, 'composer.lock')) },
};
fs.writeFileSync(path.join(evidence, 'input.json'), `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE

cat >"$run/locker-report.php" <<'PHP'
<?php
if (!copy('/usr/local/bin/composer', '/tmp/composer.phar')) {
    throw new RuntimeException('composer_phar_copy_failed');
}
require 'phar:///tmp/composer.phar/vendor/autoload.php';
$composerJson = file_get_contents($argv[1]);
$lock = json_decode(file_get_contents($argv[2]), true, 512, JSON_THROW_ON_ERROR);
$computed = Composer\Package\Locker::getContentHash($composerJson);
$report = [
    'composerVersion' => Composer\Composer::VERSION,
    'computedContentHash' => $computed,
    'storedContentHash' => $lock['content-hash'] ?? null,
    'contentHashMatches' => ($lock['content-hash'] ?? null) === $computed,
];
echo json_encode($report, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), "\n";
PHP

lando_start_attempted=1
run_lando 180s start >"$evidence/lando-start.log" 2>&1
run_lando 30s composer --version >"$evidence/composer-version.txt" 2>&1
grep -Eq '^Composer version 2\.11\.1([[:space:]]|$)' "$evidence/composer-version.txt" \
  || fail 'The isolated Lando Composer version is not pinned to 2.11.1.'

run_lando 30s php \
  "/app/$run_id/locker-report.php" "/app/$run_id/composer.json" "/app/$run_id/composer.lock" \
  >"$evidence/locker-before.json" 2>"$evidence/locker-before.stderr"
if [[ "$mode" == '--refresh-hash-control' ]]; then
  node - "$run/composer.lock" "$evidence/locker-before.json" "$evidence/lock-control.json" <<'NODE'
const fs = require('node:fs');
const lockPath = process.argv[2];
const locker = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const original = JSON.parse(JSON.stringify(lock));
const oldHash = lock['content-hash'];
lock['content-hash'] = locker.computedContentHash;
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
const after = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const withoutHash = (value) => {
  const copy = { ...value };
  delete copy['content-hash'];
  return copy;
};
if (JSON.stringify(withoutHash(original)) !== JSON.stringify(withoutHash(after))) throw new Error('unexpected non-hash lock change');
const report = {
  oldContentHash: oldHash,
  newContentHash: after['content-hash'],
  allNonContentHashLockFieldsUnchanged: true,
  packageArraysUnchanged: JSON.stringify(original.packages || []) === JSON.stringify(after.packages || [])
    && JSON.stringify(original['packages-dev'] || []) === JSON.stringify(after['packages-dev'] || []),
};
if (!report.packageArraysUnchanged) throw new Error('package records changed in scratch hash control');
fs.writeFileSync(process.argv[4], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
  run_lando 30s php \
    "/app/$run_id/locker-report.php" "/app/$run_id/composer.json" "/app/$run_id/composer.lock" \
    >"$evidence/locker-after.json" 2>"$evidence/locker-after.stderr"
fi

set +e
run_lando 60s composer \
  --working-dir="/app/$run_id" validate --no-check-publish \
  >"$evidence/composer-validate.log" 2>&1
validation_status=$?
set -e
printf 'candidate_validation_status=%s\nmode=%s\n' "$validation_status" "$mode" >"$evidence/result.txt"
if [[ "$mode" == '--refresh-hash-control' ]]; then
  node - "$evidence/locker-after.json" "$evidence/lock-control.json" <<'NODE' >"$evidence/control-result.txt"
const fs = require('node:fs');
const after = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const control = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (!after.contentHashMatches || !control.allNonContentHashLockFieldsUnchanged || !control.packageArraysUnchanged) {
  throw new Error('scratch lock hash control failed its invariants');
}
console.log(JSON.stringify({ contentHashFresh: after.contentHashMatches, ...control }));
NODE
fi
printf 'candidate_validation_status=%s\nmode=%s\nevidence_dir=%s\n' \
  "$validation_status" "$mode" "$evidence"
exit "$validation_status"
