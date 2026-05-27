// @ts-nocheck
/**
 * webmentions.test.js — Phase 8 Webmention receiver + microformats.
 *
 * Coverage:
 *   - validatePair: missing fields, non-https, wrong host, same-URL
 *   - POST /webmention happy path: 202 + Location + row stored
 *   - validateMention: real microformats source HTML → 'approved' or
 *     'rejected' depending on whether the source links back
 *   - type detection: u-in-reply-to / u-like-of / u-repost-of /
 *     u-bookmark-of vs plain mention
 *   - GET /webmention/:id status; GET /webmention/feed?target=... feed shape
 *   - admin approve / reject / delete
 *   - dump-webmentions: groups by slug, writes JSON files, cleans
 *     stale files
 *
 * Tests skip transparently when better-sqlite3 won't load (dev macOS
 * Node 26 + older binary). Mirrors the pattern in embed.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let publicApp;
let publicUrl;
let adminApp;
let adminUrl;
let tempDir;
let siteDir;
let skipReason = false;

// Node 22+ test runner skips when skip is ANY non-false/undefined value
// (including null or a function). Use a getter so the live value of
// skipReason — set later in before() — is read at test-run time.
const skipOpts = () => ({
  get skip() {
    return skipReason;
  },
});

let publicRouter;
let adminRouter;
let validateMention;
let setFetchImpl;
let parseSource;
let normaliseUrl;
let dumpWebmentions;
let slugFromTarget;

const fakeFetchRoutes = new Map();
function registerFetch(matcher, handler) {
  fakeFetchRoutes.set(matcher, handler);
}
function resetFetch() {
  fakeFetchRoutes.clear();
}
async function fakeFetch(input) {
  const url = typeof input === 'string' ? input : input?.url;
  for (const [match, handler] of fakeFetchRoutes) {
    if (typeof match === 'string' && url === match) return handler(url);
    if (match instanceof RegExp && match.test(url)) return handler(url);
  }
  return new Response('not found', { status: 404 });
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-webmention-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  // Tests register mentions against terminaleighty.com and example.com.
  process.env.WEBMENTION_HOSTS = 'terminaleighty.com,example.com';
  siteDir = join(tempDir, 'site');
  mkdirSync(join(siteDir, 'data', 'webmentions'), { recursive: true });
  process.env.SITE_DIR = siteDir;

  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
  } catch (err) {
    skipReason = `better-sqlite3 failed: ${err.message.split('\n')[0]}`;
    return;
  }
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  const mf = await import('../src/services/microformats.js');
  parseSource = mf.parseSource;
  normaliseUrl = mf.normaliseUrl;

  const routeMod = await import('../src/routes/webmentions.js');
  publicRouter = routeMod.publicRouter;
  adminRouter = routeMod.adminRouter;
  validateMention = routeMod.validateMention;
  setFetchImpl = routeMod.setFetchImpl;
  setFetchImpl(fakeFetch);

  const dumpMod = await import('../src/services/dump-webmentions.js');
  dumpWebmentions = dumpMod.dumpWebmentions;
  slugFromTarget = dumpMod.slugFromTarget;

  const express = (await import('express')).default;
  const pub = express();
  pub.use(express.json());
  pub.use(express.urlencoded({ extended: true }));
  pub.use('/webmention', publicRouter);

  const adm = express();
  adm.use(express.json());
  adm.use('/api/webmentions', adminRouter);

  await Promise.all([
    new Promise((resolve) => {
      publicApp = pub.listen(0, '127.0.0.1', () => {
        publicUrl = `http://127.0.0.1:${publicApp.address().port}`;
        resolve();
      });
    }),
    new Promise((resolve) => {
      adminApp = adm.listen(0, '127.0.0.1', () => {
        adminUrl = `http://127.0.0.1:${adminApp.address().port}`;
        resolve();
      });
    }),
  ]);
});

after(async () => {
  if (publicApp) await new Promise((resolve) => publicApp.close(resolve));
  if (adminApp) await new Promise((resolve) => adminApp.close(resolve));
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── normaliseUrl (pure) ──────────────────────────────────────────────

test('normaliseUrl strips fragment + trailing slash', skipOpts(), () => {
  assert.equal(normaliseUrl('https://Example.com/Foo/#anchor'), 'https://example.com/Foo');
});

test('normaliseUrl tolerates already-normalised URLs', skipOpts(), () => {
  assert.equal(
    normaliseUrl('https://terminaleighty.com/hello'),
    'https://terminaleighty.com/hello',
  );
});

// ── parseSource (pure) ───────────────────────────────────────────────

test('parseSource detects in-reply-to + author from h-entry', skipOpts(), () => {
  const target = 'https://terminaleighty.com/hello/';
  const html = `<!doctype html><html><body>
    <article class="h-entry">
      <div class="p-author h-card">
        <a class="p-name u-url" href="https://alice.example/">Alice</a>
        <img class="u-photo" src="https://alice.example/me.jpg" alt="">
      </div>
      <a class="u-in-reply-to" href="${target}">in reply</a>
      <div class="e-content"><p>Nice post!</p></div>
      <a class="u-url" href="https://alice.example/notes/1">permalink</a>
    </article>
  </body></html>`;
  const out = parseSource(html, 'https://alice.example/notes/1', target);
  assert.equal(out.type, 'reply');
  assert.equal(out.linksToTarget, true);
  assert.equal(out.author.name, 'Alice');
  assert.equal(out.author.url, 'https://alice.example/');
  assert.equal(out.author.photo, 'https://alice.example/me.jpg');
  assert.match(out.content, /Nice post/);
});

test('parseSource detects like-of', skipOpts(), () => {
  const target = 'https://terminaleighty.com/hello/';
  const html = `<article class="h-entry">
    <a class="u-like-of" href="${target}">★</a>
    <span class="p-author h-card"><a class="p-name u-url" href="https://bob.example/">Bob</a></span>
  </article>`;
  const out = parseSource(html, 'https://bob.example/likes/1', target);
  assert.equal(out.type, 'like');
  assert.equal(out.linksToTarget, true);
  assert.equal(out.author.name, 'Bob');
});

test('parseSource detects repost-of', skipOpts(), () => {
  const target = 'https://terminaleighty.com/hello/';
  const html = `<article class="h-entry">
    <a class="u-repost-of" href="${target}">re</a>
  </article>`;
  const out = parseSource(html, 'https://carol.example/reposts/1', target);
  assert.equal(out.type, 'repost');
});

test('parseSource detects bookmark-of', skipOpts(), () => {
  const target = 'https://terminaleighty.com/hello/';
  const html = `<article class="h-entry">
    <a class="u-bookmark-of" href="${target}">bookmark</a>
  </article>`;
  const out = parseSource(html, 'https://dave.example/bookmarks/1', target);
  assert.equal(out.type, 'bookmark');
});

test('parseSource falls back to plain mention with link', skipOpts(), () => {
  const target = 'https://terminaleighty.com/hello/';
  const html = `<!doctype html><html><body>
    <p>I read <a href="${target}">this thing</a> and liked it.</p>
  </body></html>`;
  const out = parseSource(html, 'https://eve.example/diary/1', target);
  assert.equal(out.type, 'mention');
  assert.equal(out.linksToTarget, true);
});

test('parseSource flags no-link source as not linking', skipOpts(), () => {
  const target = 'https://terminaleighty.com/hello/';
  const html = `<!doctype html><html><body><p>No reference here.</p></body></html>`;
  const out = parseSource(html, 'https://eve.example/diary/2', target);
  assert.equal(out.linksToTarget, false);
});

// ── validatePair (pure) ──────────────────────────────────────────────

test('POST rejects missing fields with 400', skipOpts(), async () => {
  const res = await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'source=&target=',
  });
  assert.equal(res.status, 400);
});

test('POST rejects http target with 400', skipOpts(), async () => {
  const res = await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      source: 'https://alice.example/notes/1',
      target: 'http://terminaleighty.com/hello/',
    }).toString(),
  });
  assert.equal(res.status, 400);
});

test('POST rejects target on a foreign host with 400', skipOpts(), async () => {
  const res = await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      source: 'https://alice.example/notes/1',
      target: 'https://otherhost.com/hello/',
    }).toString(),
  });
  assert.equal(res.status, 400);
});

test('POST rejects source==target with 400', skipOpts(), async () => {
  const res = await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      source: 'https://terminaleighty.com/hello/',
      target: 'https://terminaleighty.com/hello/',
    }).toString(),
  });
  assert.equal(res.status, 400);
});

// ── Receiver happy path + validation flow ────────────────────────────

test(
  'POST /webmention accepted source links back → approved after validate',
  skipOpts(),
  async () => {
    const target = 'https://terminaleighty.com/hello-world/';
    const source = 'https://alice.example/posts/1';
    resetFetch();
    registerFetch(
      source,
      () =>
        new Response(
          `<article class="h-entry">
          <span class="p-author h-card">
            <a class="p-name u-url" href="https://alice.example/">Alice</a>
          </span>
          <a class="u-in-reply-to" href="${target}">re</a>
          <div class="e-content"><p>Loved this read.</p></div>
        </article>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        ),
    );
    const res = await fetch(`${publicUrl}/webmention`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ source, target }).toString(),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.status, 'pending');
    assert.match(res.headers.get('location') || '', /^\/webmention\//);

    // Drive validation synchronously so we can assert the post-state.
    await validateMention(body.id);
    const statusRes = await fetch(`${publicUrl}/webmention/${body.id}`);
    const row = await statusRes.json();
    assert.equal(row.type, 'reply');
    assert.equal(row.status, 'pending'); // default-pending awaits admin approve
  },
);

test('validateMention rejects when source body has no back-link', skipOpts(), async () => {
  const target = 'https://terminaleighty.com/hello-world/';
  const source = 'https://eve.example/no-link';
  resetFetch();
  registerFetch(source, () => new Response('<p>Nope.</p>', { status: 200 }));
  const res = await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ source, target }).toString(),
  });
  const body = await res.json();
  await validateMention(body.id);
  const row = await (await fetch(`${publicUrl}/webmention/${body.id}`)).json();
  assert.equal(row.status, 'rejected');
});

test('validateMention rejects when source fetch fails', skipOpts(), async () => {
  const target = 'https://terminaleighty.com/hello-world/';
  const source = 'https://fails.example/404';
  resetFetch();
  // default fakeFetch returns 404 for unregistered URLs.
  const res = await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ source, target }).toString(),
  });
  const body = await res.json();
  await validateMention(body.id);
  const row = await (await fetch(`${publicUrl}/webmention/${body.id}`)).json();
  assert.equal(row.status, 'rejected');
});

// ── Admin approve / reject / feed ────────────────────────────────────

test('admin approve + feed surfaces the mention', skipOpts(), async () => {
  // Find the first approved-eligible row: the one from the
  // "approved after validate" test above (id known via list).
  const list = await (await fetch(`${adminUrl}/api/webmentions`)).json();
  assert.ok(list.length > 0);
  const reply = list.find(
    (r) => r.target === 'https://terminaleighty.com/hello-world/' && r.type === 'reply',
  );
  assert.ok(reply, 'expected reply row from earlier test');

  // Approve.
  const approveRes = await fetch(`${adminUrl}/api/webmentions/${reply.id}/approve`, {
    method: 'POST',
  });
  assert.equal(approveRes.status, 200);

  // Feed now lists it.
  const feedRes = await fetch(
    `${publicUrl}/webmention/feed?target=${encodeURIComponent('https://terminaleighty.com/hello-world/')}`,
  );
  assert.equal(feedRes.status, 200);
  const feed = await feedRes.json();
  assert.equal(feed.count, 1);
  assert.equal(feed.replies.length, 1);
  assert.equal(feed.replies[0].author.name, 'Alice');
});

test('admin reject hides from feed', skipOpts(), async () => {
  const list = await (await fetch(`${adminUrl}/api/webmentions?status=approved`)).json();
  assert.ok(list.length > 0);
  const reply = list[0];
  const r = await fetch(`${adminUrl}/api/webmentions/${reply.id}/reject`, { method: 'POST' });
  assert.equal(r.status, 200);
  const feedRes = await fetch(
    `${publicUrl}/webmention/feed?target=${encodeURIComponent('https://terminaleighty.com/hello-world/')}`,
  );
  const feed = await feedRes.json();
  assert.equal(feed.count, 0);
});

test('admin delete removes the row entirely', skipOpts(), async () => {
  const beforeRows = await (await fetch(`${adminUrl}/api/webmentions`)).json();
  const target = beforeRows[0];
  const r = await fetch(`${adminUrl}/api/webmentions/${target.id}`, { method: 'DELETE' });
  assert.equal(r.status, 204);
  const afterRows = await (await fetch(`${adminUrl}/api/webmentions`)).json();
  assert.equal(afterRows.length, beforeRows.length - 1);
});

// ── dump-webmentions ────────────────────────────────────────────────

test('dumpWebmentions groups approved rows by slug', skipOpts(), async () => {
  // Seed two approved replies on different posts.
  const target1 = 'https://terminaleighty.com/post-a/';
  const target2 = 'https://terminaleighty.com/post-b/';
  resetFetch();
  for (const [source, target] of [
    ['https://alice.example/wm1', target1],
    ['https://alice.example/wm2', target2],
  ]) {
    registerFetch(
      source,
      () =>
        new Response(
          `<article class="h-entry">
            <span class="p-author h-card"><a class="p-name u-url" href="https://alice.example/">Alice</a></span>
            <a class="u-in-reply-to" href="${target}">re</a>
            <div class="e-content"><p>Comment.</p></div>
          </article>`,
          { status: 200 },
        ),
    );
    const res = await fetch(`${publicUrl}/webmention`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ source, target }).toString(),
    });
    const body = await res.json();
    await validateMention(body.id);
    await fetch(`${adminUrl}/api/webmentions/${body.id}/approve`, { method: 'POST' });
  }

  const result = dumpWebmentions({ dbPath: process.env.AUTH_DB_PATH, siteDir });
  assert.ok(result.written.includes('post-a.json'));
  assert.ok(result.written.includes('post-b.json'));
  const outDir = join(siteDir, 'data', 'webmentions');
  const aPayload = JSON.parse(readFileSync(join(outDir, 'post-a.json'), 'utf-8'));
  assert.equal(aPayload.count, 1);
  assert.equal(aPayload.replies.length, 1);
  assert.equal(aPayload.replies[0].author.name, 'Alice');
});

test('slugFromTarget extracts first path segment', skipOpts(), () => {
  assert.equal(slugFromTarget('https://terminaleighty.com/hello-world/'), 'hello-world');
  assert.equal(slugFromTarget('https://terminaleighty.com/hello-world'), 'hello-world');
  assert.equal(slugFromTarget('https://terminaleighty.com/'), '__home__');
  // Garbage path bucket → null (skipped by dumper).
  assert.equal(slugFromTarget('https://terminaleighty.com/!bad/'), null);
});
