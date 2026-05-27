// @ts-check
/**
 * comments.js — Phase 8.5 unified comment moderation API.
 *
 * One place to manage every comment that lands on the blog — whether
 * it arrived through Remark42 (the primary commenting system) or as a
 * webmention via Bridgy Fed. The admin UI never has to know that
 * there are two backends; this route flattens both into a single
 * pageable list.
 *
 * Endpoints
 * ---------
 *
 *   GET    /api/comments
 *      Query params:
 *        status = visible | pinned | spam | deleted | pending | all
 *        post   = <slug>      (substring match against postUrl)
 *        author = <author id> (Remark42 user id, or webmention author host)
 *        page   = 1
 *        limit  = 20
 *      Response: { items: [...], page, limit, total, hasMore }
 *      Each item conforms to the unified shape produced by
 *      normaliseRemarkComment / normaliseWebmention below.
 *
 *   GET    /api/comments/:id
 *      Single comment lookup. Returns 404 on miss. `id` is the
 *      Remark42 comment id OR the webmention nanoid; the source is
 *      derived from the `source=` query (default: tries both).
 *
 *   POST   /api/comments/:id/reply
 *      Body: { text }
 *      Posts a reply via Remark42 as the site admin. For webmention
 *      rows, returns 409 — replies to a webmention belong on the
 *      source site (Bluesky / Mastodon), not here. Phase 9 will extend
 *      this to cross-post to the bluesky_uri thread.
 *
 *   PATCH  /api/comments/:id
 *      Body: { text }
 *      Edits the comment. Webmention edits are not supported.
 *
 *   DELETE /api/comments/:id
 *      Soft-delete (Remark42) / hard-delete (webmention).
 *
 *   POST   /api/comments/:id/pin
 *   POST   /api/comments/:id/unpin
 *      Pin or unpin a Remark42 comment. Webmention rows return 409.
 *
 *   POST   /api/comments/:id/spam
 *      Mark a comment as spam. For Remark42: soft-delete the comment
 *      AND block the author (TTL = 1y by default). For webmention:
 *      flip the row to status='rejected'.
 *
 *   GET    /api/comments/blocks
 *      Block-list mirror (reads local table + reconciles with the
 *      Remark42 admin/blocked endpoint).
 *
 *   POST   /api/comments/blocks
 *      Body: { userId, userName?, reason?, ttl? }
 *      Add a block locally + upstream.
 *
 *   DELETE /api/comments/blocks/:id
 *      Remove a block by row id.
 *
 *   GET    /api/comments/stream
 *      Server-Sent Events channel. Emits:
 *         event: comment-new     (Remark42 poller picked up a comment)
 *         event: webmention-new  (the receiver inserted a pending row)
 *         event: ping            (heartbeat, every 30s — clients ignore)
 *
 * All endpoints are mounted under the same /api auth middleware as
 * /api/posts, so an unauthenticated request gets a 401 long before it
 * reaches us.
 */

import { Router } from 'express';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';

import * as remark42 from '../services/remark42.js';
import * as bluesky from '../services/bluesky.js';
import { register as sseRegister, broadcast as sseBroadcast } from '../services/sse.js';
import { logActivity } from '../services/activity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// ── DB handle ────────────────────────────────────────────────────────

