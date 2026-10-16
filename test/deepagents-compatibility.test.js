const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexAppServer } = require('../src/codex-app-server');

class FakeProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.sent = [];
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line);
          this.sent.push(message);
          const send = (response) => this.stdout.write(`${JSON.stringify(response)}\n`);
          handler(message, send);
        }
        callback();
      },
    });
  }

  kill(signal) {
    this.exitCode = 0;
    setImmediate(() => this.emit('exit', 0, signal));
    return true;
  }
}

test('checked-in App Server client supports the existing turn route and preserves its boundaries', async (t) => {
  let child;
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'codex');
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'inherit']);
    child = new FakeProcess((message, send) => {
      if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'offline-fixture' } });
      if (message.method === 'initialized') return;
      if (message.method === 'config/read') {
        return send({ id: message.id, result: { config: { mcp_servers: {} } } });
      }
      if (message.method === 'thread/start') {
        return send({ id: message.id, result: { thread: { id: 'fixture-thread' }, model: 'fixture-model', reasoningEffort: 'high' } });
      }
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } } });
        setImmediate(() => {
          child.stdout.write(`${JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', itemId: 'cmd-1' } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { type: 'agentMessage', text: 'fixture reply' } } })}\n`);
          child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } })}\n`);
        });
        return;
      }
      if (message.id === 'approval-1') return;
      return send({ id: message.id, result: {} });
    });
    return child;
  };
  const client = new CodexAppServer({ spawnImpl });
  t.after(() => client.close());

  const result = await client.run({
    role: { name: 'explorer', model: 'fixture-model', effort: 'high', sandbox: 'read-only', instructions: 'Inspect the fixture.' },
    cwd: '/tmp/offline-project',
    input: 'inspect this',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'fixture reply');
  assert.equal(result.threadId, 'fixture-thread');
  assert.equal(result.turnId, 'fixture-turn');
  assert.equal(result.usage.model, 'fixture-model');
  assert.equal(result.usage.effort, 'high');
  assert.equal(result.usage.modelRequests, null);

  const sent = child.sent;
  const threadStart = sent.find(({ method }) => method === 'thread/start');
  const turnStart = sent.find(({ method }) => method === 'turn/start');
  assert.equal(threadStart.params.model, 'fixture-model');
  assert.equal(threadStart.params.sandbox, 'read-only');
  assert.equal(turnStart.params.threadId, 'fixture-thread');
  assert.deepEqual(turnStart.params.input, [{ type: 'text', text: 'inspect this' }]);
  assert.deepEqual(sent.find(({ id }) => id === 'approval-1'), {
    id: 'approval-1', result: { decision: 'decline' },
  });
  assert.equal(child.sent.some(({ method }) => method === 'turn/interrupt'), false);
});
