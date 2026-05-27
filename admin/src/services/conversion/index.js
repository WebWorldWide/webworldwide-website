// @ts-check
/**
 * conversion/index.js — handler registry + disk-path resolver.
 *
 * The worker dispatches each job to a handler keyed by `job.type`. New
 * pipelines (Phase 5b ffmpeg, Phase 5c PDF/code/archive) plug in here:
 * import their handler, drop it in the `handlers` map.
 *
 * Each handler is `async (ctx) => { conversions, mediaPatch }` where:
 *   ctx.row              — the parent media row
 *   ctx.diskPath         — absolute path to the original
 *   ctx.urlBase          — public URL prefix for the asset's directory
 *   ctx.diskDir          — absolute on-disk directory
 *   ctx.enqueueFollowupJob — optional callback for follow-up work
 *
 * `conversions` is merged into `media.conversions_json`; `mediaPatch`
 * can patch width/height/duration/mime_type on the media row.
 */

import { dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

import { processImage } from './image.js';
import { processVideo } from './video.js';
import { processAudio } from './audio.js';
import { processGifVideo } from './gif.js';
import { processPdf } from './pdf.js';
import { processCode } from './code.js';
import { processArchive } from './archive.js';
import { classifyMime } from '../../utils/mediaTypes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Handler registry. Keys mirror the `type` column in `conversion_jobs`.
 *
 * @type {Record<string, (ctx: any) => Promise<{ conversions: Record<string, string>, mediaPatch: Record<string, any> } | void>>}
 */
export const handlers = {
  image: processImage,
  // Phase 5b — ffmpeg-backed A/V transcoders + animated-GIF→video.
  video: processVideo,
  audio: processAudio,
  gif: processGifVideo,
  // Phase 5c — PDF cover/thumb (poppler), source-file syntax highlight
  // (shiki), archive entry listing (yauzl).
  pdf: processPdf,
  code: processCode,
  archive: processArchive,
};

/**
 * Extensions that route to the `code` handler. Detection is purely by
 * filename suffix — many code uploads arrive with `application/
 * octet-stream` from browsers that don't recognize the type, so MIME
 * sniffing isn't reliable here.
 *
 * @type {ReadonlySet<string>}
 */
export const CODE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
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
  '.html',
  '.css',
  '.scss',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.md',
  '.txt',
  '.sh',
  '.bash',
  '.sql',
  '.diff',
  '.patch',
]);

/**
 * True iff the filename's extension is in the code allowlist. The
 * upload denylist (`.sh`, `.bash`, etc. would actually block shell
 * scripts at the multer layer) takes precedence — the media route
 * still calls `isDeniedExtension` first.
 *
 * @param {string} filename
 */
export function isCodeFile(filename) {
  const ext = extname(String(filename || '')).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

/**
 * Take a job row + DB handle, find the media row, and compute the
 * disk/url paths the handler needs. Returns null if the media row was
 * deleted between enqueue and run (the worker treats that as a hard
 * fail, but it's NOT something we want to retry).
 *
 * @param {Record<string, any>} job
 * @param {import('better-sqlite3').Database} db
 */
export function resolveDiskContext(job, db) {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(job.media_id);
  if (!row) return null;
  const siteDir = process.env.SITE_DIR || join(__dirname, '..', '..', '..', '..', 'site');
  const staticDir = join(siteDir, 'static');
  const type = classifyMime(row.mime_type);
  const category = type === 'image' ? 'images' : 'files';
  const yyyymm = derivePathFromUploadedAt(row.uploaded_at);
  const diskDir = join(staticDir, category, yyyymm);
  const diskPath = join(diskDir, row.filename);
  const urlBase = `/${category}/${yyyymm}`;
  if (!existsSync(diskPath)) return null;
  return { row, diskPath, diskDir, urlBase };
}

/**
 * @param {number} uploadedAt
 */
function derivePathFromUploadedAt(uploadedAt) {
  const d = new Date(uploadedAt || Date.now());
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Barrel re-exports for callers that prefer a one-stop import.
export {
  enqueueJob,
  claimNext,
  markDone,
  markFailed,
  retryJob,
  latestJobForMedia,
  debugStats,
} from './queue.js';
export { startWorker, stopWorker, drainOnce, bindShutdownSignals } from './worker.js';
