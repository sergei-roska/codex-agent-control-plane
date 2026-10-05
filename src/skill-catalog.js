'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SKILLS_ROOT = path.resolve(__dirname, '..', 'profiles', 'skills', 'library');
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ID_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 48;
const MAX_FILE_BYTES = 65_536;
const CATALOG_ROOTS = new WeakMap();

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parseSkill(source, id, filePath) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error(`${filePath}: missing YAML frontmatter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${filePath}: unterminated YAML frontmatter`);
  const metadata = Object.create(null);
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = line.match(/^([a-z_][a-z0-9_]*):\s*(.*?)\s*$/);
    if (!match) throw new Error(`${filePath}:${index + 1}: malformed frontmatter`);
    const [, key, value] = match;
    if (!['name', 'description', 'keywords'].includes(key)) continue;
    if (Object.hasOwn(metadata, key)) throw new Error(`${filePath}:${index + 1}: duplicate ${key}`);
    if (key === 'description' && /^>[+-]?$/.test(value)) {
      const folded = [];
      while (index + 1 < end && /^\s+\S/.test(lines[index + 1])) folded.push(lines[++index].trim());
      metadata[key] = folded.join(' ');
    } else if ((key === 'name' || key === 'description') && value.startsWith('"')) {
      try { metadata[key] = JSON.parse(value); } catch (error) { throw new Error(`${filePath}:${index + 1}: invalid quoted ${key}`, { cause: error }); }
    } else if ((key === 'name' || key === 'description') && value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error(`${filePath}:${index + 1}: invalid quoted ${key}`);
      metadata[key] = value.slice(1, -1).replace(/''/g, "'");
    } else {
      metadata[key] = value;
    }
  }
  if (!Object.hasOwn(metadata, 'name') || !Object.hasOwn(metadata, 'description')) {
    throw new Error(`${filePath}: frontmatter must contain name and description`);
  }
  const name = metadata.name;
  if (name !== id || name.length > MAX_ID_LENGTH || !ID_PATTERN.test(name)) {
    throw new Error(`${filePath}: name must match skill directory id ${id}`);
  }
  const description = metadata.description;
  if (!description || description.length > MAX_DESCRIPTION_LENGTH || /[\r\n\u0000-\u001f]/.test(description)) {
    throw new Error(`${filePath}: description must be a bounded single line`);
  }
  let keywords = [];
  if (Object.hasOwn(metadata, 'keywords')) {
    try {
      keywords = JSON.parse(metadata.keywords);
    } catch (error) {
      throw new Error(`${filePath}: keywords must be a JSON string array`, { cause: error });
    }
  }
  if (!Array.isArray(keywords) || keywords.length > MAX_KEYWORDS
    || keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim() || keyword.length > MAX_KEYWORD_LENGTH || /[\r\n\u0000-\u001f]/.test(keyword))) {
    throw new Error(`${filePath}: keywords must be a bounded JSON string array`);
  }
  if (new Set(keywords).size !== keywords.length) throw new Error(`${filePath}: keywords must be unique`);
  if (!keywords.length) keywords = [...new Set(tokens(`${name} ${description}`))].slice(0, MAX_KEYWORDS);
  return { id, name, description, keywords, mcpServers: [] };
}

