// @ts-check
/**
 * remark42-poller.js — Phase 8.5 background Remark42 watcher.
 *
 * Remark42 doesn't expose webhooks for new comments, so we poll its
 * `/api/v1/last/N` endpoint on a 30-second cadence and broadcast any
 * comments that arrived since the previous tick over the SSE channel.
 *
 * The poller is deliberately simple:
 *
 *   - one tick = one HTTP call
 *   - cursor = highest `ts` seen so far (epoch ms); newer rows are new
 *   - skipped silently if `REMARK42_URL` isn't configured (e.g. dev
 *     sessions without the docker stack up) — no log spam
 *   - exponential back-off on failure: 30s → 1m → 2m → 5m cap
 *
 * Lifecycle:
 *   start() — call once at boot; idempotent.
 *   stop()  — graceful shutdown; called from SIGTERM/SIGINT hooks.
 */

import { lastComments } from './remark42.js';
import { broadcast } from './sse.js';
import { logActivity } from './activity.js';

const DEFAULT_INTERVAL_MS = Number(process.env.REMARK42_POLL_MS || 30 * 1000);
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** @type {NodeJS.Timeout | null} */
let timer = null;
let started = false;
let lastTs = 0;
let consecutiveFailures = 0;
let nextDelayMs = DEFAULT_INTERVAL_MS;
const seenIds = new Set();
const SEEN_CAP = 5000; // bounded so a long-running process doesn't leak

function configured() {
  // The poller is only useful when Remark42 is actually reachable. We
  // treat the absence of an explicit URL as "off" for unit tests and
  // greenfield dev (default localhost:8081 still polls if the user wants).
  return Boolean(process.env.REMARK42_URL || process.env.REMARK42_SITE_ID);
}

async function tick() {
  if (!started) return;
  try {
    // First tick: prime the cursor from the most recent N so we don't
    // dump the entire history onto admins reconnecting after months.
    const max = lastTs === 0 ? 50 : 100;
    const since = lastTs > 0 ? lastTs : undefined;
    const rows = await lastComments({ max, since });
    if (Array.isArray(rows) && rows.length) {
      // Sort ascending so SSE consumers see them in order.
      rows.sort((a, b) => a.ts - b.ts);
      for (const c of rows) {
        if (seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        if (seenIds.size > SEEN_CAP) {
          // crude eviction — drop one arbitrary entry per insert past the cap
          const first = seenIds.values().next().value;
          if (first !== undefined) seenIds.delete(first);
        }
        // Skip on first tick (priming pass) — we only want to push
        // comments that arrive *after* the poller starts.
        if (lastTs === 0) continue;
        broadcast('comments', 'comment-new', {
          id: c.id,
          source: 'remark42',
          author: c.author.name,
          authorId: c.author.id,
          postUrl: c.postUrl,
          excerpt: c.content.replace(/<[^>]+>/g, '').slice(0, 240),
          ts: c.ts,
        });
        logActivity({
          user: 'system',
          action: 'comment.receive',
          target: c.id,
          meta: { postUrl: c.postUrl, author: c.author.name },
        });
      }
      const latest = rows[rows.length - 1];
      if (latest && latest.ts > lastTs) lastTs = latest.ts;
    }
    consecutiveFailures = 0;
    nextDelayMs = DEFAULT_INTERVAL_MS;
  } catch (err) {
    consecutiveFailures += 1;
    // Exponential back-off: 30s → 60s → 120s → … capped at 5m. Avoid
    // hammering a stuck Remark42 with a tight loop of error logs.
    nextDelayMs = Math.min(MAX_BACKOFF_MS, DEFAULT_INTERVAL_MS * 2 ** (consecutiveFailures - 1));
    // Only log the first failure of a streak; subsequent ones are
    // assumed to be the same root cause.
    if (consecutiveFailures === 1) {
      console.warn('[remark42-poller] tick failed:', err && err.message);
    }
  } finally {
    if (started) {
      timer = setTimeout(tick, nextDelayMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }
}

/**
 * Start the background poller. Idempotent — calling twice is a no-op.
 *
 * @param {{ intervalMs?: number }} [opts]
 */
export function start(opts) {
  if (started) return;
  if (!configured()) {
    console.log('[remark42-poller] skipped (no REMARK42_URL / REMARK42_SITE_ID)');
    return;
  }
  if (opts?.intervalMs) nextDelayMs = opts.intervalMs;
  started = true;
  timer = setTimeout(tick, 1000); // first tick ~1s after boot
  if (timer && typeof timer.unref === 'function') timer.unref();
  console.log(`[remark42-poller] started (interval=${nextDelayMs}ms)`);
}

/**
 * Stop the poller; safe to call multiple times.
 */
export function stop() {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Reset internal state (cursor + seen-ids). Used by tests between cases.
 */
export function reset() {
  stop();
  lastTs = 0;
  consecutiveFailures = 0;
  nextDelayMs = DEFAULT_INTERVAL_MS;
  seenIds.clear();
}

export const __test = {
  tick,
  state() {
    return { started, lastTs, consecutiveFailures, nextDelayMs, seenCount: seenIds.size };
  },
};

export default { start, stop, reset };
