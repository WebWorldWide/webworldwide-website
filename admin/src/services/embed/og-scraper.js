// @ts-check
/**
 * og-scraper.js — Open Graph + Twitter Card metadata extractor.
 *
 * The generic embed provider falls back to a server-side scrape so a
 * link to any HTML page renders as a rich link card on the published
 * site (no iframe; no JS; no privacy surprise). We only look at the
 * first 256 KB of the document — modern OG tags live in `<head>` and
 * any page that pushes them past 256 KB is shipping anti-patterns
 * we don't want to amplify by parsing megabytes of HTML.
 *
 * The "parser" is intentionally regex-only. We do not have jsdom on the
 * server-startup hot path (admin/server.js already paid for it once for
 * the bundle build; loading it here would balloon cold-start by 30 MB).
 * The shape of `<meta name="…" content="…">` is rigid enough that the
 * regex is reliable in practice — and we fail closed: if a tag is
 * missing we return an empty string, never a partial.
 *
 * Allowed inputs: https only. The route enforces the scheme; we
 * additionally short-circuit if asked for anything else.
 */

import { readCappedText, setFetchImpl as _set } from './oembed.js';

// Re-export so tests don't have to import from oembed.js too.
export { setFetchImpl } from './oembed.js';

// Keep the linter happy — the re-export above is the public API; the
// underscore import is here so a refactor that drops the import in
// oembed.js trips a build error.
void _set;

const USER_AGENT = 'TerminalEighty/1.0 (+https://terminaleighty)';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;

/**
 * Fetch + scrape OG / Twitter Card metadata.
 *
 * @param {string} href
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ title: string, description: string, image: string, siteName: string }>}
 */
export async function scrapeOpenGraph(href, opts) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return empty();
  }
  if (url.protocol !== 'https:') return empty();

  const fetchFn = opts?.fetchImpl || globalThis.fetch;
  if (!fetchFn) return empty();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(url.href, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch {
    clearTimeout(timer);
    // Soft fail — return host-only card so the user still gets a link.
    return { title: url.hostname, description: '', image: '', siteName: url.hostname };
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) {
    return { title: url.hostname, description: '', image: '', siteName: url.hostname };
  }
  const html = await readCappedText(res, MAX_BYTES);
  const parsed = parseOgFromHtml(html, url);
  return parsed;
}

/**
 * Pure parser — split out so tests can exercise it without a network.
 *
 * @param {string} html
 * @param {URL} baseUrl
 */
export function parseOgFromHtml(html, baseUrl) {
  if (typeof html !== 'string' || !html) {
    return { title: baseUrl.hostname, description: '', image: '', siteName: baseUrl.hostname };
  }
  // Restrict scanning to the head if present — there's no value in
  // parsing the body, and many pages embed `<meta>` lookalikes inside
  // article bodies that would confuse a naive scan.
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const haystack = headMatch ? headMatch[1] : html;

  const og = {
    title:
      pickMeta(haystack, 'og:title') ||
      pickMeta(haystack, 'twitter:title') ||
      pickTitle(haystack) ||
      baseUrl.hostname,
    description:
      pickMeta(haystack, 'og:description') ||
      pickMeta(haystack, 'twitter:description') ||
      pickMetaName(haystack, 'description') ||
      '',
    image:
      pickMeta(haystack, 'og:image:secure_url') ||
      pickMeta(haystack, 'og:image') ||
      pickMeta(haystack, 'twitter:image') ||
      pickMeta(haystack, 'twitter:image:src') ||
      '',
    siteName: pickMeta(haystack, 'og:site_name') || baseUrl.hostname,
  };
  // Normalise relative image URLs.
  if (og.image && !/^https?:\/\//i.test(og.image)) {
    try {
      og.image = new URL(og.image, baseUrl).href;
    } catch {
      og.image = '';
    }
  }
  // Clip overly-long descriptions — Hugo shortcodes choke on huge
  // attribute strings (and 2 KB is enough for any card).
  if (og.description.length > 600) og.description = og.description.slice(0, 597).trimEnd() + '…';
  return og;
}

/**
 * `<meta property="…" content="…">` — OG style.
 * Tolerates attribute order, single/double quotes, and stray whitespace.
 *
 * @param {string} html
 * @param {string} key
 */
function pickMeta(html, key) {
  // First try property="key" content="…"
  let re = new RegExp(
    `<meta[^>]*\\bproperty\\s*=\\s*["']${escapeRe(key)}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  let m = html.match(re);
  if (m) return decodeEntities(m[1].trim());
  // Then try content="…" property="key" (attribute order swapped).
  re = new RegExp(
    `<meta[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bproperty\\s*=\\s*["']${escapeRe(key)}["']`,
    'i',
  );
  m = html.match(re);
  if (m) return decodeEntities(m[1].trim());
  // Twitter cards use `name=` instead of `property=`.
  re = new RegExp(
    `<meta[^>]*\\bname\\s*=\\s*["']${escapeRe(key)}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  m = html.match(re);
  if (m) return decodeEntities(m[1].trim());
  return '';
}

/**
 * `<meta name="description" content="…">` style — fallback when there's
 * no OG description.
 *
 * @param {string} html
 * @param {string} key
 */
function pickMetaName(html, key) {
  const re = new RegExp(
    `<meta[^>]*\\bname\\s*=\\s*["']${escapeRe(key)}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  if (m) return decodeEntities(m[1].trim());
  return '';
}

/** @param {string} html */
function pickTitle(html) {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return decodeEntities(m[1].replace(/\s+/g, ' ').trim());
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} s */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function empty() {
  return { title: '', description: '', image: '', siteName: '' };
}
