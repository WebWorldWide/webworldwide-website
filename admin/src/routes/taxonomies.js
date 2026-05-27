// @ts-check
/**
 * taxonomies.js — Phase 5e tag manager.
 *
 * GET    /api/taxonomies/tags                     → [{ name, count, posts }]
 * POST   /api/taxonomies/tags/rename              → { from, to }
 * POST   /api/taxonomies/tags/merge               → { from: [a,b], into }
 * DELETE /api/taxonomies/tags/:name?force=true    → strip tag from all posts
 *
 * Each mutation rewrites the affected files in front-matter and logs a
 * single `taxonomy.*` activity row. Mass-rewrites are NOT auto-committed
 * — the user clicks "Publish" on the dashboard when they're ready to
 * push. Reason: a rename across 30 posts has a single review point.
 */

import { Router } from 'express';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import path, { join } from 'path';
import { parsePost, serializePost } from '../utils/frontmatter.js';
import { invalidatePostRefs } from '../utils/postRefs.js';
import { logActivity } from '../services/activity.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
const postsDir = join(SITE_DIR, 'content', 'posts');

const router = Router();

/**
 * Walk every post and build a `{ tag → [filename, …] }` index.
 *
 * @returns {Map<string, string[]>}
 */
function buildTagIndex() {
  /** @type {Map<string, string[]>} */
  const index = new Map();
  if (!existsSync(postsDir)) return index;
  const files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    try {
      const raw = readFileSync(join(postsDir, file), 'utf-8');
      const { data } = parsePost(raw);
      const tags = Array.isArray(data.tags) ? data.tags : [];
      for (const tag of tags) {
        const name = String(tag);
        const arr = index.get(name) || [];
        arr.push(file);
        index.set(name, arr);
      }
    } catch (err) {
      console.warn(`[taxonomies] skip ${file}: ${err.message}`);
    }
  }
  return index;
}

router.get('/tags', (_req, res) => {
  const index = buildTagIndex();
  const items = Array.from(index.entries())
    .map(([name, posts]) => ({ name, count: posts.length, posts }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  res.json(items);
});

/**
 * Rewrite a single tag across all posts that mention it. Pass a
 * transform function `(tags) => tags` that returns the new array.
 *
 * @param {(tags: string[]) => string[]} transform
 * @param {string[]} [onlyFiles] limit to this filename list (optional)
 * @returns {string[]} list of modified filenames
 */
function rewriteTagsAcrossPosts(transform, onlyFiles) {
  const files =
    onlyFiles && onlyFiles.length
      ? onlyFiles.map((f) => path.basename(f))
      : existsSync(postsDir)
        ? readdirSync(postsDir).filter((f) => f.endsWith('.md'))
        : [];
  /** @type {string[]} */ const touched = [];
  for (const file of files) {
    const filePath = join(postsDir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { data, content } = parsePost(raw);
      const before = Array.isArray(data.tags) ? data.tags.map(String) : [];
      const after = transform(before.slice());
      // Skip writes when the array is identical (order + values).
      if (before.length === after.length && before.every((t, i) => t === after[i])) {
        continue;
      }
      data.tags = after;
      writeFileSync(filePath, serializePost(data, content || ''));
      touched.push(file);
    } catch (err) {
      console.warn(`[taxonomies] rewrite ${file} failed: ${err.message}`);
    }
  }
  if (touched.length) invalidatePostRefs();
  return touched;
}

router.post('/tags/rename', (req, res) => {
  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  if (from === to) return res.json({ ok: true, touched: [] });

  const touched = rewriteTagsAcrossPosts((tags) => {
    const seen = new Set();
    /** @type {string[]} */ const out = [];
    for (const t of tags) {
      const v = t === from ? to : t;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  });
  logActivity({
    req,
    action: 'taxonomy.rename',
    target: from,
    meta: { to, touched: touched.length },
  });
  res.json({ ok: true, touched });
});

router.post('/tags/merge', (req, res) => {
  const from = Array.isArray(req.body?.from) ? req.body.from.map(String) : [];
  const into = String(req.body?.into || '').trim();
  if (!from.length || !into) return res.status(400).json({ error: 'from[] and into required' });
  const fromSet = new Set(from);

  const touched = rewriteTagsAcrossPosts((tags) => {
    const seen = new Set();
    /** @type {string[]} */ const out = [];
    for (const t of tags) {
      const v = fromSet.has(t) ? into : t;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  });
  logActivity({
    req,
    action: 'taxonomy.merge',
    target: into,
    meta: { from, touched: touched.length },
  });
  res.json({ ok: true, touched });
});

router.delete('/tags/:name', (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const force = String(req.query.force || '').toLowerCase() === 'true';

  const index = buildTagIndex();
  const usage = index.get(name) || [];
  if (usage.length && !force) {
    return res.status(409).json({
      error: 'in_use',
      message: `Tag is on ${usage.length} post${usage.length === 1 ? '' : 's'}.`,
      posts: usage,
    });
  }

  const touched = rewriteTagsAcrossPosts((tags) => tags.filter((t) => t !== name), usage);
  logActivity({ req, action: 'taxonomy.delete', target: name, meta: { touched: touched.length } });
  res.json({ ok: true, touched });
});

export default router;
