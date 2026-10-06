const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexAppServer } = require('../src/codex-app-server');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-test-'));
const fixtureDirs = Object.fromEntries(['project', 'one', 'two', 'p', 'work'].map((name) => {
  const dir = path.join(fixtureRoot, name);
  fs.mkdirSync(dir);
  return [name, dir];
}));
fs.mkdirSync(path.join(fixtureDirs.work, '.runtime'));
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

class FakeProcess extends EventEmitter {
  constructor(handler, activeProfileSupport = true) {
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
          const send = (response) => {
            if (activeProfileSupport && response.id === message.id && response.result && ['thread/start', 'thread/resume'].includes(message.method)) {
              response.result.activePermissionProfile ||= { id: message.params.permissions };
            }
            this.stdout.write(`${JSON.stringify(response)}\n`);
          };
          // Tool-surface enumeration is answered here so unrelated handlers need not know it.
          if (message.method === 'config/read' && !handler.ownsConfigRead) {
            send({ id: message.id, result: { config: { mcp_servers: { alpha: {}, 'gamma': {}, beta: {} } } } });
            continue;
          }
          handler(message, send);
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

function fakeSpawn(handler, { pidBase = 0, activeProfileSupport = true } = {}) {
  const children = [];
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'codex');
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'inherit']);
    assert.equal(options.detached, true);
    const child = new FakeProcess(handler, activeProfileSupport);
    if (pidBase) child.pid = pidBase + children.length;
    children.push(child);
    return child;
  };
  return { spawnImpl, getChild: () => children.at(-1), getChildren: () => children };
}

function baseHandler() {
  let threadNumber = 0;
  let turnNumber = 0;
  return (request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'fake' } });
    if (request.method === 'initialized') return;
    if (request.method === 'thread/start') {
      return send({ id: request.id, result: { thread: { id: `thread-${++threadNumber}` }, activePermissionProfile: { id: request.params.permissions } } });
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
  const result = await client.run({ role, cwd: fixtureDirs.project, input: 'hello', outputSchema });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'reply:hello');
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');
  const sent = fake.getChild().sent;
  assert.deepEqual(sent.slice(0, 2).map(({ method }) => method), ['initialize', 'initialized']);
  assert.deepEqual(sent[0].params.capabilities, { experimentalApi: true });
  const threadStart = sent.find(({ method }) => method === 'thread/start');
  assert.equal(threadStart.params.developerInstructions, role.instructions);
  assert.equal(threadStart.params.approvalPolicy, 'on-request');
  assert.equal(threadStart.params.approvalsReviewer, 'user');
  assert.equal(threadStart.params.permissions, 'codex-a2a-workspace-write');
  assert.equal(Object.hasOwn(threadStart.params, 'sandbox'), false);
  const turnStart = sent.find(({ method }) => method === 'turn/start');
  assert.equal(turnStart.params.effort, role.effort);
  assert.deepEqual(turnStart.params.outputSchema, outputSchema);
  assert.equal(turnStart.params.permissions, threadStart.params.permissions);
  assert.equal(Object.hasOwn(turnStart.params, 'sandboxPolicy'), false);
  assert.equal(turnStart.params.approvalsReviewer, 'user');
});

test('routes concurrent turns to their owning run', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const [first, second] = await Promise.all([
    client.run({ role, cwd: fixtureDirs.one, input: 'one' }),
    client.run({ role, cwd: fixtureDirs.two, input: 'two' }),
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

  const result = await client.run({ role, cwd: fixtureDirs.project, input: 'follow up', threadId: 'existing-thread' });
  assert.equal(result.threadId, 'existing-thread');
  assert.equal(fake.getChild().sent.some(({ method }) => method === 'thread/start'), false);
  assert.equal(fake.getChild().sent.find(({ method }) => method === 'turn/start').params.threadId, 'existing-thread');
});

test('resumes an unknown thread once, then reuses it', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await client.run({ role, cwd: fixtureDirs.project, input: 'one', threadId: 'old-thread' });
  await client.run({ role, cwd: fixtureDirs.project, input: 'two', threadId: 'old-thread' });
  const sent = fake.getChild().sent;
  const resumes = sent.filter(({ method }) => method === 'thread/resume');
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].params, {
    config: resumes[0].params.config,
    threadId: 'old-thread',
    cwd: fixtureDirs.project,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    permissions: 'codex-a2a-workspace-write',
    model: 'gpt-6-sol',
    developerInstructions: role.instructions,
  });
  const methods = sent.map(({ method }) => method).filter((m) => m === 'thread/resume' || m === 'turn/start');
  assert.deepEqual(methods, ['thread/resume', 'turn/start', 'turn/start']);
});

test('does not resume a thread started in this process', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const first = await client.run({ role, cwd: fixtureDirs.project, input: 'one' });
  await client.run({ role, cwd: fixtureDirs.project, input: 'two', threadId: first.threadId });
  assert.equal(fake.getChild().sent.some(({ method }) => method === 'thread/resume'), false);
});

test('does not reuse a loaded thread with a different permission profile configuration', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const first = await client.run({ role: { ...role, sandbox: 'read-only' }, cwd: fixtureDirs.project, input: 'one' });
  await assert.rejects(
    client.run({ role, cwd: fixtureDirs.project, input: 'two', threadId: first.threadId }),
    /bound to a different role or permission configuration/,
  );
  assert.equal(fake.getChild().sent.filter(({ method }) => method === 'turn/start').length, 1);
});

test('does not reuse a loaded thread after the role tool policy changes', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const first = await client.run({
    role: toolRole({ mcpServers: ['alpha'], skills: false }),
    cwd: fixtureDirs.project,
    input: 'one',
  });
  await assert.rejects(
    client.run({
      role: toolRole({ mcpServers: ['beta'], skills: false }),
      cwd: fixtureDirs.project,
      input: 'two',
      threadId: first.threadId,
    }),
    /bound to a different role or permission configuration/,
  );
  assert.equal(fake.getChild().sent.filter(({ method }) => method === 'turn/start').length, 1);
});

test('automatically starts a replacement child after an unexpected exit', async (t) => {
  const base = baseHandler();
  let fake;
  fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize' && fake.getChildren().length > 1) {
      // A delayed event from an old child must not poison the replacement.
      fake.getChildren()[0].emit('exit', 9, null);
    }
    return base(request, send);
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const first = await client.run({ role, cwd: fixtureDirs.project, input: 'one' });
  const firstChild = fake.getChild();
  firstChild.emit('exit', 9, null);
  await client.run({ role, cwd: fixtureDirs.project, input: 'two', threadId: first.threadId });
  assert.notEqual(fake.getChild(), firstChild);
  const resumes = fake.getChild().sent.filter(({ method }) => method === 'thread/resume');
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].params.threadId, first.threadId);
});

test('starts a replacement child on the next run after a turn timeout', async (t) => {
  const base = baseHandler();
  let fake;
  fake = fakeSpawn((request, send) => {
    if (fake.getChildren().length > 1) return base(request, send);
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-timeout' } } });
    if (request.method === 'turn/start') {
      return send({ id: request.id, result: { turn: { id: 'turn-timeout', status: 'inProgress' } } });
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, requestTimeoutMs: 25, turnTimeoutMs: 25 });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'hang' }), /Timed out waiting for Codex turn completion/);
  const firstChild = fake.getChild();
  const result = await client.run({ role, cwd: fixtureDirs.project, input: 'retry' });
  assert.notEqual(fake.getChild(), firstChild);
  assert.equal(result.text, 'reply:retry');
});