/** @type {Database.Database | null} */
let dbHandle = null;
function db() {
  if (dbHandle) return dbHandle;
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  dbHandle = new Database(dbPath);
  dbHandle.pragma('journal_mode = WAL');
  // Safety net for direct-import tests (the migration runner is the
  // primary creator). Phase 9 added `bluesky_uri` — kept in sync with
  // the schema in webmentions.js so direct-import tests don't need to
  // run the migration runner first.
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
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      reason TEXT,
      ttl_ms INTEGER,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      UNIQUE(site_id, user_id)
    );
  `);
  // Same idempotent ALTER as webmentions.js — covers test DBs that
  // were created against an older schema.
  try {
    dbHandle.exec(`ALTER TABLE webmentions ADD COLUMN bluesky_uri TEXT`);
  } catch (_) {
    /* column already present — fine */
  }
  return dbHandle;
}

// ── post-slug → title cache (read from site/content/posts/*.md) ──────
//
// We resolve titles cheaply on demand. The result is cached in-process
// for 60s so a heavy admin pageload doesn't re-stat the directory once
// per row.

const SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', '..', '..', 'site');
const POSTS_DIR = join(SITE_DIR, 'content', 'posts');

/** @type {{ map: Record<string, { title: string, slug: string }>, ts: number } | null} */
let postCache = null;
const POST_CACHE_TTL_MS = 60 * 1000;

function postIndex() {
  const now = Date.now();
  if (postCache && now - postCache.ts < POST_CACHE_TTL_MS) return postCache.map;
  /** @type {Record<string, { title: string, slug: string }>} */
  const map = {};
  try {
    if (existsSync(POSTS_DIR)) {
      for (const fn of readdirSync(POSTS_DIR)) {
        if (!fn.endsWith('.md')) continue;
        try {
          const body = readFileSync(join(POSTS_DIR, fn), 'utf-8');
          const slug = fn.replace(/\.md$/, '').toLowerCase();
          const titleMatch = body.match(/^title\s*[:=]\s*['"]?(.+?)['"]?\s*$/m);
          const title = titleMatch ? titleMatch[1].trim() : slug;
          // index by slug AND filename-without-ext.
          // eslint-disable-next-line security/detect-object-injection -- slug from readdirSync; trusted FS contents
          map[slug] = { title, slug };
        } catch (_) {
          /* skip unparseable */
        }
      }
    }
  } catch (_) {
    /* directory missing — empty cache */
  }
  postCache = { map, ts: now };
  return map;
}

/**
 * Look up a post's title from its URL or slug. Returns the slug
 * unchanged if no title is found, so callers always get *something*
 * to render.
 *
 * @param {string} urlOrSlug
 * @returns {{ title: string, slug: string }}
 */
function postFor(urlOrSlug) {
  if (!urlOrSlug) return { title: '(unknown)', slug: '' };
  let slug = String(urlOrSlug).trim();
  try {
    if (slug.includes('://')) {
      const u = new URL(slug);
      const parts = u.pathname.split('/').filter(Boolean);
      slug = parts[0] || '__home__';
    } else {
      slug = slug.replace(/^\/+|\/+$/g, '').split('/')[0];
    }
  } catch (_) {
    /* leave as-is */
  }
  slug = slug.toLowerCase();
  const map = postIndex();
  // eslint-disable-next-line security/detect-object-injection -- slug derived from URL path; we re-normalised above
  const hit = map[slug];
  if (hit) return hit;
  return { title: slug, slug };
}

// ── unified shape helpers ────────────────────────────────────────────

/**
 * Normalise a Remark42 comment (already half-normalised by the
 * service) onto the row shape the admin UI consumes.
 *
 * @param {any} c
 */
function normaliseRemarkComment(c) {
  const post = postFor(c.postUrl);
  const plain = String(c.content || '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return {
    id: c.id,
    source: 'remark42',
    parentId: c.parentId || null,
    author: c.author,
    postSlug: post.slug,
    postTitle: post.title,
    postUrl: c.postUrl,
    content: c.content,
    excerpt: plain.length > 280 ? plain.slice(0, 277) + '…' : plain,
    ts: c.ts,
    status: c.status,
    originalUrl: null,
    raw: c.raw,
  };
}

/**
 * Normalise a webmention DB row into the same shape.
 *
 * @param {any} row
 */
function normaliseWebmention(row) {
  const post = postFor(row.target);
  const plain = String(row.content || '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return {
    id: row.id,
    source: 'webmention',
    parentId: null,
    author: {
      id: row.author_url || 'anonymous',
      name: row.author_name || 'anonymous',
      avatar: row.author_avatar || null,
      url: row.author_url || null,
      admin: false,
      blocked: false,
    },
    postSlug: post.slug,
    postTitle: post.title,
    postUrl: row.target,
    content: row.content || '',
    excerpt: plain.length > 280 ? plain.slice(0, 277) + '…' : plain,
    ts: row.received_at,
    status: row.status, // 'pending' | 'approved' | 'rejected'
    type: row.type, // 'reply' | 'like' | 'repost' | 'bookmark' | 'mention'
    originalUrl: row.source,
    raw: row,
  };
}

// ── handlers ─────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const status = String(req.query.status || 'all').toLowerCase();
  const postFilter = req.query.post ? String(req.query.post).toLowerCase() : '';
  const authorFilter = req.query.author ? String(req.query.author).toLowerCase() : '';
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
  const page = Math.max(1, Number(req.query.page) || 1);

  /** @type {any[]} */
  let items = [];
  let total = 0;
  /** @type {string|null} */
  let upstreamError = null;

  const wantsRemark =
    status === 'all' ||
    status === 'visible' ||
    status === 'pinned' ||
    status === 'spam' ||
    status === 'deleted';
  const wantsWebmention = status === 'all' || status === 'pending';

  if (wantsRemark) {
    try {
      const list = await remark42.lastComments({ max: 500 });
      let filtered = list.map(normaliseRemarkComment);
      if (status !== 'all') {
        filtered = filtered.filter((c) => c.status === status);
      }
      items = items.concat(filtered);
    } catch (err) {
      upstreamError = `remark42 unreachable (${err && err.message})`;
    }
  }

  if (wantsWebmention) {
    /** @type {any[]} */
    const rows = db()
      .prepare(`SELECT * FROM webmentions ORDER BY received_at DESC LIMIT 1000`)
      .all();
    let mapped = rows.map(normaliseWebmention);
    if (status === 'pending') mapped = mapped.filter((r) => r.status === 'pending');
    items = items.concat(mapped);
  }

  // Optional per-row filters.
  if (postFilter) {
    items = items.filter(
      (c) =>
        (c.postSlug && c.postSlug.toLowerCase().includes(postFilter)) ||
        (c.postUrl && c.postUrl.toLowerCase().includes(postFilter)) ||
        (c.postTitle && c.postTitle.toLowerCase().includes(postFilter)),
    );
  }
  if (authorFilter) {
    items = items.filter(
      (c) =>
        (c.author?.id && c.author.id.toLowerCase().includes(authorFilter)) ||
        (c.author?.name && c.author.name.toLowerCase().includes(authorFilter)),
    );
  }

  // Sort newest first, slice for page.
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  total = items.length;
  const start = (page - 1) * limit;
  const end = start + limit;
  const paged = items.slice(start, end);

  res.json({
    items: paged,
    page,
    limit,
    total,
    hasMore: end < total,
    warning: upstreamError,
  });
});

router.get('/blocks', async (req, res) => {
  const reconcile = req.query.reconcile !== '0';
  const siteFilter = process.env.REMARK42_SITE_ID || 'terminaleighty';

  // Reconcile with upstream best-effort. The local table is the source
  // of truth for the UI; out-of-band changes (admin used Remark42's own
  // UI) get folded in when this endpoint runs.
  if (reconcile) {
    try {
      const upstream = await remark42.listBlockedUsers();
      const stmt = db().prepare(
        `INSERT OR IGNORE INTO blocks (id, site_id, user_id, user_name, reason, ttl_ms, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const u of upstream) {
        if (!u.userId) continue;
        stmt.run(
          nanoid(),
          siteFilter,
          u.userId,
          u.name,
          'reconciled from remark42',
          u.until,
          Date.now(),
          'system',
        );
      }
    } catch (_) {
      /* leave the local list alone if upstream is down */
    }
  }

  const rows = db()
    .prepare(
      `SELECT id, site_id, user_id, user_name, reason, ttl_ms, created_at, created_by
         FROM blocks WHERE site_id = ? ORDER BY created_at DESC`,
    )
    .all(siteFilter);
  res.json({ items: rows, total: rows.length });
});

