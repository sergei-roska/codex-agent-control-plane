'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../../..');
const filename = path.join(root, 'test/project-delivery-controller.test.js');
const prefix = fs.readFileSync(filename, 'utf8').split("test('")[0];
const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(prefix + `
test('ack write then failure rolls back correction and preserves independent history', (t) => {
 const fx=fixture({authenticateOwner:()=>true,ownerCorrectionAuthorized:()=>true,onOwnerCorrection:()=>fx.db.prepare('INSERT INTO correction_probe VALUES (?)').run('transient')});
 t.after(()=>{fx.controller.stop();fx.db.close();});
 fx.db.exec('CREATE TABLE correction_probe(value TEXT)'); fx.db.prepare('INSERT INTO correction_probe VALUES (?)').run('historical');
 fx.controller.receive({messageId:'historical-message',kind:'steering',payload:{instruction:'Existing evidence'}});
 const history=fx.inbox.get('historical-message');
 fx.controller.receive({messageId:'correction',kind:'owner_correction',source:'trusted-adapter',payload:{correction:{expectedGoalRevision:1,expectedAuthorityRevision:1,expectedControlRevision:1,requirementDigest:digest('c')}}});
 const before=fx.store.getObjective(projectId,objectiveId); const mark=fx.inbox.markApplied.bind(fx.inbox);
 fx.inbox.markApplied=(...args)=>{mark(...args); throw Object.assign(new Error('post-write acknowledgement failure'),{code:'ack_after_write'});};
 fx.controller.applyPendingOwnerCorrections();
 assert.deepEqual(fx.store.getObjective(projectId,objectiveId),before);
 assert.deepEqual(fx.db.prepare('SELECT value FROM correction_probe').all(),[{value:'historical'}]);
 assert.deepEqual(fx.inbox.get('historical-message'),history);
 assert.equal(fx.db.prepare('SELECT COUNT(*) n FROM backlog_owner_corrections').get().n,0);
 assert.equal(fx.inbox.get('correction').state,'blocked'); assert.equal(fx.inbox.get('correction').result.code,'ack_after_write');
});`, filename);
