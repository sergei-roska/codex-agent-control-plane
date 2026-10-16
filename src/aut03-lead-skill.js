'use strict';

const crypto = require('node:crypto');
const { resolveSkillSelection } = require('./skill-catalog');

const AUT03_SKILL_ID = 'aut-03-lead-decomposition-v1';
const AUT03_SKILL_SHA256 = 'e0f10756e0486cdb827519edd8adfef866d84be449d6a10b1320412648e650ba';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseTrialRunIds(value = '') {
  if (value === '') return new Set();
  if (typeof value !== 'string') throw new TypeError('AUT-03 trial run IDs must be a string');
  const ids = value.split(',');
  if (ids.some((id) => !UUID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new TypeError('CODEX_A2A_AUT03_TRIAL_RUN_IDS must be a comma-separated list of unique lowercase UUIDs');
  }
  return new Set(ids);
}

function expectedLeadSkillContext(runId, trialRunIds, ownerEnabled = false, skillPin = { id: AUT03_SKILL_ID, sha256: AUT03_SKILL_SHA256 }) {
  const hasRunRestriction = trialRunIds instanceof Set && trialRunIds.size > 0;
  const enabled = ownerEnabled === true && (!hasRunRestriction || trialRunIds.has(runId));
  const allowlist = [...(trialRunIds instanceof Set ? trialRunIds : [])].sort();
  const allowlistSha256 = crypto.createHash('sha256').update(JSON.stringify(allowlist)).digest('hex');
  return {
    version: 1,
    enabled,
    allowlistSha256,
    pin: enabled ? { id: skillPin.id, sha256: skillPin.sha256 } : null,
  };
}

function resolveLeadSelectedSkills(context, catalog) {
  if (!context?.enabled) return [];
  return resolveSkillSelection(catalog, [context.pin.id], {
    audience: 'lead',
    pins: [{ id: context.pin.id, sha256: context.pin.sha256 }],
  });
}

function sameLeadSkillContext(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

module.exports = {
  AUT03_SKILL_ID,
  AUT03_SKILL_SHA256,
  expectedLeadSkillContext,
  parseTrialRunIds,
  resolveLeadSelectedSkills,
  sameLeadSkillContext,
};
