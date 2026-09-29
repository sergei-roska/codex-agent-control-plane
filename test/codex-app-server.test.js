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
    this.killed = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line);
          this.sent.push(message);
          handler(message, (response) => this.stdout.write(`${JSON.stringify(response)}\n`));
        }
        callback();
      },
    });
  }

  kill(signal) {
    this.killed = true;
    this.exitCode = 0;
    setImmediate(() => this.emit('exit', 0, signal));
    return true;
  }
}

function fakeSpawn(handler) {
  let child;
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'codex');
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'inherit']);
    child = new FakeProcess(handler);
    return child;
  };
  return { spawnImpl, getChild: () => child };
}

function baseHandler() {
  let threadNumber = 0;
  let turnNumber = 0;
  return (request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'fake' } });
    if (request.method === 'initialized') return;
    if (request.method === 'thread/start') {
      return send({ id: request.id, result: { thread: { id: `thread-${++threadNumber}` } } });
    }
    if (request.method === 'turn/start') {
      const turnId = `turn-${++turnNumber}`;
      const text = request.params.input[0].text;
      send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      setImmediate(() => {
        send({ method: 'turn/started', params: { threadId: request.params.threadId, turn: { id: turnId } } });
        if (text === 'fail') {
          send({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: turnId, status: 'failed', error: { message: 'planned failure' } } } });
        } else {
          send({ method: 'item/completed', params: { threadId: request.params.threadId, turnId, item: { type: 'agentMessage', text: `reply:${text}` } } });
          send({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: turnId, status: 'completed' } } });
        }
      });
    }
    if (request.method === 'turn/interrupt') return send({ id: request.id, result: {} });
    return send({ id: request.id, result: {} });
  };
}

const role = { name: 'reviewer', model: 'gpt-6-sol', effort: 'high', sandbox: 'workspace-write', instructions: 'Review carefully.' };

test('performs initialize handshake and completes a turn', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const result = await client.run({ role, cwd: '/tmp/project', input: 'hello', outputSchema });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'reply:hello');
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');
  const sent = fake.getChild().sent;
  assert.deepEqual(sent.slice(0, 2).map(({ method }) => method), ['initialize', 'initialized']);
  const threadStart = sent.find(({ method }) => method === 'thread/start');
  assert.equal(threadStart.params.developerInstructions, role.instructions);
  assert.equal(threadStart.params.approvalPolicy, 'on-request');
  const turnStart = sent.find(({ method }) => method === 'turn/start');
  assert.equal(turnStart.params.effort, role.effort);
  assert.deepEqual(turnStart.params.outputSchema, outputSchema);
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'workspaceWrite' });
});

test('routes concurrent turns to their owning run', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const [first, second] = await Promise.all([
    client.run({ role, cwd: '/tmp/one', input: 'one' }),
    client.run({ role, cwd: '/tmp/two', input: 'two' }),
  ]);
  assert.equal(first.text, 'reply:one');
  assert.equal(second.text, 'reply:two');
  assert.notEqual(first.threadId, second.threadId);
  assert.notEqual(first.turnId, second.turnId);
});

test('reuses a supplied thread without starting another thread', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const result = await client.run({ role, cwd: '/tmp/project', input: 'follow up', threadId: 'existing-thread' });
  assert.equal(result.threadId, 'existing-thread');
  assert.equal(fake.getChild().sent.some(({ method }) => method === 'thread/start'), false);
  assert.equal(fake.getChild().sent.find(({ method }) => method === 'turn/start').params.threadId, 'existing-thread');
});

