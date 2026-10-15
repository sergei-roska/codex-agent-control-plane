'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const analyzer = require('../src/spec-analyzer');
const contextApi = require('../src/spec-context');
const FIXTURE = path.join(__dirname, 'fixtures/spec-kit/pilot-price');
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools/spec-kit/analyze.js');
const PROFILES = path.join(ROOT, 'profiles');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-cli-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeJson(root, relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function rebindContext(root, mutate) {
  const context = readJson(root, 'context/pilot-context.json');
  mutate(context);
  writeJson(root, 'context/pilot-context.json', context);
  const accepted = readJson(root, 'context/accepted-context.json');
  accepted.contextSha256 = digest(fs.readFileSync(path.join(root, 'context/pilot-context.json')));
  writeJson(root, 'context/accepted-context.json', accepted);
  const map = readJson(root, 'specs/pilot-price/traceability.json');
  map.contextSha256 = accepted.contextSha256;
  writeJson(root, 'specs/pilot-price/traceability.json', map);
}

function argsFor(root, overrides = {}) {
  const accepted = readJson(root, 'context/accepted-context.json');
  const values = {
    workspace: root,
    context: accepted.contextPath,
    contextSha256: accepted.contextSha256,
    map: 'specs/pilot-price/traceability.json',
    profiles: PROFILES,
    ...overrides,
  };
  return [
    '--workspace', values.workspace,
    '--context', values.context,
    '--context-sha256', values.contextSha256,
    '--map', values.map,
    '--profiles', values.profiles,
    '--json',
  ];
}

function invoke(root, overrides = {}, argvPrefix = []) {
  return spawnSync(process.execPath, [CLI, ...argvPrefix, ...argsFor(root, overrides)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function parsed(result) {
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.notEqual(result.stdout, '');
  return JSON.parse(result.stdout);
}

function inventory(root) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) files.push({ path: relative, type: 'symlink', mode: stat.mode & 0o777, target: fs.readlinkSync(absolute) });
      else if (stat.isDirectory()) {
        files.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        const bytes = fs.readFileSync(absolute);
        files.push({ path: relative, type: 'file', mode: stat.mode & 0o777, size: bytes.length, sha256: digest(bytes) });
      } else files.push({ path: relative, type: 'other', mode: stat.mode & 0o777 });
    }
  };
  walk(root);
  return files;
}

