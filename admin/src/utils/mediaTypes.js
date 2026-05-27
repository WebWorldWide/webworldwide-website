// @ts-check
/**
 * mediaTypes.js — MIME classification, extension denylist, and filename
 * sanitization shared between the media route, the post-refs scanner,
 * and the (future) Phase 5 conversion pipeline.
 *
 * Buckets used by the library UI's type filter:
 *   image      image/*
 *   video      video/*
 *   audio      audio/*
 *   document   PDFs, Office docs, markdown, plain text, json
 *   archive    zip, tar, 7z, rar
 *   other      anything else (binaries, fonts, ICS calendars, etc.)
 *
 * The denylist blocks known-malicious extensions before we even hit
 * disk. This isn't a security boundary on its own — Multer still saves
 * the file under a random hash-prefixed name and the static serve uses
 * a fixed dispositional header — but it stops the most common upload
 * vectors with a clear 415 instead of a stored-but-unservable blob.
 */

/** @type {ReadonlySet<string>} */
export const DENYLIST_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.ps1',
  '.scr',
  '.com',
  '.vbs',
  '.msi',
  '.dll',
]);

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/markdown',
  'text/plain',
  'text/csv',
  'application/json',
]);

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
]);

/**
 * @param {string} mime
 * @returns {'image' | 'video' | 'audio' | 'document' | 'archive' | 'other'}
 */
export function classifyMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (DOCUMENT_MIMES.has(m)) return 'document';
  if (ARCHIVE_MIMES.has(m)) return 'archive';
  return 'other';
}

/**
 * True iff the *file extension* (including the leading dot, e.g. `.exe`)
 * is in the denylist. The comparison is case-insensitive.
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isDeniedExtension(filename) {
  const lower = String(filename || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return DENYLIST_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Turn a user-supplied filename into a safe disk component. Lowercases,
 * replaces every non-alphanumeric run with a single dash, trims dashes,
 * and caps the basename at 60 characters (extension is preserved
 * separately and capped at 10).
 *
 * @param {string} filename
 * @returns {{ base: string, ext: string }}
 */
export function safeFilenameParts(filename) {
  const raw = String(filename || 'file').trim();
  const dot = raw.lastIndexOf('.');
  const rawBase = dot > 0 ? raw.slice(0, dot) : raw;
  const rawExt = dot > 0 ? raw.slice(dot + 1) : '';
  const base =
    rawBase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'file';
  const ext = rawExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 10);
  return { base, ext };
}

/**
 * Build the storage-relative path for an upload. Images go under
 * `images/yyyy/mm/`, everything else under `files/yyyy/mm/`. The
 * filename is `<hashPrefix>-<safeBase>.<ext>` (extension omitted if the
 * upload had none).
 *
 * @param {{ mime: string, hash: string, originalName: string, now?: Date }} args
 * @returns {{ filename: string, relativeDir: string, relativePath: string, urlPath: string, category: 'images' | 'files' }}
 */
export function computeStoragePath({ mime, hash, originalName, now }) {
  const d = now || new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const category = classifyMime(mime) === 'image' ? 'images' : 'files';
  const { base, ext } = safeFilenameParts(originalName);
  const prefix = String(hash || '').slice(0, 8) || 'nohash00';
  const filename = ext ? `${prefix}-${base}.${ext}` : `${prefix}-${base}`;
  const relativeDir = `${category}/${yyyy}/${mm}`;
  const relativePath = `${relativeDir}/${filename}`;
  return {
    filename,
    relativeDir,
    relativePath,
    urlPath: `/${relativePath}`,
    category,
  };
}
