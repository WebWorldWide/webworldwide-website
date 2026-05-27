// @ts-check
/**
 * worker.js — periodic queue drainer (Phase 5).
 *
 * Polls `conversion_jobs` at 1 Hz. Up to MAX_CONCURRENCY jobs run in
 * parallel; each handler runs to completion (or throws) before its slot
 * frees. The worker is a singleton per process — `startWorker()` is
 * idempotent and `stopWorker()` awaits in-flight handlers so SIGTERM
 * shutdowns don't truncate a half-encoded AVIF.
 *
 * Concurrency budget on a Pi 5:
 *   MAX_CONCURRENCY × sharp.concurrency(1) = 2 native threads
 *   AVIF effort=6 + libvips overhead     ≈ ~70% CPU sustained
 *
 * If we measure trouble in Phase 11 we lower CONVERSION_CONCURRENCY=1
 * via the env override and the math becomes 1 × 1 = 1 thread.
 */

import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { claimNext, markDone, markFailed, enqueueJob } from './queue.js';
import { handlers, resolveDiskContext } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONCURRENCY = Number(process.env.CONVERSION_CONCURRENCY || 2);
const POLL_INTERVAL_MS = Number(process.env.CONVERSION_POLL_MS || 1000);

/** @type {{ running: boolean, inflight: Set<Promise<void>>, timer: any, db: Database.Database | null }} */
const state = {
  running: false,
  inflight: new Set(),
  timer: null,
  db: null,
};

function openDb() {
  const dbPath = process.env.AUTH_DB_PATH || join(__dirname, '..', '..', '..', 'data', 'auth.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Begin polling. No-op if already running. Returns the worker handle so
 * the caller (server.js) can hold a reference for graceful shutdown.
 *
 * @param {{ concurrency?: number, pollIntervalMs?: number, onTick?: () => void }} [opts]
 */
export function startWorker(opts) {
  if (state.running) return controller();
  state.running = true;
  state.db = openDb();

  const concurrency = (opts && opts.concurrency) || DEFAULT_CONCURRENCY;
  const interval = (opts && opts.pollIntervalMs) || POLL_INTERVAL_MS;
  const onTick = opts && opts.onTick;

  const tick = async () => {
    if (!state.running) return;
    try {
      while (state.running && state.inflight.size < concurrency) {
        const job = claimNext({ db: state.db });
        if (!job) break;
        const p = runJob(job).finally(() => {
          state.inflight.delete(p);
        });
        state.inflight.add(p);
      }
    } catch (err) {
      console.error('[conversion-worker] poll error:', err);
    }
    if (onTick) {
      try {
        onTick();
      } catch {
        /* test hook — ignore */
      }
    }
  };

  // Run an immediate tick so test suites don't have to wait a full
  // interval for the first claim. After that, settle into a timer loop.
  tick();
  state.timer = setInterval(tick, interval);
  // `unref()` so the worker doesn't pin the process open after the HTTP
  // listener closes. server.js handles graceful shutdown explicitly.
  if (state.timer.unref) state.timer.unref();

  return controller();
}

/**
 * Stop polling and await every in-flight handler. Safe to call multiple
 * times. Used by SIGTERM/SIGINT shutdown in server.js *and* by test
 * `after()` blocks.
 *
 * @returns {Promise<void>}
 */
export async function stopWorker() {
  state.running = false;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  const pending = Array.from(state.inflight);
  if (pending.length) {
    await Promise.allSettled(pending);
  }
  if (state.db) {
    try {
      state.db.close();
    } catch {
      /* ignore */
    }
    state.db = null;
  }
}

/**
 * Synchronously kick off any pending jobs that are ready, in parallel up
 * to the concurrency cap. Returns a promise that resolves when *all*
 * currently-known jobs settle (does NOT wait for jobs queued *after*
 * the call). Used by the test suite to deterministically drain the
 * queue without spinning on setInterval timing.
 *
 * @param {{ concurrency?: number }} [opts]
 */
export async function drainOnce(opts) {
  const concurrency = (opts && opts.concurrency) || DEFAULT_CONCURRENCY;
  const db = state.db || openDb();
  // Drain in waves until the queue is empty. Each wave runs up to
  // `concurrency` jobs in parallel, then awaits them, then re-checks for
  // new pending work. This handles two cases at once: (1) the regular
  // polling worker that wants to clear out backlog before sleeping, and
  // (2) tests that enqueue a job and immediately await a single drain.
  while (true) {
    /** @type {Promise<void>[]} */
    const wave = [];
    while (wave.length < concurrency) {
      const job = claimNext({ db });
      if (!job) break;
      wave.push(runJob(job, db));
    }
    if (!wave.length) break;
    await Promise.allSettled(wave);
  }
  if (!state.db) db.close();
}

/**
 * Run a single job: dispatch to its handler, mark done or failed.
 *
 * @param {Record<string, any>} job
 * @param {Database.Database} [dbOverride]
 */
async function runJob(job, dbOverride) {
  const db = dbOverride || state.db || openDb();
  const handler = handlers[job.type];
  if (!handler) {
    markFailed(job.id, `No handler registered for type='${job.type}'`, { db });
    return;
  }
  try {
    const ctx = resolveDiskContext(job, db);
    if (!ctx) {
      markFailed(job.id, 'Could not resolve media row or on-disk path', { db });
      return;
    }
    const result = (await handler({
      ...ctx,
      enqueueFollowupJob: (mediaId, type) => {
        try {
          enqueueJob(mediaId, /** @type {any} */ (type), { db });
        } catch (err) {
          console.warn('[conversion-worker] follow-up enqueue failed:', err);
        }
      },
    })) || { conversions: {}, mediaPatch: {} };

    markDone(job.id, result.conversions, { db, mediaPatch: result.mediaPatch });
  } catch (err) {
    console.error(`[conversion-worker] job ${job.id} (${job.type}) failed:`, err);
    markFailed(job.id, /** @type {any} */ (err), { db });
  }
}

function controller() {
  return {
    stop: stopWorker,
    drainOnce,
    status() {
      return {
        running: state.running,
        inflight: state.inflight.size,
      };
    },
  };
}

/**
 * Wire SIGTERM/SIGINT to a clean shutdown. Idempotent.
 */
let signalsBound = false;
export function bindShutdownSignals() {
  if (signalsBound) return;
  signalsBound = true;
  const drain = async (signal) => {
    console.log(`[conversion-worker] received ${signal}; draining…`);
    try {
      await stopWorker();
    } finally {
      // Let server.js's listener.close() finish too — don't process.exit()
      // here, that's the caller's job.
    }
  };
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));
}
