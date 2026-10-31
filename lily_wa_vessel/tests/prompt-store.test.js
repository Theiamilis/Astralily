const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../../prompts/defaults.json');
const code = fs.readFileSync(path.join(__dirname, '../prompt-store.js'), 'utf8');
test('custom templates are cached for offline use and substituted without evaluation', async () => {
    let saved = '';
    const fakeFs = { readFileSync() { throw Error('missing'); }, mkdirSync() {}, writeFileSync(_p, text) { saved = text; }, renameSync() {} };
    let now = 100000;
    const context = { __dirname: '/test', module: { exports: {} }, Date: { now: () => now },
        require: name => name === 'node:fs' ? fakeFs : name === 'node:path' ? path : defaults };
    vm.createContext(context); vm.runInContext(code, context);
    const store = context.module.exports;
    const templates = Object.entries(defaults).map(([id,item]) => ({ id, text: item.text }));
    templates.find(item => item.id === 'wa_owner_fallback').text += '\nCustom style.';
    const values = { ownerName: 'Alex', languageLabel: 'English', languageTone: '{{literal}}' };
    const text = await store.renderPrompt('wa_owner_fallback', values, async () => ({ templates }));
    assert.ok(text.includes('Custom style.'));
    assert.ok(text.includes('{{literal}}'));
    assert.ok(saved.includes('Custom style.'));
    now += 61000;
    const offline = await store.renderPrompt('wa_owner_fallback', values, async () => { throw Error('offline'); });
    assert.equal(offline, text);
});
