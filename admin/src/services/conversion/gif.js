// @ts-check
/**
 * gif.js — Phase 5b animated-GIF transcode handler.
 *
 * Triggered as a follow-up job by the image handler when it detects an
 * animated GIF (`meta.format === 'gif' && pages > 1`). The original
 * GIF is preserved at its canonical path — these conversions sit
 * alongside it so the front end can prefer <video> over <img> for huge
 * loops while still letting old browsers / RSS readers fetch the GIF.
 *
 * Outputs:
 *   - H.264 MP4 (same encoder profile as the video handler — baseline,
 *     yuv420p, faststart). Audio stripped (GIFs are silent).
 *   - VP9 WebM (libvpx-vp9, CRF 32, no audio).
 *   - Poster JPEG (first frame, 320px wide). Lets <video poster=...>
 *     show something nice before user interaction.
 *
 * conversions_json shape:
 *   {
 *     "h264-mp4": "/files/.../...mp4",
 *     "vp9-webm": "/files/.../...webm",
 *     "poster":   "/files/.../...poster.jpg"
 *   }
 */

import { basename, extname, join } from 'path';

import { ffprobe, runFfmpeg } from './ffmpeg.js';
import { __internal as queueInternal } from './queue.js';

const MAX_WIDTH = 1920;
const POSTER_WIDTH = 320;

/**
 * Drive the GIF transcode pipeline for one media row.
 *
 * @param {{
 *   row: Record<string, any>,
 *   diskPath: string,
 *   urlBase: string,
 *   diskDir: string,
 * }} ctx
 * @returns {Promise<{ conversions: Record<string, string>, mediaPatch: Record<string, any> }>}
 */
export async function processGifVideo(ctx) {
  const { row, diskPath, urlBase, diskDir } = ctx;
  const meta = await ffprobe(diskPath);

  /** @type {Record<string, any>} */
  const mediaPatch = {};
  if (meta.duration > 0) mediaPatch.duration = meta.duration;
  if (meta.width > 0) mediaPatch.width = meta.width;
  if (meta.height > 0) mediaPatch.height = meta.height;
  try {
    applyEarlyMetadata(row.id, mediaPatch);
  } catch (err) {
    console.warn('[conversion/gif] early metadata write failed:', err);
  }

  const baseName = stripExt(basename(diskPath));
  // Suffix variants for parity with the video pipeline. Original GIF
  // stays untouched at <baseName>.gif.
  const mp4Name = `${baseName}-h264.mp4`;
  const webmName = `${baseName}-vp9.webm`;
  const posterName = `${baseName}-poster.jpg`;
  const mp4Path = join(diskDir, mp4Name);
  const webmPath = join(diskDir, webmName);
  const posterPath = join(diskDir, posterName);

  // Width/height must be even for libx264 yuv420p — GIFs from Slack /
  // Giphy are frequently odd-pixel. `scale=trunc(iw/2)*2:trunc(ih/2)*2`
  // forces evenness without changing the visible dimensions perceptibly.
  const needsScale = meta.width > MAX_WIDTH;
  const scaleFilter = needsScale
    ? `scale='min(${MAX_WIDTH}\\,iw)':-2`
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

  // ── H.264 MP4 ────────────────────────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: mp4Path,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .videoCodec('libx264')
        .videoFilter(scaleFilter)
        .outputOptions([
          '-preset',
          'medium',
          '-crf',
          '23',
          '-profile:v',
          'baseline',
          '-level',
          '4.0',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
        ])
        .noAudio();
    },
  });

  // ── VP9 WebM ─────────────────────────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: webmPath,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .videoCodec('libvpx-vp9')
        .videoFilter(scaleFilter)
        .outputOptions([
          '-crf',
          '32',
          '-b:v',
          '0',
          '-row-mt',
          '1',
          '-deadline',
          'good',
          '-cpu-used',
          '4',
        ])
        .noAudio();
    },
  });

  // ── Poster JPEG (first frame) ───────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: posterPath,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .outputOptions(['-frames:v', '1', '-q:v', '4'])
        .videoFilter(`scale=${POSTER_WIDTH}:-2`)
        .noAudio();
    },
  });

  return {
    conversions: {
      'h264-mp4': `${urlBase}/${mp4Name}`,
      'vp9-webm': `${urlBase}/${webmName}`,
      poster: `${urlBase}/${posterName}`,
    },
    mediaPatch,
  };
}

/**
 * @param {string} mediaId
 * @param {Record<string, any>} patch
 */
function applyEarlyMetadata(mediaId, patch) {
  const cols = Object.keys(patch).filter((k) => ['width', 'height', 'duration'].includes(k));
  if (!cols.length) return;
  const db = queueInternal.getDb();
  const setSql = cols.map((c) => `${c} = ?`).join(', ');
  const args = cols.map((c) => patch[c]);
  args.push(mediaId);
  db.prepare(`UPDATE media SET ${setSql} WHERE id = ?`).run(...args);
}

/**
 * @param {string} name
 */
function stripExt(name) {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
