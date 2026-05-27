// @ts-nocheck
/**
 * comments.test.js — Phase 8.5 unified comment moderation API.
 *
 * Coverage:
 *   - JWT minting + verification (round-trip via the shared SECRET)
 *   - Remark42 client: normaliseComment shape, lastComments fetch shape,
 *     blockUser + listBlockedUsers (with stubbed fetch)
 *   - SSE: register → broadcast → subscriber receives the frame
 *   - /api/comments listing merges Remark42 rows + webmention rows
 *   - /api/comments?status=pending returns only webmention pending rows
 *   - POST /api/comments/:id/reply forwards to Remark42 (mocked)
 *   - POST /api/comments/:id/spam — deletes + blocks + mirrors locally
 *   - GET /api/comments/blocks lists local blocks
 *   - SSE: webmention POST → broadcast on the 'webmentions' channel
 *
 * Tests skip transparently when better-sqlite3 won't load (dev macOS
 * Node 26 + older binary). Mirrors the pattern in webmentions.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let adminApp;
let adminUrl;
let publicApp;
let publicUrl;
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

let remark42;
let commentsRoute;
let sseService;
let webmentionsRouter;
let setWmFetch;

const fakeFetchRoutes = new Map();
const fakeFetchCalls = [];
function registerFetch(matcher, handler) {
  fakeFetchRoutes.set(matcher, handler);
}
function resetFetch() {
  fakeFetchRoutes.clear();
  fakeFetchCalls.length = 0;
}
async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url;
  fakeFetchCalls.push({ url, init });
  for (const [match, handler] of fakeFetchRoutes) {
    if (typeof match === 'string' && url === match) return handler(url, init);
    if (match instanceof RegExp && match.test(url)) return handler(url, init);
  }
  return new Response('not found', { status: 404 });
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 't80-comments-test-'));
  process.env.AUTH_DB_PATH = join(tempDir, 'auth.db');
  process.env.SESSION_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  process.env.REMARK42_URL = 'http://remark42.test';
  process.env.REMARK42_SITE_ID = 'terminaleighty';
  process.env.REMARK42_SECRET = 'test-secret-please-rotate';
  process.env.REMARK42_ADMIN_USER = 'admin';
  process.env.REMARK42_ADMIN_ID = 'admin';
  process.env.WEBMENTION_HOSTS = 'terminaleighty.com';
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

  remark42 = await import('../src/services/remark42.js');
  remark42.setFetchImpl(fakeFetch);
  sseService = await import('../src/services/sse.js');

  // Mount the comments router on a tiny Express app.
  commentsRoute = (await import('../src/routes/comments.js')).default;

  const wmMod = await import('../src/routes/webmentions.js');
  webmentionsRouter = wmMod.publicRouter;
  setWmFetch = wmMod.setFetchImpl;
  // Webmention validator: never fetch real sources.
  setWmFetch(fakeFetch);

  const express = (await import('express')).default;
  const adm = express();
  adm.use(express.json());
  adm.use(express.urlencoded({ extended: true }));
  adm.use('/api/comments', commentsRoute);

  const pub = express();
  pub.use(express.json());
  pub.use(express.urlencoded({ extended: true }));
  pub.use('/webmention', webmentionsRouter);

  await Promise.all([
    new Promise((resolve) => {
      adminApp = adm.listen(0, '127.0.0.1', () => {
        adminUrl = `http://127.0.0.1:${adminApp.address().port}`;
        resolve();
      });
    }),
    new Promise((resolve) => {
      publicApp = pub.listen(0, '127.0.0.1', () => {
        publicUrl = `http://127.0.0.1:${publicApp.address().port}`;
        resolve();
      });
    }),
  ]);
});

after(async () => {
  if (adminApp) await new Promise((resolve) => adminApp.close(resolve));
  if (publicApp) await new Promise((resolve) => publicApp.close(resolve));
  try {
    sseService?.closeAll();
  } catch (_) {
    /* ignore */
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
});

// ── Remark42 client — JWT + shape ──────────────────────────────────

test('adminJwt + verifyJwt round-trip with admin claim', skipOpts(), () => {
  const tok = remark42.adminJwt();
  const decoded = remark42.verifyJwt(tok);
  assert.ok(decoded);
  assert.equal(decoded.user.admin, true);
  assert.equal(decoded.user.site_id, 'terminaleighty');
  assert.equal(decoded.aud, 'terminaleighty');
});

test('verifyJwt rejects a tampered token', skipOpts(), () => {
  const tok = remark42.adminJwt();
  const parts = tok.split('.');
  parts[1] = Buffer.from(JSON.stringify({ user: { admin: false } }))
    .toString('base64')
    .replace(/=+$/, '');
  assert.equal(remark42.verifyJwt(parts.join('.')), null);
});

