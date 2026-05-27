// @ts-check
/**
 * remark42.js — Phase 8.5 Remark42 REST client.
 *
 * Wraps the upstream Remark42 HTTP API (https://remark42.com/docs/backend/api/)
 * so the rest of the admin CMS never has to think about it directly.
 *
 * Auth model
 * ----------
 * Remark42 has two distinct flavours of admin auth:
 *
 *   1. A `Bearer` JWT obtained by signing in as the `admin` user.
 *   2. A pre-shared `?secret=…` query param on `/api/v1/admin/*`
 *      endpoints (Remark42 v1.10+ honours both; we pick the latter
 *      because the CMS already has the secret in env and we don't need
 *      to manage a session token round-trip).
 *
 * The admin-side reply / edit / delete operations require we post as an
 * admin-flagged user — Remark42 derives this from the JWT's `aud`/`admin`
 * claims. We mint a short-lived self-signed JWT using the same shared
 * `SECRET` so the upstream accepts our writes as the site admin.
 *
 * Configuration (env vars)
 * ------------------------
 *   REMARK42_URL        — base URL of the Remark42 server.
 *                         Default: `http://localhost:8081` (dev compose).
 *   REMARK42_SECRET     — the SECRET from the Remark42 container env.
 *                         REQUIRED for any admin write; the client refuses
 *                         to construct an admin JWT without it.
 *   REMARK42_SITE_ID    — site identifier configured in Remark42.
 *                         Default: `terminaleighty` (matches docker-compose).
 *   REMARK42_ADMIN_USER — username we publish replies as.
 *                         Default: `admin`.
 *   REMARK42_ADMIN_ID   — user-id used in the JWT `user.id` claim.
 *                         Default: `admin`.
 *
 * The client returns a single shape for every comment, regardless of
 * which Remark42 endpoint produced it. See `normaliseComment` below for
 * the contract.
 *
 * Test seam
 * ---------
 * `setFetchImpl(fn)` swaps the underlying fetch so tests don't actually
 * hit a Remark42 instance.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_URL = 'http://localhost:8081';
const DEFAULT_SITE_ID = 'terminaleighty';
const DEFAULT_ADMIN = 'admin';
const FETCH_TIMEOUT_MS = Number(process.env.REMARK42_FETCH_TIMEOUT_MS || 8000);

/** @type {typeof globalThis.fetch} */
let fetchImpl = (input, init) => globalThis.fetch(input, init);

/**
 * Swap the global fetch used by every call below. Pass `null` to reset
 * back to the platform default.
 *
 * @param {typeof globalThis.fetch | null | undefined} fn
 */
export function setFetchImpl(fn) {
  fetchImpl = fn || ((input, init) => globalThis.fetch(input, init));
}

// ── env / config helpers ─────────────────────────────────────────────

function baseUrl() {
  const raw = process.env.REMARK42_URL || DEFAULT_URL;
  return raw.replace(/\/+$/, '');
}

function siteId() {
  return process.env.REMARK42_SITE_ID || DEFAULT_SITE_ID;
}

function adminId() {
  return process.env.REMARK42_ADMIN_ID || DEFAULT_ADMIN;
}

function adminName() {
  return process.env.REMARK42_ADMIN_USER || DEFAULT_ADMIN;
}

function secret() {
  return process.env.REMARK42_SECRET || '';
}

// ── JWT minting (HS256 — matches Remark42's default signer) ──────────
//
// Remark42 uses HS256 with the same shared SECRET. We sign a small
// claim set with `admin: true` so the upstream accepts our writes.
// Token lifetime is short (5 min) so a leaked log line ages out fast.

const TOKEN_TTL_SEC = 300;

/**
 * @param buf
 * @returns {string}
 */
function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Mint an admin JWT for write operations. Throws if `REMARK42_SECRET`
 * is unset — every admin write needs it.
 *
 * @returns {string} signed JWT
 */
export function adminJwt() {
  const sec = secret();
  if (!sec) {
    throw new Error('REMARK42_SECRET is not set; cannot mint admin JWT');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    user: {
      id: adminId(),
      name: adminName(),
      admin: true,
      site_id: siteId(),
    },
    exp: now + TOKEN_TTL_SEC,
    nbf: now - 10,
    iat: now,
    iss: 'remark42',
    aud: siteId(),
  };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', sec).update(data).digest();
  return `${data}.${base64url(sig)}`;
}

