'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class Element {
  constructor() { this.children = []; this.handlers = {}; this.disabled = false; this.value = ''; this.href = ''; this.colSpan = 1; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  appendChild(item) { this.children.push(item); return item; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'backlog.js'), 'utf8');
const control = (objectiveId) => ({ engine: 'concurrent-v1', runId: 'run-' + objectiveId, projectId: 'aaaaaaaaaa', sessionId: 'session-a', objectiveId,
  revisions: { planRevision: 1, goalRevision: 2, controlRevision: 3 }, disposition: 'executing', inbox: [] });
const fixture = () => {
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); } };
  const calls = []; const pending = [];
  const fetch = (url, options = {}) => {
    const parsed = new URL(url, 'http://localhost');
    calls.push({ url: parsed, options });
    if (options.method === 'POST') return new Promise(resolve => pending.push({ kind: 'send', body: JSON.parse(options.body), resolve }));
    if (parsed.pathname.endsWith('/delivery/objectives')) return Promise.resolve({ ok: true, json: async () => ({ available: true, objectives: [
      { objectiveId: 'objective-a', sessionId: 'session-a', disposition: 'executing' },
      { objectiveId: 'objective-b', sessionId: 'session-a', disposition: 'executing' },
    ] }) });
    if (parsed.pathname.endsWith('/delivery/backlog')) return Promise.resolve({ ok: true, json: async () => ({ available: true, counts: { ready: 0, blocked: 0, unknown: 0, active: 0 }, tasks: [], nextCursor: null }) });
    if (parsed.pathname.endsWith('/delivery/control')) {
      const objective = parsed.searchParams.get('objectiveId');
      return Promise.resolve({ ok: true, json: async () => control(objective) });
    }
    throw new Error('unexpected request ' + url);
  };
  const window = { location: { search: '?project=aaaaaaaaaa&session=session-a', origin: 'http://localhost' }, addEventListener() {}, setInterval() { return 1; } };
  vm.runInNewContext(source, { document, window, URL, URLSearchParams, fetch, console });
  return { elements, calls, pending };
};

test('selection changes preserve scoped drafts and pending requests, and uncertain retries freeze the full body', async () => {
  const app = fixture(); await tick(); await tick();
  const text = app.elements.get('steeringText'); text.value = 'Focus on the failing API'; text.handlers.input();
  const firstSend = app.elements.get('steeringForm').handlers.submit({ preventDefault() {} });
  assert.equal(app.pending.length, 1);
  const frozenRequest = app.pending[0].body;
  text.value = 'Edited while the first send is in flight'; text.handlers.input();
  app.elements.get('backlogObjective').value = 'objective-b';
  app.elements.get('backlogObjective').handlers.change(); await tick();
  assert.equal(text.value, '');
  app.pending[0].resolve({ ok: false, status: 503, json: async () => ({ error: 'Temporary owner control failure' }) });
  await firstSend; await tick();
  app.elements.get('backlogObjective').value = 'objective-a';
  app.elements.get('backlogObjective').handlers.change(); await tick();
  assert.equal(text.value, 'Edited while the first send is in flight');
  const secondSend = app.elements.get('steeringForm').handlers.submit({ preventDefault() {} });
  assert.equal(app.pending.length, 2);
  assert.deepEqual(app.pending[1].body, frozenRequest);
  const ack = { engine: 'concurrent-v1', runId: frozenRequest.runId, projectId: frozenRequest.projectId,
    sessionId: frozenRequest.sessionId, objectiveId: frozenRequest.objectiveId, messageId: frozenRequest.messageId,
    state: 'received', acknowledged: true };
  app.pending[1].resolve({ ok: true, status: 200, json: async () => ack });
  await secondSend;
  assert.equal(text.value, 'Edited while the first send is in flight', 'an acknowledgement must preserve edits made after the request snapshot');
  assert.equal(app.pending.length, 2, 'selection and refresh do not send automatically');
});

test('unverified 200 acknowledgement keeps the draft and exact request for retry', async () => {
  const app = fixture(); await tick(); await tick();
  const text = app.elements.get('steeringText'); text.value = 'Keep this note'; text.handlers.input();
  const sending = app.elements.get('steeringForm').handlers.submit({ preventDefault() {} });
  assert.equal(app.pending.length, 1);
  const original = app.pending[0].body;
  app.pending[0].resolve({ ok: true, status: 200, json: async () => ({ messageId: original.messageId, acknowledged: true, state: 'received' }) });
  await sending;
  assert.equal(text.value, 'Keep this note');
  const retry = app.elements.get('steeringForm').handlers.submit({ preventDefault() {} });
  assert.deepEqual(app.pending[1].body, original);
  app.pending[1].resolve({ ok: true, status: 200, json: async () => ({ engine: 'concurrent-v1', runId: original.runId,
    projectId: original.projectId, sessionId: original.sessionId, objectiveId: original.objectiveId,
    messageId: original.messageId, acknowledged: true, state: 'received' }) });
  await retry;
  assert.equal(text.value, '');
});
