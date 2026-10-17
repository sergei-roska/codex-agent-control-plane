'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = process.cwd();
const cohortRoot = path.join(repo, 'docs/evidence/aut-03/live-trial/cohort-3');
const fixtureRoot = path.join(repo, 'test/fixtures/spec-kit/pilot-price');
const evidenceRoot = path.join(repo, 'docs/evidence/aut-03/s08');
const contextDigest = '44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf';
const expectedSourceCommit = 'ebe51c8f3a6139afa4141f116707d9c94e8be952';
const profileRoot = path.join(repo, 'profiles');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseOutput(outputPath) {
  const raw = fs.readFileSync(outputPath);
  const text = raw.toString('utf8');
  const offset = text.indexOf('{"explanation"');
  if (offset < 0) throw new Error(`trial_plan_json_missing:${outputPath}`);
  const envelope = JSON.parse(text.slice(offset));
  if (!envelope.trialPlan || !Array.isArray(envelope.trialPlan.tasks)) throw new Error(`trial_plan_shape_invalid:${outputPath}`);
  return { rawSha256: sha256(raw), envelope, raw };
}

function sourceHashes(root, context) {
  const result = {};
  for (const source of context.sources) {
    const bytes = fs.readFileSync(path.join(root, source.path));
    const digest = sha256(bytes);
    if (digest !== source.sha256) throw new Error(`frozen_source_mismatch:${source.path}`);
    result[source.path] = digest;
  }
  return result;
}

function projections(plan) {
  const spec = [
    '# Evaluator projection of the returned trial plan',
    '',
    `Feature: ${plan.featureId}`,
    `Context SHA-256: ${plan.contextSha256}`,
    '',
    '## Requirements',
    ...(plan.mandatoryRequirementIds || []).map((id) => `- ${id}`),
    '',
    '## Acceptance criteria',
    ...(plan.mandatoryAcceptanceIds || []).map((id) => `- ${id}`),
    '',
  ].join('\n');
  const planningRows = plan.tasks.map((task) => `- ${task.id} (${task.role}): ${task.objective}`);
  const planMarkdown = [
    '# Evaluator projection of the returned trial plan',
    '',
    ...planningRows,
    '',
    '## Checks',
    ...((plan.checks || []).map((check) => `- ${check.id}: ${JSON.stringify(check.argv || [])}`)),
    '',
  ].join('\n');
  const taskMarkdown = [
    '# Evaluator task checklist projection',
    '',
    '<!-- harness-task-map:v1 begin -->',
    ...plan.tasks.map((task) => `- [ ] ${task.id} ${task.objective}`),
    '<!-- harness-task-map:v1 end -->',
    '',
  ].join('\n');
  return { spec, plan: planMarkdown, tasks: taskMarkdown };
}

