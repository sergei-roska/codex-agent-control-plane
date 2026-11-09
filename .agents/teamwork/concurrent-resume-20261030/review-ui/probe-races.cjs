const fs = require('node:fs');
const path = require('node:path');
const testFile = path.resolve('test/launcher-decision-ui.test.js');
const prefix = fs.readFileSync(testFile, 'utf8').split('const failures = [')[0];
const helpers = new Function('require', '__dirname', prefix + '\nreturn {createHarness, functionSource, deferred, response, element};')(require, path.dirname(testFile));
const {createHarness, functionSource, deferred, response, element} = helpers;
const vm = require('node:vm');
(async () => {
  const h = createHarness();
  const c = h.context;
  const a = deferred(); const b = deferred();
  let count = 0;
  c.fetch = () => (++count === 1 ? a.promise : b.promise);
  const get = c.document.getElementById;
  const extras = {};
  c.document.getElementById = id => get(id) || (extras[id] ||= element());
  Object.assign(c, {initialSessionParam: null, window:{location:{href:'http://example.test/ui'}}, URL,
    history:{replaceState(){}}, renderProjectBar(){}, updateStatus(){}, loadTeam(){},
    setSession(id){ c.currentSessionId=id; c.sessionData=null; }, autoOpenLatest:false });
  vm.runInContext(functionSource('resetSessionView') + functionSource('selectProject'), c);
  const oldRequest = c.executeA2A({goal:'Old project message'});
  c.selectProject('project-b');
  c.currentSessionId = 'session-b';
  const newRequest = c.executeA2A({goal:'New project message'});
  const before = c.sending;
  a.resolve(response({success:true})); await oldRequest;
  console.log(JSON.stringify({scenario:'old completion while new request pending', before, after:c.sending, newerRequestStillPending:true}));
  b.resolve(response({success:true})); await newRequest;

  const j = createHarness(); const d = j.context;
  d.renderDecisionCard = () => {};
  const original = d.sessionData.turns[0].leadTask;
  const submission = d.submitDecision();
  original.state='TASK_STATE_WORKING'; d.updateDecisionCard();
  original.state='TASK_STATE_INPUT_REQUIRED';
  j.request.resolve(response({success:true,result:{status:{state:'TASK_STATE_INPUT_REQUIRED'},metadata:{pause:original.metadata.pause}}}));
  const result = await submission;
  console.log(JSON.stringify({scenario:'intermediate working poll then same semantic error', outcome:result.ok, selectedChoice:d.selectedDecisionOption, draft:j.elements.decisionAnswer.value}));
})();