test('explicit CLI emits a deterministic complete pass report bound to all inputs', () => {
  const root = copyFixture();
  try {
    const first = invoke(root);
    const second = invoke(root);
    const report = parsed(first);
    assert.equal(first.status, 0, JSON.stringify(report.findings));
    assert.equal(first.stderr, '');
    assert.equal(second.status, 0);
    assert.equal(first.stdout, second.stdout);
    assert.equal(report.schemaVersion, 'spec-analysis/v1');
    assert.equal(report.verdict, 'pass');
    assert.match(report.analysisFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(report.featureId, 'pilot-price');
    assert.deepEqual(report.coverage.requirements.map((item) => item.id), ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4']);
    assert.deepEqual(report.coverage.acceptanceCriteria.map((item) => item.id), ['AC-1']);
    assert.deepEqual(report.dependencyOrder, ['T001']);
    assert.equal(report.assignmentValidation.length, 2);
    assert.equal(report.assignmentValidation.every((item) => item.validation.ok), true);
    assert.equal(report.implementationAcceptance, 'not_evaluated');
    assert.equal(report.assumptions.liveRunStateValidationRequiredBeforeDispatch, true);
    assert.match(report.assumptions.taskAndSourceSemanticAgreement, /not machine-proved/);
    assert.equal(report.inputManifest.contextSha256, readJson(root, 'context/accepted-context.json').contextSha256);
    assert.ok(report.inputManifest.checkerSourceHashes.some((item) => item.path === 'src/spec-analyzer.js'));
    assert.ok(report.inputManifest.harnessContractHashes.some((item) => item.path === 'src/contracts.js'));
    assert.ok(report.inputManifest.roleProfileAndTeamHashes.some((item) => item.path === 'profiles/TEAM.md'));
    assert.equal(JSON.stringify(report).includes(root), false);
    assert.equal(JSON.stringify(report).includes(PROFILES), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('same IDs with a semantically different objective do not claim semantic verification', () => {
  const root = copyFixture();
  try {
    const map = readJson(root, 'specs/pilot-price/traceability.json');
    map.tasks[0].objective = 'Delete the protected product tests and rewrite package metadata.';
    writeJson(root, 'specs/pilot-price/traceability.json', map);
    const result = invoke(root);
    const report = parsed(result);
    assert.equal(result.status, 0);
    assert.equal(report.verdict, 'pass');
    assert.deepEqual(report.coverage.requirements.map((item) => item.id), ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4']);
    assert.match(report.assumptions.taskAndSourceSemanticAgreement, /not machine-proved/);
    assert.equal(report.implementationAcceptance, 'not_evaluated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI argument, JSON, version, path, and accepted digest failures are structured blocked reports', () => {
  const root = copyFixture();
  try {
    let result = spawnSync(process.execPath, [CLI, '--workspace', root], { encoding: 'utf8' });
    let report = parsed(result);
    assert.equal(result.status, 1);
    assert.equal(report.verdict, 'blocked');
    assert.equal(report.analysisFingerprint, null);
    assert.equal(report.findings[0].code, 'json_flag_required');

    result = invoke(root, {}, ['--context', 'context/absent.json']);
    report = parsed(result);
    assert.equal(result.status, 1);
    assert.equal(report.verdict, 'blocked');

    result = invoke(root, { contextSha256: '0'.repeat(64) });
    report = parsed(result);
    assert.equal(result.status, 1);
    assert.equal(report.findings[0].code, 'context_digest_mismatch');
    assert.equal(report.analysisFingerprint, null);

    const badRoot = copyFixture();
    try {
      fs.writeFileSync(path.join(badRoot, 'context/pilot-context.json'), '{bad json');
      const accepted = readJson(badRoot, 'context/accepted-context.json');
      accepted.contextSha256 = digest(fs.readFileSync(path.join(badRoot, 'context/pilot-context.json')));
      writeJson(badRoot, 'context/accepted-context.json', accepted);
      const map = readJson(badRoot, 'specs/pilot-price/traceability.json');
      map.contextSha256 = accepted.contextSha256;
      writeJson(badRoot, 'specs/pilot-price/traceability.json', map);
      result = invoke(badRoot);
      report = parsed(result);
      assert.equal(result.status, 1);
      assert.equal(report.findings[0].code, 'context_json_invalid');
    } finally {
      fs.rmSync(badRoot, { recursive: true, force: true });
    }

    const versionRoot = copyFixture();
    try {
      rebindContext(versionRoot, (context) => { context.schemaVersion = 'spec-context/v999'; });
      result = invoke(versionRoot);
      report = parsed(result);
      assert.equal(result.status, 1);
      assert.ok(report.findings.some((item) => item.code === 'schema_version_unsupported'));
    } finally {
      fs.rmSync(versionRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changed source and artifact membership are rejected against captured digests', () => {
  const root = copyFixture();
  try {
    fs.appendFileSync(path.join(root, 'canonical/GOAL.txt'), ' drift');
    let result = invoke(root);
    let report = parsed(result);
    assert.equal(result.status, 1);
    assert.equal(report.verdict, 'blocked');
    assert.ok(report.findings.some((item) => item.code === 'source_digest_mismatch'));

    const other = copyFixture();
    try {
      fs.appendFileSync(path.join(other, 'specs/pilot-price/plan.md'), ' drift');
      result = invoke(other);
      report = parsed(result);
      assert.equal(result.status, 1);
      assert.ok(report.findings.some((item) => item.code === 'artifact_digest_mismatch'));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown map authority fields, map versions, and invalid map JSON cannot pass', () => {
  const root = copyFixture();
  try {
    const mapPath = path.join(root, 'specs/pilot-price/traceability.json');
    let map = readJson(root, 'specs/pilot-price/traceability.json');
    map.contextPath = 'context/attacker-context.json';
    writeJson(root, 'specs/pilot-price/traceability.json', map);
    let result = invoke(root);
    let report = parsed(result);
    assert.equal(result.status, 1);
    assert.ok(report.findings.some((item) => item.code === 'unknown_field'));

    const versionRoot = copyFixture();
    try {
      map = readJson(versionRoot, 'specs/pilot-price/traceability.json');
      map.schemaVersion = 'spec-traceability/v999';
      writeJson(versionRoot, 'specs/pilot-price/traceability.json', map);
      result = invoke(versionRoot);
      report = parsed(result);
      assert.equal(result.status, 1);
      assert.ok(report.findings.some((item) => item.code === 'schema_version_unsupported'));
    } finally {
      fs.rmSync(versionRoot, { recursive: true, force: true });
    }

    const invalidRoot = copyFixture();
    try {
      fs.writeFileSync(path.join(invalidRoot, 'specs/pilot-price/traceability.json'), '{bad json');
      result = invoke(invalidRoot);
      report = parsed(result);
      assert.equal(result.status, 1);
      assert.equal(report.findings[0].code, 'map_json_invalid');
      assert.equal(report.analysisFingerprint, null);
    } finally {
      fs.rmSync(invalidRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit profiles are loaded, affect contract validation, and change the fingerprint', () => {
  const root = copyFixture();
  const profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-profiles-'));
  const customProfiles = path.join(profilesRoot, 'profiles');
  try {
    fs.cpSync(PROFILES, customProfiles, { recursive: true });
    const baseline = parsed(invoke(root));
    const engineerPath = path.join(customProfiles, 'agents/engineer.toml');
    const engineer = fs.readFileSync(engineerPath, 'utf8').replace('name = "engineer"', 'name = "builder"');
    fs.writeFileSync(engineerPath, engineer);
    const custom = invoke(root, { profiles: customProfiles });
    const report = parsed(custom);
    assert.equal(custom.status, 1);
    assert.equal(report.verdict, 'blocked');
    assert.notEqual(report.analysisFingerprint, baseline.analysisFingerprint);
    assert.ok(report.inputManifest.roleProfileAndTeamHashes.some((item) => item.path === 'profiles/agents/engineer.toml'));
    assert.ok(report.findings.some((item) => item.code === 'role_profiles_unavailable' || item.code === 'assignment_compile_failed'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(profilesRoot, { recursive: true, force: true });
  }
});

test('workspace symlinks and oversized context inputs are blocked before parsing', () => {
  const root = copyFixture();
  try {
    fs.symlinkSync('pilot-context.json', path.join(root, 'context/alias.json'));
    let result = invoke(root, { context: 'context/alias.json' });
    let report = parsed(result);
    assert.equal(result.status, 1);
    assert.equal(report.findings[0].code, 'path_symlink_forbidden');

    const largeRoot = copyFixture();
    try {
      fs.writeFileSync(path.join(largeRoot, 'context/pilot-context.json'), `${' '.repeat(1024 * 1024 + 1)}{}`);
      result = invoke(largeRoot);
      report = parsed(result);
      assert.equal(result.status, 1);
      assert.equal(report.findings[0].code, 'input_file_size_limit');
    } finally {
      fs.rmSync(largeRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate snapshot budget includes canonical source files', () => {
  const root = copyFixture();
  try {
    const count = 8;
    const newSources = [];
    for (let index = 0; index < count; index += 1) {
      const relativePath = `canonical/large-${index}.bin`;
      const bytes = Buffer.alloc(contextApi.MAX_SOURCE_BYTES, 0x61);
      fs.writeFileSync(path.join(root, relativePath), bytes);
      newSources.push({ id: `LARGE-${index}`, path: relativePath, sha256: digest(bytes) });
    }
    rebindContext(root, (context) => context.sources.push(...newSources));
    const result = invoke(root);
    const report = parsed(result);
    assert.equal(result.status, 1);
    assert.equal(report.findings[0].code, 'snapshot_total_size_limit');
    assert.equal(report.analysisFingerprint, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analysis leaves the entire workspace unchanged and never executes planned checks', () => {
  const root = copyFixture();
  try {
    rebindContext(root, (context) => {
      context.checks[0].argv = ['node', '-e', "require('fs').writeFileSync('sentinel.txt','executed')"];
    });
    const before = inventory(root);
    const result = invoke(root);
    const report = parsed(result);
    const after = inventory(root);
    assert.equal(result.status, 0, JSON.stringify(report.findings));
    assert.deepEqual(after, before);
    assert.equal(fs.existsSync(path.join(root, 'sentinel.txt')), false);
    assert.equal(report.assumptions.plannedChecksExecuted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('input drift during analysis blocks the snapshot report', () => {
  const root = copyFixture();
  const accepted = readJson(root, 'context/accepted-context.json');
  const goalPath = path.join(root, 'canonical/GOAL.txt');
  const original = fs.readFileSync(goalPath);
  const realOpenSync = fs.openSync;
  let opens = 0;
  try {
    fs.openSync = function patchedOpenSync(filePath, ...args) {
      if (path.resolve(String(filePath)) === goalPath) {
        opens += 1;
        if (opens === 3) fs.writeFileSync(goalPath, Buffer.concat([original, Buffer.from(' drift')]));
      }
      return realOpenSync.call(fs, filePath, ...args);
    };
    const report = analyzer.analyzeWorkspace({
      workspaceRoot: root,
      contextPath: accepted.contextPath,
      contextSha256: accepted.contextSha256,
      mapPath: 'specs/pilot-price/traceability.json',
      profilesDir: PROFILES,
    });
    assert.equal(report.verdict, 'blocked');
    assert.ok(report.findings.some((item) => item.code === 'input_drift_detected'));
  } finally {
    fs.openSync = realOpenSync;
    fs.writeFileSync(goalPath, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
