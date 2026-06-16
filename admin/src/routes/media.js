// @ts-check
/**
 * media.js — Phase 4 universal media library.
 *
 * Replaces the Phase 1–2 image-only upload route. Accepts any file
 * (subject to an extension denylist and a configurable per-file size
 * cap), computes a sha256 hash while streaming bytes to a temp file,
 * dedups by hash, then moves the file into either
 * `site/static/images/yyyy/mm/` or `site/static/files/yyyy/mm/` based
 * on MIME type. Metadata lives in the `media` table in `auth.db` (see
 * `admin/src/db/migrations/002_media.sql`).
 *
 * Endpoints (all mounted under `/api/media`, protected by the session
 * middleware in `server.js`):
 *
 *   POST   /upload          multipart `files`; multi-file via Multer
 *   GET    /                paginated list, filter/search/sort
 *   GET    /:id             one record + post-usage
 *   GET    /:id/usage       post-usage only (lighter call for delete UX)
 *   DELETE /:id             refuses if in_use, ?force=true overrides
 *
 * Originals are served by the static mount in `server.js`
 * (`/images/...`, `/files/...`) — this module does not register a
 * separate serve route.
 *
 * Phase 5 hook: when a row's `status` is flipped to `'processing'` and
 * a conversion enqueue function is wired (see `enqueueConversion`
 * placeholder below), the upload handler will fire-and-forget the job.
 * Until then, status is always `'ready'` and `conversions_json` stays
 * `'{}'`.
 */

