// @ts-nocheck
/**
 * mastodon.test.js — direct Mastodon cross-post service.
 *
 * Coverage:
 *   - composeStatus fits title+excerpt+url, truncates a long excerpt
 *   - isConfigured reflects env config
 *   - postStatus sends the right payload + returns the permalink (mocked fetch)
 *   - postStatus throws on a non-2xx
 *   - verifyCredentials returns the resolved handle (mocked fetch)
 *
 * Skips transparently if better-sqlite3 won't load (app-secrets needs it),
 * mirroring bluesky.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mastodon;
let tempDir;
let skip = false;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'masto-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test-secret-masto';
  process.env.MASTODON_INSTANCE = 'https://mastodon.example';
  process.env.MASTODON_ACCESS_TOKEN = 'tok_test';
  try {
    mastodon = await import('../src/services/mastodon.js');
  } catch {
    skip = true; // better-sqlite3 unavailable in this env — skip transparently
  }
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MASTODON_INSTANCE;
  delete process.env.MASTODON_ACCESS_TOKEN;
});

test('composeStatus fits short title + excerpt + url', () => {
  if (skip) return;
  const s = mastodon.composeStatus({
    title: 'Hello',
    excerpt: 'A short post.',
    url: 'https://x.test/p/',
  });
  assert.equal(s, 'Hello\n\nA short post.\n\nhttps://x.test/p/');
});

test('composeStatus truncates a long excerpt and still appends the url', () => {
  if (skip) return;
  const url = 'https://x.test/p/';
  const s = mastodon.composeStatus({ title: 'T', excerpt: 'word '.repeat(300), url });
  assert.ok(s.length <= 500, `len ${s.length} should be <= 500`);
  assert.ok(s.endsWith(url), 'ends with the url');
  assert.ok(s.includes('…'), 'has an ellipsis');
});

test('isConfigured true when env instance + token set', () => {
  if (skip) return;
  assert.equal(mastodon.isConfigured(), true);
});

test('postStatus sends the right payload + returns the permalink', async () => {
  if (skip) return;
  let captured = null;
  mastodon.setFetchImpl(async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: '42', url: 'https://mastodon.example/@me/42' }),
    };
  });
  const r = await mastodon.postStatus({
    title: 'Hi',
    excerpt: 'Body',
    url: 'https://x.test/p/',
    idempotencyKey: 'k1',
  });
  mastodon.setFetchImpl(null);
  assert.equal(r.id, '42');
  assert.equal(r.url, 'https://mastodon.example/@me/42');
  assert.equal(captured.url, 'https://mastodon.example/api/v1/statuses');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer tok_test');
  assert.equal(captured.init.headers['Idempotency-Key'], 'k1');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.visibility, 'public');
  assert.ok(body.status.includes('Hi'));
});

test('postStatus throws on a non-2xx', async () => {
  if (skip) return;
  mastodon.setFetchImpl(async () => ({ ok: false, status: 422, text: async () => 'bad' }));
  await assert.rejects(
    () => mastodon.postStatus({ title: 'x', url: 'https://x.test/' }),
    /post_failed 422/,
  );
  mastodon.setFetchImpl(null);
});

test('verifyCredentials returns the resolved handle', async () => {
  if (skip) return;
  mastodon.setFetchImpl(async (url, init) => {
    assert.ok(String(url).endsWith('/api/v1/accounts/verify_credentials'));
    assert.equal(init.headers.Authorization, 'Bearer tok_test');
    return {
      ok: true,
      status: 200,
      json: async () => ({ acct: 'me', url: 'https://mastodon.example/@me', display_name: 'Me' }),
    };
  });
  const acct = await mastodon.verifyCredentials();
  mastodon.setFetchImpl(null);
  assert.equal(acct.acct, 'me');
  assert.equal(acct.url, 'https://mastodon.example/@me');
});
