// @ts-check
/**
 * image.js — Phase 5a image conversion handler.
 *
 * Inputs:  one media row (FK → media table).
 * Outputs: WebP + AVIF variants at widths 320/640/1024/1920, a 240px
 *          WebP thumbnail, and metadata (width/height/format) written
 *          back to the media row via `mediaPatch`. SVG uploads are
 *          sanitized in place (DOMPurify + jsdom) — never any other
 *          conversion. Animated GIFs detect frames>1, record metadata,
 *          and queue a `gif` placeholder for Phase 5b (ffmpeg).
 *
 * EXIF stripping: sharp removes EXIF by default unless `.withMetadata()`
 * is called. We never call it, so the web variants are clean. Originals
 * are untouched.
 *
 * The handler is a pure function over `{ row, paths, services }` — no
 * imports of the global queue — so the test suite can call it directly
 * with a hand-rolled fixture row.
 */

import sharp from 'sharp';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { readFileSync, writeFileSync, statSync } from 'fs';
import { dirname, basename, extname, join, sep } from 'path';

// Cap sharp's internal cache + threads so MAX_CONCURRENCY=2 workers don't
// spawn 16 sharp threads under the hood on a Pi. Worker concurrency is
// the only knob we want users to tune.
sharp.cache(false);
sharp.concurrency(1);

/** Widths produced for raster images. Skipped if larger than source. */
export const WIDTHS = [320, 640, 1024, 1920];
/** WebP encode quality. 82 is the typical sweet-spot vs JPEG. */
const WEBP_QUALITY = 82;
/**
 * AVIF encode quality + effort. Effort 6 is the libheif preset; the
 *  Pi may want effort=4 once we Lighthouse-test (Phase 11).
 */
const AVIF_QUALITY = 64;
const AVIF_EFFORT = 6;
/** Width of the library thumbnail. */
const THUMB_WIDTH = 240;

// One JSDOM instance shared across calls — DOMPurify wants a window
// reference and the construction is the slowest bit of svg sanitization.
const SVG_WINDOW = new JSDOM('').window;
const purify = createDOMPurify(/** @type {any} */ (SVG_WINDOW));

/**
 * Drive the image pipeline for one media row.
 *
 * @param {{
 *   row: Record<string, any>,
 *   diskPath: string,                       // absolute path to the original
 *   urlBase: string,                        // url prefix ('/images/yyyy/mm')
 *   diskDir: string,                        // dir on disk ('/site/static/images/yyyy/mm')
 *   enqueueFollowupJob?: (mediaId: string, type: string) => void,
 * }} ctx
 * @returns {Promise<{ conversions: Record<string, string>, mediaPatch: Record<string, any> }>}
 */
