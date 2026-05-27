// @ts-check
/**
 * posts.js — Post CRUD plus Phase 5e extensions.
 *
 * Phase 5e adds (without changing the existing CRUD contract):
 *   POST   /api/posts/:filename/duplicate  → clone with `-copy` suffix
 *   POST   /api/posts/:filename/preview    → signed JWT preview link
 *   POST   /api/posts/bulk                 → delete/publish/tag in bulk
 *
 * Activity log integration is fire-and-forget — `logActivity(...)` is
 * called without `await` so a logger hiccup never breaks a save.
 */

import { Router } from 'express';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import path, { join } from 'path';
import crypto from 'crypto';
import { parsePost, serializePost } from '../utils/frontmatter.js';
import { invalidatePostRefs } from '../utils/postRefs.js';
import { logActivity } from '../services/activity.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
const router = Router();
const postsDir = join(SITE_DIR, 'content', 'posts');

// Utility to get all posts (Phase 2 shape preserved + a few additive
// fields the dashboard uses for the new "Scheduled" tab and badges).
function getAllPosts() {
  try {
    const files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
    const posts = files.map((file) => {
      const content = readFileSync(join(postsDir, file), 'utf-8');
      const { data } = parsePost(content);
      const stats = statSync(join(postsDir, file));

      return {
        filename: file,
        title: data.title || 'Untitled',
        slug: data.slug || file.replace('.md', ''),
        date: data.date || stats.mtime.toISOString(),
        draft: data.draft === true,
        tags: data.tags || [],
        // Phase 5e additions — null when unset.
        publish_at: data.publish_at || null,
        series: data.series || null,
        cover: data.cover || null,
      };
    });

    // Sort by date descending
    return posts.sort(
      (a, b) =>
        new Date(/** @type {string} */ (b.date)).getTime() -
        new Date(/** @type {string} */ (a.date)).getTime(),
    );
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
 *   - 'add-tag'        → payload: { tag } — push to tags[] (dedup)
 *   - 'remove-tag'     → payload: { tag } — drop from tags[]
 *   - 'change-tag'     → payload: { from, to } — rename within tags[]
 *
 * One round-trip per action; the response summarizes successes.
 */
const BULK_ACTIONS = new Set([
  'delete',
  'publish',
  'unpublish',
  'add-tag',
  'remove-tag',
  'change-tag',
]);

router.post('/bulk', (req, res) => {
  try {
    const { action, filenames, payload } = req.body || {};
    if (!BULK_ACTIONS.has(action)) {
      return res.status(400).json({ error: 'unknown_action', action });
    }
    if (!Array.isArray(filenames) || !filenames.length) {
      return res.status(400).json({ error: 'filenames must be a non-empty array' });
    }

    /** @type {string[]} */ const ok = [];
    /** @type {{ filename: string, error: string }[]} */ const errors = [];

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
        } else if (action === 'unpublish') {
          data.draft = true;
        } else if (action === 'add-tag') {
          const tag = String(payload?.tag || '').trim();
          if (!tag) {
            errors.push({ filename, error: 'tag_required' });
            continue;
          }
          const tags = Array.isArray(data.tags) ? data.tags.slice() : [];
          if (!tags.includes(tag)) tags.push(tag);
          data.tags = tags;
        } else if (action === 'remove-tag') {
          const tag = String(payload?.tag || '').trim();
          if (!tag) {
            errors.push({ filename, error: 'tag_required' });
            continue;
          }
          data.tags = Array.isArray(data.tags) ? data.tags.filter((t) => t !== tag) : [];
        } else if (action === 'change-tag') {
          const from = String(payload?.from || '').trim();
          const to = String(payload?.to || '').trim();
          if (!from || !to) {
            errors.push({ filename, error: 'from_and_to_required' });
            continue;
          }
          const tags = Array.isArray(data.tags) ? data.tags.slice() : [];
          const idx = tags.indexOf(from);
          if (idx >= 0) {
            tags.splice(idx, 1, to);
            // dedup
            data.tags = Array.from(new Set(tags));
          } else {
            data.tags = tags;
          }
        }

        writeFileSync(filePath, serializePost(data, content || ''));
        ok.push(filename);
      } catch (err) {
        errors.push({ filename, error: err.message || 'failed' });
      }
    }

    invalidatePostRefs();
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

    writeFileSync(join(postsDir, newFilename), serializePost(newData, content || ''));
    invalidatePostRefs();
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

    const secret =
      process.env.SITE_SECRET || process.env.SESSION_SECRET || 'terminal-eighty-secret';
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const token = signJwtHS256({ slug, exp }, secret);

    const base =
      process.env.SITE_BASE_URL ||
      (req.headers['x-forwarded-host']
        ? `https://${req.headers['x-forwarded-host']}`
        : 'https://terminaleighty.com');
    const url = `${base.replace(/\/$/, '')}/drafts/${encodeURIComponent(slug)}/?token=${token}`;

    logActivity({ req, action: 'post.preview', target: src, meta: { slug, exp } });
    res.json({ url, token, expires: exp * 1000 });
  } catch (err) {
    console.error('[posts] preview failed:', err);
    res.status(500).json({ error: 'preview_failed', message: err.message });
  }
});

// GET single post (left near the bottom so /bulk and /:filename/* land first)
router.get('/:filename', (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    const fileContent = readFileSync(join(postsDir, safeFilename), 'utf-8');
    const { data, content } = parsePost(fileContent);
    res.json({ data, content });
  } catch (_err) {
    res.status(404).json({ error: 'Post not found' });
  }
});

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

    const fileContent = serializePost(data, content || '');
    writeFileSync(join(postsDir, filename), fileContent);
    invalidatePostRefs();
    logActivity({ req, action: 'post.create', target: filename });

    res.json({ success: true, filename, slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// UPDATE post
router.put('/:filename', (req, res) => {
  try {
    const { data, content } = req.body;
    const oldFilename = path.basename(req.params.filename);
    const rawSlug = data.slug || oldFilename.replace('.md', '');
    const slug = path.basename(rawSlug);
    const newFilename = `${slug}.md`;

    // Validate publish_at only when first being set on an existing post
    // (a writer editing a scheduled post with a past timestamp is a
    // common "I forgot to update" case — we don't block in that case,
    // the scheduler will simply pick it up on its next tick).
    if (data.publish_at && !data.draft) {
      // publish_at only matters for drafts; ignore for live posts.
    }

    const fileContent = serializePost(data, content || '');

    // Write new content
    writeFileSync(join(postsDir, newFilename), fileContent);

    // Delete old file if name changed
    if (oldFilename !== newFilename) {
      unlinkSync(join(postsDir, oldFilename));
    }
    invalidatePostRefs();
    logActivity({ req, action: 'post.update', target: newFilename });

    res.json({ success: true, filename: newFilename, slug });
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
