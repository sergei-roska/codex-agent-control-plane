'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('/tmp/harness-resume-browser/node_modules/playwright-core');
const evidenceFile = '.agents/teamwork/concurrent-resume-20261030/evidence/live-ui-resume.json';
const projectId = '3d9c2e759c';
const sessionId = 'ddd817c7-68b3-4057-91c4-9fb901f5111c';
const taskId = '275f8476-4379-49b4-bb06-2b8bcbff6179';
const reply = 'Continue the existing bounded runtime diagnostic with its unchanged pinned acceptance contract. Run the pending mandatory verifier against the already published candidate, then finish after host acceptance. Preserve the completed engineer work; do not start unrelated development or change other files.';
(async () => {
  const proof = { startedAt: new Date().toISOString(), projectId, sessionId, taskId, submissions: 0, errors: [], updates: [] };
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => proof.errors.push(error.message));
    page.on('request', (request) => { if (request.url().endsWith('/task/send') && request.method() === 'POST') proof.submissions += 1; });
    await page.goto(`http://127.0.0.1:8081/?project=${projectId}&session=${sessionId}`);
    await page.waitForFunction(() => !document.getElementById('decisionCard').classList.contains('hidden'));
    assert.equal(await page.locator('#decisionOptionsList input').count(), 0, 'Refusing to choose an owner option');
    const beforeResponse = await page.request.get(`http://127.0.0.1:8081/api/projects/${projectId}/sessions/${sessionId}`);
    const before = await beforeResponse.json();
    assert.equal(before.turns.at(-1).leadTask.id, taskId);
    assert.equal(before.turns.at(-1).leadTask.metadata.pause.kind, 'error');
    await page.locator('#decisionAnswer').fill(reply);
    await page.locator('#decisionSubmit').click();
    const deadline = Date.now() + 8 * 60 * 1000;
    let previous = '';
    while (Date.now() < deadline) {
      const response = await page.request.get(`http://127.0.0.1:8081/api/projects/${projectId}/sessions/${sessionId}`);
      assert.equal(response.ok(), true);
      const data = await response.json();
      const lead = data.turns.at(-1)?.leadTask;
      assert.equal(lead.id, taskId, 'Resume created a different task');
      const update = { at: new Date().toISOString(), state: lead.state, pauseKind: lead.metadata?.pause?.kind || null, pauseMessage: lead.metadata?.pause?.message || null };
      const key = JSON.stringify([update.state, update.pauseKind, update.pauseMessage]);
      if (key !== previous) {
        previous = key; proof.updates.push(update);
        console.log(JSON.stringify(update)); fs.writeFileSync(evidenceFile, JSON.stringify(proof, null, 2) + '\n');
      }
      if (lead.state === 'TASK_STATE_COMPLETED') { proof.completed = true; break; }
      if (proof.updates.some((item) => item.state === 'TASK_STATE_WORKING') && ['TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED'].includes(lead.state)) {
        proof.completed = false; break;
      }
      if (await page.locator('#sendError').isVisible()) {
        proof.sendError = await page.locator('#sendError').innerText(); proof.completed = false; break;
      }
      await page.waitForTimeout(2500);
    }
    assert.equal(proof.completed, true, 'Live UI resume did not reach completed');
    assert.equal(proof.submissions, 1);
    assert.deepEqual(proof.errors, []);
  } catch (error) {
    proof.error = error.message; process.exitCode = 1;
  } finally {
    proof.finishedAt = new Date().toISOString();
    fs.writeFileSync(evidenceFile, JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify({ completed: proof.completed || false, submissions: proof.submissions, errors: proof.errors, error: proof.error || null }));
    await browser.close();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