router.post('/blocks', async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const userName = req.body?.userName ? String(req.body.userName) : null;
  const reason = req.body?.reason ? String(req.body.reason) : 'blocked from admin';
  const ttl = req.body?.ttl ? String(req.body.ttl) : ''; // '' = permanent

  try {
    await remark42.blockUser(userId, { block: true, ttl });
  } catch (err) {
    if (err.status && err.status !== 0) {
      // Couldn't reach upstream; still record locally so the admin sees
      // their intent. A future reconcile call will eventually push it.
      console.warn('[comments] blockUser upstream failed:', err.message);
    }
  }

  const id = nanoid();
  const siteFilter = process.env.REMARK42_SITE_ID || 'terminaleighty';
  try {
    db()
      .prepare(
        `INSERT OR REPLACE INTO blocks
            (id, site_id, user_id, user_name, reason, ttl_ms, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        siteFilter,
        userId,
        userName,
        reason,
        null, // upstream owns the actual TTL clock
        Date.now(),
        req.user?.username || 'admin',
      );
  } catch (err) {
    return res.status(500).json({ error: 'block insert failed: ' + err.message });
  }
  logActivity({ req, action: 'comment.block', target: userId, meta: { reason, ttl } });
  res.status(201).json({ id, userId, blocked: true });
});

router.delete('/blocks/:id', async (req, res) => {
  const id = String(req.params.id);
  const row = db().prepare(`SELECT user_id FROM blocks WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    await remark42.blockUser(row.user_id, { block: false });
  } catch (err) {
    console.warn('[comments] unblock upstream failed:', err.message);
  }
  db().prepare(`DELETE FROM blocks WHERE id = ?`).run(id);
  logActivity({ req, action: 'comment.unblock', target: row.user_id });
  res.status(204).end();
});

