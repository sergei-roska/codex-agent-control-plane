'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MCP_CATALOG = path.resolve(__dirname, '..', 'profiles', 'mcp', 'catalog.json');
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_ID = /^harness-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const HASH = /^[a-f0-9]{64}$/;
const CATALOG_ROOTS = new WeakMap();
const EXPECTED_TOOL_COUNTS = Object.freeze({
  'harness-drupal-static': 12,
  'harness-drupal-config': 10,
  'harness-drupal-content': 16,
  'harness-drupal-ops': 14,
  'harness-drupal-render': 10,
  'harness-drupal-db-ops': 14,
});
const EXPECTED_PACKAGE_PATHS = Object.freeze({
  'harness-drupal-static': 'mcp/drupal/drupal-static',
  'harness-drupal-config': 'mcp/drupal/drupal-config',
  'harness-drupal-content': 'mcp/drupal/drupal-content',
  'harness-drupal-ops': 'mcp/drupal/drupal-ops',
  'harness-drupal-render': 'mcp/drupal/drupal-render',
  'harness-drupal-db-ops': 'mcp/drupal/drupal-db-ops',
});
const EXPECTED_RUNTIME_CLASSES = Object.freeze({
  'harness-drupal-static': 'local-filesystem',
  'harness-drupal-config': 'live-drupal-drush',
  'harness-drupal-content': 'live-drupal-drush',
  'harness-drupal-ops': 'live-drupal-drush',
  'harness-drupal-render': 'live-drupal-drush',
  'harness-drupal-db-ops': 'direct-database',
});

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ascii(value) {
  return String(value).replace(/[^\x20-\x7e]/g, ' ');
}

function loadMcpCatalog({ catalogPath = DEFAULT_MCP_CATALOG, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const catalogFile = path.resolve(catalogPath);
  const root = fs.realpathSync(path.resolve(repoRoot));
  const canonicalCatalogFile = fs.realpathSync(catalogFile);
  if (!containedBy(root, canonicalCatalogFile) || canonicalCatalogFile !== catalogFile || !fs.statSync(canonicalCatalogFile).isFile()) {
    throw new Error(`${catalogFile}: catalog path is outside the Harness repository`);
  }
  const parsed = JSON.parse(fs.readFileSync(canonicalCatalogFile, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.servers) || parsed.servers.length !== 6) {
    throw new Error(`${catalogFile}: expected version 1 and exactly six MCP servers`);
  }

  const catalog = new Map();
  const servers = new Map();
  const toolCounts = new Map();
  for (const server of parsed.servers) {
    if (!server || typeof server !== 'object' || Array.isArray(server)
      || typeof server.config_name !== 'string' || !SERVER_ID.test(server.config_name)
      || typeof server.package_path !== 'string' || server.package_path !== EXPECTED_PACKAGE_PATHS[server.config_name] || path.isAbsolute(server.package_path)
      || server.package_path.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')
      || typeof server.runtime_class !== 'string' || server.runtime_class !== EXPECTED_RUNTIME_CLASSES[server.config_name]
      || !Array.isArray(server.tools) || server.tools.length === 0) {
      throw new Error(`${catalogFile}: malformed MCP server entry`);
    }
    if (servers.has(server.config_name)) throw new Error(`${catalogFile}: duplicate server ${server.config_name}`);
    if (!Object.hasOwn(EXPECTED_TOOL_COUNTS, server.config_name)) throw new Error(`${catalogFile}: unknown server ${server.config_name}`);
    const packagePath = path.resolve(root, server.package_path);
    const canonicalPackagePath = fs.realpathSync(packagePath);
    if (!containedBy(root, canonicalPackagePath) || canonicalPackagePath !== packagePath
      || !fs.statSync(canonicalPackagePath).isDirectory()) {
      throw new Error(`${catalogFile}: unsafe MCP package path for ${server.config_name}`);
    }
    const normalizedServer = {
      configName: server.config_name,
      packagePath: server.package_path,
      absolutePackagePath: canonicalPackagePath,
      purpose: ascii(server.purpose),
      dataSensitivity: ascii(server.data_sensitivity),
      runtimeClass: server.runtime_class,
    };
    servers.set(server.config_name, normalizedServer);
    const names = new Set();
    for (const tool of server.tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)
        || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)
        || typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1000
        || names.has(tool.name)) {
        throw new Error(`${catalogFile}: malformed or duplicate tool in ${server.config_name}`);
      }
      names.add(tool.name);
      const id = `${server.config_name}:${tool.name}`;
      const description = ascii(tool.description).trim();
      const pinSource = JSON.stringify({ version: parsed.version, id, description, ...normalizedServer });
      const sha256 = crypto.createHash('sha256').update(pinSource).digest('hex');
      catalog.set(id, { id, name: tool.name, description, ...normalizedServer, sha256 });
    }
    toolCounts.set(server.config_name, names.size);
  }
  if (Object.keys(EXPECTED_TOOL_COUNTS).some((name) => toolCounts.get(name) !== EXPECTED_TOOL_COUNTS[name])
    || catalog.size !== 76) throw new Error(`${catalogFile}: server or tool inventory does not match the audited Drupal bundle`);
  CATALOG_ROOTS.set(catalog, root);
  Object.defineProperty(catalog, 'servers', { value: servers, enumerable: false });
  return catalog;
}

