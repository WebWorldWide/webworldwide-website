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

import { isPrivateHost, screenedFetch } from '../utils/ssrf.js';
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
const TARGET_HOSTS = (process.env.WEBMENTION_HOSTS || 'webworldwide.online')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const FETCH_TIMEOUT_MS = Number(process.env.WEBMENTION_FETCH_TIMEOUT_MS || 8000);
const MAX_BODY_BYTES = Number(process.env.WEBMENTION_MAX_BYTES || 5 * 1024 * 1024); // 5 MB
const MAX_REDIRECTS = Number(process.env.WEBMENTION_MAX_REDIRECTS || 5);
const STATUSES = /** @type {const} */ ['pending', 'approved', 'rejected'];

// ── Test seam: pluggable fetch (defaults to globalThis.fetch). ───────
/** @type {typeof globalThis.fetch} */
let fetchImpl = (input, init) => globalThis.fetch(input, init);
// Real-DNS rebinding screen runs only on the production fetch path. When a
// test injects its own fetch it owns networking, so skip the live lookup
// (test hosts like *.example are NXDOMAIN and would otherwise be rejected).
let screenDns = true;
/**
 * @param {typeof globalThis.fetch | null | undefined} fn
 */
export function setFetchImpl(fn) {
  fetchImpl = fn || ((input, init) => globalThis.fetch(input, init));
  screenDns = !fn;
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
  // SSRF guard: we fetch the source to verify its back-link, so an attacker
  // could otherwise point it at an internal host. Reject obviously-private
  // source hosts. (Hostname-level — full DNS-rebinding defence would need
  // resolve-and-pin; this stops the easy IP-literal / localhost cases.)
  if (isPrivateHost(source.hostname)) {
    return { ok: false, status: 400, error: 'source host not allowed' };
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
    // Follow redirects MANUALLY so every hop is re-screened. The one-time
    // isPrivateHost check in validatePair only covers the *initial* host;
    // with redirect:'follow' an attacker-controlled source could 3xx toward
    // an internal address (LAN, loopback, link-local) and turn this public,
    // unauthenticated endpoint into an SSRF/port-scan probe. Re-validate the
    // protocol + host of the start URL and of each Location before fetching.
    // The shared guard re-screens every redirect hop, refuses non-public
    // addresses (incl. CGNAT/Tailscale, NAT64, mapped IPv6) and — with the
    // default pinned fetch — screens the address the socket actually uses.
    const res = await screenedFetch(url, {
      fetchImpl: screenDns ? undefined : fetchImpl,
      screenDns,
      maxRedirects: MAX_REDIRECTS,
      init: {
        headers: {
          'User-Agent': 'WebWorldWide-Webmention/1.0 (+https://webworldwide.online)',
          Accept: 'text/html, application/xhtml+xml',
        },
        signal: controller.signal,
      },
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

  let body;
  try {
    body = await fetchSource(row.source);
  } catch (err) {
    // Store a generic marker, not err.message: the detail can distinguish
    // internal hosts/ports (an SSRF oracle) and is surfaced via the admin
    // API. The full reason is logged server-side only.
    console.error('[webmention] fetch failed for', row.id, '-', err && err.message);
    db()
      .prepare(
        `UPDATE webmentions SET status = 'rejected', validated_at = ?, raw_html = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(Date.now(), 'fetch_failed', id);
    return;
  }

  const parsed = parseSource(body, row.source, row.target);
  if (!parsed.linksToTarget) {
    db()
      .prepare(
        `UPDATE webmentions SET status = 'rejected', validated_at = ?, raw_html = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(Date.now(), 'no_link_back', id);
    return;
  }

  // Do NOT persist the fetched body: storing response bytes from a
  // (best-effort screened) external fetch in a column the admin API
  // returns is needless exposure. The parsed `content` is what moderation
  // needs; raw_html holds only a short status marker.
  const stored = 'ok';

  // Default to `pending` so admin can moderate before publishing.
  // Override with `WEBMENTION_AUTO_APPROVE=1` for a low-friction
  // single-user setup (Phase 8.5 will surface the moderation UI).
  const autoApprove = process.env.WEBMENTION_AUTO_APPROVE === '1';

  db()
    .prepare(
      `UPDATE webmentions
          SET type = ?, author_name = ?, author_avatar = ?, author_url = ?,
              content = ?, validated_at = ?,
              -- An admin may approve/reject while the fetch is in flight;
              -- their decision wins over the validator's default.
              status = CASE WHEN status = 'pending' THEN ? ELSE status END,
              raw_html = ?
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
  // Normalise the target so storage and the feed lookup share one canonical key.
  // The feed normalises the QUERY but matched it against the raw stored value,
  // so a stored fragment/trailing-slash variant (Bridgy Fed appends fragments)
  // never matched → an approved mention silently never displayed.
  const normTarget = normaliseUrl(v.target);
  // Phase 9: detect bsky.app source URLs and capture the AT URI so the
  // admin can mirror replies back to the Bluesky thread later. NULL is
  // the common case (Bridgy Fed forwards Mastodon webmentions).
  const blueskyUri = webUrlToAtUri(v.source);
  // Dedup on (source, target): senders legitimately re-deliver (Bridgy Fed
  // re-sends on edits and periodically), so re-validate the existing row in
  // place rather than inserting a duplicate that inflates like/reply counts.
  let id;
  // A fresh/pending mention gets (re)validated below. But a mention the admin
  // ALREADY moderated (approved/rejected) must keep that decision on a
  // re-delivery — Bridgy Fed re-sends periodically + on edits, and resetting it
  // to 'pending' would silently un-publish an approved reply/like from the
  // public feed (which only shows status='approved') until re-approved.
  let revalidate = true;
  try {
    const existing = db()
      .prepare('SELECT id, status, raw_html FROM webmentions WHERE source = ? AND target = ?')
      .get(v.source, normTarget);
    if (existing) {
      id = existing.id;
      // A rejection the validator made on its own (transient fetch failure, or
      // the link back wasn't there yet) is not a moderation decision — a
      // re-delivery should get a fresh check, not be ignored forever.
      const systemRejected =
        existing.status === 'rejected' &&
        (existing.raw_html === 'fetch_failed' || existing.raw_html === 'no_link_back');
      if (!systemRejected && (existing.status === 'approved' || existing.status === 'rejected')) {
        // Already moderated — record the re-delivery time but PRESERVE the
        // decision; do not re-validate (which would reset it to pending).
        db().prepare(`UPDATE webmentions SET received_at = ? WHERE id = ?`).run(Date.now(), id);
        revalidate = false;
      } else {
        db()
          .prepare(
            `UPDATE webmentions
                SET status = 'pending', received_at = ?, validated_at = NULL
              WHERE id = ?`,
          )
          .run(Date.now(), id);
      }
    } else {
      id = nanoid();
      db()
        .prepare(
          `INSERT INTO webmentions
              (id, source, target, type, received_at, status, bluesky_uri)
           VALUES (?, ?, ?, 'mention', ?, 'pending', ?)`,
        )
        .run(id, v.source, normTarget, Date.now(), blueskyUri);
    }
  } catch (err) {
    console.warn('[webmention] insert failed:', err && err.message);
    return res.status(500).json({ error: 'storage failed' });
  }

  // Fire-and-forget validation. The spec says we MAY do this
  // asynchronously and return 202 immediately — that's what we do.
  setImmediate(() => {
    // Skip an already-moderated re-delivery — keep the prior approve/reject.
    if (!revalidate) return;
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
    // eslint-disable-next-line security/detect-object-injection -- bucket is one of the predefined keys above
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
  if (status && STATUSES.includes(/** @type {any} */ status)) {
    rows = db()
      .prepare(`SELECT * FROM webmentions WHERE status = ? ORDER BY received_at DESC LIMIT ?`)
      .all(status, limit);
  } else {
    rows = db().prepare(`SELECT * FROM webmentions ORDER BY received_at DESC LIMIT ?`).all(limit);
  }
  // Never expose raw_html (fetch-time marker) over the moderation API.
  res.json(rows.map(({ raw_html: _omit, ...r }) => r));
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
  const r = db()
    .prepare(`UPDATE webmentions SET status = 'rejected', raw_html = 'admin' WHERE id = ?`)
    .run(id);
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

// Re-exported for callers/tests that imported it from this route.
export { isPrivateHost };
