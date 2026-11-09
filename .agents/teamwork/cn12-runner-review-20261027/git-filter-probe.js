'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { CandidateStore } = require('../../../src/candidate-store');
const { runFrozenCandidateChecks } = require('../../../src/delivery-acceptance');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn12-filter-probe-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const marker = path.join(root, 'marker');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q'); git('config', 'user.name', 'probe'); git('config', 'user.email', 'probe@invalid');
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'payload.txt filter=owned\n');
    fs.writeFileSync(path.join(repo, '.codex-acceptance-gitconfig'), `[filter "owned"]\n\tclean = sh -c 'echo invoked > ${marker} && cat'\n`);
    fs.writeFileSync(path.join(repo, 'payload.txt'), 'candidate bytes\n');
    fs.writeFileSync(path.join(repo, 'verify.js'), "process.exit(0);\n");
    git('add', '.'); git('commit', '-q', '-m', 'base');
    const db = new Database(path.join(root, 'state.sqlite'));
    try {
      const store = new CandidateStore({ db, workspace: repo, storageDir: path.join(root, 'state', 'candidates') });
      const candidate = store.createCandidate({ candidateId: 'candidate', projectId: 'project', objectiveId: 'objective', integrationGeneration: 1, sourceAttemptId: 'attempt', environmentDigest: 'a'.repeat(64), checkIdentity: 'checks' });
      process.stdout.write(JSON.stringify({ entries: store.readManifest(candidate.manifestDigest).entries.map((x) => x.path) }) + '\n');
      const result = await runFrozenCandidateChecks({ candidateStore: store, candidate, contract: { requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 5000 }] }, runId: 'probe', attempt: 1, executionPermissions: 'strict', runAcceptanceImpl: async ({ workspace }) => { process.stdout.write(JSON.stringify({ config: execFileSync('git', ['-C', workspace, 'config', '--get', 'filter.owned.clean'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(workspace, '.codex-acceptance-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } }).trim(), attr: execFileSync('git', ['-C', workspace, 'check-attr', 'filter', '--', 'payload.txt'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(workspace, '.codex-acceptance-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } }).trim() }) + '\n'); return { disposition: 'accepted', checks: [{ id: 'verify', argv: ['node', 'verify.js'], result: 'passed' }], issues: [], reasons: [] }; }, admission: { async acquire() { return { executionId: 'probe' }; }, recordTurnStart() {}, release() { return { state: 'released' }; } } });
      process.stdout.write(JSON.stringify({ marker: fs.existsSync(marker), disposition: result.disposition }) + '\n');
    } finally { db.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
