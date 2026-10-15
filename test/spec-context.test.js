'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const api = require('../src/spec-context');
const SOURCE_ROOT = path.join(__dirname, 'fixtures/spec-kit/pilot-price');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-context-'));
  fs.cpSync(SOURCE_ROOT, root, { recursive: true });
  return root;
}

function readContext(root) {
  const file = path.join(root, 'context/pilot-context.json');
  const bytes = fs.readFileSync(file);
  return {
    bytes,
    value: JSON.parse(bytes.toString('utf8')),
    sha256: digest(bytes),
    loaded: api.loadContext({
      workspaceRoot: root,
      contextPath: 'context/pilot-context.json',
      expectedSha256: digest(bytes),
    }),
  };
}

function mapResult(root, contextResult, expectedContextSha256 = contextResult.contextSha256) {
  return api.loadTraceability({
    workspaceRoot: root,
    mapPath: 'specs/pilot-price/traceability.json',
    contextResult,
    expectedContextSha256,
  });
}

function assertStrictSchemaNodes(node, label) {
  if (node === null || typeof node !== 'object') return;
  if (!Array.isArray(node) && node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${label}: object must reject unknown fields`);
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${label}: every property is required`);
  }
  for (const [key, child] of Object.entries(node)) assertStrictSchemaNodes(child, `${label}.${key}`);
}

