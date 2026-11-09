'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { CandidateStore } = require('../../../src/candidate-store');
const { CandidateReviewStore } = require('../../../src/candidate-review');
const { BacklogStore, stableDigest } = require('../../../src/backlog-store');
const { VERSION } = require('../../../src/delivery-contracts');
const { TaskScheduler } = require('../../../src/task-scheduler');

const ENV = 'a'.repeat(64);
const CHECKS = 'b'.repeat(64);
const REQUIREMENTS = 'c'.repeat(64);
const SHA = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex');

function fixture(reviewOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-review-'));
  const workspace = path.join(root, 'repo');
  const storageDir = path.join(root, 'state', 'candidates');
  fs.mkdirSync(workspace);
  fs.cpSync(path.resolve(__dirname, '../../..', '.git'), path.join(workspace, '.git'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'A base\n');
  fs.writeFileSync(path.join(workspace, 'b.txt'), 'B base\n');

  const dbPath = path.join(root, 'state.sqlite');
  const db = new Database(dbPath);
  const backlogStore = new BacklogStore(db, { now: () => 1000, roleCapacities: { auditor: 8, verifier: 8 }, maxActiveTurns: 20,
    plannerReservedSlots: 1, selectedSettingsResolver: () => ({ model: 'review-test-model' }) });
  backlogStore.createObjective({ schemaVersion: VERSION, projectId: 'project', objectiveId: 'objective', sessionId: 'session-review',
    engineVersion: 'delivery-v1', goalRevision: 3, requirementDigest: `sha256:${REQUIREMENTS}`, checksDigest: `sha256:${CHECKS}`,
    authorityRevision: 2, controlRevision: 4, disposition: 'executing' });
  const candidateStore = new CandidateStore({ db, workspace, storageDir });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-g', projectId: 'project', objectiveId: 'objective',
    integrationGeneration: 1, sourceAttemptId: 'source-attempt-g', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  const objective = { projectId: 'project', objectiveId: 'objective', goalRevision: 3, requirementDigest: REQUIREMENTS,
    checksDigest: CHECKS, authorityRevision: 2, controlRevision: 4 };
  const known = new Map();
  const attemptFacts = new Map();
  const reviewStore = new CandidateReviewStore({ db, candidateStore,
    currentObjective: () => objective,
    checkpointInventory: ({ projectId, objectiveId }) => [...known.values()].map((cp) => ({ projectId, objectiveId, checkpointId: cp.checkpointId })),
    authorizeCheckpoint: () => true, authorizeProposal: () => true,
    attestClosure: ({ checkpointId, candidate }) => {
      if (checkpointId === undefined) return { frozen: true };
      const entry = known.get(checkpointId);
      if (!entry) return null;
      return { known: true, readManifest: entry.readManifest, checkpointAncestors: entry.checkpointAncestors || [] };
    },
    authorizeBinding: ({ attempt, claim }) => fxAttemptMatches(backlogStore, attempt, claim),
    authorizeThread: ({ binding, threadId }) => threadId === `thread-${binding.attemptId}`,
    resolveAttempt: ({ attemptId }) => attemptFacts.get(attemptId) || null,
    authorizeSettlement: () => true, verifyReviewExecution: () => true,
    attestPromotion: () => true,
    now: reviewOverrides.now || (() => 1000),
    ...reviewOverrides,
  });
  return { root, workspace, storageDir, dbPath, db, candidateStore, candidate, reviewStore, backlogStore, objective, known, attemptFacts };
}

function fxAttemptMatches(backlogStore, attempt, claim) {
  const storedAttempt = backlogStore.listAttempts('project', 'objective').find((entry) => entry.attemptId === attempt.attemptId);
  const storedClaim = backlogStore.listClaims('project', 'objective').find((entry) => entry.claimId === claim.claimId);
  const { contractSnapshot, ...attemptRecord } = storedAttempt || {};
  return storedAttempt && storedClaim && stableDigest(attemptRecord) === stableDigest(attempt)
    && stableDigest(contractSnapshot) === attempt.contractDigest
    && stableDigest(storedClaim) === stableDigest(claim);
}

function addCheckpoint(fx, checkpointId, file, ancestors = []) {
  const bytes = fs.readFileSync(path.join(fx.workspace, file));
  const readManifest = [{ path: file, digest: SHA(bytes) }];
  fx.known.set(checkpointId, { checkpointId, readManifest, checkpointAncestors: ancestors });
  return fx.reviewStore.registerCheckpoint({ projectId: 'project', objectiveId: 'objective', checkpointId,
    kind: 'risk_change', reason: `Inspect ${checkpointId}`, checkIdentity: 'check-set-v1', checkPins: ['check-v1'],
    toolPins: ['tool-v1'], profilePins: ['auditor-v1'], environmentDigest: ENV }, { source: 'owner' });
}

function propose(fx, checkpointId, reviewers) {
  return fx.reviewStore.proposeReviews({ projectId: 'project', objectiveId: 'objective', checkpointId,
    candidateId: fx.candidate.candidateId, reviewers }, { source: 'planner' });
}

function successfulAttempt(fx, proposal) {
  const current = fx.backlogStore.getObjective('project', 'objective');
  fx.backlogStore.applyPlan('project', 'objective', { schemaVersion: VERSION, expectedPlanRevision: current.planRevision,
    expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1, tasks: [{ task: proposal.task }], dependencies: [] });
  const [{ task, attempt, claim }] = fx.backlogStore.claimReady('project', 'objective', 0, { controlRevision: 4, limit: 1 });
  fx.reviewStore.bindClaimedAttempt({ task, attempt, claim });
  const threadId = `thread-${attempt.attemptId}`;
  fx.reviewStore.pinObservedThread({ taskId: task.taskId, attemptId: attempt.attemptId, fencingToken: claim.fencingToken,
    providerContextId: attempt.providerContextId, threadId });
  const fact = { ...attempt, projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
    claimId: claim.claimId, ownerGeneration: claim.ownerGeneration, role: task.role, threadId,
    candidateId: task.baseCandidateId, state: 'succeeded', inputManifestDigest: fx.candidate.manifestDigest,
    checksPassed: true, productWrites: [], outcome: { state: 'succeeded', trusted: true },
    effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } };
  fx.attemptFacts.set(attempt.attemptId, fact);
  return fact;
}