test('allows a turn to complete after the RPC timeout window', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-slow-turn' } } });
    if (request.method === 'turn/start') {
      const turnId = 'turn-slow';
      send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      setTimeout(() => {
        send({ method: 'item/completed', params: { threadId: 'thread-slow-turn', turnId, item: { type: 'agentMessage', text: 'slow reply' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread-slow-turn', turn: { id: turnId, status: 'completed' } } });
      }, 45);
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, requestTimeoutMs: 20, turnTimeoutMs: 100 });
  t.after(() => client.close());

  const result = await client.run({ role, cwd: fixtureDirs.project, input: 'slow' });
  assert.equal(result.text, 'slow reply');
});

test('rejects an invalid turn timeout', () => {
  assert.throws(() => new CodexAppServer({ turnTimeoutMs: 0 }), /positive safe integer/);
  assert.throws(() => new CodexAppServer({ turnTimeoutMs: Number.MAX_SAFE_INTEGER + 1 }), /positive safe integer/);
});

test('rejects unsupported role sandbox values before starting App Server', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(
    client.run({ role: { ...role, sandbox: 'danger-full-access' }, cwd: fixtureDirs.project, input: 'x' }),
    /Unsupported role sandbox/,
  );
  assert.equal(fake.getChildren().length, 0);
});

test('reads the turn timeout from CODEX_A2A_TURN_TIMEOUT_MS', () => {
  const previous = process.env.CODEX_A2A_TURN_TIMEOUT_MS;
  try {
    process.env.CODEX_A2A_TURN_TIMEOUT_MS = '2500';
    assert.equal(new CodexAppServer().turnTimeoutMs, 2500);
  } finally {
    if (previous === undefined) delete process.env.CODEX_A2A_TURN_TIMEOUT_MS;
    else process.env.CODEX_A2A_TURN_TIMEOUT_MS = previous;
  }
});

test('does not spawn a replacement when closed during child recovery', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  await client.start();

  fake.getChild().emit('error', new Error('broken pipe'));
  const recovering = client.start();
  await client.close();

  await assert.rejects(recovering, /client is closed/);
  assert.equal(fake.getChildren().length, 1);
});

test('propagates a thread/resume RPC error without starting a new thread', async (t) => {
  const base = baseHandler();
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'thread/resume') {
      return send({ id: request.id, error: { code: -32600, message: 'no rollout found', data: { codexErrorInfo: 'other' } } });
    }
    return base(request, send);
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(
    client.run({ role, cwd: fixtureDirs.project, input: 'x', threadId: 'gone' }),
    (error) => error.name === 'CodexAppServerError'
      && error.rpcCode === -32600
      && error.rpcData.codexErrorInfo === 'other'
      && /no rollout found/.test(error.message),
  );
  const methods = fake.getChild().sent.map(({ method }) => method);
  assert.equal(methods.includes('thread/start'), false);
  assert.equal(methods.includes('turn/start'), false);
});

test('fails closed when App Server does not report the requested active permission profile', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-no-profile' } } });
  }, { activeProfileSupport: false });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'x' }), /did not activate permission profile.*received none/);
  assert.equal(fake.getChild().sent.some(({ method }) => method === 'turn/start'), false);
});

test('readRateLimits returns the result or null on error', async (t) => {
  const limits = { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 }, secondary: null } };
  const ok = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'account/rateLimits/read') return send({ id: request.id, result: limits });
  });
  const okClient = new CodexAppServer({ spawnImpl: ok.spawnImpl });
  t.after(() => okClient.close());
  assert.deepEqual(await okClient.readRateLimits(), limits);

  const bad = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'account/rateLimits/read') return send({ id: request.id, error: { code: -32601, message: 'nope' } });
  });
  const badClient = new CodexAppServer({ spawnImpl: bad.spawnImpl });
  t.after(() => badClient.close());
  assert.equal(await badClient.readRateLimits(), null);
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

  await client.run({ role, cwd: fixtureDirs.project, input: 'request approvals' });
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
    if (request.method === 'thread/resume') send({ id: request.id, result: {} });
    if (request.method === 'turn/start') send({ id: request.id, result: { turn: { id: 'turn-overlap', status: 'inProgress' } } });
    if (request.method === 'turn/interrupt') {
      send({ id: request.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'shared-thread', turn: { id: 'turn-overlap', status: 'interrupted' } } });
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const controller = new AbortController();
  const active = client.run({ role, cwd: fixtureDirs.project, input: 'long run', threadId: 'shared-thread', signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    client.run({ role, cwd: fixtureDirs.project, input: 'overlap', threadId: 'shared-thread' }),
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
    if (request.method === 'thread/resume') send({ id: request.id, result: {} });
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
  const active = client.run({ role, cwd: fixtureDirs.project, input: 'cancel me', threadId: 'delayed-thread', signal: controller.signal });
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

  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'fail' }), /planned failure/);
});

test('keeps codexErrorInfo on a failed turn error', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-limit' } } });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-limit', status: 'inProgress' } } });
      setImmediate(() => send({ method: 'turn/completed', params: { threadId: 'thread-limit', turn: {
        id: 'turn-limit',
        status: 'failed',
        error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' },
      } } }));
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'x' }), (error) => {
    assert.equal(error.codexError.codexErrorInfo, 'usageLimitExceeded');
    assert.equal(error.threadId, 'thread-limit');
    return true;
  });
});

test('fails pending requests after an unexpected subprocess exit', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'initialized') return;
    if (request.method === 'thread/start') fake.getChild().emit('exit', 9, null);
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'exit' }), /exited unexpectedly/);
});

test('marks an unexpected exit during a turn as an unknown outcome', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-exit-mid-turn' } } });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-exit-mid-turn', status: 'inProgress' } } });
      setImmediate(() => fake.getChild().emit('exit', 9, null));
    }
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await assert.rejects(
    client.run({ role, cwd: fixtureDirs.project, input: 'may have changed files' }),
    (error) => error.outcomeUnknown === true && /exited unexpectedly/.test(error.message),
  );
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
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, requestTimeoutMs: 35, turnTimeoutMs: 35 });
  t.after(() => client.close());

  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'hang' }), (error) => {
    assert.equal(error.outcomeUnknown, true);
    return /Timed out waiting for Codex turn completion/.test(error.message);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(methods.includes('turn/interrupt'));
});

// --- group termination, execution evidence, usage ---

function groupKills() {
  const calls = [];
  const killImpl = (pid, signal) => { calls.push({ pid, signal }); };
  return { calls, killImpl };
}

const identityOf = (pid) => ({ pid, pgid: pid, startTime: '123' });

function hangingHandler({ turnStart = true, interruptConfirms = false } = {}) {
  return (request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'codex/9.9' } });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-h' }, model: 'm-x', reasoningEffort: 'low' } });
    if (request.method === 'turn/start' && turnStart) {
      send({ id: request.id, result: { turn: { id: 'turn-h', status: 'inProgress' } } });
      setImmediate(() => send({ method: 'turn/started', params: { threadId: 'thread-h', turn: { id: 'turn-h' } } }));
    }
    if (request.method === 'turn/interrupt') {
      send({ id: request.id, result: {} });
      if (interruptConfirms) {
        setImmediate(() => send({ method: 'turn/completed', params: { threadId: 'thread-h', turn: { id: 'turn-h', status: 'interrupted' } } }));
      }
    }
  };
}

