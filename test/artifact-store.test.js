'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ArtifactStore, classify, defaultArtifactRoot, sanitizeDisplayName } = require('../src/artifact-store');

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]);
const pdf = Buffer.from('%PDF-1.4\n');
const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-test-'));
  return path.join(dir, 'artifacts');
}

function code(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('allowed extensions classify with media type and extraction class', () => {
  const cases = [
    ['a.txt', Buffer.from('hi'), 'text/plain', 'extracted'],
    ['a.md', Buffer.from('# hi'), 'text/markdown', 'extracted'],
    ['a.json', Buffer.from('{"a":1}'), 'application/json', 'extracted'],
    ['a.png', png, 'image/png', 'stored_not_read'],
    ['a.jpg', jpeg, 'image/jpeg', 'stored_not_read'],
    ['a.JPEG', jpeg, 'image/jpeg', 'stored_not_read'],
    ['a.webp', webp, 'image/webp', 'stored_not_read'],
    ['a.pdf', pdf, 'application/pdf', 'reference_only'],
    ['a.doc', ole, 'application/msword', 'reference_only'],
    ['a.DOCX', zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'reference_only']
  ];
  for (const [name, buffer, mediaType, extraction] of cases) {
    const result = classify(name, buffer);
    assert.equal(result.mediaType, mediaType, name);
    assert.equal(result.extraction, extraction, name);
    if (extraction === 'extracted') assert.equal(typeof result.extractedText, 'string');
    else assert.deepEqual([result.extractedText, result.extractedChars, result.extractionTruncated], [null, null, false]);
  }
});

test('content mismatches and unknown extensions are rejected', () => {
  for (const [name, buffer] of [
    ['a.png', Buffer.from('plain text')],
    ['a.jpg', png],
    ['a.webp', Buffer.from('RIFF\0\0\0\0WAVE')],
    ['a.pdf', zip],
    ['a.doc', zip],
    ['a.docx', ole],
    ['a.txt', Buffer.from([0xff, 0xfe, 0xfd])],
    ['a.json', Buffer.from('{bad')],
    ['a.json', Buffer.from('')],
    ['a.html', Buffer.from('<p>')],
    ['a.svg', Buffer.from('<svg/>')],
    ['a.exe', Buffer.from('MZ')],
    ['noext', Buffer.from('x')],
    ['.txt', Buffer.from('x')]
  ]) {
    if (buffer.length === 0) continue;
    assert.equal(code(() => classify(name, buffer)), 'unsupported_media_type', name);
  }
});

test('size limits', () => {
  assert.equal(code(() => classify('a.txt', Buffer.alloc(0))), 'invalid_request');
  assert.equal(code(() => classify('a.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))), 'invalid_request');
  assert.equal(classify('a.txt', Buffer.alloc(10 * 1024 * 1024, 0x61)).extraction, 'extracted');
});

test('extraction truncates at 100000 code units without splitting a surrogate pair', () => {
  const plain = classify('a.txt', Buffer.from('a'.repeat(100001)));
  assert.equal(plain.extractedChars, 100000);
  assert.equal(plain.extractionTruncated, true);
  assert.equal(classify('a.txt', Buffer.from('a'.repeat(100000))).extractionTruncated, false);

  const pair = classify('a.txt', Buffer.from('a'.repeat(99999) + '\u{1F600}'));
  assert.equal(pair.extractedChars, 99999);
  assert.equal(pair.extractedText, 'a'.repeat(99999));
  assert.equal(pair.extractionTruncated, true);

  const fits = classify('a.txt', Buffer.from('a'.repeat(99998) + '\u{1F600}'));
  assert.equal(fits.extractedChars, 100000);
  assert.equal(fits.extractionTruncated, false);
});

test('leading BOM is stripped for extraction and json parsing', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  assert.equal(classify('a.txt', Buffer.concat([bom, Buffer.from('hi')])).extractedText, 'hi');
  assert.equal(classify('a.json', Buffer.concat([bom, Buffer.from('{}')])).extractedText, '{}');
});

test('display name sanitizing', () => {
  assert.equal(sanitizeDisplayName('..%2F..%2Fetc%2Fpasswd'), 'passwd');
  assert.equal(sanitizeDisplayName('C:\\x\\y.txt'), 'y.txt');
  assert.equal(sanitizeDisplayName('a%00b%0A%1Fc.txt'), 'abc.txt');
  assert.equal(sanitizeDisplayName('%20 sp%C3%A9.txt '), 'sp\u00e9.txt');
  assert.equal(sanitizeDisplayName('a'.repeat(300)).length, 255);
  assert.equal(code(() => sanitizeDisplayName('%E0%A4%A')), 'invalid_request');
  assert.equal(code(() => sanitizeDisplayName('%ff')), 'invalid_request');
  assert.equal(code(() => sanitizeDisplayName('')), 'invalid_request');
  assert.equal(code(() => sanitizeDisplayName('dir%2F')), 'invalid_request');
  assert.equal(code(() => sanitizeDisplayName('%00%01')), 'invalid_request');
  assert.equal(code(() => sanitizeDisplayName(undefined)), 'invalid_request');
});

test('store writes 0600 file in 0700 dirs, hashes, reads, streams and removes', async () => {
  const root = tempRoot();
  const store = new ArtifactStore({ root });
  store.ensureRoot();
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const body = Buffer.from('hello world');
  const meta = store.store(body, '../evil.txt'.split('/').pop());
  assert.match(meta.artifactId, /^art_[A-Za-z0-9_-]{22}$/);
  assert.equal(meta.storageRef, `${meta.artifactId.slice(4, 6)}/${meta.artifactId}`);
  assert.equal(meta.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(meta.size, body.length);
  assert.equal(meta.mediaType, 'text/plain');
  assert.equal(meta.extraction, 'extracted');
  assert.equal(meta.extractedChars, 11);
  const file = path.join(root, meta.storageRef);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [meta.artifactId]);
  assert.deepEqual(store.read(meta.storageRef), body);
  const chunks = [];
  for await (const chunk of store.createReadStream(meta.storageRef)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), body);
  store.remove(meta.storageRef);
  assert.equal(fs.existsSync(file), false);
  store.remove(meta.storageRef);
});

test('store rejects invalid content without writing', () => {
  const root = tempRoot();
  const store = new ArtifactStore({ root });
  assert.equal(code(() => store.store(Buffer.from('x'), 'a.png')), 'unsupported_media_type');
  assert.equal(fs.existsSync(root) ? fs.readdirSync(root).length : 0, 0);
});

test('storageRef traversal attempts are rejected', () => {
  const store = new ArtifactStore({ root: tempRoot() });
  store.ensureRoot();
  const id = 'art_' + 'A'.repeat(22);
  for (const ref of [
    '../etc/passwd',
    'ab/../../x',
    `/${id}`,
    `AA/${id}/..`,
    `AA/${id}x`,
    `..${'/'}${id}`,
    `AA\\${id}`,
    `AA/art_${'A'.repeat(21)}.`,
    `BB/${id}`,
    '',
    null
  ]) {
    assert.equal(code(() => store.read(ref)), 'invalid_request', String(ref));
    assert.equal(code(() => store.remove(ref)), 'invalid_request', String(ref));
  }
});

test('a symlinked root is refused', () => {
  const root = tempRoot();
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const real = path.join(path.dirname(root), 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, root);
  assert.throws(() => new ArtifactStore({ root }).ensureRoot(), /real directory/);
});

test('defaultArtifactRoot', () => {
  const saved = process.env.CODEX_A2A_ARTIFACT_DIR;
  try {
    delete process.env.CODEX_A2A_ARTIFACT_DIR;
    assert.equal(defaultArtifactRoot('/var/x/state.db'), '/var/x/artifacts');
    const temp = defaultArtifactRoot(':memory:');
    assert.ok(fs.statSync(temp).isDirectory());
    assert.notEqual(temp, defaultArtifactRoot(':memory:'));
    process.env.CODEX_A2A_ARTIFACT_DIR = '/srv/art';
    assert.equal(defaultArtifactRoot('/var/x/state.db'), '/srv/art');
  } finally {
    if (saved === undefined) delete process.env.CODEX_A2A_ARTIFACT_DIR;
    else process.env.CODEX_A2A_ARTIFACT_DIR = saved;
  }
});

test('sanitizeDisplayName strips bidi and format controls', () => {
  assert.equal(sanitizeDisplayName(encodeURIComponent('report\u202etxt.exe')), 'reporttxt.exe');
  assert.equal(sanitizeDisplayName(encodeURIComponent('\u200ea\u200fb\u202a\u202b\u202c\u202d\u2066\u2067\u2068\u2069.txt')), 'ab.txt');
});

test('ensureRoot chmods only a directory it created and rejects a loose existing root', () => {
  const root = tempRoot();
  const store = new ArtifactStore({ root });
  store.ensureRoot();
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);

  const loose = tempRoot();
  fs.mkdirSync(loose, { mode: 0o755 });
  fs.chmodSync(loose, 0o755);
  assert.throws(() => new ArtifactStore({ root: loose }).ensureRoot(), (error) => error.message.includes(loose) && error.message.includes('0700'));
  assert.equal(fs.statSync(loose).mode & 0o777, 0o755);

  const strict = tempRoot();
  fs.mkdirSync(strict, { mode: 0o500 });
  fs.chmodSync(strict, 0o500);
  assert.doesNotThrow(() => new ArtifactStore({ root: strict }).ensureRoot());
  assert.equal(fs.statSync(strict).mode & 0o777, 0o700);
});

test('sweep removes stale tmp files and unknown old artifacts but keeps known and fresh ones', () => {
  const store = new ArtifactStore({ root: tempRoot() });
  const known = store.store(Buffer.from('known'), 'k.txt');
  const orphan = store.store(Buffer.from('orphan'), 'o.txt');
  const fresh = store.store(Buffer.from('fresh'), 'f.txt');
  const dir = path.dirname(store.resolveRef(orphan.storageRef));
  const oldTmp = path.join(dir, '.tmp-old');
  const freshTmp = path.join(dir, '.tmp-fresh');
  fs.writeFileSync(oldTmp, 'x');
  fs.writeFileSync(freshTmp, 'x');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  for (const file of [oldTmp, store.resolveRef(orphan.storageRef), store.resolveRef(known.storageRef)]) fs.utimesSync(file, old, old);
  const result = store.sweep({ olderThanMs: 24 * 3600 * 1000, isKnown: (id) => id === known.artifactId });
  assert.deepEqual(result, { tmp: 1, orphans: 1 });
  assert.equal(fs.existsSync(oldTmp), false);
  assert.equal(fs.existsSync(freshTmp), true);
  assert.equal(fs.existsSync(store.resolveRef(orphan.storageRef)), false);
  assert.equal(fs.existsSync(store.resolveRef(known.storageRef)), true);
  assert.equal(fs.existsSync(store.resolveRef(fresh.storageRef)), true);
});
