// @ts-check
/**
 * queue.js — SQLite-backed conversion job queue (Phase 5).
 *
 * Generic producer/consumer infra that the upload route (producer) and
 * the worker (consumer) both call into. No knowledge of *what* a job
 * does lives here — that's the handler registry in `./index.js`.
 *
 * Lifecycle of a single job:
 *
 *   pending ──claimNext()──▶ running ──markDone()──▶ done
 *                                  └─markFailed()──▶ pending (if attempt<max, backoff)
 *                                                  └─▶ failed (otherwise)
 *
 * The companion `media.status` column is kept in sync:
 *
 *   enqueueJob()   media.status='processing'
 *   markDone()     media.status='ready'
 *   markFailed()   media.status='failed' (only on the LAST attempt)
 *
 * All state changes are wrapped in `db.transaction()` so a SIGKILL mid-
 * write can't leave a row half-updated. The schema lives in
 * `src/db/migrations/003_conversion_jobs.sql`.
 *
 * Concurrency: `claimNext()` uses an atomic UPDATE…RETURNING so multiple
 * worker iterations can race without grabbing the same row. SQLite's
 * default locking model serializes these writes; we tolerate the lock
 * contention because MAX_CONCURRENCY is small (2 by default).
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Open the same DB the rest of the admin uses. Honors AUTH_DB_PATH so the
 * test suite can point at a temp file.
 *
 * @returns {Database.Database}
 */
function openDb() {
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', '..', 'data', 'auth.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Lazy DB singleton so multiple imports share one handle inside a process.
 * Tests reset by setting AUTH_DB_PATH *before* the first import — the
 * `_db` cache key is the env value at construction time.
 *
 * @type {Database.Database | null}
 */
let _db = null;
let _dbPath = '';

function getDb() {
  const wantPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', '..', 'data', 'auth.db');
  if (_db && _dbPath === wantPath) return _db;
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
  }
  _db = openDb();
  _dbPath = wantPath;
  return _db;
}

/**
 * Queue a new conversion job and mark the parent media row as
 * `processing`. Idempotent in the sense that the queue happily accepts
 * duplicate jobs — the caller is expected to enqueue once per upload.
 *
 * @param {string} mediaId
 * @param {'image' | 'video' | 'audio' | 'pdf' | 'code' | 'archive' | 'gif'} type
 * @param {{ maxAttempts?: number, db?: Database.Database }} [opts]
 * @returns {{ id: string, media_id: string, type: string }}
 */
export function enqueueJob(mediaId, type, opts) {
  const db = (opts && opts.db) || getDb();
  const id = nanoid();
  const maxAttempts = (opts && opts.maxAttempts) || 3;
  const now = Date.now();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO conversion_jobs (id, media_id, type, status, attempt, max_attempts, queued_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(id, mediaId, type, maxAttempts, now);
    db.prepare("UPDATE media SET status = 'processing' WHERE id = ?").run(mediaId);
  });
  tx();

  return { id, media_id: mediaId, type };
}

/**
 * Atomically claim the next pending job whose `queued_at` is in the past.
 * Flips it to `running` and stamps `started_at`. Returns null if no job
 * is ready.
 *
 * SQLite's `UPDATE … RETURNING` makes this single statement act as a
 * compare-and-set, so two concurrent workers won't both grab the same
 * row even though they share a process (the `LIMIT 1` is honored before
 * the update applies).
 *
 * @param {{ db?: Database.Database }} [opts]
 * @returns {Record<string, any> | null}
 */
export function claimNext(opts) {
  const db = (opts && opts.db) || getDb();
  const now = Date.now();
  // SQLite doesn't allow `UPDATE … LIMIT 1` without compile-time flags
  // we don't control on Alpine, so do two steps inside a transaction.
  const claim = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM conversion_jobs
         WHERE status = 'pending' AND queued_at <= ?
         ORDER BY queued_at ASC
         LIMIT 1`,
      )
      .get(now);
    if (!row) return null;
    db.prepare(
      `UPDATE conversion_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(now, row.id);
    // Re-read in case another writer beat us (status would no longer be
    // 'running' for this row from our perspective).
    const fresh = db.prepare('SELECT * FROM conversion_jobs WHERE id = ?').get(row.id);
    if (!fresh || fresh.status !== 'running') return null;
    return fresh;
  });
  return claim();
}

/**
 * Mark a job done. Merges `conversions` into the parent media row's
 * `conversions_json` (deep-shallow merge — collisions replace) and flips
 * the media status back to `ready`.
 *
 * @param {string} jobId
 * @param {Record<string, any>} [conversions]
 * @param {{ db?: Database.Database, mediaPatch?: Record<string, any> }} [opts]
 */