test('turn timeout signals the whole process group', async (t) => {
  const kills = groupKills();
  const fake = fakeSpawn(hangingHandler(), { pidBase: 4000 });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, turnTimeoutMs: 30, killImpl: kills.killImpl, readProcessIdentityImpl: identityOf });
  t.after(() => client.close());
  const pending = client.run({ role, cwd: fixtureDirs.p, input: 'hang' });
  await new Promise((resolve) => setImmediate(resolve));
  const child = fake.getChild();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(kills.calls[0], { pid: -4000, signal: 'SIGTERM' });
  child.emit('exit', null, 'SIGTERM');
  await assert.rejects(pending, (error) => {
    assert.equal(error.outcomeUnknown, true);
    assert.deepEqual(error.execution.processIdentity, identityOf(4000));
    assert.equal(error.execution.turnStartSent, true);
    assert.equal(error.execution.turnTerminal, false);
    assert.equal(error.execution.turnId, 'turn-h');
    return true;
  });
});

test('falls back to child.kill when the child has no pid', async (t) => {
  const fake = fakeSpawn(hangingHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, turnTimeoutMs: 20 });
  t.after(() => client.close());
  await assert.rejects(client.run({ role, cwd: fixtureDirs.p, input: 'hang' }), { outcomeUnknown: true });
  assert.equal(fake.getChild().killed, true);
});

test('turn/start RPC timeout terminates the group and reports an unknown outcome', async (t) => {
  const kills = groupKills();
  const fake = fakeSpawn(hangingHandler({ turnStart: false }), { pidBase: 4000 });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, requestTimeoutMs: 30, killImpl: kills.killImpl, readProcessIdentityImpl: identityOf });
  t.after(() => client.close());
  await assert.rejects(client.run({ role, cwd: fixtureDirs.p, input: 'x' }), (error) => {
    assert.equal(error.outcomeUnknown, true);
    assert.match(error.message, /timed out: turn\/start/);
    assert.equal(error.execution.turnStartSent, true);
    assert.equal(error.execution.turnTerminal, false);
    return true;
  });
  assert.deepEqual(kills.calls[0], { pid: -4000, signal: 'SIGTERM' });
});

test('onTurnStart runs before turn/start is written and receives the identity', async (t) => {
  const fake = fakeSpawn(baseHandler(), { pidBase: 4000 });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, readProcessIdentityImpl: identityOf });
  t.after(() => client.close());
  let sentAtCall;
  let seen;
  const result = await client.run({
    role, cwd: fixtureDirs.p, input: 'hi',
    onTurnStart: (info) => {
      seen = info;
      sentAtCall = fake.getChild().sent.map(({ method }) => method);
    },
  });
  assert.equal(sentAtCall.includes('turn/start'), false);
  assert.deepEqual(seen, { processIdentity: identityOf(4000), threadId: 'thread-1' });
  assert.deepEqual(result.execution, {
    processIdentity: identityOf(4000), threadId: 'thread-1', turnId: 'turn-1', turnStartSent: true, turnStartRejected: false, turnTerminal: true,
  });
  assert.equal(client.processIdentity().pid, 4000);
});

test('a throwing onTurnStart prevents turn/start and is rethrown with execution', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await assert.rejects(
    client.run({ role, cwd: fixtureDirs.p, input: 'hi', onTurnStart: () => { throw new Error('admission denied'); } }),
    (error) => {
      assert.match(error.message, /admission denied/);
      assert.equal(error.execution.turnStartSent, false);
      assert.equal(error.execution.turnTerminal, false);
      return true;
    },
  );
  assert.equal(fake.getChild().sent.some(({ method }) => method === 'turn/start'), false);
});

test('failed turns carry execution with a confirmed terminal', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await assert.rejects(client.run({ role, cwd: fixtureDirs.p, input: 'fail' }), (error) => {
    assert.equal(error.execution.turnTerminal, true);
    assert.equal(error.execution.turnStartSent, true);
    assert.equal(error.execution.turnId, 'turn-1');
    assert.equal(typeof error.usage.elapsedMs, 'number');
    return true;
  });
});

test('confirmed interrupt yields an AbortError with a terminal and no unknown outcome', async (t) => {
  const kills = groupKills();
  const fake = fakeSpawn(hangingHandler({ interruptConfirms: true }), { pidBase: 4000 });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, interruptTimeoutMs: 200, killImpl: kills.killImpl, readProcessIdentityImpl: identityOf });
  t.after(() => client.close());
  const controller = new AbortController();
  const active = client.run({ role, cwd: fixtureDirs.p, input: 'x', signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(active, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.outcomeUnknown, undefined);
    assert.equal(error.execution.turnTerminal, true);
    return true;
  });
  assert.equal(kills.calls.length, 0);
});

test('unconfirmed interrupt terminates the child and reports an unknown outcome', async (t) => {
  const kills = groupKills();
  const fake = fakeSpawn(hangingHandler(), { pidBase: 4000 });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, interruptTimeoutMs: 20, turnTimeoutMs: 5000, killImpl: kills.killImpl, readProcessIdentityImpl: identityOf });
  t.after(() => client.close());
  const controller = new AbortController();
  const active = client.run({ role, cwd: fixtureDirs.p, input: 'x', signal: controller.signal });
  active.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  const child = fake.getChild();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(kills.calls[0], { pid: -4000, signal: 'SIGTERM' });
  child.emit('exit', null, 'SIGTERM');
  await assert.rejects(active, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.execution.turnTerminal, false);
    return true;
  });
});

function usageNotice(threadId, turnId, total) {
  return { method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total, last: total, modelContextWindow: 1000 } } };
}
const bd = (input, cached, output, reasoning, totalTokens) => ({
  inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens,
});

function usageHandler(totalsByTurn) {
  const base = baseHandler();
  let turn = 0;
  return (request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'codex/1.2.3' } });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-u' }, model: 'm-server', reasoningEffort: 'medium' } });
    if (request.method === 'turn/start') {
      const turnId = `turn-u${++turn}`;
      send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      setImmediate(() => {
        for (const total of totalsByTurn[turn - 1] || []) send(usageNotice(request.params.threadId, turnId, total));
        send({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: turnId, status: 'completed' } } });
      });
      return undefined;
    }
    return base(request, send);
  };
}

test('derives per-turn tokens from total deltas on a new thread and a second turn', async (t) => {
  const fake = fakeSpawn(usageHandler([
    [bd(10, 2, 5, 1, 15), bd(30, 4, 9, 3, 39)],
    [bd(50, 6, 20, 5, 70)],
  ]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const tokenRole = { name: 'r', model: 'gpt-6-sol', sandbox: 'workspace-write', instructions: role.instructions };
  const first = await client.run({ role: tokenRole, cwd: fixtureDirs.p, input: 'a' });
  assert.equal(first.usage.tokenSource, 'total_delta');
  assert.deepEqual(first.usage.tokens, { inputTokens: 30, cachedInputTokens: 4, outputTokens: 9, reasoningOutputTokens: 3, totalTokens: 39 });
  assert.equal(first.usage.model, 'm-server');
  assert.equal(first.usage.effort, 'medium');
  assert.equal(first.usage.turns, 1);
  assert.equal(first.usage.modelRequests, null);
  assert.equal(first.usage.appServerVersion, 'codex/1.2.3');
  assert.equal(first.usage.cumulativeTotal.totalTokens, 39);
  assert.equal(typeof first.usage.elapsedMs, 'number');
  assert.ok(first.usage.elapsedMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(first.usage.startedAt)));

  const second = await client.run({ role: tokenRole, cwd: fixtureDirs.p, input: 'b', threadId: first.threadId });
  assert.deepEqual(second.usage.tokens, { inputTokens: 20, cachedInputTokens: 2, outputTokens: 11, reasoningOutputTokens: 2, totalTokens: 31 });
  assert.equal(second.usage.model, 'gpt-6-sol');
  assert.equal(second.usage.effort, null);
});

test('a resumed thread with unknown baseline reports null tokens but keeps the raw total', async (t) => {
  const fake = fakeSpawn(usageHandler([[bd(500, 0, 50, 0, 550)], [bd(520, 0, 60, 0, 580)]]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const first = await client.run({ role, cwd: fixtureDirs.p, input: 'a', threadId: 'old-thread' });
  assert.equal(first.usage.tokens, null);
  assert.equal(first.usage.tokenSource, 'unavailable');
  assert.equal(first.usage.cumulativeTotal.totalTokens, 550);
  const second = await client.run({ role, cwd: fixtureDirs.p, input: 'b', threadId: 'old-thread' });
  assert.equal(second.usage.tokenSource, 'total_delta');
  assert.equal(second.usage.tokens.totalTokens, 30);
});

test('no token updates leaves tokens null, never zero', async (t) => {
  const fake = fakeSpawn(usageHandler([[]]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const result = await client.run({ role, cwd: fixtureDirs.p, input: 'a' });
  assert.equal(result.usage.tokens, null);
  assert.equal(result.usage.tokenSource, 'unavailable');
  assert.equal(result.usage.cumulativeTotal, null);
});

function permissionHandler(notes, { onTurn } = {}) {
  return (request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-perm' } } });
    if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'turn-perm', status: 'inProgress' } } });
      setImmediate(() => {
        for (const note of notes) send(note);
        onTurn?.(send);
      });
    }
    return undefined;
  };
}

