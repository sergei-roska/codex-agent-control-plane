'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../src/route-gate');

const plan = (extra = {}) => ({
  route: 'lean',
  checkIds: ['lint'],
  stages: [
    { roleId: 'orch-builder', allowedFiles: ['web/themes/custom/b4main/templates/page.html.twig'] },
    { roleId: 'orch-verifier', allowedFiles: [] },
  ],
  ...extra,
});
const on = { adaptiveRoute: 'on' };
const route = (p, policy = on, classification = 'bugfix') => gate.evaluatePlanRoute({ classification, plan: p, policy });

test('resolveRouteLimits defaults and validation', () => {
  assert.deepEqual(gate.resolveRouteLimits(), { maxFiles: 3, maxChangedLines: 30, protectedPaths: [] });
  const bad = gate.resolveRouteLimits({ maxFiles: 0, maxChangedLines: 2.5, protectedPaths: 'x' });
  assert.deepEqual(bad, { maxFiles: 3, maxChangedLines: 30, protectedPaths: [] });
  const ok = gate.resolveRouteLimits({ maxFiles: 5, maxChangedLines: 10, protectedPaths: ['src/legacy/'] });
  assert.deepEqual(ok, { maxFiles: 5, maxChangedLines: 10, protectedPaths: ['src/legacy/'] });
});

test('isProtectedPath built-in categories', () => {
  const protectedFiles = [
    'src/Auth/Foo.php', 'modules/x/src/Access/a.php', 'src/Security.php', 'web/modules/custom/x/permissions.yml',
    'src/oauth.js', 'config/sync/core.extension.yml', 'web/config/x.yml', 'web/modules/custom/x/migrations/m.yml',
    'web/modules/custom/x/x.install', 'db/seed.php', 'composer.json', 'composer.lock', 'package.json', 'yarn.lock',
    'pnpm-lock.yaml', '.env', '.env.local', 'certs/a.pem', 'a/b.KEY', 'web/sites/default/settings.php',
    'web/sites/default/settings.local.php', 'x/services.yml', '.github/workflows/ci.yml', '.gitlab-ci.yml',
    'Dockerfile', 'docker-compose.override.yml', '.lando.yml', '.ddev/config.yaml', 'dump.sql', 'x/schema.yml',
    '/etc/passwd', '../x.js', 'a/../b.js', '',
  ];
  protectedFiles.forEach((file) => assert.equal(gate.isProtectedPath(file), true, file));
});

test('isProtectedPath leaves ordinary files alone', () => {
  const ordinary = [
    'web/themes/custom/b4main/theme-settings.php', 'web/themes/custom/b4main/templates/page.html.twig',
    'web/modules/custom/x/src/Plugin/Block/Foo.php', 'web/themes/custom/b4main/js/app.js', 'src/intake.js',
    'web/themes/custom/x/config/install/x.yml',
  ];
  ordinary.forEach((file) => assert.equal(gate.isProtectedPath(file), false, file));
});

test('extra protected patterns only extend', () => {
  assert.equal(gate.isProtectedPath('src/legacy/a.js'), false);
  assert.equal(gate.isProtectedPath('src/legacy/a.js', ['src/legacy/']), true);
  assert.equal(gate.isProtectedPath('a/b/billing.php', ['billing.php']), true);
  assert.equal(gate.isProtectedPath('src/x/pay.js', ['src/**/pay.*']), true);
  assert.equal(gate.isProtectedPath('composer.json', ['nothing/']), true);
  const limits = gate.resolveRouteLimits({ protectedPaths: ['src/legacy/'] });
  assert.equal(gate.isProtectedPath('composer.json', limits.protectedPaths), true);
});

test('plan route: lean on mode on', () => {
  assert.deepEqual(route(plan()), { requested: 'lean', verdict: 'lean', effective: 'lean', mode: 'on', reasons: [] });
});

test('plan route: shadow and off always execute full', () => {
  const shadow = route(plan(), { adaptiveRoute: 'shadow' });
  assert.deepEqual([shadow.verdict, shadow.effective, shadow.reasons], ['lean', 'full', []]);
  const off = route(plan(), { adaptiveRoute: 'off' });
  assert.deepEqual([off.verdict, off.effective, off.mode, off.reasons], ['lean', 'full', 'off', ['policy_off']]);
  const missing = route(plan(), null);
  assert.equal(missing.mode, 'off');
  assert.equal(route(plan(), { adaptiveRoute: 'bogus' }).mode, 'off');
});

