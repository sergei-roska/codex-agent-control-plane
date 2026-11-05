'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DeliveryEvents } = require('./delivery-events');
const { stableDigest } = require('./backlog-store');
const { CRITICAL_KINDS, canonical, digest, clone, deepFreeze, fail, id, digestValue, pins,
  normalizeClosure, closuresIndependent, samePromotionIdentity, reviewDependencyEdges, frozenReviewMatches, projectReceipt } = require('./delivery-review-policy');

const MAX_CHECKPOINTS = 500;
const MAX_PROPOSALS = 500;
// Keep known read scopes within delivery-contracts pathArray's existing limit.
const MAX_READ_SCOPE_PATHS = 500;
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

function treeManifest(root) {
  const entries = [];
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('review_input_symlink');
      if (stat.isDirectory()) walk(absolute, rel);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(absolute);
        entries.push({ path: rel, size: bytes.length, digest: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
          mode: stat.mode & 0o111 ? '100755' : '100644' });
      } else fail('review_input_special_file');
    }
  };
  walk(root);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries, digest: digest(entries) };
}

function compactKnownReadScope(closure, manifest) {
  const entries = manifest?.entries;
  if (!Array.isArray(entries)) fail('review_candidate_manifest_invalid');
  const manifestByPath = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.digest !== 'string' || manifestByPath.has(entry.path)) {
      fail('review_candidate_manifest_invalid');
    }
    manifestByPath.set(entry.path, entry);
  }
  const selected = new Set();
  for (const entry of closure.readManifest) {
    const frozen = manifestByPath.get(entry.path);
    if (!frozen || digestValue(frozen.digest, 'manifest.digest') !== entry.digest) fail('review_closure_manifest_mismatch');
    selected.add(entry.path);
  }
  const leaves = closure.readManifest.map((entry) => entry.path);
  if (leaves.length <= MAX_READ_SCOPE_PATHS) return leaves;

  const root = { children: new Map(), filePath: null, total: 0, selected: 0 };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), filePath: null, total: 0, selected: 0 });
      node = node.children.get(part);
    }
    if (node.filePath !== null) fail('review_candidate_manifest_invalid');
    node.filePath = entry.path;
  }
  const summarize = (node) => {
    if (node.filePath !== null && node.children.size > 0) fail('review_candidate_manifest_invalid');
    let total = node.filePath === null ? 0 : 1;
    let chosen = node.filePath !== null && selected.has(node.filePath) ? 1 : 0;
    for (const child of node.children.values()) {
      summarize(child);
      total += child.total;
      chosen += child.selected;
    }
    node.total = total;
    node.selected = chosen;
  };
  summarize(root);

  const paths = [];
  const visit = (node, prefix, isRoot = false) => {
    if (!isRoot && node.total > 0 && node.selected === node.total) {
      paths.push(prefix);
      return;
    }
    if (node.filePath !== null && selected.has(node.filePath)) paths.push(node.filePath);
    for (const [name, child] of [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      visit(child, prefix ? `${prefix}/${name}` : name);
    }
  };
  visit(root, '', true);
  paths.sort((left, right) => left.localeCompare(right));

  const prefixes = new Set(paths);
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let authorized = false;
    for (let length = parts.length; length > 0; length -= 1) {
      if (prefixes.has(parts.slice(0, length).join('/'))) { authorized = true; break; }
    }
    if (authorized !== selected.has(entry.path)) fail('review_read_scope_compaction_invalid');
  }
  if (paths.length > MAX_READ_SCOPE_PATHS) fail('review_read_scope_unrepresentable');
  return paths;
}

function sameReceiptCommand(left, right) {
  const { createdAt: _leftCreatedAt, ...leftCommand } = left;
  const { createdAt: _rightCreatedAt, ...rightCommand } = right;
  return canonical(leftCommand) === canonical(rightCommand);
}