test('candidate F2 context and one-task map validate against pinned bytes', () => {
  const root = copyFixture();
  try {
    const context = readContext(root);
    assert.equal(context.loaded.ok, true, JSON.stringify(context.loaded.errors));
    const map = mapResult(root, context.loaded);
    assert.equal(map.ok, true, JSON.stringify(map.errors));
    assert.deepEqual(map.map.tasks.map((task) => task.id), ['T001']);
    assert.deepEqual(map.map.tasks[0].requirementIds, ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schemas are strict nested contracts and bound safe relative paths', () => {
  const schemaFiles = ['spec-context-v1.schema.json', 'spec-traceability-v1.schema.json'];
  for (const name of schemaFiles) {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', name), 'utf8'));
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assertStrictSchemaNodes(schema, name);
    const relativePath = new RegExp(schema.definitions.relativePath.pattern);
    for (const value of ['a/b', 'product/src/price.js']) assert.equal(relativePath.test(value), true, `${name}: ${value}`);
    for (const value of ['../escape', 'a/../escape', '/absolute', 'a\\b', 'a/./b']) assert.equal(relativePath.test(value), false, `${name}: ${value}`);
  }
});

test('caller digest and canonical source bytes are both required', () => {
  const root = copyFixture();
  try {
    const context = readContext(root);
    const wrongDigest = '0'.repeat(64);
    const rejected = api.loadContext({
      workspaceRoot: root,
      contextPath: 'context/pilot-context.json',
      expectedSha256: wrongDigest,
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((item) => item.code === 'context_digest_mismatch'));

    fs.appendFileSync(path.join(root, 'canonical/requirements.md'), '\nchanged\n');
    const stale = api.loadContext({
      workspaceRoot: root,
      contextPath: 'context/pilot-context.json',
      expectedSha256: context.sha256,
    });
    assert.equal(stale.ok, false);
    assert.ok(stale.errors.some((item) => item.code === 'source_digest_mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source byte bounds reject an oversized file and a snapshot over the total limit', () => {
  const root = copyFixture();
  try {
    const { value } = readContext(root);
    const oversizedPath = path.join(root, 'canonical/oversized.bin');
    const oversizedFd = fs.openSync(oversizedPath, 'w');
    fs.ftruncateSync(oversizedFd, api.MAX_SOURCE_BYTES + 1);
    fs.closeSync(oversizedFd);
    value.sources.push({ id: 'oversized-source', path: 'canonical/oversized.bin', sha256: '0'.repeat(64) });
    const oversized = api.validateContext(value, { workspaceRoot: root });
    assert.ok(oversized.errors.some((item) => item.code === 'source_size_limit'));

    value.sources.pop();
    for (let index = 0; index < 9; index += 1) {
      const relativePath = `canonical/sparse-${index}.bin`;
      const fd = fs.openSync(path.join(root, relativePath), 'w');
      fs.ftruncateSync(fd, api.MAX_SOURCE_BYTES);
      fs.closeSync(fd);
      value.sources.push({ id: `sparse-source-${index}`, path: relativePath, sha256: '0'.repeat(64) });
    }
    const overTotal = api.validateContext(value, { workspaceRoot: root });
    assert.ok(overTotal.errors.some((item) => item.code === 'source_total_size_limit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nested shape, references, and source line bounds fail closed', () => {
  const root = copyFixture();
  try {
    const { value } = readContext(root);
    value.requirements[0].unexpected = true;
    value.requirements[1].acceptanceIds = ['NO-SUCH-AC'];
    value.requirements[2].sourceLocation.endLine = 999;
    const checked = api.validateContext(value, { workspaceRoot: root });
    assert.equal(checked.ok, false);
    const codes = new Set(checked.errors.map((item) => item.code));
    assert.ok(codes.has('unknown_field'));
    assert.ok(codes.has('acceptance_reference_unknown'));
    assert.ok(codes.has('source_line_range_invalid'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed context collections return findings without throwing', () => {
  const root = copyFixture();
  try {
    const base = readContext(root).value;
    const mutations = [
      (value) => value.writeScope.allow.push(null),
      (value) => value.writeScope.deny.push(null),
      (value) => { value.checks = [null]; },
      (value) => { value.checks[0].verifierWritePaths = [null]; },
      (value) => { value.sources = [null]; },
      (value) => { value.requirements = [null]; },
      (value) => { value.acceptanceCriteria = [null]; },
      (value) => { value.riskRules = [null]; },
      (value) => { value.priorEvidence = [null]; },
      (value) => { value.decisions = [null]; },
      (value) => { value.checks = { malformed: true }; },
      (value) => { value.writeScope.allow = { malformed: true }; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(base);
      mutate(value);
      let result;
      assert.doesNotThrow(() => { result = api.validateContext(value, { workspaceRoot: root }); });
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed map members and typed paths return findings without throwing', () => {
  const root = copyFixture();
  try {
    const context = readContext(root).loaded;
    for (const writePath of [null, 7, { kind: 'file', path: null }, { kind: 'other', path: 'product/src/price.js' }]) {
      const map = JSON.parse(fs.readFileSync(path.join(root, 'specs/pilot-price/traceability.json'), 'utf8'));
      map.tasks[0].writePaths = [writePath];
      let result;
      assert.doesNotThrow(() => {
        result = api.validateTraceability(map, {
          workspaceRoot: root,
          contextResult: context,
          expectedContextSha256: context.contextSha256,
        });
      });
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
    }
    const map = JSON.parse(fs.readFileSync(path.join(root, 'specs/pilot-price/traceability.json'), 'utf8'));
    map.tasks = [null];
    const malformedTasks = api.validateTraceability(map, {
      workspaceRoot: root,
      contextResult: context,
      expectedContextSha256: context.contextSha256,
    });
    assert.equal(malformedTasks.ok, false);
    assert.ok(malformedTasks.errors.length > 0);

    map.tasks = [];
    map.artifactBindings = [null];
    const malformedBindings = api.validateTraceability(map, {
      workspaceRoot: root,
      contextResult: context,
      expectedContextSha256: context.contextSha256,
    });
    assert.equal(malformedBindings.ok, false);
    assert.ok(malformedBindings.errors.length > 0);

    map.artifactBindings = {};
    const malformedContainer = api.validateTraceability(map, {
      workspaceRoot: root,
      contextResult: context,
      expectedContextSha256: context.contextSha256,
    });
    assert.equal(malformedContainer.ok, false);
    assert.ok(malformedContainer.errors.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('write scopes, review risk, and task bindings are cross-validated', () => {
  const root = copyFixture();
  try {
    const context = readContext(root);
    assert.equal(context.loaded.ok, true);
    const mapFile = path.join(root, 'specs/pilot-price/traceability.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    map.tasks[0].writePaths = [{ kind: 'file', path: 'product/test/price.test.js' }];
    map.tasks[0].declaredReviewKind = 'risk_change';
    const checked = api.validateTraceability(map, {
      workspaceRoot: root,
      contextResult: context.loaded,
      expectedContextSha256: context.sha256,
    });
    assert.equal(checked.ok, false);
    const codes = new Set(checked.errors.map((item) => item.code));
    assert.ok(codes.has('write_scope_denied'));
    assert.ok(codes.has('review_kind_mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsafe paths and symlinked ancestors are rejected', (t) => {
  const root = copyFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-context-outside-'));
  try {
    assert.equal(api.isSafeRelativePath('../outside'), false);
    assert.equal(api.isSafeRelativePath('/etc/passwd'), false);
    assert.equal(api.isSafeRelativePath('a\\b'), false);
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.throws(() => api.inspectWorkspacePath(root, 'escape/new/file', { mustExist: false }), /path_symlink_escape/);
    assert.throws(() => api.inspectWorkspacePath(root, '../outside', { mustExist: false }), /path_unsafe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('write scopes reject in-root symlinks at file and ancestor paths', () => {
  const root = copyFixture();
  try {
    const context = readContext(root).loaded;
    const mapPath = path.join(root, 'specs/pilot-price/traceability.json');
    const symlinks = [
      ['product/src/alias.js', '../test/price.test.js', 'product/src/alias.js'],
      ['product/alias-src', 'src', 'product/alias-src/price.js'],
    ];
    for (const [linkPath, target, proposedPath] of symlinks) {
      fs.symlinkSync(target, path.join(root, linkPath));
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      map.tasks[0].writePaths = [{ kind: 'file', path: proposedPath }];
      const checked = api.validateTraceability(map, {
        workspaceRoot: root,
        contextResult: context,
        expectedContextSha256: context.contextSha256,
      });
      assert.equal(checked.ok, false);
      assert.ok(checked.errors.some((item) => item.code === 'path_symlink_forbidden'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary new files remain valid beneath an explicitly allowed directory', () => {
  const root = copyFixture();
  try {
    const loaded = readContext(root).loaded;
    const context = structuredClone(loaded.context);
    context.writeScope.allow.push({ kind: 'directory', path: 'product/src' });
    context.riskRules.push({
      id: 'RISK-product-src-directory',
      path: { kind: 'directory', path: 'product/src' },
      riskTags: [],
      sourceLocation: { sourceId: 'canonical-fixture', startLine: 5, endLine: 8 },
      rationale: 'A reviewed source directory allows contained implementation files.',
    });
    const verified = api.validateContext(context, { workspaceRoot: root });
    assert.equal(verified.ok, true, JSON.stringify(verified.errors));
    verified.contextSha256 = loaded.contextSha256;

    const map = JSON.parse(fs.readFileSync(path.join(root, 'specs/pilot-price/traceability.json'), 'utf8'));
    map.tasks[0].writePaths = [{ kind: 'file', path: 'product/src/new-helper.js' }];
    const checked = api.validateTraceability(map, {
      workspaceRoot: root,
      contextResult: verified,
      expectedContextSha256: loaded.contextSha256,
    });
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source line extraction accepts LF and CRLF and rejects bare CR and invalid ranges', () => {
  assert.deepEqual(api.splitSourceLines('one\ntwo\n'), ['one', 'two', '']);
  assert.deepEqual(api.splitSourceLines('one\r\ntwo\r\n'), ['one', 'two', '']);
  assert.equal(api.extractSourceLocation(Buffer.from('a\r\nb\r\n'), 2, 2), 'b');
  assert.throws(() => api.splitSourceLines('one\rtwo'), /source_newline_unsupported/);
  assert.throws(() => api.extractSourceLocation('one\ntwo', 0, 1), /source_line_range_invalid/);
});

test('map artifact bytes and externally supplied context binding are pinned', () => {
  const root = copyFixture();
  try {
    const context = readContext(root);
    const alteredMap = mapResult(root, context.loaded, 'f'.repeat(64));
    assert.equal(alteredMap.ok, false);
    assert.ok(alteredMap.errors.some((item) => item.code === 'accepted_context_digest_mismatch'));

    fs.appendFileSync(path.join(root, 'specs/pilot-price/spec.md'), '\nchanged\n');
    const staleArtifact = mapResult(root, context.loaded);
    assert.equal(staleArtifact.ok, false);
    assert.ok(staleArtifact.errors.some((item) => item.code === 'artifact_digest_mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
