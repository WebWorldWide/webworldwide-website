// @ts-check
/**
 * audio.js — Phase 5b audio conversion handler.
 *
 * Pipeline (per upload):
 *   1. ffprobe — extract duration. Write to media.duration early so the
 *      library UI gets the "03:42" badge before encoding finishes.
 *   2. LUFS analysis — pass-1 of ffmpeg's loudnorm filter measures
 *      integrated loudness so pass-2 can apply a precise per-file gain.
 *      EBU R128 target: I=-16 LUFS, LRA=11, TP=-1.5 dBTP.
 *   3. MP3 (128 kbps CBR) — libmp3lame, with the measured loudnorm
 *      parameters applied as a second-pass filter.
 *   4. Opus (96 kbps) — libopus `application=audio`, same loudnorm
 *      params applied.
 *   5. Waveform PNG — ffmpeg's `showwavespic` filter renders a 1200×120
 *      preview in the Terminal Eighty accent green. (PNG, not SVG —
 *      ffmpeg can't emit SVG; the file extension reflects reality.)
 *
 * conversions_json shape:
 *   {
 *     "mp3-128":  "/files/yyyy/mm/...-name.mp3",
 *     "opus-96":  "/files/yyyy/mm/...-name.opus",
 *     "waveform": "/files/yyyy/mm/...-name-wave.png"
 *   }
 *
 * If pass-1 loudnorm analysis fails (rare — happens on extremely short
 * sources where the integrated measurement is undefined), we fall back
 * to a single-pass `loudnorm=I=-16:LRA=11:TP=-1.5` filter with no
 * measured offsets. The result is still loudness-normalized, just less
 * precisely than the two-pass version.
 */

import { basename, extname, join } from 'path';

import ffmpeg from 'fluent-ffmpeg';

import { ffprobe, runFfmpeg } from './ffmpeg.js';
import { __internal as queueInternal } from './queue.js';

/** Integrated loudness target (EBU R128 broadcast). */
const TARGET_I = -16;
/** Loudness range target. */
const TARGET_LRA = 11;
/** True-peak ceiling (dBTP). */
const TARGET_TP = -1.5;
/** Waveform image dimensions. */
const WAVEFORM_WIDTH = 1200;
const WAVEFORM_HEIGHT = 120;
/** Terminal Eighty accent green. */
const WAVEFORM_COLOR = '7AFF9B';

/**
 * Drive the audio pipeline for one media row.
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
export async function processAudio(ctx) {
  const { row, diskPath, urlBase, diskDir } = ctx;
  const meta = await ffprobe(diskPath);

  /** @type {Record<string, any>} */
  const mediaPatch = {};
  if (meta.duration > 0) mediaPatch.duration = meta.duration;
  try {
    applyEarlyMetadata(row.id, mediaPatch);
  } catch (err) {
    console.warn('[conversion/audio] early metadata write failed:', err);
  }

  const baseName = stripExt(basename(diskPath));
  // Suffix outputs so a `.mp3` upload doesn't collide with our `.mp3`
  // re-encode (ffmpeg refuses in-place writes).
  const mp3Name = `${baseName}-128.mp3`;
  const opusName = `${baseName}-96.opus`;
  const waveName = `${baseName}-wave.png`;
  const mp3Path = join(diskDir, mp3Name);
  const opusPath = join(diskDir, opusName);
  const wavePath = join(diskDir, waveName);

  // ── Pass-1 loudnorm analysis ────────────────────────────────
  let loudnormFilter = `loudnorm=I=${TARGET_I}:LRA=${TARGET_LRA}:TP=${TARGET_TP}`;
  try {
    const measured = await measureLoudness(diskPath, meta.duration);
    if (measured) {
      loudnormFilter =
        `loudnorm=I=${TARGET_I}:LRA=${TARGET_LRA}:TP=${TARGET_TP}` +
        `:measured_I=${measured.input_i}` +
        `:measured_LRA=${measured.input_lra}` +
        `:measured_TP=${measured.input_tp}` +
        `:measured_thresh=${measured.input_thresh}` +
        `:offset=${measured.target_offset}` +
        `:linear=true:print_format=summary`;
    }
  } catch (err) {
    console.warn(
      '[conversion/audio] loudnorm pass-1 failed, using single-pass:',
      err.message || err,
    );
  }

  // ── MP3 128 kbps ────────────────────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: mp3Path,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .audioFilter(loudnormFilter)
        .noVideo()
        .outputOptions(['-id3v2_version', '3']);
    },
  });

  // ── Opus 96 kbps ────────────────────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: opusPath,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .audioCodec('libopus')
        .audioBitrate('96k')
        .audioFilter(loudnormFilter)
        .noVideo()
        .outputOptions(['-application', 'audio']);
    },
  });

  // ── Waveform PNG ────────────────────────────────────────────
  await runFfmpeg({
    input: diskPath,
    output: wavePath,
    sourceDurationSec: meta.duration,
    configure: (cmd) => {
      cmd
        .complexFilter(
          `aformat=channel_layouts=mono,showwavespic=s=${WAVEFORM_WIDTH}x${WAVEFORM_HEIGHT}:colors=0x${WAVEFORM_COLOR}`,
        )
        .outputOptions(['-frames:v', '1']);
    },
  });

  return {
    conversions: {
      'mp3-128': `${urlBase}/${mp3Name}`,
      'opus-96': `${urlBase}/${opusName}`,
      waveform: `${urlBase}/${waveName}`,
    },
    mediaPatch,
  };
}