import { Router } from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { imageSize } from 'image-size';
import {
  createWriteStream,
  createReadStream,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { classifyMime, isDeniedExtension, computeStoragePath } from '../utils/mediaTypes.js';
import { invalidatePostRefs, postsReferencing } from '../utils/postRefs.js';
// Phase 5: conversion queue producer + retry plumbing. The worker
// (started by server.js) drains rows from `conversion_jobs`; here we
// only enqueue and trigger retries.
import {
  enqueueJob,
  retryJob,
  latestJobForMedia,
  isCodeFile,
} from '../services/conversion/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// ── Config ────────────────────────────────────────────────────────
const SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', '..', '..', 'site');
// Media is stored under Astro's public dir (served at the web root). This was
// Hugo's `static/` before the Astro migration; `SITE_PUBLIC_DIR` lets tests
// and alternate hosts override the location.
const MEDIA_ROOT = process.env.SITE_PUBLIC_DIR || join(SITE_DIR, 'public');
const POSTS_DIR = join(SITE_DIR, 'content', 'posts');
const MAX_UPLOAD_SIZE = Number(process.env.MEDIA_MAX_UPLOAD_SIZE || 100 * 1024 * 1024);

// Ensure the year/month sub-directories exist on demand (Multer's tmp
// staging area lives in the OS tmpdir, not the site root, so we never
// half-write into static/ unless dedup+move succeeds).
mkdirSync(join(MEDIA_ROOT, 'images'), { recursive: true });
mkdirSync(join(MEDIA_ROOT, 'files'), { recursive: true });

// ── DB ────────────────────────────────────────────────────────────
const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// Idempotent baseline — the canonical schema is applied by
// admin/src/db/migrate.js at server boot, but tests sometimes import
// this route directly without the migration runner.
db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration REAL,
    hash TEXT NOT NULL,
    conversions_json TEXT DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'ready',
    uploaded_at INTEGER NOT NULL,
    post_refs_json TEXT DEFAULT '[]',
    storage_path TEXT,
    alt_text TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
  CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash);
  CREATE INDEX IF NOT EXISTS idx_media_mime ON media(mime_type);
  -- NOTE: the partial UNIQUE index on storage_path is created by migration
  -- 009, NOT here. This inline baseline can run at import against an
  -- already-existing (pre-009) media table that lacks the column, so
  -- creating the index here would throw "no such column: storage_path".

  -- Phase 5: idempotent mirror of migration 003 so tests that import
  -- this router without invoking the migration runner still find the
  -- conversion_jobs table they need.
  CREATE TABLE IF NOT EXISTS conversion_jobs (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    queued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    error TEXT,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON conversion_jobs(status, queued_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_media ON conversion_jobs(media_id);
`);

// ── Multer ────────────────────────────────────────────────────────
// We stage uploads in the OS tmpdir; the upload handler then moves the
// file to its final hash-prefixed location (or unlinks if the hash
// dedups against an existing row).
const tmpStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = join(tmpdir(), 't80-media-stage');
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => {
    cb(null, `${nanoid()}.part`);
  },
});

const upload = multer({
  storage: tmpStorage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    if (isDeniedExtension(file.originalname)) {
      // Tag the error so the route handler can return 415 (vs Multer's
      // default 500). We don't write any bytes for denied extensions.
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`File extension is not allowed: ${file.originalname}`)
      );
      err.code = 'MEDIA_DENIED_EXT';
      cb(err);
      return;
    }
    cb(null, true);
  },
});

// ── Helpers ───────────────────────────────────────────────────────
/**
 * Hash a file on disk by streaming it through sha256. Resolves with the
 * hex digest. Keeps memory flat regardless of file size.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Best-effort image dimensions. Returns `{ width, height }` or empty
 * object for non-images / parser failures.
 *
 * @param {string} path
 * @returns {{ width?: number, height?: number }}
 */
function readImageDimensions(path) {
  try {
    const buf = readFileSync(path);
    const dims = imageSize(buf);
    if (dims && typeof dims.width === 'number' && typeof dims.height === 'number') {
      return { width: dims.width, height: dims.height };
    }
  } catch {
    // Treat as non-image / unsupported; the row just has NULL dims.
  }
  return {};
}

/**
 * Shape a DB row for the API. Keeps the column names mostly intact and
 * adds the derived `type` bucket + public `url` path.
 *
 * @param {Record<string, any>} row
 */
function shapeMedia(row) {
  if (!row) return null;
  const type = classifyMime(row.mime_type);
  const category = type === 'image' ? 'images' : 'files';
  // Backfilled rows store the file's real path relative to the media root
  // (e.g. images/2025/12/image.webp); that wins over the uploaded_at +
  // filename derivation used for ordinary CMS uploads.
  const url = row.storage_path
    ? `/${row.storage_path}`
    : `/${category}/${derivePathFromUploadedAt(row.uploaded_at)}/${row.filename}`;
  let conversions;
  try {
    conversions = JSON.parse(row.conversions_json || '{}');
  } catch {
    conversions = {};
  }
  return {
    id: row.id,
    filename: row.filename,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    hash: row.hash,
    hash_prefix: String(row.hash || '').slice(0, 8),
    type,
    url,
    storage_path: row.storage_path || null,
    status: row.status,
    uploaded_at: row.uploaded_at,
    conversions,
    alt_text: row.alt_text || null,
  };
}

/**
 * Reverse-derive `yyyy/mm` from the recorded upload timestamp. We store
 * the absolute filename only; the year/month path segment is implied by
 * the upload date so the URL stays stable even if the row is renamed.
 *
 * @param {number} uploadedAt epoch ms
 * @returns {string}
 */
function derivePathFromUploadedAt(uploadedAt) {
  const d = new Date(uploadedAt || Date.now());
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Resolve the on-disk path for a media row.
 *
 * @param {Record<string, any>} row
 * @returns {string}
 */
function diskPathFor(row) {
  if (row.storage_path) return join(MEDIA_ROOT, row.storage_path);
  const type = classifyMime(row.mime_type);
  const category = type === 'image' ? 'images' : 'files';
  return join(MEDIA_ROOT, category, derivePathFromUploadedAt(row.uploaded_at), row.filename);
}

// ── "Used in" post scan ───────────────────────────────────────────
// Responsive variants share a base-name prefix (e.g. name.webp +
// name-320w.webp + name-640w.avif + name-thumb.webp). To decide which
// post a media row belongs to we match the row's URL *or any of its
// variant URLs* against the URLs referenced in post bodies + cover
// frontmatter. Both sides are reduced to a "variant base key"
// (directory + base name, minus the variant suffix + extension) so a
// post that references only a `-320w` variant still credits the base
// asset (and vice-versa).
//
// NOTE: the suffix list is deliberately narrow (`\d+w`, `thumb`,
// `\d+x\d+`) so legitimate name parts like `image-19` or `image-18-1`
// are NOT mistaken for variants. dedupe-media.js mirrors this helper.
/**
 * @param {string} url public path, e.g. `/images/2025/12/name-320w.webp`
 * @returns {string}
 */
function variantBaseKey(url) {
  const slash = url.lastIndexOf('/');
  const dir = url.slice(0, slash + 1);
  let name = url.slice(slash + 1).replace(/\.[a-z0-9]+$/i, '');
  // Strip responsive/derived suffixes so a post that references a variant
  // resolves to the base asset: image widths (-320w), thumbs, NxN crops,
  // and the audio/video transcodes (-h264/-vp9/-poster) — without the last
  // group, posts embedding a -h264.mp4 / -poster.jpg looked "unused" and
  // could be deleted out from under a published post.
  name = name.replace(/-(?:\d+w|thumb|\d+x\d+|h264|vp9|poster)$/i, '');
  return dir + name;
}

/**
 * One pass over the posts directory → map(variantBaseKey → [{ filename,
 * title }]). Built once per request by the list/detail handlers and
 * reused for every item (never re-scanned per row). Title comes from
 * frontmatter `title:`; falls back to the filename sans `.md`.
 *
 * @param {string} postsDir
 * @returns {Map<string, { filename: string, title: string }[]>}
 */
function buildUsageMap(postsDir) {
  /** @type {Map<string, { filename: string, title: string }[]>} */
  const map = new Map();
  let files;
  try {
    files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return map;
  }
  // Matches both body image URLs and `cover: /images/…` frontmatter.
  const urlRe = /\/(?:images|files)\/[A-Za-z0-9_./-]+/g;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(postsDir, file), 'utf8');
    } catch {
      continue;
    }
    let title = file.replace(/\.md$/, '');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const t = fm[1].match(/^title:\s*['"]?(.*?)['"]?\s*$/m);
      if (t && t[1].trim()) title = t[1].trim();
    }
    /** @type {Set<string>} */
    const keys = new Set();
    let m;
    while ((m = urlRe.exec(text)) !== null) keys.add(variantBaseKey(m[0]));
    for (const key of keys) {
      const arr = map.get(key) || [];
      if (!arr.some((e) => e.filename === file)) arr.push({ filename: file, title });
      map.set(key, arr);
    }
  }
  return map;
}

/**
 * Look up the posts that reference a media URL (or any of its variants).
 *
 * @param {string} url
 * @param {Map<string, { filename: string, title: string }[]>} usageMap
 * @returns {{ filename: string, title: string }[]}
 */
function usedInFor(url, usageMap) {
  const arr = usageMap.get(variantBaseKey(url));
  return arr ? arr.slice() : [];
}

// Phase 5: pick a job type for the asset and enqueue it. SVGs flow
// through `image` too because the handler sanitizes them inline. GIFs
// route to `image` first so we can read metadata; the image handler
// detects animated frames and queues a follow-up `gif` job for the
// Phase 5b ffmpeg transcoder. Video/audio enqueue their own ffmpeg job
// directly (image classification doesn't apply).
//
// Phase 5c adds three more job types:
//   - PDFs (mime application/pdf) → `pdf` (poppler cover + thumb)
//   - Archives (classifyMime → 'archive') → `archive` (yauzl listing)
//   - Source files (extension allowlist via isCodeFile) → `code`
//     (shiki preview + plaintext fallback)
//
// Returns true when a job was queued (so the upload handler can mark
// `media.status='processing'`).
/**
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
function enqueueConversion(row) {
  const type = classifyMime(row.mime_type);
  /** @type {'image' | 'video' | 'audio' | 'pdf' | 'code' | 'archive' | null} */
  let jobType = null;
  if (type === 'image') jobType = 'image';
  else if (type === 'video') jobType = 'video';
  else if (type === 'audio') jobType = 'audio';
  else if (String(row.mime_type || '').toLowerCase() === 'application/pdf') jobType = 'pdf';
  else if (type === 'archive') jobType = 'archive';
  else if (isCodeFile(row.original_name) || isCodeFile(row.filename)) jobType = 'code';
  if (!jobType) return false;
  try {
    enqueueJob(row.id, jobType, { db });
    return true;
  } catch (err) {
    console.warn('[media] conversion enqueue failed:', err);
    return false;
  }
}

// ── Routes ────────────────────────────────────────────────────────

/**
 * POST /api/media/upload — multipart, multi-file.
 * Field: `files` (multer.array). For one-file compatibility we also
 * accept the legacy `file` field that Phase 2 used.
 */
router.post('/upload', (req, res, next) => {
  const handler = upload.array('files', 25);
  handler(req, res, (err) => {
    if (err) return handleMulterError(err, res);
    // Fallback for legacy single-`file` clients (Phase 2 admin/editor).
    if ((!req.files || !(/** @type {any[]} */ (req.files).length)) && !req.file) {
      // Re-run multer with the legacy field name. We do this in two
      // passes so existing callers don't need to change anything.
      return upload.single('file')(req, res, (legacyErr) => {
        if (legacyErr) return handleMulterError(legacyErr, res);
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        finalizeUploads([req.file], res).catch(next);
      });
    }
    const files = /** @type {any[]} */ (req.files || (req.file ? [req.file] : []));
    finalizeUploads(files, res).catch(next);
  });
});

/**
 * @param {Error & { code?: string, message?: string }} err
 * @param {import('express').Response} res
 */
function handleMulterError(err, res) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'File too large',
      max_bytes: MAX_UPLOAD_SIZE,
      message: `Files must be ${formatBytes(MAX_UPLOAD_SIZE)} or smaller.`,
    });
  }
  if (err && err.code === 'MEDIA_DENIED_EXT') {
    return res.status(415).json({ error: 'denied_extension', message: err.message });
  }
  return res.status(400).json({ error: err?.message || 'Upload failed' });
}

/**
 * Finalize a batch of staged uploads: hash, dedup, move into place, and
 * insert DB rows. Always cleans up the staging file (move or unlink).
 *
 * @param {any[]} files Multer file records (path, originalname, mimetype, size)
 * @param {import('express').Response} res
 */
async function finalizeUploads(files, res) {
  /** @type {ReturnType<typeof shapeMedia>[]} */
  const results = [];
  /** @type {{ file: string, error: string }[]} */
  const errors = [];

  for (const file of files) {
    try {
      const hash = await hashFile(file.path);
      // Dedup check — same hash, return the existing record.
      const existing = db.prepare('SELECT * FROM media WHERE hash = ?').get(hash);
      if (existing) {
        try {
          unlinkSync(file.path);
        } catch {
          /* tmp cleanup is best-effort */
        }
        results.push(shapeMedia(existing));
        continue;
      }

      const now = new Date();
      const { filename, relativeDir, relativePath } = computeStoragePath({
        mime: file.mimetype,
        hash,
        originalName: file.originalname,
        now,
      });
      const targetDir = join(MEDIA_ROOT, relativeDir);
      mkdirSync(targetDir, { recursive: true });
      const targetPath = join(MEDIA_ROOT, relativePath);

      // Atomic-ish move. `rename` works across same fs; if tmp and site
      // happen to live on different filesystems, fall back to a copy.
      try {
        renameSync(file.path, targetPath);
      } catch (renameErr) {
        if (/** @type {any} */ (renameErr).code === 'EXDEV') {
          await copyAcrossFs(file.path, targetPath);
          try {
            unlinkSync(file.path);
          } catch {
            /* ignore */
          }
        } else {
          throw renameErr;
        }
      }

      const dims = readImageDimensions(targetPath);
      const id = nanoid();
      const uploadedAt = now.getTime();

      db.prepare(
        `INSERT INTO media (
            id, filename, original_name, mime_type, size,
            width, height, duration, hash,
            conversions_json, status, uploaded_at, post_refs_json, storage_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, '[]', NULL)`,
      ).run(
        id,
        filename,
        file.originalname,
        file.mimetype,
        file.size,
        dims.width ?? null,
        dims.height ?? null,
        null,
        hash,
        'ready',
        uploadedAt,
      );

      const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
      // Phase-5 hook — flip status if a conversion was queued.
      try {
        if (enqueueConversion(row)) {
          db.prepare("UPDATE media SET status = 'processing' WHERE id = ?").run(id);
          row.status = 'processing';
        }
      } catch (hookErr) {
        // Don't fail the upload because the (future) queue is unhappy.
        console.warn('[media] conversion enqueue failed:', hookErr);
      }
      results.push(shapeMedia(row));
    } catch (err) {
      console.error('[media] upload failed:', err);
      errors.push({ file: file.originalname, error: err.message });
      try {
        unlinkSync(file.path);
      } catch {
        /* ignore */
      }
    }
  }

  invalidatePostRefs(); // a new upload doesn't change refs, but be safe

  // Legacy single-file callers (Phase 2 editor) expect `{ success, url,
  // filename }`. Detect by checking if exactly one file was uploaded
  // via the `file` field — Multer's `req.file` vs `req.files` was our
  // dispatch signal earlier, so honor it here too.
  if (results.length === 1 && errors.length === 0 && results[0]) {
    return res.json({
      success: true,
      url: results[0].url,
      filename: results[0].filename,
      file: results[0],
      files: results,
    });
  }

  res.status(errors.length && !results.length ? 400 : 200).json({
    files: results,
    errors,
  });
}

/**
 * @param {string} src
 * @param {string} dst
 * @returns {Promise<void>}
 */
function copyAcrossFs(src, dst) {
  return new Promise((resolve, reject) => {
    const r = createReadStream(src);
    const w = createWriteStream(dst);
    r.on('error', reject);
    w.on('error', reject);
    w.on('finish', () => resolve());
    r.pipe(w);
  });
}

/**
 * @param {number} n
 */
function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * GET /api/media — list with filters.
 * Query:
 *   ?type=image|video|audio|document|archive|other
 *   ?q=<search> (matches original_name)
 *   ?sort=date|name|size (default: date)
 *   ?page=1   ?limit=50  (max 200)
 */
router.get('/', (req, res) => {
  const type = String(req.query.type || '').toLowerCase();
  const q = String(req.query.q || '').trim();
  const sort = String(req.query.sort || 'date');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200);
  const page = Math.max(parseInt(String(req.query.page), 10) || 1, 1);

  const where = [];
  const args = [];
  if (type) {
    // Convert bucket → MIME predicate. For document/archive/other we
    // don't have a simple prefix, so we filter in JS after the query.
    if (type === 'image' || type === 'video' || type === 'audio') {
      where.push('mime_type LIKE ?');
      args.push(`${type}/%`);
    }
  }
  if (q) {
    // Escape LIKE wildcards so a query containing % or _ matches literally
    // rather than acting as a wildcard.
    const likeQ = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(original_name LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\')");
    args.push(likeQ, likeQ);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let orderSql;
  switch (sort) {
    case 'name':
      orderSql = 'ORDER BY original_name ASC';
      break;
    case 'size':
      orderSql = 'ORDER BY size DESC';
      break;
    default:
      orderSql = 'ORDER BY uploaded_at DESC';
  }

  // We over-fetch a little when the type filter needs JS-side filtering
  // (document/archive/other), then page in memory. The library is
  // intended for personal-scale use so this is fine; a global LIKE
  // index would be more work than it's worth.
  const needsJsFilter = type === 'document' || type === 'archive' || type === 'other';
  const rows = db.prepare(`SELECT * FROM media ${whereSql} ${orderSql}`).all(...args);
  const filtered = needsJsFilter ? rows.filter((r) => classifyMime(r.mime_type) === type) : rows;

  const total = filtered.length;
  const start = (page - 1) * limit;
  const slice = filtered.slice(start, start + limit);

  // Single post-scan for the whole page (cached per request, never
  // re-scanned per item) → each row gets `used_in: [{ filename, title }]`.
  const usageMap = buildUsageMap(POSTS_DIR);

  res.json({
    items: slice.map((r) => {
      const s = shapeMedia(r);
      s.used_in = usedInFor(s.url, usageMap);
      return s;
    }),
    total,
    page,
    limit,
  });
});

/**
 * GET /api/media/:id — single record with usage list inlined.
 */
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const shaped = shapeMedia(row);
  const usage = postsReferencing(shaped.url);
  const used_in = usedInFor(shaped.url, buildUsageMap(POSTS_DIR));
  res.json({ ...shaped, usage, used_in });
});

/**
 * GET /api/media/:id/usage — list of post filenames referencing the asset.
 */
router.get('/:id/usage', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const shaped = shapeMedia(row);
  res.json({ posts: postsReferencing(shaped.url) });
});

