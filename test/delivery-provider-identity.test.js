'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { providerIdentityFor, createProviderIdentityPin } = require('../src/delivery-provider-identity');

function homeFixture(t, accountId = 'opaque-account-value') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ tokens: { account_id: accountId, access_token: 'private-token' } }));
  return root;
}

test('provider identity uses only a one-way account digest and canonical home', (t) => {
  const home = homeFixture(t);
  const identity = providerIdentityFor(home);
  assert.equal(identity.accountId, crypto.createHash('sha256').update('opaque-account-value').digest('hex'));
  assert.equal(identity.codexHome, fs.realpathSync(home));
  assert.equal(JSON.stringify(identity).includes('private-token'), false);
});

test('identity pin rereads account metadata so account replacement is detected', (t) => {
  const home = homeFixture(t, 'first-account');
  const pin = createProviderIdentityPin(home);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'second-account' } }));
  assert.notDeepEqual(pin.providerIdentityFor(), pin.providerIdentity);
});

test('identity failures are typed without exposing malformed credential contents', (t) => {
  const home = homeFixture(t);
  fs.writeFileSync(path.join(home, 'auth.json'), '{"access_token":"do-not-report"');
  assert.throws(() => providerIdentityFor(home), (error) => {
    assert.equal(error.code, 'auth_metadata_invalid');
    assert.equal(error.message.includes('do-not-report'), false);
    return true;
  });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: ' ' } }));
  assert.throws(() => providerIdentityFor(home), { code: 'account_identity_unavailable' });
});

test('identity loader accepts metadata from an injected disposable source', (t) => {
  const home = homeFixture(t);
  const identity = providerIdentityFor(home, { metadataLoader: () => ({ tokens: { account_id: 'test-account' } }) });
  assert.equal(identity.accountId, crypto.createHash('sha256').update('test-account').digest('hex'));
});
