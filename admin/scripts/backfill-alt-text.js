#!/usr/bin/env node
// @ts-check
/**
 * backfill-alt-text.js — seed `media.alt_text` from post markdown.
 *
 * Post bodies are the historical home of alt text (`![alt](/images/…)`),
 * so after migration 010 adds the `alt_text` column the library starts
 * empty. This one-shot, idempotent script scans every post (plus
 * frontmatter `cover`/`cover_alt` pairs), maps each referenced URL to
 * its alt text, and fills `alt_text` for media rows that don't have one
 * yet. Filename-ish "alts" (`image-19.webp`) are ignored — they're what
 * this feature exists to eliminate.
 *
 * Markdown stays authoritative inside published post bodies; the column
 * is the library default for future insertions.
 *
 * Usage (on the Pi, inside the cms container):
 *   docker compose exec cms node scripts/backfill-alt-text.js [--dry-run]
 *   # or, from admin/:  npm run backfill:alt
 *
 * Env (mirrors media.js / backfill-media.js): SITE_DIR / SITE_PUBLIC_DIR
 * override the content + media roots; AUTH_DB_PATH overrides the DB.
 */

import Database from 'better-sqlite3';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { classifyMime } from '../src/utils/mediaTypes.js';
import { runMigrations } from '../src/db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', '..', 'site');
const POSTS_DIR = join(SITE_DIR, 'content', 'posts');
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');

/** Markdown image: ![alt](/images/… | /files/…) — alt may be empty. */
const MD_IMAGE_RE = /!\[([^\]]*)\]\((\/(?:images|files)\/[^)\s]+)\)/g;

/**
 * True when an "alt" is really just a filename — the failure mode this
 * backfill exists to fix, so such values are never treated as alt text.
 *
 * @param {string} alt
 * @param {{ filename?: string, original_name?: string }} [row]
 * @returns {boolean}
 */
export function isFilenameLikeAlt(alt, row = {}) {
  const a = String(alt || '').trim();
  if (!a) return true;
  if (/^[\w. ()-]+\.(webp|png|jpe?g|gif|svg|avif|bmp|ico|mp4|webm|mp3|pdf)$/i.test(a)) return true;
  if (row.filename && a === row.filename) return true;
  if (row.original_name && a === row.original_name) return true;
  return false;
}

/**
 * Scan every post for image references and build url → alt. When two
 * posts disagree about the same image, the longer (more descriptive)
 * alt wins. Frontmatter `cover` + `cover_alt` pairs count too.
 *
 * @param {string} postsDir
 * @returns {Map<string, string>}
 */
export function collectAltMap(postsDir) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const consider = (url, alt) => {
    const a = String(alt || '').trim();
    if (!url || isFilenameLikeAlt(a)) return;
    const existing = map.get(url);
    if (!existing || a.length > existing.length) map.set(url, a);
  };

  if (!existsSync(postsDir)) return map;
  for (const file of readdirSync(postsDir)) {
    if (!file.endsWith('.md')) continue;
    const text = readFileSync(join(postsDir, file), 'utf-8');

    for (const m of text.matchAll(MD_IMAGE_RE)) consider(m[2], m[1]);

    // Frontmatter cover image: `cover: /images/…` + `cover_alt: …`
    // (values may be quoted). Only look inside the leading --- block.
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const cover = fm[1].match(/^cover:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
      const coverAlt = fm[1].match(/^cover_alt:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
      if (cover && coverAlt) consider(cover[1].trim(), coverAlt[1]);
    }
  }
  return map;
}

/**
 * Resolve a media row's public URL exactly the way the API does
 * (`shapeMedia` in src/routes/media.js): an explicit storage_path wins;
 * otherwise derive `/{category}/{yyyy}/{mm}/{filename}` from the upload
 * timestamp.
 *
 * @param {Record<string, any>} row
 * @returns {string}
 */
export function urlForRow(row) {
  if (row.storage_path) return `/${row.storage_path}`;
  const category = classifyMime(row.mime_type) === 'image' ? 'images' : 'files';
  const d = new Date(row.uploaded_at || 0);
  const ym = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `/${category}/${ym}/${row.filename}`;
}

/**
 * @param {{ dryRun?: boolean, dbPath?: string, postsDir?: string }} [opts]
 * @returns {{ updated: number, skippedHasAlt: number, skippedNoMatch: number, total: number }}
 */
export function main(opts = {}) {
  const dryRun = opts.dryRun ?? process.argv.includes('--dry-run');
  const dbPath = opts.dbPath || DB_PATH;
  const postsDir = opts.postsDir || POSTS_DIR;

  // Ensure the alt_text column exists (migration 010). Idempotent.
  runMigrations(dbPath);

  const altMap = collectAltMap(postsDir);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const rows = db.prepare('SELECT * FROM media').all();
  const update = db.prepare('UPDATE media SET alt_text = ? WHERE id = ?');

  let updated = 0;
  let skippedHasAlt = 0;
  let skippedNoMatch = 0;
  for (const row of rows) {
    if (row.alt_text && String(row.alt_text).trim()) {
      skippedHasAlt++;
      continue;
    }
    const alt = altMap.get(urlForRow(row));
    if (!alt) {
      skippedNoMatch++;
      continue;
    }
    if (!dryRun) update.run(alt, row.id);
    console.log(`${dryRun ? 'would set' : 'set'}   ${urlForRow(row)}  →  "${alt}"`);
    updated++;
  }

  db.close();
  console.log(
    `\n${dryRun ? '[dry-run] ' : ''}${updated} updated, ` +
      `${skippedHasAlt} already had alt text, ${skippedNoMatch} unreferenced, ${rows.length} rows.`,
  );
  return { updated, skippedHasAlt, skippedNoMatch, total: rows.length };
}

// Run when invoked directly; stay import-safe for the unit tests.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) main();
