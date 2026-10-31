const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildSecretaryAcknowledgement,
    classifyIncomingMessage,
    decideTriageRoute,
    createContactPolicyStore,
    normalizeInternationalNumber,
} = require('./wa_policy');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-wa-policy-'));
const policyPath = path.join(temporaryDirectory, 'policy.json');

try {
    const store = createContactPolicyStore(policyPath);
    assert.strictEqual(normalizeInternationalNumber('0812-3456-7890'), '628000000002');
    assert.strictEqual(store.add('circle', '0812-3456-7890').changed, true);
    assert.strictEqual(store.add('circle', '+62 812 3456 7890').changed, false);
    assert.strictEqual(store.has('circle', '628000000002'), true);
    assert.strictEqual(store.remove('circle', '08000000002').changed, true);

    assert.strictEqual(classifyIncomingMessage('Tolong kirim OTP dan PIN-nya').decision, 'hold');
    assert.strictEqual(classifyIncomingMessage('Promo diskon, beli sekarang!').decision, 'quarantine');
    assert.strictEqual(classifyIncomingMessage('https://shopee.example/item').decision, 'hold');
    assert.strictEqual(classifyIncomingMessage('Beli sekarang ya', { isForwarded: true }).decision, 'hold');
    assert.strictEqual(classifyIncomingMessage('Forwarded hello', { isForwarded: true }).decision, 'hold');
    assert.strictEqual(classifyIncomingMessage('Halo, nanti kabari ya').decision, 'routine');
    for (const text of ['Okeh aman aja.', 'Tunggu hari H aja.', 'Nanti ku kabari.', 'Okh.', 'Sip makasih.', 'Thanks!', 'Siap.']) {
        const result = classifyIncomingMessage(text);
        assert.strictEqual(result.decision, 'no_reply', text);
        assert.strictEqual(decideTriageRoute(result, 'shadow', 'secretary').allowAutomaticReply, false, text);
    }
    for (const text of ['[sticker].', '[document attachment].', '[voice message].']) {
        assert.strictEqual(classifyIncomingMessage(text).decision, 'hold', text);
    }
    for (const text of ['Okeh aman aja, tapi besok jadi?', 'Tolong kabari aku besok', 'Besok jadi ketemu', 'Makasih, tapi alamatnya di mana?']) {
        assert.strictEqual(classifyIncomingMessage(text).decision, 'routine', text);
    }
    const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests/wa-triage-cases.json'), 'utf8'));
    let protectedCases = 0;
    for (const item of cases) {
        const result = classifyIncomingMessage(item.text, item.metadata || {});
        assert.strictEqual(result.category, item.category, item.text);
        if (['delivery', 'sensitive_delivery', 'uncertain'].includes(item.category)) {
            protectedCases++;
            assert.equal(decideTriageRoute(result, 'enforce', null).quietNotification, false, item.text);
            assert.equal(decideTriageRoute(result, 'enforce', null).allowAutomaticReply, false, item.text);
        }
    }
    const clearPromo = classifyIncomingMessage('Promo diskon, beli sekarang!');
    assert.equal(decideTriageRoute(clearPromo, 'shadow', null).quietNotification, false);
    assert.equal(decideTriageRoute(clearPromo, 'enforce', 'summary_only').quietNotification, false);
    assert.equal(decideTriageRoute(clearPromo, 'enforce', null).quietNotification, true);
    assert.equal(decideTriageRoute(clearPromo, 'enforce', null).allowAutomaticReply, false);
    assert.equal(decideTriageRoute(classifyIncomingMessage('Paket sedang diantar'), 'enforce', null).quietNotification, false);
    assert.match(buildSecretaryAcknowledgement('en', 'Lily User', false), /I am Lily/);
    assert.match(buildSecretaryAcknowledgement('id', 'Lily User', true), /sudah Lily simpan/);
    assert.deepStrictEqual(fs.readdirSync(temporaryDirectory).filter((name) => name.endsWith('.tmp')), []);
    console.log(`wa policy contract tests passed; 0/${protectedCases} protected examples were quieted`);
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
