'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const Database = require('better-sqlite3');

async function main() {
  const id = '5f4d2e30-5b7c-4bb7-a02f-d27b46dd2b09';
  const database = new Database('.runtime/projects/3d9c2e759c/state.sqlite', { readonly: true });
  let pause;
  try {
    const row = database.prepare('SELECT metadata FROM tasks WHERE id=? AND owner=?').get(id, 'orchestrator');
    pause = JSON.parse(row.metadata).pause;
    if (pause?.kind !== 'human_decision' || pause.decisionId !== id + ':h1' || !pause.options.some((option) => option.id === 'restore_supported_route')) throw new Error('Expected original investigated local verification decision');
    const mapping = database.prepare('SELECT engine FROM delivery_run_engines WHERE run_id=?').get(id);
    if (mapping?.engine !== 'legacy') throw new Error('Expected immutable legacy run mapping');
  } finally { database.close(); }
  const token = fs.readFileSync('.runtime/a2a-token', 'utf8').trim();
  const client = await new ClientFactory().createFromUrl('http://127.0.0.1:3002', '/orchestrator/agent-card.json');
  const options = { serviceParameters: { Authorization: `Bearer ${token}` } };
  const existing = await client.getTask({ tenant: '', id }, options);
  const text = 'The owner explicitly authorizes full local harness execution without local permission questions. The project now selects full-access with never approvals, and the actual App Server probe confirmed writable /tmp and uv cache. Restore the existing supported verification path for checkpoint e4c3c and continue the original task. Re-run the original pinned commands and required installed-wheel/runtime evidence; preserve acceptance requirements and candidate integrity. Routine local cache/scratch repair, local dependency preparation and command execution are already authorized and should be handled internally. The local-verification/v1 identifier is a non-callable preflight fingerprint, not a missing tool to request from the owner. Diagnose failures in the actual verifier environment instead of inferring its writable permissions from an inspection-role mount report. Do not replace runtime checks with static evidence or weaken requirements. This authorizes local recovery, not unrelated external publication or spending.';
  const result = await client.sendMessage({ tenant: '', message: { messageId: 'owner-local-autonomy-' + crypto.randomUUID(), contextId: existing.contextId, taskId: id, role: 1, parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }], metadata: { choice: 'restore_supported_route', decisionId: pause.decisionId }, extensions: [], referenceTaskIds: [] }, configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true }, metadata: undefined }, options);
  const report = { taskId: result.id, state: TaskState[result.status?.state] || result.status?.state, decisionId: pause.decisionId, choice: 'restore_supported_route', ownerFullLocalAuthorization: true };
  fs.writeFileSync('.agents/teamwork/local-autonomy-20261028/runtime-resume.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
}

main().catch((error) => { process.stderr.write(JSON.stringify({ name: error.name, code: error.code || null, message: error.message }) + '\n'); process.exitCode = 1; });