export function markDone(jobId, conversions, opts) {
  const db = (opts && opts.db) || getDb();
  const finishedAt = Date.now();
  const tx = db.transaction(() => {
    const job = db.prepare('SELECT * FROM conversion_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    db.prepare(
      `UPDATE conversion_jobs SET status = 'done', finished_at = ?, error = NULL WHERE id = ?`,
    ).run(finishedAt, jobId);

    if (conversions && typeof conversions === 'object') {
      const media = db.prepare('SELECT conversions_json FROM media WHERE id = ?').get(job.media_id);
      if (media) {
        let existing = {};
        try {
          existing = JSON.parse(media.conversions_json || '{}');
        } catch {
          existing = {};
        }
        const merged = { ...existing, ...conversions };
        db.prepare('UPDATE media SET conversions_json = ? WHERE id = ?').run(
          JSON.stringify(merged),
          job.media_id,
        );
      }
    }

    // Optional metadata patch (width/height/duration/etc).
    const patch = opts && opts.mediaPatch;
    if (patch && typeof patch === 'object') {
      const cols = Object.keys(patch).filter((k) =>
        ['width', 'height', 'duration', 'mime_type'].includes(k),
      );
      if (cols.length) {
        const setSql = cols.map((c) => `${c} = ?`).join(', ');
        const args = cols.map((c) => patch[c]);
        args.push(job.media_id);
        db.prepare(`UPDATE media SET ${setSql} WHERE id = ?`).run(...args);
      }
    }

    // Only flip media.status='ready' if no other jobs for this media are
    // still pending/running. Lets multi-stage pipelines (e.g. image
    // resizing + a follow-up GIF transcode) share a single media row.
    const pendingForMedia = db
      .prepare(
        `SELECT COUNT(*) as n FROM conversion_jobs
         WHERE media_id = ? AND status IN ('pending', 'running')`,
      )
      .get(job.media_id);
    if (!pendingForMedia || pendingForMedia.n === 0) {
      db.prepare("UPDATE media SET status = 'ready' WHERE id = ?").run(job.media_id);
    }
  });
  tx();
}

/**
 * Record a failed attempt. If we have retries left we re-queue with an
 * exponential backoff (2^attempt seconds); otherwise we mark the job and
 * the parent media as `failed`.
 *
 * @param {string} jobId
 * @param {string | Error} err
 * @param {{ db?: Database.Database }} [opts]
 * @returns {{ retrying: boolean, attempt: number, nextRunAt?: number }}
 */
export function markFailed(jobId, err, opts) {
  const db = (opts && opts.db) || getDb();
  const message = err instanceof Error ? err.stack || err.message : String(err);
  /** @type {{ retrying: boolean, attempt: number, nextRunAt?: number }} */
  let result = { retrying: false, attempt: 0 };

  const tx = db.transaction(() => {
    const job = db.prepare('SELECT * FROM conversion_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    const nextAttempt = (job.attempt || 0) + 1;
    if (nextAttempt < (job.max_attempts || 3)) {
      // Exponential backoff: 2^attempt seconds. After 3 attempts the
      // delays are ~2s, ~4s, ~8s before the final give-up.
      const backoffMs = Math.min(2 ** nextAttempt * 1000, 60_000);
      const nextRunAt = Date.now() + backoffMs;
      db.prepare(
        `UPDATE conversion_jobs
         SET status = 'pending', attempt = ?, queued_at = ?, error = ?, started_at = NULL, finished_at = NULL
         WHERE id = ?`,
      ).run(nextAttempt, nextRunAt, message, jobId);
      // Keep media.status='processing' while we still have retries left.
      db.prepare("UPDATE media SET status = 'processing' WHERE id = ?").run(job.media_id);
      result = { retrying: true, attempt: nextAttempt, nextRunAt };
    } else {
      db.prepare(
        `UPDATE conversion_jobs
         SET status = 'failed', attempt = ?, error = ?, finished_at = ?
         WHERE id = ?`,
      ).run(nextAttempt, message, Date.now(), jobId);
      db.prepare("UPDATE media SET status = 'failed' WHERE id = ?").run(job.media_id);
      result = { retrying: false, attempt: nextAttempt };
    }
  });
  tx();
  return result;
}

/**
 * Reset a failed job (or the most-recent job for a media) to `pending`.
 * Returns the new job count touched (0 if nothing matched).
 *
 * @param {string} jobId
 * @param {{ db?: Database.Database }} [opts]
 */
export function retryJob(jobId, opts) {
  const db = (opts && opts.db) || getDb();
  const tx = db.transaction(() => {
    const job = db.prepare('SELECT * FROM conversion_jobs WHERE id = ?').get(jobId);
    if (!job) return 0;
    db.prepare(
      `UPDATE conversion_jobs
       SET status = 'pending', attempt = 0, queued_at = ?, error = NULL,
           started_at = NULL, finished_at = NULL
       WHERE id = ?`,
    ).run(Date.now(), jobId);
    db.prepare("UPDATE media SET status = 'processing' WHERE id = ?").run(job.media_id);
    return 1;
  });
  return tx();
}

/**
 * Find the most-recent failed/pending job for a media row. Used by the
 * retry endpoint to map "retry this asset" to a concrete job id.
 *
 * @param {string} mediaId
 * @param {{ db?: Database.Database }} [opts]
 * @returns {Record<string, any> | null}
 */
export function latestJobForMedia(mediaId, opts) {
  const db = (opts && opts.db) || getDb();
  return (
    db
      .prepare(
        `SELECT * FROM conversion_jobs
         WHERE media_id = ?
         ORDER BY queued_at DESC
         LIMIT 1`,
      )
      .get(mediaId) || null
  );
}

/**
 * Test-only: count rows by status. Used by the conversion test suite to
 * assert the queue eventually drains.
 *
 * @param {{ db?: Database.Database }} [opts]
 */
export function debugStats(opts) {
  const db = (opts && opts.db) || getDb();
  const rows = db
    .prepare('SELECT status, COUNT(*) as n FROM conversion_jobs GROUP BY status')
    .all();
  /** @type {Record<string, number>} */
  const out = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// Internal — exported so the worker shares the DB handle (one open file).
export const __internal = { getDb };
