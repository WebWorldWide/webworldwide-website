#!/usr/bin/env node
// @ts-check
/**
 * backfill-media.mjs — register existing on-disk media into the `media` table.
 *
 * After the Hugo→Astro migration the site's images live in
 * `site/public/images/**` (committed, served at the web root) while the CMS
 * `media` table is empty — so the library and editor show nothing even
 * though the live site is full of media. This one-shot, idempotent script
 * walks the media root and inserts a row per file, recording the real
 * on-disk path in the `storage_path` column (so the authoritative URL is the
 * actual path, and the `image.webp`-in-two-months basename collision is fine).
 *
 * Safe to re-run: rows are deduped by sha256 hash and by storage_path.
 *
 * Usage (on the Pi, after deploy — the running server has already applied
 * migration 009, so this won't rebuild the table):
 *   node admin/scripts/backfill-media.mjs
 *   # or, from admin/:  npm run backfill:media
 *
 * Env (all mirror media.js): SITE_PUBLIC_DIR / SITE_DIR override the media
 * root; AUTH_DB_PATH overrides the database location.
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { imageSize } from 'image-size';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { dirname, join, relative, extname, basename } from 'path';
import { fileURLToPath } from 'url';

import { classifyMime } from '../src/utils/mediaTypes.js';
import { runMigrations } from '../src/db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', '..', 'site');
const MEDIA_ROOT = process.env.SITE_PUBLIC_DIR || join(SITE_DIR, 'public');
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');

/** Minimal extension → MIME map for the file types we host. */
const EXT_MIME = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/**
 * @param {string} file
 * @returns {string}
 */
function mimeFor(file) {
  const ext = extname(file).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

/**
 * Recursively list every file under `dir` (absolute paths). Returns [] if
 * the directory doesn't exist.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Derive a sensible uploaded_at from a `.../yyyy/mm/...` storage path so the
 * library's date sort is coherent; fall back to the file's mtime.
 *
 * @param {string} relPath posix storage path, e.g. images/2025/12/x.webp
 * @param {string} diskPath
 * @returns {number} epoch ms
 */
function uploadedAtFor(relPath, diskPath) {
  const m = relPath.match(/(?:^|\/)(\d{4})\/(\d{2})\//);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  try {
    return Math.round(statSync(diskPath).mtimeMs);
  } catch {
    return Date.now();
  }
}

function main() {
  // Ensure the storage_path column exists before we insert. Idempotent: on a
  // server that already booted, migration 009 is recorded and this is a no-op.
  runMigrations(DB_PATH);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const byHash = db.prepare('SELECT id FROM media WHERE hash = ?');
  const byPath = db.prepare('SELECT id FROM media WHERE storage_path = ?');
  const insert = db.prepare(
    `INSERT INTO media (
        id, filename, original_name, mime_type, size,
        width, height, duration, hash,
        conversions_json, status, uploaded_at, post_refs_json, storage_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'ready', ?, '[]', ?)`,
  );

  const files = [...walk(join(MEDIA_ROOT, 'images')), ...walk(join(MEDIA_ROOT, 'files'))];

  let inserted = 0;
  let skipped = 0;
  for (const diskPath of files) {
    const relPath = relative(MEDIA_ROOT, diskPath).split('\\').join('/');
    if (byPath.get(relPath)) {
      skipped++;
      continue;
    }
    const buf = readFileSync(diskPath);
    const hash = createHash('sha256').update(buf).digest('hex');
    if (byHash.get(hash)) {
      console.log(`skip (dup hash)  ${relPath}`);
      skipped++;
      continue;
    }
    const mime = mimeFor(diskPath);
    let width = null;
    let height = null;
    if (classifyMime(mime) === 'image') {
      try {
        const dims = imageSize(buf);
        if (dims && typeof dims.width === 'number' && typeof dims.height === 'number') {
          width = dims.width;
          height = dims.height;
        }
      } catch {
        /* non-fatal; leave dims null */
      }
    }
    const name = basename(diskPath);
    insert.run(
      nanoid(),
      name,
      name,
      mime,
      buf.length,
      width,
      height,
      null,
      hash,
      uploadedAtFor(relPath, diskPath),
      relPath,
    );
    console.log(`add   ${relPath}  (${mime}, ${(buf.length / 1024).toFixed(1)} KB)`);
    inserted++;
  }

  db.close();
  console.log(`\n${inserted} inserted, ${skipped} skipped, ${files.length} on disk.`);
}

main();
