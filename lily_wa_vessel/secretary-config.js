const fs = require('fs');
const { normalizeInternationalNumber, atomicWriteJson } = require('./wa_policy');

function createSecretaryConfig({ fetchSettings, cachePath, now = Date.now, onChange = () => {} }) {
    let snapshot = null;
    try { if (cachePath) snapshot = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* Start closed. */ }
    let checkedAt = 0;
    let current = null;
    const fresh = () => snapshot && checkedAt > 0 && now() - checkedAt < 30000;
    return {
        async refresh() {
            if (current) return current;
            current = (async () => {
                try {
                    const next = await fetchSettings();
                    if (!next?.settings || !['off', 'auto', 'active'].includes(next.settings.mode)
                        || !Array.isArray(next.settings.contacts) || typeof next.revision !== 'string') {
                        throw new Error('Invalid secretary settings');
                    }
                    const changed = !checkedAt || next.revision !== snapshot?.revision;
                    if (cachePath && changed) atomicWriteJson(cachePath, next);
                    snapshot = next;
                    checkedAt = now();
                    if (changed) onChange(next.settings);
                    return true;
                } catch { return false; }
                finally { current = null; }
            })();
            return current;
        },
        fresh,
        settings: () => fresh() ? snapshot.settings : null,
        snapshot: () => fresh() ? snapshot : null,
        explicitAction(number) {
            if (!snapshot?.settings?.contacts) return null;
            const normalized = normalizeInternationalNumber(number);
            return snapshot.settings.contacts.find((item) => item.number === normalized)?.action || null;
        },
        action(number) {
            // Retain ignore/summary exclusions even if Core is offline.
            if (!snapshot?.settings?.contacts) return 'ignore';
            const normalized = normalizeInternationalNumber(number);
            return snapshot.settings.contacts.find((item) => item.number === normalized)?.action
                || snapshot.settings.default_action;
        },
    };
}

module.exports = { createSecretaryConfig };