/**
 * Run ffmpeg's loudnorm filter in analysis mode (print_format=json,
 * output discarded via the null muxer). Parse the JSON block printed to
 * stderr. Returns `null` if parsing fails or any measurement is
 * non-finite (ffmpeg sometimes prints `inf`/`nan` for very short
 * sources).
 *
 * We don't use the shared `runFfmpeg` helper here because we need raw
 * stderr access without it being trimmed for an error path, AND we want
 * a much tighter timeout (analysis is ~real-time).
 *
 * @param {string} inputPath
 * @param {number} durationSec
 * @returns {Promise<null | {
 *   input_i: number, input_tp: number, input_lra: number,
 *   input_thresh: number, target_offset: number,
 * }>}
 */
function measureLoudness(inputPath, durationSec) {
  return new Promise((resolve) => {
    const filter = `loudnorm=I=${TARGET_I}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:print_format=json`;
    let stderr = '';
    const cmd = ffmpeg(inputPath)
      .outputOptions(['-threads', '1'])
      .audioFilter(filter)
      .noVideo()
      .format('null');
    const timeout = setTimeout(
      () => {
        try {
          cmd.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      },
      Math.min(60_000, Math.max(15_000, (durationSec || 1) * 4_000)),
    );
    cmd.on('stderr', (line) => {
      stderr += `${line}\n`;
    });
    cmd.on('error', () => {
      clearTimeout(timeout);
      resolve(parseLoudnormJson(stderr));
    });
    cmd.on('end', () => {
      clearTimeout(timeout);
      resolve(parseLoudnormJson(stderr));
    });
    try {
      // Send output to the null muxer / pipe.
      cmd.save('-');
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

/**
 * Extract the JSON block ffmpeg prints to stderr and validate the four
 * fields we need. Returns null on parse failure or non-finite values.
 *
 * @param {string} stderr
 */
function parseLoudnormJson(stderr) {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1));
    const out = {
      input_i: parseFloat(parsed.input_i),
      input_tp: parseFloat(parsed.input_tp),
      input_lra: parseFloat(parsed.input_lra),
      input_thresh: parseFloat(parsed.input_thresh),
      target_offset: parseFloat(parsed.target_offset),
    };
    // Reject if anything is NaN / Infinity — fall back to single-pass.
    for (const v of Object.values(out)) {
      if (!Number.isFinite(v)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {string} mediaId
 * @param {Record<string, any>} patch
 */
function applyEarlyMetadata(mediaId, patch) {
  const cols = Object.keys(patch).filter((k) => ['duration'].includes(k));
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

export const __internal = {
  TARGET_I,
  TARGET_LRA,
  TARGET_TP,
  parseLoudnormJson,
};
