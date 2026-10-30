'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class Element {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.value = '';
    this.disabled = false;
    this.clientWidth = 760;
    this.href = '';
    this._text = '';
    this._html = '';
    const classes = new Set();
    this.classList = {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
      toggle: (value, force) => {
        if (force === undefined ? !classes.has(value) : force) classes.add(value);
        else classes.delete(value);
      },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent || '').join(''); }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.handlers[name] = callback; }
}

async function renderPage({ snapshot, usage, session = { turns: [] } }) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const document = {
    hidden: true,
    getElementById: getElement,
    createElement: (tag) => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag),
    addEventListener() {},
  };
  const window = {
    location: { search: '?project=aaaaaaaaaa&session=session-1', href: 'http://localhost/ui/performance.html?project=aaaaaaaaaa&session=session-1', origin: 'http://localhost' },
    addEventListener() {},
  };
  const history = { replaceState() {} };
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    let body;
    if (url === '/api/projects') body = { projects: [{ id: 'aaaaaaaaaa', name: 'Project' }] };
    else if (url === '/api/projects/aaaaaaaaaa/sessions') body = { sessions: [{ contextId: 'session-1' }] };
    else if (url === '/ui/metrics/aaaaaaaaaa/session-1.json') {
      if (snapshot === null) return { ok: false, status: 404, json: async () => ({}) };
      body = snapshot;
    }
    else if (url === '/api/projects/aaaaaaaaaa/sessions/session-1/usage?details=performance') body = usage;
    else if (url === '/api/projects/aaaaaaaaaa/sessions/session-1') body = session;
    else throw new Error('Unexpected request: ' + url);
    return { ok: true, json: async () => body };
  };
  const context = {
    document, window, history, fetch, URL, URLSearchParams, AbortController,
    setInterval: () => 1, clearInterval() {}, console,
    Date, Math, Number, String, Object, Array, Map, Set, JSON,
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'launcher-ui', 'performance.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'launcher-ui/performance.js' });
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return { elements, requests };
}

test('performance page overlays current per-task usage onto a same-session unknown snapshot', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', generatedAt: '2026-01-01T00:00:00.000Z',
    total: { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, attempts: 2 },
    tasks: [
      { taskId: 'worker-1', assignmentId: 'lead-1:r1:a0', role: 'engineer', totalTokens: null, inputTokens: null, outputTokens: null, elapsedMs: 30, unknownTokenRows: null },
      { taskId: 'worker-2', assignmentId: 'lead-1:r1:a1', role: 'reviewer', totalTokens: null, inputTokens: null, outputTokens: null, elapsedMs: null, unknownTokenRows: null },
    ],
  };
  const usage = {
    total: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16, attempts: 2 },
    unknownCount: 1,
    performance: {
      schema: 'session-performance/v1', generatedAt: '2026-01-02T00:00:00.000Z',
      attempts: [
        { entryId: 'turn-known', kind: 'worker_turn', taskId: 'worker-1', runId: 'lead-1', assignmentId: 'lead-1:r1:a0', role: 'engineer', tokens: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16 } },
        { entryId: 'turn-unknown', kind: 'worker_turn', taskId: 'worker-1', runId: 'lead-1', assignmentId: 'lead-1:r1:a0', role: 'engineer', tokens: { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null } },
      ],
    },
  };
  const { elements, requests } = await renderPage({ snapshot, usage });
  assert.ok(requests.includes('/api/projects/aaaaaaaaaa/sessions/session-1/usage?details=performance'));
  assert.match(elements.get('tokenTotal').textContent, /^16/);
  assert.match(elements.get('taskTokenCoverage').textContent, /Showing top 1 of 1 known task token totals; 1 partial; 1 unknown/);
  assert.match(elements.get('taskRows').innerHTML, />16\+/);
  assert.match(elements.get('taskRows').innerHTML, />Unknown/);
});

