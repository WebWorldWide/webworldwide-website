// @ts-nocheck
/**
 * analytics.test.js — server-side Umami analytics proxy.
 *
 * Coverage:
 *   - login flow + token reuse (login hits /api/auth/login once
 *     across two data calls)
 *   - /summary shape: window totals, avgTime/bounce math, delta math
 *     vs the previous equal-length window, series mapping
 *   - deltas are null when the previous window is empty
 *   - stale token: data call 401 → re-login once → retry succeeds
 *   - configured:false (200) on every endpoint when env is missing
 *   - 503 { error: 'umami_unreachable' } when fetch rejects or login
 *     fails — and the body never leaks credentials
 *   - /top referrer: empty x → 'Direct'
 *   - /top country: code → Intl.DisplayNames label, fallback to code
 *   - /pages: /blog/<slug>/ extraction, null slug elsewhere
 *   - range/type validation → 400
 *   - response cache: a second call within the TTL doesn't refetch
 *
 * globalThis.fetch is stubbed: requests to the fake Umami origin are
 * served from the mock below; everything else (the test's own calls
 * to the local Express app) passes through to the real fetch.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const UMAMI_URL = 'http://umami.test:3000';
const SITE_ID = '019540d2-site-uuid';
const PASSWORD = 'hunter2-do-not-leak';

let app;
let baseUrl;
let analyticsTest; // __test seam from the route module

const realFetch = globalThis.fetch;

// ── Umami mock state ──────────────────────────────────────────────
const mock = {};

function defaultMock() {
  return {
    loginCalls: 0,
    lastLoginBody: null,
    failLogin: false,
    reject: false,
    dataCalls: [],
    staleTokens: new Set(),
    statsCurrent: {
      pageviews: { value: 250 },
      visitors: { value: 100 },
      visits: { value: 120 },
      bounces: { value: 30 },
      totaltime: { value: 36000 },
    },
    statsPrevious: {
      pageviews: { value: 200 },
      visitors: { value: 80 },
      visits: { value: 100 },
      bounces: { value: 40 },
      totaltime: { value: 25000 },
    },
    pageviews: {
      pageviews: [
        { x: '2026-06-01', y: 5 },
        { x: '2026-06-02 00:00:00', y: 7 },
      ],
      sessions: [{ x: '2026-06-01', y: 3 }],
    },
    metrics: {
      referrer: [
        { x: '', y: 5 },
        { x: 'google.com', y: 3 },
      ],
      country: [
        { x: 'US', y: 9 },
        { x: 'XX', y: 1 },
      ],
      path: [
        { x: '/blog/my-post/', y: 10 },
        { x: '/about/', y: 4 },
      ],
    },
  };
}

function resetMock() {
  Object.assign(mock, defaultMock());
  mock.dataCalls = [];
  mock.staleTokens = new Set();
  analyticsTest.reset();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function umamiFetch(url, init = {}) {
  if (mock.reject) throw new Error('connect ECONNREFUSED 172.18.0.9:3000');
  const u = new URL(url);

  if (u.pathname === '/api/auth/login') {
    mock.loginCalls += 1;
    mock.lastLoginBody = JSON.parse(init.body);
    if (mock.failLogin) return json({ error: 'message.incorrect-username-password' }, 401);
    return json({ token: `tok-${mock.loginCalls}` });
  }

  mock.dataCalls.push({ url, init });
  const auth = init.headers?.Authorization || init.headers?.authorization || '';
  const token = String(auth).replace(/^Bearer\s+/, '');
  if (mock.staleTokens.has(token)) return json({ error: 'unauthorized' }, 401);

  const m = u.pathname.match(/^\/api\/websites\/([^/]+)\/(stats|pageviews|metrics)$/);
  if (!m || m[1] !== SITE_ID) return json({ error: 'not found' }, 404);

  if (m[2] === 'stats') {
    // The current window's endAt is ~now; the previous window's endAt
    // is a full range back — distinguish on that.
    const endAt = Number(u.searchParams.get('endAt'));
    const isCurrent = Math.abs(Date.now() - endAt) < 60_000;
    return json(isCurrent ? mock.statsCurrent : mock.statsPrevious);
  }
  if (m[2] === 'pageviews') return json(mock.pageviews);
  const type = u.searchParams.get('type');
  // Umami v3 retired the `url` metric type (it's `path` now) and 400s on
  // it — mirror that so the route can never regress to the old name.
  if (type === 'url') return json({ error: 'invalid type' }, 400);
  return json(mock.metrics[type] ?? []);
}

const approx = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} ≈ ${expected}`);

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.UMAMI_API_URL = UMAMI_URL;
  process.env.UMAMI_ADMIN_USER = 'admin';
  process.env.UMAMI_ADMIN_PASSWORD = PASSWORD;
  process.env.UMAMI_SITE_ID = SITE_ID;

  // Stub fetch: the fake Umami origin → mock; everything else (the
  // test's own requests against the local Express app) → real fetch.
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.startsWith(UMAMI_URL)) {
      return umamiFetch(url, init);
    }
    return realFetch(input, init);
  };

  // Fresh import AFTER env + fetch setup.
  const mod = await import('../src/routes/analytics.js');
  analyticsTest = mod.__test;

  const express = (await import('express')).default;
  const a = express();
  a.use(express.json());
  a.use('/api/analytics', mod.default);
  await new Promise((resolve) => {
    app = a.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${app.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  if (app) await new Promise((resolve) => app.close(resolve));
});

// ── Login flow + token reuse ──────────────────────────────────────

test('login runs once and the token is reused across two data calls', async () => {
  resetMock();
  const r1 = await fetch(`${baseUrl}/api/analytics/summary?range=7d`);
  assert.equal(r1.status, 200);
  const r2 = await fetch(`${baseUrl}/api/analytics/top?type=referrer&range=7d`);
  assert.equal(r2.status, 200);

  assert.equal(mock.loginCalls, 1);
  assert.deepEqual(mock.lastLoginBody, { username: 'admin', password: PASSWORD });
  assert.ok(mock.dataCalls.length >= 4, 'expected stats×2 + pageviews + metrics upstream calls');
  for (const call of mock.dataCalls) {
    assert.equal(call.init.headers.Authorization, 'Bearer tok-1');
  }
});

// ── /summary shape ────────────────────────────────────────────────

test('summary: totals, avgTime/bounce math, deltas vs previous window, series', async () => {
  resetMock();
  const res = await fetch(`${baseUrl}/api/analytics/summary?range=30d`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.configured, true);
  assert.equal(body.range, '30d');
  assert.equal(body.visitors, 100);
  assert.equal(body.pageviews, 250);
  assert.equal(body.avgTime, 300); // 36000 totaltime / 120 visits
  assert.equal(body.bounce, 0.25); // 30 bounces / 120 visits

  approx(body.deltas.visitors, 0.25); // (100 − 80) / 80
  approx(body.deltas.pageviews, 0.25); // (250 − 200) / 200
  approx(body.deltas.avgTime, 0.2); // (300 − 250) / 250
  approx(body.deltas.bounce, -0.375); // (0.25 − 0.4) / 0.4

  assert.deepEqual(body.series, [
    { date: '2026-06-01', pageviews: 5 },
    { date: '2026-06-02', pageviews: 7 },
  ]);

  // The previous stats window must be equal-length and end where the
  // current one starts.
  const statsCalls = mock.dataCalls.filter((c) => c.url.includes('/stats?'));
  assert.equal(statsCalls.length, 2);
  const [cur, prev] = statsCalls.map((c) => new URL(c.url).searchParams);
  assert.equal(
    Number(cur.get('endAt')) - Number(cur.get('startAt')),
    Number(prev.get('endAt')) - Number(prev.get('startAt')),
  );
  assert.equal(prev.get('endAt'), cur.get('startAt'));

  // Series request uses day buckets in UTC.
  const pv = mock.dataCalls.find((c) => c.url.includes('/pageviews?'));
  const pvParams = new URL(pv.url).searchParams;
  assert.equal(pvParams.get('unit'), 'day');
  assert.equal(pvParams.get('timezone'), 'UTC');
});

test('summary: deltas are null when the previous window is empty', async () => {
  resetMock();
  mock.statsPrevious = {
    pageviews: { value: 0 },
    visitors: { value: 0 },
    visits: { value: 0 },
    bounces: { value: 0 },
    totaltime: { value: 0 },
  };
  const body = await (await fetch(`${baseUrl}/api/analytics/summary?range=90d`)).json();
  assert.equal(body.deltas.visitors, null);
  assert.equal(body.deltas.pageviews, null);
  assert.equal(body.deltas.avgTime, null);
  assert.equal(body.deltas.bounce, null);
});

// ── 401 → re-login → retry ────────────────────────────────────────

test('stale token: 401 from a data call triggers one re-login + retry', async () => {
  resetMock();
  mock.staleTokens.add('tok-1'); // the first issued token is stale upstream

  const res = await fetch(`${baseUrl}/api/analytics/top?type=referrer&range=7d`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.ok(body.items.length > 0);

  assert.equal(mock.loginCalls, 2); // initial login + the re-login
  const metricCalls = mock.dataCalls.filter((c) => c.url.includes('type=referrer'));
  assert.equal(metricCalls.length, 2); // 401'd attempt + retried attempt
  assert.equal(metricCalls[0].init.headers.Authorization, 'Bearer tok-1');
  assert.equal(metricCalls[1].init.headers.Authorization, 'Bearer tok-2');
});

// ── Degradation: not configured ───────────────────────────────────

test('configured:false (200) on every endpoint when UMAMI_SITE_ID is missing', async () => {
  resetMock();
  const saved = process.env.UMAMI_SITE_ID;
  delete process.env.UMAMI_SITE_ID;
  try {
    for (const path of ['summary?range=7d', 'top?type=referrer&range=7d', 'pages?range=7d']) {
      const res = await fetch(`${baseUrl}/api/analytics/${path}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { configured: false });
    }
    assert.equal(mock.loginCalls, 0, 'must not touch Umami when unconfigured');
    assert.equal(mock.dataCalls.length, 0);
  } finally {
    process.env.UMAMI_SITE_ID = saved;
  }
});

// ── Degradation: Umami down ───────────────────────────────────────

test('503 umami_unreachable when fetch rejects — no credential leak', async () => {
  resetMock();
  mock.reject = true;
  const res = await fetch(`${baseUrl}/api/analytics/summary?range=7d`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { error: 'umami_unreachable' });
  assert.ok(!JSON.stringify(body).includes(PASSWORD));
});

test('503 umami_unreachable when login is rejected', async () => {
  resetMock();
  mock.failLogin = true;
  const res = await fetch(`${baseUrl}/api/analytics/pages?range=7d`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body, { error: 'umami_unreachable' });
  assert.ok(!JSON.stringify(body).includes(PASSWORD));
});

// ── /top mappings ─────────────────────────────────────────────────

test('top referrer: empty source maps to Direct', async () => {
  resetMock();
  const body = await (await fetch(`${baseUrl}/api/analytics/top?type=referrer&range=7d`)).json();
  assert.deepEqual(body, {
    configured: true,
    items: [
      { label: 'Direct', visitors: 5 },
      { label: 'google.com', visitors: 3 },
    ],
  });
});

test('top country: code maps to display name, unknown codes fall back', async () => {
  resetMock();
  const body = await (await fetch(`${baseUrl}/api/analytics/top?type=country&range=7d`)).json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.items[0], { label: 'United States', visitors: 9 });
  // 'XX' is syntactically valid but unassigned — falls back to the code.
  assert.deepEqual(body.items[1], { label: 'XX', visitors: 1 });
});

// ── /pages slug extraction ────────────────────────────────────────

test('pages: extracts the slug from /blog/<slug>/, null elsewhere', async () => {
  resetMock();
  const body = await (await fetch(`${baseUrl}/api/analytics/pages?range=7d`)).json();
  assert.deepEqual(body, {
    configured: true,
    items: [
      { path: '/blog/my-post/', slug: 'my-post', pageviews: 10 },
      { path: '/about/', slug: null, pageviews: 4 },
    ],
  });
});

// ── Validation ────────────────────────────────────────────────────

test('400 on junk range or type — and Umami is never called', async () => {
  resetMock();
  const bad = [
    'summary?range=14d',
    'summary?range=banana',
    'pages?range=1%20OR%201=1',
    'top?type=referrer&range=junk',
    'top?type=browser&range=7d',
    'top?range=7d', // missing type
  ];
  for (const path of bad) {
    const res = await fetch(`${baseUrl}/api/analytics/${path}`);
    assert.equal(res.status, 400, `expected 400 for ${path}`);
    const body = await res.json();
    assert.match(body.error, /^invalid_(range|type)$/);
  }
  assert.equal(mock.loginCalls, 0);
  assert.equal(mock.dataCalls.length, 0);
});

// ── Response cache ────────────────────────────────────────────────

test('cache: a second identical call within the TTL does not refetch', async () => {
  resetMock();
  const first = await (await fetch(`${baseUrl}/api/analytics/summary?range=7d`)).json();
  const callsAfterFirst = mock.dataCalls.length;
  const loginsAfterFirst = mock.loginCalls;
  assert.ok(callsAfterFirst > 0);

  const second = await (await fetch(`${baseUrl}/api/analytics/summary?range=7d`)).json();
  assert.equal(mock.dataCalls.length, callsAfterFirst, 'no new upstream data calls');
  assert.equal(mock.loginCalls, loginsAfterFirst, 'no new logins');
  assert.deepEqual(second, first);

  // A different range is a different cache key — it does refetch.
  await fetch(`${baseUrl}/api/analytics/summary?range=30d`);
  assert.ok(mock.dataCalls.length > callsAfterFirst);
});
