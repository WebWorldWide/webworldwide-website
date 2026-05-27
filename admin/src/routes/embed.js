// @ts-check
/**
 * embed.js — Phase 7 paste-to-embed lookup.
 *
 *   GET /api/embed?url=…
 *
 * Resolves a single URL through the provider registry and returns the
 * uniform record `{ provider, id, shortcode, html, thumbnail, title,
 * author, width, height, type }`. The same record is cached in the
 * `embed_cache` table (24-hour TTL) so a second paste of the same URL
 * is served from disk without re-hitting the upstream.
 *
 * The editor's paste handler calls this on every plausible-URL paste
 * in WYSIWYG mode (see admin/public/js/editor.entry.js). It is also
 * called by the embed slash-menu item.
 *
 * Status codes:
 *
 *   200  — cache hit OR fresh resolution succeeded. Body: the record.
 *   304  — reserved (we don't conditional-get yet).
 *   400  — malformed URL, missing `url`, or non-https.
 *   404  — provider said "no such resource" (oEmbed 404).
 *   415  — denylisted scheme / host / path shape.
 *   502  — upstream provider error other than 404.
 *
 * The route never throws to the user — every unexpected error funnels
 * to a 502 JSON `{ error: 'upstream', provider }`.
 */

import { Router } from 'express';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { pickProvider } from '../services/embed/providers.js';
import { UpstreamError } from '../services/embed/oembed.js';
import { logActivity } from '../services/activity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TTL_MS = 24 * 60 * 60 * 1000;

const router = Router();

/** @type {Database.Database | null} */
let dbHandle = null;
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  // Belt-and-braces — the migration runner creates this table at boot,
  // but tests that import the route directly skip the runner.
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS embed_cache (
      url TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      shortcode TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embed_cache_expires ON embed_cache(expires_at);
  `);
  return dbHandle;
}

/**
 * Reject anything that isn't an https URL we can actually resolve.
 *
 * @param {string} raw
 * @returns {{ ok: true, url: URL } | { ok: false, status: number, error: string }}
 */
function normaliseInput(raw) {
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'url required' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, status: 400, error: 'url required' };
  if (trimmed.length > 2000) return { ok: false, status: 400, error: 'url too long' };
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, status: 400, error: 'invalid url' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, status: 415, error: 'https required' };
  }
  // Block private / loopback / unconventional hosts. Cheap pattern
  // check — covers the common cases (localhost, 127.x, 192.168.x,
  // 10.x, .internal). Production deploys behind a tunnel never see
  // user URLs that resolve to RFC1918, so we err on the strict side.
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^(::1|fe80:|fc00:|fd00:)/i.test(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return { ok: false, status: 415, error: 'private hosts not allowed' };
  }
  return { ok: true, url: u };
}

router.get('/', async (req, res) => {
  const parsed = normaliseInput(/** @type {string} */ (req.query?.url));
  if (parsed.ok !== true) {
    return res.status(parsed.status).json({ error: parsed.error });
  }
  const url = parsed.url;
  const key = url.href;
  // ── Cache lookup ─────────────────────────────────────────────
  const now = Date.now();
  let cached = null;
  try {
    cached = db()
      .prepare(
        `SELECT provider, shortcode, payload_json, fetched_at, expires_at
           FROM embed_cache WHERE url = ?`,
      )
      .get(key);
  } catch (err) {
    // A broken cache must not break embed lookups.
    console.warn('[embed] cache read failed:', err.message);
  }
  if (cached && cached.expires_at > now) {
    let payload = null;
    try {
      payload = JSON.parse(cached.payload_json);
    } catch {
      payload = null;
    }
    if (payload) {
      res.setHeader('X-Embed-Cache', 'HIT');
      return res.json(payload);
    }
  }

  // ── Resolve ─────────────────────────────────────────────────
  let record;
  try {
    const picked = pickProvider(url);
    record = await picked.provider.resolve(url, picked.match);
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Funnel provider 4xx through to the caller, default to 502.
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      return res.status(status).json({
        error: 'upstream',
        provider: err.provider || null,
        message: err.message,
      });
    }
    console.warn('[embed] resolve failed:', err && err.message);
    return res.status(502).json({ error: 'resolve_failed' });
  }
  if (!record) {
    return res.status(502).json({ error: 'no_record' });
  }

  // ── Cache write ─────────────────────────────────────────────
  try {
    db()
      .prepare(
        `INSERT INTO embed_cache (url, provider, shortcode, payload_json, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           provider     = excluded.provider,
           shortcode    = excluded.shortcode,
           payload_json = excluded.payload_json,
           fetched_at   = excluded.fetched_at,
           expires_at   = excluded.expires_at`,
      )
      .run(key, record.provider, record.shortcode, JSON.stringify(record), now, now + TTL_MS);
  } catch (err) {
    console.warn('[embed] cache write failed:', err.message);
  }

  logActivity({ req, action: 'embed.resolve', target: key, meta: { provider: record.provider } });
  res.setHeader('X-Embed-Cache', 'MISS');
  return res.json(record);
});

// Test seam — reset the DB handle so reload-against-fresh-temp-path works.
export const __test = {
  resetDb() {
    if (dbHandle) {
      try {
        dbHandle.close();
      } catch {
        /* ignore */
      }
    }
    dbHandle = null;
  },
};

export default router;