function loadSkillCatalog({ root = DEFAULT_SKILLS_ROOT } = {}) {
  const requestedRoot = path.resolve(root);
  let rootReal;
  try {
    rootReal = fs.realpathSync(requestedRoot);
  } catch (error) {
    if (error.code === 'ENOENT' && requestedRoot === DEFAULT_SKILLS_ROOT) return new Map();
    throw error;
  }
  const rootStat = fs.lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Skills root must be a real directory: ${requestedRoot}`);

  const catalog = new Map();
  const entries = fs.readdirSync(rootReal, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Malformed skill entry: ${path.join(rootReal, entry.name)}`);
    const id = entry.name;
    if (id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id)) throw new Error(`Invalid skill directory id: ${id}`);
    const directory = path.join(rootReal, id);
    const file = path.join(directory, 'SKILL.md');
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Malformed skill entry (missing SKILL.md): ${directory}`);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error(`Malformed skill file: ${file}`);
    const canonicalDirectory = fs.realpathSync(directory);
    const canonicalFile = fs.realpathSync(file);
    if (!containedBy(rootReal, canonicalDirectory) || !containedBy(rootReal, canonicalFile) || canonicalFile !== file) {
      throw new Error(`Skill path escapes its root: ${file}`);
    }
    const contents = fs.readFileSync(canonicalFile, 'utf8');
    const parsed = parseSkill(contents, id, canonicalFile);
    const sha256 = crypto.createHash('sha256').update(contents, 'utf8').digest('hex');
    catalog.set(id, { ...parsed, path: canonicalFile, sha256 });
  }
  CATALOG_ROOTS.set(catalog, rootReal);
  return catalog;
}

function tokens(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function findSkillCandidates(catalog, query, { limit = 12 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer');
  const boundedLimit = Math.min(limit, 12);
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length || !boundedLimit) return [];
  const ranked = [];
  for (const [id, item] of catalog) {
    const nameTokens = new Set(tokens(`${id} ${item.name}`));
    const keywordTokens = new Set((item.keywords || []).flatMap(tokens));
    const descriptionTokens = new Set(tokens(item.description));
    let nameMatches = 0;
    let keywordMatches = 0;
    let descriptionMatches = 0;
    for (const token of queryTokens) {
      if (nameTokens.has(token)) nameMatches += 1;
      if (keywordTokens.has(token)) keywordMatches += 1;
      if (descriptionTokens.has(token)) descriptionMatches += 1;
    }
    if (nameMatches + keywordMatches + descriptionMatches === 0) continue;
    const exactName = tokens(id).join(' ') === queryTokens.join(' ');
    ranked.push({ id, description: item.description, score: (exactName ? 100 : 0) + nameMatches * 8 + keywordMatches * 4 + descriptionMatches, nameMatches, keywordMatches, descriptionMatches });
  }
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'));
  return ranked.slice(0, boundedLimit).map(({ id, description }) => ({ id, description }));
}

function resolveSkillSelection(catalog, ids, { pins } = {}) {
  if (!Array.isArray(ids)) throw new TypeError('skill ids must be an array');
  if (ids.length > 5) throw new TypeError('at most five skills may be selected');
  if (ids.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new TypeError('skill ids must be unique valid ids');
  }
  if (pins !== undefined) {
    if (!Array.isArray(pins) || pins.length !== ids.length) throw new TypeError('skill pins must exactly cover selected ids');
    const pinById = new Map();
    for (const pin of pins) {
      if (!pin || typeof pin !== 'object' || Array.isArray(pin) || typeof pin.id !== 'string' || !HASH_PATTERN.test(pin.sha256) || pinById.has(pin.id)) {
        throw new TypeError('skill pins are malformed or duplicated');
      }
      pinById.set(pin.id, pin.sha256);
    }
    if (ids.some((id) => !pinById.has(id))) throw new TypeError('skill pins must exactly cover selected ids');
  }
  return ids.map((id) => {
    const item = catalog.get(id);
    if (!item) throw new Error(`Unknown skill id: ${id}`);
    if (!HASH_PATTERN.test(item.sha256) || !path.isAbsolute(item.path)) throw new Error(`Malformed catalog entry for skill ${id}`);
    const root = CATALOG_ROOTS.get(catalog);
    if (!root) throw new Error('Skill catalog was not loaded by loadSkillCatalog');
    const canonical = fs.realpathSync(item.path);
    const stat = fs.statSync(canonical);
    if (canonical !== item.path || !containedBy(root, canonical) || !stat.isFile()
      || path.basename(canonical) !== 'SKILL.md' || path.basename(path.dirname(canonical)) !== id) {
      throw new Error(`Skill path changed for ${id}`);
    }
    const contents = fs.readFileSync(canonical);
    const currentHash = crypto.createHash('sha256').update(contents).digest('hex');
    if (currentHash !== item.sha256) throw new Error(`Skill file changed since catalog load: ${id}`);
    if (pins !== undefined && pins.find((pin) => pin.id === id)?.sha256 !== currentHash) throw new Error(`Skill pin does not match current catalog: ${id}`);
    return { id, name: item.name, path: canonical, sha256: currentHash };
  });
}

module.exports = { DEFAULT_SKILLS_ROOT, loadSkillCatalog, findSkillCandidates, resolveSkillSelection };
