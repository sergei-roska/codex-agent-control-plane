'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseArgs, main, safeArtifactPath, collectArtifactReferences, collectVerifiedRequirementAssessments } = require('../tools/autonomy/evaluate');

const ROOT = path.join(__dirname, '..');
const CORPUS_PATH = 'test/fixtures/autonomy/corpus-v3/corpus.json';
const OBS_PATH = 'test/fixtures/autonomy/corpus-v3/observations.json';
const BASELINE_PATH = 'test/fixtures/autonomy/corpus-v3/baseline.json';

function makeIo() {
  const io = {
    _out: '',
    _err: '',
    stdout: { write(chunk) { io._out += chunk; } },
    stderr: { write(chunk) { io._err += chunk; } },
  };
  return io;
}

function trio() {
  return ['--root', ROOT, '--corpus', CORPUS_PATH, '--observations', OBS_PATH, '--baseline', BASELINE_PATH];
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'test/fixtures/autonomy/.aut-eval-cli-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function verifiedFixtureArtifacts(corpus, observations, baseline) {
  return new Map(collectArtifactReferences(corpus, observations, baseline).map((artifactPath) => {
    const bytes = fs.readFileSync(path.join(ROOT, artifactPath));
    return [artifactPath, { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  }));
}

function updateReferenceDigest(references, artifactPath, sha256) {
  const reference = references.find((item) => item.path === artifactPath);
  if (reference) reference.sha256 = sha256;
}

function copyFixtureRoot(target) {
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, CORPUS_PATH), 'utf8'));
  const observations = JSON.parse(fs.readFileSync(path.join(ROOT, OBS_PATH), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_PATH), 'utf8'));
  const paths = new Set(collectArtifactReferences(corpus, observations, baseline));
  paths.add(CORPUS_PATH);
  paths.add(OBS_PATH);
  paths.add(BASELINE_PATH);
  for (const artifactPath of paths) {
    const destination = path.join(target, artifactPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, artifactPath), destination);
  }
  return { corpus, observations, baseline };
}

test('parseArgs requires all three input flags', () => {
  assert.throws(() => parseArgs(['--corpus', 'c.json']), /Missing required --observations/);
  assert.throws(() => parseArgs(['--corpus', 'c.json', '--observations', 'o.json']), /Missing required --baseline/);
  assert.throws(() => parseArgs([]), /Missing required --corpus/);
  assert.throws(() => parseArgs(['--nope', 'x']), /Unknown or incomplete argument/);
});

test('parseArgs accepts the explicit root, full input flags, and --json', () => {
  const args = parseArgs(['--root', '/safe/root', '--corpus', 'c', '--observations', 'o', '--baseline', 'b', '--json']);
  assert.deepEqual(args, { root: '/safe/root', corpus: 'c', observations: 'o', baseline: 'b', json: true });
});

test('main() exits 0 on the fixture trio and prints a valid report to stdout only', () => {
  const io = makeIo();
  const code = main([...trio(), '--json'], {}, io);
  assert.equal(code, 0);
  assert.equal(io._err, '');
  const report = JSON.parse(io._out);
  assert.equal(report.schemaVersion, 'autonomy-evaluation/v1');
  assert.equal(report.valid, true);
  assert.equal(report.eligibility.assessed, true);
  assert.equal(report.summary.passedCount, 4);
  assert.equal(report.summary.failedCount, 2);
  assert.equal(report.summary.inconclusiveCount, 1);
  assert.equal(report.summary.acceptedResults, null);
});

test('main() emits compact single-line JSON by default', () => {
  const io = makeIo();
  const code = main(trio(), {}, io);
  assert.equal(code, 0);
  const lines = io._out.trim().split('\n');
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.equal(report.schemaVersion, 'autonomy-evaluation/v1');
});

test('main() exits 2 on a semantically invalid input (wrong corpusDigest)', () => {
  withTempDir((dir) => {
    const badObsPath = path.relative(ROOT, path.join(dir, 'observations.json'));
    const observations = JSON.parse(fs.readFileSync(OBS_PATH, 'utf8'));
    observations.observations[0].corpusDigest = '0'.repeat(64);
    fs.writeFileSync(badObsPath, JSON.stringify(observations));

    const io = makeIo();
    const code = main(['--root', ROOT, '--corpus', CORPUS_PATH, '--observations', badObsPath, '--baseline', BASELINE_PATH, '--json'], {}, io);
    assert.equal(code, 3);
    assert.equal(io._out, '');
    assert.match(io._err, /input is not pinned by baseline/);
  });
});

test('main() exits 3 on a missing file and writes diagnostics to stderr only', () => {
  const io = makeIo();
  const code = main(['--root', ROOT, '--corpus', 'missing/corpus.json', '--observations', OBS_PATH, '--baseline', BASELINE_PATH], {}, io);
  assert.equal(code, 3);
  assert.equal(io._out, '');
  assert.match(io._err, /cannot read input/);
});

test('main() exits 3 on invalid JSON input', () => {
  withTempDir((dir) => {
  const badJsonPath = path.relative(ROOT, path.join(dir, 'corpus.json'));
    fs.writeFileSync(badJsonPath, '{ not valid json');
    const io = makeIo();
  const code = main(['--root', ROOT, '--corpus', badJsonPath, '--observations', OBS_PATH, '--baseline', BASELINE_PATH], {}, io);
    assert.equal(code, 3);
    assert.equal(io._out, '');
    assert.match(io._err, /invalid JSON/);
  });
});

