// @ts-check
/**
 * sse.js — Phase 8.5 Server-Sent Events channel manager.
 *
 * One reusable bus for any subsystem that wants to push events to the
 * admin UI without polling:
 *
 *   - new Remark42 comments (Remark42 poller)
 *   - newly-received webmentions (webmention receiver)
 *   - publish job completion / conversion progress (future Phase 9)
 *
 * Why hand-rolled instead of pulling in `eventsource` / `sse-pubsub`?
 * We need ~150 lines, zero deps, and a clean test seam. The shape is:
 *
 *   register(req, res, ['comments'])    // mounts on one or more channels
 *   broadcast('comments', 'new', data)  // fans out to all subscribers
 *
 * Each connection sends a heartbeat comment every HEARTBEAT_MS so
 * upstream proxies (Caddy, Cloudflare Tunnel) don't kill an idle
 * connection. The standard "retry: 5000" line tells the browser to
 * reconnect after a 5s drop.
 */

const HEARTBEAT_MS = 30 * 1000;

/** @typedef {{ id: number, res: any, channels: Set<string>, closed: boolean, heartbeat: NodeJS.Timeout|null }} Subscriber */

/** @type {Map<number, Subscriber>} */
const subscribers = new Map();

/** @type {number} */
let nextId = 1;

/**
 * Register a new SSE subscriber on the response stream. Returns the
 * subscriber id so callers can `unregister()` explicitly if needed
 * (the close listener handles the common case automatically).
 *
 * @param {any} _req — Express request (kept for symmetry; we don't read it)
 * @param {any} res  — Express response
 * @param {string[]} channels — one or more channel names this subscriber wants
 * @returns {number} subscriber id
 */
export function register(_req, res, channels) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // tell Nginx / Caddy not to buffer
  // Flush headers so the browser opens the EventSource cleanly even
  // before the first event lands.
  if (typeof res.flushHeaders === 'function') {
    try {
      res.flushHeaders();
    } catch (_) {
      /* some envs (tests) don't support; ignore */
    }
  }

  // Tell the browser to retry after 5s on disconnect.
  res.write('retry: 5000\n\n');

  const id = nextId++;
  /** @type {Subscriber} */
  const sub = {
    id,
    res,
    channels: new Set(channels && channels.length ? channels : ['*']),
    closed: false,
    heartbeat: null,
  };
  subscribers.set(id, sub);

  sub.heartbeat = setInterval(() => {
    if (sub.closed) return;
    try {
      // SSE comment line; ignored by clients but resets idle timers.
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (_) {
      cleanup(sub);
    }
  }, HEARTBEAT_MS);
  // Don't keep the process alive just to send pings.
  if (sub.heartbeat && typeof sub.heartbeat.unref === 'function') sub.heartbeat.unref();

  const onClose = () => cleanup(sub);
  if (typeof res.on === 'function') {
    res.on('close', onClose);
    res.on('error', onClose);
  }
  return id;
}

/**
 * @param {Subscriber} sub
 */
function cleanup(sub) {
  if (sub.closed) return;
  sub.closed = true;
  if (sub.heartbeat) {
    clearInterval(sub.heartbeat);
    sub.heartbeat = null;
  }
  try {
    sub.res.end();
  } catch (_) {
    /* already closed */
  }
  subscribers.delete(sub.id);
}

/**
 * Explicit unregister (rare — close listener handles the common path).
 *
 * @param {number} id
 */
export function unregister(id) {
  const sub = subscribers.get(id);
  if (sub) cleanup(sub);
}

/**
 * Push one event to every subscriber on the given channel. `channel`
 * `'*'` broadcasts to everyone. `data` is JSON-serialised.
 *
 * @param {string} channel
 * @param {string} event — event name (e.g. 'comment-new')
 * @param {any} data
 */
export function broadcast(channel, event, data) {
  if (!channel || typeof channel !== 'string') return;
  if (!event || typeof event !== 'string') return;
  let payload;
  try {
    payload = JSON.stringify(data === undefined ? null : data);
  } catch (_) {
    payload = 'null';
  }
  const frame = `event: ${event}\ndata: ${payload}\n\n`;
  for (const sub of subscribers.values()) {
    if (sub.closed) continue;
    if (sub.channels.has(channel) || sub.channels.has('*')) {
      try {
        sub.res.write(frame);
      } catch (_) {
        cleanup(sub);
      }
    }
  }
}

/**
 * Count of currently-open subscribers (test/debug helper).
 *
 * @param {string} [channel]
 */
export function subscriberCount(channel) {
  if (!channel) return subscribers.size;
  let n = 0;
  for (const sub of subscribers.values()) {
    if (sub.channels.has(channel) || sub.channels.has('*')) n++;
  }
  return n;
}

/**
 * Forcibly drop every connection. Used by tests for clean teardown.
 */
export function closeAll() {
  for (const sub of Array.from(subscribers.values())) cleanup(sub);
}

export default {
  register,
  unregister,
  broadcast,
  subscriberCount,
  closeAll,
};
