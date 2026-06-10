// @ts-check
/**
 * analytics.js — server-side Umami analytics proxy.
 *
 * The dashboard's traffic widgets read /api/analytics/* instead of
 * talking to Umami directly: the admin credentials stay on the server,
 * and a small in-memory response cache (5-minute TTL) keeps the Pi
 * from hammering Umami on every dashboard load.
 *
 * Env:
 *   UMAMI_API_URL         base URL of the Umami instance (default http://umami:3000)
 *   UMAMI_ADMIN_USER      Umami login username
 *   UMAMI_ADMIN_PASSWORD  Umami login password
 *   UMAMI_SITE_ID         the Umami website UUID to report on
 *
 * Endpoints (mounted at /api/analytics, behind the session cookie):
 *
 *   GET /summary?range=7d|30d|90d
 *     → { configured: true, range, visitors, pageviews, avgTime, bounce,
 *         deltas: { visitors, pageviews, avgTime, bounce },
 *         series: [{ date: 'YYYY-MM-DD', pageviews }] }
 *     visitors/pageviews are window totals; avgTime is seconds
 *     (totaltime / visits); bounce is a 0..1 fraction (bounces /
 *     visits); each delta is the fractional change vs the previous
 *     equal-length window — (cur − prev) / prev, null when prev is 0.
 *
 *   GET /top?type=referrer|country&range=…
 *     → { configured: true, items: [{ label, visitors }] }
 *     Referrer rows with an empty source are labelled 'Direct';
 *     country codes map to display names via Intl.DisplayNames
 *     (falling back to the raw code).
 *
 *   GET /pages?range=…
 *     → { configured: true, items: [{ path, slug, pageviews }] }
 *     slug is the second path segment when the path matches
 *     /blog/<slug>/, else null.
 *
 * Degradation contract:
 *   - UMAMI_SITE_ID or credentials missing → 200 { configured: false }
 *     on every endpoint (the UI shows a setup hint instead).
 *   - Umami unreachable / login rejected → 503 { error: 'umami_unreachable' }.
 *   - Junk range/type → 400. Credentials never appear in error bodies.
 */

import { Router } from 'express';

const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RANGE_DAYS = new Map([
  ['7d', 7],
  ['30d', 30],
  ['90d', 90],
]);
const TOP_TYPES = new Set(['referrer', 'country']);

// ── Module state ────────────────────────────────────────────────────
// Bearer token from /api/auth/login, cached until a data call 401s.
/** @type {string | null} */
let cachedToken = null;
// Dedupes concurrent logins so parallel dashboard requests don't each
// hit /api/auth/login.
/** @type {Promise<string> | null} */
let loginInFlight = null;
// Response cache: key (endpoint + range) → { payload, expires }.
/** @type {Map<string, { payload: object, expires: number }>} */
const responseCache = new Map();
// Lazy Intl.DisplayNames instance for country labels.
/** @type {Intl.DisplayNames | null} */
let regionNames = null;

/**
 * Read the Umami connection settings from the environment. Read per
 * request (not at import time) so tests — and a future settings UI —
 * can change them without a process restart.
 *
 * @returns {{ apiUrl: string, user: string, password: string, siteId: string }}
 */
function getConfig() {
  return {
    apiUrl: (process.env.UMAMI_API_URL || 'http://umami:3000').replace(/\/+$/, ''),
    user: process.env.UMAMI_ADMIN_USER || '',
    password: process.env.UMAMI_ADMIN_PASSWORD || '',
    siteId: process.env.UMAMI_SITE_ID || '',
  };
}

/**
 * @param {{ user: string, password: string, siteId: string }} cfg
 * @returns {boolean} true when the site id and credentials are all present
 */
function isConfigured(cfg) {
  return Boolean(cfg.siteId && cfg.user && cfg.password);
}

/**
 * Validate the ?range= query parameter. Missing defaults to 30d;
 * anything other than 7d/30d/90d is rejected.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, range: string, days: number } | { ok: false }}
 */
function parseRange(raw) {
  const range = raw === undefined ? '30d' : String(raw);
  const days = RANGE_DAYS.get(range);
  if (!days) return { ok: false };
  return { ok: true, range, days };
}

/**
 * Compute the current window plus the previous equal-length window
 * (used for the summary deltas).
 *
 * @param {number} days
 * @returns {{ startAt: number, endAt: number, prevStartAt: number, prevEndAt: number }}
 */
function windowFor(days) {
  const endAt = Date.now();
  const startAt = endAt - days * DAY_MS;
  return { startAt, endAt, prevStartAt: startAt - days * DAY_MS, prevEndAt: startAt };
}

