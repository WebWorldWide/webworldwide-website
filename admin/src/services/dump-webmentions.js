// @ts-check
/**
 * dump-webmentions.js — Phase 8 build-time data export.
 *
 * Reads every `status='approved'` row from the `webmentions` table,
 * groups by post slug (derived from the `target` URL's pathname), and
 * writes one JSON file per slug under `site/data/webmentions/`:
 *
 *   site/data/webmentions/<slug>.json
 *
 * Shape per file:
 *
 *   {
 *     "target":   "https://terminaleighty.com/<slug>/",
 *     "count":    <int>,
 *     "replies":  [{ id, source, author:{name,url,avatar}, content, received_at }, ...],
 *     "likes":    [{ id, source, author:{...}, received_at }, ...],
 *     "reposts":  [...],
 *     "bookmarks":[...],
 *     "mentions": [...]
 *   }
 *
 * Hugo's `webmentions.html` partial reads the file matching the
 * current page's slug at build time. This keeps the public site
 * static (no runtime fetch) so Lighthouse stays green.
 *
 * Invocation:
 *   node admin/src/services/dump-webmentions.js [--dry-run]
 *
 * On the Pi a cron calls `scripts/dump-webmentions.sh` every 5 min,
 * which wraps this script + a git commit/push so the JSON files land
 * in the same repo state Hugo builds from.
 *
 * Exit code: 0 even when nothing changed (cron-friendly). Errors
 * propagate as non-zero exits with stderr.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { normaliseUrl } from './microformats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
const DEFAULT_SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', '..', '..', 'site');

/**
 * Pull `<slug>` from a target URL: the first non-empty path segment.
 * Posts use the permalink `posts = "/:slug/"` rule in hugo.toml so
 * `https://terminaleighty.com/<slug>/` is the canonical shape.
 *
 * Returns null for URLs we can't bucket (homepage, taxonomies — we
 * don't write per-slug files for those; their mentions live in the
 * special `__home__.json` bucket so the renderer can still surface them).
 *
 * @param {string} url
 * @returns {string|null}
 */
export function slugFromTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return '__home__';
  // Sanitise — accept slug-shaped tokens only (Hugo's slug rules).
  const candidate = parts[0];
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * Build the per-slug grouped output map from a flat row list.
 *
 * @param {any[]} rows
 * @returns {Record<string, any>}
 */
export function groupBySlug(rows) {
  /** @type {Record<string, any>} */
  const buckets = {};
  for (const r of rows) {
    const slug = slugFromTarget(r.target);
    if (!slug) continue;
    // eslint-disable-next-line security/detect-object-injection -- slug is regex-validated above
    if (!buckets[slug]) {
      // eslint-disable-next-line security/detect-object-injection -- slug is regex-validated above
      buckets[slug] = {
        target: canonicalTarget(r.target),
        count: 0,
        replies: [],
        likes: [],
        reposts: [],
        bookmarks: [],
        mentions: [],
      };
    }
    // eslint-disable-next-line security/detect-object-injection -- slug already validated
    const bucket = buckets[slug];
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
    // 'reply' → 'replies' (irregular plural); other types pluralize
    // cleanly. Keep this in sync with the feed route in webmentions.js.
    const bucketMap = {
      reply: 'replies',
      like: 'likes',
      repost: 'reposts',
      bookmark: 'bookmarks',
      mention: 'mentions',
    };
    const key = bucketMap[r.type] || 'mentions';
    if (Array.isArray(bucket[key])) {
      bucket[key].push(shaped);
    } else {
      bucket.mentions.push(shaped);
    }
    bucket.count += 1;
  }
  return buckets;
}

/**
 * Strip fragment + duplicate slashes from a target URL for display.
 * @param url
 */
function canonicalTarget(url) {
  return normaliseUrl(url) || url;
}

/**
 * Run the dump. Returns a summary so the cron wrapper can decide
 * whether to git-commit (any files written or removed → commit).
 *
 * @param {{ dbPath?: string, siteDir?: string, dryRun?: boolean }} [opts]
 * @returns {{ written: string[], removed: string[], total: number }}
 */
export function dumpWebmentions(opts) {
  const dbPath = opts?.dbPath || DEFAULT_DB_PATH;
  const siteDir = opts?.siteDir || DEFAULT_SITE_DIR;
  const dryRun = Boolean(opts?.dryRun);
  const outDir = join(siteDir, 'data', 'webmentions');

  if (!existsSync(dbPath)) {
    console.warn(`[dump-webmentions] DB missing at ${dbPath} — nothing to dump.`);
    return { written: [], removed: [], total: 0 };
  }

  const db = new Database(dbPath, { readonly: true });
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT id, source, target, type, author_name, author_avatar, author_url,
                content, received_at
           FROM webmentions
          WHERE status = 'approved'
          ORDER BY target, received_at ASC`,
      )
      .all();
  } finally {
    db.close();
  }

  const buckets = groupBySlug(rows);
  if (!dryRun) mkdirSync(outDir, { recursive: true });

  const written = [];
  const existingFiles = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => f.endsWith('.json'))
    : [];
  const keepFiles = new Set();

  for (const [slug, payload] of Object.entries(buckets)) {
    const fname = `${slug}.json`;
    keepFiles.add(fname);
    const fpath = join(outDir, fname);
    const next = JSON.stringify(payload, null, 2) + '\n';
    let prev = '';
    if (existsSync(fpath)) {
      try {
        prev = readFileSync(fpath, 'utf-8');
      } catch {
        prev = '';
      }
    }
    if (prev === next) continue;
    if (!dryRun) writeFileSync(fpath, next);
    written.push(fname);
  }

  // Sweep files whose slug no longer has any approved mentions. Keep
  // the `.gitkeep` (and any non-json sentinel) intact.
  const removed = [];
  for (const f of existingFiles) {
    if (keepFiles.has(f)) continue;
    const fpath = join(outDir, f);
    if (!dryRun) rmSync(fpath, { force: true });
    removed.push(f);
  }

  return { written, removed, total: rows.length };
}

// Allow `node admin/src/services/dump-webmentions.js` as a CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const result = dumpWebmentions({ dryRun });
  console.log(
    `[dump-webmentions] total=${result.total} written=${result.written.length} removed=${result.removed.length}${dryRun ? ' (dry-run)' : ''}`,
  );
  if (result.written.length) {
    console.log(`[dump-webmentions] wrote: ${result.written.join(', ')}`);
  }
  if (result.removed.length) {
    console.log(`[dump-webmentions] removed: ${result.removed.join(', ')}`);
  }
}

export default { dumpWebmentions, groupBySlug, slugFromTarget };
