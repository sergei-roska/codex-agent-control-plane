'use strict';

// Explicit-input CLI for the AUT-05 offline autonomy evaluator.
//
// Usage:
//   node tools/autonomy/evaluate.js \
//     [--root <trusted-root>] --corpus <corpus.json> --observations <obs.json> \
//     --baseline <baseline.json> \
//     [--json]
//
// `--json` toggles pretty (indented) vs compact (single-line) JSON output. The
// report is always JSON; it is written to stdout. Diagnostics go to stderr.
//
// This command NEVER executes a model, runs corpus shell commands, edits source
// state, or writes a database. Inputs and references are relative to --root
// (default: repository root). Resolved symlinks may not escape that root; each
// artifact is limited to 10 MiB.

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { evaluate } = require('../../src/autonomy-evaluation');

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const EXECUTING_SOURCE_DIGESTS = Object.freeze({
  'src/autonomy-evaluation.js': crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../../src/autonomy-evaluation'))).digest('hex'),
  'tools/autonomy/evaluate.js': crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
});

function parseArgs(argv) {
  const out = {};
  const valueFlags = { '--corpus': 'corpus', '--observations': 'observations', '--baseline': 'baseline', '--root': 'root' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') {
      if (out.json) throw new Error('--json may be supplied only once');
      out.json = true;
      continue;
    }
    const key = valueFlags[flag];
    if (!key || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete argument "${flag}"`);
    }
    if (out[key] !== undefined) throw new Error(`${flag} may be supplied only once`);
    out[key] = argv[i + 1];
    i += 1;
  }
  for (const key of ['corpus', 'observations', 'baseline']) {
    if (!out[key]) throw new Error(`Missing required --${key} <path>`);
  }
  if (out.root === undefined) out.root = path.resolve(__dirname, '../..');
  return out;
}

function safeArtifactPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).some((part) => part === '..' || part === '')) {
    throw new Error(`artifact path must be a safe relative path: ${String(relativePath)}`);
  }
  const resolvedRoot = fs.realpathSync(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate !== resolvedRoot && !realCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`artifact path escapes trusted root: ${relativePath}`);
  }
  const stat = fs.statSync(realCandidate);
  if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw new Error(`artifact is not a bounded regular file: ${relativePath}`);
  return realCandidate;
}

function readArtifact(root, relativePath) {
  const resolved = safeArtifactPath(root, relativePath);
  const bytes = fs.readFileSync(resolved);
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${relativePath}`);
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), resolved };
}

function collectArtifactReferences(corpus, observations, baseline) {
  const refs = new Set();
  const addList = (list) => {
    if (Array.isArray(list)) for (const item of list) if (item && typeof item.path === 'string') refs.add(item.path);
  };
  if (corpus && Array.isArray(corpus.cases)) for (const item of corpus.cases) {
    if (!item || typeof item !== 'object') continue;
    addList(item.canonicalInputs);
    addList(item.inputArtifacts);
    addList(item.expectedOutcomeArtifacts);
  }
  if (observations && Array.isArray(observations.observations)) for (const item of observations.observations) {
    if (item && typeof item === 'object') addList(item.evidenceArtifacts);
  }
  if (baseline && typeof baseline === 'object') {
    addList(baseline.sourceOutputDigests);
    addList(baseline.verificationEvidence);
    addList(baseline.auditEvidence);
  }
  return [...refs];
}

