// @ts-check
/**
 * publish-media-data.js — Phase 6 publish-time data builder.
 *
 * The Hugo `attachment` shortcode (Phase 6) does lookups via
 * `site.Data.media` so it can render attachment previews without a
 * runtime API call. This builder serialises the `media` table into a
 * Hugo data file at `site/data/media.json` shaped as:
 *
 *   {
 *     "<id>": {
 *       filename, original_filename, mime_type, type,
 *       size, width, height, duration,
 *       original_url, conversions: { ... }
 *     },
 *     ...
 *   }
 *
 * Rules:
 *   - Skip rows whose original file is missing on disk (Phase 5d's
 *     dev-seeded fixtures don't bundle real bytes — they'd render as
 *     broken images otherwise).
 *   - Always overwrite the existing file (no merge: the DB is the
 *     source of truth).
 *   - On a write failure (disk full, perms), throw — the publish flow
 *     catches and reports it to the user, who can then retry.
 *
 * The publish route calls `writeMediaData()` immediately before
 * `git.add`, so the resulting `site/data/media.json` is included in the
 * same commit that ships the post referencing the attachments.
 */

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

import { classifyMime, computeStoragePath } from '../utils/mediaTypes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
const DEFAULT_SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', '..', '..', 'site');

/**
 * Reverse-derive `yyyy/mm` from the recorded upload timestamp. Mirrors
 * `media.js`'s helper so the two stay in lockstep without an import
 * dependency (media.js is an Express router; importing it here would
 * mount the router as a side effect).
 *
 * @param {number} uploadedAt epoch ms
 * @returns {string}
 */
function derivePathFromUploadedAt(uploadedAt) {
  const d = new Date(uploadedAt || Date.now());
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Shape a media row into the JSON map entry. Mirrors the API's shape so
 * Hugo templates and admin React code see the same field names.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function shapeMediaForData(row) {
  const type = classifyMime(row.mime_type);
  const category = type === 'image' ? 'images' : 'files';
  const datePath = derivePathFromUploadedAt(row.uploaded_at);
  const originalUrl = `/${category}/${datePath}/${row.filename}`;
  let conversions = {};
  try {
    conversions = JSON.parse(row.conversions_json || '{}');
  } catch {
    conversions = {};
  }
  return {
    id: row.id,
    filename: row.filename,
    original_filename: row.original_name,
    mime_type: row.mime_type,
    type, // image | video | audio | document | archive | other
    size: row.size,
    width: row.width ?? null,
    height: row.height ?? null,
    duration: row.duration ?? null,
    original_url: originalUrl,
    conversions,
  };
}

/**
 * Resolve the on-disk path for a row.
 *
 * @param {Record<string, any>} row
 * @param {string} staticDir absolute path to `site/static`
 * @returns {string}
 */
function diskPathFor(row, staticDir) {
  const type = classifyMime(row.mime_type);
  const category = type === 'image' ? 'images' : 'files';
  // computeStoragePath is the canonical join used by the upload handler
  // — we mirror its rules here so a row written by media.js maps to the
  // same path on disk. We only need the directory + filename, not the
  // urlPath (which uses leading "/" and we'd have to strip).
  void computeStoragePath; // future-proofing reference
  return join(staticDir, category, derivePathFromUploadedAt(row.uploaded_at), row.filename);
}

/**
 * Build the media-data map from a SQLite database.
 *
 * @param {{ dbPath?: string, siteDir?: string, includeMissing?: boolean }} [opts]
 * @returns {{ map: Record<string, any>, total: number, skipped: number }}
 */
export function buildMediaData(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const siteDir = opts.siteDir || DEFAULT_SITE_DIR;
  const includeMissing = Boolean(opts.includeMissing);
  const staticDir = join(siteDir, 'static');

  if (!existsSync(dbPath)) {
    // No DB on disk = nothing to write. Return an empty map; the caller
    // still ensures media.json exists (overwriting with `{}`).
    return { map: {}, total: 0, skipped: 0 };
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT * FROM media').all();
    /** @type {Record<string, any>} */
    const map = {};
    let skipped = 0;
    for (const row of rows) {
      // Phase 5d's dev seed writes rows without a real file on disk.
      // Including them in media.json would render as broken images and
      // hide real failures, so we skip them by default.
      if (!includeMissing) {
        const disk = diskPathFor(row, staticDir);
        if (!existsSync(disk)) {
          skipped += 1;
          continue;
        }
      }
      map[row.id] = shapeMediaForData(row);
    }
    return { map, total: rows.length, skipped };
  } finally {
    db.close();
  }
}

/**
 * Build and write `site/data/media.json`. Returns the path written and
 * the number of entries serialised (after skipping missing files).
 *
 * @param {{ dbPath?: string, siteDir?: string, includeMissing?: boolean }} [opts]
 * @returns {{ path: string, count: number, skipped: number, total: number }}
 */
export function writeMediaData(opts = {}) {
  const siteDir = opts.siteDir || DEFAULT_SITE_DIR;
  const dataDir = join(siteDir, 'data');
  const outPath = join(dataDir, 'media.json');

  const { map, total, skipped } = buildMediaData(opts);

  mkdirSync(dataDir, { recursive: true });
  // Pretty-print: the file is committed to git, and a stable
  // human-readable format makes review-friendly diffs when only a
  // single entry changes.
  writeFileSync(outPath, JSON.stringify(map, null, 2) + '\n', 'utf8');

  return { path: outPath, count: Object.keys(map).length, skipped, total };
}
