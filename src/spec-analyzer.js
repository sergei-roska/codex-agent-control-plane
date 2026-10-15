'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const {
  MAX_CONTEXT_BYTES,
  MAX_MAP_BYTES,
  MAX_SOURCE_BYTES,
  inspectWorkspacePath,
  isSafeRelativePath,
  splitSourceLines,
  validateContext,
  validateTraceability,
} = require('./spec-context');
const { adaptAssignments } = require('./spec-assignment-adapter');

const MAX_FINDINGS = 1000;
const MAX_TOTAL_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_FILES = 32;
const TASK_ROW_RE = /^\s*-\s+\[([ xX])\]\s+(T[0-9]{3,6})(?:\s|$)(.*)$/;
const MARKER_RE = /^\s*<!--\s*harness-task-map:v1\s+(begin|end)\s*-->\s*$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PINNED_PROJECT_FILES = [
  'schemas/spec-context-v1.schema.json',
  'schemas/spec-traceability-v1.schema.json',
  'src/spec-context.js',
  'src/spec-analyzer.js',
  'src/spec-assignment-adapter.js',
  'src/contracts.js',
  'src/role-catalog.js',
  'src/role-names.js',
  'src/staging-log.js',
  'tools/spec-kit/analyze.js',
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finding(code, message, { path: fieldPath = '$', taskIds = [] } = {}) {
  return { code, path: fieldPath, message, taskIds: [...new Set(taskIds)].sort(compareText) };
}

function sortFindings(findings) {
  findings.sort((left, right) => compareText(left.code, right.code)
    || compareText(left.taskIds.join(','), right.taskIds.join(','))
    || compareText(left.path, right.path)
    || compareText(left.message, right.message));
  return findings;
}

function boundedFindings() {
  const findings = [];
  let overflow = 0;
  return {
    add(item) {
      if (findings.length < MAX_FINDINGS - 1) findings.push(item);
      else overflow += 1;
    },
    finish() {
      if (overflow > 0) findings.push(finding(
        'finding_limit_exceeded',
        `Analysis finding limit reached; at least ${overflow} additional finding(s) were not expanded.`,
      ));
      return sortFindings(findings);
    },
  };
}

function mapErrorTaskIds(error, tasks) {
  const named = typeof error.path === 'string' && error.path.match(/^\$\.tasks\.([A-Za-z0-9_-]+)/);
  if (named) return [named[1]];
  const indexed = typeof error.path === 'string' && error.path.match(/^\$\.tasks\[(\d+)\]/);
  if (indexed && Array.isArray(tasks)) {
    const task = tasks[Number(indexed[1])];
    if (task && typeof task.id === 'string') return [task.id];
  }
  return [];
}

function addValidationFindings(target, validation, map) {
  const tasks = map && map.tasks;
  for (const error of validation.errors || []) {
    target.add(finding(error.code || 'map_invalid', error.message || 'Map validation failed.', {
      path: error.path || '$',
      taskIds: mapErrorTaskIds(error, tasks),
    }));
  }
  if ((validation.errors || []).length >= 200) {
    target.add(finding('validation_finding_limit_reached', 'Context/map validation reached its 200 finding limit; analysis is incomplete.'));
  }
}

function readTasksArtifact(workspaceRoot, bindings) {
  if (!Array.isArray(bindings)) return { error: 'tasks_binding_missing' };
  const candidates = bindings.filter((binding) => binding && binding.role === 'tasks');
  if (candidates.length !== 1) return { error: 'tasks_binding_missing' };
  const binding = candidates[0];
  if (!isSafeRelativePath(binding.path)) return { error: 'tasks_path_unsafe' };
  try {
    const resolved = inspectWorkspacePath(workspaceRoot, binding.path, { mustExist: true, expectedType: 'file' });
    const stat = fs.statSync(resolved.realPath);
    if (stat.size > MAX_SOURCE_BYTES) return { error: 'tasks_size_limit' };
    const bytes = fs.readFileSync(resolved.realPath);
    if (bytes.length > MAX_SOURCE_BYTES) return { error: 'tasks_size_limit' };
    if (typeof binding.sha256 !== 'string' || sha256(bytes) !== binding.sha256) return { error: 'tasks_digest_mismatch' };
    let text;
    try { text = UTF8.decode(bytes); } catch (_) { return { error: 'tasks_utf8_invalid' }; }
    return { text, path: binding.path };
  } catch (error) {
    return { error: error && error.message ? error.message : 'tasks_read_failed' };
  }
}

function fenceOpening(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return { malformed: true };
  return { character: match[1][0], length: match[1].length };
}

function isFenceClosing(line, fence) {
  const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
  return Boolean(match && match[1][0] === fence.character && match[1].length >= fence.length);
}

function scanTasksMarkdown(text) {
  const findings = [];
  let lines;
  try { lines = splitSourceLines(text); } catch (error) {
    return { findings: [finding(error.message || 'tasks_newline_invalid', 'Task artifact contains unsupported newlines.')], rows: [], markers: [] };
  }
  const rows = [];
  const markers = [];
  let fence = null;
  let inComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (isFenceClosing(line, fence)) fence = null;
      continue;
    }
    if (!inComment) {
      const openedFence = fenceOpening(line);
      if (openedFence && openedFence.malformed) {
        findings.push(finding('projection_fence_malformed', `Malformed fenced code opener at line ${index + 1}.`, { path: `tasks.md:${index + 1}` }));
        continue;
      }
      if (openedFence) {
        fence = openedFence;
        continue;
      }
      const marker = line.match(MARKER_RE);
      if (marker) {
        markers.push({ kind: marker[1], line: index + 1, index });
        continue;
      }
    }

    let visible = '';
    let cursor = 0;
    while (cursor < line.length) {
      if (inComment) {
        const close = line.indexOf('-->', cursor);
        const nested = line.indexOf('<!--', cursor);
        if (nested !== -1 && (close === -1 || nested < close)) {
          findings.push(finding('projection_comment_nested', `Nested HTML comment at line ${index + 1}.`, { path: `tasks.md:${index + 1}` }));
          cursor = nested + 4;
          continue;
        }
        if (close === -1) {
          cursor = line.length;
          break;
        }
        inComment = false;
        cursor = close + 3;
        continue;
      }
      const open = line.indexOf('<!--', cursor);
      if (open === -1) {
        visible += line.slice(cursor);
        cursor = line.length;
        break;
      }
      visible += line.slice(cursor, open);
      const close = line.indexOf('-->', open + 4);
      const nested = line.indexOf('<!--', open + 4);
      if (nested !== -1 && (close === -1 || nested < close)) {
        findings.push(finding('projection_comment_nested', `Nested HTML comment at line ${index + 1}.`, { path: `tasks.md:${index + 1}` }));
        inComment = true;
        cursor = nested + 4;
        continue;
      }
      const commentText = line.slice(open, close === -1 ? line.length : close + 3);
      if (/^<!--[ \t]*harness-task-map:v1(?:[ \t]|$)/.test(commentText)) {
        findings.push(finding('projection_marker_malformed', `Malformed task-map marker at line ${index + 1}.`, { path: `tasks.md:${index + 1}` }));
      }
      if (close === -1) {
        inComment = true;
        cursor = line.length;
        break;
      }
      cursor = close + 3;
    }
    if (visible.includes('harness-task-map:v1')) {
      findings.push(finding('projection_marker_malformed', `Malformed task-map marker at line ${index + 1}.`, { path: `tasks.md:${index + 1}` }));
    }
    const row = visible.match(TASK_ROW_RE);
    if (row) rows.push({ line: index + 1, index, checked: row[1].toLowerCase() === 'x', id: row[2], text: row[3], parallel: /(?:^|\s)\[P\](?:\s|$)/.test(row[3]) });
  }
  if (fence) findings.push(finding('projection_fence_unclosed', 'Unclosed fenced code block in tasks.md.', { path: 'tasks.md' }));
  if (inComment) findings.push(finding('projection_comment_unclosed', 'Unclosed HTML comment in tasks.md.', { path: 'tasks.md' }));
  return { findings, rows, markers };
}

