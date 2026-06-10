#!/usr/bin/env node
// @ts-check
/**
 * dedupe-media.js — collapse byte-identical media into a single canonical
 * copy and repoint posts at it.
 *
 * The library accumulated DUPLICATES: the same image uploaded several
 * times under different hash-prefixed names (e.g. `9d9c330d-image-19.webp`
 * vs an earlier `image-19.webp`). They waste space and clutter the grid.
 *
 * This script content-hashes (sha256) every media file on disk, groups
 * identical hashes, and for each group picks ONE canonical copy:
 *   1. prefer a copy that is referenced by a post, then
 *   2. tie-break to the OLDEST file (lowest uploaded_at, then name).
 *
 * For every non-canonical duplicate it:
 *   - rewrites post references (body image URLs + cover frontmatter),
 *     mapping a duplicate's URL — including responsive variants like
 *     `dup-320w.webp` — to the canonical's matching variant when that
 *     variant exists on disk (else to the canonical base);
 *   - deletes the duplicate's DB row and its files (base + variants).
 *
 * Default is a DRY RUN that only prints the plan. Pass `--apply` to make
 * the changes. Safe to re-run: a second `--apply` is a no-op.
 *
 * Usage (on the Pi, inside the cms container):
 *   docker compose exec cms node scripts/dedupe-media.js            # dry-run
 *   docker compose exec cms node scripts/dedupe-media.js --apply
 *   # or, from admin/:  npm run dedupe:media [-- --apply]
 *
 * Env (mirrors media.js / backfill-*.js): SITE_DIR / SITE_PUBLIC_DIR
 * override the content + media roots; AUTH_DB_PATH overrides the DB.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { runMigrations } from '../src/db/migrate.js';
import { urlForRow } from './backfill-alt-text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', '..', 'site');
const MEDIA_ROOT = process.env.SITE_PUBLIC_DIR || join(SITE_DIR, 'public');
const POSTS_DIR = join(SITE_DIR, 'content', 'posts');
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');

/** Markdown/cover URL token, same shape postRefs.js scans for. */
const URL_RE = /\/(?:images|files)\/[A-Za-z0-9_./-]+/g;
/** Responsive-variant suffix: `-320w`, `-640w`, `-thumb`, `-1200x800`. */
const VARIANT_SUFFIX_RE = /-(?:\d+w|thumb|\d+x\d+)$/i;

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decompose a media URL into directory / base name / variant descriptor.
 *
 * @param {string} url e.g. `/images/2025/12/name-320w.webp`
 * @returns {{ dir: string, ext: string, base: string, descriptor: string | null }}
 */
function parseMediaUrl(url) {
  const slash = url.lastIndexOf('/');
  const dir = url.slice(0, slash + 1);
  const file = url.slice(slash + 1);
  const extM = file.match(/\.[a-z0-9]+$/i);
  const ext = extM ? extM[0] : '';
  const stem = ext ? file.slice(0, -ext.length) : file;
  const vm = stem.match(VARIANT_SUFFIX_RE);
  const descriptor = vm ? vm[0].slice(1) : null;
  const base = vm ? stem.slice(0, -vm[0].length) : stem;
  return { dir, ext, base, descriptor };
}

/**
 * Reduce a URL to the key shared by an asset and all its variants
 * (directory + base name, minus variant suffix + extension). Mirrors the
 * helper in src/routes/media.js.
 *
 * @param {string} url
 * @returns {string}
 */
function variantBaseKey(url) {
  const { dir, base } = parseMediaUrl(url);
  return dir + base;
}

/**
 * Absolute on-disk path for a public media URL.
 *
 * @param {string} url
 * @param {string} mediaRoot
 * @returns {string}
 */
