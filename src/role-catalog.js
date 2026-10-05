'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalRoleId, roleDisplayName } = require('./role-names');

const DEFAULT_PROFILES_DIR = path.resolve(__dirname, '..', 'profiles');
const REQUIRED_FIELDS = [
  'name',
  'description',
  'model',
  'model_reasoning_effort',
  'sandbox_mode',
  'developer_instructions',
];
const STRING_FIELDS = new Set([...REQUIRED_FIELDS, 'display_name']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const SANDBOXES = new Set(['read-only', 'workspace-write']);
const TOOLS_TABLE = 'a2a_tools';
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

function parseProfile(source, filePath) {
  const values = Object.create(null);
  const tools = Object.create(null);
  let inTools = false;
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#')) continue;

    const table = line.match(/^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/);
    if (table) {
      if (table[1] !== TOOLS_TABLE) throw new Error(`${filePath}:${index + 1}: unknown table ${table[1]}`);
      if (inTools) throw new Error(`${filePath}:${index + 1}: duplicate table ${TOOLS_TABLE}`);
      inTools = true;
      continue;
    }
    if (inTools) {
      const toolField = line.match(/^(mcp_servers|skills)\s*=\s*(.*?)\s*(?:#.*)?$/);
      if (!toolField) throw new Error(`${filePath}:${index + 1}: unsupported ${TOOLS_TABLE} syntax`);
      const [, key, literal] = toolField;
      if (Object.hasOwn(tools, key)) throw new Error(`${filePath}:${index + 1}: duplicate field ${key}`);
      let parsed;
      try {
        parsed = JSON.parse(literal);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: invalid value for ${key}`, { cause: error });
      }
      if (key === 'skills' && typeof parsed !== 'boolean') {
        throw new Error(`${filePath}:${index + 1}: skills must be true or false`);
      }
      if (key === 'mcp_servers' && !(Array.isArray(parsed) && parsed.every((name) => typeof name === 'string' && MCP_NAME.test(name)))) {
        throw new Error(`${filePath}:${index + 1}: mcp_servers must be an array of server names`);
      }
      tools[key] = parsed;
      continue;
    }

    const multiline = line.match(/^([a-z_]+)\s*=\s*"""\s*$/);
    if (multiline) {
      const key = multiline[1];
      if (key !== 'developer_instructions') {
        throw new Error(`${filePath}:${index + 1}: multiline value is not allowed for ${key}`);
      }
      if (Object.hasOwn(values, key)) {
        throw new Error(`${filePath}:${index + 1}: duplicate field ${key}`);
      }

      const content = [];
      let closed = false;
      while (++index < lines.length) {
        const end = lines[index].match(/^\s*"""\s*(?:#.*)?$/);
        if (end) {
          closed = true;
          break;
        }
        content.push(lines[index]);
      }
      if (!closed) throw new Error(`${filePath}: unterminated developer_instructions`);
      values[key] = content.join('\n').trim();
      continue;
    }

    const assignment = line.match(/^([a-z_]+)\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
    if (!assignment) throw new Error(`${filePath}:${index + 1}: unsupported TOML syntax`);
    const [, key, literal] = assignment;
    if (!STRING_FIELDS.has(key)) throw new Error(`${filePath}:${index + 1}: unknown field ${key}`);
    if (Object.hasOwn(values, key)) throw new Error(`${filePath}:${index + 1}: duplicate field ${key}`);
    try {
      values[key] = JSON.parse(literal);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: invalid string for ${key}`, { cause: error });
    }
  }

  for (const key of REQUIRED_FIELDS) {
    if (typeof values[key] !== 'string' || values[key].trim() === '') {
      throw new Error(`${filePath}: required non-empty string field ${key} is missing`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.name)) {
    throw new Error(`${filePath}: invalid role name ${JSON.stringify(values.name)}`);
  }
  if (!EFFORTS.has(values.model_reasoning_effort)) {
    throw new Error(`${filePath}: unsupported model_reasoning_effort ${JSON.stringify(values.model_reasoning_effort)}`);
  }
  if (!SANDBOXES.has(values.sandbox_mode)) {
    throw new Error(`${filePath}: unsupported sandbox_mode ${JSON.stringify(values.sandbox_mode)}`);
  }
  if (!/^gpt-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(values.model)) {
    throw new Error(`${filePath}: invalid model ${JSON.stringify(values.model)}`);
  }
  const name = canonicalRoleId(values.name);
  return {
    name,
    displayName: values.display_name || roleDisplayName(name),
    sourceName: values.name,
    description: values.description,
    model: values.model,
    effort: values.model_reasoning_effort,
    sandbox: values.sandbox_mode,
    instructions: values.developer_instructions,
    tools: {
      mcpServers: [...new Set(tools.mcp_servers || [])],
      skills: tools.skills === true,
    },
  };
}

function runtimeInstructions(instructions, teamPath) {
  const resolved = instructions.replaceAll('{{TEAM_RULES}}', teamPath);
  if (resolved.includes('{{') || resolved.includes('}}')) {
    throw new Error('Role instructions contain an unresolved template placeholder');
  }
  return resolved;
}

function loadRoles({ profilesDir = DEFAULT_PROFILES_DIR } = {}) {
  const root = path.resolve(profilesDir);
  const agentsDir = path.join(root, 'agents');
  const teamPath = path.join(root, 'TEAM.md');
  if (!fs.statSync(agentsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Role profiles directory is missing: ${agentsDir}`);
  }
  if (!fs.statSync(teamPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Team rules file is missing: ${teamPath}`);
  }

  const roles = new Map();
  for (const fileName of fs.readdirSync(agentsDir).filter((name) => name.endsWith('.toml')).sort()) {
    const filePath = path.join(agentsDir, fileName);
    const role = parseProfile(fs.readFileSync(filePath, 'utf8'), filePath);
    if (fileName !== `${role.sourceName}.toml`) {
      throw new Error(`${filePath}: filename must match role name ${role.sourceName}`);
    }
    delete role.sourceName;
    if (roles.has(role.name)) throw new Error(`${filePath}: duplicate role name ${role.name}`);
    role.instructions = runtimeInstructions(role.instructions, teamPath);
    roles.set(role.name, role);
  }
  if (roles.size === 0) throw new Error(`No role profiles found in ${agentsDir}`);
  return roles;
}

function createLeadRole({ profilesDir = DEFAULT_PROFILES_DIR } = {}) {
  const root = path.resolve(profilesDir);
  const teamPath = path.join(root, 'TEAM.md');
  const teamRules = fs.readFileSync(teamPath, 'utf8');
  const skillPath = path.join(root, 'skills') + path.sep;
  const inlineRules = teamRules.replaceAll('profiles/skills/', skillPath);

  return {
    name: 'coordinator',
    displayName: roleDisplayName('coordinator'),
    description: 'Read-only orchestrator lead that plans work and dispatches bounded tasks to A2A roles.',
    model: 'gpt-6.1-sol',
    effort: 'high',
    sandbox: 'read-only',
    tools: { mcpServers: [], skills: false },
    instructions: [
      'You are the read-only lead of this A2A development team. You own scope, architecture, priorities, dispatch decisions, integration review, final verification, approvals, and git state.',
      'Use A2A dispatches to assign bounded tasks to the runtime roles. The A2A worker profiles are separate executions; do not spawn Codex subagents.',
      'Delegate product code, tests, scripts, and build configuration to scoped implementation roles. You may read project files and review results, but do not edit product files.',
      'Base decisions on the user request, project instructions, concrete evidence, and the acceptance criteria. Preserve worker ownership boundaries and inspect evidence before escalating.',
      'Use these team rules as the lead contract:',
      inlineRules.trim(),
    ].join('\n\n'),
  };
}

module.exports = { createLeadRole, loadRoles };
