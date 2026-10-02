'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { startServer } = require('../src/server');
const { createTaskStore, openStateDatabase } = require('../src/durable-store');
const { ProductStore } = require('../src/product-store');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

function copyIfPresent(source, destination) {
  if (fs.existsSync(source)) fs.copyFileSync(source, destination);
}

function makeTask(id) {
  return {
    id,
    contextId: `ctx-${id}`,
    status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: { recoveryFixture: true },
  };
}

test('stopped-server backup restores pending work and startup reconciles interrupted tasks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-recovery-'));
  const workspace = path.join(root, 'workspace');
  const stateFile = path.join(root, 'state.sqlite');
  const artifactRoot = path.join(root, 'artifacts');
  const backupRoot = path.join(root, 'backup');
  const backupFile = path.join(backupRoot, 'state.sqlite');
  const backupArtifacts = path.join(backupRoot, 'artifacts');
  const taskId = 'interrupted-before-backup';
  fs.mkdirSync(workspace);
  fs.mkdirSync(backupRoot);

  let runtime = null;
  t.after(async () => {
    if (runtime) await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const options = () => ({
    listen: false,
    workspace,
    stateFile,
    tokenFile: path.join(root, 'token', 'a2a-token'),
    projectConfigFile: path.join(root, 'project.json'),
    workspaceLockDir: path.join(root, 'locks'),
    appServer: makeFakeAppServer(),
  });

  runtime = await startServer(options());
  const created = runtime.productStore.createTicket({
    commandId: 'm9-before-backup-create',
    title: 'Pending recovery work',
    description: 'This direct ticket and queued run must survive restore.',
  }).ticket;
  const submitted = runtime.productStore.submitTicket(created.ticketId, {
    commandId: 'm9-before-backup-submit',
    expectedVersion: created.version,
  }, { rolePack: 'legacy-orch', revision: 'recovery-test' });
  assert.equal(submitted.ticket.status, 'pending');
  assert.equal(submitted.run.status, 'queued');
  assert.equal(submitted.run.revisionId, created.currentRevisionId);

  const tasks = createTaskStore(runtime.state, 'orchestrator');
  await tasks.save(makeTask(taskId), new ServerCallContext());
  await runtime.close();
  runtime = null;

  // The stopped server has checkpointed SQLite. Copy its database and any WAL
  // sidecars together, along with the attachment tree, as the manual recovery
  // procedure requires.
  fs.copyFileSync(stateFile, backupFile);
  copyIfPresent(`${stateFile}-wal`, `${backupFile}-wal`);
  copyIfPresent(`${stateFile}-shm`, `${backupFile}-shm`);
  if (fs.existsSync(artifactRoot)) fs.cpSync(artifactRoot, backupArtifacts, { recursive: true });

  // Add a later ticket after the backup. It must be absent after restoration.
  const mutationState = await openStateDatabase({ filePath: stateFile });
  try {
    const mutationStore = new ProductStore({ db: mutationState.db, projectId: created.projectId });
    mutationStore.createTicket({ commandId: 'm9-after-backup-create', title: 'Post-backup mutation' });
  } finally {
    await mutationState.close();
  }

  // Restore only while stopped; remove newer SQLite sidecars so they cannot
  // replay writes against the selected backup.
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${stateFile}${suffix}`, { force: true });
  fs.copyFileSync(backupFile, stateFile);
  for (const suffix of ['-wal', '-shm']) copyIfPresent(`${backupFile}${suffix}`, `${stateFile}${suffix}`);
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  if (fs.existsSync(backupArtifacts)) fs.cpSync(backupArtifacts, artifactRoot, { recursive: true });
  if (fs.existsSync(artifactRoot)) fs.chmodSync(artifactRoot, 0o700);

  runtime = await startServer(options());
  const restoredTicket = runtime.productStore.getTicket(created.ticketId);
  assert.ok(restoredTicket);
  assert.equal(restoredTicket.status, 'pending');
  assert.equal(restoredTicket.version, submitted.ticket.version);
  assert.equal(restoredTicket.currentRevisionId, created.currentRevisionId);
  const restoredRevision = runtime.productStore.getRevision(created.ticketId, created.currentRevisionId);
  assert.equal(restoredRevision.description, 'This direct ticket and queued run must survive restore.');
  assert.equal(runtime.productStore.getRun(submitted.run.runId).status, 'queued');
  assert.equal(runtime.productStore.listTickets().some((ticket) => ticket.title === 'Post-backup mutation'), false);

  const reconciledTask = await createTaskStore(runtime.state, 'orchestrator').load(taskId, new ServerCallContext());
  assert.equal(reconciledTask.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(reconciledTask.metadata.pause.kind, 'restart');
});
