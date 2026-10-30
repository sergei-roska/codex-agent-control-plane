'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class Element {
  constructor(id = '') { this.id = id; this.children = []; this.handlers = {}; this.disabled = false; this.colSpan = 1; this.href = ''; this._text = ''; this.value = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  appendChild(child) { this.children.push(child); return child; }
}

function responseJson(value) { return { ok: true, json: async () => value }; }
function projection(objectiveId, ready) {
  return { available: true, objective: { objectiveId }, counts: { ready, blocked: 1, active: 0, unknown: 2 },
    capacity: { projectActive: 2, objectiveActive: 0, configuredWorkerLimit: 4, effectiveRuntimeLimit: null,
      byRole: { engineer: { active: 2, configuredLimit: 4 }, verifier: { active: 0, configuredLimit: 2 } } },
    planner: { available: true, scope: 'session', sessionId: 'session-a', attribution: 'not_attributed_to_objective', inFlight: false },
    inbox: { available: true, wakeup: false },
    idleReasons: { known: [{ reason: 'role_capacity_full', detail: 'engineer: 4 project claims use the configured 4 role slots.' }], unknown: [{ reason: 'effective_runtime_capacity_unknown', detail: 'The active scheduler limit is not exposed.' }] },
    tasks: [], nextCursor: null };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('objective discovery, live polling, detail rendering and stale selection guards work together', async () => {
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); }, createElement() { return new Element(); } };
  const pending = [];
  const calls = [];
  const fetch = url => {
    calls.push(url);
    if (new URL(url, 'http://localhost').pathname.endsWith('/delivery/control')) return Promise.resolve(responseJson({
      engine: 'concurrent-v1', runId: 'run-ui', projectId: 'aaaaaaaaaa', sessionId: 'session-a', objectiveId: 'objective-ui',
      revisions: { planRevision: 1, goalRevision: 1, controlRevision: 1 }, inbox: [], disposition: 'executing',
    }));
    return new Promise(resolve => pending.push({ url: new URL(url, 'http://localhost'), resolve }));
  };
  let poll;
  const source = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'backlog.js'), 'utf8');
  const window = { location: { search: '?project=aaaaaaaaaa&session=session-a', origin: 'http://localhost' },
    addEventListener() {}, setInterval(callback) { poll = callback; return 1; } };
  vm.runInNewContext(source, { document, window, URL, URLSearchParams, fetch, console });
  assert.match(pending[0].url.pathname, /delivery\/objectives$/);
  pending[0].resolve(responseJson({ available: true, objectives: [
    { objectiveId: 'objective-old', sessionId: 'session-a', disposition: 'executing' },
    { objectiveId: 'objective-new', sessionId: 'session-a', disposition: 'planning' },
  ] }));
  await flush();
  assert.match(pending[1].url.pathname, /delivery\/backlog$/);
  assert.equal(pending[1].url.searchParams.get('objectiveId'), 'objective-old');
  const selector = elements.get('backlogObjective');
  selector.value = 'objective-new';
  selector.handlers.change();
  assert.equal(pending[2].url.searchParams.get('objectiveId'), 'objective-new');
  pending[2].resolve(responseJson(projection('objective-new', 7)));
  await flush();
  pending[1].resolve(responseJson(projection('objective-old', 1)));
  await flush();
  assert.equal(elements.get('readyCount').textContent, '7');
  assert.match(elements.get('roleOccupancy').textContent, /engineer: 2 project claims/);
  assert.match(elements.get('configuredCapacity').textContent, /configured slots/);
  assert.equal(elements.get('effectiveCapacity').textContent, 'Unknown');
  assert.match(elements.get('idleUnknown').textContent, /active scheduler limit is not exposed/);
  assert.match(elements.get('plannerSummary').textContent, /objective attribution unavailable/);

  poll();
  assert.match(pending[3].url.pathname, /delivery\/objectives$/);
  pending[3].resolve(responseJson({ available: true, objectives: [
    { objectiveId: 'objective-old', sessionId: 'session-a', disposition: 'executing' },
    { objectiveId: 'objective-new', sessionId: 'session-a', disposition: 'planning' },
  ] }));
  await flush();
  assert.equal(pending[4].url.searchParams.get('objectiveId'), 'objective-new');
  pending[4].resolve(responseJson({ ...projection('objective-new', 9), tasks: [{ taskId: 'task-stable-42', title: 'Readable task summary', state: 'queued', readiness: 'ready', role: 'engineer', dependencyReasons: [], attempts: [{ attemptId: 'a1', state: 'running', waits: { backlogMs: 100, writerMs: null, providerMs: 50, settlementMs: 400 } }] }] }));
  await flush();
  assert.equal(elements.get('readyCount').textContent, '9');
  assert.equal(elements.get('backlogRows').children[0].children[0].textContent, 'Readable task summary\ntask-stable-42');
  const timing = elements.get('backlogRows').children[0].children[5].textContent;
  assert.match(timing, /Backlog creation to first claim.*100 ms/);
  assert.match(timing, /Writer admission acquisition: Unknown/);
  assert.match(timing, /Provider startup to turn start: 50 ms/);
  assert.match(timing, /Terminal to durable settlement.*400 ms/);
  assert.ok(calls.some(url => new URL(url, 'http://localhost').searchParams.get('sessionId') === 'session-a'));
  assert.equal(selector.children.some(option => option.value === 'objective-new'), true);
});

