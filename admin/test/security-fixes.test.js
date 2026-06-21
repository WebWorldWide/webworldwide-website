// @ts-nocheck
/**
 * security-fixes.test.js — regression tests for the security-sweep fixes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeniedExtension } from '../src/utils/mediaTypes.js';
import { sanitizeEmbedHtml } from '../src/utils/sanitizeHtml.js';

test('isDeniedExtension blocks trailing-whitespace / trailing-dot / case bypasses', () => {
  assert.equal(isDeniedExtension('evil.html'), true);
  assert.equal(isDeniedExtension('evil.html '), true); // trailing space
  assert.equal(isDeniedExtension('evil.html\t'), true); // tab
  assert.equal(isDeniedExtension('evil.html\n'), true); // newline
  assert.equal(isDeniedExtension('evil.html.'), true); // trailing dot
  assert.equal(isDeniedExtension('evil.html. '), true); // dot + space
  assert.equal(isDeniedExtension('EVIL.SVG '), true); // case + space
  assert.equal(isDeniedExtension('payload.js '), true);
  // legit media must still pass
  assert.equal(isDeniedExtension('photo.png'), false);
  assert.equal(isDeniedExtension('clip.mp4'), false);
  assert.equal(isDeniedExtension('archive.tar.gz'), false);
});

test('sanitizeEmbedHtml strips script vectors but keeps the iframe/blockquote embed', () => {
  const out = sanitizeEmbedHtml(
    '<iframe src="https://mastodon.social/@a/1/embed" width="400"></iframe><script>alert(1)</script>',
  );
  assert.ok(out.includes('<iframe'), 'keeps the iframe embed');
  assert.ok(out.includes('mastodon.social'), 'keeps the https src');
  assert.ok(!/script/i.test(out), 'drops <script>');

  const out2 = sanitizeEmbedHtml(
    '<img src="x" onerror="alert(1)"><iframe src="javascript:alert(1)"></iframe><iframe src="data:text/html,<script>1</script>"></iframe>',
  );
  assert.ok(!/onerror/i.test(out2), 'drops on* handlers');
  assert.ok(!/javascript:/i.test(out2), 'drops javascript: URL');
  assert.ok(!/data:/i.test(out2), 'drops data: URL');
});
