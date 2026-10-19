'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { findMcpToolCandidates, resolveMcpToolSelection: resolveDrupalToolSelection } = require('./mcp-catalog');

const DEFAULT_CONNECTOR_CATALOG = path.resolve(__dirname, '..', 'profiles', 'connectors', 'catalog.json');
const SERVER_ID = /^harness-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const HASH = /^[a-f0-9]{64}$/;
// Each Harness connector is bound to one vendor host; a catalog edit cannot point it elsewhere.
const EXPECTED_HOSTS = Object.freeze({
  'harness-atlassian': 'mcp.atlassian.com',
  'harness-figma': 'mcp.figma.com',
  'harness-context7': 'mcp.context7.com',
  'harness-gtm': 'gtm-mcp.stape.ai',
});
const LOADED = new WeakSet();
const COMBINED = new WeakMap();
let defaultCatalog = null;

function ascii(value) {
  return String(value).replace(/[^\x20-\x7e]/g, ' ');
}

function checkUrl(file, name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error(`${file}: invalid url for ${name}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${file}: connector url for ${name} must use https`);
  if (parsed.username || parsed.password || parsed.port) throw new Error(`${file}: connector url for ${name} must not carry credentials or a port`);
  if (!Object.values(EXPECTED_HOSTS).includes(parsed.hostname)) throw new Error(`${file}: connector host ${parsed.hostname} is not allowed`);
  if (EXPECTED_HOSTS[name] !== parsed.hostname) throw new Error(`${file}: connector ${name} must use host ${EXPECTED_HOSTS[name]}`);
}

function loadConnectorCatalog({ catalogPath = DEFAULT_CONNECTOR_CATALOG } = {}) {
  const file = path.resolve(catalogPath);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.connectors)) {
    throw new Error(`${file}: expected version 1 and a connectors array`);
  }
  const catalog = new Map();
  const servers = new Map();
  for (const connector of parsed.connectors) {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector)
      || typeof connector.config_name !== 'string' || !SERVER_ID.test(connector.config_name)
      || typeof connector.url !== 'string' || connector.auth !== 'oauth'
      || typeof connector.purpose !== 'string' || typeof connector.data_sensitivity !== 'string'
      || typeof connector.tools_verified !== 'boolean' || !Array.isArray(connector.read_only_tools)) {
      throw new Error(`${file}: malformed connector entry`);
    }
    const name = connector.config_name;
    if (servers.has(name)) throw new Error(`${file}: duplicate connector ${name}`);
    if (!Object.hasOwn(EXPECTED_HOSTS, name)) throw new Error(`${file}: unknown connector ${name}`);
    checkUrl(file, name, connector.url);
    servers.set(name, {
      configName: name,
      url: connector.url,
      purpose: ascii(connector.purpose),
      dataSensitivity: ascii(connector.data_sensitivity),
      auth: connector.auth,
      toolsVerified: connector.tools_verified,
    });
    const names = new Set();
    for (const tool of connector.read_only_tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)
        || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)
        || typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1000
        || names.has(tool.name)) {
        throw new Error(`${file}: malformed or duplicate tool in ${name}`);
      }
      names.add(tool.name);
      const description = ascii(tool.description).trim();
      const pinSource = JSON.stringify({ config_name: name, url: connector.url, name: tool.name, description });
      const sha256 = crypto.createHash('sha256').update(pinSource).digest('hex');
      const id = `${name}:${tool.name}`;
      catalog.set(id, { id, name: tool.name, description, ...servers.get(name), sha256 });
    }
  }
  LOADED.add(catalog);
  Object.defineProperty(catalog, 'servers', { value: servers, enumerable: false });
  return catalog;
}

function defaultConnectorCatalog() {
  if (!defaultCatalog) defaultCatalog = loadConnectorCatalog();
  return defaultCatalog;
}

function findConnectorToolCandidates(catalog, query, options) {
  if (!(catalog instanceof Map) || !LOADED.has(catalog)) throw new TypeError('connector catalog must come from loadConnectorCatalog');
  return findMcpToolCandidates(catalog, query, options);
}