/**
 * Verify a Remark42 JWT (used only by tests to inspect what we minted —
 * the production code path never round-trips). Returns the decoded
 * payload on success, or `null` on any failure.
 *
 * @param {string} token
 * @returns {any|null}
 */
export function verifyJwt(token) {
  try {
    const sec = secret();
    if (!sec) return null;
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const expected = createHmac('sha256', sec).update(`${h}.${p}`).digest();
    const actual = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch {
    return null;
  }
}

// ── shared HTTP helper ───────────────────────────────────────────────

class Remark42Error extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} url
   * @param {any} [body]
   */
  constructor(message, status, url, body) {
    super(message);
    this.name = 'Remark42Error';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export { Remark42Error };

/**
 * @param {string} path
 * @param {{ method?: string, query?: Record<string, string|number|boolean>, body?: any, admin?: boolean, secret?: boolean, accept?: string }} [opts]
 */
async function call(path, opts) {
  const o = opts || {};
  const url = new URL(`${baseUrl()}${path}`);
  if (o.query) {
    for (const [k, v] of Object.entries(o.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  if (o.secret) {
    if (!secret()) {
      throw new Remark42Error('REMARK42_SECRET not set', 500, url.toString());
    }
    url.searchParams.set('secret', secret());
  }
  /** @type {Record<string, string>} */
  const headers = {
    Accept: o.accept || 'application/json',
  };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.admin) headers.Authorization = `Bearer ${adminJwt()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: o.method || 'GET',
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Remark42Error(`upstream unreachable: ${err.message}`, 0, url.toString());
  }
  clearTimeout(timer);

  const ct = res.headers.get('content-type') || '';
  /** @type {any} */
  let payload = null;
  if (ct.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else {
    payload = await res.text().catch(() => '');
  }

  if (!res.ok) {
    const msg = (payload && (payload.error || payload.message)) || `HTTP ${res.status}`;
    throw new Remark42Error(`remark42 ${msg}`, res.status, url.toString(), payload);
  }
  return payload;
}

// ── shape normaliser ─────────────────────────────────────────────────

/**
 * Map an upstream comment record onto the unified shape every consumer
 * in the CMS expects. The raw record is preserved under `raw` so the
 * UI can read provider-specific fields (score, votes…) without us
 * having to enumerate them here.
 *
 * Upstream fields of interest:
 *   id          — comment id (string)
 *   pid         — parent comment id, '' for top-level
 *   text        — sanitised HTML
 *   orig        — original markdown (when available)
 *   time        — ISO-8601 timestamp
 *   user        — { id, name, picture, ip, admin, blocked, verified }
 *   locator     — { site, url } — `url` is the post URL the thread lives on
 *   delete      — `true` if the comment is soft-deleted
 *   pin         — `true` if the comment is pinned
 *   score       — int
 *   votes       — { userId: 1 | -1, … }
 *
 * @param {any} c
 * @returns {{
 *   id: string,
 *   source: 'remark42',
 *   parentId: string | null,
 *   author: { id: string, name: string, avatar: string|null, url: string|null, admin: boolean, blocked: boolean },
 *   postUrl: string,
 *   content: string,
 *   contentMarkdown: string | null,
 *   ts: number,
 *   status: 'visible'|'pinned'|'deleted'|'spam',
 *   score: number,
 *   raw: any,
 * }}
 */
export function normaliseComment(c) {
  const tsMs = c?.time ? new Date(c.time).getTime() : Date.now();
  // Spam in Remark42 is encoded via `user.blocked && delete`; pin is
  // a top-level boolean; deleted is `delete: true`.
  let status = 'visible';
  if (c?.pin === true) status = 'pinned';
  if (c?.delete === true) status = 'deleted';
  if (c?.user?.blocked === true && c?.delete === true) status = 'spam';

  return {
    id: String(c?.id || ''),
    source: 'remark42',
    parentId: c?.pid ? String(c.pid) : null,
    author: {
      id: String(c?.user?.id || ''),
      name: String(c?.user?.name || 'anonymous'),
      avatar: c?.user?.picture || null,
      url: c?.user?.url || null,
      admin: Boolean(c?.user?.admin),
      blocked: Boolean(c?.user?.blocked),
    },
    postUrl: String(c?.locator?.url || ''),
    content: String(c?.text || ''),
    contentMarkdown: c?.orig ? String(c.orig) : null,
    ts: Number.isFinite(tsMs) ? tsMs : Date.now(),
    /** @type {any} */ status,
    score: Number(c?.score || 0),
    raw: c,
  };
}

// ── public methods ───────────────────────────────────────────────────

/**
 * Recent comments across every post, newest first. Wraps
 * `/api/v1/last/N?site=…`.
 *
 * @param {{ max?: number, since?: number }} [opts]
 */
export async function lastComments(opts) {
  const max = Math.max(1, Math.min(500, Number(opts?.max) || 50));
  const query = /** @type {Record<string, string | number>} */ ({ site: siteId() });
  if (opts?.since) query.since = opts.since;
  const data = await call(`/api/v1/last/${max}`, { query });
  const list = Array.isArray(data) ? data : Array.isArray(data?.comments) ? data.comments : [];
  return list.map(normaliseComment);
}

/**
 * One comment by id. Wraps `/api/v1/id/:id?site=…&url=…`. Remark42
 * requires a URL too; the caller should pass it (we read it from the
 * stored row or take it from the API response). For convenience this
 * helper accepts an optional URL hint; if missing we fetch via the
 * find endpoint and search.
 *
 * @param {string} id
 * @param {string} [postUrl]
 */
export async function getComment(id, postUrl) {
  if (!id) throw new Remark42Error('id required', 400, '/api/v1/id');
  if (postUrl) {
    const data = await call(`/api/v1/id/${encodeURIComponent(id)}`, {
      query: { site: siteId(), url: postUrl },
    });
    return data ? normaliseComment(data) : null;
  }
  // Fallback: scan the recent N — Remark42 has no global id lookup
  // without a URL hint.
  const recent = await lastComments({ max: 500 });
  return recent.find((c) => c.id === id) || null;
}

/**
 * Comments belonging to one post URL. Wraps `/api/v1/find?url=…`.
 *
 * @param {string} postUrl
 */
export async function findByPost(postUrl) {
  const data = await call(`/api/v1/find`, {
    query: { site: siteId(), url: postUrl, format: 'tree', sort: 'time' },
  });
  // Remark42 returns a tree when format=tree. Flatten so the admin UI
  // sees one row per comment.
  /** @type {any[]} */
  const flat = [];
  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n?.comment) flat.push(n.comment);
      if (Array.isArray(n?.replies)) walk(n.replies);
    }
  }
  if (Array.isArray(data?.comments)) walk(data.comments);
  else if (Array.isArray(data)) flat.push(...data);
  return flat.map(normaliseComment);
}

/**
 * Post a new reply. Wraps `POST /api/v1/comment` with admin JWT so the
 * comment is published immediately as the site author.
 *
 * @param {{ parentId: string, postUrl: string, text: string }} args
 */
export async function replyComment(args) {
  if (!args?.parentId) throw new Remark42Error('parentId required', 400, '/api/v1/comment');
  if (!args?.postUrl) throw new Remark42Error('postUrl required', 400, '/api/v1/comment');
  if (!args?.text || !String(args.text).trim()) {
    throw new Remark42Error('text required', 400, '/api/v1/comment');
  }
  const body = {
    text: String(args.text),
    pid: args.parentId,
    locator: { site: siteId(), url: args.postUrl },
  };
  const data = await call(`/api/v1/comment`, { method: 'POST', body, admin: true });
  return data ? normaliseComment(data) : null;
}

/**
 * Edit an existing comment. Wraps `PUT /api/v1/comment/:id`.
 * Remark42 enforces an edit window (`EDIT_TIME`) for regular users; admins
 * can edit anytime.
 *
 * @param {string} id
 * @param {string} postUrl
 * @param {string} text
 */
export async function editComment(id, postUrl, text) {
  if (!id) throw new Remark42Error('id required', 400, '/api/v1/comment');
  const body = { text: String(text || ''), summary: 'edited by admin' };
  const data = await call(`/api/v1/comment/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body,
    admin: true,
    query: { url: postUrl, site: siteId() },
  });
  return data ? normaliseComment(data) : null;
}

/**
 * Soft-delete a comment. Wraps the admin endpoint
 * `DELETE /api/v1/admin/comment/:id?site=…&url=…`.
 *
 * @param {string} id
 * @param {string} postUrl
 */
export async function deleteComment(id, postUrl) {
  if (!id) throw new Remark42Error('id required', 400, '/api/v1/admin/comment');
  await call(`/api/v1/admin/comment/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    secret: true,
    query: { site: siteId(), url: postUrl || '' },
  });
  return { id, deleted: true };
}

/**
 * Pin or unpin. Wraps `PUT /api/v1/admin/pin/:id?pin=1|0&site=…&url=…`.
 *
 * @param {string} id
 * @param {string} postUrl
 * @param {boolean} pinned
 */
export async function pinComment(id, postUrl, pinned) {
  if (!id) throw new Remark42Error('id required', 400, '/api/v1/admin/pin');
  await call(`/api/v1/admin/pin/${encodeURIComponent(id)}`, {
    method: 'PUT',
    secret: true,
    query: { pin: pinned ? 1 : 0, site: siteId(), url: postUrl || '' },
  });
  return { id, pinned };
}

/**
 * Block / unblock a user. Wraps:
 *   PUT  /api/v1/admin/user/:userID?block=1&ttl=…
 *   PUT  /api/v1/admin/user/:userID?block=0
 *
 * `ttl` is a Go duration string ('24h', '7d', ''). Empty string ⇒
 * permanent.
 *
 * @param {string} userId
 * @param {{ block?: boolean, ttl?: string }} [opts]
 */
export async function blockUser(userId, opts) {
  if (!userId) throw new Remark42Error('userId required', 400, '/api/v1/admin/user');
  const block = opts?.block !== false; // default true
  /** @type {Record<string, string|number>} */
  const query = { block: block ? 1 : 0, site: siteId() };
  if (block && opts?.ttl) query.ttl = opts.ttl;
  await call(`/api/v1/admin/user/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    secret: true,
    query,
  });
  return { userId, blocked: block };
}