test('performance page recognizes nested and legacy snake-case token fields without filling unknowns', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1',
    total: { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null },
    tasks: [
      { task_id: 'worker-1', assignment_id: 'lead-1:r1:a0', role: 'engineer', tokens: { input_tokens: 6, cached_input_tokens: 2, output_tokens: 3, total_tokens: 9 }, elapsedMs: null },
      { task_id: 'worker-2', assignment_id: 'lead-1:r1:a1', role: 'reviewer', tokens: { input_tokens: null, output_tokens: 3 }, elapsedMs: null },
    ],
  };
  const { elements } = await renderPage({ snapshot, usage: { total: {}, unknownCount: 0 } });
  assert.match(elements.get('taskTokenCoverage').textContent, /Showing top 1 of 1 known task token totals; 1 unknown/);
  assert.match(elements.get('taskRows').innerHTML, />9</);
  assert.match(elements.get('taskRows').innerHTML, />Unknown/);
});

test('performance page builds task token rows from live detailed usage when no snapshot exists', async () => {
  const usage = {
    total: { inputTokens: 8, cachedInputTokens: null, outputTokens: 2, totalTokens: 10, attempts: 2 },
    unknownCount: 1,
    performance: {
      schema: 'session-performance/v1', generatedAt: '2026-01-02T00:00:00.000Z',
      attempts: [
        { entryId: 'turn-known', kind: 'worker_turn', taskId: 'worker-1', runId: 'lead-1', assignmentId: 'lead-1:r2:a0', role: 'engineer', elapsedMs: 1200, tokens: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
        { entryId: 'turn-unknown', kind: 'worker_turn', taskId: 'worker-2', runId: 'lead-1', assignmentId: 'lead-1:r2:a1', role: 'reviewer', elapsedMs: null, tokens: null },
      ],
    },
  };
  const { elements, requests } = await renderPage({ snapshot: null, usage, session: { turns: [{
    leadTask: { id: 'lead-1', state: 'TASK_STATE_COMPLETED', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:03Z' },
    workers: [
      { task_id: 'worker-1', assignment_id: 'lead-1:r2:a0', role: 'engineer', state: 'TASK_STATE_COMPLETED', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:02Z' },
      { task_id: 'worker-2', assignment_id: 'lead-1:r2:a1', role: 'reviewer', state: 'TASK_STATE_FAILED', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:01Z' },
    ],
  }] } });
  assert.match(elements.get('taskTokenCoverage').textContent, /Showing top 1 of 1 known task token totals; 2 unknown/);
  assert.match(elements.get('taskRows').innerHTML, />10</);
  assert.match(elements.get('taskRows').innerHTML, />Unknown/);
  assert.match(elements.get('timeDetail').textContent, /1 measured, 2 lifecycle spans, 0 unknown \/ 3 tasks/);
  assert.match(elements.get('taskRows').innerHTML, />3 s</);
  assert.match(elements.get('taskRows').innerHTML, />1 s/);
  assert.match(elements.get('taskRows').innerHTML, />Completed</);
  assert.match(elements.get('taskRows').innerHTML, />Failed</);
  assert.match(elements.get('taskRows').innerHTML, /dispatch-created to journal-updated lifecycle span, not model latency/);
  assert.match(elements.get('taskRows').innerHTML, /recorded execution time, including tools and startup when present/);
  assert.match(elements.get('taskTimeCoverage').textContent, /Showing top 3 of 3 known task durations; 1 measured; 2 lifecycle spans/);
  assert.match(elements.get('taskTimeCoverage').textContent, /Lifecycle spans are not model latency/);
  assert.match(elements.get('tableNote').textContent, /1 measured execution duration/);
  assert.match(elements.get('tableNote').textContent, /2 dispatch-created to journal-updated lifecycle spans, not model latency/);
  assert.equal(requests.filter((url) => url === '/api/projects/aaaaaaaaaa/sessions/session-1/usage?details=performance').length, 1);
});

test('time summaries identify all measured execution durations', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', generatedAt: '2026-01-02T00:00:00.000Z',
    total: {},
    tasks: [
      { taskId: 'worker-1', role: 'engineer', elapsedMs: 100, totalTokens: null },
      { taskId: 'worker-2', role: 'reviewer', elapsedMs: 200, totalTokens: null },
    ],
  };
  const { elements } = await renderPage({ snapshot, usage: { total: {}, unknownCount: 0 } });
  assert.match(elements.get('timeDetail').textContent, /2 measured, 0 lifecycle spans, 0 unknown \/ 2 tasks/);
  assert.match(elements.get('taskTimeCoverage').textContent, /2 measured; 0 lifecycle spans/);
  assert.match(elements.get('tableNote').textContent, /2 measured execution durations/);
  assert.doesNotMatch(elements.get('tableNote').textContent, /lifecycle spans/);
});

test('time summaries identify all lifecycle spans and explicitly exclude model latency', async () => {
  const session = { turns: [{
    leadTask: { id: 'lead-1', state: 'TASK_STATE_COMPLETED', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:03Z' },
    workers: [{ task_id: 'worker-1', assignment_id: 'lead-1:r1:a0', role: 'engineer', state: 'TASK_STATE_COMPLETED', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:02Z' }],
  }] };
  const { elements } = await renderPage({ snapshot: null, usage: { total: {}, unknownCount: 0 }, session });
  assert.match(elements.get('timeDetail').textContent, /0 measured, 2 lifecycle spans, 0 unknown \/ 2 tasks/);
  assert.match(elements.get('taskTimeCoverage').textContent, /2 lifecycle spans/);
  assert.match(elements.get('taskTimeCoverage').textContent, /not model latency/);
  assert.match(elements.get('tableNote').textContent, /2 dispatch-created to journal-updated lifecycle spans, not model latency/);
});

test('time summaries retain unknown durations alongside measured durations', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', total: {},
    tasks: [
      { taskId: 'worker-1', role: 'engineer', elapsedMs: 100, totalTokens: null },
      { taskId: 'worker-2', role: 'reviewer', elapsedMs: null, unknownTimeRows: 1, totalTokens: null },
    ],
  };
  const { elements } = await renderPage({ snapshot, usage: { total: {}, unknownCount: 0 } });
  assert.match(elements.get('timeDetail').textContent, /1 measured, 0 lifecycle spans, 1 unknown \/ 2 tasks/);
  assert.match(elements.get('taskTimeCoverage').textContent, /1 measured; 0 lifecycle spans; 1 unknown/);
  assert.match(elements.get('tableNote').textContent, /1 task duration unknown/);
});

test('incomplete live token rows do not downgrade a known snapshot group', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1',
    total: { inputTokens: 10, cachedInputTokens: null, outputTokens: 2, totalTokens: 12, attempts: 1 },
    tasks: [{ taskId: 'worker-1', assignmentId: 'lead-1:r1:a0', role: 'engineer', totalTokens: 12, inputTokens: 10, outputTokens: 2, elapsedMs: 50, unknownTokenRows: 0 }],
  };
  const usage = {
    total: { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, attempts: 1 },
    unknownCount: 1,
    performance: {
      schema: 'session-performance/v1',
      attempts: [{ entryId: 'turn-unknown', kind: 'worker_turn', taskId: 'worker-1', runId: 'lead-1', assignmentId: 'lead-1:r1:a0', role: 'engineer', tokens: null }],
    },
  };
  const { elements } = await renderPage({ snapshot, usage });
  assert.equal(elements.get('tokenTotal').textContent, '12');
  assert.match(elements.get('taskTokenCoverage').textContent, /Showing top 1 of 1 known task token totals\./);
  assert.doesNotMatch(elements.get('taskTokenCoverage').textContent, /partial/);
  assert.match(elements.get('taskRows').innerHTML, />12</);
  assert.match(elements.get('taskRows').innerHTML, />50 ms</);
});

test('a one-attempt live subset cannot replace a two-attempt persisted token and time aggregate', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', total: { inputTokens: 10, outputTokens: 2, totalTokens: 12, attempts: 2 },
    tasks: [{ taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', totalTokens: 12, inputTokens: 10, outputTokens: 2, attempts: 2, unknownTokenRows: 0, elapsedMs: 100 }],
  };
  const usage = {
    total: { inputTokens: 3, outputTokens: 1, totalTokens: 4, attempts: 1 },
    performance: { schema: 'session-performance/v1', attempts: [
      { kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', tokens: { totalTokens: 4, inputTokens: 3, outputTokens: 1 }, elapsedMs: 40 },
    ] },
  };
  const { elements } = await renderPage({ snapshot, usage });
  assert.equal(elements.get('tokenTotal').textContent, '12');
  assert.match(elements.get('taskRows').innerHTML, />12</);
  assert.match(elements.get('taskRows').innerHTML, /Input 10, cached input Unknown, output 2/);
  assert.match(elements.get('taskRows').innerHTML, />100 ms</);
  assert.equal(elements.get('timeTotal').textContent, '100 ms');
  assert.match(elements.get('tokenDetail').textContent, /2 attempts/);
  assert.doesNotMatch(elements.get('tokenDetail').textContent, /1 attempts/);
});

test('complete attributable live coverage can refresh a known session aggregate', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', total: { totalTokens: 12, attempts: 1 },
    tasks: [{ taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', entryIds: ['attempt-1'], totalTokens: 12, attempts: 1 }],
  };
  const usage = {
    total: { totalTokens: 4, attempts: 1 },
    performance: { schema: 'session-performance/v1', attempts: [
      { entryId: 'attempt-1', kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', tokens: { totalTokens: 4 } },
    ] },
  };
  const { elements } = await renderPage({ snapshot, usage });
  assert.equal(elements.get('tokenTotal').textContent, '4');
  assert.match(elements.get('tokenDetail').textContent, /1 attempts/);
});

test('partial live token components do not mix with a known persisted token aggregate', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', total: { totalTokens: 12, attempts: 2 },
    tasks: [{ taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', totalTokens: 12, inputTokens: 10, cachedInputTokens: 2, outputTokens: 2, attempts: 2, elapsedMs: 100 }],
  };
  const usage = {
    total: { totalTokens: null, attempts: 1 },
    performance: { schema: 'session-performance/v1', attempts: [
      { entryId: 'partial-attempt', kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', tokens: { inputTokens: 3 }, elapsedMs: 40 },
    ] },
  };
  const { elements } = await renderPage({ snapshot, usage });
  assert.equal(elements.get('tokenTotal').textContent, '12');
  assert.match(elements.get('taskRows').innerHTML, /Input 10, cached input 2, output 2/);
  assert.match(elements.get('taskRows').innerHTML, />100 ms</);
});

test('live values enrich an unknown snapshot group and expose missing attempt coverage', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', total: { totalTokens: null },
    tasks: [{ taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', attempts: 2, totalTokens: null, inputTokens: null, outputTokens: null, elapsedMs: null }],
  };
  const usage = {
    total: { totalTokens: 4, attempts: 1 },
    performance: { schema: 'session-performance/v1', attempts: [
      { entryId: 'one-of-two', kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', tokens: { totalTokens: 4 }, elapsedMs: 30 },
    ] },
  };
  const { elements } = await renderPage({ snapshot, usage });
  assert.match(elements.get('tokenTotal').textContent, /^4\+/);
  assert.match(elements.get('tokenDetail').textContent, /1 attempts/);
  assert.match(elements.get('taskRows').innerHTML, />4\+/);
  assert.match(elements.get('taskRows').innerHTML, />30 ms\+</);
  assert.match(elements.get('taskTokenCoverage').textContent, /1 partial/);
  assert.match(elements.get('taskTimeCoverage').textContent, /1 partial/);
});

test('live retries aggregate by assignment without merging distinct assignments for one task', async () => {
  const snapshot = {
    schema: 'task-metrics/v1', contextId: 'session-1', total: { totalTokens: null },
    tasks: [
      { taskId: 'worker-1', assignmentId: 'lead-1:r2:a0', role: 'engineer', totalTokens: null },
      { taskId: 'worker-1', assignmentId: 'lead-1:r3:a0', role: 'engineer', totalTokens: null },
    ],
  };
  const usage = {
    total: { totalTokens: 35 }, unknownCount: 0,
    performance: { schema: 'session-performance/v1', attempts: [
      { entryId: 'retry-1', kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead-1:r2:a0', role: 'engineer', tokens: { totalTokens: 10 } },
      { entryId: 'retry-2', kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead-1:r2:a0', role: 'engineer', tokens: { totalTokens: 5 } },
      { entryId: 'retry-3', kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead-1:r3:a0', role: 'engineer', tokens: { totalTokens: 20 } },
    ] },
  };
  const { elements } = await renderPage({ snapshot, usage });
  assert.match(elements.get('tokenTotal').textContent, /^35/);
  assert.match(elements.get('taskTokenCoverage').textContent, /Showing top 2 of 2 known task token totals/);
  assert.match(elements.get('taskRows').innerHTML, />15</);
  assert.match(elements.get('taskRows').innerHTML, />20</);
});