// ── stream ───────────────────────────────────────────────────────────
//
// Mount BEFORE the `/:id` routes below or Express's path matching will
// route `stream` into the param. We're already past `/blocks` (specific
// path), so registering this one before the param handler keeps the
// router clean.

router.get('/stream', (req, res) => {
  sseRegister(req, res, ['comments', 'webmentions']);
  // Emit one greeting frame so the client's `onopen` fires immediately
  // and they can update the "live" indicator without waiting for the
  // first real event.
  try {
    res.write(`event: hello\ndata: {"ts":${Date.now()}}\n\n`);
  } catch (_) {
    /* connection died before first write — register() cleans up */
  }
});

// ── individual comment endpoints ────────────────────────────────────

router.get('/:id', async (req, res) => {
  const id = String(req.params.id);
  const source = req.query.source ? String(req.query.source) : null;
  if (source === 'webmention' || (!source && id.length < 24 && id.length > 6)) {
    // nanoid range — try webmention first.
    const row = db().prepare(`SELECT * FROM webmentions WHERE id = ?`).get(id);
    if (row) return res.json(normaliseWebmention(row));
  }
  try {
    const url = req.query.url ? String(req.query.url) : undefined;
    const c = await remark42.getComment(id, url);
    if (c) return res.json(normaliseRemarkComment(c));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'not_found' });
    console.warn('[comments] getComment failed:', err.message);
  }
  // Last-ditch: maybe a webmention id that didn't match the heuristic.
  const fallback = db().prepare(`SELECT * FROM webmentions WHERE id = ?`).get(id);
  if (fallback) return res.json(normaliseWebmention(fallback));
  return res.status(404).json({ error: 'not_found' });
});

