'use strict';
const fs = require('node:fs');
const { chromium } = require('/tmp/harness-live-browser/node_modules/playwright-core');
const out = '.agents/teamwork/live-lead-recovery/evidence/browser-task.json';
const goal = 'Read the first heading of README.md. Delegate one bounded engineer task to create docs/RUNTIME_DIAGNOSTIC.md with a title line "# Runtime diagnostic", one blank line, and a line "Project: Agent Harness", ending with a newline. Only that file may change. Let the mandatory verifier independently check the result and finish after acceptance. Do not continue other development or run broad test suites.';
const check = 'node /home/sr/Projects/Workspace/codex-agent-control-plane/.agents/teamwork/live-lead-recovery/evidence/check-diagnostic.cjs';
(async()=>{
  const proof = { goal, check, pageErrors: [], updates: [], startedAt: new Date().toISOString() };
  if (fs.existsSync('/home/sr/Projects/Workspace/agent-harness/docs/RUNTIME_DIAGNOSTIC.md')) throw new Error('Diagnostic output already exists; refusing to overwrite');
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => proof.pageErrors.push(e.message));
    await page.goto('http://127.0.0.1:8081/?project=3d9c2e759c');
    await page.waitForTimeout(2500);
    if (await page.locator('#startBtn').isVisible() && await page.locator('#startBtn').isEnabled()) {
      await page.locator('#startBtn').click();
    }
    await page.waitForFunction(() => !document.querySelector('#stopBtn').disabled, null, { timeout: 45000 });
    if (await page.locator('#newSessionBtn').isEnabled()) await page.locator('#newSessionBtn').click();
    await page.locator('#taskGoal').fill(goal);
    await page.locator('#taskChecksBox > summary').click();
    await page.locator('#taskChecks').fill(check);
    await page.waitForFunction(() => !document.querySelector('#sendBtn').disabled);
    await page.locator('#sendBtn').click();
    proof.url = page.url();
    proof.contextId = new URL(proof.url).searchParams.get('session');
    console.log(JSON.stringify({ event: 'submitted', contextId: proof.contextId }));
    const deadline = Date.now() + 12 * 60 * 1000;
    let previous = '';
    while (Date.now() < deadline) {
      const status = await page.locator('#taskStatusLabel').innerText();
      const response = await page.request.get(`http://127.0.0.1:8081/api/projects/3d9c2e759c/sessions/${proof.contextId}`);
      const session = response.ok() ? await response.json() : null;
      const lead = session?.turns?.at(-1)?.leadTask;
      const update = { at: new Date().toISOString(), status, taskId: lead?.id || null, state: lead?.state || null };
      const key = JSON.stringify([update.status, update.state]);
      if (key !== previous) { proof.updates.push(update); console.log(JSON.stringify(update)); previous = key; fs.writeFileSync(out, JSON.stringify(proof, null, 2)); }
      if (lead && ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_CANCELED'].includes(lead.state)) {
        proof.final = { taskId: lead.id, state: lead.state, status: lead.status, artifacts: lead.artifacts, metadata: lead.metadata };
        await page.screenshot({ path: '.agents/teamwork/live-lead-recovery/evidence/browser-task.png', fullPage: true });
        break;
      }
      await page.waitForTimeout(5000);
    }
    if (!proof.final) throw new Error('Browser task did not reach a visible terminal/pause state within twelve minutes');
    if (proof.final.state !== 'TASK_STATE_COMPLETED') process.exitCode = 1;
  } catch (error) { proof.error = error.message; console.error(error.message); process.exitCode = 1; }
  finally { proof.finishedAt = new Date().toISOString(); fs.writeFileSync(out, JSON.stringify(proof, null, 2)); await browser.close(); }
})().catch(e=>{console.error(e.message);process.exitCode=1});