const completedTurn = { method: 'turn/completed', params: { threadId: 'thread-perm', turn: { id: 'turn-perm', status: 'completed' } } };
const hookRun = (over = {}) => ({
  id: 'h1', eventName: 'preToolUse', handlerType: 'command', executionMode: 'sync', scope: 'turn',
  sourcePath: '/home/u/.codex/hooks.json', source: 'user', displayOrder: 3, status: 'blocked',
  statusMessage: 'blocked', startedAt: 1, completedAt: 2, durationMs: 1,
  entries: [{ kind: 'stop', text: 'Command blocked by PreToolUse hook: nope' }], ...over,
});

test('records a blocked hook run with provenance', async (t) => {
  const fake = fakeSpawn(permissionHandler([
    { method: 'hook/started', params: { threadId: 'thread-perm', turnId: 'turn-perm', run: hookRun({ status: 'running', entries: [] }) } },
    { method: 'hook/completed', params: { threadId: 'thread-perm', turnId: 'turn-perm', run: hookRun() } },
    { method: 'hook/completed', params: { threadId: 'thread-perm', turnId: 'turn-perm', run: hookRun({ id: 'h2', status: 'completed', entries: [] }) } },
    completedTurn,
  ]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const result = await client.run({ role, cwd: fixtureDirs.project, input: 'go' });
  assert.equal(result.permissionEvents.length, 1);
  assert.deepEqual(result.permissionEvents[0], {
    type: 'hook', eventName: 'preToolUse', status: 'blocked', source: 'user', sourcePath: '/home/u/.codex/hooks.json',
    hookId: 'h1', displayOrder: 3, statusMessage: 'blocked',
    entries: [{ kind: 'stop', text: 'Command blocked by PreToolUse hook: nope' }],
  });
});

test('records declined and hook-blocked tool items', async (t) => {
  const fake = fakeSpawn(permissionHandler([
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: 'rm -rf x', cwd: '/w', status: 'declined', aggregatedOutput: null } } },
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: 'Command blocked by PreToolUse hook: lead only' } } },
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: 'ok', cwd: '/w', status: 'completed', aggregatedOutput: 'fine' } } },
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'fileChange', status: 'failed', changes: [{ path: '/w/a.txt', kind: 'update', diff: 'x' }] } } },
    completedTurn,
  ]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const { permissionEvents: events } = await client.run({ role, cwd: fixtureDirs.work, input: 'go' });
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { type: 'tool', tool: 'commandExecution', status: 'declined', command: 'rm -rf x', cwd: '/w', blockedByHook: false, denial: true, reasonText: null });
  assert.equal(events[1].blockedByHook, true);
  assert.equal(events[1].reasonText, 'Command blocked by PreToolUse hook: lead only');
  assert.deepEqual(events[2], { type: 'tool', tool: 'fileChange', status: 'failed', paths: ['/w/a.txt'], blockedByHook: false, denial: true, reasonText: null });
  assert.equal(events[1].denial, true);
});

test('a failed command without a hook block or sandbox denial is not a permission event', async (t) => {
  const fake = fakeSpawn(permissionHandler([
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: 'rg nomatch', cwd: '/w', status: 'failed', aggregatedOutput: '' } } },
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: 'touch x', cwd: '/w', status: 'failed', aggregatedOutput: 'touch: cannot touch x: Read-only file system' } } },
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: 'cat y', cwd: '/w', status: 'failed', aggregatedOutput: 'cat: y: Permission denied' } } },
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: 'kill 1', cwd: '/w', status: 'failed', aggregatedOutput: 'kill: Operation not permitted' } } },
    completedTurn,
  ]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const { permissionEvents: events } = await client.run({ role, cwd: fixtureDirs.work, input: 'go' });
  assert.deepEqual(events.map((e) => e.command), ['touch x', 'cat y', 'kill 1']);
  assert.ok(events.every((e) => e.denial === true));
});

test('legacy approval requests get the schema decline and are recorded', async (t) => {
  const fake = fakeSpawn(permissionHandler([completedTurn], {
    onTurn: (send) => {
      send({ id: 'server-7', method: 'applyPatchApproval', params: { conversationId: 'thread-perm', callId: 'c', fileChanges: {}, reason: null, grantRoot: null } });
      send({ id: 'server-8', method: 'execCommandApproval', params: { conversationId: 'thread-perm', callId: 'd', command: ['ls'], cwd: '/w', reason: null, parsedCmd: [] } });
      send({ id: 'server-9', method: 'somethingElse', params: {} });
    },
  }));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const { permissionEvents: events } = await client.run({ role, cwd: fixtureDirs.work, input: 'go' });
  await new Promise((resolve) => setImmediate(resolve));
  const replies = fake.getChild().sent.filter((m) => String(m.id).startsWith('server-') && !m.method);
  assert.equal(replies.length, 3);
  for (const reply of replies.slice(0, 2)) assert.deepEqual(Object.keys(reply.result.decision), ['denied']);
  assert.equal(typeof replies[0].result.decision.denied.rejection, 'string');
  assert.ok(replies[2].error);
  assert.deepEqual(events.map((e) => [e.type, e.method]), [
    ['approval_request_declined', 'applyPatchApproval'], ['approval_request_declined', 'execCommandApproval'],
  ]);
});

