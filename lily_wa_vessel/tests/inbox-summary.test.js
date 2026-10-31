const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8');
const fn = source.slice(source.indexOf('async function summarizeExternalMessage('), source.indexOf('\nfunction hasExternalInboxEntry('));

test('summary uses Core without Gemini and without request retries', async () => {
    const context = { LILY_CORE_URL: 'http://core/', console, requestCore: async (...args) => {
        assert.equal(args[1], 'http://core/api/wa/inbox/summarize');
        assert.equal(args[3], 15000);
        assert.equal(args[4], false);
        return { data: { summary: ' A summary. ' } };
    } };
    vm.createContext(context);
    vm.runInContext(fn, context);
    assert.equal(await context.summarizeExternalMessage('Alice', 'Hello'), 'A summary.');
});

test('offline, invalid, and empty provider replies retain a message excerpt', async () => {
    for (const reply of [null, {}, { data: { summary: '' } }]) {
        const context = { LILY_CORE_URL: 'http://core', console: { warn() {} }, requestCore: async () => {
            if (reply === null) throw new Error('offline');
            return reply;
        } };
        vm.createContext(context);
        vm.runInContext(fn, context);
        assert.equal(await context.summarizeExternalMessage('Alice', 'Hello'), 'Hello');
        assert.equal((await context.summarizeExternalMessage('Alice', 'x'.repeat(150))).length, 120);
    }
});
