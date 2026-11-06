'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const json = (value) => JSON.stringify(value);
const parse = (value) => value == null ? null : JSON.parse(value);
const copy = (value) => value == null ? value : structuredClone(value);
const hash = (value) => crypto.createHash('sha256').update(json(value)).digest('hex');

function runNotFound(runId) {
  return Object.assign(new Error(`No stored run for ${runId}`), { name: 'RunNotFoundError', runId });
}

class DeliveryEngineRouter {
  constructor({ db, projectId, defaultEngine = 'legacy', legacyEngine, concurrentEngine, canRunEngine = () => true, now = () => Date.now() } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('A better-sqlite3 database is required');
    if (typeof projectId !== 'string' || !/^[0-9a-f]{10}$/.test(projectId)) throw new TypeError('projectId must be a normalized 10-character project ID');
    if (!['legacy', 'concurrent-v1'].includes(defaultEngine)) throw new TypeError('Unsupported default delivery engine');
    if (typeof canRunEngine !== 'function') throw new TypeError('canRunEngine must be a function');
    if (!legacyEngine || typeof legacyEngine.run !== 'function' || typeof legacyEngine.resume !== 'function') throw new TypeError('Legacy engine is required');
    if (defaultEngine === 'concurrent-v1' && (!concurrentEngine || typeof concurrentEngine.run !== 'function' || typeof concurrentEngine.resume !== 'function')) {
      throw new TypeError('Concurrent engine is required when selected for new runs');
    }
    this.db = db;
    this.projectId = projectId;
    this.defaultEngine = defaultEngine;
    this.legacyEngine = legacyEngine;
    this.concurrentEngine = concurrentEngine || null;
    this.canRunEngine = canRunEngine;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_run_engines (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, engine TEXT NOT NULL,
        objective_id TEXT, session_id TEXT, request_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS delivery_run_engine_objective_idx
        ON delivery_run_engines(project_id, objective_id, engine);
    `);
    const columns = db.prepare('PRAGMA table_info(delivery_run_engines)').all();
    if (!columns.some((column) => column.name === 'resume_placeholder')) {
      db.exec('ALTER TABLE delivery_run_engines ADD COLUMN resume_placeholder INTEGER NOT NULL DEFAULT 0');
    }
  }

  mapping(runId) {
    if (typeof runId !== 'string' || !runId) return null;
    const row = this.db.prepare('SELECT * FROM delivery_run_engines WHERE project_id=? AND run_id=?').get(this.projectId, runId);
    return row ? { projectId: row.project_id, runId: row.run_id, engine: row.engine,
      objectiveId: row.objective_id, sessionId: row.session_id,
      request: parse(row.request_json), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  mappings({ engine } = {}) {
    const rows = engine
      ? this.db.prepare('SELECT * FROM delivery_run_engines WHERE project_id=? AND engine=? ORDER BY created_at,run_id').all(this.projectId, engine)
      : this.db.prepare('SELECT * FROM delivery_run_engines WHERE project_id=? ORDER BY created_at,run_id').all(this.projectId);
    return rows.map((row) => ({ projectId: row.project_id, runId: row.run_id, engine: row.engine,
      objectiveId: row.objective_id, sessionId: row.session_id,
      request: parse(row.request_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  #pin(runId, engine, request, { objectiveId = null, sessionId = null, resumePlaceholder = false } = {}) {
    if (typeof runId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(runId)) throw new TypeError('runId must be a printable A2A task ID');
    if (!['legacy', 'concurrent-v1'].includes(engine)) throw new TypeError('Unsupported delivery engine');
    const encoded = json(copy(request || {}));
    const transaction = this.db.transaction(() => {
      const prior = this.db.prepare('SELECT engine,objective_id,session_id,request_json,resume_placeholder FROM delivery_run_engines WHERE project_id=? AND run_id=?')
        .get(this.projectId, runId);
      if (prior) {
        const oldRequest = parse(prior.request_json) || {};
        const isPlaceholder = prior.resume_placeholder === 1;
        if (prior.engine !== engine && !isPlaceholder) throw Object.assign(new Error('Run engine selection is immutable'), { code: 'run_engine_selection_conflict' });
        const supplied = Object.fromEntries(Object.entries(copy(request || {})).filter(([, value]) => value !== undefined));
        if (!isPlaceholder) {
          for (const key of ['goal', 'contract', 'contextId', 'newRequest']) {
            if (Object.hasOwn(supplied, key)
              && (!Object.hasOwn(oldRequest, key) || !isDeepStrictEqual(oldRequest[key], supplied[key]))) {
              throw Object.assign(new Error(`Run intake field ${key} is immutable`), { code: 'run_intake_conflict' });
            }
          }
        }
        const mergedRequest = isPlaceholder ? supplied : { ...oldRequest, ...supplied };
        const nextObjectiveId = prior.objective_id || objectiveId;
        const nextSessionId = prior.session_id || sessionId;
        const changed = !isDeepStrictEqual(oldRequest, mergedRequest)
          || nextObjectiveId !== prior.objective_id || nextSessionId !== prior.session_id
          || (isPlaceholder && !resumePlaceholder);
        if (!changed) return this.mapping(runId);
        this.db.prepare(`UPDATE delivery_run_engines SET objective_id=COALESCE(objective_id,?),session_id=COALESCE(session_id,?),
          request_json=?,updated_at=?,resume_placeholder=? WHERE project_id=? AND run_id=?`)
          .run(nextObjectiveId, nextSessionId, json(mergedRequest), this.now(), isPlaceholder && resumePlaceholder ? 1 : 0, this.projectId, runId);
      } else {
        this.db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(this.projectId, runId, engine, objectiveId, sessionId, encoded, this.now(), this.now());
        if (resumePlaceholder) this.db.prepare('UPDATE delivery_run_engines SET resume_placeholder=1 WHERE project_id=? AND run_id=?').run(this.projectId, runId);
      }
      return this.mapping(runId);
    });
    return transaction.immediate();
  }

  async run(input = {}) {
    return this.#run(input, false);
  }

  async runLegacy(input = {}) {
    return this.#run(input, true);
  }

  async #run(input, legacyOnly) {
    const { runId } = input;
    let mapping = this.mapping(runId);
    const engine = mapping?.engine || (legacyOnly ? 'legacy' : this.defaultEngine);
    if (engine === 'concurrent-v1' && !this.concurrentEngine) throw Object.assign(new Error('Concurrent engine is unavailable'), { code: 'concurrent_engine_unavailable' });
    this.#assertCanRun(engine, { runId, input, mapping });
    if (!mapping) {
      mapping = this.#pin(runId, engine, this.#intake(input), { objectiveId: engine === 'concurrent-v1' ? this.objectiveIdFor(runId) : null,
        sessionId: engine === 'concurrent-v1' ? this.sessionIdFor(runId, input.contextId) : null });
    } else if (Object.keys(this.#intake(input)).length) {
      mapping = this.#pin(runId, mapping.engine, this.#intake(input), { objectiveId: mapping.objectiveId, sessionId: mapping.sessionId });
    }
    const routedInput = { ...input, ...mapping.request };
    const routed = mapping.engine === 'concurrent-v1'
      ? { ...routedInput, objectiveId: mapping.objectiveId, sessionId: mapping.sessionId, engineMapping: mapping }
      : routedInput;
    return this.#engine(mapping.engine).run(routed);
  }

  #assertCanRun(engine, { runId, input, mapping }) {
    const result = this.canRunEngine({ engine, projectId: this.projectId, runId, input, mapping });
    if (result === true) return;
    const unsafe = result === 'unsafe' || result?.kind === 'unsafe';
    throw Object.assign(new Error(unsafe
      ? 'Delivery is fenced by unresolved or unknown workspace effects'
      : 'Delivery is busy with an active run on the other engine'), {
      code: unsafe ? 'delivery_engine_unsafe' : 'delivery_engine_busy',
    });
  }

  #intake(input) {
    return Object.fromEntries(['goal', 'contract', 'contextId', 'newRequest']
      .filter((key) => Object.hasOwn(input, key) && input[key] !== undefined)
      .map((key) => [key, copy(input[key])]));
  }

  async resume(input = {}) {
    const { runId } = input;
    let mapping = this.mapping(runId);
    const engine = mapping?.engine || 'legacy';
    if (engine === 'concurrent-v1' && !this.concurrentEngine) throw Object.assign(new Error('Concurrent engine is unavailable for a stored run'), { code: 'concurrent_engine_unavailable' });
    this.#assertCanRun(engine, { runId, input, mapping });
    if (!mapping) {
      mapping = this.#pin(runId, 'legacy', {}, { resumePlaceholder: true });
    }
    try {
      const routed = mapping.engine === 'concurrent-v1'
        ? { ...input, objectiveId: mapping.objectiveId, sessionId: mapping.sessionId, engineMapping: mapping }
        : input;
      return await this.#engine(mapping.engine).resume(routed);
    } catch (error) {
      if (mapping.engine === 'concurrent-v1' && error?.name === 'RunNotFoundError') {
        throw Object.assign(new Error('Concurrent run mapping exists but its objective is missing'), { code: 'concurrent_run_mapping_corrupt' });
      }
      throw error;
    }
  }

  objectiveIdFor(runId) { return `delivery-${hash([this.projectId, runId]).slice(0, 32)}`; }
  sessionIdFor(runId, contextId) { return `session-${hash([this.projectId, contextId || runId]).slice(0, 32)}`; }

  #engine(name) {
    if (name === 'legacy') return this.legacyEngine;
    if (!this.concurrentEngine) throw Object.assign(new Error('Concurrent engine is unavailable for a stored run'), { code: 'concurrent_engine_unavailable' });
    return this.concurrentEngine;
  }

  #route(runId, fallback = 'legacy') { return this.#engine(this.mapping(runId)?.engine || fallback); }

  activeRuns() {
    const runs = [...(this.legacyEngine.activeRuns?.() || []), ...(this.concurrentEngine?.activeRuns?.() || [])];
    return [...new Map(runs.map((run) => [run.runId, run])).values()];
  }

  getPause(runId) { return this.#route(runId).getPause?.(runId) || null; }
  requestPause(runId) { return this.#route(runId).requestPause?.(runId) === true; }
  cancelPauseRequest(runId) { return this.#route(runId).cancelPauseRequest?.(runId) === true; }
  async requestCancel(runId, expectedControlRevision) {
    const requestCancel = this.#route(runId).requestCancel;
    if (typeof requestCancel !== 'function') throw Object.assign(new Error('Owner cancellation is unavailable'), { code: 'owner_control_unavailable' });
    return requestCancel.call(this.#route(runId), runId, expectedControlRevision);
  }
  async isResumable(runId) { return (await this.#route(runId).isResumable?.(runId)) === true; }
  getRecoveryCheckpoint(runId) { return this.#route(runId).getRecoveryCheckpoint?.(runId) || null; }
  consumeCompletedPauseRequest(runId) { return this.#route(runId).consumeCompletedPauseRequest?.(runId) === true; }
  getRunGoal(runId) { return this.mapping(runId)?.request?.goal || this.#route(runId).getRunGoal?.(runId) || null; }
  getRunDigest(runId) { return this.#route(runId).getRunDigest?.(runId) || null; }
  getRunEngine(runId) { return this.mapping(runId)?.engine || null; }

  async prepareShutdown(options) {
    const legacy = await this.legacyEngine.shutdown?.(options);
    const concurrent = await this.concurrentEngine?.prepareShutdown?.(options);
    return { legacy: legacy ?? null, concurrent: concurrent ?? null };
  }

  async shutdown(options) {
    const legacy = await this.legacyEngine.shutdown?.(options);
    const concurrent = await this.concurrentEngine?.shutdown?.(options);
    return { legacy: legacy ?? null, concurrent: concurrent ?? null };
  }
}

module.exports = { DeliveryEngineRouter };