function runArm(arm, tempRoot) {
  const sourceRoot = path.join(cohortRoot, arm, 'pilot-price-f2');
  const outputPath = path.join(sourceRoot, 'output.txt');
  const parsed = parseOutput(outputPath);
  const plan = parsed.envelope.trialPlan;
  const evaluationRoot = path.join(tempRoot, arm);
  fs.cpSync(fixtureRoot, evaluationRoot, { recursive: true, errorOnExist: true });

  const contextPath = path.join(evaluationRoot, 'context/pilot-context.json');
  const contextBytes = fs.readFileSync(contextPath);
  if (sha256(contextBytes) !== contextDigest) throw new Error(`context_digest_mismatch:${arm}`);
  const context = JSON.parse(contextBytes.toString('utf8'));
  const inputHashesBefore = sourceHashes(evaluationRoot, context);
  const acceptedContextPath = path.join(evaluationRoot, 'context/accepted-context.json');
  const acceptedContext = JSON.parse(fs.readFileSync(acceptedContextPath, 'utf8'));
  if (acceptedContext.contextSha256 !== contextDigest) throw new Error(`accepted_context_mismatch:${arm}`);

  const generated = projections(plan);
  const artifactRoot = path.join(evaluationRoot, 'specs/pilot-price');
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'spec.md'), generated.spec);
  fs.writeFileSync(path.join(artifactRoot, 'plan.md'), generated.plan);
  fs.writeFileSync(path.join(artifactRoot, 'tasks.md'), generated.tasks);
  const bindings = [
    { role: 'spec', path: 'specs/pilot-price/spec.md', sha256: sha256(Buffer.from(generated.spec)) },
    { role: 'plan', path: 'specs/pilot-price/plan.md', sha256: sha256(Buffer.from(generated.plan)) },
    { role: 'tasks', path: 'specs/pilot-price/tasks.md', sha256: sha256(Buffer.from(generated.tasks)) },
  ];
  const map = {
    schemaVersion: plan.schemaVersion,
    featureId: plan.featureId,
    contextSha256: plan.contextSha256,
    artifactBindings: bindings,
    tasks: plan.tasks,
  };
  const mapBytes = Buffer.from(`${JSON.stringify(map, null, 2)}\n`);
  const mapPath = path.join(artifactRoot, 'traceability.json');
  fs.writeFileSync(mapPath, mapBytes);

  const cli = path.join(repo, 'tools/spec-kit/analyze.js');
  const args = [
    cli,
    '--workspace', evaluationRoot,
    '--context', 'context/pilot-context.json',
    '--context-sha256', contextDigest,
    '--map', 'specs/pilot-price/traceability.json',
    '--profiles', profileRoot,
    '--json',
  ];
  const child = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
  if (child.error) throw child.error;
  let report;
  try { report = JSON.parse(child.stdout); } catch (_) { throw new Error(`analyzer_json_invalid:${arm}:${child.stderr}`); }
  const inputHashesAfter = sourceHashes(evaluationRoot, context);
  const unchanged = JSON.stringify(inputHashesBefore) === JSON.stringify(inputHashesAfter);

  const caseEvidenceRoot = path.join(evidenceRoot, arm);
  fs.mkdirSync(caseEvidenceRoot, { recursive: true });
  for (const name of ['spec.md', 'plan.md', 'tasks.md', 'traceability.json']) {
    fs.copyFileSync(path.join(artifactRoot, name), path.join(caseEvidenceRoot, name));
  }
  fs.writeFileSync(path.join(caseEvidenceRoot, 'analyzer-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(caseEvidenceRoot, 'analyzer-stderr.txt'), child.stderr || '');
  if (!unchanged) throw new Error(`input_drift_after_analysis:${arm}`);

  return {
    arm,
    caseId: 'pilot-price-f2',
    taskId: JSON.parse(fs.readFileSync(path.join(sourceRoot, 'run.json'), 'utf8')).taskId,
    rawOutputPath: path.relative(repo, outputPath),
    rawOutputSha256: parsed.rawSha256,
    trialPlanSha256: sha256(Buffer.from(JSON.stringify(plan))),
    generatedArtifactHashes: bindings,
    traceabilitySha256: sha256(mapBytes),
    analyzerExitCode: child.status,
    analyzerVerdict: report.verdict,
    analyzerFingerprint: report.analysisFingerprint,
    findings: report.findings,
    passes: report.passes,
    assignmentValidation: report.assignmentValidation.map((item) => ({ taskId: item.taskId, kind: item.kind, validation: item.validation })),
    adapterContractPassed: report.passes.assignments === 'passed',
    inputHashesBefore,
    inputHashesAfter,
    inputsUnchanged: unchanged,
  };
}

function main() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0 || git.stdout.trim() !== expectedSourceCommit) throw new Error('source_commit_mismatch');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aut03-s08-'));
  try {
    const report = {
      schemaVersion: 'aut-03-s08-qualification/v1',
      sourceCommit: expectedSourceCommit,
      contextSha256: contextDigest,
      normalization: 'Projected the returned tasks array unchanged into the analyzer map; the map envelope contains only schemaVersion, featureId, contextSha256, and tasks. Added exactly three artifact bindings whose hashes were calculated from evaluator-generated spec.md, plan.md, and tasks.md projections. No task field, role, identifier, write path, or task meaning was repaired.',
      execution: 'Ran the existing offline spec analyzer, which invokes the real assignment adapter. No tests or task commands were run.',
      cases: [runArm('skill-off', tempRoot), runArm('skill-on', tempRoot)],
    };
    fs.writeFileSync(path.join(evidenceRoot, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`);
    const hashes = [];
    for (const file of [
      path.join(evidenceRoot, 'qualification.json'),
      ...['skill-off', 'skill-on'].flatMap((arm) => ['spec.md', 'plan.md', 'tasks.md', 'traceability.json', 'analyzer-report.json', 'analyzer-stderr.txt'].map((name) => path.join(evidenceRoot, arm, name))),
    ]) hashes.push({ path: path.relative(repo, file), sha256: sha256(fs.readFileSync(file)), size: fs.statSync(file).size });
    fs.writeFileSync(path.join(evidenceRoot, 'manifest.json'), `${JSON.stringify({ schemaVersion: 'aut-03-s08-manifest/v1', files: hashes }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report.cases.map(({ arm, analyzerExitCode, analyzerVerdict, analyzerFingerprint, findings, adapterContractPassed, inputsUnchanged }) => ({ arm, analyzerExitCode, analyzerVerdict, analyzerFingerprint, findings, adapterContractPassed, inputsUnchanged })), null, 2)}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
