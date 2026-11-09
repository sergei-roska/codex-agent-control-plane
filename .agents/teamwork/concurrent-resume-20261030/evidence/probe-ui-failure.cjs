'use strict';
const fs = require('node:fs');
const { chromium } = require('/tmp/harness-resume-browser/node_modules/playwright-core');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    let submissions = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/task/send', (route) => { submissions += 1; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Probe: continuation temporarily unavailable' }) }); });
    await page.goto('http://127.0.0.1:8081/?project=3d9c2e759c&session=ddd817c7-68b3-4057-91c4-9fb901f5111c');
    await page.waitForFunction(() => !document.getElementById('decisionCard').classList.contains('hidden'));
    const draft = 'Preserve this diagnostic reply for retry.';
    await page.locator('#decisionAnswer').fill(draft);
    await page.locator('#decisionSubmit').click();
    await page.waitForFunction(() => !document.getElementById('sendError').classList.contains('hidden'));
    await page.waitForTimeout(300);
    const result = { capturedAt: new Date().toISOString(), interceptedRequestsOnly: true, actualTaskSubmissions: 0, submissions, draftPreserved: await page.locator('#decisionAnswer').inputValue() === draft, errorVisible: await page.locator('#sendError').innerText(), errors };
    fs.writeFileSync(process.argv[2] || '.agents/teamwork/concurrent-resume-20261030/evidence/ui-failure-before.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