function collectVerifiedRequirementAssessments(corpus, observations, artifacts) {
  const verified = {};
  const corpusCases = corpus && Array.isArray(corpus.cases) ? corpus.cases : [];
  if (!observations || !Array.isArray(observations.observations)) return verified;
  for (const observation of observations.observations) {
    if (!observation || !Array.isArray(observation.metrics)) continue;
    for (const metric of observation.metrics) {
      if (!metric || metric.metricId !== 'requirement_preservation' || metric.value === null
        || typeof metric.sourceRef !== 'string') continue;
      const artifact = artifacts.get(metric.sourceRef);
      if (!artifact) continue;
      let assessment;
      try {
        assessment = JSON.parse(artifact.bytes.toString('utf8'));
      } catch {
        continue;
      }
      const review = assessment && assessment.independentReview;
      const scoring = assessment && assessment.scoring;
      const criteria = assessment && assessment.semanticRequirements;
      const criterionIds = Array.isArray(criteria) ? criteria.map((item) => item && item.requirementId) : [];
      const inventory = review && typeof review.inventoryPath === 'string' ? artifacts.get(review.inventoryPath) : null;
      const reviewedArtifact = assessment && typeof assessment.artifactPath === 'string' ? artifacts.get(assessment.artifactPath) : null;
      const provenance = review && typeof review.provenancePath === 'string' ? artifacts.get(review.provenancePath) : null;
      let capture;
      try {
        capture = provenance ? JSON.parse(provenance.bytes.toString('utf8')) : null;
      } catch {
        continue;
      }
      const caseRecord = corpusCases.find((item) => item && item.caseId === observation.caseId);
      const canonicalInputs = caseRecord && Array.isArray(caseRecord.canonicalInputs) ? caseRecord.canonicalInputs : [];
      const captureSources = capture && Array.isArray(capture.sources) ? capture.sources : [];
      const sourcePaths = captureSources.map((source) => source && source.path);
      const sourceDigestsMatch = captureSources.length === canonicalInputs.length
        && new Set(sourcePaths).size === sourcePaths.length
        && captureSources.every((source) => {
          const expected = canonicalInputs.find((input) => input.path === source.path);
          const actual = artifacts.get(source.path);
          return expected && actual && source.sha256 === expected.sha256 && actual.sha256 === expected.sha256;
        });
      const satisfiedCount = Array.isArray(criteria) ? criteria.filter((item) => item && item.result === 'pass').length : -1;
      const observationEvidence = Array.isArray(observation.evidenceArtifacts) ? observation.evidenceArtifacts : [];
      const assessmentEvidence = observationEvidence.find((ref) => ref.path === assessment?.artifactPath);
      const caseOutput = caseRecord && Array.isArray(caseRecord.inputArtifacts)
        ? caseRecord.inputArtifacts.find((ref) => ref.path === assessment?.artifactPath)
        : null;
      if (!assessment || assessment.assessmentStatus !== 'independently_reviewed_semantic_assessment'
        || !review || review.verdict !== 'approve' || review.sourceEvidenceDigestsMatchCapture !== true
        || !inventory || review.inventorySha256 !== inventory.sha256
        || !reviewedArtifact || !assessmentEvidence || !caseOutput
        || assessmentEvidence.sha256 !== reviewedArtifact.sha256 || caseOutput.sha256 !== reviewedArtifact.sha256
        || review.reviewedArtifactSha256 !== reviewedArtifact.sha256
        || !provenance || review.provenanceSha256 !== provenance.sha256
        || !capture || capture.captureKind !== 'manual_current_lead_artifact'
        || capture.artifactSha256 !== reviewedArtifact.sha256
        || !caseRecord || capture.sourceSnapshot !== caseRecord.sourceSnapshot
        || !sourceDigestsMatch
        || !Array.isArray(criteria) || criteria.length === 0
        || review.semanticRequirementCount !== criteria.length
        || criteria.some((item) => !item || !['pass', 'fail'].includes(item.result) || typeof item.requirementId !== 'string')
        || new Set(criterionIds).size !== criterionIds.length
        || !scoring || scoring.metricId !== 'requirement_preservation'
        || scoring.availability !== 'measured'
        || scoring.denominator !== criteria.length
        || scoring.numerator !== review.semanticRequirementsSatisfied
        || scoring.numerator !== satisfiedCount
        || scoring.excludedIncompleteCount !== 0
        || scoring.value !== scoring.numerator / scoring.denominator) continue;
      verified[metric.sourceRef] = {
        sha256: artifact.sha256,
        inventoryPath: review.inventoryPath,
        inventorySha256: review.inventorySha256,
        verdict: review.verdict,
        semanticRequirementCount: review.semanticRequirementCount,
        semanticRequirementsSatisfied: review.semanticRequirementsSatisfied,
        numerator: scoring.numerator,
        denominator: scoring.denominator,
        excludedIncompleteCount: scoring.excludedIncompleteCount,
        value: scoring.value,
      };
    }
  }
  return verified;
}

