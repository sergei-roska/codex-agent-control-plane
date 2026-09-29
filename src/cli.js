'use strict';

const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { readAuthToken } = require('./local-auth');

const USAGE = "Usage: node src/cli.js '<goal>'\n       node src/cli.js --task <id> [--decision <id>] [--choice <optionId>] '<answer>'\n";
const EXIT_INPUT_REQUIRED = 3;
const VALUE_FLAGS = new Map([['--task', 'task'], ['--choice', 'choice'], ['--decision', 'decision']]);

// Leading --task/--choice/--decision flags (also --flag=value), then the free text.
function parseArgs(argv) {
  const options = {};
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    const key = VALUE_FLAGS.get(flag);
    if (!key) throw new Error(`Unknown option: ${flag}`);
    const value = inline !== undefined ? inline : argv[index + 1];
    if (!value) throw new Error(`Option ${flag} requires a value.`);
    options[key] = value;
    index += inline !== undefined ? 1 : 2;
  }
  return { ...options, text: argv.slice(index).join(' ').trim() };
}

function messageText(message) {
  return message?.parts?.map((part) => part?.content?.$case === 'text' ? part.content.value : '').filter(Boolean).join('\n') || '';
}

function printPause(result) {
  const text = messageText(result?.status?.message);
  if (text) process.stderr.write(`${text}\n`);
  // The server message already carries the answer command; fall back when it is absent.
  if (!text) {
    const pause = result?.metadata?.pause;
    const decision = pause?.kind === 'human_decision' && pause.decisionId ? `--decision ${pause.decisionId} ` : '';
    process.stderr.write(`Resume with: npm run ask -- --task ${result?.id} ${decision}"<answer>"\n`);
  }
}

async function main(argv = process.argv.slice(2), env = process.env, { clientFactory } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  const goal = parsed.text;
  if (!goal && !parsed.task) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (!goal && (parsed.choice || parsed.decision)) {
    process.stderr.write(USAGE);
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
    const client = clientFactory
      ? await clientFactory(parsedBaseUrl.origin)
      : await new ClientFactory().createFromUrl(parsedBaseUrl.origin, '/orchestrator/agent-card.json');
    const requestOptions = { serviceParameters: { Authorization: `Bearer ${authToken}` } };
    let contextId = '';
    if (parsed.task) {
      const existing = await client.getTask({ tenant: '', id: parsed.task }, requestOptions);
      contextId = existing?.contextId || '';
    }
    const messageMetadata = {};
    if (parsed.choice !== undefined) messageMetadata.choice = parsed.choice;
    if (parsed.decision !== undefined) messageMetadata.decisionId = parsed.decision;
    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: `cli-${Date.now()}`,
        contextId,
        taskId: parsed.task || '',
        role: 1,
        parts: [{ content: { $case: 'text', value: goal }, mediaType: 'text/plain', filename: '', metadata: undefined }],
        metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
      metadata: undefined,
    }, requestOptions);
    if (result?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      printPause(result);
      return EXIT_INPUT_REQUIRED;
    }
    if (result?.status?.state !== TaskState.TASK_STATE_COMPLETED) {
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

module.exports = { main, parseArgs };