class CandidateReviewStore {
  constructor({ db, candidateStore, events, checkpointInventory = () => [], currentObjective,
    authorizeCheckpoint = () => false, authorizeProposal = () => false, authorizeBinding = () => false, authorizeThread = () => false, resolveAttempt = () => null,
    authorizeSettlement = () => false, authorizeCheckpointSupersession = () => false, attestClosure = () => null, attestPromotion = () => false,
    verifyReviewExecution = () => false, eventHook, idFactory = (kind, key) => `${kind}-${digest(key).slice(7, 39)}`,
    now = () => Date.now() } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('A better-sqlite3 database is required');
    if (!candidateStore || candidateStore.db !== db) throw new TypeError('CandidateStore must share the SQLite database');
    for (const [name, callback] of Object.entries({ checkpointInventory, currentObjective, authorizeCheckpoint, authorizeProposal, authorizeBinding, authorizeThread,
      resolveAttempt, authorizeSettlement, authorizeCheckpointSupersession, attestClosure, attestPromotion, verifyReviewExecution, idFactory, now })) {
      if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
    }
    if (eventHook !== undefined && typeof eventHook !== 'function') throw new TypeError('eventHook must be a function');
    this.db = db;
    this.candidates = candidateStore;
    this.events = events || new DeliveryEvents(db, { now });
    this.checkpointInventoryAdapter = checkpointInventory;
    this.currentObjective = currentObjective || (() => null);
    this.authorizeCheckpoint = authorizeCheckpoint;
    this.authorizeProposal = authorizeProposal;
    this.authorizeBinding = authorizeBinding;
    this.authorizeThread = authorizeThread;
    this.resolveAttempt = resolveAttempt;
    this.authorizeSettlement = authorizeSettlement;
    this.authorizeCheckpointSupersession = authorizeCheckpointSupersession;
    this.attestClosure = attestClosure;
    this.attestPromotion = attestPromotion;
    this.verifyReviewExecution = verifyReviewExecution;
    this.eventHook = eventHook;
    this.idFactory = idFactory;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_checkpoints (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL, checkpoint_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id, checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS review_checkpoint_supersessions (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL, replacement_checkpoint_id TEXT NOT NULL,
        input_json TEXT NOT NULL, checkpoint_digest TEXT NOT NULL, replacement_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id, checkpoint_id),
        UNIQUE(project_id, objective_id, source_message_id, checkpoint_id),
        UNIQUE(project_id, objective_id, replacement_checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS review_contexts (
        context_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL, candidate_id TEXT NOT NULL, context_json TEXT NOT NULL,
        context_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(project_id, objective_id, checkpoint_id, candidate_id, context_digest)
      );
      CREATE TABLE IF NOT EXISTS review_tasks (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL, candidate_id TEXT NOT NULL, context_id TEXT NOT NULL,
        role TEXT NOT NULL, task_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_attempt_bindings (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE, claim_id TEXT NOT NULL UNIQUE, fencing_token INTEGER NOT NULL,
        owner_generation INTEGER NOT NULL, selected_settings_digest TEXT NOT NULL, provider_context_id TEXT NOT NULL,
        thread_id TEXT UNIQUE, attempt_json TEXT NOT NULL, claim_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_receipts (
        receipt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL, candidate_id TEXT NOT NULL, context_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_promotions (
        promotion_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, project_id TEXT NOT NULL,
        objective_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, source_candidate_id TEXT NOT NULL,
        target_candidate_id TEXT NOT NULL, target_context_id TEXT NOT NULL, promotion_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(receipt_id, target_candidate_id, target_context_id)
      );
      CREATE INDEX IF NOT EXISTS review_task_lookup_idx ON review_tasks(project_id, objective_id, candidate_id);
      CREATE INDEX IF NOT EXISTS review_receipt_lookup_idx ON review_receipts(project_id, objective_id, candidate_id, checkpoint_id);
    `);
  }

  #sync(value, code) {
    if (value && typeof value.then === 'function') fail(code || 'review_callback_must_be_synchronous');
    return value;
  }

  checkpointInventory({ projectId, objectiveId } = {}) {
    id(projectId, 'projectId'); id(objectiveId, 'objectiveId');
    return this.#checkpointInventory(projectId, objectiveId, this.#ownerCheckpointInventory(projectId, objectiveId));
  }

  #ownerCheckpointInventory(projectId, objectiveId) {
    const values = this.#sync(this.checkpointInventoryAdapter({ projectId, objectiveId }), 'checkpoint_inventory_async');
    if (!Array.isArray(values) || values.length > MAX_CHECKPOINTS) fail('checkpoint_inventory_invalid');
    const result = new Map();
    for (const row of values) {
      if (!row || row.projectId !== projectId || row.objectiveId !== objectiveId) fail('checkpoint_inventory_scope_invalid');
      const checkpointId = id(row.checkpointId, 'checkpointId');
      const prior = result.get(checkpointId);
      if (prior && canonical(prior) !== canonical(row)) fail('checkpoint_inventory_conflict');
      result.set(checkpointId, { projectId, objectiveId, checkpointId });
    }
    return [...result.values()].sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
  }

  #checkpointInventory(projectId, objectiveId, ownerRows) {
    const result = new Map(ownerRows.map((row) => [row.checkpointId, row]));
    for (const row of this.db.prepare('SELECT project_id,objective_id,checkpoint_id FROM review_checkpoints WHERE project_id=? AND objective_id=?').all(projectId, objectiveId)) {
      result.set(row.checkpoint_id, { projectId: row.project_id, objectiveId: row.objective_id, checkpointId: row.checkpoint_id });
    }
    const retired = new Set(this.db.prepare('SELECT checkpoint_id FROM review_checkpoint_supersessions WHERE project_id=? AND objective_id=?').all(projectId, objectiveId)
      .map((row) => row.checkpoint_id));
    return [...result.values()].filter((row) => !retired.has(row.checkpointId)).sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
  }

  checkpointHistory({ projectId, objectiveId } = {}) {
    id(projectId, 'projectId'); id(objectiveId, 'objectiveId');
    return this.db.prepare(`SELECT checkpoint_id,checkpoint_json,checkpoint_digest FROM review_checkpoints
      WHERE project_id=? AND objective_id=? ORDER BY checkpoint_id`).all(projectId, objectiveId)
      .map((row) => ({ checkpoint: parse(row.checkpoint_json), checkpointDigest: row.checkpoint_digest }));
  }

  isCheckpointActive({ projectId, objectiveId, checkpointId } = {}) {
    id(projectId, 'projectId'); id(objectiveId, 'objectiveId'); id(checkpointId, 'checkpointId');
    if (!this.checkpointInventory({ projectId, objectiveId }).some((entry) => entry.checkpointId === checkpointId)) return false;
    return this.#getCheckpoint(projectId, objectiveId, checkpointId) !== null;
  }

  checkpointSupersessions({ projectId, objectiveId } = {}) {
    id(projectId, 'projectId'); id(objectiveId, 'objectiveId');
    const rows = this.db.prepare(`SELECT source_message_id,checkpoint_id,replacement_checkpoint_id,input_json,
      checkpoint_digest,replacement_digest,created_at FROM review_checkpoint_supersessions
      WHERE project_id=? AND objective_id=? ORDER BY created_at,source_message_id,checkpoint_id`).all(projectId, objectiveId);
    const groups = new Map();
    for (const row of rows) {
      let entry = groups.get(row.source_message_id);
      if (!entry) {
        entry = { ...parse(row.input_json), createdAt: row.created_at, checkpointDigests: [], replacements: [] };
        groups.set(row.source_message_id, entry);
      }
      entry.checkpointDigests.push({ checkpointId: row.checkpoint_id, checkpointDigest: row.checkpoint_digest });
      entry.replacements.push({ checkpointId: row.checkpoint_id, replacementCheckpointId: row.replacement_checkpoint_id,
        replacementDigest: row.replacement_digest });
    }
    return [...groups.values()];
  }

  supersedeCheckpoints(input, authorization) {
    const fields = ['projectId', 'objectiveId', 'sourceMessageId', 'expectedOwnerGeneration', 'expectedControlRevision',
      'priorGoalRevision', 'currentGoalRevision', 'replacements'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
      fail('review_checkpoint_supersession_input_invalid');
    }
    const inputKeys = Reflect.ownKeys(input);
    if (inputKeys.length !== fields.length || inputKeys.some((field) => typeof field !== 'string' || !fields.includes(field))) {
      fail('review_checkpoint_supersession_input_invalid');
    }
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('review_checkpoint_supersession_input_invalid');
    }
    const projectId = id(input.projectId, 'projectId');
    const objectiveId = id(input.objectiveId, 'objectiveId');
    const sourceMessageId = id(input.sourceMessageId, 'sourceMessageId');
    for (const field of ['expectedOwnerGeneration', 'expectedControlRevision', 'priorGoalRevision', 'currentGoalRevision']) {
      if (!Number.isSafeInteger(input[field]) || input[field] < 0) fail('review_checkpoint_supersession_revision_invalid');
    }
    if (input.currentGoalRevision !== input.priorGoalRevision + 1) fail('review_checkpoint_supersession_revision_invalid');
    if (!Array.isArray(input.replacements) || input.replacements.length < 1 || input.replacements.length > MAX_CHECKPOINTS) {
      fail('review_checkpoint_supersession_replacements_invalid');
    }
    const replacements = input.replacements.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype
        || Reflect.ownKeys(entry).length !== 2 || !Object.hasOwn(entry, 'checkpointId')
        || !Object.hasOwn(entry, 'replacementCheckpointId')) fail('review_checkpoint_supersession_replacements_invalid');
      for (const field of ['checkpointId', 'replacementCheckpointId']) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('review_checkpoint_supersession_replacements_invalid');
      }
      return { checkpointId: id(entry.checkpointId, 'checkpointId'),
        replacementCheckpointId: id(entry.replacementCheckpointId, 'replacementCheckpointId') };
    }).sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
    if (new Set(replacements.map((entry) => entry.checkpointId)).size !== replacements.length
      || new Set(replacements.map((entry) => entry.replacementCheckpointId)).size !== replacements.length
      || replacements.some((entry) => entry.checkpointId === entry.replacementCheckpointId)) {
      fail('review_checkpoint_supersession_mapping_invalid');
    }
    const normalized = { projectId, objectiveId, sourceMessageId,
      expectedOwnerGeneration: input.expectedOwnerGeneration, expectedControlRevision: input.expectedControlRevision,
      priorGoalRevision: input.priorGoalRevision, currentGoalRevision: input.currentGoalRevision, replacements };
    const transaction = this.db.transaction(() => this.#supersedeCheckpoints(normalized, authorization));
    return transaction.immediate();
  }

  #supersedeCheckpoints(normalized, authorization) {
    const { projectId, objectiveId, sourceMessageId, replacements } = normalized;
    const currentObjective = this.#sync(this.currentObjective({ projectId, objectiveId }), 'objective_resolver_async');
    if (!currentObjective || currentObjective.projectId !== projectId || currentObjective.objectiveId !== objectiveId
      || currentObjective.ownerGeneration !== normalized.expectedOwnerGeneration
      || currentObjective.controlRevision !== normalized.expectedControlRevision
      || currentObjective.goalRevision !== normalized.currentGoalRevision) fail('review_checkpoint_supersession_pins_stale');
    const ownerRows = this.#ownerCheckpointInventory(projectId, objectiveId);
    const ownerIds = new Set(ownerRows.map((row) => row.checkpointId));
    const activeInventory = this.#checkpointInventory(projectId, objectiveId, ownerRows);

    const saved = this.db.prepare(`SELECT input_json FROM review_checkpoint_supersessions
      WHERE project_id=? AND objective_id=? AND source_message_id=? ORDER BY checkpoint_id LIMIT 1`)
      .get(projectId, objectiveId, sourceMessageId);
    let checkpointPairs;
    if (saved) {
      if (canonical(parse(saved.input_json)) !== canonical(normalized)) fail('review_checkpoint_supersession_source_conflict');
      checkpointPairs = replacements.map((mapping) => {
        const old = this.db.prepare(`SELECT checkpoint_json,checkpoint_digest FROM review_checkpoints
          WHERE project_id=? AND objective_id=? AND checkpoint_id=?`).get(projectId, objectiveId, mapping.checkpointId);
        const replacement = this.db.prepare(`SELECT checkpoint_json,checkpoint_digest FROM review_checkpoints
          WHERE project_id=? AND objective_id=? AND checkpoint_id=?`).get(projectId, objectiveId, mapping.replacementCheckpointId);
        if (!old || !replacement) fail('review_checkpoint_supersession_checkpoint_missing');
        return { ...mapping, checkpoint: parse(old.checkpoint_json), checkpointDigest: old.checkpoint_digest,
          replacement: parse(replacement.checkpoint_json), replacementDigest: replacement.checkpoint_digest };
      });
    } else {
      const activeRecords = activeInventory.map((entry) => {
        const row = this.db.prepare(`SELECT checkpoint_json FROM review_checkpoints
          WHERE project_id=? AND objective_id=? AND checkpoint_id=?`).get(projectId, objectiveId, entry.checkpointId);
        if (!row) fail('review_checkpoint_supersession_checkpoint_missing');
        return parse(row.checkpoint_json);
      });
      const priorIds = activeRecords.filter((checkpoint) => checkpoint.goalRevision === normalized.priorGoalRevision)
        .map((checkpoint) => checkpoint.checkpointId).sort();
      if (activeRecords.some((checkpoint) => checkpoint.goalRevision !== normalized.priorGoalRevision
        && checkpoint.goalRevision !== normalized.currentGoalRevision)
        || canonical(priorIds) !== canonical(replacements.map((entry) => entry.checkpointId))) {
        fail('review_checkpoint_supersession_incomplete');
      }
      checkpointPairs = replacements.map((mapping) => {
        const old = this.db.prepare(`SELECT checkpoint_json,checkpoint_digest FROM review_checkpoints
          WHERE project_id=? AND objective_id=? AND checkpoint_id=?`).get(projectId, objectiveId, mapping.checkpointId);
        const replacement = this.db.prepare(`SELECT checkpoint_json,checkpoint_digest FROM review_checkpoints
          WHERE project_id=? AND objective_id=? AND checkpoint_id=?`).get(projectId, objectiveId, mapping.replacementCheckpointId);
        if (!old || !replacement) fail('review_checkpoint_supersession_checkpoint_missing');
        if (this.db.prepare(`SELECT 1 FROM review_checkpoint_supersessions
          WHERE project_id=? AND objective_id=? AND checkpoint_id=?`).get(projectId, objectiveId, mapping.replacementCheckpointId)) {
          fail('review_checkpoint_supersession_cycle');
        }
        const checkpoint = parse(old.checkpoint_json);
        const replacementCheckpoint = parse(replacement.checkpoint_json);
        if (checkpoint.goalRevision !== normalized.priorGoalRevision
          || replacementCheckpoint.goalRevision !== normalized.currentGoalRevision
          || replacementCheckpoint.requirementDigest !== digestValue(currentObjective.requirementDigest, 'requirementDigest')
          || replacementCheckpoint.checksDigest !== digestValue(currentObjective.checksDigest, 'checksDigest')) {
          fail('review_checkpoint_supersession_identity_stale');
        }
        if (checkpoint.critical && !replacementCheckpoint.critical) fail('review_checkpoint_supersession_critical_downgrade');
        return { ...mapping, checkpoint, checkpointDigest: old.checkpoint_digest,
          replacement: replacementCheckpoint, replacementDigest: replacement.checkpoint_digest };
      });
      const currentIds = new Set(activeRecords.filter((checkpoint) => checkpoint.goalRevision === normalized.currentGoalRevision)
        .map((checkpoint) => checkpoint.checkpointId));
      for (const mapping of checkpointPairs) {
        if (!currentIds.has(mapping.replacementCheckpointId) || !ownerIds.has(mapping.replacementCheckpointId)) {
          fail('review_checkpoint_supersession_replacement_in_inventory');
        }
        for (const dependency of mapping.replacement.dependsOn) {
          if (replacements.some((entry) => entry.checkpointId === dependency)) fail('review_checkpoint_supersession_dependency_remapped');
        }
      }
      const projectedIds = activeRecords.map((checkpoint) => checkpoint.checkpointId)
        .filter((checkpointId) => !replacements.some((entry) => entry.checkpointId === checkpointId));
      const projected = projectedIds.map((checkpointId) => {
        const row = this.db.prepare(`SELECT checkpoint_json FROM review_checkpoints
          WHERE project_id=? AND objective_id=? AND checkpoint_id=?`).get(projectId, objectiveId, checkpointId);
        if (!row) fail('review_checkpoint_supersession_checkpoint_missing');
        return parse(row.checkpoint_json);
      });
      this.#assertCheckpointGraph(projected);
    }

    const authContext = deepFreeze(clone({ input: normalized, authorization, currentObjective, ownerInventory: ownerRows,
      priorCheckpoints: checkpointPairs.map((entry) => ({ checkpoint: entry.checkpoint, checkpointDigest: entry.checkpointDigest })),
      replacementCheckpoints: checkpointPairs.map((entry) => ({ checkpoint: entry.replacement, checkpointDigest: entry.replacementDigest })),
      mapping: checkpointPairs.map(({ checkpointId, replacementCheckpointId, checkpointDigest, replacementDigest }) =>
        ({ checkpointId, replacementCheckpointId, checkpointDigest, replacementDigest })) }));
    if (this.#sync(this.authorizeCheckpointSupersession(authContext), 'checkpoint_supersession_authorization_async') !== true) {
      fail('review_checkpoint_supersession_unauthorized');
    }
    const authorizedObjective = this.#sync(this.currentObjective({ projectId, objectiveId }), 'objective_resolver_async');
    const authorizedOwnerRows = this.#ownerCheckpointInventory(projectId, objectiveId);
    if (!authorizedObjective || authorizedObjective.projectId !== projectId || authorizedObjective.objectiveId !== objectiveId
      || authorizedObjective.ownerGeneration !== normalized.expectedOwnerGeneration
      || authorizedObjective.controlRevision !== normalized.expectedControlRevision
      || authorizedObjective.goalRevision !== normalized.currentGoalRevision
      || canonical(authorizedOwnerRows) !== canonical(ownerRows)) fail('review_checkpoint_supersession_pins_stale');
    if (saved) return this.checkpointSupersessions({ projectId, objectiveId }).find((entry) => entry.sourceMessageId === sourceMessageId);

    const inputJson = canonical(normalized);
    const createdAt = this.now();
    for (const pair of checkpointPairs) {
      this.db.prepare(`INSERT INTO review_checkpoint_supersessions(project_id,objective_id,source_message_id,checkpoint_id,
        replacement_checkpoint_id,input_json,checkpoint_digest,replacement_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(projectId, objectiveId, sourceMessageId, pair.checkpointId, pair.replacementCheckpointId,
          inputJson, pair.checkpointDigest, pair.replacementDigest, createdAt);
    }
    const event = this.events.appendInTransaction(projectId, { eventType: 'review.checkpoints_superseded',
      objectRevision: normalized.currentGoalRevision,
      payload: { objectiveId, sourceMessageId, priorGoalRevision: normalized.priorGoalRevision,
        currentGoalRevision: normalized.currentGoalRevision, mapping: checkpointPairs.map((pair) =>
          ({ checkpointId: pair.checkpointId, replacementCheckpointId: pair.replacementCheckpointId,
            checkpointDigest: pair.checkpointDigest, replacementDigest: pair.replacementDigest })) },
      dedupeKey: `review-checkpoint-supersession:${objectiveId}:${sourceMessageId}` });
    this.#hook({ type: 'review.checkpoints_superseded', input: normalized, event });
    return this.checkpointSupersessions({ projectId, objectiveId }).find((entry) => entry.sourceMessageId === sourceMessageId);
  }

  registerCheckpoint(input, authorization) {
    if (!input || this.#sync(this.authorizeCheckpoint({ input: clone(input), authorization }), 'checkpoint_authorization_async') !== true) fail('checkpoint_registration_unauthorized');
    const projectId = id(input.projectId, 'projectId');
    const objectiveId = id(input.objectiveId, 'objectiveId');
    const checkpointId = id(input.checkpointId, 'checkpointId');
    const objective = this.#sync(this.currentObjective({ projectId, objectiveId }), 'objective_resolver_async');
    if (!objective || objective.projectId !== projectId || objective.objectiveId !== objectiveId) fail('review_objective_missing');
    const checkpoint = {
      projectId, objectiveId, checkpointId,
      kind: id(input.kind, 'kind'),
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 1000) : fail('checkpoint_reason_invalid'),
      goalRevision: objective.goalRevision,
      requirementDigest: digestValue(objective.requirementDigest, 'requirementDigest'),
      checksDigest: digestValue(objective.checksDigest, 'checksDigest'),
      checkIdentity: id(input.checkIdentity, 'checkIdentity'),
      checkPins: pins(input.checkPins || [], 'checkPins'),
      toolPins: pins(input.toolPins || [], 'toolPins'),
      profilePins: pins(input.profilePins || [], 'profilePins'),
      environmentDigest: digestValue(input.environmentDigest, 'environmentDigest'),
      dependsOn: [...new Set((input.dependsOn || []).map((value) => id(value, 'dependsOn')))].sort(),
      critical: input.critical === true || CRITICAL_KINDS.has(input.kind),
      createdAt: this.now(),
    };
    const checkpointDigest = digest(checkpoint);
    const existing = this.db.prepare('SELECT checkpoint_digest,checkpoint_json FROM review_checkpoints WHERE project_id=? AND objective_id=? AND checkpoint_id=?').get(projectId, objectiveId, checkpointId);
    if (existing) {
      if (existing.checkpoint_digest !== checkpointDigest) fail('checkpoint_immutable_conflict');
      return parse(existing.checkpoint_json);
    }
    this.#checkpointGraph(projectId, objectiveId, checkpoint);
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO review_checkpoints(project_id,objective_id,checkpoint_id,checkpoint_json,checkpoint_digest,created_at) VALUES(?,?,?,?,?,?)')
        .run(projectId, objectiveId, checkpointId, json(checkpoint), checkpointDigest, checkpoint.createdAt);
      const event = this.events.appendInTransaction(projectId, { eventType: 'review.checkpoint_registered', objectRevision: objective.goalRevision,
        payload: { objectiveId, checkpointId, checkpointDigest }, dedupeKey: `review-checkpoint:${objectiveId}:${checkpointId}` });
      this.#hook({ type: 'review.checkpoint_registered', checkpoint, event });
      return checkpoint;
    });
    return tx.immediate();
  }

  #hook(event) {
    if (!this.eventHook) return;
    this.#sync(this.eventHook(deepFreeze(clone(event))), 'review_event_hook_async');
  }

  #getCheckpoint(projectId, objectiveId, checkpointId) {
    const row = this.db.prepare('SELECT checkpoint_json FROM review_checkpoints WHERE project_id=? AND objective_id=? AND checkpoint_id=?').get(projectId, objectiveId, checkpointId);
    return row ? parse(row.checkpoint_json) : null;
  }

  #addCandidateReference(candidateId, projectId, objectiveId, refType, refId) {
    this.candidates.addReference(candidateId, refType, refId);
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.status !== 'known' || candidate.projectId !== projectId || candidate.objectiveId !== objectiveId) {
      fail('review_candidate_unavailable');
    }
  }

  #checkpointGraph(projectId, objectiveId, pending) {
    const activeIds = new Set(this.checkpointInventory({ projectId, objectiveId }).map((entry) => entry.checkpointId));
    const nodes = new Map([...activeIds].map((checkpointId) => [checkpointId, {
      projectId, objectiveId, checkpointId, dependsOn: [],
    }]));
    for (const row of this.db.prepare('SELECT checkpoint_json FROM review_checkpoints WHERE project_id=? AND objective_id=?').all(projectId, objectiveId)) {
      const checkpoint = parse(row.checkpoint_json);
      if (activeIds.has(checkpoint.checkpointId)) nodes.set(checkpoint.checkpointId, checkpoint);
    }
    if (pending) nodes.set(pending.checkpointId, pending);
    return this.#assertCheckpointGraph([...nodes.values()]);
  }

  #assertCheckpointGraph(checkpoints) {
    const nodes = new Map(checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]));
    for (const checkpoint of nodes.values()) {
      for (const dependency of checkpoint.dependsOn || []) if (!nodes.has(dependency)) fail('review_checkpoint_dependency_missing');
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (checkpointId) => {
      if (visiting.has(checkpointId)) fail('review_checkpoint_dependency_cycle');
      if (visited.has(checkpointId)) return;
      visiting.add(checkpointId);
      for (const dependency of nodes.get(checkpointId)?.dependsOn || []) visit(dependency);
      visiting.delete(checkpointId);
      visited.add(checkpointId);
    };
    for (const checkpointId of nodes.keys()) visit(checkpointId);
    return [...nodes.values()].sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
  }

  #checkpointAncestors(checkpointId, graph) {
    const byId = new Map(graph.map((checkpoint) => [checkpoint.checkpointId, checkpoint]));
    const ancestors = new Set();
    const visit = (currentId) => {
      for (const dependency of byId.get(currentId)?.dependsOn || []) {
        if (ancestors.has(dependency)) continue;
        ancestors.add(dependency);
        visit(dependency);
      }
    };
    visit(checkpointId);
    return [...ancestors].sort();
  }

  #validateLiveReviewContext(registered) {
    const task = registered.task;
    const objective = this.#sync(this.currentObjective({ projectId: task.projectId, objectiveId: task.objectiveId }), 'objective_resolver_async');
    const checkpoint = this.#getCheckpoint(task.projectId, task.objectiveId, task.checkpointId);
    if (!objective || objective.projectId !== task.projectId || objective.objectiveId !== task.objectiveId
      || objective.goalRevision !== registered.context.ownerGoalRevision
      || digestValue(objective.requirementDigest, 'requirementDigest') !== registered.context.requirementDigest
      || digestValue(objective.checksDigest, 'checksDigest') !== registered.context.checksDigest
      || !checkpoint || checkpoint.checkIdentity !== registered.context.checkIdentity
      || canonical(checkpoint.checkPins) !== canonical(registered.context.checkPins)
      || canonical(checkpoint.toolPins) !== canonical(registered.context.toolPins)
      || canonical(checkpoint.profilePins) !== canonical(registered.context.profilePins)
      || checkpoint.environmentDigest !== registered.context.environmentDigest) fail('review_context_stale');
    const manifest = this.candidates.readManifest(registered.context.candidateManifestDigest);
    const candidate = this.candidates.get(task.baseCandidateId);
    if (!candidate || candidate.checkIdentity !== registered.context.checkIdentity
      || digestValue(candidate.environmentDigest, 'candidate.environmentDigest') !== registered.context.environmentDigest) fail('review_context_stale');
    const closure = this.#closure({ projectId: task.projectId, objectiveId: task.objectiveId, checkpointId: task.checkpointId,
      candidate: this.candidates.projectDeliveryCandidate(task.baseCandidateId), checkpoint, objective, manifest });
    if (canonical(closure) !== canonical(registered.context.closure)) fail('review_context_stale');
    return true;
  }

  #closure(input) {
    const value = this.#sync(this.attestClosure(clone(input)), 'closure_attestation_async');
    const normalized = normalizeClosure(value);
    if (!normalized.known) return normalized;
    const checkpointId = input.checkpointId || normalized.checkpointId;
    return { ...normalized, checkpointId, digest: digest({ checkpointId, readManifest: normalized.readManifest, checkpointAncestors: normalized.checkpointAncestors }) };
  }

  proposeReviews({ projectId, objectiveId, checkpointId, candidateId, reviewers } = {}, authorization) {
    if (this.#sync(this.authorizeProposal({ projectId, objectiveId, checkpointId, candidateId, reviewers: clone(reviewers), authorization }), 'proposal_authorization_async') !== true) fail('review_proposal_unauthorized');
    id(projectId, 'projectId'); id(objectiveId, 'objectiveId'); id(checkpointId, 'checkpointId'); id(candidateId, 'candidateId');
    if (!Array.isArray(reviewers) || reviewers.length < 1 || reviewers.length > MAX_PROPOSALS) fail('reviewers_invalid');
    const checkpoint = this.#getCheckpoint(projectId, objectiveId, checkpointId);
    if (!checkpoint) fail('review_checkpoint_missing');
    const candidate = this.candidates.get(candidateId);
    const deliveryCandidate = this.candidates.projectDeliveryCandidate(candidateId);
    if (!candidate || candidate.status !== 'known' || deliveryCandidate.projectId !== projectId || deliveryCandidate.objectiveId !== objectiveId) fail('review_candidate_invalid');
    if (candidate.checkIdentity !== checkpoint.checkIdentity
      || digestValue(candidate.environmentDigest, 'candidate.environmentDigest') !== checkpoint.environmentDigest) fail('review_candidate_pins_stale');
    const manifest = this.candidates.readManifest(candidate.manifestDigest);
    if (manifest.digest !== candidate.manifestDigest) fail('review_candidate_manifest_mismatch');
    const objective = this.#sync(this.currentObjective({ projectId, objectiveId }), 'objective_resolver_async');
    if (!objective || objective.goalRevision !== checkpoint.goalRevision || digestValue(objective.requirementDigest, 'requirementDigest') !== checkpoint.requirementDigest
      || digestValue(objective.checksDigest, 'checksDigest') !== checkpoint.checksDigest) fail('review_owner_context_stale');
    const checkpointGraph = this.#checkpointGraph(projectId, objectiveId);
    const closure = this.#closure({ projectId, objectiveId, checkpointId, candidate: deliveryCandidate, checkpoint, objective, manifest });
    const readScopePaths = closure.known ? compactKnownReadScope(closure, manifest) : null;
    const requiredAncestors = this.#checkpointAncestors(checkpointId, checkpointGraph);
    const graphIds = new Set(checkpointGraph.map((entry) => entry.checkpointId));
    if (closure.known && (closure.checkpointAncestors.includes(checkpointId)
      || closure.checkpointAncestors.some((ancestor) => !graphIds.has(ancestor)))) fail('review_closure_checkpoint_scope_invalid');
    if (requiredAncestors.some((ancestor) => !closure.known || !closure.checkpointAncestors.includes(ancestor))) fail('review_closure_ancestry_incomplete');
    const contextCore = {
      projectId, objectiveId, checkpointId, candidateId,
      candidateManifestDigest: manifest.digest,
      ownerGoalRevision: objective.goalRevision,
      requirementDigest: checkpoint.requirementDigest,
      checksDigest: checkpoint.checksDigest,
      checkIdentity: checkpoint.checkIdentity,
      checkPins: checkpoint.checkPins, toolPins: checkpoint.toolPins, profilePins: checkpoint.profilePins,
      environmentDigest: checkpoint.environmentDigest,
      closure,
    };
    const contextDigest = digest(contextCore);
    const contextId = id(this.idFactory('review-context', `${projectId}:${objectiveId}:${checkpointId}:${candidateId}:${contextDigest}`), 'contextId');
    const context = { ...contextCore, contextId, contextDigest };
    const proposalOffset = this.db.prepare('SELECT COUNT(*) AS count FROM review_tasks WHERE context_id=?').get(contextId).count;
    const unique = new Set();
    const proposals = reviewers.map((reviewer, index) => {
      if (!reviewer || !['verifier', 'auditor'].includes(reviewer.role)) fail('review_role_invalid');
      const taskId = id(reviewer.taskId || this.idFactory('review-task', `${contextId}:${reviewer.role}:${proposalOffset + index}`), 'taskId');
      if (unique.has(taskId)) fail('review_instance_identity_duplicate');
      unique.add(taskId);
      const task = { schemaVersion: 'delivery/v1', projectId, objectiveId, taskId, revision: 1, role: reviewer.role,
        kind: 'review', objective: `Review checkpoint ${checkpointId} on frozen candidate ${candidateId}`,
        priority: reviewer.priority ?? 0, dependencies: [], productWritePaths: [],
        readScope: closure.known ? { kind: 'known', paths: readScopePaths }
          : { kind: 'unknown', paths: null, reason: 'Controller did not attest a complete read closure.' },
        scratchWriteRoots: [`review-scratch/${taskId}`], resourceClaims: [], publicationAuthority: { state: 'denied', reason: 'review_task', authorityRevision: objective.authorityRevision ?? 0 },
        state: 'queued', checkpointId, baseCandidateId: candidateId, skillPins: [], checks: { checkPins: checkpoint.checkPins, toolPins: checkpoint.toolPins, profilePins: checkpoint.profilePins } };
      return { task, role: reviewer.role, checkpointId, taskId, contextId, contextDigest, inputManifestDigest: manifest.digest,
        dependsOnVerifierEvidence: reviewer.dependsOnVerifierEvidence === true };
    });
    const peers = this.db.prepare('SELECT task_json FROM review_tasks WHERE project_id=? AND objective_id=? AND candidate_id=? AND role IN (\'verifier\',\'auditor\')').all(projectId, objectiveId, candidateId).map((row) => parse(row.task_json));
    const every = [...peers, ...proposals.map((entry) => entry.task)];
    const peerIdentities = new Set();
    for (const task of every) {
      if (!['verifier', 'auditor'].includes(task.role)) continue;
      const key = `${task.role}:${task.taskId}`;
      if (peerIdentities.has(key)) fail('review_instance_identity_duplicate');
      peerIdentities.add(key);
    }
    const deps = reviewDependencyEdges(checkpointGraph, proposals);
    for (const proposal of proposals) {
      for (const dependency of checkpoint.dependsOn) proposal.task.dependencies.push({ projectId, objectiveId,
        predecessorType: 'checkpoint', predecessorId: dependency, successorTaskId: proposal.task.taskId, kind: 'requires_acceptance' });
    }
    const verifiers = proposals.filter((entry) => entry.role === 'verifier');
    for (const proposal of proposals) {
      if (proposal.role === 'auditor' && proposal.dependsOnVerifierEvidence) {
        const verifier = verifiers[0] || peers.map((task) => ({ role: task.role, taskId: task.taskId, attemptId: task.attemptId })).find((entry) => entry.role === 'verifier');
        if (!verifier) fail('review_verifier_evidence_missing');
        proposal.task.dependencies.push({ projectId, objectiveId,
          predecessorType: 'task', predecessorId: verifier.taskId, successorTaskId: proposal.task.taskId, kind: 'requires_output' });
      }
    }
    const tx = this.db.transaction(() => {
      this.#addCandidateReference(candidateId, projectId, objectiveId, 'review_context', contextId);
      this.db.prepare('INSERT OR IGNORE INTO review_contexts(context_id,project_id,objective_id,checkpoint_id,candidate_id,context_json,context_digest,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(contextId, projectId, objectiveId, checkpointId, candidateId, json(context), contextDigest, this.now());
      for (const proposal of proposals) {
        const task = proposal.task;
        this.db.prepare('INSERT INTO review_tasks(task_id,project_id,objective_id,checkpoint_id,candidate_id,context_id,role,task_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(task.taskId, projectId, objectiveId, checkpointId, candidateId, contextId, task.role, json(task), 'queued', this.now());
      }
      const event = this.events.appendInTransaction(projectId, { eventType: 'review.tasks_proposed', objectRevision: objective.goalRevision,
        payload: { objectiveId, checkpointId, candidateId, contextId, taskIds: proposals.map((entry) => entry.taskId), dependencyCount: deps.length },
        candidateId, dedupeKey: `review-context:${contextId}:proposed:${digest(proposals.map((entry) => entry.taskId))}` });
      this.#hook({ type: 'review.tasks_proposed', context, tasks: proposals.map((entry) => entry.task), event });
      return proposals.map((entry) => ({ task: deepFreeze(entry.task), context: deepFreeze(context) }));
    });
    return tx.immediate();
  }

  getReviewTask(taskId) {
    const row = this.db.prepare('SELECT task_json FROM review_tasks WHERE task_id=?').get(taskId);
    return row ? deepFreeze(parse(row.task_json)) : null;
  }

  #registered(taskId) {
    const row = this.db.prepare(`SELECT t.task_json,c.context_json FROM review_tasks t
      JOIN review_contexts c ON c.context_id=t.context_id
      JOIN review_contexts r ON r.context_id=t.context_id WHERE t.task_id=?`).get(taskId);
    if (!row) return null;
    const task = parse(row.task_json);
    const context = parse(row.context_json);
    const candidate = this.candidates.get(task.baseCandidateId);
    const bindingRow = this.db.prepare('SELECT * FROM review_attempt_bindings WHERE task_id=?').get(taskId);
    return candidate ? { task, context, candidate, binding: bindingRow ? {
      attemptId: bindingRow.attempt_id, claimId: bindingRow.claim_id, fencingToken: bindingRow.fencing_token,
      ownerGeneration: bindingRow.owner_generation, selectedSettingsDigest: bindingRow.selected_settings_digest,
      providerContextId: bindingRow.provider_context_id, threadId: bindingRow.thread_id,
      attempt: parse(bindingRow.attempt_json), claim: parse(bindingRow.claim_json),
    } : null } : null;
  }

  bindClaimedAttempt({ task, attempt, claim } = {}) {
    if (!task || !attempt || !claim || typeof task.taskId !== 'string') fail('review_claim_binding_invalid');
    const registered = this.#registered(task.taskId);
    if (!registered || !frozenReviewMatches(task, registered)) fail('review_task_binding_invalid');
    const expected = registered.task;
    if (attempt.projectId !== expected.projectId || attempt.objectiveId !== expected.objectiveId || attempt.taskId !== expected.taskId
      || claim.projectId !== expected.projectId || claim.objectiveId !== expected.objectiveId || claim.taskId !== expected.taskId
      || claim.role !== expected.role || attempt.attemptId !== claim.attemptId || claim.state !== 'active'
      || attempt.fencingToken !== claim.fencingToken || attempt.executionGeneration !== claim.ownerGeneration
      || attempt.contractDigest !== stableDigest(expected) || !attempt.providerContextId
      || typeof attempt.selectedSettingsDigest !== 'string' || !attempt.capturedControls
      || attempt.capturedControls.schedulerGeneration !== claim.ownerGeneration
      || attempt.capturedControls.selectedSettingsKnown !== true) fail('review_claim_binding_invalid');
    if (this.#sync(this.authorizeBinding({ task: clone(expected), attempt: clone(attempt), claim: clone(claim) }), 'claim_binding_authorization_async') !== true) fail('review_claim_binding_unauthorized');
    if (registered.binding) {
      if (registered.binding.attemptId === attempt.attemptId && registered.binding.claimId === claim.claimId
        && registered.binding.fencingToken === claim.fencingToken) return deepFreeze({ task: expected, attempt, claim });
      fail('review_claim_binding_conflict');
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO review_attempt_bindings(task_id,project_id,objective_id,attempt_id,claim_id,fencing_token,owner_generation,
        selected_settings_digest,provider_context_id,attempt_json,claim_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(task.taskId, expected.projectId, expected.objectiveId, attempt.attemptId, claim.claimId, claim.fencingToken,
          claim.ownerGeneration, attempt.selectedSettingsDigest, attempt.providerContextId, json(attempt), json(claim), this.now());
      const event = this.events.appendInTransaction(expected.projectId, { eventType: 'review.attempt_bound', objectRevision: expected.revision,
        payload: { objectiveId: expected.objectiveId, checkpointId: expected.checkpointId, taskId: expected.taskId,
          attemptId: attempt.attemptId, claimId: claim.claimId, fencingToken: claim.fencingToken }, candidateId: expected.baseCandidateId,
        taskId: expected.taskId, attemptId: attempt.attemptId, dedupeKey: `review-attempt:${attempt.attemptId}:bound` });
      this.#hook({ type: 'review.attempt_bound', task: expected, attempt, claim, event });
      return { task: expected, attempt, claim };
    });
    return deepFreeze(tx.immediate());
  }

  pinObservedThread({ taskId, attemptId, fencingToken, providerContextId, threadId } = {}) {
    id(taskId, 'taskId'); id(attemptId, 'attemptId'); id(providerContextId, 'providerContextId'); id(threadId, 'threadId');
    const registered = this.#registered(taskId);
    const binding = registered?.binding;
    if (!binding || binding.attemptId !== attemptId || binding.fencingToken !== fencingToken
      || binding.providerContextId !== providerContextId) fail('review_thread_binding_invalid');
    if (this.#sync(this.authorizeThread({ task: clone(registered.task), binding: clone(binding), threadId }), 'thread_binding_authorization_async') !== true) fail('review_thread_binding_unauthorized');
    if (binding.threadId && binding.threadId !== threadId) fail('review_thread_binding_conflict');
    if (binding.threadId === threadId) return threadId;
    const tx = this.db.transaction(() => {
      const updated = this.db.prepare('UPDATE review_attempt_bindings SET thread_id=? WHERE task_id=? AND attempt_id=? AND fencing_token=? AND provider_context_id=? AND thread_id IS NULL')
        .run(threadId, taskId, attemptId, fencingToken, providerContextId);
      if (updated.changes !== 1) fail('review_thread_binding_conflict');
      const event = this.events.appendInTransaction(registered.task.projectId, { eventType: 'review.thread_bound', objectRevision: registered.task.revision,
        payload: { objectiveId: registered.task.objectiveId, taskId, attemptId, threadId }, candidateId: registered.task.baseCandidateId,
        taskId, attemptId, dedupeKey: `review-attempt:${attemptId}:thread` });
      this.#hook({ type: 'review.thread_bound', task: registered.task, attemptId, threadId, event });
      return threadId;
    });
    return tx.immediate();
  }

  isFrozenReview(input) {
    const task = input?.task || input;
    if (!task || typeof task.taskId !== 'string') return false;
    const registered = this.#registered(task.taskId);
    return Boolean(registered && frozenReviewMatches(task, registered));
  }

  prepareReviewInput(taskId, destination) {
    const registered = this.#registered(id(taskId, 'taskId'));
    if (!registered) fail('review_task_missing');
    const expected = this.candidates.readManifest(registered.context.candidateManifestDigest);
    if (expected.digest !== registered.context.candidateManifestDigest) fail('review_candidate_manifest_mismatch');
    const target = path.resolve(destination);
    if (within(this.candidates.workspace, target) || within(target, this.candidates.workspace)) fail('review_input_destination_unsafe');
    this.candidates.materialize(registered.task.baseCandidateId, target);
    const actual = treeManifest(target);
    if (actual.digest !== digest(expected.entries.map(({ path: filePath, mode, size, digest: fileDigest }) => ({ path: filePath, mode, size, digest: fileDigest })))) {
      fs.rmSync(target, { recursive: true, force: true });
      fail('review_input_materialization_mismatch');
    }
    const record = { taskId, candidateId: registered.task.baseCandidateId, contextId: registered.context.contextId,
      inputManifestDigest: expected.digest, destination: target, treeDigest: actual.digest };
    return deepFreeze(record);
  }

  verifyReviewInput(prepared) {
    if (!prepared || typeof prepared.destination !== 'string') return false;
    const registered = this.#registered(prepared.taskId);
    if (!registered || registered.task.baseCandidateId !== prepared.candidateId || registered.context.contextId !== prepared.contextId
      || registered.context.candidateManifestDigest !== prepared.inputManifestDigest) return false;
    try {
      const actual = treeManifest(prepared.destination);
      const expected = this.candidates.readManifest(prepared.inputManifestDigest);
      const expectedEntries = expected.entries.map(({ path: filePath, mode, size, digest: fileDigest }) => ({ path: filePath, mode, size, digest: fileDigest }));
      return actual.digest === digest(expectedEntries);
    } catch (_) { return false; }
  }

  settleReceipt({ taskId, outcome, evidenceRefs = [] } = {}) {
    id(taskId, 'taskId');
    const registered = this.#registered(taskId);
    if (!registered) fail('review_task_missing');
    const task = registered.task;
    this.#validateLiveReviewContext(registered);
    if (!registered.binding) fail('review_attempt_unbound');
    const binding = registered.binding;
    const actual = this.#sync(this.resolveAttempt({ projectId: task.projectId, objectiveId: task.objectiveId, taskId,
      attemptId: binding.attemptId, claimId: binding.claimId, fencingToken: binding.fencingToken,
      providerContextId: binding.providerContextId }), 'attempt_resolver_async');
    if (!actual || actual.projectId !== task.projectId || actual.objectiveId !== task.objectiveId || actual.taskId !== taskId
      || actual.attemptId !== binding.attemptId || actual.role !== task.role || !actual.threadId || actual.threadId !== binding.threadId
      || actual.claimId !== binding.claimId || actual.fencingToken !== binding.fencingToken
      || actual.ownerGeneration !== binding.ownerGeneration || actual.selectedSettingsDigest !== binding.selectedSettingsDigest
      || actual.providerContextId !== binding.providerContextId
      || actual.candidateId !== task.baseCandidateId || actual.state !== 'succeeded') fail('review_attempt_identity_invalid');
    if (this.#sync(this.authorizeSettlement({ task: clone(task), attempt: clone(actual), context: clone(registered.context) }), 'settlement_authorization_async') !== true) fail('review_settlement_unauthorized');
    if (this.#sync(this.verifyReviewExecution({ task: clone(task), attempt: clone(actual), context: clone(registered.context) }), 'execution_verifier_async') !== true) fail('review_execution_untrusted');
    if (actual.inputManifestDigest !== registered.context.candidateManifestDigest
      || actual.checksPassed !== true || actual.productWrites?.length || actual.outcome?.trusted !== true
      || actual.effect?.remoteQuiescent !== true || actual.effect?.processQuiescent !== true || actual.effect?.effectsSettled !== true) fail('review_input_or_checks_invalid');
    if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'inconclusive' && outcome !== 'blocked') fail('review_outcome_invalid');
    const receiptId = id(this.idFactory('review-receipt', `${task.projectId}:${task.objectiveId}:${taskId}:${actual.attemptId}`), 'receiptId');
    const receiptFields = { projectId: task.projectId, objectiveId: task.objectiveId, receiptId,
      checkpointId: task.checkpointId, candidateId: task.baseCandidateId, contextDigest: registered.context.contextDigest,
      inputManifestDigest: registered.context.candidateManifestDigest, checkPins: registered.context.checkPins,
      toolPins: registered.context.toolPins, profilePins: registered.context.profilePins, role: task.role,
      attemptId: actual.attemptId, outcome, evidenceRefs };
    const prior = this.db.prepare('SELECT receipt_json FROM review_receipts WHERE task_id=? OR attempt_id=?').get(taskId, actual.attemptId);
    if (prior) {
      const saved = parse(prior.receipt_json);
      const replay = projectReceipt({ ...receiptFields, createdAt: saved.createdAt });
      if (!sameReceiptCommand(saved, replay)) fail('review_receipt_duplicate_conflict');
      return saved;
    }
    const record = projectReceipt({ ...receiptFields, createdAt: this.now() });
    const tx = this.db.transaction(() => {
      const duplicate = this.db.prepare('SELECT receipt_json FROM review_receipts WHERE task_id=? OR attempt_id=?').get(taskId, actual.attemptId);
      if (duplicate) {
        const saved = parse(duplicate.receipt_json);
        if (!sameReceiptCommand(saved, record)) fail('review_receipt_duplicate_conflict');
        return saved;
      }
      this.#addCandidateReference(task.baseCandidateId, task.projectId, task.objectiveId, 'review_receipt', receiptId);
      this.db.prepare('INSERT INTO review_receipts(receipt_id,project_id,objective_id,checkpoint_id,candidate_id,context_id,task_id,attempt_id,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(receiptId, task.projectId, task.objectiveId, task.checkpointId, task.baseCandidateId, registered.context.contextId, taskId, actual.attemptId, json(record), record.createdAt);
      this.db.prepare('UPDATE review_tasks SET state=? WHERE task_id=?').run(outcome, taskId);
      const event = this.events.appendInTransaction(task.projectId, { eventType: 'review.receipt_settled', objectRevision: registered.context.ownerGoalRevision,
        payload: { objectiveId: task.objectiveId, checkpointId: task.checkpointId, receiptId, role: task.role, outcome },
        taskId, attemptId: actual.attemptId, candidateId: task.baseCandidateId, evidenceRef: evidenceRefs[0] || null,
        dedupeKey: `review-receipt:${receiptId}` });
      this.#hook({ type: 'review.receipt_settled', receipt: record, event });
      return record;
    });
    return tx.immediate();
  }

  getReceipt(receiptId) {
    const row = this.db.prepare('SELECT receipt_json FROM review_receipts WHERE receipt_id=?').get(receiptId);
    return row ? deepFreeze(parse(row.receipt_json)) : null;
  }

  qualification({ projectId, objectiveId, checkpointId, candidateId, role } = {}) {
    const direct = this.db.prepare(`SELECT r.receipt_json FROM review_receipts r WHERE r.project_id=? AND r.objective_id=? AND r.checkpoint_id=? AND r.candidate_id=? AND r.receipt_json IS NOT NULL`)
      .all(projectId, objectiveId, checkpointId, candidateId).map((row) => parse(row.receipt_json));
    const promoted = this.db.prepare(`SELECT r.receipt_json FROM review_promotions p JOIN review_receipts r ON r.receipt_id=p.receipt_id
      WHERE p.project_id=? AND p.objective_id=? AND p.checkpoint_id=? AND p.target_candidate_id=?`).all(projectId, objectiveId, checkpointId, candidateId).map((row) => parse(row.receipt_json));
    const records = [...direct, ...promoted].filter((entry) => entry.outcome === 'passed' && (!role || entry.role === role));
    return deepFreeze(records);
  }

  promoteReceipt({ receiptId, targetCandidateId } = {}, attestation) {
    id(receiptId, 'receiptId'); id(targetCandidateId, 'targetCandidateId');
    const sourceRow = this.db.prepare('SELECT project_id,objective_id,checkpoint_id,candidate_id,context_id,receipt_json FROM review_receipts WHERE receipt_id=?').get(receiptId);
    const sourceReceipt = sourceRow && parse(sourceRow.receipt_json);
    if (!sourceReceipt || sourceReceipt.outcome !== 'passed' || sourceReceipt.receiptId !== receiptId
      || sourceReceipt.projectId !== sourceRow.project_id || sourceReceipt.objectiveId !== sourceRow.objective_id
      || sourceReceipt.checkpointId !== sourceRow.checkpoint_id || sourceReceipt.candidateId !== sourceRow.candidate_id
      || typeof sourceReceipt.contextDigest !== 'string' || typeof sourceReceipt.inputManifestDigest !== 'string') fail('promotion_source_receipt_invalid');
    const sourceContextRow = this.db.prepare(`SELECT context_id,project_id,objective_id,checkpoint_id,candidate_id,context_json,context_digest
      FROM review_contexts WHERE context_id=? AND project_id=? AND objective_id=? AND checkpoint_id=? AND candidate_id=?`)
      .get(sourceRow.context_id, sourceRow.project_id, sourceRow.objective_id, sourceRow.checkpoint_id, sourceRow.candidate_id);
    const sourceContext = sourceContextRow && parse(sourceContextRow.context_json);
    const sourceContextCore = sourceContext && { ...sourceContext };
    if (sourceContextCore) { delete sourceContextCore.contextId; delete sourceContextCore.contextDigest; }
    if (!sourceContext || sourceContext.contextId !== sourceRow.context_id || sourceContext.contextDigest !== sourceReceipt.contextDigest
      || sourceContextRow.context_digest !== sourceReceipt.contextDigest || sourceContext.projectId !== sourceRow.project_id
      || sourceContext.objectiveId !== sourceRow.objective_id || sourceContext.checkpointId !== sourceRow.checkpoint_id
      || sourceContext.candidateId !== sourceRow.candidate_id || sourceContext.candidateManifestDigest !== sourceReceipt.inputManifestDigest
      || digest(sourceContextCore) !== sourceReceipt.contextDigest) fail('promotion_source_context_invalid');
    const checkpoint = this.#getCheckpoint(sourceReceipt.projectId, sourceReceipt.objectiveId, sourceReceipt.checkpointId);
    const candidate = this.candidates.get(targetCandidateId);
    if (!sourceContext || !checkpoint || !candidate || candidate.status !== 'known' || candidate.projectId !== sourceReceipt.projectId || candidate.objectiveId !== sourceReceipt.objectiveId) fail('promotion_target_invalid');
    if (candidate.checkIdentity !== checkpoint.checkIdentity
      || digestValue(candidate.environmentDigest, 'candidate.environmentDigest') !== checkpoint.environmentDigest) fail('promotion_identity_changed');
    const objective = this.#sync(this.currentObjective({ projectId: candidate.projectId, objectiveId: candidate.objectiveId }), 'objective_resolver_async');
    if (!objective || objective.goalRevision !== sourceContext.ownerGoalRevision || digestValue(objective.requirementDigest, 'requirementDigest') !== sourceContext.requirementDigest
      || digestValue(objective.checksDigest, 'checksDigest') !== sourceContext.checksDigest) fail('promotion_owner_context_changed');
    const manifest = this.candidates.readManifest(candidate.manifestDigest);
    const closure = this.#closure({ projectId: candidate.projectId, objectiveId: candidate.objectiveId,
      checkpointId: sourceReceipt.checkpointId, candidate: this.candidates.projectDeliveryCandidate(targetCandidateId), checkpoint, objective, manifest });
    const targetCore = { projectId: candidate.projectId, objectiveId: candidate.objectiveId, checkpointId: sourceReceipt.checkpointId,
      candidateId: targetCandidateId, candidateManifestDigest: manifest.digest, ownerGoalRevision: objective.goalRevision,
      requirementDigest: sourceContext.requirementDigest, checksDigest: sourceContext.checksDigest,
      checkIdentity: checkpoint.checkIdentity, checkPins: checkpoint.checkPins, toolPins: checkpoint.toolPins,
      profilePins: checkpoint.profilePins, environmentDigest: checkpoint.environmentDigest, closure };
    if (!samePromotionIdentity({ ...sourceContext, candidateId: sourceReceipt.candidateId }, targetCore)) fail('promotion_identity_changed');
    if (this.#sync(this.attestPromotion({ sourceReceipt: clone(sourceReceipt), sourceContext: clone(sourceContext), target: clone(targetCore), attestation }), 'promotion_attestation_async') !== true) fail('promotion_attestation_invalid');
    const targetContextId = id(this.idFactory('review-context', `${candidate.projectId}:${candidate.objectiveId}:${sourceReceipt.checkpointId}:${targetCandidateId}:${digest(targetCore)}`), 'targetContextId');
    const promotionId = id(this.idFactory('review-promotion', `${receiptId}:${targetCandidateId}:${targetContextId}`), 'promotionId');
    const targetContextDigest = digest(targetCore);
    const attestationDigest = digest(attestation);
    const existingRow = this.db.prepare('SELECT promotion_json FROM review_promotions WHERE receipt_id=? AND target_candidate_id=?').get(receiptId, targetCandidateId);
    if (existingRow) {
      const saved = parse(existingRow.promotion_json);
      if (saved.receiptId !== receiptId || saved.targetCandidateId !== targetCandidateId
        || saved.targetContextId !== targetContextId || saved.targetContextDigest !== targetContextDigest
        || saved.attestationDigest !== attestationDigest) fail('review_promotion_duplicate_conflict');
      return deepFreeze(saved);
    }
    const promotion = { promotionId, receiptId, projectId: candidate.projectId, objectiveId: candidate.objectiveId,
      checkpointId: sourceReceipt.checkpointId, sourceCandidateId: sourceReceipt.candidateId, targetCandidateId,
      targetContextId, targetContextDigest, attestationDigest, createdAt: this.now() };
    const tx = this.db.transaction(() => {
      const duplicate = this.db.prepare('SELECT promotion_json FROM review_promotions WHERE receipt_id=? AND target_candidate_id=?').get(receiptId, targetCandidateId);
      if (duplicate) {
        const saved = parse(duplicate.promotion_json);
        if (saved.receiptId !== receiptId || saved.targetCandidateId !== targetCandidateId
          || saved.targetContextId !== targetContextId || saved.targetContextDigest !== targetContextDigest
          || saved.attestationDigest !== attestationDigest) fail('review_promotion_duplicate_conflict');
        return saved;
      }
      this.#addCandidateReference(targetCandidateId, candidate.projectId, candidate.objectiveId, 'review_promotion', promotionId);
      const targetContextJson = json({ ...targetCore, contextId: targetContextId, contextDigest: promotion.targetContextDigest });
      this.db.prepare('INSERT OR IGNORE INTO review_contexts(context_id,project_id,objective_id,checkpoint_id,candidate_id,context_json,context_digest,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(targetContextId, candidate.projectId, candidate.objectiveId, sourceReceipt.checkpointId, targetCandidateId, targetContextJson, promotion.targetContextDigest, promotion.createdAt);
      const savedContext = this.db.prepare('SELECT context_json,context_digest FROM review_contexts WHERE context_id=? AND project_id=? AND objective_id=? AND checkpoint_id=? AND candidate_id=?')
        .get(targetContextId, candidate.projectId, candidate.objectiveId, sourceReceipt.checkpointId, targetCandidateId);
      if (!savedContext || savedContext.context_json !== targetContextJson || savedContext.context_digest !== promotion.targetContextDigest) fail('review_promotion_context_conflict');
      this.db.prepare('INSERT INTO review_promotions(promotion_id,receipt_id,project_id,objective_id,checkpoint_id,source_candidate_id,target_candidate_id,target_context_id,promotion_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(promotionId, receiptId, candidate.projectId, candidate.objectiveId, sourceReceipt.checkpointId, sourceReceipt.candidateId, targetCandidateId, targetContextId, json(promotion), promotion.createdAt);
      const event = this.events.appendInTransaction(candidate.projectId, { eventType: 'review.receipt_promoted', objectRevision: objective.goalRevision,
        payload: { objectiveId: candidate.objectiveId, checkpointId: sourceReceipt.checkpointId, receiptId, promotionId, sourceCandidateId: sourceReceipt.candidateId, targetCandidateId },
        candidateId: targetCandidateId, dedupeKey: `review-promotion:${promotionId}` });
      this.#hook({ type: 'review.receipt_promoted', promotion, event });
      return promotion;
    });
    return tx.immediate();
  }

  canReviewTogether(leftTaskId, rightTaskId) {
    const left = this.#registered(leftTaskId);
    const right = this.#registered(rightTaskId);
    if (!left || !right || left.task.role !== 'auditor' || right.task.role !== 'auditor') return false;
    if (left.task.taskId === right.task.taskId) return false;
    if (left.binding && right.binding && left.binding.attemptId === right.binding.attemptId) return false;
    if (left.candidate.manifestDigest !== right.candidate.manifestDigest) return false;
    if (left.task.productWritePaths?.length || right.task.productWritePaths?.length) return false;
    const rightScratch = new Set(right.task.scratchWriteRoots || []);
    if ((left.task.scratchWriteRoots || []).some((root) => rightScratch.has(root))) return false;
    const rightResources = new Set(right.task.resourceClaims || []);
    if ((left.task.resourceClaims || []).some((claim) => rightResources.has(claim))) return false;
    if ([...left.task.dependencies, ...right.task.dependencies].some((dependency) =>
      dependency.predecessorType === 'task' && [left.task.taskId, right.task.taskId].includes(dependency.predecessorId))) return false;
    return closuresIndependent(left.context.closure, right.context.closure);
  }

  isFinalStabilized({ projectId, objectiveId, candidateId, requiredRoles = ['verifier'] } = {}) {
    const objective = this.#sync(this.currentObjective({ projectId, objectiveId }), 'objective_resolver_async');
    const candidate = this.candidates.get(candidateId);
    if (!objective || !candidate || objective.projectId !== projectId || objective.objectiveId !== objectiveId || candidate.projectId !== projectId || candidate.objectiveId !== objectiveId) return false;
    if (this.#sync(this.attestClosure({ kind: 'final-stabilization', projectId, objectiveId, candidate, objective }), 'closure_attestation_async')?.frozen !== true) return false;
    const checkpoints = this.checkpointInventory({ projectId, objectiveId });
    for (const checkpoint of checkpoints) {
      const record = this.#getCheckpoint(projectId, objectiveId, checkpoint.checkpointId);
      if (!record || !record.critical) continue;
      for (const role of requiredRoles) if (!this.qualification({ projectId, objectiveId, checkpointId: checkpoint.checkpointId, candidateId, role }).length) return false;
    }
    return true;
  }

  finalizationProjection({ projectId, objectiveId, candidateId, requiredRoles = ['verifier'] } = {}) {
    id(projectId, 'projectId'); id(objectiveId, 'objectiveId'); id(candidateId, 'candidateId');
    if (!Array.isArray(requiredRoles) || requiredRoles.length > 20) fail('review_final_roles_invalid');
    const roles = [...new Set(requiredRoles.map((role) => id(role, 'requiredRole')))].sort();
    if (roles.length !== requiredRoles.length) fail('review_final_roles_duplicate');

    const objective = this.#sync(this.currentObjective({ projectId, objectiveId }), 'objective_resolver_async');
    const candidate = this.candidates.get(candidateId);
    if (!objective || objective.projectId !== projectId || objective.objectiveId !== objectiveId
      || !candidate || candidate.projectId !== projectId || candidate.objectiveId !== objectiveId || candidate.status !== 'known') {
      fail('review_final_identity_invalid');
    }
    const manifest = this.candidates.readManifest(candidate.manifestDigest);
    if (manifest.digest !== candidate.manifestDigest) fail('review_final_manifest_invalid');
    const deliveryCandidate = this.candidates.projectDeliveryCandidate(candidateId);
    const finalClosure = this.#sync(this.attestClosure({ kind: 'final-stabilization', projectId, objectiveId, candidate, objective }), 'closure_attestation_async');
    const checkpoints = this.checkpointInventory({ projectId, objectiveId });
    const requirements = [];
    const checkpointContexts = new Map();
    for (const entry of checkpoints) {
      const checkpoint = this.#getCheckpoint(projectId, objectiveId, entry.checkpointId);
      if (!checkpoint) fail('review_final_checkpoint_missing');
      const identityCurrent = checkpoint.goalRevision === objective.goalRevision
        && checkpoint.requirementDigest === digestValue(objective.requirementDigest, 'requirementDigest')
        && checkpoint.checksDigest === digestValue(objective.checksDigest, 'checksDigest')
        && checkpoint.checkIdentity === candidate.checkIdentity
        && checkpoint.environmentDigest === digestValue(candidate.environmentDigest, 'candidate.environmentDigest');
      const closure = identityCurrent
        ? this.#closure({ projectId, objectiveId, checkpointId: checkpoint.checkpointId,
          candidate: deliveryCandidate, checkpoint, objective, manifest })
        : { known: false, checkpointId: checkpoint.checkpointId, readManifest: [], checkpointAncestors: [], digest: null };
      checkpointContexts.set(checkpoint.checkpointId, { checkpoint, closure, identityCurrent });
      requirements.push({ checkpointId: checkpoint.checkpointId, kind: checkpoint.kind, critical: checkpoint.critical,
        goalRevision: checkpoint.goalRevision, requirementDigest: checkpoint.requirementDigest,
        checksDigest: checkpoint.checksDigest, checkIdentity: checkpoint.checkIdentity,
        checkPins: [...checkpoint.checkPins], toolPins: [...checkpoint.toolPins], profilePins: [...checkpoint.profilePins],
        environmentDigest: checkpoint.environmentDigest, dependsOn: [...checkpoint.dependsOn],
        closure: clone(closure), requiredRoles: checkpoint.critical ? roles : [] });
    }

    const receiptRows = this.db.prepare(`SELECT r.receipt_id,r.project_id,r.objective_id,r.checkpoint_id,r.candidate_id,
        r.context_id,r.receipt_json,c.context_json,c.context_digest,NULL AS promotion_json,NULL AS promotion_id,
        r.candidate_id AS target_candidate_id,'direct' AS binding_kind,NULL AS promotion_project_id,
        NULL AS promotion_objective_id,NULL AS promotion_checkpoint_id,NULL AS promotion_source_candidate_id
      FROM review_receipts r LEFT JOIN review_contexts c ON c.context_id=r.context_id
      WHERE r.project_id=? AND r.objective_id=? AND r.candidate_id=?
      UNION ALL
      SELECT r.receipt_id,r.project_id,r.objective_id,r.checkpoint_id,r.candidate_id,
        p.target_context_id AS context_id,r.receipt_json,c.context_json,c.context_digest,p.promotion_json,
        p.promotion_id,p.target_candidate_id,'promotion' AS binding_kind,p.project_id AS promotion_project_id,
        p.objective_id AS promotion_objective_id,p.checkpoint_id AS promotion_checkpoint_id,
        p.source_candidate_id AS promotion_source_candidate_id
      FROM review_promotions p
      JOIN review_receipts r ON r.receipt_id=p.receipt_id
      LEFT JOIN review_contexts c ON c.context_id=p.target_context_id
      WHERE p.project_id=? AND p.objective_id=? AND p.target_candidate_id=?
      ORDER BY 4,1,13`).all(projectId, objectiveId, candidateId, projectId, objectiveId, candidateId);

    const observedReceipts = [];
    const qualifiedKeys = new Set();
    const same = (left, right) => canonical(left) === canonical(right);
    const contextCore = (value) => {
      const core = { ...value };
      delete core.contextId;
      delete core.contextDigest;
      return core;
    };
    const contextValid = (context, contextId, contextDigest, scope) => Boolean(context && context.contextId === contextId
      && context.contextDigest === contextDigest && digest(contextCore(context)) === contextDigest
      && context.projectId === scope.projectId && context.objectiveId === scope.objectiveId
      && context.checkpointId === scope.checkpointId && context.candidateId === scope.candidateId
      && context.candidateManifestDigest === scope.manifestDigest);

    for (const row of receiptRows) {
      const receipt = parse(row.receipt_json);
      const context = row.context_json ? parse(row.context_json) : null;
      const identityValid = receipt.receiptId === row.receipt_id && receipt.projectId === row.project_id
        && receipt.objectiveId === row.objective_id && receipt.checkpointId === row.checkpoint_id
        && receipt.candidateId === row.candidate_id && row.project_id === projectId && row.objective_id === objectiveId;
      if (!identityValid) fail('review_final_receipt_identity_invalid');

      let sourceContext = context;
      let sourceContextId = row.context_id;
      let sourceContextDigest = row.context_digest;
      let targetContext = context;
      let promotion = row.promotion_json ? parse(row.promotion_json) : null;
      let candidateBound = row.binding_kind === 'direct' && receipt.candidateId === candidateId;
      let bindingId = null;
      if (row.binding_kind === 'promotion') {
        promotion = promotion || {};
        bindingId = row.promotion_id;
        candidateBound = promotion.promotionId === row.promotion_id && promotion.receiptId === receipt.receiptId
          && promotion.projectId === row.promotion_project_id && promotion.projectId === projectId
          && promotion.objectiveId === row.promotion_objective_id && promotion.objectiveId === objectiveId
          && promotion.checkpointId === row.promotion_checkpoint_id && promotion.checkpointId === receipt.checkpointId
          && promotion.sourceCandidateId === receipt.candidateId && promotion.targetCandidateId === candidateId
          && row.promotion_source_candidate_id === receipt.candidateId
          && promotion.targetContextId === row.context_id && promotion.targetContextDigest === row.context_digest
          && row.target_candidate_id === candidateId;
        const receiptContextId = this.db.prepare('SELECT context_id FROM review_receipts WHERE receipt_id=?').get(receipt.receiptId)?.context_id;
        const sourceRow = this.db.prepare(`SELECT context_id,context_json,context_digest FROM review_contexts
          WHERE context_id=? AND project_id=? AND objective_id=? AND checkpoint_id=? AND candidate_id=?`)
          .get(receiptContextId, projectId, objectiveId, receipt.checkpointId, receipt.candidateId);
        if (!sourceRow) fail('review_final_source_context_missing');
        sourceContext = parse(sourceRow.context_json);
        sourceContextId = sourceRow.context_id;
        sourceContextDigest = sourceRow.context_digest;
      }

      const sourceContextValid = contextValid(sourceContext, sourceContextId, sourceContextDigest, {
        projectId, objectiveId, checkpointId: receipt.checkpointId, candidateId: receipt.candidateId,
        manifestDigest: receipt.inputManifestDigest,
      });
      const sourceReceiptMatches = sourceContextValid && receipt.contextDigest === sourceContextDigest
        && same(receipt.checkPins, sourceContext.checkPins) && same(receipt.toolPins, sourceContext.toolPins)
        && same(receipt.profilePins, sourceContext.profilePins);
      let targetContextValid = row.binding_kind === 'direct' ? sourceContextValid
        : contextValid(targetContext, row.context_id, row.context_digest, {
          projectId, objectiveId, checkpointId: receipt.checkpointId, candidateId,
          manifestDigest: manifest.digest,
        });
      if (row.binding_kind === 'promotion') {
        const sourceCore = contextCore(sourceContext || {});
        const targetCore = contextCore(targetContext || {});
        targetContextValid = targetContextValid && samePromotionIdentity(sourceCore, targetCore)
          && promotion.targetContextDigest === row.context_digest;
      }

      const pinned = checkpointContexts.get(receipt.checkpointId);
      const checkpoint = pinned?.checkpoint;
      const currentClosure = pinned?.closure;
      const contextForPins = row.binding_kind === 'direct' ? sourceContext : targetContext;
      const currentPins = Boolean(checkpoint && pinned.identityCurrent && currentClosure?.known
        && contextForPins?.ownerGoalRevision === objective.goalRevision
        && contextForPins?.requirementDigest === checkpoint.requirementDigest
        && contextForPins?.checksDigest === checkpoint.checksDigest
        && contextForPins?.checkIdentity === checkpoint.checkIdentity
        && contextForPins?.environmentDigest === checkpoint.environmentDigest
        && same(contextForPins?.checkPins, checkpoint.checkPins)
        && same(contextForPins?.toolPins, checkpoint.toolPins)
        && same(contextForPins?.profilePins, checkpoint.profilePins)
        && same(contextForPins?.closure, currentClosure)
        && receipt.checkPins && same(receipt.checkPins, checkpoint.checkPins)
        && same(receipt.toolPins, checkpoint.toolPins) && same(receipt.profilePins, checkpoint.profilePins)
        && (row.binding_kind === 'direct' ? receipt.inputManifestDigest === manifest.digest
          : targetContext?.candidateManifestDigest === manifest.digest) && candidateBound);
      const valid = sourceReceiptMatches && targetContextValid && currentPins;
      const qualified = valid && receipt.outcome === 'passed';
      if (qualified) qualifiedKeys.add(`${receipt.checkpointId}\0${receipt.role}`);
      observedReceipts.push({ bindingKind: row.binding_kind, bindingId, targetCandidateId: candidateId,
        receipt: clone(receipt), sourceContextId, sourceContextDigest, targetContextId: row.context_id,
        targetContextDigest: row.context_digest, current: valid, qualified,
        currentClosureDigest: currentClosure?.digest ?? null });
    }

    const missingReceipts = requirements.flatMap((requirement) => requirement.requiredRoles
      .filter((role) => !qualifiedKeys.has(`${requirement.checkpointId}\0${role}`))
      .map((role) => ({ checkpointId: requirement.checkpointId, role })));

    const reviewRows = this.db.prepare(`SELECT r.task_id,r.checkpoint_id,r.candidate_id,r.role,r.task_json,r.state,
        r.context_id,c.context_json,c.context_digest,b.attempt_id,b.claim_id,b.fencing_token,b.provider_context_id
      FROM review_tasks r LEFT JOIN review_attempt_bindings b ON b.task_id=r.task_id
      LEFT JOIN review_contexts c ON c.context_id=r.context_id AND c.project_id=r.project_id
        AND c.objective_id=r.objective_id AND c.checkpoint_id=r.checkpoint_id AND c.candidate_id=r.candidate_id
      WHERE r.project_id=? AND r.objective_id=? ORDER BY r.task_id`).all(projectId, objectiveId);
    const pendingReviewTasks = [];
    const reviewTaskIds = new Set();
    for (const row of reviewRows) {
      const task = parse(row.task_json);
      if (task.taskId !== row.task_id || task.projectId !== projectId || task.objectiveId !== objectiveId
        || task.checkpointId !== row.checkpoint_id || task.baseCandidateId !== row.candidate_id || task.role !== row.role) {
        fail('review_final_task_identity_invalid');
      }
      if (reviewTaskIds.has(row.task_id)) fail('review_final_task_duplicate');
      reviewTaskIds.add(row.task_id);
      const receiptRow = this.db.prepare('SELECT receipt_json FROM review_receipts WHERE task_id=?').get(row.task_id);
      const receipt = receiptRow ? parse(receiptRow.receipt_json) : null;
      const settled = Boolean(receipt && receipt.projectId === projectId && receipt.objectiveId === objectiveId
        && receipt.checkpointId === row.checkpoint_id && receipt.candidateId === row.candidate_id
        && receipt.role === row.role && receipt.outcome === row.state
        && ['passed', 'failed', 'inconclusive', 'blocked'].includes(row.state));
      const pinned = checkpointContexts.get(row.checkpoint_id);
      const checkpoint = pinned?.checkpoint;
      const context = row.context_json ? parse(row.context_json) : null;
      const currentContext = Boolean(row.candidate_id === candidateId && checkpoint && pinned.identityCurrent
        && contextValid(context, row.context_id, row.context_digest, { projectId, objectiveId,
          checkpointId: row.checkpoint_id, candidateId, manifestDigest: manifest.digest })
        && context.ownerGoalRevision === objective.goalRevision
        && context.requirementDigest === checkpoint.requirementDigest
        && context.checksDigest === checkpoint.checksDigest
        && context.checkIdentity === checkpoint.checkIdentity
        && context.environmentDigest === checkpoint.environmentDigest
        && same(context.checkPins, checkpoint.checkPins)
        && same(context.toolPins, checkpoint.toolPins)
        && same(context.profilePins, checkpoint.profilePins)
        && same(context.closure, pinned.closure));
      let liveBinding = false;
      if (row.attempt_id || row.claim_id) {
        const actual = this.#sync(this.resolveAttempt({ projectId, objectiveId, taskId: row.task_id,
          attemptId: row.attempt_id, claimId: row.claim_id, fencingToken: row.fencing_token,
          providerContextId: row.provider_context_id }), 'attempt_resolver_async');
        const claimState = actual?.claimState || actual?.claim?.state;
        const effect = actual?.effect;
        liveBinding = !actual || !actual.state || ['claimed', 'running', 'settling', 'unknown'].includes(actual.state)
          || !['released'].includes(claimState) || effect?.remoteQuiescent !== true
          || effect?.processQuiescent !== true || effect?.effectsSettled !== true;
      }
      if (!settled && (currentContext || liveBinding)) pendingReviewTasks.push({ taskId: row.task_id, checkpointId: row.checkpoint_id,
        candidateId: row.candidate_id, role: row.role, state: row.state,
        boundAttemptId: row.attempt_id || null, boundClaimId: row.claim_id || null,
        fencingToken: row.fencing_token ?? null, reason: receipt ? 'receipt_state_mismatch' : 'receipt_missing' });
    }

    const objectivePins = { goalRevision: objective.goalRevision,
      requirementDigest: digestValue(objective.requirementDigest, 'requirementDigest'),
      checksDigest: digestValue(objective.checksDigest, 'checksDigest'), authorityRevision: objective.authorityRevision,
      controlRevision: objective.controlRevision };
    const candidatePins = { candidateId, integrationGeneration: candidate.integrationGeneration,
      manifestDigest: manifest.digest, environmentDigest: digestValue(candidate.environmentDigest, 'candidate.environmentDigest'),
      checkIdentity: candidate.checkIdentity };
    return deepFreeze({ projectId, objectiveId, objectivePins, candidatePins,
      finalClosure: finalClosure && typeof finalClosure === 'object' ? clone(finalClosure) : null,
      frozen: finalClosure?.frozen === true, requirements, receipts: observedReceipts, missingReceipts,
      pendingReviewTasks, complete: finalClosure?.frozen === true && missingReceipts.length === 0
        && pendingReviewTasks.length === 0 });
  }
}

module.exports = { CandidateReviewStore, treeManifest };