router.post('/:id/reply', async (req, res) => {
  const id = String(req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  // Webmention rows: if the source URL is a bsky.app post, Phase 9
  // lets us mirror the admin reply to the Bluesky thread. Otherwise
  // (Mastodon, generic Webmention) the reply belongs on the source
  // site and we keep the 409.
  const wm = db().prepare(`SELECT id, source, bluesky_uri FROM webmentions WHERE id = ?`).get(id);
  if (wm) {
    if (wm.bluesky_uri && bluesky.isConfigured()) {
      try {
        const agent = await bluesky.signIn();
        const reply = await bluesky.replyToPost(agent, wm.bluesky_uri, text);
        logActivity({
          req,
          action: 'comment.reply.bluesky',
          target: id,
          meta: { parent: wm.bluesky_uri, reply: reply.uri },
        });
        sseBroadcast('comments', 'comment-replied', {
          id,
          replyId: reply.uri,
          source: 'bluesky',
        });
        return res.status(201).json({
          id,
          source: 'bluesky',
          parent: wm.bluesky_uri,
          uri: reply.uri,
          cid: reply.cid,
        });
      } catch (err) {
        // Fall through to a 502 — the admin can retry once we know
        // what's broken upstream. Don't leak credentials in the
        // response body.
        console.warn('[comments] bluesky reply mirror failed:', err && err.message);
        return res.status(502).json({
          error: 'bluesky_reply_failed',
          hint: err && err.message,
        });
      }
    }
    if (wm.bluesky_uri && !bluesky.isConfigured()) {
      return res.status(409).json({
        error: 'cannot_reply_to_webmention',
        hint: 'Bluesky cross-post is not configured (BLUESKY_HANDLE/BLUESKY_APP_PASSWORD).',
      });
    }
    return res.status(409).json({
      error: 'cannot_reply_to_webmention',
      hint:
        'Reply on the source site (' +
        wm.source +
        '). Only bsky.app webmentions can be mirrored from here.',
    });
  }

  try {
    // We need the post URL to publish the reply; look up the parent.
    const url = req.body?.postUrl ? String(req.body.postUrl) : undefined;
    let postUrl = url;
    if (!postUrl) {
      const parent = await remark42.getComment(id);
      if (!parent) return res.status(404).json({ error: 'not_found' });
      postUrl = parent.postUrl;
    }
    const reply = await remark42.replyComment({ parentId: id, postUrl, text });
    if (!reply) return res.status(502).json({ error: 'reply_failed' });
    logActivity({ req, action: 'comment.reply', target: id, meta: { postUrl } });
    sseBroadcast('comments', 'comment-replied', { id, replyId: reply.id });
    res.status(201).json(normaliseRemarkComment(reply));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  const id = String(req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  const wm = db().prepare(`SELECT id FROM webmentions WHERE id = ?`).get(id);
  if (wm) return res.status(409).json({ error: 'cannot_edit_webmention' });

  try {
    const url = req.body?.postUrl ? String(req.body.postUrl) : undefined;
    let postUrl = url;
    if (!postUrl) {
      const parent = await remark42.getComment(id);
      if (!parent) return res.status(404).json({ error: 'not_found' });
      postUrl = parent.postUrl;
    }
    const updated = await remark42.editComment(id, postUrl, text);
    logActivity({ req, action: 'comment.edit', target: id });
    if (!updated) return res.status(502).json({ error: 'edit_failed' });
    res.json(normaliseRemarkComment(updated));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const id = String(req.params.id);

  // Webmention path — delete the local row outright (Bridgy Fed
  // doesn't have a "withdraw" so a future re-send would just create a
  // new row, but that's acceptable).
  const wm = db().prepare(`SELECT id FROM webmentions WHERE id = ?`).get(id);
  if (wm) {
    db().prepare(`DELETE FROM webmentions WHERE id = ?`).run(id);
    logActivity({ req, action: 'webmention.delete', target: id });
    return res.status(204).end();
  }

  try {
    const url = req.query.url ? String(req.query.url) : '';
    await remark42.deleteComment(id, url);
    logActivity({ req, action: 'comment.delete', target: id });
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:id/pin', async (req, res) => {
  await pinOrUnpin(req, res, true);
});

router.post('/:id/unpin', async (req, res) => {
  await pinOrUnpin(req, res, false);
});

async function pinOrUnpin(req, res, pinned) {
  const id = String(req.params.id);
  const wm = db().prepare(`SELECT id FROM webmentions WHERE id = ?`).get(id);
  if (wm) return res.status(409).json({ error: 'cannot_pin_webmention' });
  try {
    const url = req.body?.postUrl ? String(req.body.postUrl) : '';
    let postUrl = url;
    if (!postUrl) {
      const parent = await remark42.getComment(id);
      if (!parent) return res.status(404).json({ error: 'not_found' });
      postUrl = parent.postUrl;
    }
    await remark42.pinComment(id, postUrl, pinned);
    logActivity({ req, action: pinned ? 'comment.pin' : 'comment.unpin', target: id });
    res.json({ id, pinned });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

router.post('/:id/spam', async (req, res) => {
  const id = String(req.params.id);

  // Webmention path: just flip to rejected.
  const wm = db().prepare(`SELECT id, source FROM webmentions WHERE id = ?`).get(id);
  if (wm) {
    db().prepare(`UPDATE webmentions SET status = 'rejected' WHERE id = ?`).run(id);
    logActivity({ req, action: 'webmention.spam', target: id });
    return res.json({ id, source: 'webmention', spam: true });
  }

  // Remark42 path: delete the comment + block the author.
  try {
    const url = req.body?.postUrl ? String(req.body.postUrl) : '';
    let postUrl = url;
    let userId = req.body?.userId ? String(req.body.userId) : '';
    let userName = req.body?.userName ? String(req.body.userName) : null;
    if (!postUrl || !userId) {
      const parent = await remark42.getComment(id);
      if (!parent) return res.status(404).json({ error: 'not_found' });
      postUrl = postUrl || parent.postUrl;
      userId = userId || parent.author.id;
      userName = userName || parent.author.name;
    }
    await remark42.markSpam({ id, userId, postUrl, ttl: '8760h' });

    // Mirror the block locally so the block-list view reflects it.
    const siteFilter = process.env.REMARK42_SITE_ID || 'terminaleighty';
    try {
      db()
        .prepare(
          `INSERT OR REPLACE INTO blocks
              (id, site_id, user_id, user_name, reason, ttl_ms, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nanoid(),
          siteFilter,
          userId,
          userName,
          'auto: marked spam',
          null,
          Date.now(),
          req.user?.username || 'system',
        );
    } catch (_) {
      /* the unique index conflict means we already had them; fine */
    }
    logActivity({ req, action: 'comment.spam', target: id, meta: { userId, postUrl } });
    res.json({ id, source: 'remark42', spam: true, userId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── test seam ────────────────────────────────────────────────────────

export const __test = {
  resetDb() {
    if (dbHandle) {
      try {
        dbHandle.close();
      } catch (_) {
        /* ignore */
      }
    }
    dbHandle = null;
    postCache = null;
  },
  postFor,
  normaliseRemarkComment,
  normaliseWebmention,
};

export default router;
