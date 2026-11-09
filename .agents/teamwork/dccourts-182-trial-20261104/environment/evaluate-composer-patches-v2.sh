#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail 'Usage: bash evaluate-composer-patches-v2.sh CANDIDATE_ROOT'
candidate_root=$(cd "$1" && pwd -P)
[[ -f "$candidate_root/composer.json" && -f "$candidate_root/composer.lock" && -f "$candidate_root/patches.lock.json" ]] \
  || fail 'Candidate composer.json, composer.lock, or patches.lock.json is missing.'
command -v node >/dev/null || fail 'Node.js is required for read-only metadata snapshotting.'
command -v lando >/dev/null || fail 'Lando is required.'
command -v flock >/dev/null || fail 'flock is required.'
command -v timeout >/dev/null || fail 'timeout is required.'

cache="${TMPDIR:-/tmp}/dccourts182-pristine-${UID}"
[[ -f "$cache/.lando.yml" ]] || fail "Isolated PHP-only Lando cache is missing: $cache"
grep -Fq 'type: php:8.3' "$cache/.lando.yml" || fail 'Refusing an unexpected Lando service configuration.'
mkdir -p "$cache"
exec 9>"$cache/lock"
flock 9
evidence=$(mktemp -d "${TMPDIR:-/tmp}/dccourts182-metadata-evidence.XXXXXX")
run_id="metadata-$(date -u +%Y%m%dT%H%M%SZ)-$$"
run="$cache/$run_id"
plugin_version=''
lando_started=0
cleanup() {
  status=$?
  set +e
  cleanup_failed=0
  if [[ $lando_started -eq 1 ]]; then
    (cd "$cache" && timeout --signal=TERM --kill-after=10s 60s lando destroy -y) \
      >>"$evidence/commands.log" 2>&1 || cleanup_failed=1
  fi
  if [[ $cleanup_failed -eq 1 ]]; then
    printf 'cleanup=failed; scratch_preserved=%s\n' "$run" >>"$evidence/result.txt"
    status=1
  else
    rm -rf "$run"
  fi
  printf 'exit_status=%s\n' "$status" >>"$evidence/result.txt"
  printf 'evidence_dir=%s\n' "$evidence" >&2
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$run"
cp "$candidate_root/composer.json" "$evidence/candidate-composer.json"
cp "$candidate_root/composer.lock" "$evidence/candidate-composer.lock"
cp "$candidate_root/patches.lock.json" "$evidence/candidate-patches.lock.json"

mapfile -t metadata < <(node - "$candidate_root" "$run" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[2];
const run = process.argv[3];
const inside = (base, candidate) => candidate.startsWith(base + path.sep);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const copyLocal = (url) => {
  if (typeof url !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(url) || path.isAbsolute(url)) return;
  if (url.split(/[\\/]/).includes('..')) throw new Error(`Unsafe local patch path: ${url}`);
  const source = path.resolve(root, url);
  if (!inside(root, source) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Local patch file is missing from candidate: ${url}`);
  }
  const destination = path.join(run, url);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const sourceHash = sha(source);
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(destination) !== sourceHash) {
      throw new Error(`Conflicting local patch copy: ${url}`);
    }
    return;
  }
  fs.copyFileSync(source, destination);
  if (sourceHash !== sha(destination)) throw new Error(`Local patch copy hash mismatch: ${url}`);
};
const entriesForPackage = (packageName, definitions) => {
  const found = [];
  if (Array.isArray(definitions) && definitions.every((entry) => entry && typeof entry === 'object')) {
    for (const definition of definitions) found.push({ package: packageName, description: definition.description, url: definition.url });
  } else if (definitions && typeof definitions === 'object') {
    for (const [description, url] of Object.entries(definitions)) found.push({ package: packageName, description, url });
  }
  return found;
};
const entries = (patches) => Object.entries(patches || {}).flatMap(([packageName, definitions]) =>
  entriesForPackage(packageName, definitions));

try {
  const composer = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'composer.lock'), 'utf8'));
  const patchLock = JSON.parse(fs.readFileSync(path.join(root, 'patches.lock.json'), 'utf8'));
  const packages = [...(lock.packages || []), ...(lock['packages-dev'] || [])];
  const shs = packages.find((pkg) => pkg.name === 'drupal/shs');
  if (!shs || shs.version !== '2.0.7') throw new Error('composer.lock must retain drupal/shs 2.0.7');
  const plugin = packages.find((pkg) => pkg.name === 'cweagans/composer-patches');
  if (!plugin || !/^2\./.test(plugin.version)) throw new Error('composer.lock must contain a v2 composer-patches package');
  if (!patchLock._hash || !patchLock.patches || typeof patchLock.patches !== 'object') {
    throw new Error('patches.lock.json must contain _hash and the complete patches map');
  }

  const shsDefinitions = entriesForPackage('drupal/shs', composer.extra?.patches?.['drupal/shs']);
  const shsRecords = patchLock.patches['drupal/shs'] || [];
  if (shsDefinitions.length !== 1 || shsRecords.length !== 1) {
    throw new Error('Expected exactly one drupal/shs registration and lock record');
  }
  const definition = shsDefinitions[0];
  const record = shsRecords[0];
  if (definition.url !== record.url || definition.description !== record.description) {
    throw new Error('The drupal/shs Composer registration does not match its lock record');
  }
  if (!/^[a-f0-9]{64}$/i.test(record.sha256 || '')) throw new Error('The drupal/shs lock record has no SHA-256');
  copyLocal(record.url);
  const patchPath = path.resolve(root, record.url);
  if (sha(patchPath) !== record.sha256) throw new Error('The drupal/shs patch file does not match its locked SHA-256');

  const pluginConfig = composer.extra?.['composer-patches'] || {};
  const patchesFile = pluginConfig['patches-file'] || 'patches.json';
  if (/^(?:[a-z]+:|\/)/i.test(patchesFile) || patchesFile.split(/[\\/]/).includes('..')) {
    throw new Error('The patches-file setting must remain within the candidate root');
  }
  const patchesFilePath = path.join(root, patchesFile);
  let patchesFileData = { patches: {} };
  if (fs.existsSync(patchesFilePath)) {
    if (!fs.statSync(patchesFilePath).isFile()) throw new Error('Configured patches-file is not a regular file');
    patchesFileData = JSON.parse(fs.readFileSync(patchesFilePath, 'utf8'));
    if (typeof patchesFileData.patches !== 'object') throw new Error('Configured patches-file has no patches map');
    const destination = path.join(run, patchesFile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(patchesFilePath, destination);
  }
  for (const entry of [...entries(composer.extra?.patches), ...entries(patchesFileData.patches)]) copyLocal(entry.url);
  for (const patchRecords of Object.values(patchLock.patches)) {
    for (const lockedPatch of patchRecords) copyLocal(lockedPatch.url);
  }

  const minimalComposer = {
    name: 'dccourts/trial-patches-lock-check',
    require: { 'cweagans/composer-patches': plugin.version },
    config: { 'allow-plugins': { 'cweagans/composer-patches': true } },
    extra: {
      patches: composer.extra?.patches || {},
      'composer-patches': pluginConfig,
    },
  };
  fs.copyFileSync(path.join(root, 'composer.json'), path.join(run, 'source-composer.json'));
  if (sha(path.join(root, 'composer.json')) !== sha(path.join(run, 'source-composer.json'))) {
    throw new Error('composer.json snapshot hash mismatch');
  }
  fs.writeFileSync(path.join(run, 'composer.json'), JSON.stringify(minimalComposer, null, 2) + '\n');
  fs.copyFileSync(path.join(root, 'composer.lock'), path.join(run, 'composer.lock'));
  fs.copyFileSync(path.join(root, 'patches.lock.json'), path.join(run, 'expected-patches.lock.json'));
  if (sha(path.join(root, 'composer.lock')) !== sha(path.join(run, 'composer.lock')) ||
    sha(path.join(root, 'patches.lock.json')) !== sha(path.join(run, 'expected-patches.lock.json'))) {
    throw new Error('Composer lock metadata snapshot hash mismatch');
  }
  fs.writeFileSync(path.join(run, 'snapshot.json'), JSON.stringify({
    composerJsonSha256: sha(path.join(root, 'composer.json')),
    composerLockSha256: sha(path.join(root, 'composer.lock')),
    patchesLockSha256: sha(path.join(root, 'patches.lock.json')),
    shsPatchSha256: sha(patchPath),
    pluginVersion: plugin.version,
    shsVersion: shs.version,
    patchRecords: Object.values(patchLock.patches).reduce((count, records) => count + records.length, 0),
  }, null, 2) + '\n');
  process.stdout.write(`${plugin.version}\n${shs.version}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
NODE
)
[[ ${#metadata[@]} -eq 2 ]] || fail 'Candidate metadata snapshot failed.'
plugin_version=${metadata[0]}
shs_version=${metadata[1]}
cat "$run/snapshot.json" >"$evidence/snapshot.json"
printf 'candidate_root=%s\nplugin_version=%s\nshs_version=%s\n' \
  "$candidate_root" "$plugin_version" "$shs_version" >"$evidence/result.txt"

bootstrap="$cache/plugin-bootstrap-$plugin_version"
mkdir -p "$bootstrap"
node - "$bootstrap/composer.json" "$plugin_version" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const version = process.argv[3];
const data = {
  name: 'dccourts/trial-composer-patches-bootstrap',
  require: { 'cweagans/composer-patches': version },
  config: { 'allow-plugins': { 'cweagans/composer-patches': true } },
};
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
NODE

cd "$cache"
lando_started=1
timeout --signal=TERM --kill-after=10s 180s lando start 2>&1 | tee -a "$evidence/commands.log"
if [[ ! -f "$bootstrap/vendor/autoload.php" ]]; then
  timeout --signal=TERM --kill-after=10s 300s \
    lando composer update --working-dir="/app/plugin-bootstrap-$plugin_version" --no-interaction --prefer-dist \
    2>&1 | tee -a "$evidence/commands.log"
fi

cp -a "$bootstrap/vendor" "$run/vendor"
timeout --signal=TERM --kill-after=10s 600s \
  lando composer --working-dir="/app/$run_id" patches-relock \
  2>&1 | tee -a "$evidence/commands.log"
cp "$run/patches.lock.json" "$evidence/regenerated-patches.lock.json"
candidate_patches_lock_sha=$(sha256sum "$evidence/candidate-patches.lock.json" | awk '{print $1}')
regenerated_patches_lock_sha=$(sha256sum "$evidence/regenerated-patches.lock.json" | awk '{print $1}')
printf 'candidate_patches_lock_sha256=%s\nregenerated_patches_lock_sha256=%s\n' \
  "$candidate_patches_lock_sha" "$regenerated_patches_lock_sha" >>"$evidence/result.txt"

node - "$run/expected-patches.lock.json" "$run/patches.lock.json" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const expected = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const actual = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
const expectedRecords = Object.values(expected.patches || {}).reduce((sum, records) => sum + records.length, 0);
const actualRecords = Object.values(actual.patches || {}).reduce((sum, records) => sum + records.length, 0);
const expectedSha = sha(process.argv[2]);
const actualSha = sha(process.argv[3]);
if (!expected._hash || actual._hash !== expected._hash) {
  throw new Error(`Composer Patches v2 _hash differs after scratch relock; candidate_sha256=${expectedSha}; regenerated_sha256=${actualSha}; candidate_hash=${expected._hash || 'missing'}; regenerated_hash=${actual._hash || 'missing'}`);
}
if (expectedRecords !== actualRecords) {
  throw new Error(`Patch record count differs (${expectedRecords} candidate, ${actualRecords} relocked); candidate_sha256=${expectedSha}; regenerated_sha256=${actualSha}`);
}
if (JSON.stringify(sort(expected)) !== JSON.stringify(sort(actual))) {
  throw new Error(`Full patches.lock.json differs after scratch relock; candidate_sha256=${expectedSha}; regenerated_sha256=${actualSha}`);
}
process.stdout.write(`Composer Patches v2 lock verified: ${actualRecords} records, _hash ${actual._hash}\n`);
NODE

printf 'lock_relock=pass\n' >>"$evidence/result.txt"