/**
 * POST /api/auth/login and cache the bearer token. Errors are kept
 * generic — they bubble out as a 503 and must never echo credentials.
 *
 * @param {{ apiUrl: string, user: string, password: string }} cfg
 * @returns {Promise<string>} the bearer token
 */
async function login(cfg) {
  const res = await fetch(`${cfg.apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.password }),
  });
  if (!res.ok) throw new Error(`umami login failed (${res.status})`);
  const body = await res.json();
  if (!body || typeof body.token !== 'string' || !body.token) {
    throw new Error('umami login response had no token');
  }
  cachedToken = body.token;
  return body.token;
}

/**
 * Return the cached token, or log in (deduping concurrent callers).
 *
 * @param {{ apiUrl: string, user: string, password: string }} cfg
 * @returns {Promise<string>}
 */
function ensureToken(cfg) {
  if (cachedToken) return Promise.resolve(cachedToken);
  if (!loginInFlight) {
    loginInFlight = login(cfg).finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

/**
 * GET a Umami REST path with the bearer token. On a 401 the cached
 * token is dropped, login runs once more, and the request is retried
 * a single time.
 *
 * @param {{ apiUrl: string, user: string, password: string }} cfg
 * @param {string} path path + query, e.g. '/api/websites/<id>/stats?startAt=…'
 * @returns {Promise<any>} parsed JSON body
 */
async function umamiGet(cfg, path) {
  let token = await ensureToken(cfg);
  let res = await fetch(`${cfg.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    cachedToken = null;
    token = await ensureToken(cfg);
    res = await fetch(`${cfg.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!res.ok) throw new Error(`umami responded ${res.status} for ${path.split('?')[0]}`);
  return res.json();
}

/**
 * Pull a numeric metric out of an Umami stats field. Umami v2 returns
 * `{ value, prev }` objects; older builds returned bare numbers —
 * accept both, default 0.
 *
 * @param {unknown} field
 * @returns {number}
 */
function metricValue(field) {
  if (typeof field === 'number' && Number.isFinite(field)) return field;
  if (field && typeof field === 'object') {
    const value = /** @type {{ value?: unknown }} */ (field).value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Reduce a raw Umami /stats body to the four summary numbers.
 *
 * @param {any} stats raw response from GET /api/websites/:id/stats
 * @returns {{ visitors: number, pageviews: number, avgTime: number, bounce: number }}
 */
function summarizeStats(stats) {
  const visitors = metricValue(stats?.visitors);
  const pageviews = metricValue(stats?.pageviews);
  const visits = metricValue(stats?.visits);
  const bounces = metricValue(stats?.bounces);
  const totaltime = metricValue(stats?.totaltime);
  return {
    visitors,
    pageviews,
    avgTime: visits > 0 ? totaltime / visits : 0,
    bounce: visits > 0 ? bounces / visits : 0,
  };
}

/**
 * Fractional change vs the previous window: (cur − prev) / prev.
 *
 * @param {number} cur
 * @param {number} prev
 * @returns {number | null} null when prev is 0 (no baseline to compare)
 */
function delta(cur, prev) {
  if (!prev) return null;
  return (cur - prev) / prev;
}

/**
 * Map a 2-letter country code to a display name, falling back to the
 * raw code (and 'Unknown' for rows with no country at all).
 *
 * @param {unknown} code
 * @returns {string}
 */
function countryLabel(code) {
  const raw = code ? String(code) : '';
  if (!raw) return 'Unknown';
  try {
    if (!regionNames) regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(raw.toUpperCase()) || raw;
  } catch {
    return raw;
  }
}

/**
 * Read a cached payload, expiring stale entries.
 *
 * @param {string} key
 * @returns {object | null}
 */
function cacheGet(key) {
  const hit = responseCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.payload;
  if (hit) responseCache.delete(key);
  return null;
}

/**
 * Store a payload for CACHE_TTL_MS.
 *
 * @param {string} key
 * @param {object} payload
 * @returns {void}
 */
function cachePut(key, payload) {
  responseCache.set(key, { payload, expires: Date.now() + CACHE_TTL_MS });
}

// ── GET /summary?range=7d|30d|90d ───────────────────────────────────
router.get('/summary', async (req, res) => {
  const cfg = getConfig();
  if (!isConfigured(cfg)) return res.json({ configured: false });
  const parsed = parseRange(req.query.range);
  if (!parsed.ok) return res.status(400).json({ error: 'invalid_range' });

  const cacheKey = `summary:${parsed.range}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { startAt, endAt, prevStartAt, prevEndAt } = windowFor(parsed.days);
    const base = `/api/websites/${encodeURIComponent(cfg.siteId)}`;
    // Sequential on purpose: one login, no parallel burst on the Pi.
    const curStats = await umamiGet(cfg, `${base}/stats?startAt=${startAt}&endAt=${endAt}`);
    const prevStats = await umamiGet(
      cfg,
      `${base}/stats?startAt=${prevStartAt}&endAt=${prevEndAt}`,
    );
    const views = await umamiGet(
      cfg,
      `${base}/pageviews?startAt=${startAt}&endAt=${endAt}&unit=day&timezone=UTC`,
    );

    const cur = summarizeStats(curStats);
    const prev = summarizeStats(prevStats);
    const series = (Array.isArray(views?.pageviews) ? views.pageviews : []).map((row) => ({
      // Umami returns 'YYYY-MM-DD' or 'YYYY-MM-DD HH:mm:ss' x values
      // depending on version — keep just the date part.
      date: String(row?.x ?? '').slice(0, 10),
      pageviews: Number(row?.y) || 0,
    }));

    const payload = {
      configured: true,
      range: parsed.range,
      visitors: cur.visitors,
      pageviews: cur.pageviews,
      avgTime: cur.avgTime,
      bounce: cur.bounce,
      deltas: {
        visitors: delta(cur.visitors, prev.visitors),
        pageviews: delta(cur.pageviews, prev.pageviews),
        avgTime: delta(cur.avgTime, prev.avgTime),
        bounce: delta(cur.bounce, prev.bounce),
      },
      series,
    };
    cachePut(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.warn('[analytics] summary failed:', err instanceof Error ? err.message : err);
    return res.status(503).json({ error: 'umami_unreachable' });
  }
});

// ── GET /top?type=referrer|country&range=… ──────────────────────────
router.get('/top', async (req, res) => {
  const cfg = getConfig();
  if (!isConfigured(cfg)) return res.json({ configured: false });
  const type = String(req.query.type ?? '');
  if (!TOP_TYPES.has(type)) return res.status(400).json({ error: 'invalid_type' });
  const parsed = parseRange(req.query.range);
  if (!parsed.ok) return res.status(400).json({ error: 'invalid_range' });

  const cacheKey = `top:${type}:${parsed.range}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { startAt, endAt } = windowFor(parsed.days);
    const base = `/api/websites/${encodeURIComponent(cfg.siteId)}`;
    const rows = await umamiGet(
      cfg,
      `${base}/metrics?type=${type}&startAt=${startAt}&endAt=${endAt}&limit=10`,
    );
    const items = (Array.isArray(rows) ? rows : []).map((row) => ({
      label: type === 'country' ? countryLabel(row?.x) : row?.x ? String(row.x) : 'Direct',
      visitors: Number(row?.y) || 0,
    }));
    const payload = { configured: true, items };
    cachePut(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.warn('[analytics] top failed:', err instanceof Error ? err.message : err);
    return res.status(503).json({ error: 'umami_unreachable' });
  }
});

// ── GET /pages?range=… ──────────────────────────────────────────────
router.get('/pages', async (req, res) => {
  const cfg = getConfig();
  if (!isConfigured(cfg)) return res.json({ configured: false });
  const parsed = parseRange(req.query.range);
  if (!parsed.ok) return res.status(400).json({ error: 'invalid_range' });

  const cacheKey = `pages:${parsed.range}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { startAt, endAt } = windowFor(parsed.days);
    const base = `/api/websites/${encodeURIComponent(cfg.siteId)}`;
    const rows = await umamiGet(
      cfg,
      `${base}/metrics?type=url&startAt=${startAt}&endAt=${endAt}&limit=10`,
    );
    const items = (Array.isArray(rows) ? rows : []).map((row) => {
      const path = String(row?.x ?? '');
      const blogMatch = path.match(/^\/blog\/([^/]+)\/?$/);
      return {
        path,
        slug: blogMatch ? blogMatch[1] : null,
        pageviews: Number(row?.y) || 0,
      };
    });
    const payload = { configured: true, items };
    cachePut(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.warn('[analytics] pages failed:', err instanceof Error ? err.message : err);
    return res.status(503).json({ error: 'umami_unreachable' });
  }
});

// Test seam — clear the token + response cache so each test starts cold.
export const __test = {
  reset() {
    cachedToken = null;
    loginInFlight = null;
    responseCache.clear();
  },
};

export default router;
