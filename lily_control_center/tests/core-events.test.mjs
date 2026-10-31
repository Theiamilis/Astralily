import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

test('Core events share a connection, deduplicate replay and release on last unsubscribe', async () => {
  const result = await build({
    entryPoints: ['src/app/coreApi.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'fixture-launcher', setup(builder) {
      builder.onResolve({ filter: /browserSession$/ }, () => ({ path: 'fixture-launcher', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const launcherFetch = (...args) => globalThis.fixtureFetch(...args);' }));
    } }],
  });
  const storage = new Map();
  const streams = [];
  const context = { exports: {}, module: { exports: {} }, Headers, AbortController, TextDecoder, console,
    window: { setTimeout, clearTimeout, sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) } },
    fixtureFetch: async (_service, url, init) => {
      const entry = { url, init, controller: null };
      const body = new ReadableStream({ start(controller) {
        entry.controller = controller;
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      } });
      streams.push(entry);
      return new Response(body);
    },
  };
  vm.runInNewContext(result.outputFiles[0].text, context);
  const { subscribeCoreEvents } = context.module.exports;
  const a = [], b = [];
  const offA = subscribeCoreEvents('http://core-a/', (event) => a.push(event.id));
  const offB = subscribeCoreEvents('http://core-a', (event) => b.push(event.id));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(streams.length, 1);
  const encoder = new TextEncoder();
  streams[0].controller.enqueue(encoder.encode('id: 7\nevent: home.state\ndata: {}\n\nid: 7\nevent: home.state\ndata: {}\n\nid: 8\r'));
  streams[0].controller.enqueue(encoder.encode('\nevent: home.state\r\ndata: {}\r\n\r\n'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(a, [7, 8]);
  assert.deepEqual(b, [7, 8]);
  offA();
  assert.equal(streams[0].init.signal.aborted, false);
  offB();
  assert.equal(streams[0].init.signal.aborted, true);
  const offC = subscribeCoreEvents('http://core-a', () => {});
  const offD = subscribeCoreEvents('http://core-b', () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(streams[1].init.headers.get('Last-Event-ID'), '8');
  assert.equal(streams[2].init.headers.get('Last-Event-ID'), null);
  offC(); offD();
});
