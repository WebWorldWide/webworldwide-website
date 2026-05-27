// @ts-check
/**
 * webmentions.js — Phase 8 Webmention receiver.
 *
 * Implements the W3C Webmention spec (https://www.w3.org/TR/webmention/)
 * plus a small admin surface for moderation.
 *
 * Bridgy Fed (https://fed.brid.gy) forwards Fediverse replies / likes /
 * reposts to this endpoint as standard webmentions, which is how the
 * blog federates without a self-hosted ActivityPub server.
 *
 * Routes (mounted at `/webmention` — note the singular, per spec):
 *
 *   POST /webmention
 *     Body: form-encoded `source=<url>&target=<url>`.
 *     202 + Location header on accept; row stored with status='pending'
 *     and a background validation step runs (no queue — just a
 *     setImmediate that fetches + parses; the receiver is low-volume).
 *     400 on validation errors (missing fields, non-https, target not
 *     our domain, source==target).
 *
 *   GET /webmention/feed?target=<url>
 *     Public JSON feed of `approved` mentions for a given target URL.
 *     This is what `site/layouts/partials/webmentions.html` consumes
 *     at build time (the Pi's dump script writes the on-disk snapshot
 *     under `site/data/webmentions/<slug>.json` once per cycle).
 *
 *   GET /webmention/:id
 *     Public status of a single webmention (so a sender can poll the
 *     Location header it got back from the POST).
 *
 *   GET /api/webmentions            (auth required)
 *     Admin moderation list with optional ?status= filter.
 *
 *   POST /api/webmentions/:id/approve
 *   POST /api/webmentions/:id/reject     (both auth required)
 *
 * The POST endpoint deliberately is NOT under /api so it sits outside
 * the session-cookie auth middleware in server.js. Webmention is an
 * unauthenticated public-facing endpoint (any site on the open web
 * can ping us); spam control happens via:
 *   1. Strict back-link validation (source must link to target).
 *   2. Per-source rate limiting (express-rate-limit at mount time).
 *   3. status='pending' → admin moderation queue until approved.
 */

import { Router } from 'express';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

import { parseSource, normaliseUrl } from '../services/microformats.js';
import { logActivity } from '../services/activity.js';
import { broadcast as sseBroadcast } from '../services/sse.js';
import { webUrlToAtUri } from '../services/bluesky.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ───────────────────────────────────────────────────
const TARGET_HOSTS = (process.env.WEBMENTION_HOSTS || 'terminaleighty.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const FETCH_TIMEOUT_MS = Number(process.env.WEBMENTION_FETCH_TIMEOUT_MS || 8000);
const MAX_BODY_BYTES = Number(process.env.WEBMENTION_MAX_BYTES || 5 * 1024 * 1024); // 5 MB
const STATUSES = /** @type {const} */ (['pending', 'approved', 'rejected']);

// ── Test seam: pluggable fetch (defaults to globalThis.fetch). ───────
/** @type {typeof globalThis.fetch} */
let fetchImpl = (input, init) => globalThis.fetch(input, init);
/**
 * @param {typeof globalThis.fetch | null | undefined} fn
 */
export function setFetchImpl(fn) {
  fetchImpl = fn || ((input, init) => globalThis.fetch(input, init));
}

/** @type {Database.Database | null} */
let dbHandle = null;
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  // Migration runner creates this at boot; safety net for direct-import tests.
  // Phase 9 added `bluesky_uri` — kept in this safety net so direct-import
  // tests don't need to run the migration runner first.
  dbHandle.exec(`
    CREATE TABLE IF NOT EXISTS webmentions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'mention',
      author_name TEXT,
      author_avatar TEXT,
      author_url TEXT,
      content TEXT,
      received_at INTEGER NOT NULL,
      validated_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      raw_html TEXT,
      bluesky_uri TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wm_target_status
      ON webmentions(target, status, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wm_status ON webmentions(status);
  `);
  // If the table already existed without bluesky_uri (older test DBs),
  // ALTER it in. Wrapped in try/catch because the column may already exist.
  try {
    dbHandle.exec(`ALTER TABLE webmentions ADD COLUMN bluesky_uri TEXT`);
  } catch (_) {
    /* column already present — fine */
  }
  return dbHandle;
}

/**
 * Validate the incoming source/target pair. Returns either `{ ok: true,
 * source, target }` (both normalised URL strings) or a `{ ok: false,
 * status, error }` envelope ready to return to the caller.
 *
 * Rules:
 *   - Both required.
 *   - Both must be absolute https URLs (the W3C spec allows http too,
 *     but we restrict — Bridgy Fed always sends https; opens fewer
 *     SSRF holes if we never follow http).
 *   - source MUST NOT equal target.
 *   - target's hostname MUST match one of WEBMENTION_HOSTS.
 *
 * @param {any} sourceRaw
 * @param {any} targetRaw
 * @returns {{ ok: true, source: string, target: string }
 *           | { ok: false, status: number, error: string }}
 */
