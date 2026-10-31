'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const {
    buildChromiumUserAgent,
    createNavigationResilientClient,
    isNavigationContextError,
} = require('./wa_navigation');

const navigationError = () => new Error('Execution context was destroyed, most likely because of a navigation.');

function fixture(outcomes, overrides = {}) {
    const calls = { inject: 0, initialize: 0, destroy: 0, delays: [] };
    class FakeClient extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.pupPage = { isClosed: () => false };
            this.pupBrowser = { isConnected: () => true };
        }
        async initialize() { calls.initialize++; await this.inject(); }
        async inject() {
            const next = outcomes[calls.inject++];
            if (next instanceof Error) throw next;
            return typeof next === 'function' ? next() : next;
        }
        async destroy() { calls.destroy++; }
    }
    const ResilientClient = createNavigationResilientClient(FakeClient, {
        sleep: async (ms) => { calls.delays.push(ms); },
        ...overrides,
    });
    const client = new ResilientClient({ authStrategy: { existingSession: true } });
    return { client, calls };
}

test('retries a startup navigation on the same client and profile', async () => {
    const { client, calls } = fixture([navigationError(), navigationError(), 'injected']);
    const page = client.pupPage;
    const retries = [];
    client.on('lily_navigation_retry', value => retries.push(value.attempt));
    await client.initialize();
    assert.equal(calls.initialize, 1);
    assert.equal(calls.inject, 3);
    assert.equal(calls.destroy, 0);
    assert.equal(client.pupPage, page);
    assert.deepEqual(client.options.authStrategy, { existingSession: true });
    assert.deepEqual(retries, [1, 2]);
    assert.deepEqual(calls.delays, [1000, 2000]);
});

test('coalesces overlapping navigation callbacks, including during a retry', async () => {
    let resume;
    const { client, calls } = fixture([navigationError(), 'injected'], {
        sleep: () => new Promise(resolve => { resume = resolve; }),
    });
    const first = client.inject();
    const second = client.inject();
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.inject(), first);
    resume();
    assert.deepEqual(await Promise.all([first, second]), ['injected', 'injected']);
    assert.equal(calls.inject, 2);
    assert.equal(client.navigationInjection, null);
});

test('bounds startup retries and preserves the original failure', async () => {
    const error = navigationError();
    const { client, calls } = fixture([error, error, error, error]);
    await assert.rejects(client.initialize(), value => value === error);
    assert.equal(calls.inject, 4);
    assert.equal(calls.initialize, 1);
    assert.equal(calls.destroy, 0);
});

test('does not disguise authentication or unrelated startup errors as navigation', async () => {
    const error = new Error('Authentication failed');
    const { client, calls } = fixture([error]);
    await assert.rejects(client.initialize(), value => value === error);
    assert.equal(calls.inject, 1);
    assert.deepEqual(calls.delays, []);
});

test('a later navigation recovers without reinitializing the browser', async () => {
    const { client, calls } = fixture(['initial', navigationError(), 'recovered']);
    await client.initialize();
    assert.equal(await client.inject(), 'recovered');
    assert.equal(calls.initialize, 1);
    assert.equal(calls.inject, 3);
});

test('a later exhausted recovery is reported instead of rejecting the event callback', async () => {
    const error = navigationError();
    const { client, calls } = fixture(['initial', error, error, error, error]);
    const failures = [];
    client.on('lily_navigation_failed', value => failures.push(value));
    await client.initialize();
    await assert.doesNotReject(client.inject());
    assert.deepEqual(failures, [error]);
    assert.equal(calls.inject, 5);
});

test('closed page or disconnected browser does not enter the retry loop', async () => {
    for (const closedPage of [true, false]) {
        const error = navigationError();
        const { client, calls } = fixture([error]);
        if (closedPage) client.pupPage.isClosed = () => true;
        else client.pupBrowser.isConnected = () => false;
        await assert.rejects(client.initialize(), value => value === error);
        assert.equal(calls.inject, 1);
        assert.deepEqual(calls.delays, []);
    }
});

test('shutdown aborts pending retries without starting another browser or injection', async () => {
    let sleeping;
    const started = new Promise(resolve => { sleeping = resolve; });
    const { client, calls } = fixture([navigationError()], {
        sleep: (_ms, _value, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
            sleeping();
        }),
    });
    const pending = client.inject();
    await started;
    await client.destroy();
    await pending;
    await client.inject();
    assert.equal(calls.inject, 1);
    assert.equal(calls.destroy, 1);
    assert.equal(calls.initialize, 0);
});

test('recognizes only transient execution-context errors', () => {
    assert.equal(isNavigationContextError(navigationError()), true);
    assert.equal(isNavigationContextError(new Error('Cannot find context with specified id')), true);
    for (const message of ['Target closed', 'auth timeout', 'Protocol error', 'Session revoked']) {
        assert.equal(isNavigationContextError(new Error(message)), false);
    }
});

test('builds a current non-headless user-agent from Puppeteer Chrome', () => {
    assert.equal(
        buildChromiumUserAgent('146.0.7680.31'),
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    );
    assert.equal(buildChromiumUserAgent('invalid'), '');
    assert.equal(buildChromiumUserAgent('146.0.0.0', 'Custom UA'), 'Custom UA');
});