// Same rules as the Drupal resolver: at most five unique IDs, exact pins, role ceiling.
// The catalog holds only allowlisted tools, so an ID outside it is unknown and rejected.
function resolveConnectorToolSelection(catalog, ids, { pins, allowedServers = [] } = {}) {
  if (!(catalog instanceof Map) || !LOADED.has(catalog)) throw new TypeError('connector catalog must come from loadConnectorCatalog');
  if (!Array.isArray(ids)) throw new TypeError('connector tool ids must be an array');
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
  const permitted = new Set(allowedServers);
  return ids.map((id) => {
    const item = catalog.get(id);
    if (!item) throw new Error(`Unknown connector tool id: ${id}`);
    if (!permitted.has(item.configName)) throw new Error(`MCP server ${item.configName} is not available to this role`);
    if (pins !== undefined && pins.find((pin) => pin.id === id)?.sha256 !== item.sha256) {
      throw new Error(`MCP tool pin does not match current catalog: ${id}`);
    }
    return { ...item };
  });
}

// One Map holding Drupal and connector tools, for code that lists or looks up tools by ID.
// Drupal entries are untouched; the two source catalogs stay reachable for the resolvers.
function withConnectors(catalog, connectors) {
  if (!(catalog instanceof Map)) throw new TypeError('MCP catalog must be a Map');
  if (catalog.connectorCatalog && connectors === undefined) return catalog;
  const connectorCatalog = connectors === undefined ? defaultConnectorCatalog() : connectors;
  if (!(connectorCatalog instanceof Map) || !LOADED.has(connectorCatalog)) throw new TypeError('connector catalog must come from loadConnectorCatalog');
  const cached = COMBINED.get(catalog);
  if (cached && cached.connectorCatalog === connectorCatalog) return cached;
  const combined = new Map(catalog);
  for (const [id, item] of connectorCatalog) {
    if (combined.has(id)) throw new Error(`Connector tool id collides with the MCP catalog: ${id}`);
    combined.set(id, item);
  }
  const servers = new Map(catalog.servers || []);
  for (const [name, server] of connectorCatalog.servers) {
    if (servers.has(name)) throw new Error(`Connector name collides with the MCP catalog: ${name}`);
    servers.set(name, server);
  }
  Object.defineProperty(combined, 'servers', { value: servers, enumerable: false });
  Object.defineProperty(combined, 'drupalCatalog', { value: catalog, enumerable: false });
  Object.defineProperty(combined, 'connectorCatalog', { value: connectorCatalog, enumerable: false });
  COMBINED.set(catalog, combined);
  return combined;
}

// Drop-in for resolveMcpToolSelection: Drupal IDs take the Drupal path unchanged,
// connector IDs take the connector path. The result keeps the order of ids.
function resolveManagedToolSelection(catalog, ids, { pins, allowedServers = [] } = {}) {
  const combined = withConnectors(catalog);
  if (!Array.isArray(ids)) throw new TypeError('MCP tool ids must be an array');
  const connectorIds = new Set(ids.filter((id) => combined.connectorCatalog.has(id)));
  if (connectorIds.size === 0) return resolveDrupalToolSelection(combined.drupalCatalog, ids, { pins, allowedServers });
  if (ids.length > 5) throw new TypeError('at most five MCP tools may be selected');
  if (new Set(ids).size !== ids.length) throw new TypeError('MCP tool ids must be unique strings');
  if (pins !== undefined && (!Array.isArray(pins) || pins.length !== ids.length)) {
    throw new TypeError('MCP tool pins must exactly cover selected tools');
  }
  const split = (list, wanted) => list.filter((item) => connectorIds.has(typeof item === 'string' ? item : item?.id) === wanted);
  const drupalIds = split(ids, false);
  const drupalSelection = resolveDrupalToolSelection(combined.drupalCatalog, drupalIds,
    { allowedServers, ...(pins === undefined ? {} : { pins: split(pins, false) }) });
  const connectorSelection = resolveConnectorToolSelection(combined.connectorCatalog, split(ids, true),
    { allowedServers, ...(pins === undefined ? {} : { pins: split(pins, true) }) });
  const byId = new Map([...drupalSelection, ...connectorSelection].map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id));
}

module.exports = {
  DEFAULT_CONNECTOR_CATALOG,
  loadConnectorCatalog,
  defaultConnectorCatalog,
  findConnectorToolCandidates,
  resolveConnectorToolSelection,
  withConnectors,
  resolveManagedToolSelection,
};
