// @ts-check
/**
 * posts.js — Post CRUD plus Phase 5e extensions.
 *
 * Phase 5e adds (without changing the existing CRUD contract):
 *   POST   /api/posts/:filename/duplicate  → clone with `-copy` suffix
 *   POST   /api/posts/:filename/preview    → signed JWT preview link
 *   POST   /api/posts/bulk                 → delete/publish in bulk
 *
 * Activity log integration is fire-and-forget — `logActivity(...)` is
 * called without `await` so a logger hiccup never breaks a save.
 */

import { Router } from 'express';
import { readdirSync, readFileSync, unlinkSync, statSync } from 'fs';
import path, { join } from 'path';
import crypto from 'crypto';
import { parsePost, serializePost, validateForPublish } from '../utils/frontmatter.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { invalidatePostRefs } from '../utils/postRefs.js';
import { logActivity } from '../services/activity.js';
import { getPostHistory, getPostAtCommit } from '../utils/git.js';
import {
  recordSnapshot,
  listSnapshots,
  getSnapshot,
  renameSnapshots,
} from '../services/snapshots.js';
import { readRedirects, writeRedirects, upsertRedirect } from '../services/redirects-store.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
const router = Router();
const postsDir = join(SITE_DIR, 'content', 'posts');

// Short-lived cache for the list scan. Opening the admin fires GET
// /api/posts a few times in a burst (dashboard, drafts widget, sidebar
// badge); a 10s TTL collapses those into one directory scan. Mutations
// invalidate it immediately (invalidatePostsCache); the TTL is the
// safety net for out-of-band writes (the scheduler promoting a draft).
/** @type {{ at: number, list: any[] } | null} */
let postsListCache = null;
const POSTS_LIST_TTL_MS = 10_000;

function invalidatePostsCache() {
  postsListCache = null;
}

// Utility to get all posts (Phase 2 shape preserved + a few additive
// fields the dashboard uses for the new "Scheduled" tab and badges).
function getAllPosts() {
  if (postsListCache && Date.now() - postsListCache.at < POSTS_LIST_TTL_MS) {
    return postsListCache.list;
  }
  try {
    const files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
    const posts = files.map((file) => {
      const content = readFileSync(join(postsDir, file), 'utf-8');
      const { data, content: body } = parsePost(content);
      const stats = statSync(join(postsDir, file));

      return {
        filename: file,
        title: data.title || 'Untitled',
        slug: data.slug || file.replace('.md', ''),
        date: data.date || stats.mtime.toISOString(),
        draft: data.draft === true,
        // Phase 5e additions — null when unset.
        publish_at: data.publish_at || null,
        series: data.series || null,
        cover: data.cover || null,
        // v2 Overview additions — drafts list shows real progress.
        word_count: String(body || '')
          .split(/\s+/)
          .filter(Boolean).length,
        modified: stats.mtime.toISOString(),
      };
    });

    // Sort by date descending
    posts.sort(
      (a, b) =>
        new Date(/** @type {string} */ (b.date)).getTime() -
        new Date(/** @type {string} */ (a.date)).getTime(),
    );
    postsListCache = { at: Date.now(), list: posts };
    return posts;
  } catch (err) {
    console.error('Error reading posts directory:', err);
    return [];
  }
}

// ── CRUD (Phase 2 contract; unchanged shapes) ──────────────────────

// GET all posts
router.get('/', (req, res) => {
  res.json(getAllPosts());
});

// Bulk operations + new-only routes are mounted BEFORE the
// `:filename` catch-alls so Express doesn't route `/bulk` into the
// per-file handler.

/**
 * POST /api/posts/bulk
 *
 * Body: `{ action, filenames, payload? }` where `action` is one of:
 *   - 'delete'         → remove the files
 *   - 'publish'        → flip draft → false
 *   - 'unpublish'      → flip draft → true
 *
 * One round-trip per action; the response summarizes successes.
 */
const BULK_ACTIONS = new Set(['delete', 'publish', 'unpublish']);