test('plan route: each reason code', () => {
  assert.deepEqual(route(plan(), on, 'feature').reasons, ['not_bugfix']);
  assert.deepEqual(route(plan({ route: 'full' })).reasons, ['not_requested']);
  assert.deepEqual(route(plan({ route: 'weird' })).requested, null);
  const many = plan({ stages: [{ roleId: 'b', allowedFiles: ['a.js', 'b.js', 'c.js', 'd.js'] }] });
  assert.deepEqual(route(many).reasons, ['too_many_files']);
  const dup = plan({ stages: [{ roleId: 'b', allowedFiles: ['a.js', 'b.js'] }, { roleId: 'c', allowedFiles: ['a.js', 'c.js'] }] });
  assert.equal(route(dup).verdict, 'lean');
  const prot = plan({ stages: [{ roleId: 'b', allowedFiles: ['a.js', 'composer.lock'] }] });
  assert.deepEqual(route(prot).reasons, ['protected_path:composer.lock']);
  assert.deepEqual(route(plan({ checkIds: [] })).reasons, ['no_mechanical_check']);
  const all = route(plan({ route: 'full', checkIds: [], stages: [{ roleId: 'b', allowedFiles: ['a', 'b', 'c', 'd', '.env'] }] }),
    { adaptiveRoute: 'off' }, 'docs');
  assert.deepEqual(all.reasons, ['not_bugfix', 'not_requested', 'too_many_files', 'protected_path:.env', 'no_mechanical_check']);
});

test('plan route: routeLimits and extra patterns from policy', () => {
  const p = plan({ stages: [{ roleId: 'b', allowedFiles: ['a.js', 'b.js', 'src/legacy/x.js'] }] });
  const policy = { adaptiveRoute: 'on', routeLimits: { maxFiles: 2, protectedPaths: ['src/legacy/'] } };
  assert.deepEqual(route(p, policy).reasons, ['too_many_files', 'protected_path:src/legacy/x.js']);
});

test('plan route: malformed input does not throw', () => {
  assert.equal(gate.evaluatePlanRoute({ classification: 'bugfix', plan: undefined, policy: on }).verdict, 'full');
  assert.equal(gate.evaluatePlanRoute().verdict, 'full');
  const bad = route({ route: 'lean', checkIds: 'x', stages: 'nope' });
  assert.equal(bad.verdict, 'full');
  assert.ok(bad.reasons.includes('no_mechanical_check'));
  assert.equal(route({ route: 'lean', checkIds: ['c'], stages: [null, { allowedFiles: 'x' }] }).verdict, 'lean');
});

const delta = (extra = {}) => gate.evaluateDelta({
  allowedFiles: ['src/a.js'],
  changed: [{ path: 'src/a.js', addedLines: 5, removedLines: 5 }],
  checksPassed: true,
  scopeExpansions: 0,
  needsDecision: false,
  limits: gate.resolveRouteLimits(),
  ...extra,
});

test('delta: clean delta does not promote', () => {
  assert.deepEqual(delta(), { promote: false, reasons: [] });
  assert.equal(delta({ changed: [] }).promote, false);
});

test('delta: each reason code', () => {
  assert.deepEqual(delta({ changed: null }).reasons, ['delta_unknown']);
  assert.deepEqual(delta({ checksPassed: false }).reasons, ['check_not_passed']);
  assert.deepEqual(delta({ checksPassed: undefined }).reasons, ['check_not_passed']);
  assert.deepEqual(delta({ changed: [{ path: 'src/b.js', addedLines: 1, removedLines: 0 }] }).reasons, ['outside_allowed_files:src/b.js']);
  assert.deepEqual(
    delta({ allowedFiles: ['composer.json'], changed: [{ path: 'composer.json', addedLines: 1, removedLines: 0 }] }).reasons,
    ['protected_path:composer.json'],
  );
  assert.deepEqual(delta({ changed: [{ path: 'src/a.js', addedLines: 20, removedLines: 11 }] }).reasons, ['too_many_changed_lines']);
  assert.equal(delta({ changed: [{ path: 'src/a.js', addedLines: 20, removedLines: 10 }] }).promote, false);
  assert.deepEqual(delta({ scopeExpansions: 1 }).reasons, ['scope_expansion']);
  assert.deepEqual(delta({ needsDecision: true }).reasons, ['needs_decision']);
});

test('delta: custom limits and extra protected paths', () => {
  const limits = gate.resolveRouteLimits({ maxChangedLines: 5, protectedPaths: ['src/'] });
  assert.deepEqual(delta({ limits }).reasons, ['protected_path:src/a.js', 'too_many_changed_lines']);
});

test('delta: fail closed on malformed input', () => {
  assert.deepEqual(delta({ changed: [{ path: 'src/a.js', addedLines: -1, removedLines: 0 }] }).reasons, ['delta_unknown']);
  assert.equal(delta({ changed: [{ path: 'src/a.js', addedLines: 1.5, removedLines: 0 }] }).promote, true);
  assert.equal(delta({ changed: [{ path: 'src/a.js', addedLines: '1', removedLines: 0 }] }).promote, true);
  assert.equal(delta({ changed: 'x' }).promote, true);
  assert.equal(delta({ changed: [null] }).promote, true);
  assert.equal(gate.evaluateDelta().promote, true);
  assert.equal(gate.evaluateDelta({}).promote, true);
  assert.equal(delta({ allowedFiles: 'x' }).promote, true);
});

test('delta: reasons keep documented order', () => {
  const r = gate.evaluateDelta({
    allowedFiles: [], changed: [{ path: '.env', addedLines: 40, removedLines: 0 }],
    checksPassed: false, scopeExpansions: 2, needsDecision: true,
  });
  assert.deepEqual(r.reasons, [
    'check_not_passed', 'outside_allowed_files:.env', 'protected_path:.env',
    'too_many_changed_lines', 'scope_expansion', 'needs_decision',
  ]);
});