test('main() exits 2 on usage errors (unknown flag)', () => {
  const io = makeIo();
  const code = main(['--root', ROOT, '--corpus', CORPUS_PATH, '--observations', OBS_PATH, '--baseline', BASELINE_PATH, '--bogus'], {}, io);
  assert.equal(code, 2);
  assert.match(io._err, /usage:/);
});

test('safeArtifactPath rejects traversal and symlinks escaping the trusted root', () => {
  withTempDir((dir) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aut-eval-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'outside.json'), '{}');
      fs.symlinkSync(outside, path.join(dir, 'escape'));
      assert.throws(() => safeArtifactPath(dir, '../outside.json'), /safe relative path/);
      assert.throws(() => safeArtifactPath(dir, 'escape/outside.json'), /escapes trusted root/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('planning score requires reviewer, capture, and source bytes to join exactly', () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, CORPUS_PATH), 'utf8'));
  const observations = JSON.parse(fs.readFileSync(path.join(ROOT, OBS_PATH), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_PATH), 'utf8'));
  const artifacts = verifiedFixtureArtifacts(corpus, observations, baseline);
  const reviewPath = 'test/fixtures/autonomy/planning-baseline/reviewer-assessment.json';
  const capturePath = 'test/fixtures/autonomy/planning-baseline/capture-provenance.json';
  const originalReview = JSON.parse(artifacts.get(reviewPath).bytes.toString('utf8'));
  const result = collectVerifiedRequirementAssessments(corpus, observations, artifacts);
  assert.equal(result[reviewPath].value, 1);

  const staleReview = JSON.parse(JSON.stringify(originalReview));
  staleReview.independentReview.reviewedArtifactSha256 = '0'.repeat(64);
  const staleReviewBytes = Buffer.from(JSON.stringify(staleReview));
  const staleReviewSha = crypto.createHash('sha256').update(staleReviewBytes).digest('hex');
  const staleReviewArtifacts = new Map(artifacts);
  staleReviewArtifacts.set(reviewPath, { bytes: staleReviewBytes, sha256: staleReviewSha });
  const planningCase = corpus.cases.find((item) => item.caseId === 'aut-01-planning-baseline');
  updateReferenceDigest(planningCase.inputArtifacts, reviewPath, staleReviewSha);
  updateReferenceDigest(observations.observations[6].evidenceArtifacts, reviewPath, staleReviewSha);
  assert.deepEqual(collectVerifiedRequirementAssessments(corpus, observations, staleReviewArtifacts), {});

  const freshCorpus = JSON.parse(fs.readFileSync(path.join(ROOT, CORPUS_PATH), 'utf8'));
  const freshObservations = JSON.parse(fs.readFileSync(path.join(ROOT, OBS_PATH), 'utf8'));
  const freshArtifacts = verifiedFixtureArtifacts(freshCorpus, freshObservations, baseline);
  const provenance = JSON.parse(freshArtifacts.get(capturePath).bytes.toString('utf8'));
  provenance.sources[0].sha256 = '0'.repeat(64);
  const provenanceBytes = Buffer.from(JSON.stringify(provenance));
  const provenanceSha = crypto.createHash('sha256').update(provenanceBytes).digest('hex');
  freshArtifacts.set(capturePath, { bytes: provenanceBytes, sha256: provenanceSha });
  const review = JSON.parse(freshArtifacts.get(reviewPath).bytes.toString('utf8'));
  review.independentReview.provenanceSha256 = provenanceSha;
  const reviewBytes = Buffer.from(JSON.stringify(review));
  const reviewSha = crypto.createHash('sha256').update(reviewBytes).digest('hex');
  freshArtifacts.set(reviewPath, { bytes: reviewBytes, sha256: reviewSha });
  updateReferenceDigest(freshCorpus.cases.find((item) => item.caseId === 'aut-01-planning-baseline').inputArtifacts, reviewPath, reviewSha);
  updateReferenceDigest(freshObservations.observations[6].evidenceArtifacts, reviewPath, reviewSha);
  assert.deepEqual(collectVerifiedRequirementAssessments(freshCorpus, freshObservations, freshArtifacts), {});
});

test('custom root cannot repin a different checker than the code actually executing', () => {
  withTempDir((tempRoot) => {
    const { baseline } = copyFixtureRoot(tempRoot);
    const changedSourcePath = 'src/autonomy-evaluation.js';
    const changedBytes = Buffer.from('module.exports = {};\n');
    fs.writeFileSync(path.join(tempRoot, changedSourcePath), changedBytes);
    const pin = baseline.sourceOutputDigests.find((item) => item.path === changedSourcePath);
    pin.sha256 = crypto.createHash('sha256').update(changedBytes).digest('hex');
    fs.writeFileSync(path.join(tempRoot, BASELINE_PATH), JSON.stringify(baseline));

    const io = makeIo();
    const code = main(['--root', tempRoot, '--corpus', CORPUS_PATH, '--observations', OBS_PATH, '--baseline', BASELINE_PATH], {}, io);
    assert.equal(code, 3);
    assert.match(io._err, /does not match the currently executing checker bytes/);
    assert.equal(io._out, '');
  });
});