router.post('/bulk', (req, res) => {
  try {
    const { action, filenames, payload } = req.body || {};
    if (!BULK_ACTIONS.has(action)) {
      return res.status(400).json({ error: 'unknown_action', action });
    }
    if (!Array.isArray(filenames) || !filenames.length) {
      return res.status(400).json({ error: 'filenames must be a non-empty array' });
    }
    // Cap the batch: each item does synchronous file I/O + parsing, so a huge
    // array would block the event loop. 200 is far above any real bulk action.
    if (filenames.length > 200) {
      return res
        .status(400)
        .json({ error: 'batch_too_large', message: 'Maximum 200 items per bulk operation.' });
    }

    /** @type {string[]} */ const ok = [];
    /** @type {Array<{ filename: string, error: string, details?: unknown }>} */ const errors = [];

    for (const raw of filenames) {
      const filename = path.basename(String(raw || ''));
      const filePath = join(postsDir, filename);
      try {
        statSync(filePath);
      } catch {
        errors.push({ filename, error: 'not_found' });
        continue;
      }

      try {
        if (action === 'delete') {
          unlinkSync(filePath);
          ok.push(filename);
          continue;
        }

        // All other actions edit front-matter in place.
        const src = readFileSync(filePath, 'utf-8');
        const { data, content } = parsePost(src);

        if (action === 'publish') {
          data.draft = false;
          // Validate against the shared schema before flipping live.
          const check = validateForPublish(data);
          if (!check.ok) {
            errors.push({
              filename,
              error: 'schema_validation_failed',
              details: check.errors,
            });
            continue;
          }
        } else if (action === 'unpublish') {
          data.draft = true;
        }

        writeFileAtomic(filePath, serializePost(data, content || ''));
        ok.push(filename);
      } catch (err) {
        errors.push({ filename, error: err.message || 'failed' });
      }
    }

    invalidatePostRefs();
    invalidatePostsCache();
    logActivity({
      req,
      action: 'post.bulk',
      target: action,
      meta: { count: ok.length, errors: errors.length, payload },
    });

    res.json({ action, ok, errors });
  } catch (err) {
    console.error('[posts] bulk failed:', err);
    res.status(500).json({ error: 'bulk_failed', message: err.message });
  }
});

/**
 * POST /api/posts/:filename/duplicate
 *
 * Reads the source file, clones it with a `-copy` (or `-copy-N`)
 * suffixed slug, sets `draft: true`, drops `publish_at`, and writes
 * the new file. Returns the new filename.
 */
router.post('/:filename/duplicate', (req, res) => {
  try {
    const src = path.basename(req.params.filename);
    const srcPath = join(postsDir, src);
    const raw = readFileSync(srcPath, 'utf-8');
    const { data, content } = parsePost(raw);

    const baseSlug = String(data.slug || src.replace(/\.md$/, ''));
    const suffix = 'copy';
    let candidate = `${baseSlug}-${suffix}`;
    let i = 1;
    while (true) {
      try {
        statSync(join(postsDir, `${candidate}.md`));
      } catch {
        break;
      }
      i += 1;
      candidate = `${baseSlug}-copy-${i}`;
    }

    const newSlug = candidate;
    const newFilename = `${newSlug}.md`;
    const newData = { ...data };
    newData.slug = newSlug;
    newData.title = `${data.title || baseSlug} (copy)`;
    newData.draft = true;
    delete newData.publish_at;
    newData.date = new Date().toISOString();

    writeFileAtomic(join(postsDir, newFilename), serializePost(newData, content || ''));
    invalidatePostRefs();
    invalidatePostsCache();
    logActivity({ req, action: 'post.duplicate', target: newFilename, meta: { from: src } });

    res.json({ success: true, filename: newFilename, slug: newSlug });
  } catch (err) {
    console.error('[posts] duplicate failed:', err);
    res.status(500).json({ error: 'duplicate_failed', message: err.message });
  }
});

/**
 * POST /api/posts/:filename/preview
 *
 * Returns a 7-day signed JWT URL to view the draft. Token payload is
 * `{ slug, exp }` signed HMAC-SHA256 with `SITE_SECRET`.
 *
 * Hugo's draft build emits `/drafts/<slug>/index.html`; verification of
 * the token happens server-side by a small Caddy/Worker layer (out of
 * scope for this phase — see CONTRIBUTING). The admin returns the
 * generated URL so the writer can share or open it directly.
 *
 * Design choice (recorded for posterity): plain HMAC + JWT, not ed25519
 * or a Cloudflare Worker dance. Reason: the Pi already holds the secret,
 * the admin is the only generator, and verification can be added later
 * by any stateless reverse proxy that shares the env var. Cloudflare
 * Worker support is a Phase 11+ followup if/when we move drafts behind
 * the CDN edge.
 */