export async function processImage(ctx) {
  const { row, diskPath, urlBase, diskDir, enqueueFollowupJob } = ctx;
  const mime = String(row.mime_type || '').toLowerCase();
  /** @type {Record<string, string>} */
  const conversions = {};
  /** @type {Record<string, any>} */
  const mediaPatch = {};

  // ── SVG ────────────────────────────────────────────────────
  // Sanitize in place. We never produce thumbs/variants for SVG; the
  // browser renders the source. The on-disk overwrite is the only step
  // that's load-bearing — without it, a malicious upload would persist.
  if (mime === 'image/svg+xml' || diskPath.toLowerCase().endsWith('.svg')) {
    const raw = readFileSync(diskPath, 'utf8');
    const clean = purify.sanitize(raw, {
      USE_PROFILES: { svg: true, svgFilters: true },
      // Make sure script/foreignObject and event-handlers can never sneak
      // back in if a future DOMPurify default loosens up.
      FORBID_TAGS: ['script', 'foreignObject'],
      FORBID_ATTR: ['onload', 'onerror', 'onclick'],
    });
    writeFileSync(diskPath, String(clean), 'utf8');
    return { conversions, mediaPatch };
  }

  // ── Raster decode ──────────────────────────────────────────
  // We re-read the file on each variant write rather than caching the
  // decoded buffer, because sharp's encode pipeline mutates internal
  // state and reusing a Sharp instance is order-dependent. Disk I/O is
  // cheap compared to JPEG decode + AVIF encode.
  const inputBuffer = readFileSync(diskPath);
  const probe = sharp(inputBuffer, { failOn: 'none' });
  const meta = await probe.metadata();
  const srcWidth = meta.width || 0;
  const srcHeight = meta.height || 0;
  const isAnimated = (meta.pages || 1) > 1 || meta.format === 'gif';

  if (srcWidth > 0 && srcHeight > 0) {
    mediaPatch.width = srcWidth;
    mediaPatch.height = srcHeight;
  }

  // Animated GIF: do not slice frames, just enqueue the 5b placeholder.
  // The original GIF is preserved on disk.
  if (meta.format === 'gif' && isAnimated) {
    if (typeof enqueueFollowupJob === 'function') {
      try {
        enqueueFollowupJob(row.id, 'gif');
      } catch {
        /* swallow — the placeholder is best-effort */
      }
    }
    return { conversions, mediaPatch };
  }

  // ── HEIC / HEIF → JPEG fallback ────────────────────────────
  // The original HEIC is kept on disk (some browsers will eventually
  // support it, and the Hugo build will reference both via <picture>).
  // The fallback JPEG becomes a first-class conversion entry.
  let workingPath = diskPath;
  let workingBuffer = inputBuffer;
  const isHeic =
    meta.format === 'heif' ||
    mime === 'image/heic' ||
    mime === 'image/heif' ||
    /\.(heic|heif)$/i.test(diskPath);
  if (isHeic) {
    const jpgName = `${stripExt(basename(diskPath))}.jpg`;
    const jpgPath = join(diskDir, jpgName);
    await sharp(inputBuffer, { failOn: 'none' })
      .rotate() // honor EXIF orientation before stripping
      .jpeg({ quality: 92, progressive: true, mozjpeg: true })
      .toFile(jpgPath);
    conversions['heic-converted-jpg'] = `${urlBase}/${jpgName}`;
    // Subsequent variants are produced from the JPEG so browsers without
    // libheif (i.e. everyone) actually have a source they can decode.
    workingPath = jpgPath;
    workingBuffer = readFileSync(jpgPath);
  }

  // ── Variants (WebP + AVIF × 4 widths) ──────────────────────
  const baseName = stripExt(basename(workingPath));
  for (const w of WIDTHS) {
    if (srcWidth && w > srcWidth) continue; // never upscale
    const webpName = `${baseName}-${w}w.webp`;
    const avifName = `${baseName}-${w}w.avif`;
    const webpPath = join(diskDir, webpName);
    const avifPath = join(diskDir, avifName);

    await sharp(workingBuffer, { failOn: 'none' })
      .rotate()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(webpPath);

    await sharp(workingBuffer, { failOn: 'none' })
      .rotate()
      .resize({ width: w, withoutEnlargement: true })
      .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
      .toFile(avifPath);

    conversions[`webp-${w}`] = `${urlBase}/${webpName}`;
    conversions[`avif-${w}`] = `${urlBase}/${avifName}`;
  }

  // ── Thumbnail (240px WebP) ─────────────────────────────────
  const thumbName = `${baseName}-thumb.webp`;
  const thumbPath = join(diskDir, thumbName);
  await sharp(workingBuffer, { failOn: 'none' })
    .rotate()
    .resize({ width: Math.min(THUMB_WIDTH, srcWidth || THUMB_WIDTH), withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(thumbPath);
  conversions.thumb = `${urlBase}/${thumbName}`;

  return { conversions, mediaPatch };
}

/**
 * Strip the extension (and the dot) from a filename. Multi-dot names
 * like `foo.bar.png` keep the `.bar` segment — we only chop the last.
 *
 * @param {string} name
 */
function stripExt(name) {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/**
 * Tiny helper for the worker: confirm a generated variant actually
 * landed on disk (sharp can swallow some errors silently when libvips
 * runs out of memory on the Pi). Returns true if the file exists and
 * has nonzero bytes.
 *
 * @param {string} path
 */
export function variantWritten(path) {
  try {
    const s = statSync(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

// Surfaced for tests that want to point the SVG sanitizer at a different
// DOMPurify config or call it directly without exercising the file write.
export const __internal = {
  purify,
  WIDTHS,
  WEBP_QUALITY,
  AVIF_QUALITY,
  AVIF_EFFORT,
  THUMB_WIDTH,
  sep, // re-export so callers don't have to import 'path' in tests
  dirname,
  basename,
  extname,
};
