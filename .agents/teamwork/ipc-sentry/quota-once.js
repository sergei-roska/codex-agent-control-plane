const { CodexAppServer } = require("../../../src/codex-app-server");
(async () => {
  const server = new CodexAppServer({ codexHome: "/home/sr/codex-work" });
  const result = await server.readRateLimits();
  const primary = result?.rateLimits?.primary;
  if (!primary) {
    process.stdout.write("null\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    usedPercent: primary.usedPercent,
    windowDurationMins: primary.windowDurationMins,
    resetsAt: primary.resetsAt,
  }) + "\n");
})().catch(() => process.stdout.write("null\n"));