export function validatePair(sourceRaw, targetRaw) {
  if (!sourceRaw || !targetRaw) {
    return { ok: false, status: 400, error: 'source and target required' };
  }
  let source, target;
  try {
    source = new URL(String(sourceRaw));
  } catch {
    return { ok: false, status: 400, error: 'invalid source URL' };
  }
  try {
    target = new URL(String(targetRaw));
  } catch {
    return { ok: false, status: 400, error: 'invalid target URL' };
  }
  if (source.protocol !== 'https:') {
    return { ok: false, status: 400, error: 'source must be https' };
  }
  if (target.protocol !== 'https:') {
    return { ok: false, status: 400, error: 'target must be https' };
  }
  if (normaliseUrl(source.href) === normaliseUrl(target.href)) {
    return { ok: false, status: 400, error: 'source and target must differ' };
  }
  if (!TARGET_HOSTS.includes(target.hostname.toLowerCase())) {
    return { ok: false, status: 400, error: 'target not on this site' };
  }
  return { ok: true, source: source.href, target: target.href };
}

/**
 * Fetch the source URL with a hard timeout + size cap. Returns the
 * decoded body, or throws. Used by the background validator.
 *
 * @param {string} url
 */
async function fetchSource(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'TerminalEighty-Webmention/1.0 (+https://terminaleighty.com)',
        Accept: 'text/html, application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`fetch returned ${res.status}`);
    }
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      return text.slice(0, MAX_BODY_BYTES);
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('source exceeds max body size');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((u8) => Buffer.from(u8))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process one pending webmention end-to-end: fetch source, parse,
 * decide status, write back to the DB. Exported so tests can drive
 * the flow synchronously without waiting for setImmediate.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function validateMention(id) {
  const row = db().prepare('SELECT * FROM webmentions WHERE id = ?').get(id);
  if (!row) return;

  let body = '';
  try {
    body = await fetchSource(row.source);
  } catch (err) {
    db()
      .prepare(
        `UPDATE webmentions SET status = 'rejected', validated_at = ?, raw_html = ? WHERE id = ?`,
      )
      .run(Date.now(), `fetch_failed: ${err.message}`.slice(0, 1024), id);
    return;
  }

  const parsed = parseSource(body, row.source, row.target);
  if (!parsed.linksToTarget) {
    db()
      .prepare(
        `UPDATE webmentions SET status = 'rejected', validated_at = ?, raw_html = ? WHERE id = ?`,
      )
      .run(Date.now(), 'no_link_back', id);
    return;
  }

  // Truncate body for storage — useful for moderation diffing, never
  // rendered to readers.
  const stored = body.slice(0, 16 * 1024);

  // Default to `pending` so admin can moderate before publishing.
  // Override with `WEBMENTION_AUTO_APPROVE=1` for a low-friction
  // single-user setup (Phase 8.5 will surface the moderation UI).
  const autoApprove = process.env.WEBMENTION_AUTO_APPROVE === '1';

  db()
    .prepare(
      `UPDATE webmentions
          SET type = ?, author_name = ?, author_avatar = ?, author_url = ?,
              content = ?, validated_at = ?, status = ?, raw_html = ?
        WHERE id = ?`,
    )
    .run(
      parsed.type,
      parsed.author?.name || null,
      parsed.author?.photo || null,
      parsed.author?.url || null,
      parsed.content || parsed.summary || null,
      Date.now(),
      autoApprove ? 'approved' : 'pending',
      stored,
      id,
    );

  // Phase 8.5: tell the admin UI that this row is fully validated.
  // Lets the moderation view re-render the row with its actual author
  // / content / type without a refresh.
  try {
    sseBroadcast('webmentions', 'webmention-validated', {
      id,
      status: autoApprove ? 'approved' : 'pending',
      type: parsed.type,
      author: parsed.author?.name || null,
    });
  } catch (_) {
    /* non-critical */
  }
}

// ── Public router (no auth) — mounted at /webmention ────────────────
export const publicRouter = Router();

