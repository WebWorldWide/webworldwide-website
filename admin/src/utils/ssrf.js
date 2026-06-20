// @ts-check
/**
 * ssrf.js — SSRF-screened HTTP fetch for server-side link fetching.
 *
 * Mirrors the hardening already proven in routes/webmentions.js
 * (isPrivateHost / ipIsPrivate / assertPublicHost + a MANUAL-redirect
 * re-screen loop) so the embed / OG-scrape paths can't be turned into a
 * LAN / docker-network probe via:
 *   1. a DNS pin — a public hostname whose A/AAAA record points at an
 *      internal/link-local address (a sibling container, 192.168.x, 169.254.x);
 *   2. a redirect — a public source 30x'ing to http://<internal>.
 *
 * Deliberately self-contained (a vetted COPY of the IP checks, not an import of
 * the webmentions ROUTE module) so the embed path carries its own guard and
 * loading it never drags in the route/DB machinery. Keep the IP logic in sync
 * with routes/webmentions.js.
 */

import { promises as dnsPromises } from 'dns';

/**
 * Lexical screen of a hostname string: localhost, .local/.internal, and
 * IPv4/IPv6 literals in private/reserved ranges.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHost(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

/**
 * Is a RESOLVED IP address (v4 or v6, incl. IPv4-mapped) private/reserved?
 * @param {string} ip
 * @returns {boolean}
 */
export function ipIsPrivate(ip) {
  const h = String(ip || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  const v4 = mapped ? mapped[1] : h;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    return false;
  }
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/**
 * Resolve `hostname` and reject if ANY A/AAAA record is private/reserved.
 * Closes the DNS-rebinding gap the string-only isPrivateHost can't catch.
 * Best-effort pre-connect check (a narrow TOCTOU window remains vs the
 * runtime's own resolve, but it removes the trivial public-name→private-IP
 * bypass).
 *
 * @param {string} hostname
 */
export async function assertPublicHost(hostname) {
  let addrs;
  try {
    addrs = await dnsPromises.lookup(hostname, { all: true });
  } catch {
    throw new Error('refusing fetch: host did not resolve');
  }
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) {
    throw new Error('refusing fetch to a private/non-public host');
  }
}

/**
 * Fetch `url` with SSRF screening. Rejects a non-http(s) scheme, a
 * private/reserved host (lexically, AND by resolved IP when `screenDns`), and
 * follows redirects MANUALLY so EVERY hop's Location is re-screened before the
 * next request. Returns the final Response (the caller decides how to read it).
 *
 * @param {string} url
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   init?: object,
 *   maxRedirects?: number,
 *   screenDns?: boolean,
 * }} [opts]
 * @returns {Promise<Response>}
 */
export async function screenedFetch(url, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const init = opts.init || {};
  const maxRedirects = opts.maxRedirects ?? 4;
  const screenDns = opts.screenDns ?? true;
  let current = url;
  let res;
  for (let hop = 0; ; hop += 1) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`refusing non-http(s) URL: ${u.protocol}`);
    }
    if (isPrivateHost(u.hostname)) {
      throw new Error('refusing fetch to a private/non-public host');
    }
    if (screenDns) await assertPublicHost(u.hostname);
    // `redirect: 'manual'` is forced — that's the whole point; a hop is only
    // followed after the loop re-screens its target.
    res = await doFetch(current, { ...init, redirect: 'manual' });
    const location =
      res && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) break;
    if (hop >= maxRedirects) throw new Error('too many redirects');
    try {
      current = new URL(location, current).href;
    } catch {
      throw new Error('invalid redirect location');
    }
  }
  return res;
}