const MAX_ALT_TEXT_LENGTH = 1000;

/**
 * PATCH /api/media/:id — edit asset metadata. Currently the only
 * editable field is `alt_text` (string to set, null/'' to clear).
 * The stored value is the library default the editor inserts with;
 * markdown stays authoritative inside already-published post bodies.
 */
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  if (!('alt_text' in body)) {
    return res.status(400).json({ error: 'no_editable_fields', message: 'Provide alt_text.' });
  }
  const raw = body.alt_text;
  if (raw !== null && typeof raw !== 'string') {
    return res
      .status(400)
      .json({ error: 'invalid_alt_text', message: 'alt_text must be a string or null.' });
  }
  const altText = raw === null ? null : raw.trim() || null;
  if (altText && altText.length > MAX_ALT_TEXT_LENGTH) {
    return res.status(400).json({
      error: 'alt_text_too_long',
      message: `Alt text must be ${MAX_ALT_TEXT_LENGTH} characters or fewer.`,
    });
  }

  db.prepare('UPDATE media SET alt_text = ? WHERE id = ?').run(altText, req.params.id);
  const updated = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  res.json(shapeMedia(updated));
});

/**
 * DELETE /api/media/:id — refuses if the asset is referenced by any
 * post unless `?force=true` is set.
 */
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const shaped = shapeMedia(row);
  // Bypass the cache for delete checks — a stale 60-second usage map
  // could surprise the user. `?force=true` skips the scan entirely.
  invalidatePostRefs();
  const force = String(req.query.force || '').toLowerCase() === 'true';
  const usage = force ? [] : postsReferencing(shaped.url);

  if (usage.length && !force) {
    return res.status(409).json({
      error: 'in_use',
      message: `Referenced by ${usage.length} post${usage.length === 1 ? '' : 's'}.`,
      posts: usage,
    });
  }

  // Best-effort unlink — a missing file shouldn't block the row delete.
  try {
    unlinkSync(diskPathFor(row));
  } catch (err) {
    console.warn('[media] unlink failed (continuing):', err.message);
  }
  db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id);
  invalidatePostRefs();
  res.status(204).end();
});

