'use strict';

// M4 exit gate: every public role has a reproducible capability case (scripts/role-capability-check.js).
// Fake protocol only: proves routing, scope/sandbox accounting, report validation and plan binding.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CASES, runCase, runAll } = require('../scripts/role-capability-check');

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

const caseById = (id) => CASES.find((entry) => entry.id === id);
const joined = (result) => result.problems.join('\n');

test('role capability cases', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('there is one case per public role plus the repair chain', () => {
    assert.deepEqual(CASES.map((entry) => entry.role).sort(), [
      'architect', 'developer', 'developer (repair chain)', 'devops', 'performance', 'project-manager', 'qa', 'reviewer', 'security', 'tech-writer',
    ]);
  });

  await suite.test('all ten cases pass on the fake protocol', async () => {
    const results = await runAll({ mode: 'fake' });
    assert.equal(results.length, 10);
    for (const result of results) assert.equal(result.ok, true, `${result.id}: ${joined(result)}`);
  });

  // Negative controls: each mutates one fake behavior and must be flagged.

  await suite.test('control: a read-only role that writes a file is flagged', async () => {
    const result = await runCase(caseById('security'), {
      behavior: (ctx, original) => {
        const out = original(ctx);
        if (ctx.role !== 'dlv-security') return out;
        return { ...out, writes: { 'src/admin.js': "'use strict';\n// patched by a read-only role\n" } };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /read-only role dlv-security changed files: src\/admin\.js/);
  });

  await suite.test('control: a developer editing outside allowedFiles is flagged', async () => {
    const result = await runCase(caseById('developer'), {
      behavior: (ctx, original) => {
        const out = original(ctx);
        if (ctx.role !== 'dlv-developer') return out;
        return {
          report: { ...out.report, filesChanged: ['src/greet.js', 'src/other.js'] },
          writes: { 'src/other.js': "module.exports = () => 'changed outside scope';\n" },
        };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /dlv-developer changed files outside allowedFiles \[src\/greet\.js\]: src\/other\.js/);
  });

  await suite.test('control: a QA report missing the seeded failure is flagged', async () => {
    const result = await runCase(caseById('qa'), {
      behavior: (ctx, original) => {
        if (ctx.role !== 'dlv-qa' || ctx.stageId !== 'reproduce') return original(ctx);
        return {
          report: {
            ...original(ctx).report,
            summary: 'looked fine',
            checks: [{ command: 'node --test test/tiny.test.js', result: 'passed', detail: 'not actually run' }],
            risks: [],
          },
        };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /QA did not report the seeded failure/);
  });

  await suite.test('control: a reviewer citing the wrong location is flagged', async () => {
    const result = await runCase(caseById('reviewer'), {
      behavior: (ctx, original) => {
        const out = original(ctx);
        if (ctx.role !== 'dlv-reviewer' || ctx.stageId !== 'investigate') return out;
        return { report: { ...out.report, risks: ['[high] src/price.js:99 - looks wrong somewhere'] } };
      },
    });
    assert.equal(result.ok, false);
    assert.match(joined(result), /did not cite the seeded location src\/price\.js:5/);
  });

  await suite.test('live mode refuses to run without the quota acknowledgement', () => {
    const script = path.join(__dirname, '..', 'scripts', 'role-capability-check.js');
    const refused = spawnSync(process.execPath, [script, '--live'], { encoding: 'utf8' });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--i-understand-this-uses-my-quota/);
    assert.match(refused.stderr, /ChatGPT plan usage/);
  });
});
