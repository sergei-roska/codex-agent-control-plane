const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_CONNECTOR_CATALOG,
  loadConnectorCatalog,
  findConnectorToolCandidates,
  resolveConnectorToolSelection,
  withConnectors,
  resolveManagedToolSelection,
} = require('../src/connector-catalog');
const { loadMcpCatalog, mcpToolPins } = require('../src/mcp-catalog');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-catalog-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const base = () => JSON.parse(fs.readFileSync(DEFAULT_CONNECTOR_CATALOG, 'utf8'));
let counter = 0;
function load(edit) {
  const data = base();
  edit(data);
  const file = path.join(tmp, `catalog-${counter += 1}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return loadConnectorCatalog({ catalogPath: file });
}
const connector = (data, name) => data.connectors.find((item) => item.config_name === name);

test('the shipped catalog loads with the four connectors and the documented allowlists', () => {
  const catalog = loadConnectorCatalog();
  assert.deepEqual([...catalog.servers.keys()], ['harness-atlassian', 'harness-figma', 'harness-context7', 'harness-gtm']);
  const names = (server) => [...catalog.values()].filter((item) => item.configName === server).map((item) => item.name);
  assert.deepEqual(names('harness-figma'),
    ['get_design_context', 'get_metadata', 'get_screenshot', 'get_variable_defs', 'search_design_system', 'whoami']);
  assert.deepEqual(names('harness-context7'), ['resolve-library-id', 'query-docs']);
  assert.equal(names('harness-atlassian').length, 4);
  assert.deepEqual(names('harness-gtm'), []);
  for (const server of catalog.servers.values()) {
    assert.match(server.url, /^https:\/\//);
    assert.equal(server.auth, 'oauth');
    assert.equal(server.toolsVerified, false);
  }
  for (const item of catalog.values()) assert.match(item.sha256, /^[a-f0-9]{64}$/);
});

test('the loader rejects a host outside the four vendor hosts and a host bound to the wrong connector', () => {
  assert.throws(() => load((data) => { connector(data, 'harness-figma').url = 'https://evil.example.com/mcp'; }), /host evil\.example\.com is not allowed/);
  assert.throws(() => load((data) => { connector(data, 'harness-figma').url = 'https://mcp.context7.com/mcp'; }), /must use host mcp\.figma\.com/);
  assert.throws(() => load((data) => { connector(data, 'harness-figma').url = 'https://user:pw@mcp.figma.com/mcp'; }), /credentials or a port/);
});

test('the loader rejects a non-https url', () => {
  assert.throws(() => load((data) => { connector(data, 'harness-figma').url = 'http://mcp.figma.com/mcp'; }), /must use https/);
  assert.throws(() => load((data) => { connector(data, 'harness-figma').url = 'not a url'; }), /invalid url/);
});

test('the loader rejects a bad or unknown connector name and a duplicate connector', () => {
  assert.throws(() => load((data) => { connector(data, 'harness-figma').config_name = 'figma'; }), /malformed connector entry/);
  assert.throws(() => load((data) => { connector(data, 'harness-figma').config_name = 'harness-other'; }), /unknown connector harness-other/);
  assert.throws(() => load((data) => { data.connectors.push({ ...connector(data, 'harness-figma') }); }), /duplicate connector harness-figma/);
});

test('the loader rejects a tool name outside the allowlist pattern and a duplicate tool', () => {
  assert.throws(() => load((data) => { connector(data, 'harness-figma').read_only_tools[0].name = 'bad name'; }), /malformed or duplicate tool/);
  assert.throws(() => load((data) => { connector(data, 'harness-figma').read_only_tools[0].name = 'a/b'; }), /malformed or duplicate tool/);
  assert.throws(() => load((data) => {
    const tools = connector(data, 'harness-figma').read_only_tools;
    tools.push({ ...tools[0] });
  }), /malformed or duplicate tool/);
});

test('the loader rejects a connector that does not use oauth or carries a malformed shape', () => {
  assert.throws(() => load((data) => { connector(data, 'harness-figma').auth = 'api-key'; }), /malformed connector entry/);
  assert.throws(() => load((data) => { data.version = 2; }), /expected version 1/);
});

test('a valid selection resolves and returns copies with the pinned hash', () => {
  const catalog = loadConnectorCatalog();
  const ids = ['harness-figma:get_metadata', 'harness-figma:whoami'];
  const pins = ids.map((id) => ({ id, sha256: catalog.get(id).sha256 }));
  const selection = resolveConnectorToolSelection(catalog, ids, { pins, allowedServers: ['harness-figma'] });
  assert.deepEqual(selection.map((item) => item.name), ['get_metadata', 'whoami']);
  assert.equal(selection[0].url, 'https://mcp.figma.com/mcp');
  assert.notEqual(selection[0], catalog.get(ids[0]));
  assert.deepEqual(mcpToolPins(selection), pins.slice().sort((a, b) => a.id.localeCompare(b.id, 'en')));
});

test('a pin mismatch is rejected', () => {
  const catalog = loadConnectorCatalog();
  const id = 'harness-context7:query-docs';
  assert.throws(() => resolveConnectorToolSelection(catalog, [id],
    { pins: [{ id, sha256: 'a'.repeat(64) }], allowedServers: ['harness-context7'] }), /pin does not match/);
  assert.throws(() => resolveConnectorToolSelection(catalog, [id],
    { pins: [], allowedServers: ['harness-context7'] }), /pins must exactly cover/);
});

test('the pin changes when the url or the description changes', () => {
  const id = 'harness-context7:query-docs';
  const original = loadConnectorCatalog().get(id).sha256;
  const edited = load((data) => { connector(data, 'harness-context7').read_only_tools[1].description = 'Changed.'; }).get(id).sha256;
  const moved = load((data) => { connector(data, 'harness-context7').url = 'https://mcp.context7.com/other'; }).get(id).sha256;
  assert.notEqual(edited, original);
  assert.notEqual(moved, original);
});

test('more than five ids, duplicate ids and a server outside the role ceiling are rejected', () => {
  const catalog = loadConnectorCatalog();
  const figma = [...catalog.keys()].filter((id) => id.startsWith('harness-figma:'));
  assert.equal(figma.length, 6);
  assert.throws(() => resolveConnectorToolSelection(catalog, figma, { allowedServers: ['harness-figma'] }), /at most five/);
  assert.throws(() => resolveConnectorToolSelection(catalog, [figma[0], figma[0]], { allowedServers: ['harness-figma'] }), /unique/);
  assert.throws(() => resolveConnectorToolSelection(catalog, [figma[0]], { allowedServers: ['harness-context7'] }), /not available to this role/);
  assert.throws(() => resolveConnectorToolSelection(catalog, [figma[0]]), /not available to this role/);
});

test('an id outside the allowlist is unknown, and the gtm allowlist rejects every tool', () => {
  const catalog = loadConnectorCatalog();
  const allowed = [...catalog.servers.keys()];
  assert.throws(() => resolveConnectorToolSelection(catalog, ['harness-figma:delete_file'], { allowedServers: allowed }), /Unknown connector tool id/);
  for (const name of ['list_accounts', 'create_tag', 'publish_version', 'get_container', '']) {
    assert.throws(() => resolveConnectorToolSelection(catalog, [`harness-gtm:${name}`], { allowedServers: allowed }), /Unknown connector tool id/);
  }
  assert.equal([...catalog.values()].some((item) => item.configName === 'harness-gtm'), false);
});

test('a catalog not produced by the loader is refused', () => {
  assert.throws(() => resolveConnectorToolSelection(new Map(), [], {}), /must come from loadConnectorCatalog/);
  assert.throws(() => findConnectorToolCandidates(new Map(), 'x'), /must come from loadConnectorCatalog/);
});

test('the candidate finder honors the role ceiling and the limit', () => {
  const catalog = loadConnectorCatalog();
  const found = findConnectorToolCandidates(catalog, 'figma design screenshot', { allowedServers: ['harness-figma'] });
  assert.ok(found.length > 0);
  assert.ok(found.every((item) => item.server === 'harness-figma'));
  assert.deepEqual(Object.keys(found[0]).sort(), ['dataSensitivity', 'description', 'id', 'name', 'server']);
  assert.deepEqual(findConnectorToolCandidates(catalog, 'figma design screenshot', { allowedServers: ['harness-context7'] }), []);
  assert.equal(findConnectorToolCandidates(catalog, 'figma design screenshot', { allowedServers: ['harness-figma'], limit: 1 }).length, 1);
});

test('the combined catalog resolves Drupal and connector ids together in request order', () => {
  const drupal = loadMcpCatalog();
  const combined = withConnectors(drupal);
  assert.equal(withConnectors(combined), combined);
  assert.equal(withConnectors(drupal), combined);
  assert.equal(combined.size, drupal.size + loadConnectorCatalog().size);
  assert.equal(combined.servers.has('harness-figma'), true);
  assert.equal(combined.servers.has('harness-drupal-static'), true);
  const drupalId = [...drupal.keys()][0];
  const ids = ['harness-context7:query-docs', drupalId];
  const pins = ids.map((id) => ({ id, sha256: combined.get(id).sha256 }));
  const selection = resolveManagedToolSelection(drupal, ids,
    { pins, allowedServers: ['harness-context7', combined.get(drupalId).configName] });
  assert.deepEqual(selection.map((item) => item.id), ids);
  // A plain Drupal selection behaves as before.
  assert.deepEqual(resolveManagedToolSelection(drupal, [drupalId], { allowedServers: [combined.get(drupalId).configName] }).map((item) => item.id), [drupalId]);
  assert.throws(() => resolveManagedToolSelection(drupal, ['harness-nope:x'], { allowedServers: [] }), /Unknown MCP tool id/);
});

test('the combined resolver applies the five-tool limit, pins and the role ceiling across both kinds', () => {
  const drupal = loadMcpCatalog();
  const combined = withConnectors(drupal);
  const drupalIds = [...drupal.keys()].slice(0, 3);
  const mixed = [...drupalIds, 'harness-context7:query-docs', 'harness-context7:resolve-library-id'];
  const allowed = [...combined.servers.keys()];
  assert.equal(resolveManagedToolSelection(drupal, mixed, { allowedServers: allowed }).length, 5);
  assert.throws(() => resolveManagedToolSelection(drupal, [...mixed, 'harness-figma:whoami'], { allowedServers: allowed }), /at most five/);
  assert.throws(() => resolveManagedToolSelection(drupal, ['harness-context7:query-docs'], { allowedServers: ['harness-figma'] }), /not available to this role/);
  assert.throws(() => resolveManagedToolSelection(drupal, ['harness-context7:query-docs'],
    { allowedServers: allowed, pins: [{ id: 'harness-context7:query-docs', sha256: 'b'.repeat(64) }] }), /pin does not match/);
  assert.throws(() => resolveManagedToolSelection(drupal, ['harness-context7:query-docs', drupalIds[0]],
    { allowedServers: allowed, pins: [{ id: 'harness-context7:query-docs', sha256: combined.get('harness-context7:query-docs').sha256 }] }), /pins must exactly cover/);
  assert.throws(() => resolveManagedToolSelection(drupal, ['harness-context7:query-docs', 'harness-context7:query-docs'], { allowedServers: allowed }), /unique/);
});
