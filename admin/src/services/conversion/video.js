// @ts-check
/**
 * video.js — Phase 5b video conversion handler.
 *
 * Pipeline (per upload):
 *   1. ffprobe — extract duration / dimensions / codecs. Update the
 *      parent media row's `width`/`height`/`duration` *early* so the
 *      library UI can render a duration badge while encoding is still
 *      running.
 *   2. H.264 MP4 — libx264, preset medium, CRF 23, baseline profile,
 *      yuv420p, faststart. AAC 128k audio (or copy if source is AAC).
 *      Capped at 1080p via `scale='min(1920,iw):-2'` so smaller sources
 *      pass through untouched.
 *   3. VP9 WebM — libvpx-vp9 single-pass CRF 32 + Opus 96k audio.
 *      Single-pass to keep Pi 5 wall-clock tolerable; two-pass is on the
 *      table for Phase 11 if we add a "queue-quality" toggle.
 *   4. Poster JPEG — single frame at duration/2, scaled to max 1920px.
 *   5. Thumbnail JPEG — single frame at duration/2, scaled to 320px.
 *
 * conversions_json shape:
 *   {
 *     "h264-mp4": "/files/yyyy/mm/...-name.mp4",
 *     "vp9-webm": "/files/yyyy/mm/...-name.webm",
 *     "poster":   "/files/yyyy/mm/...-name-poster.jpg",
 *     "thumb":    "/files/yyyy/mm/...-name-thumb.jpg"
 *   }
 *
 * The original upload is preserved at its canonical path — none of the
 * outputs touch it.
 */

import { basename, extname, join } from 'path';

import { ffprobe, runFfmpeg } from './ffmpeg.js';
import { __internal as queueInternal } from './queue.js';

/** Output resolution cap (1080p). */
const MAX_WIDTH = 1920;
/** Poster max width — matches MAX_WIDTH so still frames stay sharp. */
const POSTER_MAX_WIDTH = 1920;
/** Thumbnail width used by the library card grid. */
const THUMB_WIDTH = 320;

/**
 * Drive the video pipeline for one media row.
 *
 * @param {{
 *   row: Record<string, any>,
 *   diskPath: string,
 *   urlBase: string,
 *   diskDir: string,
 *   enqueueFollowupJob?: (mediaId: string, type: string) => void,
 * }} ctx
 * @returns {Promise<{ conversions: Record<string, string>, mediaPatch: Record<string, any> }>}
 */
export async function processVideo(ctx) {
  const { row, diskPath, urlBase, diskDir } = ctx;
  const meta = await ffprobe(diskPath);

  /** @type {Record<string, any>} */
  const mediaPatch = {};
  if (meta.duration > 0) mediaPatch.duration = meta.duration;
  if (meta.width > 0) mediaPatch.width = meta.width;
  if (meta.height > 0) mediaPatch.height = meta.height;

  // Best-effort early write of duration/dims so the library UI can show
  // "01:24" while we're still encoding. If encoding dies, the queue's
  // markFailed flips media.status='failed' but the duration sticks.
  try {
    applyEarlyMetadata(row.id, mediaPatch);
  } catch (err) {
    console.warn('[conversion/video] early metadata write failed:', err);
  }

  const baseName = stripExt(basename(diskPath));
  // Suffix every output to avoid colliding with the source upload (e.g.
  // an .mp4 input would otherwise produce an .mp4 of the same name —
  // ffmpeg refuses to write in-place).
  const mp4Name = `${baseName}-h264.mp4`;
  const webmName = `${baseName}-vp9.webm`;
  const posterName = `${baseName}-poster.jpg`;
  const thumbName = `${baseName}-thumb.jpg`;
  const mp4Path = join(diskDir, mp4Name);
  const webmPath = join(diskDir, webmName);
  const posterPath = join(diskDir, posterName);
  const thumbPath = join(diskDir, thumbName);

  // If the source IS already an MP4, we still re-encode to canonicalize
  // the codec/profile/yuv420p and faststart layout — a phone-shot MOV
  // with HEVC playback is hostile to <video> in older Safari/Chromium.
  const needsScale = meta.width > MAX_WIDTH || meta.height > 1080;
  const scaleFilter = needsScale ? `scale='min(${MAX_WIDTH}\\,iw)':-2` : null;
  const audioPassThrough = meta.audioCodec === 'aac';

  // ── H.264 MP4 ────────────────────────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: mp4Path,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .videoCodec('libx264')
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
        ]);
      if (scaleFilter) cmd.videoFilter(scaleFilter);
      if (meta.hasAudio) {
        if (audioPassThrough) {
          cmd.audioCodec('copy');
        } else {
          cmd.audioCodec('aac').audioBitrate('128k');
        }
      } else {
        cmd.noAudio();
      }
    },
  });

  // ── VP9 WebM ─────────────────────────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: webmPath,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd.videoCodec('libvpx-vp9').outputOptions([
        '-crf',
        '32',
        '-b:v',
        '0',
        '-row-mt',
        '1',
        '-deadline',
        'good',
        '-cpu-used',
        '4', // speed/quality tradeoff; 4 is the Pi-friendly knee
      ]);
      if (scaleFilter) cmd.videoFilter(scaleFilter);
      if (meta.hasAudio) {
        cmd.audioCodec('libopus').audioBitrate('96k');
      } else {
        cmd.noAudio();
      }
    },
  });

  // ── Poster + thumbnail (single frame each at midpoint) ──────
  const seekSec = Math.max(0, (meta.duration || 0) / 2);
  await runFfmpeg({
    input: diskPath,
    output: posterPath,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .seekInput(seekSec)
        .outputOptions(['-frames:v', '1', '-q:v', '3'])
        .videoFilter(`scale='min(${POSTER_MAX_WIDTH}\\,iw)':-2`)
        .noAudio();
    },
  });

  await runFfmpeg({
    input: diskPath,
    output: thumbPath,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .seekInput(seekSec)
        .outputOptions(['-frames:v', '1', '-q:v', '5'])
        .videoFilter(`scale=${THUMB_WIDTH}:-2`)
        .noAudio();
    },
  });

  return {
    conversions: {
      'h264-mp4': `${urlBase}/${mp4Name}`,
      'vp9-webm': `${urlBase}/${webmName}`,
      poster: `${urlBase}/${posterName}`,
      thumb: `${urlBase}/${thumbName}`,
    },
    mediaPatch,
  };
}

/**
 * Patch width/height/duration on the media row using the queue's shared
 * DB handle. Pure best-effort — handler still returns the full patch in
 * its mediaPatch for the final markDone() call, so even if this write
 * fails the row catches up at the end.
 *
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
 * Strip the extension from a filename. `foo.bar.mp4` → `foo.bar`.
 * @param {string} name
 */
function stripExt(name) {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