function analyzeProjection(text, map) {
  const scan = scanTasksMarkdown(text);
  const findings = [...scan.findings];
  const starts = scan.markers.filter((marker) => marker.kind === 'begin');
  const ends = scan.markers.filter((marker) => marker.kind === 'end');
  if (starts.length !== 1 || ends.length !== 1 || (starts[0] && ends[0] && starts[0].index >= ends[0].index)) {
    findings.push(finding('projection_markers_invalid', 'tasks.md must contain exactly one ordered, nonnested task-map marker pair.', { path: 'tasks.md' }));
  }
  const hasBlock = starts.length === 1 && ends.length === 1 && starts[0].index < ends[0].index;
  const blockRows = hasBlock ? scan.rows.filter((row) => row.index > starts[0].index && row.index < ends[0].index) : [];
  const outsideRows = scan.rows.filter((row) => !hasBlock || row.index < starts[0].index || row.index > ends[0].index);
  for (const row of outsideRows) findings.push(finding('projection_task_outside_block', `Checklist task ${row.id} appears outside the marked block at line ${row.line}.`, { path: `tasks.md:${row.line}`, taskIds: [row.id] }));

  const mapTasks = Array.isArray(map && map.tasks) ? map.tasks : [];
  const byId = new Map();
  for (const task of mapTasks) if (task && typeof task.id === 'string') {
    if (byId.has(task.id)) findings.push(finding('projection_map_task_duplicate', `Map task ${task.id} is duplicated.`, { path: '$.tasks', taskIds: [task.id] }));
    byId.set(task.id, task);
  }
  const rowIds = new Set();
  const taskStates = [];
  for (const row of blockRows) {
    if (rowIds.has(row.id)) findings.push(finding('projection_task_duplicate', `Task ${row.id} appears more than once in the marked block.`, { path: `tasks.md:${row.line}`, taskIds: [row.id] }));
    rowIds.add(row.id);
    if (row.text.trim().length === 0) findings.push(finding('projection_task_text_empty', `Task ${row.id} has no human-readable checklist text.`, { path: `tasks.md:${row.line}`, taskIds: [row.id] }));
    const task = byId.get(row.id);
    if (!task) findings.push(finding('projection_task_unknown', `Task ${row.id} in the marked block has no map entry.`, { path: `tasks.md:${row.line}`, taskIds: [row.id] }));
    else if (typeof task.parallel === 'boolean' && row.parallel !== task.parallel) findings.push(finding('projection_parallel_mismatch', `Task ${row.id} [P] annotation does not match its parallel field.`, { path: `tasks.md:${row.line}`, taskIds: [row.id] }));
    taskStates.push({ id: row.id, checked: row.checked, parallel: row.parallel, line: row.line });
  }
  for (const task of mapTasks) if (task && typeof task.id === 'string' && !rowIds.has(task.id)) {
    findings.push(finding('projection_task_missing', `Map task ${task.id} is missing from the marked block.`, { path: '$.tasks', taskIds: [task.id] }));
  }
  taskStates.sort((left, right) => compareText(left.id, right.id) || left.line - right.line);
  return { ok: findings.length === 0, findings: sortFindings(findings), taskStates, taskIds: [...rowIds].sort(compareText) };
}

function validGraphTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 100) return false;
  const ids = new Set();
  for (const task of tasks) {
    if (!isPlainObject(task) || typeof task.id !== 'string' || !/^T[0-9]{3,6}$/.test(task.id) || ids.has(task.id) || !Array.isArray(task.dependsOn)) return false;
    ids.add(task.id);
  }
  return tasks.every((task) => task.dependsOn.every((id) => typeof id === 'string' && ids.has(id)));
}

function stronglyConnected(ids, dependencies) {
  let nextIndex = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  function visit(id) {
    index.set(id, nextIndex);
    low.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const dependency of [...dependencies.get(id)].sort(compareText)) {
      if (!index.has(dependency)) {
        visit(dependency);
        low.set(id, Math.min(low.get(id), low.get(dependency)));
      } else if (onStack.has(dependency)) low.set(id, Math.min(low.get(id), index.get(dependency)));
    }
    if (low.get(id) === index.get(id)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component.sort(compareText));
    }
  }
  for (const id of ids) if (!index.has(id)) visit(id);
  return components;
}

function cycleWitness(component, dependencies) {
  const allowed = new Set(component);
  const state = new Map();
  const stack = [];
  let witness = null;
  function visit(id) {
    state.set(id, 1);
    stack.push(id);
    for (const dependency of [...dependencies.get(id)].filter((item) => allowed.has(item)).sort(compareText)) {
      if (state.get(dependency) === 1) {
        const start = stack.lastIndexOf(dependency);
        witness = [...stack.slice(start), dependency];
        return true;
      }
      if (!state.has(dependency) && visit(dependency)) return true;
    }
    stack.pop();
    state.set(id, 2);
    return false;
  }
  for (const id of component) if (!state.has(id) && visit(id)) break;
  return witness || [];
}

function topologicalOrder(ids, dependencies) {
  const indegree = new Map(ids.map((id) => [id, dependencies.get(id).size]));
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) for (const dependency of dependencies.get(id)) dependents.get(dependency).push(id);
  for (const values of dependents.values()) values.sort(compareText);
  const ready = ids.filter((id) => indegree.get(id) === 0).sort(compareText);
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort(compareText);
      }
    }
  }
  return order.length === ids.length ? order : null;
}

function pathsOverlap(left, right) {
  if (!left || !right || typeof left.path !== 'string' || typeof right.path !== 'string') return false;
  if (left.path === right.path) return true;
  if (left.kind === 'directory' && right.path.startsWith(`${left.path}/`)) return true;
  if (right.kind === 'directory' && left.path.startsWith(`${right.path}/`)) return true;
  return false;
}

