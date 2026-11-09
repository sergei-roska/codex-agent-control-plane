'use strict';
const { chromium } = require('/tmp/harness-resume-browser/node_modules/playwright-core');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:8081/?project=3d9c2e759c&session=ddd817c7-68b3-4057-91c4-9fb901f5111c');
    await page.waitForFunction(() => !document.getElementById('decisionCard').classList.contains('hidden'));
    console.log(JSON.stringify({ title: await page.title(), status: await page.locator('#taskStatusLabel').innerText(), taskId: await page.locator('#activeTaskIdDisplay').innerText(), decisionDisabled: await page.locator('#decisionSubmit').isDisabled(), question: await page.locator('#decisionQuestion').innerText(), errors }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