/**
 * POST /api/media/:id/retry — re-queue the most recent conversion job
 * for the given media row. Returns 200 on success, 404 if no job exists
 * for the media, 409 if there's nothing to retry (status already 'ready'
 * with no pending work).
 *
 * The retry resets `attempt=0` and `queued_at=now()`. Phase 5 worker
 * picks it up on the next 1 Hz tick.
 */
router.post('/:id/retry', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const job = latestJobForMedia(req.params.id, { db });
  if (!job) {
    // No prior job — start a fresh one if the asset still warrants one
    // (e.g. an image upload that somehow skipped enqueue, or a re-queue
    // of a video/audio whose original job row was pruned).
    const cls = classifyMime(row.mime_type);
    /** @type {'image' | 'video' | 'audio' | 'pdf' | 'code' | 'archive' | null} */
    let fallback = null;
    if (cls === 'image') fallback = 'image';
    else if (cls === 'video') fallback = 'video';
    else if (cls === 'audio') fallback = 'audio';
    else if (String(row.mime_type || '').toLowerCase() === 'application/pdf') fallback = 'pdf';
    else if (cls === 'archive') fallback = 'archive';
    else if (isCodeFile(row.original_name) || isCodeFile(row.filename)) fallback = 'code';
    if (fallback) {
      const queued = enqueueJob(row.id, fallback, { db });
      return res.json({ retried: true, job_id: queued.id });
    }
    return res.status(409).json({ error: 'no_job_for_media' });
  }
  retryJob(job.id, { db });
  res.json({ retried: true, job_id: job.id });
});

// ── Phase 2 compat: list-as-array endpoint ────────────────────────
// The Phase 2 editor sidebar (`admin/public/js/media.js` pre-rewrite)
// called `GET /api/media` and expected `[ { url, filename, date, size } ]`.
// The new endpoint returns `{ items, total, page, limit }`. Browsers
// caching the old admin bundle would break — we keep the legacy shape
// behind `?legacy=1` and let the Phase 4 frontend opt in to the new
// envelope.
router.get('/legacy/list', (_req, res) => {
  const rows = db.prepare('SELECT * FROM media ORDER BY uploaded_at DESC LIMIT 100').all();
  res.json(
    rows.map((r) => {
      const s = shapeMedia(r);
      return {
        url: s.url,
        filename: s.filename,
        date: new Date(r.uploaded_at).toISOString(),
        size: r.size,
      };
    }),
  );
});

// ── Local utilities exposed for tests ─────────────────────────────
// Tests import the router and exercise it via supertest-style fetch;
// the `__db` handle lets a test seed rows or assert state cheaply
// without re-opening the file.
export const __testInternals = {
  db,
  hashFile,
  shapeMedia,
  diskPathFor,
  statSync,
};

export default router;