function diskPathForUrl(url, mediaRoot) {
  return join(mediaRoot, url.replace(/^\//, ''));
}

/**
 * Variant files (NOT the base) that live alongside a base URL on disk.
 *
 * @param {string} baseUrl
 * @param {string} mediaRoot
 * @returns {string[]} variant URLs
 */
function findVariantUrls(baseUrl, mediaRoot) {
  const { dir, base } = parseMediaUrl(baseUrl);
  const absDir = join(mediaRoot, dir.replace(/^\//, ''));
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${escapeRegExp(base)}-(?:\\d+w|thumb|\\d+x\\d+)\\.[a-z0-9]+$`, 'i');
  return entries.filter((n) => re.test(n)).map((n) => dir + n);
}

/**
 * Map a duplicate's referenced URL to the canonical equivalent. A variant
 * reference (`dup-320w.webp`) maps to the canonical's same-descriptor
 * variant when it exists on disk; otherwise everything falls back to the
 * canonical base URL.
 *
 * @param {string} refUrl
 * @param {string} canonUrl
 * @param {string} mediaRoot
 * @returns {string}
 */
function rewriteTargetFor(refUrl, canonUrl, mediaRoot) {
  const ref = parseMediaUrl(refUrl);
  if (!ref.descriptor) return canonUrl;
  const canon = parseMediaUrl(canonUrl);
  const candidateName = `${canon.base}-${ref.descriptor}${ref.ext}`;
  const candidateUrl = canon.dir + candidateName;
  if (existsSync(diskPathForUrl(candidateUrl, mediaRoot))) return candidateUrl;
  return canonUrl;
}

/**
 * Scan posts → { referencedKeys, byFile }. `referencedKeys` is the set of
 * variantBaseKeys any post links to (used to prefer referenced copies as
 * canonical). `byFile` maps each post filename to its raw text + the URL
 * tokens it contains (used to plan/apply rewrites).
 *
 * @param {string} postsDir
 * @returns {{ referencedKeys: Set<string>, byFile: Map<string, { text: string, urls: string[] }> }}
 */
function scanPosts(postsDir) {
  /** @type {Set<string>} */
  const referencedKeys = new Set();
  /** @type {Map<string, { text: string, urls: string[] }>} */
  const byFile = new Map();
  let files;
  try {
    files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return { referencedKeys, byFile };
  }
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(postsDir, file), 'utf8');
    } catch {
      continue;
    }
    /** @type {string[]} */
    const urls = [];
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
      urls.push(m[0]);
      referencedKeys.add(variantBaseKey(m[0]));
    }
    byFile.set(file, { text, urls });
  }
  return { referencedKeys, byFile };
}

/**
 * Pick the canonical row of a duplicate group: prefer a referenced copy,
 * then the oldest (lowest uploaded_at, then URL for determinism).
 *
 * @param {Record<string, any>[]} group
 * @param {Set<string>} referencedKeys
 * @returns {Record<string, any>}
 */
function pickCanonical(group, referencedKeys) {
  const referenced = group.filter((r) => referencedKeys.has(variantBaseKey(urlForRow(r))));
  const pool = referenced.length ? referenced : group;
  return pool.slice().sort((a, b) => {
    const at = a.uploaded_at || 0;
    const bt = b.uploaded_at || 0;
    if (at !== bt) return at - bt;
    return urlForRow(a) < urlForRow(b) ? -1 : 1;
  })[0];
}

/**
 * @param {{ apply?: boolean, dbPath?: string, mediaRoot?: string, postsDir?: string, quiet?: boolean }} [opts]
 * @returns {{
 *   applied: boolean,
 *   groups: { hash: string, canonical: { id: string, url: string }, duplicates: { id: string, url: string }[] }[],
 *   rewrites: { file: string, from: string, to: string }[],
 *   deletions: { id: string, url: string, files: string[] }[],
 * }}
 */
export function main(opts = {}) {
  const apply =
    opts.apply ?? (process.argv.includes('--apply') && !process.argv.includes('--dry-run'));
  const dbPath = opts.dbPath || DB_PATH;
  const mediaRoot = opts.mediaRoot || MEDIA_ROOT;
  const postsDir = opts.postsDir || POSTS_DIR;
  const quiet = opts.quiet ?? false;
  const log = quiet ? () => {} : (...a) => console.log(...a);

  // Ensure the schema (storage_path / alt_text columns) exists. Idempotent.
  runMigrations(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const rows = /** @type {Record<string, any>[]} */ (db.prepare('SELECT * FROM media').all());
  const { referencedKeys, byFile } = scanPosts(postsDir);

  // Content-hash each row's file. Rows whose file is missing are skipped.
  /** @type {Map<string, Record<string, any>[]>} */
  const byHash = new Map();
  for (const row of rows) {
    const url = urlForRow(row);
    const disk = diskPathForUrl(url, mediaRoot);
    let buf;
    try {
      buf = readFileSync(disk);
    } catch {
      log(`skip (missing file)  ${url}`);
      continue;
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    const arr = byHash.get(hash) || [];
    arr.push(row);
    byHash.set(hash, arr);
  }

  /** @type {{ hash: string, canonical: { id: string, url: string }, duplicates: { id: string, url: string }[] }[]} */
  const groups = [];
  /** @type {{ file: string, from: string, to: string }[]} */
  const rewrites = [];
  /** @type {{ id: string, url: string, files: string[] }[]} */
  const deletions = [];
  // file -> Map(fromUrl -> toUrl) accumulated across all duplicates.
  /** @type {Map<string, Map<string, string>>} */
  const fileRewrites = new Map();

  for (const hash of [...byHash.keys()].sort()) {
    const group = byHash.get(hash);
    if (!group || group.length < 2) continue;
    const canon = pickCanonical(group, referencedKeys);
    const canonUrl = urlForRow(canon);
    const dups = group.filter((r) => r.id !== canon.id);
    groups.push({
      hash,
      canonical: { id: canon.id, url: canonUrl },
      duplicates: dups.map((d) => ({ id: d.id, url: urlForRow(d) })),
    });

    for (const dup of dups) {
      const dupUrl = urlForRow(dup);
      const dupKey = variantBaseKey(dupUrl);

      // Plan post rewrites for every reference to this duplicate (base or
      // variant), pointing each at the canonical's matching URL.
      for (const [file, info] of byFile) {
        for (const refUrl of info.urls) {
          if (variantBaseKey(refUrl) !== dupKey) continue;
          const to = rewriteTargetFor(refUrl, canonUrl, mediaRoot);
          if (to === refUrl) continue; // already canonical
          const fm = fileRewrites.get(file) || new Map();
          if (!fm.has(refUrl)) {
            fm.set(refUrl, to);
            rewrites.push({ file, from: refUrl, to });
          }
          fileRewrites.set(file, fm);
        }
      }

      // Plan file deletions: base + variants on disk.
      const files = [dupUrl, ...findVariantUrls(dupUrl, mediaRoot)];
      deletions.push({ id: dup.id, url: dupUrl, files });
    }
  }

  // ── Report ──────────────────────────────────────────────────────
  log(`\n${apply ? '[apply]' : '[dry-run]'} ${groups.length} duplicate group(s) found.`);
  for (const g of groups) {
    log(`\n  group ${g.hash.slice(0, 8)}  keep ${g.canonical.url}`);
    for (const d of g.duplicates) log(`    drop ${d.url}`);
  }
  if (rewrites.length) {
    log(`\n  ${rewrites.length} post reference(s) to rewrite:`);
    for (const r of rewrites) log(`    ${r.file}:  ${r.from}  →  ${r.to}`);
  }

  // ── Apply ───────────────────────────────────────────────────────
  if (apply && groups.length) {
    // 1) Rewrite post files.
    for (const [file, fm] of fileRewrites) {
      const path = join(postsDir, file);
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      // Replace longer (variant) URLs first so a base URL never partially
      // matches inside a variant. A trailing boundary prevents matching a
      // URL that is a prefix of a longer one.
      for (const from of [...fm.keys()].sort((a, b) => b.length - a.length)) {
        const to = fm.get(from);
        text = text.replace(new RegExp(`${escapeRegExp(from)}(?![A-Za-z0-9])`, 'g'), to);
      }
      writeFileSync(path, text);
    }

    // 2) Delete duplicate files + DB rows.
    const del = db.prepare('DELETE FROM media WHERE id = ?');
    const drop = db.transaction((items) => {
      for (const d of items) del.run(d.id);
    });
    for (const d of deletions) {
      for (const url of d.files) {
        const disk = diskPathForUrl(url, mediaRoot);
        try {
          if (existsSync(disk)) unlinkSync(disk);
        } catch (err) {
          console.warn(`[dedupe] unlink failed (continuing): ${disk}: ${err.message}`);
        }
      }
    }
    drop(deletions);
    log(
      `\n[apply] rewrote ${rewrites.length} reference(s), deleted ${deletions.length} duplicate row(s).`,
    );
  } else if (!apply && groups.length) {
    log(`\nRe-run with --apply to rewrite posts and delete ${deletions.length} duplicate(s).`);
  } else if (!groups.length) {
    log('Nothing to do — no duplicates.');
  }

  db.close();
  return { applied: Boolean(apply) && groups.length > 0, groups, rewrites, deletions };
}

// statSync re-export kept for symmetry with backfill scripts / tests that
// may want to assert mtimes without re-importing fs.
export const __internals = {
  variantBaseKey,
  parseMediaUrl,
  rewriteTargetFor,
  findVariantUrls,
  statSync,
};

// Run when invoked directly; stay import-safe for the unit tests.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) main();
