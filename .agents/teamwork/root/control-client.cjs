'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { readAuthToken } = require(path.resolve('src/local-auth'));

async function main() {
  const [action, taskId, file, pollArgument] = process.argv.slice(2);
  const baseUrl = 'http://127.0.0.1:3001';
  const token = readAuthToken();
  const readSituation = async () => {
    const response = await fetch('http://127.0.0.1:8080/api/projects/c8740b5b4f/sessions/8d7f6bd4-2d43-48cd-933a-53736fba2e88/situation', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Situation HTTP ${response.status}`);
    return response.json();
  };
  if (action === 'runtime') {
    const response = await fetch(`${baseUrl}/control/runtime`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Runtime HTTP ${response.status}`);
    process.stdout.write(`${JSON.stringify(await response.json())}\n`);
    return;
  }
  const initialDelayMs = action === 'watch' ? Number(pollArgument) || 0 : 0;
  if (initialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
  const client = await new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json');
  const options = { serviceParameters: { Authorization: `Bearer ${token}` } };
  if (action === 'watch') {
    const pollIntervalMs = Number(file) || 394000;
    let task = await client.getTask({ tenant: '', id: taskId }, options);
    let situation = await readSituation();
    const seenFailures = new Set((situation.batch || [])
      .filter((assignment) => assignment.state === 'failed'
        || /VERDICT:\s*(fail|inconclusive)/i.test(assignment.summary || ''))
      .map((assignment) => assignment.assignmentId));
    while (situation.state === 'TASK_STATE_WORKING' && !situation.openDecisions?.length) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      task = await client.getTask({ tenant: '', id: taskId }, options);
      situation = await readSituation();
      const newFailures = (situation.batch || []).filter((assignment) =>
        (assignment.state === 'failed'
          || /VERDICT:\s*(fail|inconclusive)/i.test(assignment.summary || ''))
        && !seenFailures.has(assignment.assignmentId));
      if (newFailures.length) {
        for (const assignment of newFailures) seenFailures.add(assignment.assignmentId);
        break;
      }
    }
    process.stdout.write(`${JSON.stringify({ id: task.id, state: task.status.state, pause: task.metadata?.pause,
      artifacts: task.artifacts, situation })}\n`);
    return;
  }
  const task = await client.getTask({ tenant: '', id: taskId }, options);
  if (action === 'status') {
    const situation = await readSituation();
    process.stdout.write(`${JSON.stringify({ id: task.id, state: task.status.state,
      pause: task.metadata?.pause, artifacts: task.artifacts, timestamp: task.status.timestamp, situation })}\n`);
    return;
  }
  if (action !== 'answer') throw new Error('Expected runtime, status or answer');
  const answer = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (task.metadata?.pause?.decisionId !== answer.decisionId) throw new Error('Pending decision changed');
  const result = await client.sendMessage({ tenant: '', message: {
    messageId: `controller-${Date.now()}`, contextId: task.contextId, taskId,
    role: 1, parts: [{ content: { $case: 'text', value: answer.text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: { decisionId: answer.decisionId, choice: answer.choice },
    extensions: [], referenceTaskIds: [],
  }, configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true }, metadata: undefined }, options);
  process.stdout.write(`${JSON.stringify({ id: result.id, state: result.status?.state })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