function analyzeGraph(tasks) {
  const findings = [];
  if (!validGraphTasks(tasks)) return { ok: false, findings: [finding('graph_skipped_invalid_references', 'Graph analysis requires unique task IDs and fully resolved dependency IDs.')], taskOrder: null, cycles: [], parallelConflicts: [] };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ids = [...byId.keys()].sort(compareText);
  const dependencies = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const components = stronglyConnected(ids, dependencies)
    .filter((component) => component.length > 1 || dependencies.get(component[0]).has(component[0]))
    .sort((left, right) => compareText(left[0], right[0]));
  const cycles = components.map((component) => ({ taskIds: component, witness: cycleWitness(component, dependencies) }));
  for (const cycle of cycles) findings.push(finding('dependency_cycle', `Dependency cycle: ${cycle.witness.join(' -> ')}.`, { path: '$.tasks.dependsOn', taskIds: cycle.taskIds }));
  const taskOrder = cycles.length === 0 ? topologicalOrder(ids, dependencies) : null;

  function reachable(from, target) {
    const pending = [...dependencies.get(from)];
    const seen = new Set();
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...dependencies.get(id));
    }
    return false;
  }
  const parallel = tasks.filter((task) => task.parallel === true).sort((a, b) => compareText(a.id, b.id));
  const parallelConflicts = [];
  for (let leftIndex = 0; leftIndex < parallel.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < parallel.length; rightIndex += 1) {
    const left = parallel[leftIndex];
    const right = parallel[rightIndex];
    if (reachable(left.id, right.id) || reachable(right.id, left.id)) {
      const item = { code: 'parallel_dependency_conflict', taskIds: [left.id, right.id] };
      parallelConflicts.push(item);
      findings.push(finding(item.code, 'Parallel tasks have a direct or transitive dependency.', { path: '$.tasks.dependsOn', taskIds: item.taskIds }));
    }
    const overlap = (Array.isArray(left.writePaths) ? left.writePaths : []).some((leftPath) => (Array.isArray(right.writePaths) ? right.writePaths : []).some((rightPath) => pathsOverlap(leftPath, rightPath)));
    if (overlap) {
      const item = { code: 'parallel_write_conflict', taskIds: [left.id, right.id] };
      parallelConflicts.push(item);
      findings.push(finding(item.code, 'Parallel tasks have overlapping file or directory write scopes.', { path: '$.tasks.writePaths', taskIds: item.taskIds }));
    }
  }
  return { ok: findings.length === 0, findings: sortFindings(findings), taskOrder, cycles, parallelConflicts };
}

