'use strict';

const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { readAuthToken } = require('./local-auth');
const { parseCheckCommand } = require('./acceptance');

const USAGE = "Usage: node src/cli.js [--check '<command>']... '<goal>'\n       node src/cli.js --task <id> [--decision <id>] [--choice <optionId>] '<answer>'\n";
const EXIT_INPUT_REQUIRED = 3;
const EXIT_NOT_ACCEPTED = 4;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_POLL_FAILURES = 5;
const ACTIVE_STATES = new Set([TaskState.TASK_STATE_UNSPECIFIED, TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING]);
const VALUE_FLAGS = new Map([['--task', 'task'], ['--choice', 'choice'], ['--decision', 'decision']]);

// Leading --task/--choice/--decision flags and repeatable --check (also --flag=value), then the free text.
function parseArgs(argv) {
  const options = {};
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const [flag, inline] = argv[index].split(/=(.*)/s, 2);
    const key = flag === '--check' ? 'checks' : VALUE_FLAGS.get(flag);
    if (!key) throw new Error(`Unknown option: ${flag}`);
    const value = inline !== undefined ? inline : argv[index + 1];
    if (!value) throw new Error(`Option ${flag} requires a value.`);
    if (key === 'checks') options.checks = [...(options.checks || []), value];
    else options[key] = value;
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

async function main(argv = process.argv.slice(2), env = process.env, { clientFactory, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (parsed.checks && parsed.task) {
    process.stderr.write(`--check applies to a new run only and cannot be combined with --task.\n${USAGE}`);
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
    if (parsed.checks) {
      messageMetadata.acceptance = { requiredChecks: parsed.checks.map((command, index) => parseCheckCommand(command, index)) };
    }
    let result = await client.sendMessage({
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
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
      metadata: undefined,
    }, requestOptions);
    // A Message result carries no status and falls through to the non-completed path below.
    const taskId = result?.status ? result.id : undefined;
    if (taskId) process.stderr.write(`Task: ${taskId}\n`);
    let failures = 0;
    while (taskId && ACTIVE_STATES.has(result.status.state)) {
      await sleep(pollIntervalMs);
      try {
        result = await client.getTask({ tenant: '', id: taskId }, requestOptions);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures < MAX_POLL_FAILURES) continue;
        process.stderr.write(`${error?.message || String(error)}\nTask: ${taskId}\nResume or inspect with: npm run ask -- --task ${taskId} "<message>"\n`);
        return 1;
      }
    }
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
    const disposition = artifact?.metadata?.acceptance?.disposition;
    if (typeof disposition === 'string' && !text.startsWith('Acceptance:')) process.stdout.write(`Acceptance: ${disposition}\n`);
    process.stdout.write('Task completed.\n');
    return disposition === 'rejected' || disposition === 'unverifiable' ? EXIT_NOT_ACCEPTED : 0;
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main, parseArgs };
