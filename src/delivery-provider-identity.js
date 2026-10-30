'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AUTH_BYTES = 1024 * 1024;

function identityError(code) {
  return Object.assign(new Error(`Provider identity unavailable (${code})`), { code });
}

function loadAuthMetadata(codexHome) {
  const authPath = path.join(codexHome, 'auth.json');
  let descriptor;
  try { descriptor = fs.openSync(authPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (_) { throw identityError('auth_metadata_unavailable'); }
  let data;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_AUTH_BYTES) throw identityError('auth_metadata_invalid');
    data = fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error?.code === 'auth_metadata_invalid') throw error;
    throw identityError('auth_metadata_unavailable');
  } finally {
    fs.closeSync(descriptor);
  }
  try { return JSON.parse(data); } catch (_) { throw identityError('auth_metadata_invalid'); }
}

function providerIdentityFor(codexHome, { metadataLoader = loadAuthMetadata } = {}) {
  if (typeof codexHome !== 'string' || !codexHome || typeof metadataLoader !== 'function') {
    throw identityError('identity_input_invalid');
  }
  let canonicalHome;
  try { canonicalHome = fs.realpathSync(codexHome); } catch (_) { throw identityError('home_unavailable'); }
  let metadata;
  try { metadata = metadataLoader(canonicalHome); } catch (error) {
    if (error?.code?.startsWith('auth_metadata_')) throw error;
    throw identityError('auth_metadata_unavailable');
  }
  const accountId = metadata?.tokens?.account_id;
  if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 4096) {
    throw identityError('account_identity_unavailable');
  }
  return {
    accountId: crypto.createHash('sha256').update(accountId, 'utf8').digest('hex'),
    codexHome: canonicalHome,
  };
}

function createProviderIdentityPin(codexHome, options = {}) {
  const providerIdentity = providerIdentityFor(codexHome, options);
  return {
    providerIdentity: Object.freeze({ ...providerIdentity }),
    providerIdentityFor: () => providerIdentityFor(codexHome, options),
  };
}

module.exports = { MAX_AUTH_BYTES, loadAuthMetadata, providerIdentityFor, createProviderIdentityPin };
