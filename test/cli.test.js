'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskState } = require('@a2a-js/sdk');
const { main, parseArgs } = require('../src/cli');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'A'.repeat(43), { mode: 0o600 });
  return { dir, env: { PORT: '3999', CODEX_A2A_TOKEN_FILE: tokenFile } };
}

function capture() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  return { out, err, restore() { process.stdout.write = origOut; process.stderr.write = origErr; } };
}

function textMessage(text) {
  return { messageId: 'm', contextId: '', taskId: '', role: 2, parts: [{ content: { $case: 'text', value: text } }] };
}

async function run(argv, client, env) {
  const cap = capture();
  let code;
  try {
    code = await main(argv, env, { clientFactory: async () => client });
  } finally {
    cap.restore();
  }
  return { code, out: cap.out.join(''), err: cap.err.join('') };
}

test('parseArgs reads leading flags then free text', () => {
  assert.deepEqual(parseArgs(['--task', 't1', '--choice', 'a', '--decision', 'd1', 'go', 'ahead']), {
    task: 't1', choice: 'a', decision: 'd1', text: 'go ahead',
  });
  assert.deepEqual(parseArgs(['--task=t1', 'ok']), { task: 't1', text: 'ok' });
  assert.deepEqual(parseArgs(['build it']), { text: 'build it' });
  assert.deepEqual(parseArgs(['--check', 'npm test', '--check=node -v', 'goal']), { checks: ['npm test', 'node -v'], text: 'goal' });
  assert.throws(() => parseArgs(['--bogus', 'x', 'y']), /Unknown option/);
  assert.throws(() => parseArgs(['--task']), /requires a value/);
});

test('new goal sends a message without task id and prints the result', async () => {
  const { dir, env } = setup();
  const sent = [];
  const client = {
    async getTask() { throw new Error('unexpected getTask'); },
    async sendMessage(request) {
      sent.push(request);
      return {
        id: 't1', status: { state: TaskState.TASK_STATE_COMPLETED },
        artifacts: [{ parts: [{ content: { $case: 'text', value: 'All done' } }] }],
      };
    },
  };
  const result = await run(['build', 'it'], client, env);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 0);
  assert.match(result.out, /All done/);
  assert.equal(sent[0].message.taskId, '');
  assert.equal(sent[0].message.metadata, undefined);
});

test('--task fetches the context and sends choice and decision metadata', async () => {
  const { dir, env } = setup();
  const sent = [];
  const client = {
    async getTask({ id }) { return { id, contextId: 'ctx-9' }; },
    async sendMessage(request) {
      sent.push(request);
      return { id: 't9', status: { state: TaskState.TASK_STATE_COMPLETED }, artifacts: [] };
    },
  };
  const result = await run(['--task', 't9', '--decision', 'run:h1', '--choice', 'opt-a', 'go with A'], client, env);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 0);
  assert.equal(sent[0].message.taskId, 't9');
  assert.equal(sent[0].message.contextId, 'ctx-9');
  assert.deepEqual(sent[0].message.metadata, { choice: 'opt-a', decisionId: 'run:h1' });
  assert.equal(sent[0].message.parts[0].content.value, 'go with A');
});

test('--task omits undefined metadata keys', async () => {
  const { dir, env } = setup();
  const sent = [];
  const client = {
    async getTask({ id }) { return { id, contextId: 'ctx' }; },
    async sendMessage(request) { sent.push(request); return { id: 't', status: { state: TaskState.TASK_STATE_COMPLETED } }; },
  };
  await run(['--task', 't', '--choice', 'x', 'yes'], client, env);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(sent[0].message.metadata, { choice: 'x' });
});

test('input required prints the pause and exits 3', async () => {
  const { dir, env } = setup();
  const client = {
    async sendMessage() {
      return {
        id: 't5',
        status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: textMessage('Decision required: pick one\nAnswer with: npm run ask -- --task t5') },
        metadata: { pause: { kind: 'human_decision', decisionId: 't5:h1' } },
      };
    },
  };
  const result = await run(['goal'], client, env);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 3);
  assert.match(result.err, /Decision required: pick one/);
  assert.match(result.err, /npm run ask -- --task t5/);
});

test('input required without a status message prints a resume command', async () => {
  const { dir, env } = setup();
  const client = {
    async sendMessage() {
      return { id: 't6', status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, metadata: { pause: { kind: 'human_decision', decisionId: 'd' } } };
    },
  };
  const result = await run(['goal'], client, env);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 3);
  assert.match(result.err, /Resume with: npm run ask -- --task t6 --decision d/);
});

test('failed task exits 1 and missing text exits 2', async () => {
  const { dir, env } = setup();
  const client = { async sendMessage() { return { id: 't', status: { state: TaskState.TASK_STATE_FAILED } }; } };
  assert.equal((await run(['goal'], client, env)).code, 1);
  assert.equal((await run([], client, env)).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--check builds acceptance metadata for a new run', async () => {
  const { dir, env } = setup();
  const sent = [];
  const client = {
    async sendMessage(request) { sent.push(request); return { id: 't', status: { state: TaskState.TASK_STATE_COMPLETED } }; },
  };
  const result = await run(['--check', 'npm  test', '--check', 'node -v', 'ship it'], client, env);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 0);
  assert.deepEqual(sent[0].message.metadata, {
    acceptance: { requiredChecks: [{ id: 'check-1', argv: ['npm', 'test'] }, { id: 'check-2', argv: ['node', '-v'] }] },
  });
  assert.equal(sent[0].message.parts[0].content.value, 'ship it');
});

test('--check combined with --task is an error and sends nothing', async () => {
  const { dir, env } = setup();
  let sends = 0;
  const client = { async getTask() { return { id: 't', contextId: 'c' }; }, async sendMessage() { sends += 1; return {}; } };
  const result = await run(['--task', 't', '--check', 'npm test', 'answer'], client, env);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.code, 2);
  assert.match(result.err, /--check .* new run only/);
  assert.equal(sends, 0);
});

test('the acceptance disposition is printed and rejected or unverifiable exit 4', async () => {
  const { dir, env } = setup();
  const task = (disposition, text = 'Text') => ({
    id: 't', status: { state: TaskState.TASK_STATE_COMPLETED },
    artifacts: [{ parts: [{ content: { $case: 'text', value: text } }], metadata: { acceptance: { disposition } } }],
  });
  const codes = {};
  for (const disposition of ['accepted', 'rejected', 'unverifiable', 'unverified', 'not_required']) {
    const client = { async sendMessage() { return task(disposition); } };
    const result = await run(['goal'], client, env);
    codes[disposition] = result.code;
    assert.match(result.out, new RegExp(`Acceptance: ${disposition}`));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(codes, { accepted: 0, rejected: 4, unverifiable: 4, unverified: 0, not_required: 0 });
});