router.post('/:filename/preview', (req, res) => {
  try {
    const src = path.basename(req.params.filename);
    const raw = readFileSync(join(postsDir, src), 'utf-8');
    const { data } = parsePost(raw);
    const slug = String(data.slug || src.replace(/\.md$/, ''));

    const secret = process.env.SITE_SECRET || process.env.SESSION_SECRET || 'web-world-wide-secret';
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const token = signJwtHS256({ slug, exp }, secret);

    const base =
      process.env.SITE_BASE_URL ||
      (req.headers['x-forwarded-host']
        ? `https://${req.headers['x-forwarded-host']}`
        : 'https://webworldwide.online');
    const url = `${base.replace(/\/$/, '')}/drafts/${encodeURIComponent(slug)}/?token=${token}`;

    logActivity({ req, action: 'post.preview', target: src, meta: { slug, exp } });
    res.json({ url, token, expires: exp * 1000 });
  } catch (err) {
    console.error('[posts] preview failed:', err);
    res.status(500).json({ error: 'preview_failed', message: err.message });
  }
});

/**
 * GET /api/posts/:filename/history
 *
 * Revision history for the editor's History panel: published versions
 * from git (newest first) plus recent local pre-save snapshots (covers
 * drafts). Both are restorable via the version endpoint below.
 */
router.get('/:filename/history', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const [git, snapshots] = await Promise.all([
      getPostHistory(filename),
      Promise.resolve(listSnapshots(filename)),
    ]);
    res.json({ git, snapshots });
  } catch (err) {
    console.error('[posts] history failed:', err);
    res.status(500).json({ error: 'history_failed', message: err.message });
  }
});

/**
 * GET /api/posts/:filename/version/:source/:ref
 *
 * The full {data, content} of a historical version — `source` is `git`
 * (ref = commit hash) or `snapshot` (ref = snapshot id). The editor loads
 * the result as unsaved changes so a restore is always reviewed before it
 * becomes current (never a silent server-side overwrite).
 */
router.get('/:filename/version/:source/:ref', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const { source, ref } = req.params;
    if (source === 'git') {
      const raw = await getPostAtCommit(filename, ref);
      if (raw === null) return res.status(404).json({ error: 'version_not_found' });
      const { data, content } = parsePost(raw);
      return res.json({ data, content, source, ref });
    }
    if (source === 'snapshot') {
      const snap = getSnapshot(ref);
      if (!snap) return res.status(404).json({ error: 'version_not_found' });
      return res.json({ data: snap.data, content: snap.content, source, ref, ts: snap.ts });
    }
    return res.status(400).json({ error: 'unknown_source' });
  } catch (err) {
    console.error('[posts] version fetch failed:', err);
    res.status(500).json({ error: 'version_failed', message: err.message });
  }
});

// GET single post (left near the bottom so /bulk and /:filename/* land first)
router.get('/:filename', (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    const filePath = join(postsDir, safeFilename);
    const fileContent = readFileSync(filePath, 'utf-8');
    const { data, content } = parsePost(fileContent);
    // `mtime` is the optimistic-concurrency token: the editor sends it
    // back on save so the server can refuse to clobber a newer copy
    // written by another tab/device/the scheduler in the meantime.
    const mtime = statSync(filePath).mtimeMs;
    res.json({ data, content, mtime });
  } catch (_err) {
    res.status(404).json({ error: 'Post not found' });
  }
});

/**
 * Rewrite internal links `/blog/<oldSlug>` → `/blog/<newSlug>` in a blob of
 * text. Only whole path-segment matches are rewritten (a delimiter must
 * follow), so `/blog/foo` never clobbers `/blog/foobar`.
 *
 * @param {string} text
 * @param {string} oldSlug
 * @param {string} newSlug
 * @returns {{ out: string, count: number }}
 */
function rewriteSlugLinks(text, oldSlug, newSlug) {
  const esc = oldSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`/blog/${esc}(?=[/"')\\s#?]|$)`, 'g');
  let count = 0;
  const out = text.replace(re, () => {
    count += 1;
    return `/blog/${newSlug}`;
  });
  return { out, count };
}

/**
 * Recursively rewrite every internal link pointing at the old slug across
 * all posts + site.toml, so a rename never leaves a dangling cross-link.
 *
 * @param {string} oldSlug
 * @param {string} newSlug
 * @returns {number} total links rewritten
 */
