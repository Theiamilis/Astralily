const { normalizeInternationalNumber } = require('./wa_policy');

function verifyProfileIdentity(profile, connectedNumber, ownerNumber, lilyNumber) {
    const expected = String(profile === 'public' ? lilyNumber || '' : ownerNumber || '')
        .split(/[\s,;]+/)
        .map((value) => normalizeInternationalNumber(value))
        .filter(Boolean);
    const connected = normalizeInternationalNumber(connectedNumber);
    if (!expected.length) return { ok: false, state: 'identity_unconfigured' };
    if (!connected) return { ok: false, state: 'identity_unavailable' };
    if (!expected.includes(connected)) return { ok: false, state: 'account_mismatch' };
    return { ok: true, state: 'verified' };
}

module.exports = { verifyProfileIdentity };