test('records declined approval requests and non-approved auto reviews', async (t) => {
  const fake = fakeSpawn(permissionHandler([
    { method: 'item/autoApprovalReview/completed', params: { threadId: 'thread-perm', targetItemId: 'i1', decisionSource: 'agent', review: { status: 'denied', riskLevel: 'high', rationale: 'risky' } } },
    { method: 'item/autoApprovalReview/completed', params: { threadId: 'thread-perm', targetItemId: 'i2', decisionSource: 'agent', review: { status: 'approved' } } },
    completedTurn,
  ], {
    onTurn: (send) => send({ id: 'server-9', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-perm', itemId: 'c' } }),
  }));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const { permissionEvents: events } = await client.run({ role, cwd: fixtureDirs.work, input: 'go' });
  assert.deepEqual(events, [
    { type: 'approval_review', status: 'denied', riskLevel: 'high', rationale: 'risky', decisionSource: 'agent', targetItemId: 'i1' },
    { type: 'approval_request_declined', method: 'item/commandExecution/requestApproval', reason: 'client_declines_all' },
  ]);
});

test('truncates, redacts and caps permission events', async (t) => {
  const long = 'x'.repeat(2000);
  const notes = [
    { method: 'item/completed', params: { threadId: 'thread-perm', item: { type: 'commandExecution', command: `curl -H "Authorization: Bearer abc.def" GITHUB_TOKEN=ghp_123456789012345678901234567890123456 ${long}`, cwd: '/w', status: 'failed', aggregatedOutput: `Permission denied {"access_token":"json-secret"} Cookie: session=cookie-secret x-api-key: header-secret key sk-abcdefghijkl1234 ${long}` } } },
  ];
  for (let i = 0; i < 60; i += 1) notes.push({ method: 'hook/completed', params: { threadId: 'thread-perm', run: hookRun({ id: `c${i}` }) } });
  notes.push(completedTurn);
  const fake = fakeSpawn(permissionHandler(notes));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const { permissionEvents: events } = await client.run({ role, cwd: fixtureDirs.work, input: 'go' });
  assert.equal(events.length, 50);
  assert.ok(events[0].command.length <= 303);
  assert.ok(!events[0].command.includes('abc.def'));
  assert.ok(!events[0].command.includes('ghp_123456789012345678901234567890123456'));
  assert.match(events[0].command, /\[REDACTED\]/);
  assert.ok(!events[0].reasonText.includes('sk-abcdefghijkl1234'));
  assert.ok(!events[0].reasonText.includes('json-secret'));
  assert.ok(!events[0].reasonText.includes('cookie-secret'));
  assert.ok(!events[0].reasonText.includes('header-secret'));
  assert.ok(events[0].reasonText.includes('Permission denied'));
  assert.ok(events[0].reasonText.length <= 503);
});

test('reports permissionConfig for read-only and workspace-write roles', async (t) => {
  const fake = fakeSpawn(permissionHandler([completedTurn]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const ro = await client.run({ role: { ...role, sandbox: 'read-only' }, cwd: fixtureDirs.one, input: 'go' });
  const { toolPolicy: roPolicy, ...roConfig } = ro.permissionConfig;
  assert.deepEqual(roConfig, { profileId: 'codex-a2a-read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: fixtureDirs.one });
  assert.equal(roPolicy.enforced, true);
  assert.deepEqual(ro.permissionEvents, []);
  const rw = await client.run({ role, cwd: fixtureDirs.two, input: 'go' });
  const { toolPolicy: rwPolicy, ...rwConfig } = rw.permissionConfig;
  assert.equal(rwPolicy.enforced, true);
  assert.deepEqual(rwConfig, { profileId: 'codex-a2a-workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: fixtureDirs.two });
});

test('attaches permission events to thrown errors', async (t) => {
  const fake = fakeSpawn(permissionHandler([
    { method: 'hook/completed', params: { threadId: 'thread-perm', run: hookRun() } },
    { method: 'turn/completed', params: { threadId: 'thread-perm', turn: { id: 'turn-perm', status: 'failed', error: { message: 'boom' } } } },
  ]));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await assert.rejects(client.run({ role, cwd: fixtureDirs.work, input: 'go' }), (error) => {
    assert.equal(error.permissionEvents.length, 1);
    assert.equal(error.permissionEvents[0].hookId, 'h1');
    assert.equal(error.permissionConfig.cwd, fixtureDirs.work);
    return true;
  });
});

test('listHooks sanitizes metadata and hookInventory caches per cwd', async (t) => {
  let calls = 0;
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'hooks/list') {
      calls += 1;
      return send({ id: request.id, result: { data: [{ cwd: '/w', warnings: [], errors: [], hooks: [
        { key: 'k1', eventName: 'preToolUse', matcher: 'Bash', command: 'y'.repeat(500), sourcePath: '/h.json', source: 'user', enabled: true, trustStatus: 'trusted', currentHash: 'zz' },
      ] }] } });
    }
    return undefined;
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const hooks = await client.hookInventory('/w');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].key, 'k1');
  assert.equal(hooks[0].trustStatus, 'trusted');
  assert.ok(hooks[0].command.length <= 203);
  assert.ok(!('currentHash' in hooks[0]));
  await client.hookInventory('/w');
  assert.equal(calls, 1);
  assert.deepEqual(fake.getChild().sent.find((m) => m.method === 'hooks/list').params, { cwds: ['/w'] });
});

test('a JSON-RPC error answering turn/start marks execution.turnStartRejected and is not unknown', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, result: { thread: { id: 'thread-rej' } } });
    if (request.method === 'turn/start') return send({ id: request.id, error: { code: -32600, message: 'invalid request' } });
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await assert.rejects(client.run({ role, cwd: fixtureDirs.p, input: 'x' }), (error) => {
    assert.equal(error.execution.turnStartRejected, true);
    assert.equal(error.execution.turnStartSent, true);
    assert.notEqual(error.outcomeUnknown, true);
    return true;
  });
});

test('a turn/start timeout does not set turnStartRejected', async (t) => {
  const fake = fakeSpawn(hangingHandler({ turnStart: false }), { pidBase: 4100 });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, requestTimeoutMs: 30, killImpl: groupKills().killImpl, readProcessIdentityImpl: identityOf });
  t.after(() => client.close());
  await assert.rejects(client.run({ role, cwd: fixtureDirs.p, input: 'x' }), (error) => {
    assert.equal(error.execution.turnStartRejected, false);
    return true;
  });
});

test('usage.turns is 0 when the run failed before turn/start and 1 once it was sent', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'thread/start') return send({ id: request.id, error: { code: -1, message: 'no thread' } });
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await assert.rejects(client.run({ role, cwd: fixtureDirs.p, input: 'x' }), (error) => {
    assert.equal(error.usage.turns, 0);
    return true;
  });
  const ok = new CodexAppServer({ spawnImpl: fakeSpawn(baseHandler()).spawnImpl });
  t.after(() => ok.close());
  const result = await ok.run({ role, cwd: fixtureDirs.p, input: 'x' });
  assert.equal(result.usage.turns, 1);
});

const failurePaths = [
  ['stdin error', (child) => child.stdin.emit('error', new Error('EPIPE')), /stdin failed/],
  ['stdout error', (child) => child.stdout.emit('error', new Error('EIO')), /stdout failed/],
  ['invalid JSONL', (child) => child.stdout.write('not json\n'), /invalid JSONL/],
  ['stdout close', (child) => child.stdout.end(), /stdout closed unexpectedly/],
];

for (const [name, trigger, pattern] of failurePaths) {
  test(`${name} during a turn reports an unknown outcome and terminates the group`, async (t) => {
    const kills = groupKills();
    const fake = fakeSpawn(hangingHandler(), { pidBase: 4200 });
    const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, killImpl: kills.killImpl, readProcessIdentityImpl: identityOf });
    t.after(() => client.close());
    const running = client.run({ role, cwd: fixtureDirs.p, input: 'x' });
    await new Promise((resolve) => {
      const check = () => (fake.getChild()?.sent.some((m) => m.method === 'turn/start') ? setTimeout(resolve, 20) : setTimeout(check, 5));
      check();
    });
    try { trigger(fake.getChild()); } catch (_) { /* readline re-emits stream errors on itself */ }
    await assert.rejects(running, (error) => {
      assert.equal(error.outcomeUnknown, true);
      assert.match(error.message, pattern);
      return true;
    });
    assert.ok(kills.calls.some((c) => c.pid === -4200 && c.signal === 'SIGTERM'), 'group signalled');
  });
}

// The fake child's kill() emits an exit; these cases model a leader that never reports one.
function noHandleKill(spawnImpl) {
  return (...args) => {
    const child = spawnImpl(...args);
    child.kill = () => true;
    return child;
  };
}

