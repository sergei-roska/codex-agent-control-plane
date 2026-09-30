'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 100000;
const MAX_DISPLAY_NAME_CHARS = 255;
const STORAGE_REF_PATTERN = /^[A-Za-z0-9_-]{2}\/art_[A-Za-z0-9_-]{22}$/;

const hasPrefix = (buffer, bytes, offset = 0) => buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);
const isPng = (b) => hasPrefix(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpeg = (b) => hasPrefix(b, [0xff, 0xd8, 0xff]);
const isWebp = (b) => hasPrefix(b, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(b, [0x57, 0x45, 0x42, 0x50], 8);
const isPdf = (b) => hasPrefix(b, [0x25, 0x50, 0x44, 0x46, 0x2d]);
const isOle = (b) => hasPrefix(b, [0xd0, 0xcf, 0x11, 0xe0]);
const isZip = (b) => hasPrefix(b, [0x50, 0x4b, 0x03, 0x04]);

const FORMATS = {
  '.txt': { mediaType: 'text/plain', kind: 'text' },
  '.md': { mediaType: 'text/markdown', kind: 'text' },
  '.json': { mediaType: 'application/json', kind: 'text', json: true },
  '.png': { mediaType: 'image/png', kind: 'image', magic: isPng },
  '.jpg': { mediaType: 'image/jpeg', kind: 'image', magic: isJpeg },
  '.jpeg': { mediaType: 'image/jpeg', kind: 'image', magic: isJpeg },
  '.webp': { mediaType: 'image/webp', kind: 'image', magic: isWebp },
  '.pdf': { mediaType: 'application/pdf', kind: 'reference', magic: isPdf },
  '.doc': { mediaType: 'application/msword', kind: 'reference', magic: isOle },
  '.docx': { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'reference', magic: isZip }
};

class ArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

function sanitizeDisplayName(headerValue) {
  if (typeof headerValue !== 'string') throw new ArtifactError('invalid_request', 'Filename is required');
  let decoded;
  try {
    decoded = decodeURIComponent(headerValue);
  } catch {
    throw new ArtifactError('invalid_request', 'Filename is not valid percent-encoded UTF-8');
  }
  const parts = decoded.split(/[\\/]/);
  const name = parts[parts.length - 1]
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  const capped = Array.from(name).slice(0, MAX_DISPLAY_NAME_CHARS).join('').trim();
  if (!capped || capped === '.' || capped === '..') throw new ArtifactError('invalid_request', 'Filename is empty');
  return capped;
}

function extensionOf(displayName) {
  const index = displayName.lastIndexOf('.');
  return index > 0 ? displayName.slice(index).toLowerCase() : '';
}

function truncateUtf16(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function classify(displayName, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new ArtifactError('invalid_request', 'File content must be a Buffer');
  if (buffer.length === 0) throw new ArtifactError('invalid_request', 'File is empty');
  if (buffer.length > MAX_ARTIFACT_BYTES) throw new ArtifactError('invalid_request', 'File exceeds 10 MiB');
  const format = FORMATS[extensionOf(String(displayName))];
  if (!format) throw new ArtifactError('unsupported_media_type', 'Unsupported file extension');

  if (format.kind === 'text') {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new ArtifactError('unsupported_media_type', 'File content is not valid UTF-8');
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (format.json) {
      try {
        JSON.parse(text);
      } catch {
        throw new ArtifactError('unsupported_media_type', 'File content is not valid JSON');
      }
    }
    const { text: extractedText, truncated } = truncateUtf16(text, MAX_EXTRACTED_CHARS);
    return { mediaType: format.mediaType, extraction: 'extracted', extractedText, extractedChars: extractedText.length, extractionTruncated: truncated };
  }

  if (!format.magic(buffer)) throw new ArtifactError('unsupported_media_type', 'File content does not match its extension');
  return {
    mediaType: format.mediaType,
    extraction: format.kind === 'image' ? 'stored_not_read' : 'reference_only',
    extractedText: null,
    extractedChars: null,
    extractionTruncated: false
  };
}

function defaultArtifactRoot(stateFilePath) {
  if (process.env.CODEX_A2A_ARTIFACT_DIR) return path.resolve(process.env.CODEX_A2A_ARTIFACT_DIR);
  if (!stateFilePath || stateFilePath === ':memory:') return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-a2a-artifacts-'));
  return path.join(path.dirname(path.resolve(stateFilePath)), 'artifacts');
}

class ArtifactStore {
  constructor({ root, randomId } = {}) {
    if (!root || typeof root !== 'string') throw new TypeError('ArtifactStore requires a root directory');
    this.root = path.resolve(root);
    this.randomId = randomId || (() => crypto.randomBytes(16).toString('base64url'));
  }

  ensureRoot() {
    // mkdirSync(recursive) returns the first directory it created, or undefined if the root already existed.
    const created = fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }) !== undefined;
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Artifact root must be a real directory: ${this.root}`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      if (!created && (stat.mode & 0o077) !== 0) {
        throw new Error(`Artifact root ${this.root} is accessible to group/other; it must have mode 0700 (chmod 700 it)`);
      }
      fs.chmodSync(this.root, 0o700);
    }
    return this.root;
  }

  resolveRef(storageRef) {
    if (typeof storageRef !== 'string' || !STORAGE_REF_PATTERN.test(storageRef)) {
      throw new ArtifactError('invalid_request', 'Invalid storage reference');
    }
    const [shard, id] = storageRef.split('/');
    if (id.slice(4, 6) !== shard) throw new ArtifactError('invalid_request', 'Invalid storage reference');
    const resolved = path.resolve(this.root, storageRef);
    if (!resolved.startsWith(this.root + path.sep)) throw new ArtifactError('invalid_request', 'Invalid storage reference');
    return resolved;
  }

  store(buffer, displayName) {
    const classified = classify(displayName, buffer);
    this.ensureRoot();
    const artifactId = `art_${this.randomId()}`;
    const storageRef = `${artifactId.slice(4, 6)}/${artifactId}`;
    const target = this.resolveRef(storageRef);
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dirStat = fs.lstatSync(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error(`Artifact directory must be a real directory: ${directory}`);
    if ((dirStat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);

    const temp = path.join(directory, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    const descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      try {
        fs.writeFileSync(descriptor, buffer);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
    return {
      artifactId,
      displayName,
      mediaType: classified.mediaType,
      size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      storageRef,
      extraction: classified.extraction,
      extractedChars: classified.extractedChars,
      extractionTruncated: classified.extractionTruncated
    };
  }

  read(storageRef) {
    return fs.readFileSync(this.resolveRef(storageRef));
  }

  createReadStream(storageRef) {
    return fs.createReadStream(this.resolveRef(storageRef));
  }

  // Removes stale .tmp-* files and artifact files that no row knows about (isKnown(id) false).
  sweep({ olderThanMs = 0, tmpOlderThanMs = 60 * 60 * 1000, isKnown, now = Date.now() } = {}) {
    const result = { tmp: 0, orphans: 0 };
    if (!fs.existsSync(this.root)) return result;
    for (const shard of fs.readdirSync(this.root)) {
      const dir = path.join(this.root, shard);
      let stat;
      try { stat = fs.lstatSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
          const fileStat = fs.lstatSync(file);
          if (!fileStat.isFile()) continue;
          const age = now - fileStat.mtimeMs;
          if (name.startsWith('.tmp-')) {
            if (age > tmpOlderThanMs) { fs.unlinkSync(file); result.tmp += 1; }
          } else if (/^art_[A-Za-z0-9_-]{22}$/.test(name) && age > olderThanMs && typeof isKnown === 'function' && !isKnown(name)) {
            fs.unlinkSync(file);
            result.orphans += 1;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    return result;
  }

  remove(storageRef) {
    try {
      fs.unlinkSync(this.resolveRef(storageRef));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = {
  ArtifactError,
  ArtifactStore,
  MAX_ARTIFACT_BYTES,
  MAX_EXTRACTED_CHARS,
  classify,
  defaultArtifactRoot,
  sanitizeDisplayName
};
