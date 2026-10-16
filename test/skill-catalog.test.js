'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_SKILLS_ROOT, loadSkillCatalog, findSkillCandidates, resolveSkillSelection } = require('../src/skill-catalog');

function writeSkill(root, id, { description = 'Review safe execution flows', keywords = '["review", "security"]', audience, body = 'Instructions.' } = {}) {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  const content = `---\nname: ${id}\ndescription: ${description}\nkeywords: ${keywords}\n${audience ? `audience: ${audience}\n` : ''}---\n${body}\n`;
  fs.writeFileSync(path.join(directory, 'SKILL.md'), content);
  return { path: path.join(directory, 'SKILL.md'), content };
}

test('loads catalog entries in stable order with full-content hashes and no external scanning', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const z = writeSkill(root, 'z-review');
  const a = writeSkill(root, 'a-review');
  fs.mkdirSync(path.join(root, 'not-a-skill'));
  fs.writeFileSync(path.join(root, 'outside.md'), 'ignored?');
  // Non-directory root entries are malformed to avoid silently hiding catalog mistakes.
  assert.throws(() => loadSkillCatalog({ root }), /Malformed skill entry/);
  fs.rmSync(path.join(root, 'outside.md'));
  fs.rmSync(path.join(root, 'not-a-skill'), { recursive: true, force: true });
  const catalog = loadSkillCatalog({ root });
  assert.deepEqual([...catalog.keys()], ['a-review', 'z-review']);
  assert.equal(catalog.get('a-review').path, a.path);
  assert.equal(catalog.get('z-review').sha256, crypto.createHash('sha256').update(z.content, 'utf8').digest('hex'));
  assert.deepEqual(catalog.get('a-review').mcpServers, []);
  assert.equal(catalog.get('a-review').audience, 'worker');
  assert.throws(() => loadSkillCatalog({ root: path.join(root, 'missing') }), /ENOENT/);
});

test('lead-only skills are excluded from worker candidates and worker assignment resolution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSkill(root, 'worker-review', { description: 'Review decomposition plans', keywords: '["decomposition"]' });
  writeSkill(root, 'lead-decomposition', { description: 'Review decomposition plans', keywords: '["decomposition"]', audience: 'lead' });
  const catalog = loadSkillCatalog({ root });
  assert.deepEqual(findSkillCandidates(catalog, 'decomposition').map(({ id }) => id), ['worker-review']);
  assert.deepEqual(findSkillCandidates(catalog, 'decomposition', { audience: 'lead' }).map(({ id }) => id), ['lead-decomposition']);
  assert.throws(() => resolveSkillSelection(catalog, ['lead-decomposition']), /not available to worker/);
  assert.equal(resolveSkillSelection(catalog, ['lead-decomposition'], { audience: 'lead' })[0].id, 'lead-decomposition');
});

test('audience metadata accepts quoted values and rejects unknown audiences', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = writeSkill(root, 'quoted-audience');
  fs.writeFileSync(entry.path, entry.content.replace('---\nInstructions.', 'audience: "lead"\n---\nInstructions.'));
  assert.equal(loadSkillCatalog({ root }).get('quoted-audience').audience, 'lead');
  fs.writeFileSync(entry.path, entry.content.replace('---\nInstructions.', 'audience: admin\n---\nInstructions.'));
  assert.throws(() => loadSkillCatalog({ root }), /audience must be worker or lead/);
});

test('returns an empty map for a missing default catalog directory', () => {
  assert.equal(path.isAbsolute(DEFAULT_SKILLS_ROOT), true);
  assert.ok(loadSkillCatalog() instanceof Map);
});

test('ranks relevant candidates deterministically and enforces the shortlist bound', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 20; index += 1) writeSkill(root, `review-${String(index).padStart(2, '0')}`, { description: 'Review access security', keywords: '["access"]' });
  const catalog = loadSkillCatalog({ root });
  const candidates = findSkillCandidates(catalog, 'access', { limit: 99 });
  assert.equal(candidates.length, 12);
  assert.deepEqual(candidates, findSkillCandidates(catalog, 'access', { limit: 99 }));
  assert.deepEqual(findSkillCandidates(catalog, 'unrelated', {}), []);
  assert.deepEqual(Object.keys(candidates[0]).sort(), ['description', 'id']);
});

test('selection enforces count, uniqueness, pins, canonical paths, and unchanged content', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = writeSkill(root, 'review-skill');
  const catalog = loadSkillCatalog({ root });
  const sha256 = catalog.get('review-skill').sha256;
  assert.deepEqual(resolveSkillSelection(catalog, ['review-skill'], { pins: [{ id: 'review-skill', sha256 }] })[0], {
    id: 'review-skill', name: 'review-skill', path: entry.path, sha256,
  });
  assert.throws(() => resolveSkillSelection(catalog, ['review-skill', 'review-skill']), /unique/);
  assert.throws(() => resolveSkillSelection(catalog, ['unknown']), /Unknown skill/);
  assert.throws(() => resolveSkillSelection(catalog, ['review-skill'], { pins: [] }), /exactly cover/);
  assert.throws(() => resolveSkillSelection(catalog, ['review-skill'], { pins: [{ id: 'review-skill', sha256: '0'.repeat(64) }] }), /pin/);
  assert.throws(() => resolveSkillSelection(catalog, Array(6).fill('review-skill')), /at most five/);
  const outside = path.join(root, 'external-SKILL.md');
  fs.writeFileSync(outside, entry.content);
  catalog.get('review-skill').path = outside;
  assert.throws(() => resolveSkillSelection(catalog, ['review-skill']), /path changed/);
  catalog.get('review-skill').path = entry.path;
  fs.appendFileSync(entry.path, 'changed');
  assert.throws(() => resolveSkillSelection(catalog, ['review-skill']), /changed since catalog load/);
});

test('rejects malformed frontmatter and symlink escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  writeSkill(root, 'bad', { keywords: 'not-json' });
  assert.throws(() => loadSkillCatalog({ root }), /keywords must be a JSON/);
  fs.rmSync(path.join(root, 'bad'), { recursive: true, force: true });
  writeSkill(outside, 'escape');
  fs.symlinkSync(path.join(outside, 'escape'), path.join(root, 'escape'));
  assert.throws(() => loadSkillCatalog({ root }), /Malformed skill entry/);
});
