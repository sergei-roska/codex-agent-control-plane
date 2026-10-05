'use strict';

// node bench/make-trial-workspace.js <fixtureId> [--into <dir>]
// Copies a fixture into a fresh repo with one fixed commit. Grader-only
// files (GOAL.txt, CHECKS.json, FIXTURE.md, REFERENCE_FIX.patch) are not copied.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FIXTURES = path.join(__dirname, 'fixtures');
const EXCLUDE = new Set(['GOAL.txt', 'CHECKS.json', 'FIXTURE.md', 'REFERENCE_FIX.patch']);
const DATE = '2026-01-01T00:00:00Z';

function copyTree(src, dest, top) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (top && EXCLUDE.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to, false);
    else fs.copyFileSync(from, to);
  }
}

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Bench',
      GIT_AUTHOR_EMAIL: 'bench@example.invalid',
      GIT_AUTHOR_DATE: DATE,
      GIT_COMMITTER_NAME: 'Bench',
      GIT_COMMITTER_EMAIL: 'bench@example.invalid',
      GIT_COMMITTER_DATE: DATE,
    },
  }).trim();
}

function findFixtureDir(id) {
  const match = fs.readdirSync(FIXTURES)
    .find((d) => d === id || d.startsWith(`${String(id).toLowerCase()}-`));
  if (!match) throw new Error(`unknown fixture: ${id}`);
  return { name: match, dir: path.join(FIXTURES, match) };
}

function makeTrialWorkspace(id, into) {
  const { name, dir } = findFixtureDir(id);
  const workspace = into ? path.resolve(into) : fs.mkdtempSync(path.join(os.tmpdir(), `bench-${name}-`));
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0) {
    throw new Error(`target directory is not empty: ${workspace}`);
  }
  copyTree(dir, workspace, true);
  runGit(workspace, ['init', '-q']);
  runGit(workspace, ['add', '-A']);
  runGit(workspace, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Fixture ${name}`]);
  return { fixture: name, workspace, commit: runGit(workspace, ['rev-parse', 'HEAD']) };
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const into = argv.includes('--into') ? argv[argv.indexOf('--into') + 1] : undefined;
    if (!argv[0] || argv[0].startsWith('--')) throw new Error('usage: make-trial-workspace.js <fixtureId> [--into <dir>]');
    process.stdout.write(`${JSON.stringify(makeTrialWorkspace(argv[0], into))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { makeTrialWorkspace };