test('returns schema-shaped fail-closed responses to server requests', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-approval' } } });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-approval', status: 'inProgress' } } });
      setImmediate(() => {
        const child = fake.getChild();
        child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-approval', turn: { id: 'turn-approval' } } })}\n`);
        const requests = [
          ['item/commandExecution/requestApproval', { itemId: 'cmd' }],
          ['item/fileChange/requestApproval', { itemId: 'file' }],
          ['item/permissions/requestApproval', { itemId: 'permissions' }],
          ['mcpServer/elicitation/request', { threadId: 'thread-approval' }],
          ['item/tool/requestUserInput', { questions: [{ id: 'one' }, { id: 'two' }] }],
        ];
        requests.forEach(([method, params], index) => {
          child.stdout.write(`${JSON.stringify({ id: `server-${index}`, method, params })}\n`);
        });
        setImmediate(() => {
          child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-approval', turn: { id: 'turn-approval', status: 'completed' } } })}\n`);
        });
      });
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await client.run({ role, cwd: '/tmp/project', input: 'request approvals' });
  const replies = fake.getChild().sent.filter((message) => Object.hasOwn(message, 'id') && !message.method && String(message.id).startsWith('server-'));
  assert.deepEqual(replies, [
    { id: 'server-0', result: { decision: 'decline' } },
    { id: 'server-1', result: { decision: 'decline' } },
    { id: 'server-2', result: { permissions: {}, scope: 'turn' } },
    { id: 'server-3', result: { action: 'decline', content: null } },
    { id: 'server-4', result: { answers: { one: { answers: [] }, two: { answers: [] } } } },
  ]);
});

test('rejects overlapping runs on the same thread', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'turn/start') send({ id: request.id, result: { turn: { id: 'turn-overlap', status: 'inProgress' } } });
    if (request.method === 'turn/interrupt') {
      send({ id: request.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'shared-thread', turn: { id: 'turn-overlap', status: 'interrupted' } } });
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const controller = new AbortController();
  const active = client.run({ role, cwd: '/tmp/project', input: 'long run', threadId: 'shared-thread', signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    client.run({ role, cwd: '/tmp/project', input: 'overlap', threadId: 'shared-thread' }),
    /already active for thread shared-thread/,
  );
  controller.abort();
  await assert.rejects(active, { name: 'AbortError' });
});

test('interrupts a turn when cancellation arrives before turn/start responds', async (t) => {
  let markTurnStartWritten;
  const turnStartWritten = new Promise((resolve) => { markTurnStartWritten = resolve; });
  let interruptCount = 0;
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'turn/start') {
      markTurnStartWritten();
      setTimeout(() => {
        send({ id: request.id, result: { turn: { id: 'late-turn-id', status: 'inProgress' } } });
        send({ method: 'turn/started', params: { threadId: 'delayed-thread', turn: { id: 'late-turn-id' } } });
      }, 30);
    }
    if (request.method === 'turn/interrupt') {
      interruptCount += 1;
      send({ id: request.id, result: {} });
      setImmediate(() => send({ method: 'turn/completed', params: {
        threadId: 'delayed-thread',
        turn: { id: 'late-turn-id', status: 'interrupted' },
      } }));
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, requestTimeoutMs: 500 });
  t.after(() => client.close());
  const controller = new AbortController();
  let settled = false;
  const active = client.run({ role, cwd: '/tmp/project', input: 'cancel me', threadId: 'delayed-thread', signal: controller.signal });
  active.finally(() => { settled = true; }).catch(() => {});
  await turnStartWritten;
  controller.abort();

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false, 'run must remain pending while turn/start may still create a turn');
  await assert.rejects(active, { name: 'AbortError' });
  assert.equal(interruptCount, 1, 'late turn ID must be interrupted exactly once');
});

test('surfaces failed turns with the server error', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: '/tmp/project', input: 'fail' }), /planned failure/);
});

test('fails pending requests after an unexpected subprocess exit', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'initialized') return;
    if (request.method === 'thread/start') fake.getChild().emit('exit', 9, null);
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: '/tmp/project', input: 'exit' }), /exited unexpectedly/);
});

test('times out a turn that never completes and requests interruption', async (t) => {
  const methods = [];
  const fake = fakeSpawn((request, send) => {
    methods.push(request.method);
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-timeout' } } });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-timeout', status: 'inProgress' } } });
      setImmediate(() => send({ method: 'turn/started', params: { threadId: 'thread-timeout', turn: { id: 'turn-timeout' } } }));
    }
    if (request.method === 'turn/interrupt') send({ id: request.id, result: {} });
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, requestTimeoutMs: 35 });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: '/tmp/project', input: 'hang' }), /Timed out waiting for Codex turn completion/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(methods.includes('turn/interrupt'));
});