function rewriteSlugLinksEverywhere(oldSlug, newSlug) {
  let total = 0;
  for (const file of readdirSync(postsDir).filter((f) => f.endsWith('.md'))) {
    const p = join(postsDir, file);
    let text;
    try {
      text = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    const { out, count } = rewriteSlugLinks(text, oldSlug, newSlug);
    if (count > 0) {
      writeFileAtomic(p, out);
      total += count;
    }
  }
  try {
    const tomlPath = join(SITE_DIR, 'site.toml');
    const text = readFileSync(tomlPath, 'utf-8');
    const { out, count } = rewriteSlugLinks(text, oldSlug, newSlug);
    if (count > 0) {
      writeFileAtomic(tomlPath, out);
      total += count;
    }
  } catch {
    /* no site.toml / unreadable — skip */
  }
  return total;
}

/**
 * Side effects of a post slug rename: add redirects so the old public URL
 * never 404s, and rewrite internal links to the new slug. Best-effort —
 * a failure here is logged but never fails the save (the file rename has
 * already succeeded on disk).
 *
 * @param {string} oldSlug
 * @param {string} newSlug
 * @returns {{ redirected: Array<{from:string,to:string}>, linksUpdated: number }}
 */
function applySlugRename(oldSlug, newSlug) {
  const report = {
    redirected: /** @type {Array<{from:string,to:string}>} */ ([]),
    linksUpdated: 0,
  };
  try {
    const rows = readRedirects();
    // Canonical /blog/<slug>/ plus the legacy bare /<slug>/ form
    // (astro.config.mjs only auto-redirects bare URLs for CURRENT posts,
    // so the old one needs an explicit entry once the slug moves).
    const a = upsertRedirect(rows, `/blog/${oldSlug}/`, `/blog/${newSlug}/`);
    const b = upsertRedirect(rows, `/${oldSlug}/`, `/blog/${newSlug}/`);
    writeRedirects(rows);
    if (a) report.redirected.push(a);
    if (b) report.redirected.push(b);
  } catch (err) {
    console.warn('[posts] rename redirect failed:', err instanceof Error ? err.message : err);
  }
  try {
    report.linksUpdated = rewriteSlugLinksEverywhere(oldSlug, newSlug);
  } catch (err) {
    console.warn('[posts] rename link rewrite failed:', err instanceof Error ? err.message : err);
  }
  return report;
}

// CREATE post
router.post('/', (req, res) => {
  try {
    const { data, content } = req.body;
    if (!data || !data.title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const rawSlug =
      data.slug ||
      data.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '');
    const slug = path.basename(rawSlug);
    const filename = `${slug}.md`;

    // Check if exists
    try {
      statSync(join(postsDir, filename));
      return res.status(400).json({ error: 'A post with this slug already exists' });
    } catch {
      /* Doesn't exist, good */
    }

    data.slug = slug;
    if (!data.date) data.date = new Date().toISOString();

    // Phase 5e: if publish_at is set, validate it's in the future.
    if (data.publish_at) {
      const ts = new Date(data.publish_at).getTime();
      if (Number.isNaN(ts) || ts <= Date.now()) {
        return res.status(400).json({ error: 'publish_at must be a future ISO timestamp' });
      }
    }

    // Single-source-of-truth schema check (shared with Astro build).
    // Drafts pass unconditionally; non-drafts must satisfy the Zod schema
    // so a publish never lands a post that the next CI build would reject.
    const check = validateForPublish(data);
    if (!check.ok) {
      return res.status(400).json({ error: 'schema_validation_failed', errors: check.errors });
    }

    const fileContent = serializePost(data, content || '');
    const createPath = join(postsDir, filename);
    writeFileAtomic(createPath, fileContent);
    invalidatePostRefs();
    invalidatePostsCache();
    logActivity({ req, action: 'post.create', target: filename });

    res.json({ success: true, filename, slug, mtime: statSync(createPath).mtimeMs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// UPDATE post
router.put('/:filename', (req, res) => {
  try {
    const { data, content, baseMtime } = req.body;
    const oldFilename = path.basename(req.params.filename);
    const rawSlug = data.slug || oldFilename.replace('.md', '');
    const slug = path.basename(rawSlug);
    const newFilename = `${slug}.md`;
    const oldPath = join(postsDir, oldFilename);
    const newPath = join(postsDir, newFilename);

    // Optimistic concurrency: if the client tells us which version it
    // loaded (`baseMtime`), refuse to overwrite a copy that changed on
    // disk since — another tab/device, or the scheduler flipping a
    // scheduled draft live. Without it we'd silently clobber their work.
    if (typeof baseMtime === 'number') {
      try {
        const current = statSync(oldPath).mtimeMs;
        // 1ms slack for filesystem mtime granularity.
        if (current > baseMtime + 1) {
          return res.status(409).json({
            error: 'conflict',
            message:
              'This post changed since you opened it (another tab, device, or the scheduler). Reload to get the latest before saving.',
            currentMtime: current,
          });
        }
      } catch {
        // The client loaded this post (it sent a baseMtime) but the file is
        // gone now — deleted or renamed by another tab/device/the scheduler.
        // Recreating it would silently resurrect a deleted post, so treat a
        // missing-but-expected file as a conflict, not a fresh create.
        return res.status(409).json({
          error: 'conflict',
          message:
            'This post no longer exists (it was deleted or renamed elsewhere). Reload before saving.',
        });
      }
    }

    // A slug rename must NEVER clobber a different existing post. CREATE
    // guards this; UPDATE must too, or renaming post A's slug onto B's
    // would destroy B.
    if (newFilename !== oldFilename) {
      try {
        statSync(newPath);
        return res.status(409).json({
          error: 'slug_taken',
          message: `A different post already uses the slug "${slug}". Choose another.`,
        });
      } catch {
        /* target free — good */
      }
    }

    // Validate publish_at on update too (create already does). We reject a
    // malformed timestamp but NOT a past one: an existing post's scheduled
    // time may legitimately have already passed, and editing it shouldn't be
    // blocked just because that moment is now behind us.
    if (data.publish_at && Number.isNaN(new Date(data.publish_at).getTime())) {
      return res.status(400).json({ error: 'publish_at must be a valid ISO timestamp' });
    }

    // Single-source-of-truth schema check (shared with Astro build).
    // Drafts pass unconditionally; non-drafts must satisfy the Zod schema.
    const check = validateForPublish(data);
    if (!check.ok) {
      return res.status(400).json({ error: 'schema_validation_failed', errors: check.errors });
    }

    const fileContent = serializePost(data, content || '');

    // Snapshot the PREVIOUS on-disk content before we overwrite it, so the
    // History panel can roll back recent saves (covers drafts too). Best
    // effort — never block a save on the safety net.
    try {
      const prev = readFileSync(oldPath, 'utf-8');
      const parsedPrev = parsePost(prev);
      const prevData = /** @type {Record<string, unknown>} */ (parsedPrev.data || {});
      recordSnapshot(oldFilename, {
        title: typeof prevData.title === 'string' ? prevData.title : undefined,
        data: prevData,
        content: parsedPrev.content,
      });
    } catch {
      /* first save / unreadable previous — nothing to snapshot */
    }

    // Write new content atomically (temp + rename), then drop the old
    // file if the slug changed.
    writeFileAtomic(newPath, fileContent);
    let rename = null;
    if (oldFilename !== newFilename) {
      unlinkSync(oldPath);
      // The post's identity moved to newFilename — carry its snapshot
      // history along so the renamed post keeps its revisions.
      renameSnapshots(oldFilename, newFilename);
      // Auto-redirect the old URL + rewrite internal links so the public
      // slug change never 404s. (Best-effort; never fails the save.)
      rename = applySlugRename(oldFilename.replace(/\.md$/, ''), slug);
      logActivity({
        req,
        action: 'post.rename',
        target: newFilename,
        meta: {
          from: oldFilename,
          redirected: rename.redirected.length,
          links: rename.linksUpdated,
        },
      });
    }
    invalidatePostRefs();
    invalidatePostsCache();
    logActivity({ req, action: 'post.update', target: newFilename });

    res.json({
      success: true,
      filename: newFilename,
      slug,
      mtime: statSync(newPath).mtimeMs,
      rename,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// DELETE post
router.delete('/:filename', (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    unlinkSync(join(postsDir, safeFilename));
    invalidatePostRefs();
    invalidatePostsCache();
    logActivity({ req, action: 'post.delete', target: safeFilename });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Sign a payload as a JWT-HS256 token. Tiny implementation — we don't
 * pull in `jsonwebtoken` because the only place we issue these is here,
 * and the only place we'd verify them is a reverse-proxy layer that
 * lives outside this codebase. Shared secret only.
 *
 * @param {Record<string, any>} payload
 * @param {string} secret
 * @returns {string}
 */
function signJwtHS256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url').replace(/=+$/, '');
  const head = enc(header);
  const body = enc(payload);
  const data = `${head}.${body}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url')
    .replace(/=+$/, '');
  return `${data}.${sig}`;
}

/**
 * Verify a JWT-HS256 token. Returns the parsed payload on success or
 * null on any failure (bad signature, expired, malformed). Exported
 * for tests; a real proxy layer would re-implement this in its own
 * runtime.
 *
 * @param {string} token
 * @param {string} secret
 * @returns {Record<string, any> | null}
 */
export function verifyJwtHS256(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url')
    .replace(/=+$/, '');
  // Constant-time compare
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export default router;