async function delayedKillCase(t, identityNow) {
  const kills = groupKills();
  let reads = 0;
  const readImpl = (pid) => { reads += 1; return reads <= 2 ? identityOf(pid) : identityNow(pid); };
  const survivors = [{ pid: 4001, ppid: 1, comm: 'sleep', startTime: '5' }];
  const fake = fakeSpawn(hangingHandler(), { pidBase: 4000 });
  const client = new CodexAppServer({
    spawnImpl: noHandleKill(fake.spawnImpl), turnTimeoutMs: 20, killImpl: kills.killImpl,
    readProcessIdentityImpl: readImpl, listGroupMembersImpl: () => survivors,
  });
  t.after(() => client.close());
  const pending = client.run({ role, cwd: fixtureDirs.p, input: 'hang' });
  pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { kills, client, survivors };
}

test('delayed SIGKILL after the leader exited does not signal by number', async (t) => {
  const { kills, client, survivors } = await delayedKillCase(t, (pid) => ({ pid, pgid: pid, startTime: null }));
  assert.deepEqual(kills.calls.map((c) => c.signal), ['SIGTERM']);
  assert.deepEqual(client.lastTermination.survivors, survivors);
  assert.equal(client.lastTermination.identity.pid, 4000);
});

test('delayed SIGKILL after pid reuse (different start time) does not signal', async (t) => {
  const { kills } = await delayedKillCase(t, (pid) => ({ pid, pgid: pid, startTime: '999' }));
  assert.deepEqual(kills.calls.map((c) => c.signal), ['SIGTERM']);
});

test('delayed SIGKILL with the leader alive and the same start time signals the group', async (t) => {
  const { kills, client } = await delayedKillCase(t, identityOf);
  assert.deepEqual(kills.calls, [{ pid: -4000, signal: 'SIGTERM' }, { pid: -4000, signal: 'SIGKILL' }]);
  assert.equal(client.lastTermination, null);
});

test('a null start time identity never signals by number', async (t) => {
  const calls = [];
  const fake = fakeSpawn(hangingHandler(), { pidBase: 4100 });
  const client = new CodexAppServer({
    spawnImpl: noHandleKill(fake.spawnImpl), turnTimeoutMs: 20, killImpl: (pid, signal) => calls.push({ pid, signal }),
    readProcessIdentityImpl: (pid) => ({ pid, pgid: pid, startTime: null }), listGroupMembersImpl: () => [],
  });
  t.after(() => client.close());
  client.run({ role, cwd: fixtureDirs.p, input: 'hang' }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(calls, []);
});

test('pins approvalsReviewer to user on thread/start, thread/resume, and turn/start for both roles', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await client.run({ role: { ...role, sandbox: 'read-only' }, cwd: fixtureDirs.one, input: 'go' });
  await client.run({ role, cwd: fixtureDirs.two, input: 'go' });
  client.loadedThreads.clear();
  await client.run({ role: { ...role, sandbox: 'read-only' }, cwd: fixtureDirs.one, input: 'go', threadId: 'thread-old' });
  await client.run({ role, cwd: fixtureDirs.two, input: 'go', threadId: 'thread-old2' });
  const sent = fake.getChild().sent;
  for (const method of ['thread/start', 'thread/resume', 'turn/start']) {
    const calls = sent.filter((m) => m.method === method);
    assert.equal(calls.length, method === 'thread/start' ? 2 : method === 'thread/resume' ? 2 : 4, method);
    for (const call of calls) assert.equal(call.params.approvalsReviewer, 'user', method);
  }
});

// --- own-group signaling ---

test('close() with a leader exiting on SIGTERM SIGKILLs the group from the exit handler', async (t) => {
  const kills = groupKills();
  let alive = true;
  const fake = fakeSpawn(baseHandler(), { pidBase: 5000 });
  const client = new CodexAppServer({
    spawnImpl: fake.spawnImpl, killImpl: (pid, signal) => { kills.calls.push({ pid, signal }); },
    readProcessIdentityImpl: (pid) => (alive ? identityOf(pid) : { pid, pgid: pid, startTime: null }),
    listGroupMembersImpl: () => [],
  });
  await client.start();
  const child = fake.getChild();
  await client.close();
  assert.deepEqual(kills.calls, [{ pid: -5000, signal: 'SIGTERM' }]);
  alive = false;
  child.emit('exit', null, 'SIGTERM');
  assert.deepEqual(kills.calls, [{ pid: -5000, signal: 'SIGTERM' }, { pid: -5000, signal: 'SIGKILL' }]);
});

test('_signalOwnGroup decisions: stale exit, reused pid, mismatched identity, unreadable /proc', () => {
  const calls = [];
  const gone = (pid) => ({ pid, pgid: pid, startTime: null });
  const make = (readProcessIdentityImpl) => new CodexAppServer({ killImpl: (pid, signal) => calls.push({ pid, signal }), readProcessIdentityImpl });
  const id = { pid: 6000, pgid: 6000, startTime: '10' };
  // Leader absent, exit observed just now: signal.
  assert.equal(make(gone)._signalOwnGroup(id, 'SIGKILL', { exitAt: Date.now() - 100 }), true);
  assert.deepEqual(calls.splice(0), [{ pid: -6000, signal: 'SIGKILL' }]);
  // Exit observed more than 5 s ago: no signal.
  assert.equal(make(gone)._signalOwnGroup(id, 'SIGKILL', { exitAt: Date.now() - 6000 }), false);
  // Leader absent and no exit observed: no signal.
  assert.equal(make(gone)._signalOwnGroup(id, 'SIGKILL'), false);
  // Reused pid (different start time): no signal.
  assert.equal(make((pid) => ({ pid, pgid: pid, startTime: '99' }))._signalOwnGroup(id, 'SIGKILL', { exitAt: Date.now() }), false);
  // Leader alive but no longer its own group leader: no signal.
  assert.equal(make((pid) => ({ pid, pgid: 1, startTime: '10' }))._signalOwnGroup(id, 'SIGTERM'), false);
  // Identity without a start time (/proc unreadable): never by number.
  assert.equal(make(gone)._signalOwnGroup({ pid: 6000, pgid: 6000, startTime: null }, 'SIGTERM', { exitAt: Date.now() }), false);
  assert.deepEqual(calls, []);
  // The child handle is still signalled when the group is not.
  let handleSignal = null;
  const child = { exitCode: null, signalCode: null, kill: (sig) => { handleSignal = sig; } };
  make(gone)._signalOwnGroup({ pid: 6000, pgid: 6000, startTime: null }, 'SIGTERM', { child });
  assert.equal(handleSignal, 'SIGTERM');
});

test('SIGTERM with a mismatching childIdentity sends no numeric signal', async (t) => {
  const kills = groupKills();
  const fake = fakeSpawn(baseHandler(), { pidBase: 7000 });
  const client = new CodexAppServer({
    spawnImpl: fake.spawnImpl, killImpl: kills.killImpl,
    readProcessIdentityImpl: (pid) => ({ pid, pgid: pid, startTime: '555' }),
  });
  await client.start();
  client.childIdentity = { pid: 7000, pgid: 7000, startTime: '123' };
  await client.close();
  assert.deepEqual(kills.calls, []);
});