function verifyExecutingSourcePins(baseline) {
  if (!baseline || !Array.isArray(baseline.sourceOutputDigests)) throw new Error('baseline sourceOutputDigests are required');
  for (const [sourcePath, executingDigest] of Object.entries(EXECUTING_SOURCE_DIGESTS)) {
    const pin = baseline.sourceOutputDigests.find((item) => item && item.path === sourcePath);
    if (!pin || pin.sha256 !== executingDigest) {
      throw new Error(`baseline pin for ${sourcePath} does not match the currently executing checker bytes`);
    }
  }
}

function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return 2;
  }

  let corpusRaw;
  let observationsRaw;
  let baselineRaw;
  let corpusFile;
  let observationsFile;
  let baselineFile;
  let root;
  try {
    root = fs.realpathSync(args.root);
    corpusFile = readArtifact(root, args.corpus);
    observationsFile = readArtifact(root, args.observations);
    baselineFile = readArtifact(root, args.baseline);
    corpusRaw = corpusFile.bytes;
    observationsRaw = observationsFile.bytes;
    baselineRaw = baselineFile.bytes;
  } catch (error) {
    stderr.write(`autonomy_evaluate_error: cannot read input: ${error.message}\n`);
    return 3;
  }

  let corpus;
  let observations;
  let baseline;
  try {
    corpus = JSON.parse(corpusRaw.toString('utf8'));
    observations = JSON.parse(observationsRaw.toString('utf8'));
    baseline = JSON.parse(baselineRaw.toString('utf8'));
  } catch (error) {
    stderr.write(`autonomy_evaluate_error: invalid JSON: ${error.message}\n`);
    return 3;
  }

  const corpusSha256 = crypto.createHash('sha256').update(corpusRaw).digest('hex');
  let artifacts;
  try {
    const pinnedOutputs = baseline && Array.isArray(baseline.sourceOutputDigests) ? baseline.sourceOutputDigests : [];
    verifyExecutingSourcePins(baseline);
    for (const [inputPath, inputFile] of [[args.corpus, corpusFile], [args.observations, observationsFile]]) {
      const pin = pinnedOutputs.find((item) => item && item.path === inputPath);
      if (!pin || pin.sha256 !== inputFile.sha256) throw new Error(`input is not pinned by baseline sourceOutputDigests: ${inputPath}`);
    }
    artifacts = new Map();
    for (const artifactPath of collectArtifactReferences(corpus, observations, baseline)) {
      artifacts.set(artifactPath, readArtifact(root, artifactPath));
    }
    const snapshot = Object.fromEntries([...artifacts].map(([artifactPath, item]) => [artifactPath, item.sha256]));
    // Re-read every referenced byte stream immediately before evaluation so an
    // artifact changed during collection cannot be treated as one snapshot.
    for (const [artifactPath, prior] of artifacts) {
      if (readArtifact(root, artifactPath).sha256 !== prior.sha256) throw new Error(`artifact changed during snapshot: ${artifactPath}`);
    }
    if (readArtifact(root, args.corpus).sha256 !== corpusFile.sha256
      || readArtifact(root, args.observations).sha256 !== observationsFile.sha256
      || readArtifact(root, args.baseline).sha256 !== baselineFile.sha256) {
      throw new Error('an input changed during snapshot');
    }
    const verifiedRequirementAssessments = collectVerifiedRequirementAssessments(corpus, observations, artifacts);
    const report = evaluate({ corpus, observations, baseline, corpusSha256, verifiedArtifacts: snapshot, verifiedRequirementAssessments });
    const output = args.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${JSON.stringify(report)}\n`;
    stdout.write(output);
    return report.valid && report.eligibility.assessed ? 0 : 2;
  } catch (error) {
    stderr.write(`autonomy_evaluate_error: artifact verification failed: ${String(error.message).slice(0, 240)}\n`);
    return 3;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env, { stdout: process.stdout, stderr: process.stderr });
}

module.exports = { parseArgs, main, safeArtifactPath, collectArtifactReferences, collectVerifiedRequirementAssessments, verifyExecutingSourcePins };
