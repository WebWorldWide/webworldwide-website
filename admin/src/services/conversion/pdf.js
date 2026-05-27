// @ts-check
/**
 * pdf.js — Phase 5c PDF preview generation.
 *
 * Pipeline (per upload):
 *   1. pdfinfo — extract page count, title, author, creation date.
 *      Encrypted PDFs print "Encrypted: yes" and refuse content access;
 *      we surface that as a hard fail with a clear message.
 *   2. pdftoppm -jpeg — render page 1 at 1024px wide → "cover" image.
 *   3. pdftoppm -jpeg — render page 1 at 320px wide → library "thumb".
 *   4. image-size on the cover → patch media.width/height.
 *
 * conversions_json shape:
 *   {
 *     "cover":      "/files/yyyy/mm/...-cover.jpg",
 *     "thumb":      "/files/yyyy/mm/...-thumb.jpg",
 *     "page_count": 12,
 *     "title":      "…",     // optional, only if pdfinfo found one
 *     "author":     "…",     // optional
 *     "created_at": "…"      // optional ISO-ish string from pdfinfo
 *   }
 *
 * The original PDF is preserved at its canonical path — none of the
 * outputs touch it.
 *
 * Tool availability: the worker only succeeds if poppler-utils is on
 * PATH. In the Alpine container that's `apk add poppler-utils`; on the
 * macOS dev host, `brew install poppler`. If the tool is missing we
 * throw an obviously-wrong error so the queue's failure path stores
 * something a human can grep.
 */

import { spawn } from 'child_process';
import { basename, extname, join } from 'path';
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { imageSize } from 'image-size';

/** Cover image max width (px). */
const COVER_WIDTH = 1024;
/** Library thumbnail width (px). */
const THUMB_WIDTH = 320;
/**
 * Hard cap on individual subprocess runtime. PDFs over a few hundred
 * pages can blow past this; the user can retry the conversion job to
 * pick up where we left off.
 */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/**
 * Drive the PDF pipeline for one media row.
 *
 * @param {{
 *   row: Record<string, any>,
 *   diskPath: string,
 *   urlBase: string,
 *   diskDir: string,
 *   enqueueFollowupJob?: (mediaId: string, type: string) => void,
 * }} ctx
 * @returns {Promise<{ conversions: Record<string, any>, mediaPatch: Record<string, any> }>}
 */
export async function processPdf(ctx) {
  const { diskPath, urlBase, diskDir } = ctx;

  const info = await pdfInfo(diskPath);
  if (info.encrypted) {
    throw new Error('PDF is encrypted — preview generation refused');
  }
  if (!info.pages || info.pages < 1) {
    throw new Error('PDF has no pages (empty or corrupt)');
  }

  const baseName = stripExt(basename(diskPath));
  const coverName = `${baseName}-cover.jpg`;
  const thumbName = `${baseName}-thumb.jpg`;
  const coverPath = join(diskDir, coverName);
  const thumbPath = join(diskDir, thumbName);

  // pdftoppm writes <prefix>-<page>.jpg (or -01.jpg with zero-pad
  // depending on version + page count). We render to a unique prefix
  // and then move the single produced file to the canonical name so the
  // URL we record in conversions_json doesn't depend on the suffix
  // pdftoppm picked. The cover/thumb prefixes deliberately do NOT end
  // in `-cover` / `-thumb` so we can disambiguate from a same-named
  // user upload sitting in the dir.
  const coverPrefix = join(diskDir, `.${baseName}-pdfcover`);
  const thumbPrefix = join(diskDir, `.${baseName}-pdfthumb`);

  await renderFirstPage(diskPath, coverPrefix, COVER_WIDTH);
  await renderFirstPage(diskPath, thumbPrefix, THUMB_WIDTH);

  // pdftoppm tacks on the page number. Find whichever variant landed.
  const coverProduced = findPdftoppmOutput(diskDir, basename(coverPrefix));
  const thumbProduced = findPdftoppmOutput(diskDir, basename(thumbPrefix));
  if (!coverProduced || !thumbProduced) {
    throw new Error('pdftoppm did not produce expected output files');
  }

  // Rename to canonical names. If a previous failed run left stale
  // outputs in place, overwrite them. Same-directory rename is atomic
  // on every POSIX filesystem we care about.
  if (existsSync(coverPath)) unlinkSync(coverPath);
  if (existsSync(thumbPath)) unlinkSync(thumbPath);
  renameSync(coverProduced, coverPath);
  renameSync(thumbProduced, thumbPath);

  /** @type {Record<string, any>} */
  const mediaPatch = {};
  try {
    const dims = imageSize(readFileSync(coverPath));
    if (dims && typeof dims.width === 'number' && typeof dims.height === 'number') {
      mediaPatch.width = dims.width;
      mediaPatch.height = dims.height;
    }
  } catch {
    /* image-size fail on the cover is non-fatal; metadata just stays null */
  }

  /** @type {Record<string, any>} */
  const conversions = {
    cover: `${urlBase}/${coverName}`,
    thumb: `${urlBase}/${thumbName}`,
    page_count: info.pages,
  };
  if (info.title) conversions.title = info.title;
  if (info.author) conversions.author = info.author;
  if (info.createdAt) conversions.created_at = info.createdAt;

  return { conversions, mediaPatch };
}

