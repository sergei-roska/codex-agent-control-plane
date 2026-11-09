'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexAppServer } = require('../../../src/codex-app-server');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scoped-permissions-'));
  const scratch = path.join(root, 'scratch');
  const candidate = path.join(root, 'scratch.candidate');
  const outside = path.join(root, 'outside');
  for (const directory of [scratch, candidate, outside]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(candidate, 'source.txt'), 'candidate input\n');
  const server = new CodexAppServer({ codexHome: '/home/sr/codex-work' });
  const policy = { type: 'workspaceWrite', writableRoots: [scratch], networkAccess: true,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  const commandSource = `
    const fs = require('node:fs');
    const path = require('node:path');
    const [scratch, candidate, outside] = process.argv.slice(1);
    function write(directory, name) {
      try { fs.writeFileSync(path.join(directory, name), 'probe'); return {written: true}; }
      catch (error) { return {written: false, code: error.code}; }
    }
    process.stdout.write(JSON.stringify({
      candidateReadable: fs.readFileSync(path.join(candidate, 'source.txt'), 'utf8') === 'candidate input\\n',
      scratch: write(scratch, 'scratch-write.txt'),
      candidate: write(candidate, 'candidate-write.txt'),
      outside: write(outside, 'outside-write.txt'),
      tmpEnv: write(process.env.TMPDIR, 'tmp-write.txt')
    }) + '\\n');
  `;
  const report = { at: new Date().toISOString(), scope: 'standalone command/exec only; no model turn', policy };
  try {
    const result = await server.execCommand({ command: [process.execPath, '-e', commandSource, scratch, candidate, outside],
      cwd: scratch, sandboxPolicy: policy, env: { TMPDIR: outside }, timeoutMs: 10000 });
    report.version = server.getVersion?.() || null;
    report.exitCode = result.exitCode;
    report.stdout = result.stdout;
    report.stderr = result.stderr;
    assert.equal(result.exitCode, 0);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.candidateReadable, true);
    assert.equal(observed.scratch.written, true);
    assert.equal(observed.candidate.written, false);
    assert.equal(observed.outside.written, false);
    assert.equal(observed.tmpEnv.written, false);
    assert.equal(fs.existsSync(path.join(candidate, 'candidate-write.txt')), false);
    assert.equal(fs.existsSync(path.join(outside, 'outside-write.txt')), false);
    report.observed = observed;
    report.result = 'PASS';
  } catch (error) {
    report.result = 'UNVERIFIED_OR_FAILED';
    report.error = { name: error.name, code: error.code || null, message: error.message };
    process.exitCode = 1;
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(path.join(__dirname, 'scoped-permissions-evidence.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n');
  }
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
