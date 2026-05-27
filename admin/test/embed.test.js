// @ts-nocheck
/**
 * embed.test.js — Phase 7 paste-to-embed.
 *
 * Coverage:
 *   - provider matching (youtube + vimeo + bluesky + mastodon + gist + spotify + generic)
 *   - oEmbed path: fake `fetch` returns JSON, route shapes a record
 *   - generic OG scrape: HTML body → og:* extraction
 *   - cache hit/miss: second identical URL is served from SQLite,
 *     `X-Embed-Cache` header flips MISS → HIT
 *   - 4xx envelope: malformed URL, http (not https), private host
 *   - upstream 404: returned as 404, not 502
 *
 * The route opens better-sqlite3 lazily; we point AUTH_DB_PATH at a
 * tempdir before the route module loads so its module-level db handle
 * never sees the real auth.db.
 *
 * Tests skip transparently when better-sqlite3 won't load (dev macOS
 * Node 26 + older binary). Mirrors the pattern in activity.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let tempDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

let providers;
let oembed;
let ogScraper;
let route;

// A pluggable fake fetch installed via the oEmbed/og-scraper test
// seam. Tests register a per-URL handler; default = 404.
const fakeFetchRoutes = new Map();
function registerFetch(matcher, handler) {
  fakeFetchRoutes.set(matcher, handler);
}
function resetFetch() {
  fakeFetchRoutes.clear();
}
async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url;
  // Defer to the real fetch for our own test server (127.0.0.1) — the
  // test's request-under-test goes through the real network stack; only
  // the upstream provider/oEmbed calls should be intercepted.
  if (url && (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost'))) {
    return globalThis.__realFetch(url, init);
  }
  for (const [match, handler] of fakeFetchRoutes) {
    if (typeof match === 'string' && url === match) return handler(url);
    if (match instanceof RegExp && match.test(url)) return handler(url);
  }
  return new Response('not found', { status: 404 });
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-embed-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  mkdirSync(join(tempDir, 'site', 'content', 'posts'), { recursive: true });
  process.env.SITE_DIR = join(tempDir, 'site');

  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  providers = await import('../src/services/embed/providers.js');
  oembed = await import('../src/services/embed/oembed.js');
  ogScraper = await import('../src/services/embed/og-scraper.js');
  // Swap the underlying fetch for both modules.
  oembed.setFetchImpl(fakeFetch);

  // Patch the global so the og-scraper (which reads globalThis.fetch
  // at call time) goes through our fake too.
  globalThis.__realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  const routeMod = await import('../src/routes/embed.js');
  route = routeMod.default;

  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/embed', route);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (globalThis.__realFetch) {
    globalThis.fetch = globalThis.__realFetch;
    delete globalThis.__realFetch;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Provider matching (pure functions, no DB) ────────────────────

test('pickProvider matches YouTube watch URLs', skipOpts(), () => {
  const picked = providers.pickProvider(new URL('https://www.youtube.com/watch?v=abc12345_xy'));
  assert.equal(picked.provider.name, 'youtube');
  assert.equal(picked.match.id, 'abc12345_xy');
});

test('pickProvider matches youtu.be short URLs', skipOpts(), () => {
  const picked = providers.pickProvider(new URL('https://youtu.be/dQw4w9WgXcQ'));
  assert.equal(picked.provider.name, 'youtube');
  assert.equal(picked.match.id, 'dQw4w9WgXcQ');
});

test('pickProvider matches Vimeo numeric IDs', skipOpts(), () => {
  const picked = providers.pickProvider(new URL('https://vimeo.com/123456789'));
  assert.equal(picked.provider.name, 'vimeo');
  assert.equal(picked.match.id, '123456789');
});

test('pickProvider matches Bluesky profile/post', skipOpts(), () => {
  const picked = providers.pickProvider(
    new URL('https://bsky.app/profile/alice.bsky.social/post/3xyz'),
  );
  assert.equal(picked.provider.name, 'bluesky');
  assert.equal(picked.match.handle, 'alice.bsky.social');
});

test('pickProvider matches Mastodon per-instance URL', skipOpts(), () => {
  const picked = providers.pickProvider(
    new URL('https://mastodon.social/@gargron/123456789012345678'),
  );
  assert.equal(picked.provider.name, 'mastodon');
  assert.equal(picked.match.host, 'mastodon.social');
  assert.equal(picked.match.user, 'gargron');
  assert.equal(picked.match.statusId, '123456789012345678');
});

test('pickProvider matches GitHub Gist', skipOpts(), () => {
  const picked = providers.pickProvider(
    new URL('https://gist.github.com/octocat/aabbccddeeff112233'),
  );
  assert.equal(picked.provider.name, 'gist');
  assert.equal(picked.match.owner, 'octocat');
});

test('pickProvider matches Spotify track', skipOpts(), () => {
  const picked = providers.pickProvider(
    new URL('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh'),
  );
  assert.equal(picked.provider.name, 'spotify');
  assert.equal(picked.match.kind, 'track');
});

test('pickProvider falls back to generic for unknown hosts', skipOpts(), () => {
  const picked = providers.pickProvider(new URL('https://example.com/some/article'));
  assert.equal(picked.provider.name, 'generic');
});

// ── OG scraper unit test (pure parser) ────────────────────────────

test('parseOgFromHtml extracts og:* and twitter:* fields', skipOpts(), () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="The Title">
    <meta property="og:description" content="A description &amp; more">
    <meta property="og:image" content="https://cdn.example.com/cover.jpg">
    <meta name="twitter:title" content="ignored">
    <meta property="og:site_name" content="Example">
  </head><body><p>Hi</p></body></html>`;
  const og = ogScraper.parseOgFromHtml(html, new URL('https://example.com/a'));
  assert.equal(og.title, 'The Title');
  assert.equal(og.description, 'A description & more');
  assert.equal(og.image, 'https://cdn.example.com/cover.jpg');
  assert.equal(og.siteName, 'Example');
});

test('parseOgFromHtml resolves relative og:image against base', skipOpts(), () => {
  const html = `<head>
    <meta property="og:title" content="X">
    <meta property="og:image" content="/img/cover.png">
  </head>`;
  const og = ogScraper.parseOgFromHtml(html, new URL('https://example.com/post/1'));
  assert.equal(og.image, 'https://example.com/img/cover.png');
});

test('parseOgFromHtml falls back to <title> when no og:title', skipOpts(), () => {
  const html = `<head><title> Just a Title </title></head>`;
  const og = ogScraper.parseOgFromHtml(html, new URL('https://example.com/'));
  assert.equal(og.title, 'Just a Title');
});

// ── Route integration: oEmbed path ────────────────────────────────

test('GET /api/embed?url=youtube returns shortcode + MISS', skipOpts(), async () => {
  resetFetch();
  registerFetch(/youtube\.com\/oembed/, () =>
    Response.json({
      type: 'video',
      title: 'Never Gonna Give You Up',
      author_name: 'Rick Astley',
      thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      width: 480,
      height: 270,
      html: '<iframe …></iframe>',
    }),
  );
  const res = await fetch(
    `${baseUrl}/api/embed?url=${encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-embed-cache'), 'MISS');
  const body = await res.json();
  assert.equal(body.provider, 'youtube');
  assert.equal(body.id, 'dQw4w9WgXcQ');
  assert.equal(body.type, 'video');
  assert.match(body.shortcode, /^\{\{< embed-youtube id="dQw4w9WgXcQ"/);
  assert.match(body.shortcode, /title="Never Gonna Give You Up"/);
  assert.equal(body.title, 'Never Gonna Give You Up');
});

test('GET /api/embed second identical URL is HIT', skipOpts(), async () => {
  resetFetch();
  // Intentionally do NOT register a fetch — if the cache is bypassed
  // the underlying fetch returns 404 and the test fails.
  const res = await fetch(
    `${baseUrl}/api/embed?url=${encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-embed-cache'), 'HIT');
  const body = await res.json();
  assert.equal(body.provider, 'youtube');
  assert.equal(body.title, 'Never Gonna Give You Up');
});

test('GET /api/embed Bluesky returns bluesky shortcode', skipOpts(), async () => {
  resetFetch();
  registerFetch(/embed\.bsky\.app\/oembed/, () =>
    Response.json({
      type: 'rich',
      title: 'Hello, Bluesky',
      author_name: 'alice.bsky.social',
      html: '<blockquote>…</blockquote>',
    }),
  );
  const url = 'https://bsky.app/profile/alice.bsky.social/post/3kfoo';
  const res = await fetch(`${baseUrl}/api/embed?url=${encodeURIComponent(url)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'bluesky');
  assert.match(body.shortcode, /^\{\{< embed-bluesky /);
  assert.match(body.shortcode, /handle="alice\.bsky\.social"/);
});

test('GET /api/embed Mastodon hits per-instance oEmbed', skipOpts(), async () => {
  resetFetch();
  let calledUrl = null;
  registerFetch(/mastodon\.social\/api\/oembed/, (u) => {
    calledUrl = u;
    return Response.json({
      type: 'rich',
      title: 'A toot',
      author_name: 'gargron',
      html: '<iframe …></iframe>',
    });
  });
  const url = 'https://mastodon.social/@gargron/110000000000000001';
  const res = await fetch(`${baseUrl}/api/embed?url=${encodeURIComponent(url)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'mastodon');
  assert.match(body.shortcode, /host="mastodon\.social"/);
  assert.match(body.shortcode, /user="gargron"/);
  assert.ok(
    calledUrl && calledUrl.startsWith('https://mastodon.social/api/oembed?'),
    `expected mastodon.social oEmbed call, got ${calledUrl}`,
  );
});

test('GET /api/embed generic falls back to OG scrape', skipOpts(), async () => {
  resetFetch();
  registerFetch(
    'https://example.org/article',
    () =>
      new Response(
        `<!doctype html><head>
        <meta property="og:title" content="An Article">
        <meta property="og:description" content="About things.">
        <meta property="og:image" content="https://cdn.example.org/cover.jpg">
      </head><body></body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      ),
  );
  const res = await fetch(
    `${baseUrl}/api/embed?url=${encodeURIComponent('https://example.org/article')}`,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'generic');
  assert.equal(body.type, 'link');
  assert.equal(body.title, 'An Article');
  assert.equal(body.thumbnail, 'https://cdn.example.org/cover.jpg');
  assert.match(body.shortcode, /^\{\{< embed-generic /);
  assert.match(body.shortcode, /title="An Article"/);
});

// ── 4xx envelope ─────────────────────────────────────────────────

test('GET /api/embed missing url → 400', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/embed`);
  assert.equal(res.status, 400);
});

test('GET /api/embed http (not https) → 415', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/embed?url=${encodeURIComponent('http://example.com/')}`);
  assert.equal(res.status, 415);
});

test('GET /api/embed private host → 415', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/embed?url=${encodeURIComponent('https://localhost/')}`);
  assert.equal(res.status, 415);
});

test('GET /api/embed malformed URL → 400', skipOpts(), async () => {
  const res = await fetch(`${baseUrl}/api/embed?url=notaurl`);
  assert.equal(res.status, 400);
});

test('GET /api/embed upstream 404 → 404', skipOpts(), async () => {
  resetFetch();
  registerFetch(/vimeo\.com\/api\/oembed/, () => new Response('gone', { status: 404 }));
  const res = await fetch(
    `${baseUrl}/api/embed?url=${encodeURIComponent('https://vimeo.com/999999999')}`,
  );
  assert.equal(res.status, 404);
});
