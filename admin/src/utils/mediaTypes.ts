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
  // Script-capable web types: an uploaded .svg/.html/etc. is committed and then
  // served by GitHub Pages (no CSP), so it would execute in a visitor's browser
  // on the site origin (stored XSS). None are needed as blog media — raster
  // covers go through the AVIF/WebP convert pipeline. (Re-enable .svg only with
  // server-side sanitization.)
  '.svg',
  '.svgz',
  '.html',
  '.htm',
  '.xhtml',
  '.xml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.wasm',
  '.shtml',
  '.xht',
  '.xsl',
  '.xslt',
  '.htc',
  '.mht',
  '.mhtml',
]);

/**
 * Every extension the media library accepts. Anything else is refused at
 * upload time (415). Keep HTML-/script-capable types OUT of this list.
 * @type {ReadonlySet<string>}
 */
export const ALLOWED_EXTENSIONS = new Set([
  // images
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.heic',
  '.heif',
  '.ico',
  '.bmp',
  '.tif',
  '.tiff',
  // video
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  // audio
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  // documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.rtf',
  '.epub',
  // archives
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  // fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  // source code shown via the highlighter (served as downloads, never executed)
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.css',
  '.scss',
  '.yml',
  '.yaml',
  '.toml',
  '.sql',
  '.swift',
  '.kt',
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
  // Normalize the SAME way the on-disk name is derived (safeFilenameParts trims),
  // then strip trailing dots/whitespace, so `evil.html ` / `evil.svg\t` / `evil.js.`
  // can't smuggle the live extension past the check while landing on disk as
  // the real, servable type.
  const lower = String(filename || '')
    .toLowerCase()
    .trim()
    .replace(/[\s.]+$/, '');
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return true; // no extension → refuse (can't reason about it)
  const ext = lower.slice(dot);
  if (DENYLIST_EXTENSIONS.has(ext)) return true;
  // Allowlist (2026-11): a denylist kept missing script-capable types
  // (.shtml, .mjs, .xsl, .htc…), each a stored-XSS vector on the admin origin
  // and on GitHub Pages. Only known media/document/code types are accepted.
  return !ALLOWED_EXTENSIONS.has(ext);
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