test('survivors of a termination are attached to the failed run error', async (t) => {
  const survivors = [{ pid: 4001, ppid: 1, comm: 'sleep', startTime: '5' }];
  const fake = fakeSpawn(hangingHandler(), { pidBase: 4300 });
  const client = new CodexAppServer({
    spawnImpl: fake.spawnImpl, turnTimeoutMs: 20,
    killImpl: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
    readProcessIdentityImpl: (pid) => (client.childExitAt == null ? identityOf(pid) : { pid, pgid: pid, startTime: null }),
    listGroupMembersImpl: () => survivors,
  });
  t.after(() => client.close());
  const pending = client.run({ role, cwd: fixtureDirs.p, input: 'hang' });
  const outcome = pending.then(() => null, (error) => error);
  await new Promise((resolve) => setTimeout(resolve, 40));
  fake.getChild().exitCode = 0;
  fake.getChild().emit('exit', null, 'SIGTERM');
  const error = await outcome;
  assert.equal(error.outcomeUnknown, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(error.termination.survivors, survivors);
  assert.equal(error.termination.identity.pid, 4300);
  assert.deepEqual(client.lastTermination.survivors, survivors);
});

function toolHandler(base, configRead) {
  const handler = (request, send) => {
    if (request.method === 'config/read') return configRead(request, send);
    return base(request, send);
  };
  handler.ownsConfigRead = true;
  return handler;
}

const toolRole = (tools) => ({ ...role, tools });

test('thread/start carries the fixed per-role tool config', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const priorSecret = process.env.M9_PROBE_SECRET;
  process.env.M9_PROBE_SECRET = 'fixture-secret';
  t.after(() => {
    if (priorSecret === undefined) delete process.env.M9_PROBE_SECRET;
    else process.env.M9_PROBE_SECRET = priorSecret;
  });
  const roleWithEnvironmentOverride = {
    ...toolRole({ mcpServers: ['gamma', 'ghost'], skills: false }),
    shell_environment_policy: { inherit: 'all', set: { M9_PROBE_SECRET: 'role-value' } },
  };
  const result = await client.run({ role: roleWithEnvironmentOverride, cwd: fixtureDirs.work, input: 'hi' });
  const start = fake.getChild().sent.find(({ method }) => method === 'thread/start');
  assert.deepEqual(Object.fromEntries(Object.entries(start.params.config).filter(([key]) => !key.startsWith('permissions.'))), {
    'features.apps': false,
    'features.plugins': false,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set': { PATH: process.env.PATH, HOME: process.env.HOME },
    'skills.include_instructions': false,
    'skills.bundled.enabled': false,
    'mcp_servers.alpha.enabled': false,
    'mcp_servers.beta.enabled': false,
  });
  const profile = start.params.config['permissions.codex-a2a-workspace-write.filesystem'];
  assert.deepEqual(profile[':root'], 'deny');
  assert.deepEqual(profile[':minimal'], 'read');
  assert.deepEqual(profile[fixtureDirs.work], 'write');
  assert.deepEqual(profile[`${fixtureDirs.work}/.runtime`], 'deny');
  assert.equal(profile[`${fixtureDirs.work}/.git`], 'read');
  assert.deepEqual(start.params.config['permissions.codex-a2a-workspace-write.network.enabled'], false);
  assert.equal(Object.hasOwn(start.params.config['shell_environment_policy.set'], 'M9_PROBE_SECRET'), false);
  assert.deepEqual(fake.getChild().sent.find(({ method }) => method === 'config/read').params.cwd, fixtureDirs.work);
  assert.deepEqual(result.permissionConfig.toolPolicy, {
    mcpAllowed: ['gamma'],
    mcpDisabled: ['alpha', 'beta'],
    mcpMissing: ['ghost'],
    skills: false,
    apps: false,
    plugins: false,
    enforced: true,
    source: 'config/read',
  });
});

test('missing tools table means empty allowlist and skills off; skills true keeps the listing', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await client.run({ role, cwd: fixtureDirs.work, input: 'one' });
  await client.run({ role: toolRole({ mcpServers: [], skills: true }), cwd: fixtureDirs.work, input: 'two' });
  const starts = fake.getChild().sent.filter(({ method }) => method === 'thread/start');
  assert.equal(starts[0].params.config['mcp_servers.gamma.enabled'], false);
  assert.equal(starts[0].params.config['skills.include_instructions'], false);
  assert.equal('skills.include_instructions' in starts[1].params.config, false);
  assert.equal('skills.bundled.enabled' in starts[1].params.config, false);
  // Enumeration is cached per child generation and cwd.
  assert.equal(fake.getChild().sent.filter(({ method }) => method === 'config/read').length, 1);
});

test('thread/resume carries the tool config after a child replacement', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const tools = { mcpServers: ['alpha'], skills: false };
  await client.run({ role: toolRole(tools), cwd: fixtureDirs.work, input: 'one', threadId: 'old-thread' });
  const resume = fake.getChild().sent.find(({ method }) => method === 'thread/resume');
  assert.equal(resume.params.config['mcp_servers.alpha.enabled'], undefined);
  assert.equal(resume.params.config['mcp_servers.beta.enabled'], false);
  assert.equal(resume.params.config['features.plugins'], false);
  assert.equal(resume.params.config['shell_environment_policy.inherit'], 'none');
  assert.deepEqual(resume.params.config['shell_environment_policy.set'], { PATH: process.env.PATH, HOME: process.env.HOME });
});

test('MCP enumeration failure fails closed before a thread or turn starts', async (t) => {
  const fake = fakeSpawn(toolHandler(baseHandler(), (request, send) => send({ id: request.id, error: { code: -32601, message: 'nope' } })));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await assert.rejects(
    client.run({ role: toolRole({ mcpServers: ['alpha'], skills: false }), cwd: fixtureDirs.work, input: 'hi' }),
    /MCP server enumeration failed/,
  );
  const methods = fake.getChild().sent.map(({ method }) => method);
  assert.equal(methods.includes('thread/start'), false);
  assert.equal(methods.includes('turn/start'), false);
});

test('mcpServerStatus lists status for a thread', async (t) => {
  const fake = fakeSpawn((request, send) => {
    if (request.method === 'initialize') return send({ id: request.id, result: {} });
    if (request.method === 'mcpServerStatus/list') return send({ id: request.id, result: { data: [{ name: 'x', runtimeStatus: 'disabled' }] } });
    return send({ id: request.id, result: {} });
  });
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  assert.deepEqual(await client.mcpServerStatus('t1'), [{ name: 'x', runtimeStatus: 'disabled' }]);
  assert.equal(fake.getChild().sent.find(({ method }) => method === 'mcpServerStatus/list').params.threadId, 't1');
});

function versionedHandler({ thread = {}, ready = {} } = {}) {
  const base = baseHandler();
  return (request, send) => {
    if (request.method === 'thread/start' || request.method === 'thread/resume') {
      return send({ id: request.id, result: { thread: { id: request.params.threadId || 'thread-1' }, activePermissionProfile: { id: request.params.permissions }, ...thread } });
    }
    if (request.method === 'model/list') return ready.modelList(request, send);
    return base(request, send);
  };
}

test('serviceTier is sent on thread/start and turn/start only when the role sets it', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await client.run({ role, cwd: fixtureDirs.project, input: 'plain' });
  let sent = fake.getChild().sent;
  assert.equal(Object.hasOwn(sent.find(({ method }) => method === 'thread/start').params, 'serviceTier'), false);
  assert.equal(Object.hasOwn(sent.find(({ method }) => method === 'turn/start').params, 'serviceTier'), false);

  await client.run({ role: { ...role, serviceTier: 'fast' }, cwd: fixtureDirs.project, input: 'quick' });
  sent = fake.getChild().sent;
  const starts = sent.filter(({ method }) => method === 'thread/start');
  const turns = sent.filter(({ method }) => method === 'turn/start');
  assert.equal(starts[1].params.serviceTier, 'fast');
  assert.equal(turns[1].params.serviceTier, 'fast');
  assert.equal(turns[1].params.model, 'gpt-6-sol');
  assert.equal(turns[1].params.effort, 'high');
});