function check(name, fn) {
  try { fn(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { process.stdout.write(`FAIL ${name}: ${error.code || error.name}: ${error.message}\n`); process.exitCode = 1; }
}

check('receipt exact replay with advanced clock and database reopen', () => {
  let tick = 1000;
  const fx = fixture({ now: () => tick });
  try {
    addCheckpoint(fx, 'checkpoint-a', 'a.txt');
    const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
    successfulAttempt(fx, proposal);
    const receipt = fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed', evidenceRefs: ['report:a'] });
    tick = 2000;
    const replay = fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed', evidenceRefs: ['report:a'] });
    assert.deepEqual(replay, receipt);
    const db2 = new Database(fx.dbPath);
    try {
      const candidate2 = new CandidateStore({ db: db2, workspace: fx.workspace, storageDir: fx.storageDir });
      const review2 = new CandidateReviewStore({ db: db2, candidateStore: candidate2, now: () => 3000,
        currentObjective: () => fx.objective, checkpointInventory: ({projectId,objectiveId}) => [...fx.known.values()].map(cp => ({projectId,objectiveId,checkpointId:cp.checkpointId})),
        attestClosure: ({checkpointId}) => checkpointId ? {known:true,readManifest:fx.known.get(checkpointId).readManifest,checkpointAncestors:[]} : {frozen:true},
        resolveAttempt: ({attemptId}) => fx.attemptFacts.get(attemptId), authorizeSettlement: () => true, verifyReviewExecution: () => true });
      assert.deepEqual(review2.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed', evidenceRefs: ['report:a'] }), receipt);
    } finally { db2.close(); }
  } finally { fx.db.close(); fs.rmSync(fx.root, {recursive:true,force:true}); }
});

check('promotion exact replay with advanced clock', () => {
  let tick = 1000;
  const fx = fixture({ now: () => tick });
  try {
    addCheckpoint(fx, 'checkpoint-a', 'a.txt');
    const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
    successfulAttempt(fx, proposal);
    const receipt = fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed' });
    fs.writeFileSync(path.join(fx.workspace,'b.txt'),'B changed\n');
    const target = fx.candidateStore.createCandidate({ candidateId:'candidate-target',projectId:'project',objectiveId:'objective',parentCandidateId:fx.candidate.candidateId,
      integrationGeneration:2,sourceAttemptId:'target-attempt',environmentDigest:ENV,checkIdentity:'check-set-v1' });
    const first = fx.reviewStore.promoteReceipt({ receiptId:receipt.receiptId,targetCandidateId:target.candidateId }, {controller:'attested'});
    tick = 2000;
    const second = fx.reviewStore.promoteReceipt({ receiptId:receipt.receiptId,targetCandidateId:target.candidateId }, {controller:'attested'});
    assert.deepEqual(second, first);
  } finally { fx.db.close(); fs.rmSync(fx.root, {recursive:true,force:true}); }
});

check('settlement rejects old claim, generation, provider context, and thread', () => {
  const fx = fixture();
  try {
    addCheckpoint(fx, 'checkpoint-a', 'a.txt');
    const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
    const fact = successfulAttempt(fx, proposal);
    for (const [field, value] of [['claimId','old-claim'], ['ownerGeneration',fact.ownerGeneration + 1],
      ['providerContextId','wrong-context'], ['threadId','wrong-thread'], ['selectedSettingsDigest','sha256:' + 'e'.repeat(64)]]) {
      fx.attemptFacts.set(fact.attemptId, {...fact, [field]:value});
      assert.throws(() => fx.reviewStore.settleReceipt({taskId:proposal.task.taskId,outcome:'passed'}), {code:'review_attempt_identity_invalid'}, field);
    }
    fx.attemptFacts.set(fact.attemptId, fact);
    assert.equal(fx.reviewStore.settleReceipt({taskId:proposal.task.taskId,outcome:'passed'}).outcome,'passed');
  } finally { fx.db.close(); fs.rmSync(fx.root,{recursive:true,force:true}); }
});

check('promotion event failure rolls back context, event, and reference', () => {
  const fx = fixture({eventHook: ({type}) => { if (type === 'review.receipt_promoted') throw new Error('sink-failed'); }});
  try {
    addCheckpoint(fx, 'checkpoint-a', 'a.txt');
    const [proposal] = propose(fx, 'checkpoint-a', [{role:'auditor'}]);
    successfulAttempt(fx, proposal);
    const receipt = fx.reviewStore.settleReceipt({taskId:proposal.task.taskId,outcome:'passed'});
    fs.writeFileSync(path.join(fx.workspace,'b.txt'),'B changed\n');
    const target = fx.candidateStore.createCandidate({candidateId:'candidate-target',projectId:'project',objectiveId:'objective',parentCandidateId:fx.candidate.candidateId,
      integrationGeneration:2,sourceAttemptId:'target-attempt',environmentDigest:ENV,checkIdentity:'check-set-v1'});
    assert.throws(() => fx.reviewStore.promoteReceipt({receiptId:receipt.receiptId,targetCandidateId:target.candidateId},{controller:'attested'}), /sink-failed/);
    for (const table of ['review_promotions']) assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM review_contexts WHERE candidate_id=?').get(target.candidateId).n,0);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE candidate_id=? AND ref_type='review_promotion'").get(target.candidateId).n,0);
    assert.equal(fx.reviewStore.events.replay('project').filter(e => e.eventType === 'review.receipt_promoted').length,0);
  } finally { fx.db.close(); fs.rmSync(fx.root,{recursive:true,force:true}); }
});

check('receipt exact replay after database reopen', () => {
  const fx = fixture({now:()=>1000});
  let db2;
  try {
    addCheckpoint(fx,'checkpoint-a','a.txt');
    const [proposal] = propose(fx,'checkpoint-a',[{role:'auditor'}]);
    successfulAttempt(fx,proposal);
    const receipt = fx.reviewStore.settleReceipt({taskId:proposal.task.taskId,outcome:'passed',evidenceRefs:['report:a']});
    fx.db.close();
    db2 = new Database(fx.dbPath);
    const candidate2 = new CandidateStore({db:db2,workspace:fx.workspace,storageDir:fx.storageDir});
    const review2 = new CandidateReviewStore({db:db2,candidateStore:candidate2,now:()=>3000,
      currentObjective:()=>fx.objective,
      checkpointInventory:({projectId,objectiveId})=>[...fx.known.values()].map(cp=>({projectId,objectiveId,checkpointId:cp.checkpointId})),
      attestClosure:({checkpointId})=>checkpointId?{known:true,readManifest:fx.known.get(checkpointId).readManifest,checkpointAncestors:[]}:{frozen:true},
      resolveAttempt:({attemptId})=>fx.attemptFacts.get(attemptId),authorizeSettlement:()=>true,verifyReviewExecution:()=>true});
    assert.deepEqual(review2.settleReceipt({taskId:proposal.task.taskId,outcome:'passed',evidenceRefs:['report:a']}),receipt);
  } finally { if (db2) db2.close(); if (fx.db.open) fx.db.close(); fs.rmSync(fx.root,{recursive:true,force:true}); }
});


function commitWinnerAfterStaleRead(db, sql, winner) {
  const originalPrepare = db.prepare.bind(db);
  let fired = false;
  db.prepare = (query) => {
    const statement = originalPrepare(query);
    if (fired || query !== sql) return statement;
    return { get: (...args) => {
      const stale = statement.get(...args);
      if (!fired && !stale) {
        fired = true;
        db.prepare = originalPrepare;
        winner();
      }
      return stale;
    } };
  };
  return () => { db.prepare = originalPrepare; assert.equal(fired,true); };
}

check('committed receipt winner survives conflicting stale preflight', () => {
  const fx = fixture();
  try {
    addCheckpoint(fx,'checkpoint-a','a.txt');
    const [proposal] = propose(fx,'checkpoint-a',[{role:'auditor'}]);
    successfulAttempt(fx,proposal);
    let winner;
    const restore = commitWinnerAfterStaleRead(fx.db,
      'SELECT receipt_json FROM review_receipts WHERE task_id=? OR attempt_id=?',
      () => { winner = fx.reviewStore.settleReceipt({taskId:proposal.task.taskId,outcome:'passed'}); });
    assert.throws(() => fx.reviewStore.settleReceipt({taskId:proposal.task.taskId,outcome:'failed'}),{code:'review_receipt_duplicate_conflict'});
    restore();
    assert.equal(fx.reviewStore.getReceipt(winner.receiptId).outcome,'passed');
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE ref_type='review_receipt' AND ref_id=?").get(winner.receiptId).n,1);
    assert.equal(fx.reviewStore.events.replay('project').filter(e => e.eventType === 'review.receipt_settled').length,1);
    fx.candidateStore.collectGarbage();
    assert.equal(fx.candidateStore.get(fx.candidate.candidateId).status,'known');
  } finally { fx.db.close(); fs.rmSync(fx.root,{recursive:true,force:true}); }
});

check('committed promotion winner survives conflicting stale preflight', () => {
  const fx = fixture();
  try {
    addCheckpoint(fx,'checkpoint-a','a.txt');
    const [proposal] = propose(fx,'checkpoint-a',[{role:'auditor'}]);
    successfulAttempt(fx,proposal);
    const receipt = fx.reviewStore.settleReceipt({taskId:proposal.task.taskId,outcome:'passed'});
    fs.writeFileSync(path.join(fx.workspace,'b.txt'),'B changed\n');
    const target = fx.candidateStore.createCandidate({candidateId:'candidate-target',projectId:'project',objectiveId:'objective',parentCandidateId:fx.candidate.candidateId,
      integrationGeneration:2,sourceAttemptId:'target-attempt',environmentDigest:ENV,checkIdentity:'check-set-v1'});
    const command = {receiptId:receipt.receiptId,targetCandidateId:target.candidateId};
    let winner;
    const restore = commitWinnerAfterStaleRead(fx.db,
      'SELECT promotion_json FROM review_promotions WHERE receipt_id=? AND target_candidate_id=?',
      () => { winner = fx.reviewStore.promoteReceipt(command,{controller:'winner'}); });
    assert.throws(() => fx.reviewStore.promoteReceipt(command,{controller:'loser'}),{code:'review_promotion_duplicate_conflict'});
    restore();
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM review_promotions WHERE promotion_id=?').get(winner.promotionId).n,1);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE ref_type='review_promotion' AND ref_id=?").get(winner.promotionId).n,1);
    assert.equal(fx.reviewStore.events.replay('project').filter(e => e.eventType === 'review.receipt_promoted').length,1);
    fx.candidateStore.collectGarbage();
    assert.equal(fx.candidateStore.get(target.candidateId).status,'known');
  } finally { fx.db.close(); fs.rmSync(fx.root,{recursive:true,force:true}); }
});
