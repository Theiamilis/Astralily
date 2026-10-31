import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

test('Overview reply pages preserve full long, multiline and multilingual messages', async () => {
  const result = await build({ entryPoints: ['src/app/overviewConversation.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, context);
  const { overviewReplyPages } = context.module.exports;
  const messages = [
    '',
    'A long reply stays readable without discarding any text. '.repeat(40),
    'Line one.\nLine two.\n\n'.repeat(35),
    'リリーはここにいます。お手伝いします。 🌸 Hello, Lily! '.repeat(35),
    'W'.repeat(1000),
  ];
  for (const columns of [16, 32]) {
    for (const message of messages) {
      const pages = overviewReplyPages(message, columns);
      assert.equal(pages.join(''), message, 'Paging must never drop or duplicate message content.');
      for (const page of pages) {
        assert.ok(Array.from(page).length <= columns * 5 + 1, 'Each reply page must stay bounded.');
        assert.ok((page.match(/\n/g) || []).length <= 5, 'Explicit line breaks must also consume the page budget.');
        assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page), 'A page boundary must not split a Unicode surrogate pair.');
      }
    }
  }
});
