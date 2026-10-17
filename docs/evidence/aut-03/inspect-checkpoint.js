'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { BaseCheckpointSaver } = require('@langchain/langgraph-checkpoint');

async function main() {
  const [, , dbPath, taskId, expectedSetting, workspace] = process.argv;
  if (!dbPath || !taskId || !['true', 'false'].includes(expectedSetting) || !workspace) {
    throw new Error('Usage: node inspect-checkpoint.js <db> <task-id> <true|false> <workspace>');
  }
  const root = path.resolve(__dirname, '../../..');
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/aut-03/trial-runtime-pins.json'), 'utf8'));
  const resolvedWorkspace = path.resolve(workspace);
  assert.equal(resolvedWorkspace, fs.realpathSync(workspace), 'Trial workspace root must not be a symlink.');
  assert.ok(resolvedWorkspace.startsWith(`${path.resolve(pins.trialEnforcement.workspaceRoot)}${path.sep}`), 'Trial workspace is outside the dedicated cohort root.');
  assert.ok(path.relative(root, resolvedWorkspace).startsWith('..'), 'Trial workspace must be outside the repository.');
  const helper = pins.trialHelpers.find((item) => item.path.endsWith('/inspect-checkpoint.js'));
  assert.ok(helper, 'Checkpoint reader pin is missing.');
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  assert.equal(actualHash, helper.sha256, 'Checkpoint reader hash changed.');
  const workspaceStat = fs.statSync(workspace);
  assert.equal(workspaceStat.mode & 0o222, 0, 'Trial workspace permissions are writable.');
  assert.throws(() => fs.accessSync(workspace, fs.constants.W_OK), { code: 'EACCES' }, 'Trial workspace is writable by the server user.');
  const workspaceEntries = fs.readdirSync(workspace);
  assert.deepEqual(workspaceEntries, [], 'Trial workspace changed during the task.');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      "SELECT checkpoint_id, type, checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1",
    ).get(taskId);
    assert.ok(row, 'No lead checkpoint found for the A2A task ID.');
    const checkpoint = await new BaseCheckpointSaver().serde.loadsTyped(row.type, row.checkpoint);
    const context = checkpoint.channel_values?.leadSkillContext;
    assert.ok(context && typeof context.enabled === 'boolean', 'Lead skill context is missing from the checkpoint.');
    assert.equal(context.enabled, expectedSetting === 'true', 'Effective skill setting did not match the arm.');
    if (expectedSetting === 'true') {
      assert.deepEqual(context.pin, {
        id: 'aut-03-lead-decomposition-v1',
        sha256: 'e0f10756e0486cdb827519edd8adfef866d84be449d6a10b1320412648e650ba',
      });
    } else {
      assert.equal(context.pin, null);
    }
    process.stdout.write(`${JSON.stringify({ taskId, checkpointId: row.checkpoint_id, leadSkillContext: context, workspaceEmptyAndReadOnly: true })}\n`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