/**
 * Run `pdfinfo <path>` and parse its key:value output. Returns null
 * pages on parse failure. Captures stderr so the caller can surface
 * the underlying problem in the queue's `error` column.
 *
 * @param {string} pdfPath
 * @returns {Promise<{
 *   pages: number,
 *   encrypted: boolean,
 *   title: string | null,
 *   author: string | null,
 *   createdAt: string | null,
 * }>}
 */
function pdfInfo(pdfPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdfinfo', [pdfPath]);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('pdfinfo timed out'));
    }, SUBPROCESS_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`pdfinfo spawn failed: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const tail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`pdfinfo exited with code ${code}: ${tail || '(no output)'}`));
        return;
      }
      resolve(parsePdfInfo(stdout));
    });
  });
}

/**
 * Tiny key:value parser for pdfinfo's plaintext output. Robust to
 * trailing whitespace and missing fields. Only the keys we care about
 * are surfaced.
 *
 * @param {string} text
 */
function parsePdfInfo(text) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) map[key] = val;
  }
  const pages = parseInt(map.Pages || '0', 10) || 0;
  const encrypted = /^yes/i.test(map.Encrypted || '');
  return {
    pages,
    encrypted,
    title: map.Title || null,
    author: map.Author || null,
    createdAt: map.CreationDate || null,
  };
}

/**
 * Render the first page of a PDF to a JPEG of the given target width.
 * pdftoppm's `-scale-to-x` honors aspect ratio (use `-scale-to-y -1`
 * to lock the other axis; pdftoppm computes height automatically).
 *
 * @param {string} pdfPath
 * @param {string} prefix
 * @param {number} width
 * @returns {Promise<void>}
 */
function renderFirstPage(pdfPath, prefix, width) {
  return new Promise((resolve, reject) => {
    const args = [
      '-jpeg',
      '-f',
      '1',
      '-l',
      '1',
      '-scale-to-x',
      String(width),
      '-scale-to-y',
      '-1',
      pdfPath,
      prefix,
    ];
    const child = spawn('pdftoppm', args);
    let stderr = '';
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('pdftoppm timed out'));
    }, SUBPROCESS_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`pdftoppm spawn failed: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`pdftoppm exited with code ${code}: ${tail || '(no output)'}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * pdftoppm names outputs `<prefix>-<page>.jpg` (or `-NN.jpg` /
 * `-NNN.jpg` depending on total page count). For a single-page render
 * we just need to find whichever variant landed in the directory.
 *
 * @param {string} dir
 * @param {string} prefixName  basename without directory
 * @returns {string | null}
 */
function findPdftoppmOutput(dir, prefixName) {
  const entries = readdirSync(dir);
  // Match `<prefixName>-<digits>.jpg` and `<prefixName>.jpg` (the
  // latter happens on some pdftoppm builds when -l == -f == 1).
  const re = new RegExp(`^${escapeRegex(prefixName)}(-\\d+)?\\.jpg$`);
  for (const name of entries) {
    if (re.test(name)) return join(dir, name);
  }
  return null;
}

/**
 * @param {string} s
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip the extension from a filename. `foo.bar.pdf` → `foo.bar`.
 * @param {string} name
 */
function stripExt(name) {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

export const __internal = {
  parsePdfInfo,
  findPdftoppmOutput,
  COVER_WIDTH,
  THUMB_WIDTH,
};