function analyzeTaskMap({ workspaceRoot, contextResult, expectedContextSha256, map } = {}) {
  const all = boundedFindings();
  let validation;
  try {
    validation = validateTraceability(map, { workspaceRoot, contextResult, expectedContextSha256 });
  } catch (error) {
    all.add(finding('analysis_validation_exception', `Map validation failed safely: ${String(error && error.message || error).slice(0, 300)}`));
    return { ok: false, findings: all.finish(), mapValidation: { ok: false, errors: [] }, graph: null, projection: null, assignmentValidation: 'pending' };
  }
  addValidationFindings(all, validation, map);

  let projection = null;
  if (isPlainObject(map)) {
    const artifact = readTasksArtifact(workspaceRoot, map.artifactBindings);
    if (artifact.error) all.add(finding(artifact.error, 'Cannot verify the bound tasks.md projection.', { path: '$.artifactBindings' }));
    else {
      projection = analyzeProjection(artifact.text, map);
      for (const item of projection.findings) all.add(item);
    }
  } else all.add(finding('map_object_required', 'Map must be a plain object.', { path: '$' }));

  let graph = null;
  if (isPlainObject(map) && Array.isArray(map.tasks)) {
    graph = analyzeGraph(map.tasks);
    for (const item of graph.findings || []) all.add(item);
  }
  const findings = all.finish();
  return {
    ok: validation.ok && Boolean(graph && graph.ok) && Boolean(projection && projection.ok) && findings.length === 0,
    findings,
    mapValidation: { ok: validation.ok, errors: validation.errors },
    graph,
    projection,
    assignmentValidation: 'pending',
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort(compareText)) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function stableJSON(value) {
  return JSON.stringify(stableValue(value));
}

function blockedReport(code, message, report = null) {
  const base = report || {
    schemaVersion: 'spec-analysis/v1',
    featureId: null,
    analysisFingerprint: null,
    inputManifest: null,
    assumptions: offlineAssumptions(),
    findings: [],
    coverage: { requirements: [], acceptanceCriteria: [] },
    dependencyOrder: null,
    assignmentValidation: [],
    reviewPlan: [],
    passes: { snapshot: 'blocked', context: 'not_run', traceability: 'not_run', graph: 'not_run', projection: 'not_run', assignments: 'not_run', drift: 'not_run' },
    implementationAcceptance: 'not_evaluated',
  };
  base.findings.push({ code, severity: 'error', path: '$', taskIds: [], requirementIds: [], expected: null, actual: message });
  base.findings.sort((left, right) => compareText(left.code, right.code) || compareText(left.path, right.path));
  base.verdict = 'blocked';
  return base;
}

function offlineAssumptions() {
  return {
    mode: 'offline',
    openDecisions: 0,
    unresolvedWriters: 0,
    incompleteCriticalCheckpoints: 0,
    continuations: 0,
    attemptedRoles: [],
    selectedSkills: [],
    semanticInventoryCompleteness: 'established by accepted-context review; checker proves coverage only',
    taskAndSourceSemanticAgreement: 'not machine-proved; requires lead review',
    liveRunStateValidationRequiredBeforeDispatch: true,
    typedScopePolicyIsNotRuntimePrefixEnforcement: true,
    plannedChecksExecuted: false,
    implementationAcceptance: 'not_evaluated',
  };
}

function fileDigest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readLimited(realPath, maxBytes, totalRemaining) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(realPath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('input_not_regular_file');
    if (stat.size > maxBytes) throw new Error('input_file_size_limit');
    if (stat.size > totalRemaining) throw new Error('snapshot_total_size_limit');
    const chunks = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (true) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error('input_file_size_limit');
      if (total > totalRemaining) throw new Error('snapshot_total_size_limit');
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

function safeRead(root, relativePath, maxBytes, budget) {
  if (!isSafeRelativePath(relativePath)) throw new Error('path_unsafe');
  const resolved = inspectWorkspacePath(root, relativePath, { mustExist: true, expectedType: 'file', rejectSymlinks: true });
  const bytes = readLimited(resolved.realPath, maxBytes, MAX_TOTAL_SNAPSHOT_BYTES - budget.used);
  budget.used += bytes.length;
  return { bytes, sha256: fileDigest(bytes), size: bytes.length, path: relativePath };
}

function parseSnapshotJSON(item, label) {
  let text;
  try { text = UTF8.decode(item.bytes); } catch (_) { throw new Error(`${label}_utf8_invalid`); }
  try { return JSON.parse(text); } catch (_) { throw new Error(`${label}_json_invalid`); }
}

function normalizeFinding(item, privateRoots = []) {
  const taskIds = Array.isArray(item.taskIds) ? item.taskIds.filter((id) => typeof id === 'string') : [];
  const taskId = typeof item.taskId === 'string' ? [item.taskId] : [];
  const requirementMatch = typeof item.path === 'string' && item.path.match(/\$\.requirements\.([A-Za-z0-9_-]+)/);
  let findingPath = typeof item.path === 'string' ? item.path : '$';
  let actual = typeof item.message === 'string' ? item.message : typeof item.actual === 'string' ? item.actual : null;
  for (const root of privateRoots) if (root) findingPath = findingPath.split(root).join('<root>');
  if (actual) {
    for (const root of privateRoots) if (root) actual = actual.split(root).join('<root>');
    actual = actual.slice(0, 500);
  }
  const expectedByCode = {
    context_digest_mismatch: 'context bytes match the caller-supplied accepted digest',
    source_digest_mismatch: 'source bytes match the accepted source digest',
    artifact_digest_mismatch: 'derived artifact bytes match the map binding digest',
    map_context_digest_mismatch: 'map binds the caller-supplied accepted context digest',
    write_scope_denied: 'every write path is within accepted allow scope and outside deny scope',
    assignment_contract_invalid: 'both exported contract validators accept every proposal',
  };
  return {
    code: typeof item.code === 'string' ? item.code : 'analysis_invalid',
    severity: 'error',
    path: findingPath,
    taskIds: [...new Set([...taskIds, ...taskId])].sort(compareText),
    requirementIds: requirementMatch ? [requirementMatch[1]] : [],
    expected: expectedByCode[item.code] || null,
    actual: actual || (item.taskId ? 'Task proposal failed compilation or offline contract validation.' : null),
  };
}

function artifactMap(context, map) {
  const bindings = Array.isArray(map && map.artifactBindings) ? map.artifactBindings : [];
  const sources = Array.isArray(context && context.sources) ? context.sources : [];
  return { bindings, sources };
}

function analyzeWorkspace({ workspaceRoot, contextPath, contextSha256, mapPath, profilesDir } = {}) {
  const budget = { used: 0 };
  const workspaceFiles = new Map();
  const observed = [];
  let snapshotRoot;
  let acceptedContext;
  let map;
  let contextFile;
  let mapFile;
  let contextResult;
  let traceability;
  let graph;
  let projection;
  let adapterResult;
  let profileRecords = [];
  let profileRoot;
  let expectedProfilePaths = [];
  let manifest;
  try {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw new Error('workspace_root_invalid');
    snapshotRoot = fs.realpathSync(workspaceRoot);
    if (!fs.statSync(snapshotRoot).isDirectory()) throw new Error('workspace_root_invalid');
    if (typeof contextSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(contextSha256)) throw new Error('context_digest_invalid');
    if (!isSafeRelativePath(contextPath) || !isSafeRelativePath(mapPath)) throw new Error('input_path_unsafe');
    if (typeof profilesDir !== 'string' || !path.isAbsolute(profilesDir)) throw new Error('profiles_path_invalid');
    profileRoot = fs.realpathSync(profilesDir);
    if (!fs.statSync(profileRoot).isDirectory()) throw new Error('profiles_path_invalid');

    const readWorkspace = (relativePath, maxBytes) => {
      if (workspaceFiles.has(relativePath)) return workspaceFiles.get(relativePath);
      const item = safeRead(snapshotRoot, relativePath, maxBytes, budget);
      workspaceFiles.set(relativePath, item);
      observed.push({ root: snapshotRoot, relativePath, sha256: item.sha256, maxBytes });
      return item;
    };

    contextFile = readWorkspace(contextPath, MAX_CONTEXT_BYTES);
    mapFile = readWorkspace(mapPath, MAX_MAP_BYTES);
    if (contextFile.sha256 !== contextSha256) throw new Error('context_digest_mismatch');
    acceptedContext = parseSnapshotJSON(contextFile, 'context');
    map = parseSnapshotJSON(mapFile, 'map');
    if (!acceptedContext || typeof acceptedContext !== 'object' || Array.isArray(acceptedContext)) throw new Error('context_object_required');
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('map_object_required');
    if (!Array.isArray(acceptedContext.sources) || acceptedContext.sources.length < 1 || acceptedContext.sources.length > MAX_SOURCE_FILES) throw new Error('source_count_limit');
    if (!Array.isArray(acceptedContext.requirements) || acceptedContext.requirements.length > 100) throw new Error('requirement_count_limit');
    if (!Array.isArray(acceptedContext.acceptanceCriteria) || acceptedContext.acceptanceCriteria.length > 200) throw new Error('acceptance_count_limit');
    if (!Array.isArray(acceptedContext.riskRules) || acceptedContext.riskRules.length > 200) throw new Error('risk_rule_count_limit');
    if (!Array.isArray(acceptedContext.checks) || acceptedContext.checks.length > 100) throw new Error('check_count_limit');
    if (!Array.isArray(acceptedContext.priorEvidence) || acceptedContext.priorEvidence.length > 200) throw new Error('evidence_count_limit');
    if (!Array.isArray(acceptedContext.decisions) || acceptedContext.decisions.length > 200) throw new Error('decision_count_limit');
    if (!Array.isArray(map.tasks) || map.tasks.length < 1 || map.tasks.length > 100) throw new Error('task_count_limit');
    if (!Array.isArray(map.artifactBindings) || map.artifactBindings.length !== 3) throw new Error('artifact_bindings_invalid');

    const inputs = artifactMap(acceptedContext, map);
    for (const item of inputs.sources) {
      if (!item || typeof item.path !== 'string' || !isSafeRelativePath(item.path)) continue;
      readWorkspace(item.path, MAX_SOURCE_BYTES);
    }
    for (const item of inputs.bindings) {
      if (!item || typeof item.path !== 'string' || !isSafeRelativePath(item.path)) continue;
      readWorkspace(item.path, MAX_SOURCE_BYTES);
    }

    const parsedSources = {};
    for (const source of inputs.sources) {
      if (!source || typeof source.id !== 'string' || typeof source.path !== 'string' || !workspaceFiles.has(source.path)) continue;
      const item = workspaceFiles.get(source.path);
      const text = UTF8.decode(item.bytes);
      parsedSources[source.id] = {
        id: source.id,
        path: source.path,
        sha256: item.sha256,
        bytes: item.bytes,
        text,
        lines: splitSourceLines(text),
      };
      if (source.sha256 !== item.sha256) throw new Error('source_digest_mismatch');
    }
    const contextValidation = validateContext(acceptedContext, { workspaceRoot: snapshotRoot });
    for (const entry of contextValidation.errors || []) {
      if (entry.code === 'source_digest_mismatch') throw new Error('source_digest_mismatch');
    }
    contextResult = { ...contextValidation, contextSha256: contextFile.sha256, sources: parsedSources };
    if (!contextResult.ok) throw new Error(contextResult.errors && contextResult.errors[0] && contextResult.errors[0].code || 'context_validation_failed');

    const artifactHashes = [];
    for (const binding of inputs.bindings) {
      if (!binding || !workspaceFiles.has(binding.path)) continue;
      const item = workspaceFiles.get(binding.path);
      artifactHashes.push({ role: binding.role, path: binding.path, sha256: item.sha256, size: item.size });
      if (binding.sha256 !== item.sha256) throw new Error('artifact_digest_mismatch');
    }
    traceability = validateTraceability(map, {
      workspaceRoot: snapshotRoot,
      contextResult,
      expectedContextSha256: contextSha256,
    });
    const taskBinding = inputs.bindings.filter((binding) => binding && binding.role === 'tasks');
    if (taskBinding.length !== 1 || !workspaceFiles.has(taskBinding[0].path)) throw new Error('tasks_binding_missing');
    const taskBytes = workspaceFiles.get(taskBinding[0].path).bytes;
    let taskText;
    try { taskText = UTF8.decode(taskBytes); } catch (_) { throw new Error('tasks_utf8_invalid'); }
    projection = analyzeProjection(taskText, map);
    graph = analyzeGraph(map.tasks);

    const analysisFindings = [
      ...(contextResult.errors || []).map((error) => ({ code: error.code, path: error.path, message: error.message })),
      ...(traceability.errors || []).map((error) => ({ code: error.code, path: error.path, message: error.message })),
      ...(graph.findings || []),
      ...(projection.findings || []),
    ];
    const structuralResult = {
      ok: contextResult.ok && traceability.ok && graph.ok && projection.ok && analysisFindings.length === 0,
      findings: analysisFindings,
      mapValidation: { ok: traceability.ok, errors: traceability.errors },
      graph,
      projection,
      assignmentValidation: 'pending',
    };

    const codeFiles = [];
    for (const relativePath of PINNED_PROJECT_FILES) {
      const item = safeRead(PROJECT_ROOT, relativePath, MAX_SOURCE_BYTES, budget);
      codeFiles.push({ path: relativePath, sha256: item.sha256, size: item.size });
      observed.push({ root: PROJECT_ROOT, relativePath, sha256: item.sha256, maxBytes: MAX_SOURCE_BYTES });
    }
    inspectWorkspacePath(profileRoot, 'agents', { mustExist: true, expectedType: 'directory', rejectSymlinks: true });
    const profilePaths = ['TEAM.md', ...fs.readdirSync(path.join(profileRoot, 'agents'))
      .filter((name) => name.endsWith('.toml')).sort(compareText).map((name) => `agents/${name}`)];
    expectedProfilePaths = profilePaths;
    if (profilePaths.length < 2 || profilePaths.length > 101) throw new Error('profile_count_limit');
    const profileSources = new Map();
    for (const relativePath of profilePaths) {
      const item = safeRead(profileRoot, relativePath, MAX_SOURCE_BYTES, budget);
      profileSources.set(relativePath, item);
      observed.push({ root: profileRoot, relativePath, sha256: item.sha256, maxBytes: MAX_SOURCE_BYTES });
    }
    const onSourceFile = (absolutePath, content) => {
      const relativePath = path.relative(profileRoot, absolutePath).split(path.sep).join('/');
      if (!isSafeRelativePath(relativePath)) throw new Error('profile_path_unsafe');
      const item = profileSources.get(relativePath);
      if (!item) throw new Error('profile_membership_changed');
      let decoded;
      try { decoded = UTF8.decode(item.bytes); } catch (_) { throw new Error('profile_utf8_invalid'); }
      if (decoded !== content) throw new Error('profile_bytes_changed');
    };
    adapterResult = adaptAssignments({
      workspaceRoot: snapshotRoot,
      contextResult,
      expectedContextSha256: contextSha256,
      map,
      analysisResult: structuralResult,
      profilesDir: profileRoot,
      onSourceFile,
    });
    profileRecords = [...profileSources.entries()].map(([relativePath, item]) => ({ path: `profiles/${relativePath}`, sha256: item.sha256, size: item.size })).sort((left, right) => compareText(left.path, right.path));

    const sources = inputs.sources.map((source) => {
      const item = workspaceFiles.get(source.path);
      return { id: source.id, path: source.path, sha256: item ? item.sha256 : null, size: item ? item.size : null };
    }).sort((left, right) => compareText(left.id, right.id));
    artifactHashes.sort((left, right) => compareText(left.role || '', right.role || '') || compareText(left.path, right.path));
    const checkerHashes = codeFiles.filter((item) => !item.path.startsWith('src/contracts.js')
      && !item.path.startsWith('src/role-catalog.js') && !item.path.startsWith('src/role-names.js')
      && !item.path.startsWith('src/staging-log.js')).sort((left, right) => compareText(left.path, right.path));
    const contractHashes = codeFiles.filter((item) => item.path.startsWith('src/contracts.js')
      || item.path.startsWith('src/role-catalog.js') || item.path.startsWith('src/role-names.js')
      || item.path.startsWith('src/staging-log.js')).sort((left, right) => compareText(left.path, right.path));
    manifest = {
      contractVersion: 'spec-analysis/v1',
      featureId: contextResult.context.featureId,
      checkerSourceHashes: checkerHashes,
      harnessContractHashes: contractHashes,
      roleProfileAndTeamHashes: profileRecords,
      contextSha256: contextFile.sha256,
      mapSha256: mapFile.sha256,
      contextPath,
      contextSize: contextFile.size,
      mapPath,
      mapSize: mapFile.size,
      sources,
      artifacts: artifactHashes,
      versions: { context: contextResult.context.schemaVersion, map: map.schemaVersion },
      totalSnapshotBytes: budget.used,
    };
  } catch (error) {
    return blockedReport(error && error.message ? error.message : 'snapshot_failed', 'Snapshot or validation pass could not complete.');
  }

  const fingerprint = fileDigest(Buffer.from(`spec-analysis/v1\0${stableJSON(manifest)}`, 'utf8'));
  const findings = [];
  for (const item of [...(contextResult.errors || []), ...(traceability.errors || []), ...(graph.findings || []), ...(projection.findings || []), ...(adapterResult.findings || [])]) {
    findings.push(normalizeFinding(item, [snapshotRoot, profileRoot, PROJECT_ROOT]));
  }
  for (const proposal of adapterResult.proposals || []) {
    if (!proposal.validation.ok) findings.push({
      code: 'assignment_contract_invalid', severity: 'error', path: `$.tasks.${proposal.taskId}.${proposal.kind}`,
      taskIds: [proposal.taskId], requirementIds: [], expected: 'both exported contract validators pass', actual: proposal.validation.errors.map((entry) => entry.code).join(','),
    });
  }
  let drift = false;
  try {
    inspectWorkspacePath(profileRoot, 'agents', { mustExist: true, expectedType: 'directory', rejectSymlinks: true });
    const currentProfilePaths = ['TEAM.md', ...fs.readdirSync(path.join(profileRoot, 'agents'))
      .filter((name) => name.endsWith('.toml')).sort(compareText).map((name) => `agents/${name}`)];
    if (stableJSON(currentProfilePaths) !== stableJSON(expectedProfilePaths)) drift = true;
    for (const item of observed) {
      const current = safeRead(item.root, item.relativePath, item.maxBytes, { used: 0 });
      if (current.sha256 !== item.sha256) drift = true;
    }
  } catch (_) { drift = true; }
  if (drift) findings.push({ code: 'input_drift_detected', severity: 'error', path: '$inputs', taskIds: [], requirementIds: [], expected: 'input bytes unchanged during analysis', actual: 'one or more inputs changed or became unavailable' });
  const unique = new Map();
  for (const item of findings) {
    const key = `${item.code}\0${item.path}\0${item.taskIds.join(',')}\0${item.requirementIds.join(',')}`;
    unique.set(key, item);
  }
  const stableFindings = [...unique.values()].sort((left, right) => compareText(left.code, right.code)
    || compareText(left.path, right.path) || compareText(left.taskIds.join(','), right.taskIds.join(',')));
  const requirements = contextResult.context.requirements.map((item) => ({
    id: item.id,
    mandatory: item.mandatory,
    taskIds: map.tasks.filter((task) => task && Array.isArray(task.requirementIds) && task.requirementIds.includes(item.id)).map((task) => task.id).sort(compareText),
  })).sort((left, right) => compareText(left.id, right.id));
  const acceptanceCriteria = contextResult.context.acceptanceCriteria.map((item) => ({
    id: item.id,
    mandatory: item.mandatory,
    requiredCheckIds: [...(item.checkIds || [])].sort(compareText),
    taskIds: map.tasks.filter((task) => task && Array.isArray(task.acceptanceIds) && task.acceptanceIds.includes(item.id)).map((task) => task.id).sort(compareText),
  })).sort((left, right) => compareText(left.id, right.id));
  const report = {
    schemaVersion: 'spec-analysis/v1',
    featureId: contextResult.context.featureId,
    analysisFingerprint: fingerprint,
    inputManifest: manifest,
    assumptions: offlineAssumptions(),
    findings: stableFindings,
    coverage: { requirements, acceptanceCriteria },
    dependencyOrder: graph.taskOrder,
    assignmentValidation: (adapterResult.proposals || []).map((proposal) => ({
      taskId: proposal.taskId,
      kind: proposal.kind,
      assignment: proposal.assignment,
      validation: proposal.validation,
    })),
    reviewPlan: adapterResult.reviewPlan,
    passes: {
      snapshot: 'passed',
      context: contextResult.ok ? 'passed' : 'blocked',
      traceability: traceability.ok ? 'passed' : 'blocked',
      graph: graph.ok ? 'passed' : 'blocked',
      projection: projection.ok ? 'passed' : 'blocked',
      assignments: adapterResult.ok ? 'passed' : 'blocked',
      drift: drift ? 'blocked' : 'passed',
    },
    implementationAcceptance: 'not_evaluated',
    verdict: stableFindings.length === 0 && adapterResult.ok ? 'pass' : 'blocked',
  };
  return report;
}

module.exports = {
  MAX_FINDINGS,
  scanTasksMarkdown,
  analyzeProjection,
  analyzeGraph,
  analyzeTaskMap,
  analyzeWorkspace,
  MAX_TOTAL_SNAPSHOT_BYTES,
};
