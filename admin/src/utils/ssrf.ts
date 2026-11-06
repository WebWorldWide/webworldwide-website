// @ts-check
/**
 * ssrf.ts — the single SSRF guard for every server-side fetch of a URL that
 * an outsider or an admin can influence (webmention sources, oEmbed / OG
 * scraping, Bluesky cover images, Mastodon instance URLs).
 *
 * Defences:
 *   1. Scheme: only http(s); a redirect may never downgrade https → http.
 *   2. Address classes: every IANA special-purpose range is refused — RFC 1918,
 *      loopback, link-local, CGNAT 100.64/10 (this host's Tailscale net),
 *      benchmarking 198.18/15, documentation, multicast/reserved, IPv6 ULA /
 *      link-local / multicast, IPv4-mapped/-compatible, NAT64 (64:ff9b::/96),
 *      6to4 and Teredo (which embed arbitrary IPv4 addresses).
 *   3. DNS pinning: the default fetch uses an undici Agent whose `lookup`
 *      resolves, screens EVERY returned address, and hands the socket the
 *      vetted address — so a rebinding DNS server can't answer "public" to the
 *      pre-check and "private" to the connect.
 *   4. Redirects are followed manually; each hop is re-screened.
 */

import { promises as dnsPromises, lookup as dnsLookup } from 'dns';
import { BlockList, isIP } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

const BLOCKED_V4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT / Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  BLOCKED_V4.addSubnet(net, bits, 'ipv4');
}
// Separate list: Node's BlockList also matches IPv4 lookups against IPv6
// rules in IPv4-mapped form, so a ::ffff:0:0/96 rule here would block ALL v4.
const BLOCKED_V6 = new BlockList();
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated) — embeds an IPv4 address
  ['64:ff9b::', 96], // NAT64 — embeds an IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo — embeds an IPv4 address
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 — embeds an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(net, bits, 'ipv6');
}

const stripBrackets = (h: unknown) =>
  String(h || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

/**
 * Is a literal IP address (v4 or v6, any textual form) non-public? Non-IP
 * strings return true (fail closed).
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function ipIsPrivate(ip: string): boolean {
  const h = stripBrackets(ip).replace(/%.*$/, ''); // drop a zone id (fe80::1%eth0)
  const family = isIP(h);
  if (family === 4) return BLOCKED_V4.check(h, 'ipv4');
  if (family !== 6) return true;
  // IPv4-mapped (::ffff:a.b.c.d, or the hex form ::ffff:7f00:1): judge the
  // embedded IPv4 address. URL parsing canonicalises every textual form.
  const canon = new URL(`http://[${h}]/`).hostname.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return BLOCKED_V4.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return BLOCKED_V6.check(canon, 'ipv6');
}

/**
 * Lexical screen of a URL hostname: localhost-ish names, mDNS/internal TLDs,
 * single-label names (docker service names like `cms`, `remark42`), and any IP
 * literal in a non-public range. Also catches legacy numeric forms browsers
 * and some resolvers accept (`2130706433`, `0x7f.1`, `127.1`).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHost(hostname: string): boolean {
  const h = stripBrackets(hostname).replace(/\.$/, '');
  if (!h) return true;
  if (isIP(h)) return ipIsPrivate(h);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan|home|arpa|localdomain|home\.arpa)$/.test(h)) return true;
  // Single-label names resolve via the docker/search domain to internal hosts.
  if (!h.includes('.')) return true;
  // Numeric-only / hex / octal "hostnames" are IPv4 in disguise.
  if (h.split('.').every((label) => /^(0x[0-9a-f]*|[0-9]+)$/.test(label))) return true;
  return false;
}

/**
 * Resolve `hostname` and reject if ANY A/AAAA record is non-public. Used as a
 * pre-check (and by tests); the pinned Agent below repeats it at connect time.
 *
 * @param {string} hostname
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const target = stripBrackets(hostname);
  if (isIP(target)) {
    if (ipIsPrivate(target)) throw new Error('refusing fetch to a private/non-public host');
    return;
  }
  let addrs;
  try {
    addrs = await dnsPromises.lookup(target, { all: true, verbatim: true });
  } catch {
    throw new Error('refusing fetch: host did not resolve');
  }
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) {
    throw new Error('refusing fetch to a private/non-public host');
  }
}

/**
 * dns.lookup replacement for the socket: resolve all addresses, refuse the
 * whole host if any is non-public, and connect only to a vetted address.
 */
function pinnedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : options || {};
  const cb = typeof options === 'function' ? options : callback;
  dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length || list.some((a) => ipIsPrivate(a.address))) {
      const e = new Error('refusing connection to a private/non-public address') as Error & {
        code?: string;
      };
      e.code = 'ESSRF';
      return cb(e);
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

let pinnedAgent: Agent | null = null;
function getPinnedAgent() {
  if (!pinnedAgent) {
    pinnedAgent = new Agent({
      connect: { lookup: pinnedLookup, timeout: 10_000 },
      // Never reuse a socket across hosts; keep the pool small.
      connections: 8,
    });
  }
  return pinnedAgent;
}

/** fetch() that can only connect to public addresses. */
export const pinnedFetch = (url: string, init: RequestInit = {}) =>
  undiciFetch(url, {
    ...(init as any),
    dispatcher: getPinnedAgent(),
  }) as unknown as Promise<Response>;

type ScreenedFetchOptions = {
  fetchImpl?: typeof fetch;
  init?: RequestInit;
  maxRedirects?: number;
  screenDns?: boolean;
};

/**
 * Fetch `url` with SSRF screening (see module header). Returns the final
 * Response; the caller decides how to read it (and must cap the body).
 *
 * `fetchImpl` lets tests inject a mock; production uses the DNS-pinned fetch.
 *
 * @param {string} url
 * @param {ScreenedFetchOptions} [opts]
 * @returns {Promise<Response>}
 */
export async function screenedFetch(url: string, opts: ScreenedFetchOptions = {}) {
  const doFetch = opts.fetchImpl || pinnedFetch;
  const init = opts.init || {};
  const maxRedirects = opts.maxRedirects ?? 4;
  const screenDns = opts.screenDns ?? true;
  let current = url;
  let startedHttps = false;
  let res;
  for (let hop = 0; ; hop += 1) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`refusing non-http(s) URL: ${u.protocol}`);
    }
    if (isPrivateHost(u.hostname)) {
      throw new Error('refusing fetch to a private/non-public host');
    }
    if (hop === 0) startedHttps = u.protocol === 'https:';
    else if (startedHttps && u.protocol !== 'https:') {
      throw new Error('refusing redirect that downgrades https to http');
    }
    if (u.username || u.password) throw new Error('refusing URL with embedded credentials');
    if (screenDns) await assertPublicHost(u.hostname);
    // `redirect: 'manual'` is forced — a hop is only followed after the loop
    // re-screens its target.
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