test('serviceTier is sent on thread/resume when set', async (t) => {
  const fake = fakeSpawn(versionedHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  await client.run({ role: { ...role, serviceTier: 'fast' }, cwd: fixtureDirs.project, input: 'again', threadId: 'old-thread' });
  const resume = fake.getChild().sent.find(({ method }) => method === 'thread/resume');
  assert.equal(resume.params.serviceTier, 'fast');
  await client.run({ role, cwd: fixtureDirs.project, input: 'again', threadId: 'other-thread' });
  const resumes = fake.getChild().sent.filter(({ method }) => method === 'thread/resume');
  assert.equal(Object.hasOwn(resumes[1].params, 'serviceTier'), false);
});

test('usage carries requested and reported settings from the thread response', async (t) => {
  const fake = fakeSpawn(versionedHandler({ thread: { model: 'gpt-6-luna', reasoningEffort: 'xhigh', serviceTier: 'fast' } }));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const result = await client.run({ role: { ...role, serviceTier: 'fast' }, cwd: fixtureDirs.project, input: 'hi' });
  assert.deepEqual(result.usage.requested, { model: 'gpt-6-sol', effort: 'high', serviceTier: 'fast' });
  assert.deepEqual(result.usage.reported, { model: 'gpt-6-luna', reasoningEffort: 'xhigh', serviceTier: 'fast' });
  assert.equal(result.usage.model, 'gpt-6-luna');
  assert.equal(result.usage.effort, 'high');
});

test('usage requested and reported are null-filled when nothing is set or reported', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const result = await client.run({ role: { name: 'bare', sandbox: 'read-only' }, cwd: fixtureDirs.project, input: 'hi' });
  assert.deepEqual(result.usage.requested, { model: null, effort: null, serviceTier: null });
  assert.deepEqual(result.usage.reported, { model: null, reasoningEffort: null, serviceTier: null });
});

test('usage reported is null on a turn of an already loaded thread', async (t) => {
  const fake = fakeSpawn(versionedHandler({ thread: { model: 'gpt-6-luna', reasoningEffort: 'xhigh', serviceTier: 'fast' } }));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  const first = await client.run({ role, cwd: fixtureDirs.project, input: 'one' });
  assert.equal(first.usage.reported.model, 'gpt-6-luna');
  const second = await client.run({ role, cwd: fixtureDirs.project, input: 'two', threadId: first.threadId });
  assert.equal(second.usage.reported, null);
  assert.deepEqual(second.usage.requested, { model: 'gpt-6-sol', effort: 'high', serviceTier: null });
});

test('listModels pages model/list until nextCursor is null', async (t) => {
  const pages = { undefined: { data: [{ id: 'a' }], nextCursor: 'c1' }, c1: { data: [{ id: 'b' }, { id: 'c' }], nextCursor: null } };
  const fake = fakeSpawn(versionedHandler({ ready: { modelList: (request, send) => send({ id: request.id, result: pages[request.params.cursor] }) } }));
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());
  assert.deepEqual((await client.listModels()).map((m) => m.id), ['a', 'b', 'c']);
  const requests = fake.getChild().sent.filter(({ method }) => method === 'model/list');
  assert.deepEqual(requests.map((r) => r.params), [{ includeHidden: false }, { includeHidden: false, cursor: 'c1' }]);
});

test('listModels gives up after 20 pages and propagates RPC errors', async (t) => {
  const endless = fakeSpawn(versionedHandler({ ready: { modelList: (request, send) => send({ id: request.id, result: { data: [], nextCursor: 'more' } }) } }));
  const endlessClient = new CodexAppServer({ spawnImpl: endless.spawnImpl });
  t.after(() => endlessClient.close());
  await assert.rejects(endlessClient.listModels(), /20 pages/);
  assert.equal(endless.getChild().sent.filter(({ method }) => method === 'model/list').length, 20);

  const bad = fakeSpawn(versionedHandler({ ready: { modelList: (request, send) => send({ id: request.id, error: { code: -32601, message: 'nope' } }) } }));
  const badClient = new CodexAppServer({ spawnImpl: bad.spawnImpl });
  t.after(() => badClient.close());
  await assert.rejects(badClient.listModels(), /nope/);
});

// ---- auth failure: lazy recycle of the shared child ----

function authHandler() {
  const base = baseHandler();
  const hung = [];
  const handler = (request, send) => {
    if (request.method === 'turn/start') {
      const text = request.params.input[0].text;
      if (text === 'authfail' || text === 'hang') {
        const turnId = `turn-${text}-${hung.length}`;
        send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
        const finish = () => send({
          method: 'turn/completed',
          params: { threadId: request.params.threadId, turn: { id: turnId, status: 'failed', error: { message: 'Please sign in again.', codexErrorInfo: 'unauthorized' } } },
        });
        if (text === 'authfail') setImmediate(finish); else hung.push(finish);
        return undefined;
      }
    }
    return base(request, send);
  };
  return { handler, hung };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an auth failure marks the session stale; the next idle run uses a fresh child and resumes the thread', async (t) => {
  const { handler } = authHandler();
  const fake = fakeSpawn(handler);
  const stale = [];
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl, onAuthStale: () => stale.push(client.authStale) });
  t.after(() => client.close());

  const first = await client.run({ role, cwd: fixtureDirs.project, input: 'one' });
  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'authfail', threadId: first.threadId }), /sign in again/);
  assert.equal(client.authStale, true);
  assert.equal(fake.getChildren().length, 1);
  assert.deepEqual(stale, [true]);

  const result = await client.run({ role, cwd: fixtureDirs.project, input: 'two', threadId: first.threadId });
  assert.equal(result.status, 'completed');
  assert.equal(client.authStale, false);
  assert.equal(fake.getChildren().length, 2);
  assert.equal(fake.getChildren()[0].killed, true);
  assert.equal(fake.getChildren()[1].sent.some(({ method }) => method === 'thread/resume'), true);
  assert.equal(stale.length, 2);
});

test('a stale session is not recycled while a run is in flight; the flag stays until idle', async (t) => {
  const { handler, hung } = authHandler();
  const fake = fakeSpawn(handler);
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  const busy = client.run({ role, cwd: fixtureDirs.one, input: 'hang' });
  busy.catch(() => {});
  for (let i = 0; i < 50 && hung.length === 0; i += 1) await settle();
  assert.equal(hung.length, 1);
  client.authStale = true;
  const other = await client.run({ role, cwd: fixtureDirs.two, input: 'other' });
  assert.equal(other.status, 'completed');
  assert.equal(fake.getChildren().length, 1);
  assert.equal(fake.getChildren()[0].killed, false);
  assert.equal(client.authStale, true);

  hung[0]();
  await assert.rejects(busy, /sign in again/);
  await client.run({ role, cwd: fixtureDirs.project, input: 'idle' });
  assert.equal(client.authStale, false);
  assert.equal(fake.getChildren().length, 2);
});

test('without the stale flag the child is never recycled; other failures do not set it', async (t) => {
  const fake = fakeSpawn(baseHandler());
  const client = new CodexAppServer({ spawnImpl: fake.spawnImpl });
  t.after(() => client.close());

  await client.run({ role, cwd: fixtureDirs.project, input: 'one' });
  await assert.rejects(client.run({ role, cwd: fixtureDirs.project, input: 'fail' }), /planned failure/);
  assert.equal(client.authStale, false);
  await client.run({ role, cwd: fixtureDirs.project, input: 'two' });
  assert.equal(fake.getChildren().length, 1);
});