/**
 * List blocked users (Remark42's view). Wraps `GET /api/v1/admin/blocked`.
 */
export async function listBlockedUsers() {
  const data = await call(`/api/v1/admin/blocked`, {
    secret: true,
    query: { site: siteId() },
  });
  if (!Array.isArray(data)) return [];
  return data.map((u) => ({
    userId: String(u?.id || u?.user || ''),
    name: u?.name || null,
    until: u?.time ? new Date(u.time).getTime() : null,
    raw: u,
  }));
}

/**
 * Mark a comment as spam. Remark42 doesn't have a "spam" status per se —
 * the convention is: soft-delete the comment + block the user. The
 * unified API exposes this as one call so callers don't have to issue
 * both.
 *
 * @param {{ id: string, userId: string, postUrl: string, ttl?: string }} args
 */
export async function markSpam(args) {
  await deleteComment(args.id, args.postUrl);
  if (args.userId) {
    await blockUser(args.userId, { block: true, ttl: args.ttl || '8760h' /* 1y */ });
  }
  return { id: args.id, userId: args.userId, spam: true };
}

/**
 * Convenience wrapper around the comment "verify" toggle. Remark42
 * uses `verified` as a visible "trusted" badge rather than a spam
 * marker; we expose it here in case future workflows want it.
 *
 * @param {string} userId
 * @param {boolean} verified
 */
export async function verifyUser(userId, verified) {
  if (!userId) throw new Remark42Error('userId required', 400, '/api/v1/admin/verify');
  await call(`/api/v1/admin/verify/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    secret: true,
    query: { verified: verified ? 1 : 0, site: siteId() },
  });
  return { userId, verified };
}

/**
 * Cheap health check — `GET /ping`. Returns true on 2xx.
 */
export async function ping() {
  try {
    await call('/ping', { accept: 'text/plain' });
    return true;
  } catch {
    return false;
  }
}

export const __test = {
  resetFetch() {
    fetchImpl = (input, init) => globalThis.fetch(input, init);
  },
};

export default {
  setFetchImpl,
  adminJwt,
  verifyJwt,
  normaliseComment,
  lastComments,
  getComment,
  findByPost,
  replyComment,
  editComment,
  deleteComment,
  pinComment,
  blockUser,
  listBlockedUsers,
  markSpam,
  verifyUser,
  ping,
  Remark42Error,
};
