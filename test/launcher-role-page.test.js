'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { effectiveRole } = require('../src/role-overrides');

const root = path.join(__dirname, '..');
const mainHtml = fs.readFileSync(path.join(root, 'launcher-ui/index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'launcher-ui/app.js'), 'utf8');
const rolesHtml = fs.readFileSync(path.join(root, 'launcher-ui/roles.html'), 'utf8');
const rolesJs = fs.readFileSync(path.join(root, 'launcher-ui/roles.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'launcher-ui/styles.css'), 'utf8');
const rolesStyles = fs.readFileSync(path.join(root, 'launcher-ui/roles.css'), 'utf8');

function rolePageFunction(name) {
  const start = rolesJs.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1);
  const end = rolesJs.indexOf('\n  }\n', start);
  assert.notEqual(end, -1);
  return rolesJs.slice(start, end + '\n  }\n'.length);
}

function createElement(tagName) {
  const listeners = {};
  const element = {
    tagName: tagName.toUpperCase(), children: [], options: [], value: '', textContent: '',
    disabled: false, className: '', type: '', min: '', max: '', step: '', maxLength: 0,
    appendChild(child) {
      this.children.push(child);
      if (this.tagName === 'SELECT') this.options.push(child);
      return child;
    },
    append(...children) { children.forEach((child) => this.appendChild(child)); },
    addEventListener(name, callback) { listeners[name] = callback; },
    async dispatch(name) { if (listeners[name]) await listeners[name](); },
    querySelector(selector) {
      const match = selector.match(/^option\[value="([^"]+)"\]$/);
      return match ? this.options.find((option) => option.value === match[1]) || null : null;
    },
  };
  Object.defineProperty(element, 'textContent', {
    get() { return this._textContent || ''; },
    set(value) {
      this._textContent = String(value);
      if (this.tagName === 'SELECT') { this.children = []; this.options = []; this.value = ''; }
    },
  });
  return element;
}

describe('dedicated role settings page', () => {
  it('links from the main page and keeps role editing off the main activity view', () => {
    assert.match(mainHtml, /id="rolesNavLink" href="\/ui\/roles\.html"/);
    assert.match(mainHtml, /class="card sidebar-section team-activity-card" id="teamBand"/);
    assert.doesNotMatch(mainHtml, /id="roleModal"/);
    assert.match(rolesHtml, /id="roleList"/);
    assert.match(rolesHtml, /id="projectSelect"/);
  });

  it('handles Escape safely when the main page has no role modal', () => {
    const match = mainJs.match(/document\.addEventListener\('keydown', function \(ev\) \{\s*const modal = document\.getElementById\('roleModal'\);[\s\S]*?\n    \}\);/);
    assert.ok(match, 'role-modal key handler must remain null-safe');
    const vm = require('node:vm');
    const body = match[0].replace(/^document\.addEventListener\('keydown', function \(ev\) \{/, '').replace(/\}\);$/, '');
    const handler = vm.runInNewContext('(function (ev) {' + body + '\n})', {
      document: { getElementById() { return null; } },
      closeRoleModal() { throw new Error('unexpected modal close'); },
    });
    assert.doesNotThrow(() => handler({ key: 'Escape' }));
  });

  it('renders inherited and saved efforts against selected model capabilities', () => {
    const vm = require('node:vm');
    const context = {};
    vm.createContext(context);
    vm.runInContext(rolePageFunction('roleEffortOptions'), context);
    const model = { defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'high'] };
    const effective = effectiveRole({ name: 'engineer', model: 'model-base', effort: 'high' }, { model: 'model-base' });
    const inherited = context.roleEffortOptions(
      model, effective.model, 'model-base', effective.effort, null,
    );
    assert.equal(inherited.selected, '');
    assert.equal(inherited.inherited, 'high');
    assert.equal(inherited.inheritedUnknown, false);
    const saved = context.roleEffortOptions(model, 'model-new', 'model-base', 'high', 'medium');
    assert.equal(saved.selected, 'medium');
    const changedModel = context.roleEffortOptions(model, 'model-new', 'model-base', 'high', null, true);
    assert.equal(changedModel.selected, 'medium');
    const reset = context.roleEffortOptions(model, 'model-base', 'model-base', 'high', null, true);
    assert.equal(reset.selected, '');
    assert.equal(reset.inherited, 'high');
    const resetModelWithExplicitEffort = context.roleEffortOptions(model, 'model-base', 'model-base', 'high', 'low', true);
    assert.equal(resetModelWithExplicitEffort.selected, 'low');
    const unknown = context.roleEffortOptions(null, 'custom-model', 'base-model', 'high', 'custom-effort');
    assert.equal(unknown.selected, 'custom-effort');
    assert.equal(unknown.savedUnknown, true);
  });

  it('saves a rendered inherited effort as null and keeps profile effort propagation', async () => {
    const vm = require('node:vm');
    const sent = [];
    const context = {
      document: { createElement },
      capabilities: { models: [{ id: 'model-base', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'high', 'xhigh'], serviceTiers: [] }] },
      team: { running: false },
      error: { textContent: '' },
      loadTeam: async () => true,
      isRenderedProjectCurrent: () => true,
      fetch: async (url, request) => {
        sent.push({ url, request, body: request.body ? JSON.parse(request.body) : null });
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      },
    };
    context.modelRecord = (id) => context.capabilities.models.find((model) => model.id === id) || null;
    vm.createContext(context);
    vm.runInContext([
      'fill', 'advertisedFastTier', 'roleEffortOptions', 'roleOverrideUrl', 'sendRoleMutation', 'renderRole',
    ].map(rolePageFunction).join('\n'), context);

    const card = context.renderRole({
      name: 'engineer', displayName: 'Engineer', model: 'model-base', effort: 'high',
      defaults: { model: 'model-base', effort: 'high', maxConcurrentAgents: 4 },
      override: { model: 'model-base' },
    }, false, 'project-a', 7);
    const effortField = card.children.find((child) => child.tagName === 'LABEL' && child.children[0].tagName === 'SELECT' && child.children[0].options[0].textContent === 'Inherited (high)');
    assert.ok(effortField, 'rendered effort selector exists');
    const effortSelect = effortField.children[0];
    assert.equal(effortSelect.value, '');
    assert.equal(effortSelect.options[0].textContent, 'Inherited (high)');

    const actions = card.children.find((child) => child.className === 'role-setting-actions');
    const save = actions.children.find((child) => child.textContent === 'Save');
    await save.dispatch('click');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, '/api/projects/project-a/roles/engineer/override');
    assert.equal(sent[0].body.model, 'model-base');
    assert.equal(sent[0].body.effort, null);

    const override = require('../src/role-overrides').normalizeOverride(sent[0].body);
    assert.deepEqual(override, { model: 'model-base', maxConcurrentAgents: 4 });
    const afterProfileUpdate = effectiveRole(
      { name: 'engineer', model: 'model-base', effort: 'xhigh' }, override,
    );
    assert.equal(afterProfileUpdate.effort, 'xhigh');

    const reset = actions.children.find((child) => child.textContent === 'Reset');
    await reset.dispatch('click');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].request.method, 'DELETE');
    assert.equal(sent[1].body, null);
  });

  it('only enables Fast on for one explicit Fast tier id', () => {
    const vm = require('node:vm');
    const context = {};
    vm.createContext(context);
    vm.runInContext(rolePageFunction('advertisedFastTier'), context);
    assert.equal(context.advertisedFastTier({ serviceTiers: [{ id: 'fast', name: 'Fast' }] }).id, 'fast');
    assert.equal(context.advertisedFastTier({ serviceTiers: [{ id: 'standard', name: 'Standard', description: 'Fast tier unavailable' }] }), null);
    assert.equal(context.advertisedFastTier({ serviceTiers: [{ id: 'fast' }, { id: 'FAST' }] }), null);
  });

  it('drops late project responses and keeps in-flight mutations bound to their rendered project', async () => {
    const vm = require('node:vm');
    const pendingTeams = [];
    const requests = [];
    const roleList = { children: [], appendChild(item) { this.children.push(item); } };
    Object.defineProperty(roleList, 'textContent', { set(value) { if (value === '') this.children = []; }, get() { return ''; } });
    const pageNote = { textContent: '' }; const backLink = { href: '' }; const error = { textContent: '' };
    const context = {
      select: { value: 'A' }, query: new URLSearchParams('?project=A'), location: { pathname: '/ui/roles.html' },
      history: { replaceState() {} }, team: null, error, teamRequestId: 0, selectionRevision: 0, displayedRevision: 0,
      document: { getElementById(id) { return ({ roleList, pageNote, backLink, error })[id]; } },
      get(url) { return new Promise((resolve) => pendingTeams.push({ url, resolve })); },
      renderRole(role, _lead, projectId, revision) { return { role: role.name, projectId, revision }; },
      fetch(url, options) { return new Promise((resolve) => requests.push({ url, options, resolve })); },
    };
    vm.createContext(context);
    vm.runInContext(['isRenderedProjectCurrent', 'roleOverrideUrl', 'loadTeam', 'selectProject', 'sendRoleMutation'].map(rolePageFunction).join('\n'), context);
    const projectTeam = (id) => ({ running: false, lead: { name: 'coordinator' }, roles: [{ name: 'engineer-' + id }] });

    const loadA = context.loadTeam('A', 0);
    const loadB = context.selectProject('B');
    pendingTeams[1].resolve(projectTeam('B'));
    await loadB;
    pendingTeams[0].resolve(projectTeam('A'));
    await loadA;
    assert.deepEqual(roleList.children.map((card) => card.projectId), ['B', 'B']);
    assert.equal(context.roleOverrideUrl('A', 'engineer', 0), null);
    assert.equal(context.roleOverrideUrl('B', 'engineer', 1), '/api/projects/B/roles/engineer/override');

    const button = { disabled: false };
    const mutation = context.sendRoleMutation('B', 'engineer', 1, 'PUT', { effort: 'high' }, button);
    assert.equal(requests[0].url, '/api/projects/B/roles/engineer/override');
    const switched = context.selectProject('A');
    pendingTeams[2].resolve(projectTeam('A'));
    await switched;
    requests[0].resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    await mutation;
    assert.deepEqual(roleList.children.map((card) => card.projectId), ['A', 'A']);
    assert.equal(pendingTeams.length, 3);
  });

  it('loads the selected project from the query and preserves it in the back link', () => {
    assert.match(rolesJs, /query\.get\('project'\)/);
    assert.match(rolesJs, /backLink'\)\.href = '\/\?project='/);
    assert.match(rolesJs, /\/api\/projects\/.*\/team/);
  });

  it('loads only the selected project engine setting and locks a running project', async () => {
    assert.match(rolesHtml, /id="deliveryEngineSelect"/);
    assert.match(rolesHtml, /id="deliveryEngineSave"/);
    const pending = [];
    const controls = { disabled: false, value: '', textContent: '' };
    let selected = 'A';
    const context = {
      engineSelect: controls, engineSave: { disabled: false }, engineNote: { textContent: '' }, engineRequestId: 0,
      document: { getElementById() { return {}; } },
      isRenderedProjectCurrent(id) { return id === selected; },
      get(url) { return new Promise(resolve => pending.push({ url, resolve })); },
    };
    const vm = require('node:vm'); vm.createContext(context); vm.runInContext(rolePageFunction('loadDeliveryEngine'), context);
    const old = context.loadDeliveryEngine('A', 1);
    selected = 'B';
    const current = context.loadDeliveryEngine('B', 2);
    assert.match(pending[0].url, /\/api\/projects\/A\/delivery-engine$/);
    assert.match(pending[1].url, /\/api\/projects\/B\/delivery-engine$/);
    pending[1].resolve({ deliveryEngine: 'concurrent-v1', running: true }); await current;
    pending[0].resolve({ deliveryEngine: 'legacy', running: false }); await old;
    assert.equal(controls.value, 'concurrent-v1');
    assert.equal(controls.disabled, true);
    assert.equal(context.engineSave.disabled, true);
    assert.match(context.engineNote.textContent, /Stop it before changing/);
  });

  it('uses the viewport width and collapses the role grid for narrow screens', () => {
    assert.match(rolesStyles, /\.roles-page\s*\{\s*width:\s*100%/);
    assert.match(rolesStyles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(rolesStyles, /@media \(max-width: 1100px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(rolesStyles, /@media \(max-width: 720px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(rolesStyles, /\.role-setting-card \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(rolesStyles, /\.role-setting-card \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
});

describe('main page connector layout', () => {
  it('places connectors in the fixed-width left sidebar and uses a two-column main grid', () => {
    assert.ok(mainHtml.indexOf('id="connectorsCard"') < mainHtml.indexOf('</aside>'));
    assert.doesNotMatch(mainHtml, /id="connectorsSidebar"/);
    assert.match(styles, /grid-template-columns:\s*360px minmax\(0, 1fr\)/);
    assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*?grid-template-columns: 1fr/);
    assert.match(styles, /\.connector-actions\s*\{[\s\S]*?flex-wrap: wrap/);
  });
});
