// @ts-check
/**
 * posts.js — Post CRUD plus Phase 5e extensions.
 *
 * Phase 5e adds (without changing the existing CRUD contract):
 *   POST   /api/posts/:filename/duplicate  → clone with `-copy` suffix
 *   POST   /api/posts/bulk                 → delete/publish in bulk
 *
 * Activity log integration is fire-and-forget — `logActivity(...)` is
 * called without `await` so a logger hiccup never breaks a save.
 */

import * as remark42 from '../services/remark42.js';
import { trashPost, listTrash, getTrashed, removeTrashed, TRASH_DAYS } from '../services/trash.js';
import { Router } from 'express';
import { readdirSync, readFileSync, unlinkSync, statSync, existsSync } from 'fs';
import path, { join } from 'path';
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

/** Front-matter keys the post editor owns (absent = cleared by the author). */
const EDITOR_MANAGED_KEYS = new Set([
  'title',
  'slug',
  'draft',
  'date',
  'excerpt',
  'publish_at',
  'cover',
  'cover_alt',
]);

/**
 * Make draft/publish_at consistent:
 *  - a FUTURE publish_at means "scheduled": the post stays a draft until the
 *    scheduler promotes it (otherwise the build hides it while syndication
 *    announces a 404 immediately);
 *  - a PAST publish_at is spent: drop it, or flipping the post back to draft
 *    later would get it silently re-published by the scheduler.
 *
 * @param {Record<string, any>} data
 */
function normalizeSchedule(data) {
  if (!data.publish_at) return;
  const ts = new Date(data.publish_at).getTime();
  if (Number.isNaN(ts)) return;
  if (ts > Date.now()) data.draft = true;
  else delete data.publish_at;
}
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

/**
 * Canonical slug: lowercase, non-alphanumerics → hyphens, ends trimmed.
 * Mirrors the client's slugify (editor.js) so the on-disk filename and the
 * public URL are always safe even if a client posts a raw value like
 * "Hello World!". `path.basename` still guards traversal at the call site.
 *
 * @param {string} s
 * @returns {string}
 */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

/**
 * First-paragraph excerpt, matching the public site's deriveExcerpt()
 * (site/src/lib/post-utils.ts) so the homepage preview shows the same text.
 *
 * @param {string} body
 * @returns {string}
 */
