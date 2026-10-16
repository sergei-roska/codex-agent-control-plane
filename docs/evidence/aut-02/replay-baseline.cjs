'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const entryPath = path.join(repoRoot, 'docs/evidence/aut-02/entry.json');
const testFiles = [
  'test/contracts.test.js',
  'test/review-policy.test.js',
  'test/a2a-role-service.test.js',
  'test/lead-graph.test.js',
];
const focusedSourceFiles = [
  'src/lead-graph.js',
  'src/a2a-role-service.js',
  'src/contracts.js',
  'src/review-policy.js',
];
const fixtureRoot = 'test/fixtures/autonomy/aut-02';

function usage() {
  return 'Usage: node docs/evidence/aut-02/replay-baseline.cjs --test-name-pattern <pattern> --output <path>';
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--test-name-pattern' || arg === '--output') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      parsed[arg] = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--test-name-pattern=')) {
      parsed['--test-name-pattern'] = arg.slice('--test-name-pattern='.length);
    } else if (arg.startsWith('--output=')) {
      parsed['--output'] = arg.slice('--output='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed['--test-name-pattern'] || !parsed['--output']) throw new Error(usage());
  return parsed;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function hashTree(root, relativeRoot) {
  const result = {};
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return result;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result[path.relative(root, absolute).split(path.sep).join('/')] = fileHash(absolute);
      else throw new Error(`Unsupported fixture entry: ${path.relative(root, absolute)}`);
    }
  };
  visit(absoluteRoot);
  return result;
}

function baselineHash(commit, relativePath) {
  const bytes = execFileSync('git', ['show', `${commit}:${relativePath}`], { cwd: repoRoot });
  return sha256(bytes);
}

function parseCounts(tap) {
  const match = (label) => {
    const found = tap.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return found ? Number(found[1]) : null;
  };
  return {
    tests: match('tests'),
    pass: match('pass'),
    fail: match('fail'),
    skipped: match('skipped'),
    cancelled: match('cancelled'),
    todo: match('todo'),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  const commit = entry.implementationCommit;
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('entry.json has no full implementationCommit');
  execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: repoRoot });

  const outputPath = path.resolve(repoRoot, options['--output']);
  const evidenceRoot = path.join(repoRoot, 'docs/evidence/aut-02');
  const outputRelative = path.relative(evidenceRoot, outputPath);
  if (!outputRelative || outputRelative === '..' || outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative)) {
    throw new Error('--output must name a file inside docs/evidence/aut-02');
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aut02-replay-baseline-'));
  const baselineRoot = path.join(tempRoot, 'workspace');
  fs.mkdirSync(baselineRoot);
  try {
    const archivePath = path.join(tempRoot, 'baseline.tar');
    execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, commit], { cwd: repoRoot });
    execFileSync('tar', ['-xf', archivePath, '-C', baselineRoot], { cwd: repoRoot });

    const overlayFiles = {};
    for (const relativePath of testFiles) {
      const currentPath = path.join(repoRoot, relativePath);
      if (!fs.existsSync(currentPath)) throw new Error(`Current focused test is missing: ${relativePath}`);
      const destination = path.join(baselineRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(currentPath, destination);
      overlayFiles[relativePath] = fileHash(currentPath);
    }
    const currentFixtures = path.join(repoRoot, fixtureRoot);
    if (fs.existsSync(currentFixtures)) {
      const destination = path.join(baselineRoot, fixtureRoot);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(currentFixtures, destination, { recursive: true, force: true });
      Object.assign(overlayFiles, hashTree(repoRoot, fixtureRoot));
    }

    const modulesPath = path.join(repoRoot, 'node_modules');
    if (!fs.existsSync(modulesPath)) throw new Error('Current node_modules is unavailable');
    fs.symlinkSync(modulesPath, path.join(baselineRoot, 'node_modules'), 'dir');

    const runnerArgs = [
      '--test',
      '--test-isolation=none',
      '--test-reporter=tap',
      `--test-name-pattern=${options['--test-name-pattern']}`,
      ...testFiles,
    ];
    const command = `${process.execPath} ${runnerArgs.map((value) => JSON.stringify(value)).join(' ')}`;
    const result = spawnSync(process.execPath, runnerArgs, {
      cwd: baselineRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    if (result.error) throw result.error;
    const tap = `${result.stdout || ''}${result.stderr || ''}`;
    if (!tap.startsWith('TAP version 13\n')) throw new Error(`Node test runner did not produce TAP output: ${tap.slice(0, 1000)}`);

    const counts = parseCounts(tap);
    if (Object.values(counts).some((count) => count === null)) throw new Error('Node test output is missing TAP summary counts');
    const manifest = {
      schemaVersion: 1,
      baselineCommit: commit,
      baselineSourceHashes: Object.fromEntries(focusedSourceFiles.map((file) => [file, baselineHash(commit, file)])),
      overlayHashes: overlayFiles,
      nodeVersion: process.version,
      dependencyLink: { path: modulesPath, policy: 'read-only by convention' },
      testNamePattern: options['--test-name-pattern'],
      testFiles,
      command,
      baselineWorkspace: 'temporary archive under os.tmpdir; removed after execution',
      counts,
      runnerExitCode: result.status,
      outcome: result.status === 0 ? 'passed' : 'failed',
    };
    const manifestComment = `# AUT-02-REPLAY-MANIFEST ${JSON.stringify(manifest)}\n`;
    const headerEnd = tap.indexOf('\n') + 1;
    const output = `${tap.slice(0, headerEnd)}${manifestComment}${tap.slice(headerEnd)}`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, 'utf8');
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n${usage()}\n`);
  process.exitCode = 1;
}