test('project and session changes clear selection and discard old objective and backlog responses', async () => {
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); }, createElement() { return new Element(); } };
  const pending = [];
  const fetch = url => {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname.endsWith('/delivery/control')) return Promise.resolve(responseJson({
      engine: 'concurrent-v1', runId: 'run-ui', projectId: parsed.pathname.split('/')[3], sessionId: parsed.searchParams.get('sessionId'),
      objectiveId: parsed.searchParams.get('objectiveId'), revisions: { planRevision: 1, goalRevision: 1, controlRevision: 1 }, inbox: [], disposition: 'executing',
    }));
    return new Promise(resolve => pending.push({ url: parsed, resolve }));
  };
  const events = {};
  let poll;
  const window = { location: { search: '?project=aaaaaaaaaa&session=session-a', origin: 'http://localhost' },
    addEventListener(name, callback) { events[name] = callback; }, setInterval(callback) { poll = callback; return 1; } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'backlog.js'), 'utf8');
  vm.runInNewContext(source, { document, window, URL, URLSearchParams, fetch, console });
  window.location.search = '?project=bbbbbbbbbb&session=session-b';
  pending[0].resolve(responseJson({ available: true, objectives: [{ objectiveId: 'objective-a', sessionId: 'session-a', disposition: 'executing' }] }));
  await flush();
  assert.equal(pending.length, 1);
  events.popstate();
  assert.equal(elements.get('readyCount').textContent, '-');
  assert.match(pending[1].url.pathname, /delivery\/objectives$/);
  assert.equal(pending[1].url.pathname, '/api/projects/bbbbbbbbbb/delivery/objectives');
  assert.equal(pending[1].url.searchParams.get('sessionId'), 'session-b');
  pending[1].resolve(responseJson({ available: true, objectives: [{ objectiveId: 'objective-b', sessionId: 'session-b', disposition: 'executing' }] }));
  await flush();
  assert.equal(pending[2].url.pathname, '/api/projects/bbbbbbbbbb/delivery/backlog');
  window.location.search = '?project=cccccccccc&session=session-c';
  events.popstate();
  assert.equal(elements.get('readyCount').textContent, '-');
  assert.equal(pending[3].url.pathname, '/api/projects/cccccccccc/delivery/objectives');
  pending[3].resolve(responseJson({ available: true, objectives: [{ objectiveId: 'objective-c', sessionId: 'session-c', disposition: 'planning' }] }));
  await flush();
  assert.equal(pending[4].url.pathname, '/api/projects/cccccccccc/delivery/backlog');
  pending[4].resolve(responseJson(projection('objective-c', 11)));
  await flush();
  pending[2].resolve(responseJson(projection('objective-b', 2)));
  await flush();
  assert.equal(elements.get('readyCount').textContent, '11');
  assert.match(elements.get('backlogStatus').textContent, /refreshed just now/);
});

test('poll refreshes every currently loaded page with a nonempty cursor and renders unknown readiness', async () => {
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); }, createElement() { return new Element(); } };
  const pending = [];
  const fetch = url => {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname.endsWith('/delivery/control')) return Promise.resolve(responseJson({
      engine: 'concurrent-v1', runId: 'run-ui', projectId: 'aaaaaaaaaa', sessionId: 'session-a', objectiveId: 'objective-a',
      revisions: { planRevision: 1, goalRevision: 1, controlRevision: 1 }, inbox: [], disposition: 'executing',
    }));
    return new Promise(resolve => pending.push({ url: parsed, resolve }));
  };
  let poll;
  const window = { location: { search: '?project=aaaaaaaaaa&session=session-a', origin: 'http://localhost' },
    addEventListener() {}, setInterval(callback) { poll = callback; return 1; } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'backlog.js'), 'utf8');
  vm.runInNewContext(source, { document, window, URL, URLSearchParams, fetch, console });
  pending[0].resolve(responseJson({ available: true, objectives: [{ objectiveId: 'objective-a', sessionId: 'session-a', disposition: 'executing' }] }));
  await flush();
  pending[1].resolve(responseJson({ ...projection('objective-a', 1), tasks: [{ taskId: 'page-one' }], nextCursor: 'opaque-page-2' }));
  await flush();
  assert.equal(elements.get('unknownCount').textContent, '2');
  assert.equal(elements.get('backlogRows').children.length, 1);
  elements.get('backlogNext').handlers.click();
  assert.equal(pending[2].url.searchParams.get('afterCursor'), 'opaque-page-2');
  pending[2].resolve(responseJson({ ...projection('objective-a', 1), tasks: [{ taskId: 'page-two' }], nextCursor: 'opaque-page-3' }));
  await flush();
  assert.equal(elements.get('backlogRows').children.length, 2);

  poll();
  pending[3].resolve(responseJson({ available: true, objectives: [{ objectiveId: 'objective-a', sessionId: 'session-a', disposition: 'executing' }] }));
  await flush();
  assert.equal(pending[4].url.searchParams.get('afterCursor'), null);
  pending[4].resolve(responseJson({ ...projection('objective-a', 8), tasks: [{ taskId: 'updated-page-one' }], nextCursor: 'fresh-page-2' }));
  await flush();
  assert.equal(pending[5].url.searchParams.get('afterCursor'), 'fresh-page-2');
  pending[5].resolve(responseJson({ ...projection('objective-a', 8), tasks: [{ taskId: 'updated-page-two' }], nextCursor: null }));
  await flush();
  assert.equal(elements.get('readyCount').textContent, '8');
  assert.equal(elements.get('unknownCount').textContent, '2');
  assert.equal(elements.get('backlogRows').children.length, 2);
  assert.equal(elements.get('backlogNext').disabled, true);
});