export function deriveExcerpt(body: string): string {
  const cleaned = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .trim();
  const para = (cleaned.split(/\n\n+/).find((p) => p.trim()) ?? '').replace(/\s+/g, ' ').trim();
  if (!para) return '';
  const LIMIT = 180;
  if (para.length <= LIMIT) return para;
  const head = para.slice(0, LIMIT);
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
  );
  if (sentenceEnd >= 80) return head.slice(0, sentenceEnd + 1);
  const wordEnd = head.lastIndexOf(' ');
  return (wordEnd > 0 ? head.slice(0, wordEnd) : head).trimEnd() + '…';
}

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
        publish_at: data.publish_at || null,
        series: data.series || null,
        cover: data.cover || null,
        excerpt:
          typeof data.excerpt === 'string' && data.excerpt ? data.excerpt : deriveExcerpt(body),
        word_count: String(body || '')
          .split(/\s+/)
          .filter(Boolean).length,
        modified: stats.mtime.toISOString(),
      };
    });

    posts.sort(
      (a, b) =>
        new Date(/** @type {string} */ b.date).getTime() -
        new Date(/** @type {string} */ a.date).getTime(),
    );
    postsListCache = { at: Date.now(), list: posts };
    return posts;
  } catch (err) {
    console.error('Error reading posts directory:', err);
    return [];
  }
}

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
          moveToTrash(req, filename, filePath);
          ok.push(filename);
          continue;
        }

        const src = readFileSync(filePath, 'utf-8');
        const { data, content } = parsePost(src);

        if (action === 'publish') {
          data.draft = false;
          // Publishing now supersedes any pending schedule.
          delete data.publish_at;
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
          // A leftover past publish_at would make the scheduler re-publish
          // this post on its next 5-minute tick.
          delete data.publish_at;
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

    // Sanitize like CREATE/UPDATE — the source frontmatter `slug` can carry
    // path separators/traversal (e.g. from a git pull or external edit), and it
    // flows straight into the write path. Never let a clone escape postsDir.
    const baseSlug = path.basename(slugify(String(data.slug || src.replace(/\.md$/, ''))));
    if (!baseSlug) {
      return res
        .status(400)
        .json({ error: 'invalid_slug', message: 'Source post has no usable slug to duplicate.' });
    }
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
 * @returns {{ redirected: Array<{from:string,to:string}>, linksUpdated: number, warnings: string[] }}
 */
function applySlugRename(oldSlug, newSlug) {
  const report = {
    redirected: /** @type {Array<{from:string,to:string}>} */ [],
    linksUpdated: 0,
    // Side effects are best-effort and never fail the save, but a swallowed
    // failure is otherwise indistinguishable from "nothing to do" — so we
    // record it here and the editor surfaces a non-blocking warning, since a
    // missing redirect means the old public URL will 404.
    warnings: /** @type {string[]} */ [],
  };
  try {
    const rows = readRedirects();
    // Canonical /blog/<slug>/ plus the legacy bare /<slug>/ form
    // (astro.config.ts only auto-redirects bare URLs for CURRENT posts,
    // so the old one needs an explicit entry once the slug moves).
    const a = upsertRedirect(rows, `/blog/${oldSlug}/`, `/blog/${newSlug}/`);
    const b = upsertRedirect(rows, `/${oldSlug}/`, `/blog/${newSlug}/`);
    writeRedirects(rows);
    if (a) report.redirected.push(a);
    if (b) report.redirected.push(b);
  } catch (err) {
    console.warn('[posts] rename redirect failed:', err instanceof Error ? err.message : err);
    report.warnings.push('redirect');
  }
  try {
    report.linksUpdated = rewriteSlugLinksEverywhere(oldSlug, newSlug);
  } catch (err) {
    console.warn('[posts] rename link rewrite failed:', err instanceof Error ? err.message : err);
    report.warnings.push('links');
  }
  return report;
}

router.post('/', (req, res) => {
  try {
    const { data, content } = req.body;
    if (!data || !data.title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const slug = path.basename(slugify(data.slug || data.title));
    if (!slug) {
      return res.status(400).json({
        error: 'invalid_slug',
        message: 'The title needs at least one letter or number (it forms the web address).',
      });
    }
    const filename = `${slug}.md`;

    try {
      statSync(join(postsDir, filename));
      return res.status(400).json({ error: 'A post with this slug already exists' });
    } catch {
      /* doesn't exist — good */
    }

    data.slug = slug;
    if (!data.date) data.date = new Date().toISOString();

    if (data.publish_at) {
      const ts = new Date(data.publish_at).getTime();
      if (Number.isNaN(ts) || ts <= Date.now()) {
        return res.status(400).json({ error: 'publish_at must be a future ISO timestamp' });
      }
    }
    normalizeSchedule(data);

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

router.put('/:filename', (req, res) => {
  try {
    const { data, content, baseMtime } = req.body;
    const oldFilename = path.basename(req.params.filename);
    const rawSlug = data.slug || data.title || oldFilename.replace('.md', '');
    const slug = path.basename(slugify(rawSlug));
    if (!slug) {
      return res.status(400).json({
        error: 'invalid_slug',
        message: 'The web address can’t be empty — add letters or numbers to the title or slug.',
      });
    }
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
        // Include the conflicting post's title so the editor can show
        // "Already used by '<title>' — pick another" instead of a generic slug.
        let conflictTitle = slug;
        try {
          const { data: cd } = parsePost(readFileSync(newPath, 'utf8'));
          if (cd && cd.title) conflictTitle = String(cd.title);
        } catch {
          /* best-effort */
        }
        return res.status(409).json({
          error: 'slug_taken',
          message: `The web address "${slug}" is already used by "${conflictTitle}". Choose another.`,
          conflicting_title: conflictTitle,
        });
      } catch (e) {
        if (/** @type {any} */ e.code !== 'ENOENT') throw e;
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
    normalizeSchedule(data);

    // Keep front-matter keys the editor doesn't manage (bluesky_uri,
    // mastodon_uri, canonical_url, hand-added keys…). The editor sends only
    // the fields it edits; writing that object verbatim used to erase the
    // rest — losing syndication URIs and causing duplicate cross-posts.
    try {
      const { data: onDisk } = parsePost(readFileSync(oldPath, 'utf8'));
      for (const [k, v] of Object.entries(onDisk || {})) {
        if (!EDITOR_MANAGED_KEYS.has(k) && !(k in data)) data[k] = v;
      }
    } catch {
      /* new file or unreadable — nothing to preserve */
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
      const prevData = /** @type {Record<string, unknown>} */ parsedPrev.data || {};
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
      // The new content is already safely written; from here a failure must
      // NOT 500 the save (the post is saved). Drop the old file tolerantly —
      // ENOENT means it's already gone, which is the goal.
      try {
        unlinkSync(oldPath);
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          console.warn('[posts] could not remove old file after rename:', err.message);
        }
      }
      // The post's identity moved to newFilename — carry its snapshot
      // history along so the renamed post keeps its revisions.
      renameSnapshots(oldFilename, newFilename);
      // Auto-redirect the old URL + rewrite internal links so the public
      // slug change never 404s. (Best-effort; never fails the save.)
      rename = applySlugRename(oldFilename.replace(/\.md$/, ''), slug);
      // Comments are keyed by the post URL; move the thread with the post.
      // Best-effort and async — a Remark42 hiccup must never fail the save.
      const base = (process.env.PUBLIC_BASE_URL || 'https://webworldwide.online').replace(
        /\/+$/,
        '',
      );
      const oldSlug = oldFilename.replace(/\.md$/, '');
      remark42
        .remapUrls([[`${base}/blog/${oldSlug}/`, `${base}/blog/${slug}/`]])
        .then(() =>
          logActivity({ req, action: 'comments.remap', target: slug, meta: { from: oldSlug } }),
        )
        .catch((err) => console.warn('[posts] comment remap failed:', err && err.message));
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

router.delete('/:filename', (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    const trashId = moveToTrash(req, safeFilename, join(postsDir, safeFilename));
    invalidatePostRefs();
    invalidatePostsCache();
    logActivity({ req, action: 'post.delete', target: safeFilename, meta: { trashId } });
    res.json({ success: true, trashId, keptDays: TRASH_DAYS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

/** GET /api/posts/trash/list — recently deleted posts (restorable). */
router.get('/trash/list', (_req, res) => {
  res.json({ items: listTrash(), keptDays: TRASH_DAYS });
});

/**
 * POST /api/posts/trash/:id/restore — put a deleted post back. Refuses if a
 * post with that filename exists again (never overwrites).
 */
router.post('/trash/:id/restore', (req, res) => {
  const item = getTrashed(String(req.params.id));
  if (!item) return res.status(404).json({ error: 'not_found' });
  const safe = path.basename(item.filename);
  const dest = join(postsDir, safe);
  if (existsSync(dest)) {
    return res.status(409).json({
      error: 'exists',
      message: `A post named ${safe} exists again — rename it first, then restore.`,
    });
  }
  writeFileAtomic(dest, item.raw);
  removeTrashed(item.id);
  invalidatePostRefs();
  invalidatePostsCache();
  logActivity({ req, action: 'post.restore', target: safe });
  res.json({ success: true, filename: safe });
});

/**
 * Move a post file into the trash (keeps its revision snapshots).
 * @returns {string} trash id
 */
function moveToTrash(req, filename, filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  let title = null;
  try {
    title = String(parsePost(raw).data.title || '') || null;
  } catch {
    /* unparseable front matter — still trash the bytes */
  }
  const id = trashPost(filename, raw, title, req.user?.username || null);
  unlinkSync(filePath);
  return id;
}

export default router;
