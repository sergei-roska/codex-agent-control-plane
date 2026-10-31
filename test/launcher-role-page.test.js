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

// app.js is a classic browser script with no exports; pull one top-level function
// out of its IIFE (4-space indented, ends at the matching brace line).
function functionSource(name) {
  const start = mainJs.search(new RegExp('^    function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, `${name} must exist in app.js`);
  const end = mainJs.indexOf('\n    }\n', start);
  assert.notEqual(end, -1);
  return mainJs.slice(start, end + '\n    }\n'.length);
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
    assert.match(mainHtml, /class="card sidebar-section team-activity-card sidebar-disclosure" id="teamBand"/);
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
  it('makes every sidebar card collapsible and keeps Accounts collapsed by default', () => {
    const sidebar = mainHtml.match(/<aside class="sidebar">([\s\S]*?)<\/aside>/)?.[1];
    assert.ok(sidebar, 'sidebar markup must exist');

    const about = sidebar.match(/<details class="about-details"([^>]*)>/);
    assert.ok(about, 'About Orchestrator must be collapsible');
    assert.doesNotMatch(about[1], /\bopen\b/);
    assert.match(sidebar, /<summary class="card-title-summary">[\s\S]*?About Orchestrator/);

    for (const id of ['accountsCard', 'teamBand', 'connectorsCard']) {
      const card = sidebar.match(new RegExp(`<details\\b(?=[^>]*\\bid="${id}")[^>]*>([\\s\\S]*?)<\\/details>`));
      assert.ok(card, `${id} must be a details disclosure`);
      assert.match(card[1], /^\s*<summary\b/);
      const openingTag = card[0].slice(0, card[0].indexOf('>') + 1);
      assert.doesNotMatch(openingTag, /\bopen\b/);
    }
    assert.doesNotMatch(sidebar, /id="projectCard"/);
    assert.doesNotMatch(sidebar, /id="projectSelect"/);
    assert.match(sidebar, /id="accountsQuotaPreview" role="img"/);
    assert.match(sidebar, /<summary class="card-header card-title-summary sidebar-disclosure-summary">\s*<span class="accounts-summary-title">[\s\S]*?<\/span>\s*<span class="accounts-quota-preview"[\s\S]*?<\/span>\s*<svg class="icon sidebar-disclosure-chevron"/);
    assert.match(styles, /\.accounts-card > summary\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center/);
    for (const [trackId, fillId] of [['accountsQuota5hTrack', 'accountsQuota5hFill'], ['accountsQuotaWeeklyTrack', 'accountsQuotaWeeklyFill']]) {
      assert.match(sidebar, new RegExp(`class="accounts-quota-preview-track is-unknown" id="${trackId}"`));
      assert.match(sidebar, new RegExp(`class="progress-bar-fill accounts-quota-preview-fill" id="${fillId}" style="width: 0%"`));
    }
    assert.match(styles, /\.accounts-card\[open\] > summary \.accounts-quota-preview\s*\{\s*display:\s*none/);
    assert.ok(sidebar.indexOf('id="teamBand"') < sidebar.indexOf('id="connectorsCard"'));
  });

  it('keeps project management in the session header as one combobox field', () => {
    const header = mainHtml.match(/<div class="session-header">([\s\S]*?)<!-- Session Situation/)?.[1];
    assert.ok(header, 'session header markup must exist');

    // One field: a combobox input that owns the menu and shows a typed path.
    assert.match(header, /<input[^>]*id="projectSelect"[^>]*role="combobox"/);
    assert.match(header, /aria-controls="projectMenu"/);
    assert.match(header, /aria-expanded="false"/);
    assert.match(header, /placeholder="Path to project\.\.\."/);
    assert.match(header, /id="projectMenu"[^>]*role="listbox"/);
    // The old separate path field is gone; Add is an explicit, visible action.
    assert.doesNotMatch(mainHtml, /id="projectPathInput"/);
    assert.match(header, /<button[^>]*id="addProjectBtn"[^>]*onclick="addProjectFromField\(\)"/);
    // Every inline handler the markup calls must exist in app.js.
    for (const fn of ['onProjectFocus', 'onProjectQueryInput', 'onProjectKeydown', 'onProjectBlur', 'toggleProjectMenu', 'removeProject', 'addProjectFromField']) {
      assert.match(mainJs, new RegExp(`function ${fn}\\b`), `${fn} must be defined`);
    }
    // Remove sits beside the field, not in the title block.
    const title = header.match(/<div class="session-header-left">([\s\S]*?)<\/div>\s*<!--/)?.[1] || '';
    assert.doesNotMatch(title, /id="removeProjectBtn"/);
    assert.match(header, /id="projectCombo"[\s\S]*id="projectSelect"[\s\S]*id="addProjectBtn"[\s\S]*id="removeProjectBtn"/);
  });

  it('renders the project menu rows and keyboard highlight from the project list', () => {
    const vm = require('node:vm');
    // Only direct appends to the menu are rows; spans go to their row's children.
    const menu = {
      textContent: '', children: [],
      appendChild(c) { this.children.push(c); },
      querySelector(sel) {
        if (sel !== '.project-menu-item.is-active') return null;
        return this.children.find((c) => c.classList.values.has('is-active')) || null;
      },
    };
    const field = { value: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, closest() { return { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0 }) }) }; } };
    const context = {
      document: {
        getElementById: (id) => ({ projectMenu: menu, projectSelect: field }[id] || null),
        createElement: (tag) => {
          // Fresh class list per element, and className writes feed it.
          const values = new Set();
          const element = {
            tagName: tag.toUpperCase(), id: '', children: [],
            classList: { values, add: (c) => values.add(c), remove: (c) => values.delete(c), contains: (c) => values.has(c) },
            setAttribute() {}, addEventListener() {}, appendChild(c) { element.children.push(c); },
          };
          Object.defineProperty(element, 'className', {
            get: () => [...values].join(' '),
            set: (v) => { values.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => values.add(c)); },
          });
          return element;
        },
      },
      projectList: [
        { id: 'p1', name: 'alpha-repo', path: '/work/alpha-repo', status: 'stopped' },
        { id: 'p2', name: 'beta-repo', path: '/work/beta-repo', status: 'stopped' },
      ],
      currentProjectId: 'p1',
      projectQuery: 'beta',
      projectActiveIndex: 0,
      displayProjectName: (n) => n,
      statusMarker: () => '[stopped]',
      isProjectMenuOpen: () => true,
      projectField: () => field,
      window: { innerHeight: 800 },
    };
    vm.createContext(context);
    vm.runInContext([functionSource('renderProjectMenu'), functionSource('projectMenuItems')].join('\n'), context);
    context.renderProjectMenu();
    assert.equal(menu.children.length, 2, 'one match plus the add-path row');
    assert.equal(menu.children[0].id, 'project-option-0');
    assert.equal(menu.children[0].classList.values.has('is-active'), true, 'first row carries the highlight');
    assert.equal(field.attrs['aria-activedescendant'], 'project-option-0');
    assert.equal(menu.children[1].classList.values.has('is-add'), true);

    // Nothing matches: the typed path is still offered as an addition.
    context.projectQuery = '/new/place';
    context.projectActiveIndex = -1;
    menu.children.length = 0;
    context.renderProjectMenu();
    assert.equal(menu.children.length, 1);
    assert.equal(menu.children[0].classList.values.has('is-add'), true);
    assert.equal(field.attrs['aria-activedescendant'], undefined);
  });

  it('places connectors in the fixed-width left sidebar and uses a two-column main grid', () => {
    assert.ok(mainHtml.indexOf('id="connectorsCard"') < mainHtml.indexOf('</aside>'));
    assert.doesNotMatch(mainHtml, /id="connectorsSidebar"/);
    assert.match(mainHtml, /class="card sidebar-section team-activity-card sidebar-disclosure" id="teamBand"/);
    assert.match(styles, /grid-template-columns:\s*360px minmax\(0, 1fr\)/);
    assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*?grid-template-columns: 1fr/);
    assert.match(styles, /\.connector-actions\s*\{[\s\S]*?flex-wrap: wrap/);
  });

  it('keeps expanded account content constrained to the sidebar card width', () => {
    assert.match(styles, /\.accounts-card::details-content\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*min-width:\s*0/);
    assert.match(styles, /\.accounts-card > summary\s*\{[^}]*align-self:\s*center/);
    assert.match(styles, /\.accounts-card-actions\s*\{[^}]*justify-content:\s*flex-end/);
    assert.match(styles, /\.accounts-card > :not\(summary\):not\(\.accounts-card-actions\)\s*\{[^}]*min-width:\s*0/);
    assert.match(styles, /\.accounts-list\s*\{[^}]*min-width:\s*0/);
    assert.match(styles, /\.account-block\s*\{[^}]*min-width:\s*0/);
    assert.match(styles, /\.accounts-card \.limit-reset\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('animates native sidebar disclosures with intrinsic sizing and honors reduced motion', () => {
    assert.match(styles, /@supports\s*\(interpolate-size:\s*allow-keywords\)[\s\S]*?\.sidebar\s*\{\s*interpolate-size:\s*allow-keywords/);
    assert.match(styles, /\.sidebar details::details-content\s*\{[^}]*block-size:\s*0;[^}]*opacity:\s*0;[^}]*overflow:\s*clip;[^}]*block-size 180ms ease-out[^}]*opacity 180ms ease-out/);
    assert.match(styles, /\.sidebar details\[open\]::details-content\s*\{[^}]*block-size:\s*auto;[^}]*opacity:\s*1/);
    assert.match(styles, /@supports\s*\(interpolate-size:\s*allow-keywords\)\s*and\s*\(transition-behavior:\s*allow-discrete\)[\s\S]*?content-visibility 180ms allow-discrete/);
    assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.sidebar details::details-content,[\s\S]*?\.sidebar-disclosure-chevron,[\s\S]*?\.about-chevron\s*\{\s*transition:\s*none/);
  });
});
