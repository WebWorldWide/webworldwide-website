// @ts-check
/**
 * ffmpeg.js — shared helpers for the Phase 5b A/V pipelines.
 *
 * Two responsibilities:
 *   1. `ffprobe(path)` — promise-wrapped probe that normalizes the noisy
 *      ffprobe JSON into the small handful of fields the handlers care
 *      about (duration, width, height, audio/video codec).
 *   2. `runFfmpeg({ input, output, configure })` — promise-wrapped encode
 *      with a per-job timeout, hard kill on timeout, and uniform error
 *      surfacing (stderr tail is included in the rejection so the queue
 *      `error` column shows the actual ffmpeg complaint, not just
 *      `Error: ffmpeg exited with code 1`).
 *
 * Concurrency contract:
 *   Every ffmpeg invocation runs with `-threads 1`. The worker caps the
 *   simultaneous handler count to CONVERSION_CONCURRENCY (default 2),
 *   so total ffmpeg threads in flight ≤ 2 on a Pi 5 → ~50% CPU headroom.
 *
 * Timeout policy:
 *   Soft budget = max(MIN_TIMEOUT_MS, 10 × source duration in ms).
 *   Hard cap   = HARD_CAP_MS (30 minutes).
 *   On expiry we send SIGTERM, wait 2s, then SIGKILL.
 *
 * Both helpers degrade gracefully when ffmpeg/ffprobe aren't on PATH:
 * the promise rejects with a `code: 'FFMPEG_MISSING'` so callers (and
 * tests) can detect and skip cleanly.
 */

import ffmpeg from 'fluent-ffmpeg';

/** Minimum total budget regardless of source duration (10s). */
const MIN_TIMEOUT_MS = 10_000;
/** Hard cap on any single ffmpeg invocation (30 min). */
const HARD_CAP_MS = 30 * 60_000;
/** Default multiplier on source duration. */
const TIMEOUT_MULTIPLIER = 10;

/**
 * Probe a media file and return the normalized metadata we use across
 * the video/audio/gif handlers.
 *
 * @param {string} filePath absolute path to the source
 * @returns {Promise<{
 *   duration: number,            // seconds (0 if unknown)
 *   width: number,               // 0 if no video stream
 *   height: number,              // 0 if no video stream
 *   videoCodec: string|null,
 *   audioCodec: string|null,
 *   hasAudio: boolean,
 *   hasVideo: boolean,
 *   bitrate: number,             // bits/sec (0 if unknown)
 *   format: string,              // container, e.g. 'mov,mp4,m4a,3gp,3g2,mj2'
 *   nbFrames: number,            // for GIFs / single-stream sources
 * }>}
 */
