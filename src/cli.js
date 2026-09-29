'use strict';

const { ClientFactory } = require('@a2a-js/sdk/client');
const { readAuthToken } = require('./local-auth');

async function main(argv = process.argv.slice(2), env = process.env) {
  const goal = argv.join(' ').trim();
  if (!goal) {
    process.stderr.write("Usage: node src/cli.js '<goal>'\n");
    return 2;
  }

  const port = Number(env.PORT || 3000);
  const baseUrl = env.A2A_ORCHESTRATOR_URL || `http://127.0.0.1:${port}`;
  try {
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedBaseUrl.protocol !== 'http:' || parsedBaseUrl.hostname !== '127.0.0.1') {
      throw new Error('A2A orchestrator URL must use local HTTP at 127.0.0.1.');
    }
    const authToken = readAuthToken(env.CODEX_A2A_TOKEN_FILE ? { filePath: env.CODEX_A2A_TOKEN_FILE } : undefined);
    const client = await new ClientFactory().createFromUrl(parsedBaseUrl.origin, '/orchestrator/agent-card.json');
    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: `cli-${Date.now()}`,
        contextId: '',
        taskId: '',
        role: 1,
        parts: [{ content: { $case: 'text', value: goal }, mediaType: 'text/plain', filename: '', metadata: undefined }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
      metadata: undefined,
    }, { serviceParameters: { Authorization: `Bearer ${authToken}` } });
    if (result?.status?.state !== 3) {
      process.stderr.write(`A2A task failed (state ${result?.status?.state ?? 'unknown'}).\n`);
      return 1;
    }
    const artifact = result.artifacts?.at(-1);
    const text = artifact?.parts?.map((part) => part?.content?.$case === 'text' ? part.content.value : '').filter(Boolean).join('\n') || '';
    if (text) process.stdout.write(`${text}\n`);
    process.stdout.write('Task completed.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main };