publicRouter.post('/', async (req, res) => {
  const source = req.body?.source;
  const target = req.body?.target;
  const v = validatePair(source, target);
  if (v.ok !== true) {
    return res.status(v.status).json({ error: v.error });
  }
  const id = nanoid();
  // Phase 9: detect bsky.app source URLs and capture the AT URI so the
  // admin can mirror replies back to the Bluesky thread later. NULL is
  // the common case (Bridgy Fed forwards Mastodon webmentions).
  const blueskyUri = webUrlToAtUri(v.source);
  try {
    db()
      .prepare(
        `INSERT INTO webmentions
            (id, source, target, type, received_at, status, bluesky_uri)
         VALUES (?, ?, ?, 'mention', ?, 'pending', ?)`,
      )
      .run(id, v.source, v.target, Date.now(), blueskyUri);
  } catch (err) {
    console.warn('[webmention] insert failed:', err && err.message);
    return res.status(500).json({ error: 'storage failed' });
  }

  // Fire-and-forget validation. The spec says we MAY do this
  // asynchronously and return 202 immediately — that's what we do.
  setImmediate(() => {
    validateMention(id).catch((err) => {
      console.warn('[webmention] validate failed for', id, err && err.message);
    });
  });

  logActivity({
    user: 'system',
    action: 'webmention.receive',
    target: v.target,
    meta: { source: v.source, id },
  });

  // Phase 8.5: push to the admin SSE channel so the moderation UI can
  // toast + bump the unread badge without polling.
  try {
    sseBroadcast('webmentions', 'webmention-new', {
      id,
      source: v.source,
      target: v.target,
      status: 'pending',
      ts: Date.now(),
    });
  } catch (err) {
    // SSE is non-critical — never fail the inbound POST over a broadcast hiccup.
    console.warn('[webmention] sse broadcast failed:', err && err.message);
  }

  const statusUrl = `/webmention/${id}`;
  res.setHeader('Location', statusUrl);
  return res.status(202).json({ id, status: 'pending', url: statusUrl });
});

publicRouter.get('/feed', (req, res) => {
  const target = String(req.query?.target || '');
  if (!target) return res.status(400).json({ error: 'target required' });
  const normalised = normaliseUrl(target);
  // Match on the exact normalised target as well as the literal stored
  // form — Bridgy Fed sometimes appends a fragment we want to ignore.
  const rows = db()
    .prepare(
      `SELECT id, source, target, type, author_name, author_avatar,
              author_url, content, received_at, validated_at
         FROM webmentions
        WHERE status = 'approved' AND (target = ? OR target = ?)
        ORDER BY received_at ASC`,
    )
    .all(target, normalised);

  // Group by type so the renderer can show replies inline and
  // aggregate likes/reposts as a single row.
  const out = {
    target,
    count: rows.length,
    replies: [],
    likes: [],
    reposts: [],
    bookmarks: [],
    mentions: [],
  };
  for (const r of rows) {
    const shaped = {
      id: r.id,
      source: r.source,
      type: r.type,
      author: {
        name: r.author_name,
        avatar: r.author_avatar,
        url: r.author_url,
      },
      content: r.content,
      received_at: r.received_at,
    };

    // Map mention type → output bucket. We can't naively `${type}s` because
    // 'reply' → 'replys' (wrong plural). All other types pluralize cleanly.
    const bucketMap = {
      reply: 'replies',
      like: 'likes',
      repost: 'reposts',
      bookmark: 'bookmarks',
      mention: 'mentions',
    };
    const bucket = bucketMap[r.type] || 'mentions';
    if (Array.isArray(out[bucket])) {
      // eslint-disable-next-line security/detect-object-injection -- bucket is one of the predefined keys above
      out[bucket].push(shaped);
    } else {
      out.mentions.push(shaped);
    }
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json(out);
});

publicRouter.get('/:id', (req, res) => {
  const id = String(req.params.id || '');
  const row = db()
    .prepare(
      `SELECT id, source, target, type, status, received_at, validated_at
         FROM webmentions WHERE id = ?`,
    )
    .get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

// ── Admin router (auth required) — mounted under /api/webmentions ───
export const adminRouter = Router();

adminRouter.get('/', (req, res) => {
  const status = String(req.query?.status || '');
  const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 100));
  let rows;
  if (status && STATUSES.includes(/** @type {any} */ (status))) {
    rows = db()
      .prepare(`SELECT * FROM webmentions WHERE status = ? ORDER BY received_at DESC LIMIT ?`)
      .all(status, limit);
  } else {
    rows = db().prepare(`SELECT * FROM webmentions ORDER BY received_at DESC LIMIT ?`).all(limit);
  }
  res.json(rows);
});

adminRouter.post('/:id/approve', (req, res) => {
  const id = String(req.params.id || '');
  const r = db().prepare(`UPDATE webmentions SET status = 'approved' WHERE id = ?`).run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  logActivity({ req, action: 'webmention.approve', target: id });
  res.json({ id, status: 'approved' });
});

adminRouter.post('/:id/reject', (req, res) => {
  const id = String(req.params.id || '');
  const r = db().prepare(`UPDATE webmentions SET status = 'rejected' WHERE id = ?`).run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  logActivity({ req, action: 'webmention.reject', target: id });
  res.json({ id, status: 'rejected' });
});

adminRouter.delete('/:id', (req, res) => {
  const id = String(req.params.id || '');
  const r = db().prepare(`DELETE FROM webmentions WHERE id = ?`).run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  logActivity({ req, action: 'webmention.delete', target: id });
  res.status(204).end();
});

// Test seam: reset the DB handle + fetch impl between tests.
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
  resetFetch() {
    fetchImpl = (input, init) => globalThis.fetch(input, init);
  },
};

export default publicRouter;
