'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CodexAppServer } = require('../../../../src/codex-app-server');
const { runSandboxedCheck } = require('../../../../src/acceptance');

const base = __dirname;
const workspace = path.join(base, 'workspace');
const scratch = path.join(base, 'scratch');
const outside = path.join(base, 'outside');
for (const dir of [workspace, scratch, outside]) fs.mkdirSync(dir, { recursive: true });
const code = `
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
async function writable(dir) {
  const file = path.join(dir, 'probe-' + process.pid);
  try { fs.writeFileSync(file, 'x'); fs.rmSync(file); return 'allowed'; }
  catch (error) { return error.code || String(error); }
}
(async () => {
  const dirs = JSON.parse(process.argv[1]);
  const out = {};
  for (const [name, dir] of Object.entries(dirs)) out[name] = await writable(dir);
  out.loopback = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code || String(error)));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve('allowed')));
  });
  process.stdout.write(JSON.stringify(out));
})().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });
`;
const client = new CodexAppServer({ codexHome: '/home/sr/.codex' });
const run = async (kind, scratchOpt = null) => {
  const result = await runSandboxedCheck({
    id: kind, argv: ['node', '-e', code, JSON.stringify({ workspace, scratch, outside })], timeoutMs: 15000,
  }, { appServer: client, cwd: workspace, scratch: scratchOpt });
  assert.equal(result.result, 'passed', JSON.stringify(result));
  return JSON.parse(result.stdoutTail);
};
(async () => {
  try {
    const strict = await run('strict');
    const scratchOnly = await run('scratch', {
      policy: { type: 'workspaceWrite', writableRoots: [scratch], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      env: { TEST_SCRATCH_ROOT: scratch, TMPDIR: scratch },
    });
    const strictAgain = await run('strict-again');
    for (const item of [strict, scratchOnly, strictAgain]) {
      assert.equal(item.workspace, 'EROFS', JSON.stringify(item));
      assert.equal(item.outside, 'EROFS', JSON.stringify(item));
      assert.equal(item.loopback, 'allowed', JSON.stringify(item));
    }
    assert.equal(strict.scratch, 'EROFS', JSON.stringify(strict));
    assert.equal(strictAgain.scratch, 'EROFS', JSON.stringify(strictAgain));
    assert.equal(scratchOnly.scratch, 'allowed', JSON.stringify(scratchOnly));
    process.stdout.write(JSON.stringify({ strict, scratchOnly, strictAgain }) + '\n');
  } finally {
    client.close();
  }
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
