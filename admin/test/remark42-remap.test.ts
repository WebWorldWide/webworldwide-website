// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('remapUrls posts "from to" lines as text/plain to the admin remap API', async () => {
  process.env.REMARK42_URL = 'http://remark42.test';
  process.env.REMARK42_SITE_ID = 'site1';
  process.env.REMARK42_ADMIN_PASSWD = 'pw';
  const r42 = await import('../src/services/remark42.js');
  let seen;
  r42.setFetchImpl(async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ status: 'convert request accepted' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  await r42.remapUrls([
    ['https://x.test/blog/old/', 'https://x.test/blog/new/'],
    ['https://x.test/blog/same/', 'https://x.test/blog/same/'], // no-op pair dropped
  ]);
  assert.match(seen.url, /\/api\/v1\/admin\/remap\?site=site1$/);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Type'], 'text/plain');
  assert.equal(seen.init.body, 'https://x.test/blog/old/ https://x.test/blog/new/');
  assert.match(seen.init.headers.Authorization, /^Basic /);
  assert.equal(await r42.remapUrls([['a', 'a']]), null, 'nothing to remap → no request');
  r42.setFetchImpl(null);
});
