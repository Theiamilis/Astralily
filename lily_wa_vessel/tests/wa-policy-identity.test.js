const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideTriageRoute, verifiedDirectPhoneNumber } = require('../wa_policy');

test('LID digits never stand in for a contact phone number', () => {
    const lid = '92453549942638@lid';
    const phone = '628000000005';
    const contact = { id: { _serialized: lid }, number: '92453549942638' };
    assert.equal(verifiedDirectPhoneNumber(lid, contact, [lid], '92453549942638'), '');
    assert.equal(verifiedDirectPhoneNumber(lid, contact, [lid, `${phone}@c.us`]), phone);
    assert.equal(verifiedDirectPhoneNumber(lid, contact, [lid, phone], '92453549942638'), phone);
    assert.equal(verifiedDirectPhoneNumber(lid, contact, [lid], phone), phone);
    assert.equal(verifiedDirectPhoneNumber(lid, { ...contact, number: phone }, [lid]), phone);
    assert.equal(verifiedDirectPhoneNumber(`${phone}@c.us`), phone);
});

test('summary-only and unresolved identities never receive automatic replies', () => {
    const routine = { category: 'personal', confidence: 'high', decision: 'routine' };
    assert.equal(decideTriageRoute(routine, 'shadow', 'summary_only', 'summary_only').allowAutomaticReply, false);
    assert.equal(decideTriageRoute(routine, 'shadow', null, 'summary_only').allowAutomaticReply, false);
    assert.equal(decideTriageRoute(routine, 'shadow', 'secretary', 'secretary').allowAutomaticReply, true);
});
