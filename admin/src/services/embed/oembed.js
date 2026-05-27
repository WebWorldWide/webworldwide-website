// @ts-check
/**
 * oembed.js — thin oEmbed client.
 *
 * Wraps `fetch` with: a hard 5-second timeout, a User-Agent header
 * (some providers — notably Mastodon instances behind Cloudflare — 403
 * a request with no UA), a small response size cap (256 KB), and a
 * structured error type so the route can translate "upstream said 404"
 * into a 4xx without leaking provider-specific phrasing.
 *
 * The return value is the parsed JSON oEmbed payload, or `null` if the
 * upstream returned a non-2xx. The caller (providers.js#resolve) is
 * tolerant of a missing oembed and falls back to URL-derived defaults
 * so a transient upstream blip doesn't prevent the user from inserting
 * the embed — only the title/thumbnail metadata is missing.
 *
 * Test seam: `setFetchImpl(fn)` swaps the underlying fetch so unit
 * tests can run without touching the network.
 */

let _fetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;

/** @param {typeof fetch} fn */
export function setFetchImpl(fn) {
  _fetch = fn;
}

/** Restore the global fetch (test cleanup helper). */
export function resetFetchImpl() {
  _fetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
}

const USER_AGENT = 'TerminalEighty/1.0 (+https://terminaleighty)';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, provider?: string, cause?: any }} [opts]
   */
  constructor(message, opts) {
    super(message);
    this.name = 'UpstreamError';
    this.status = opts?.status ?? 502;
    this.provider = opts?.provider ?? null;
    if (opts?.cause) this.cause = opts.cause;
  }
}

/**
 * Fetch an oEmbed JSON document.
 *
 * @param {string} endpoint
 * @param {{ provider?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<any | null>}
 */
export async function fetchOEmbed(endpoint, opts) {
  if (!_fetch) {
    throw new UpstreamError('fetch unavailable in this runtime', {
      provider: opts?.provider,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await _fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new UpstreamError('oembed timeout', { provider: opts?.provider, status: 504 });
    }
    throw new UpstreamError('oembed fetch failed', {
      provider: opts?.provider,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) {
    // Provider said "no" — most often 404 (unknown video) or 403
    // (geo/age-restricted). The route turns this into a 404 to the
    // caller; we still return null so callers that prefer best-effort
    // metadata don't need to catch.
    if (res && (res.status === 404 || res.status === 410)) {
      throw new UpstreamError('not found', { provider: opts?.provider, status: 404 });
    }
    if (res && res.status === 401) {
      throw new UpstreamError('unauthorised', { provider: opts?.provider, status: 401 });
    }
    return null;
  }
  // Cap the body size — defends against an upstream returning a 5MB
  // HTML page when we asked for JSON.
  const text = await readCappedText(res, MAX_BYTES);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON response — treat as a soft failure.
    return null;
  }
}

/**
 * Read a fetch Response body but bail if it exceeds `maxBytes`.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function readCappedText(res, maxBytes) {
  // Prefer the streaming reader so a hostile peer can't make us
  // allocate 100MB before we notice. Falls back to res.text() in
  // environments where reader is unavailable (test mocks).
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const t = await res.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
  }
  // Use TextDecoder so we handle multi-byte UTF-8 cleanly.
  const decoder = new TextDecoder('utf-8');
  return chunks.map((c) => decoder.decode(c, { stream: false })).join('');
}