test('normaliseComment maps a Remark42 record to the unified shape', skipOpts(), () => {
  const out = remark42.normaliseComment({
    id: 'r1',
    pid: '',
    text: '<p>Hi</p>',
    orig: 'Hi',
    time: '2026-05-17T09:00:00Z',
    user: { id: 'alice', name: 'Alice', picture: 'https://a.example/me.png', admin: false },
    locator: { url: 'https://terminaleighty.com/post-a/', site: 'terminaleighty' },
    score: 3,
  });
  assert.equal(out.id, 'r1');
  assert.equal(out.source, 'remark42');
  assert.equal(out.author.name, 'Alice');
  assert.equal(out.postUrl, 'https://terminaleighty.com/post-a/');
  assert.equal(out.status, 'visible');
  assert.equal(out.score, 3);
});

test('lastComments hits /api/v1/last/N and parses array body', skipOpts(), async () => {
  resetFetch();
  registerFetch(
    /\/api\/v1\/last\/\d+/,
    () =>
      new Response(
        JSON.stringify([
          {
            id: 'c1',
            text: '<p>Nice</p>',
            time: '2026-05-17T10:00:00Z',
            user: { id: 'bob', name: 'Bob' },
            locator: { url: 'https://terminaleighty.com/post-a/', site: 'terminaleighty' },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const rows = await remark42.lastComments({ max: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'c1');
  assert.equal(rows[0].author.name, 'Bob');
});

test('blockUser issues PUT /api/v1/admin/user/:id?block=1&secret=…', skipOpts(), async () => {
  resetFetch();
  let calledUrl = null;
  registerFetch(/\/api\/v1\/admin\/user\//, (url) => {
    calledUrl = url;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await remark42.blockUser('alice', { block: true, ttl: '24h' });
  assert.ok(calledUrl);
  const u = new URL(calledUrl);
  assert.equal(u.pathname, '/api/v1/admin/user/alice');
  assert.equal(u.searchParams.get('block'), '1');
  assert.equal(u.searchParams.get('ttl'), '24h');
  assert.equal(u.searchParams.get('secret'), 'test-secret-please-rotate');
});

test('listBlockedUsers parses the admin/blocked response', skipOpts(), async () => {
  resetFetch();
  registerFetch(
    /\/api\/v1\/admin\/blocked/,
    () =>
      new Response(
        JSON.stringify([
          { id: 'eve', name: 'Eve', time: '2027-01-01T00:00:00Z' },
          { id: 'mallory', name: 'Mallory' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const list = await remark42.listBlockedUsers();
  assert.equal(list.length, 2);
  assert.equal(list[0].userId, 'eve');
});

// ── SSE channel ───────────────────────────────────────────────────

test('SSE register + broadcast roundtrip', skipOpts(), async () => {
  const captured = [];
  const fakeRes = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    flushHeaders() {},
    write(chunk) {
      captured.push(String(chunk));
    },
    on() {},
    end() {},
  };
  const id = sseService.register({}, fakeRes, ['comments']);
  assert.equal(typeof id, 'number');
  sseService.broadcast('comments', 'comment-new', { id: 'x', author: 'Bob' });
  // First frame is `retry: 5000`, then the event.
  const joined = captured.join('\n');
  assert.match(joined, /retry:\s*5000/);
  assert.match(joined, /event:\s*comment-new/);
  assert.match(joined, /"author":"Bob"/);
  sseService.unregister(id);
});

test('SSE broadcast on a foreign channel is NOT delivered', skipOpts(), () => {
  const captured = [];
  const fakeRes = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    flushHeaders() {},
    write(chunk) {
      captured.push(String(chunk));
    },
    on() {},
    end() {},
  };
  const id = sseService.register({}, fakeRes, ['comments']);
  sseService.broadcast('other-channel', 'noisy', { x: 1 });
  const joined = captured.join('\n');
  assert.doesNotMatch(joined, /noisy/);
  sseService.unregister(id);
});

// ── /api/comments listing ─────────────────────────────────────────

test('GET /api/comments status=pending returns only webmention rows', skipOpts(), async () => {
  resetFetch();
  // Seed a pending webmention by POSTing to the receiver (it inserts
  // status='pending' immediately; the background validator is async
  // and won't matter for this test).
  registerFetch(
    'https://alice.example/post-1',
    () =>
      new Response(
        `<article class="h-entry">
          <a class="u-in-reply-to" href="https://terminaleighty.com/hello-world/">re</a>
          <div class="e-content">Nice</div>
        </article>`,
        { status: 200 },
      ),
  );
  const wmRes = await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      source: 'https://alice.example/post-1',
      target: 'https://terminaleighty.com/hello-world/',
    }).toString(),
  });
  assert.equal(wmRes.status, 202);

  // Remark42's last endpoint returns nothing for this test.
  registerFetch(
    /\/api\/v1\/last\/\d+/,
    () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  const list = await (await fetch(`${adminUrl}/api/comments?status=pending`)).json();
  assert.ok(Array.isArray(list.items));
  assert.ok(list.items.length >= 1);
  assert.ok(list.items.every((c) => c.source === 'webmention'));
  assert.ok(list.items.every((c) => c.status === 'pending'));
});

test('GET /api/comments status=all merges Remark42 + webmentions', skipOpts(), async () => {
  resetFetch();
  registerFetch(
    /\/api\/v1\/last\/\d+/,
    () =>
      new Response(
        JSON.stringify([
          {
            id: 'rk-1',
            text: '<p>Greetings</p>',
            time: new Date().toISOString(),
            user: { id: 'bob', name: 'Bob' },
            locator: { url: 'https://terminaleighty.com/hello-world/', site: 'terminaleighty' },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  // Re-seed a webmention so we know there's at least one in addition.
  registerFetch(
    'https://carol.example/note-1',
    () =>
      new Response(
        `<article class="h-entry">
          <a class="u-in-reply-to" href="https://terminaleighty.com/another/">re</a>
        </article>`,
        { status: 200 },
      ),
  );
  await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      source: 'https://carol.example/note-1',
      target: 'https://terminaleighty.com/another/',
    }).toString(),
  });

  const list = await (await fetch(`${adminUrl}/api/comments?status=all&limit=200`)).json();
  const sources = new Set(list.items.map((c) => c.source));
  assert.ok(sources.has('remark42'), 'expected remark42 in merged list');
  assert.ok(sources.has('webmention'), 'expected webmention in merged list');
});

// ── /api/comments/:id/reply ───────────────────────────────────────

test('POST /api/comments/:id/reply forwards to Remark42 with admin JWT', skipOpts(), async () => {
  resetFetch();
  let postedUrl = null;
  let postedInit = null;
  registerFetch(/\/api\/v1\/comment$/, (url, init) => {
    postedUrl = url;
    postedInit = init;
    return new Response(
      JSON.stringify({
        id: 'reply-1',
        text: '<p>thanks</p>',
        time: new Date().toISOString(),
        user: { id: 'admin', name: 'admin', admin: true },
        locator: { url: 'https://terminaleighty.com/hello-world/', site: 'terminaleighty' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  // The route looks up the parent first if no postUrl is supplied — provide one.
  const res = await fetch(`${adminUrl}/api/comments/parent-1/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'thanks', postUrl: 'https://terminaleighty.com/hello-world/' }),
  });
  assert.equal(res.status, 201);
  assert.ok(postedUrl);
  assert.ok(postedInit);
  assert.equal(postedInit.method, 'POST');
  // Auth header should carry the admin JWT.
  const auth = postedInit.headers?.Authorization || postedInit.headers?.authorization;
  assert.match(String(auth || ''), /^Bearer /);
});

test('POST /api/comments/:id/reply returns 409 for webmentions', skipOpts(), async () => {
  // Pick the first webmention id we've seeded above.
  const list = await (await fetch(`${adminUrl}/api/comments?status=pending`)).json();
  assert.ok(list.items.length);
  const wmId = list.items[0].id;
  const res = await fetch(`${adminUrl}/api/comments/${encodeURIComponent(wmId)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'cannot_reply_to_webmention');
});

// ── Spam + block flow ─────────────────────────────────────────────

test('POST /api/comments/:id/spam deletes + blocks + mirrors locally', skipOpts(), async () => {
  resetFetch();
  // Stub the Remark42 admin delete + block-user endpoints to all 200.
  registerFetch(
    /\/api\/v1\/admin\/comment\//,
    () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  registerFetch(
    /\/api\/v1\/admin\/user\//,
    () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  const res = await fetch(`${adminUrl}/api/comments/r42-spam-1/spam`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postUrl: 'https://terminaleighty.com/hello-world/',
      userId: 'spammer',
      userName: 'Spammer',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.spam, true);
  assert.equal(body.userId, 'spammer');

  // Block-list endpoint should now include the user. (Reconcile may
  // also add upstream users; we just check ours is present.)
  registerFetch(
    /\/api\/v1\/admin\/blocked/,
    () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  const blocks = await (await fetch(`${adminUrl}/api/comments/blocks`)).json();
  assert.ok(blocks.items.some((b) => b.user_id === 'spammer'));
});

test('GET /api/comments/blocks survives Remark42 being down', skipOpts(), async () => {
  resetFetch();
  // Default fakeFetch → 404 for unregistered URLs. Listing should
  // still return the local mirror without throwing.
  const res = await fetch(`${adminUrl}/api/comments/blocks`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.items));
});

// ── Webmention POST → SSE broadcast ───────────────────────────────

test('webmention POST broadcasts on the webmentions SSE channel', skipOpts(), async () => {
  const captured = [];
  const fakeRes = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    flushHeaders() {},
    write(chunk) {
      captured.push(String(chunk));
    },
    on() {},
    end() {},
  };
  const subId = sseService.register({}, fakeRes, ['webmentions']);

  resetFetch();
  registerFetch(
    'https://dave.example/note-9',
    () =>
      new Response(
        `<article class="h-entry">
            <a class="u-in-reply-to" href="https://terminaleighty.com/sse-target/">re</a>
          </article>`,
        { status: 200 },
      ),
  );
  await fetch(`${publicUrl}/webmention`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      source: 'https://dave.example/note-9',
      target: 'https://terminaleighty.com/sse-target/',
    }).toString(),
  });

  const joined = captured.join('\n');
  assert.match(joined, /event:\s*webmention-new/);
  sseService.unregister(subId);
});
