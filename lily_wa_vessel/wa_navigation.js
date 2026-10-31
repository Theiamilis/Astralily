'use strict';

const { setTimeout: delay } = require('node:timers/promises');

function isNavigationContextError(error) {
    const message = String(error?.message || error);
    return /Execution context was destroyed|Cannot find context with specified id|Execution context is not available in detached frame/i.test(message);
}

function buildChromiumUserAgent(chromeVersion, configuredUserAgent = '') {
    const configured = String(configuredUserAgent || '').trim();
    if (configured) return configured;

    const match = String(chromeVersion || '').match(/^(\d+)\./);
    if (!match) return '';
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${match[1]}.0.0.0 Safari/537.36`;
}

// whatsapp-web.js 1.34.7 calls inject() both during initialize() and from an
// async navigation listener. Keep one injection in flight, including retries,
// so a WA reload cannot crash that listener or attach concurrent bindings.
function createNavigationResilientClient(Client, {
    maxAttempts = 4,
    retryDelayMs = 1000,
    sleep = delay,
} = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new RangeError('maxAttempts must be a positive integer');
    }

    return class NavigationResilientClient extends Client {
        constructor(...args) {
            super(...args);
            this.navigationInjection = null;
            this.navigationInitialized = false;
            this.navigationStopping = false;
            this.navigationAbort = new AbortController();
        }

        async initialize() {
            await super.initialize();
            this.navigationInitialized = true;
        }

        inject() {
            if (this.navigationStopping) return Promise.resolve();
            if (this.navigationInjection) return this.navigationInjection;

            const run = async () => {
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    if (this.navigationStopping) return;
                    try {
                        return await super.inject();
                    } catch (error) {
                        if (this.navigationStopping) return;
                        if (!isNavigationContextError(error)
                            || attempt === maxAttempts
                            || this.pupPage?.isClosed()
                            || !this.pupBrowser?.isConnected()) {
                            throw error;
                        }
                        this.emit('lily_navigation_retry', { attempt, maxAttempts });
                        // Reuse the same page/profile. Never initialize another
                        // browser, log out, or delete auth data for a reload.
                        await sleep(retryDelayMs * attempt, undefined, {
                            signal: this.navigationAbort.signal,
                        });
                    }
                }
            };

            const operation = run().catch((error) => {
                if (this.navigationStopping) return;
                // initialize() has its own catch. Later injections are awaited
                // by an upstream event callback with no rejection handler.
                if (!this.navigationInitialized) throw error;
                this.emit('lily_navigation_failed', error);
            }).finally(() => {
                if (this.navigationInjection === operation) {
                    this.navigationInjection = null;
                }
            });
            this.navigationInjection = operation;
            return operation;
        }

        async destroy() {
            this.navigationStopping = true;
            this.navigationAbort.abort();
            return super.destroy();
        }
    };
}

module.exports = {
    buildChromiumUserAgent,
    createNavigationResilientClient,
    isNavigationContextError,
};
