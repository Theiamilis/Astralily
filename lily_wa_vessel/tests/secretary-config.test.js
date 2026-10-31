const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretaryConfig } = require('../secretary-config');

const snapshot = { revision: 'a', settings: { mode: 'off', default_action: 'secretary', contacts: [
    { number: '628000000002', action: 'ignore' }, { number: '628000000003', action: 'summary_only' },
] } };

test('startup stays closed, rules normalize numbers, unchanged refresh does not cancel work', async () => {
    let updates = 0;
    const c = createSecretaryConfig({ fetchSettings: async () => snapshot, onChange: () => updates++ });
    assert.equal(c.action('08000000002'), 'ignore');
    assert.equal(c.settings(), null);
    await c.refresh(); await c.refresh();
    assert.equal(c.action('08000000002'), 'ignore');
    assert.equal(c.action('+62 813 3456 7890'), 'summary_only');
    assert.equal(c.action('628000000004'), 'secretary');
    assert.equal(c.explicitAction('08000000003'), 'summary_only');
    assert.equal(c.explicitAction('628000000004'), null);
    assert.equal(updates, 1);
});

test('offline cache preserves exclusions but never permits old enabled settings', async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-cache-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const cachePath = path.join(folder, 'cache.json');
    let clock = 100000; let offline = false;
    const fetchSettings = async () => { if (offline) throw new Error('offline'); return { ...snapshot, settings: { ...snapshot.settings, mode: 'active' } }; };
    const c = createSecretaryConfig({ cachePath, fetchSettings, now: () => clock });
    await c.refresh(); assert.equal(c.settings().mode, 'active');
    offline = true; clock += 30001; await c.refresh();
    assert.equal(c.settings(), null);
    assert.equal(c.action('08000000002'), 'ignore');
    const restored = createSecretaryConfig({ cachePath, fetchSettings, now: () => clock });
    assert.equal(restored.settings(), null);
    assert.equal(restored.action('08000000003'), 'summary_only');
});
