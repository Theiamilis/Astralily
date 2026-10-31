const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyProfileIdentity } = require('../wa_profile');

test('personal bridge accepts only the configured owner account', () => {
    assert.deepEqual(verifyProfileIdentity('personal', '628000000006', '08000000006', '628000000007'),
        { ok: true, state: 'verified' });
    assert.deepEqual(verifyProfileIdentity('personal', '628000000007', '08000000006', '628000000007'),
        { ok: false, state: 'account_mismatch' });
    assert.deepEqual(verifyProfileIdentity('personal', '628000000006', '628000000008, 08000000006', '628000000007'),
        { ok: true, state: 'verified' });
});

test('Lily bridge accepts only the configured Lily account', () => {
    assert.deepEqual(verifyProfileIdentity('public', '628000000007', '08000000006', '628000000007'),
        { ok: true, state: 'verified' });
    assert.deepEqual(verifyProfileIdentity('public', '628000000006', '08000000006', '628000000007'),
        { ok: false, state: 'account_mismatch' });
});

test('missing expected or connected identity fails closed', () => {
    assert.equal(verifyProfileIdentity('personal', '', '628000000006', '').state, 'identity_unavailable');
    assert.equal(verifyProfileIdentity('public', '628000000007', '628000000006', '').state, 'identity_unconfigured');
});