export function ffprobe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        const e = /** @type {Error & { code?: string }} */ (
          new Error(`ffprobe failed for ${filePath}: ${err.message || err}`)
        );
        // ffprobe surfaces a child_process ENOENT when the binary is
        // missing; surface that so tests can skip on hosts without it.
        if (/ENOENT|not found|Cannot find/i.test(String(err.message || ''))) {
          e.code = 'FFMPEG_MISSING';
        }
        return reject(e);
      }
      try {
        const streams = (data && data.streams) || [];
        const format = (data && data.format) || {};
        const v = streams.find((s) => s.codec_type === 'video') || null;
        const a = streams.find((s) => s.codec_type === 'audio') || null;
        // ffprobe sometimes reports duration only on format, sometimes
        // only on the stream (GIFs in particular). Prefer the larger.
        const fmtDur = parseFloat(format.duration) || 0;
        const vDur = v ? parseFloat(v.duration) || 0 : 0;
        const aDur = a ? parseFloat(a.duration) || 0 : 0;
        const duration = Math.max(fmtDur, vDur, aDur);
        const nbFrames = v ? parseInt(v.nb_frames, 10) || 0 : 0;
        resolve({
          duration: Number.isFinite(duration) ? duration : 0,
          width: v ? Number(v.width) || 0 : 0,
          height: v ? Number(v.height) || 0 : 0,
          videoCodec: v ? String(v.codec_name || '') : null,
          audioCodec: a ? String(a.codec_name || '') : null,
          hasAudio: Boolean(a),
          hasVideo: Boolean(v),
          bitrate: parseInt(format.bit_rate, 10) || 0,
          format: String(format.format_name || ''),
          nbFrames,
        });
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

/**
 * Compute the timeout budget for a single ffmpeg call. Public so callers
 * can pre-allocate / log it, and so tests can assert the math.
 *
 * @param {number} sourceDurationSec
 * @returns {number} timeout in milliseconds
 */
export function computeTimeoutMs(sourceDurationSec) {
  const base = Math.max(
    MIN_TIMEOUT_MS,
    Math.round((sourceDurationSec || 0) * 1000 * TIMEOUT_MULTIPLIER),
  );
  return Math.min(base, HARD_CAP_MS);
}

/**
 * Run an ffmpeg pipeline to completion. The caller provides a `configure`
 * callback that receives the underlying fluent-ffmpeg `command` and adds
 * codecs/filters/output options. We attach `-threads 1` and uniform
 * stderr capture + timeout handling.
 *
 * Resolves with `{ stderrTail }` on success (the last ~4KB of stderr,
 * useful for debugging silent codec fallbacks) or rejects with an Error
 * whose `.message` contains the ffmpeg stderr tail.
 *
 * @param {{
 *   input: string,
 *   output: string,
 *   sourceDurationSec?: number,
 *   configure: (cmd: import('fluent-ffmpeg').FfmpegCommand) => void,
 *   timeoutMs?: number,
 * }} args
 * @returns {Promise<{ stderrTail: string }>}
 */
export function runFfmpeg({ input, output, sourceDurationSec = 0, configure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(input).outputOptions(['-threads', '1']);
    // Caller gets full control of codecs/filters; threads are non-
    // negotiable so we set them before handing off.
    try {
      configure(cmd);
    } catch (cfgErr) {
      return reject(cfgErr);
    }

    const budgetMs = timeoutMs || computeTimeoutMs(sourceDurationSec);
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let killHardTimer = null;
    let settled = false;
    let stderrBuf = '';

    cmd.on('stderr', (line) => {
      stderrBuf += `${line}\n`;
      // Keep memory bounded — only the last ~16 KB.
      if (stderrBuf.length > 16_384) stderrBuf = stderrBuf.slice(-16_384);
    });

    cmd.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (killHardTimer) clearTimeout(killHardTimer);
      const tail = stderrBuf.slice(-4_096);
      const e = /** @type {Error & { code?: string, stderr?: string }} */ (
        new Error(`ffmpeg failed: ${err.message || err}\n--- stderr tail ---\n${tail}`)
      );
      e.stderr = tail;
      if (/ENOENT|spawn .*ffmpeg/i.test(String(err.message || ''))) {
        e.code = 'FFMPEG_MISSING';
      }
      reject(e);
    });

    cmd.on('end', () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (killHardTimer) clearTimeout(killHardTimer);
      resolve({ stderrTail: stderrBuf.slice(-4_096) });
    });

    // Timeout: SIGTERM, then SIGKILL 2s later if it's still alive.
    killTimer = setTimeout(() => {
      if (settled) return;
      try {
        cmd.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      killHardTimer = setTimeout(() => {
        if (settled) return;
        try {
          cmd.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2_000);
    }, budgetMs);

    try {
      cmd.save(output);
    } catch (saveErr) {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(saveErr);
    }
  });
}

/**
 * Lightweight availability check. Resolves with `true` if both ffmpeg
 * and ffprobe are on PATH, `false` otherwise. Used by the test suite to
 * skip cleanly when run on a host without ffmpeg.
 *
 * @returns {Promise<boolean>}
 */
export function ffmpegAvailable() {
  return new Promise((resolve) => {
    // `getAvailableFormats` shells out to ffmpeg; if the binary is
    // missing we get an ENOENT error here.
    ffmpeg.getAvailableFormats((err) => {
      resolve(!err);
    });
  });
}

export const __internal = {
  MIN_TIMEOUT_MS,
  HARD_CAP_MS,
  TIMEOUT_MULTIPLIER,
};