function tokens(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function findMcpToolCandidates(catalog, query, { limit = 12, allowedServers = [] } = {}) {
  if (!(catalog instanceof Map)) throw new TypeError('MCP catalog must be a Map');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer');
  if (!Array.isArray(allowedServers) || allowedServers.some((name) => typeof name !== 'string' || !SERVER_ID.test(name))) {
    throw new TypeError('allowedServers must be a list of Harness MCP server names');
  }
  const permitted = new Set(allowedServers);
  const boundedLimit = Math.min(limit, 12);
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length || !boundedLimit) return [];
  const ranked = [];
  for (const [id, item] of catalog) {
    if (!permitted.has(item.configName)) continue;
    const nameTokens = new Set(tokens(`${item.name} ${item.configName}`));
    const descriptionTokens = new Set(tokens(`${item.purpose} ${item.description} ${item.dataSensitivity}`));
    let nameMatches = 0;
    let descriptionMatches = 0;
    for (const token of queryTokens) {
      if (nameTokens.has(token)) nameMatches += 1;
      if (descriptionTokens.has(token)) descriptionMatches += 1;
    }
    if (nameMatches + descriptionMatches === 0) continue;
    const exactName = tokens(id).join(' ') === queryTokens.join(' ');
    ranked.push({ id, name: item.name, description: item.description, configName: item.configName,
      dataSensitivity: item.dataSensitivity, score: (exactName ? 100 : 0) + nameMatches * 8 + descriptionMatches });
  }
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'));
  return ranked.slice(0, boundedLimit).map(({ id, name, description, configName, dataSensitivity }) => ({
    id, name, description, server: configName, dataSensitivity,
  }));
}

function resolveMcpToolSelection(catalog, ids, { pins, allowedServers = [] } = {}) {
  if (!(catalog instanceof Map)) throw new TypeError('MCP catalog must be a Map');
  if (!Array.isArray(ids)) throw new TypeError('MCP tool ids must be an array');
  if (!Array.isArray(allowedServers)) throw new TypeError('allowedServers must be an array');
  if (ids.length > 5) throw new TypeError('at most five MCP tools may be selected');
  if (ids.some((id) => typeof id !== 'string' || id.length > 160) || new Set(ids).size !== ids.length) {
    throw new TypeError('MCP tool ids must be unique strings');
  }
  if (pins !== undefined) {
    if (!Array.isArray(pins) || pins.length !== ids.length) throw new TypeError('MCP tool pins must exactly cover selected tools');
    const pinById = new Map();
    for (const pin of pins) {
      if (!pin || typeof pin !== 'object' || Array.isArray(pin) || typeof pin.id !== 'string'
        || typeof pin.sha256 !== 'string' || !HASH.test(pin.sha256) || pinById.has(pin.id)) {
        throw new TypeError('MCP tool pins are malformed or duplicated');
      }
      pinById.set(pin.id, pin.sha256);
    }
    if (ids.some((id) => !pinById.has(id))) throw new TypeError('MCP tool pins must exactly cover selected tools');
  }
  const root = CATALOG_ROOTS.get(catalog);
  if (!root) throw new Error('MCP catalog was not loaded by loadMcpCatalog');
  const permitted = new Set(allowedServers);
  return ids.map((id) => {
    const item = catalog.get(id);
    if (!item) throw new Error(`Unknown MCP tool id: ${id}`);
    if (!permitted.has(item.configName)) throw new Error(`MCP server ${item.configName} is not available to this role`);
    const currentPackagePath = fs.realpathSync(path.resolve(root, item.packagePath));
    if (currentPackagePath !== item.absolutePackagePath || !containedBy(root, currentPackagePath)) {
      throw new Error(`MCP package path changed for ${item.configName}`);
    }
    if (pins !== undefined && pins.find((pin) => pin.id === id)?.sha256 !== item.sha256) {
      throw new Error(`MCP tool pin does not match current catalog: ${id}`);
    }
    return { ...item };
  });
}

function mcpToolPins(selection) {
  if (!Array.isArray(selection) || selection.length > 5) throw new TypeError('MCP tool selection is malformed');
  return selection.map(({ id, sha256 }) => ({ id, sha256 })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

module.exports = {
  DEFAULT_MCP_CATALOG,
  loadMcpCatalog,
  findMcpToolCandidates,
  resolveMcpToolSelection,
  mcpToolPins,
};
