'use strict';
const assert = require('node:assert/strict');
const {validateDecision,classifyCodexError}=require('../../../src/contracts');
const decision={action:'finish',assignments:[],final:'run:r3:a0 found a local implementation bug. The engineer can fix it within the authorized scope; no owner action is needed.',resolutions:[],humanInput:null,goalAchieved:false};
validateDecision(decision,{roles:new Map(),attemptedRoles:new Set(),outcomeCount:1,openDecisionIds:new Set(),goalInvestigationRound:2,investigations:[{assignmentId:'run:r3:a0',round:3}]});
assert.equal(classifyCodexError(new Error('Selected model is at capacity. Please try a different model.')),'other');
console.log('Confirmed: local-fixable repeated finish validates; capacity message classifies as other.');
