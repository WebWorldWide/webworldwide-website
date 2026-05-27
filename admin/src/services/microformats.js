// @ts-check
/**
 * microformats.js — Phase 8 Webmention helper.
 *
 * Parses a fetched source HTML document and extracts the pieces a
 * Webmention receiver needs to attribute and classify a mention:
 *
 *   - Does the source actually link to `target`? (the W3C spec MUST)
 *   - What kind of mention is it? (reply / like / repost / bookmark /
 *     generic mention — derived from `u-in-reply-to`, `u-like-of`,
 *     `u-repost-of`, `u-bookmark-of`)
 *   - Who's the author? (`h-card` on the source's root h-entry, or
 *     the page's h-card fallback)
 *   - What's the content? (`e-content` of the h-entry, plain-text
 *     fallback to `<title>`)
 *
 * We deliberately keep this module pure (no DB, no fetch). Tests
 * feed it a string of HTML and assert the shape. The route module
 * (`routes/webmentions.js`) handles fetch + persistence.
 *
 * Returned shape:
 *
 *   {
 *     linksToTarget: boolean,
 *     type: 'reply' | 'like' | 'repost' | 'bookmark' | 'mention',
 *     author: { name: string|null, url: string|null, photo: string|null },
 *     content: string|null,
 *     summary: string|null,
 *   }
 */

import { mf2 } from 'microformats-parser';

/**
 * Parse a fetched source HTML body and classify the webmention.
 *
 * @param {string} html — the raw HTML body from the source URL.
 * @param {string} sourceUrl — the URL that was fetched (used as the
 *   microformats baseUrl so relative links resolve).
 * @param {string} targetUrl — the post URL that received the
 *   webmention; used both for back-link validation and for
 *   `u-in-reply-to` etc. matching.
 * @returns {{
 *   linksToTarget: boolean,
 *   type: 'reply' | 'like' | 'repost' | 'bookmark' | 'mention',
 *   author: { name: string|null, url: string|null, photo: string|null },
 *   content: string|null,
 *   summary: string|null,
 * }}
 */
export function parseSource(html, sourceUrl, targetUrl) {
  let parsed;
  try {
    parsed = mf2(html, { baseUrl: sourceUrl });
  } catch (_err) {
    // mf2 throws on malformed input; treat as "no microformats".
    return {
      linksToTarget: htmlLinksTo(html, targetUrl),
      type: 'mention',
      author: { name: null, url: null, photo: null },
      content: null,
      summary: null,
    };
  }

  const normalisedTarget = normaliseUrl(targetUrl);

  // ── Find the relevant h-entry. We prefer the first top-level
  // h-entry that mentions the target (via u-in-reply-to / like-of /
  // repost-of / bookmark-of / a plain link in e-content). Falls back
  // to the first h-entry of any kind, then to no entry at all.
  const entries = collectHEntries(parsed.items);

  /** @type {'reply' | 'like' | 'repost' | 'bookmark' | 'mention'} */
  let type = 'mention';
  let matchedEntry = null;

  const TYPE_PROPS = /** @type {const} */ ([
    ['in-reply-to', 'reply'],
    ['like-of', 'like'],
    ['repost-of', 'repost'],
    ['bookmark-of', 'bookmark'],
  ]);

  for (const entry of entries) {
    for (const [prop, t] of TYPE_PROPS) {
      const urls = collectUrls(entry.properties?.[prop]);
      if (urls.some((u) => normaliseUrl(u) === normalisedTarget)) {
        type = t;
        matchedEntry = entry;
        break;
      }
    }
    if (matchedEntry) break;
  }

  if (!matchedEntry && entries.length) {
    matchedEntry = entries[0];
  }

  // ── Author info: prefer the h-entry's p-author h-card; fall back
  // to the document's rel="author" link, then the first h-card.
  const author = extractAuthor(matchedEntry, parsed, sourceUrl);

  // ── Content & summary: e-content (HTML) text, p-summary, or null.
  const content = matchedEntry ? extractContent(matchedEntry) : null;
  const summary = matchedEntry ? extractSummary(matchedEntry) : null;

  // ── Validation: a webmention is only valid if the source body
  // actually links to the target. Microformats provide a structured
  // path (u-in-reply-to etc.); we also accept a plain `<a href>` in
  // the body as a fallback (per W3C — the link discovery rule).
  let linksToTarget = false;
  if (type !== 'mention') {
    // We already proved it via the structured property match.
    linksToTarget = true;
  } else if (
    parsed['rel-urls'] &&
    Object.keys(parsed['rel-urls']).some((u) => normaliseUrl(u) === normalisedTarget)
  ) {
    linksToTarget = true;
  } else {
    linksToTarget = htmlLinksTo(html, targetUrl);
  }

  return { linksToTarget, type, author, content, summary };
}

/**
 * Recursively collect every h-entry from a microformats tree.
 *
 * @param {any[]} items
 * @returns {any[]}
 */
function collectHEntries(items) {
  const out = [];
  for (const item of items || []) {
    if (Array.isArray(item.type) && item.type.includes('h-entry')) {
      out.push(item);
    }
    if (Array.isArray(item.children) && item.children.length) {
      out.push(...collectHEntries(item.children));
    }
  }
  return out;
}

/**
 * Microformat properties are arrays of mixed strings / objects with
 * `value` / `html`. This pulls every URL-ish string out.
 *
 * @param {any[]|undefined} prop
 * @returns {string[]}
 */
function collectUrls(prop) {
  if (!Array.isArray(prop)) return [];
  const out = [];
  for (const v of prop) {
    if (typeof v === 'string') {
      out.push(v);
    } else if (v && typeof v === 'object') {
      // h-cite shape: { type:['h-cite'], properties:{ url:[…] } }
      if (Array.isArray(v.type) && v.type.includes('h-cite')) {
        out.push(...collectUrls(v.properties?.url));
      }
      if (typeof v.value === 'string') out.push(v.value);
    }
  }
  return out;
}

/**
 * Cheap URL normaliser for back-link matching. We canonicalise the
 * scheme + host case, drop trailing slashes on the path, and drop
 * the fragment. Querystrings stay (they're often load-bearing).
 *
 * @param {string} input
 * @returns {string}
 */
export function normaliseUrl(input) {
  if (typeof input !== 'string' || !input) return '';
  let u;
  try {
    u = new URL(input);
  } catch {
    return input.trim().toLowerCase();
  }
  u.hash = '';
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  // Trim trailing slash on non-root paths so "/foo/" and "/foo" match.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

/**
 * @param {any} entry
 * @param {{ items: any[], rels?: Record<string,string[]> }} parsed
 * @param {string} sourceUrl
 * @returns {{ name: string|null, url: string|null, photo: string|null }}
 */
function extractAuthor(entry, parsed, sourceUrl) {
  // p-author on the h-entry first.
  const authors = entry?.properties?.author;
  if (Array.isArray(authors) && authors.length) {
    const a = authors[0];
    if (typeof a === 'string') {
      return { name: a, url: null, photo: null };
    }
    if (a && typeof a === 'object' && a.properties) {
      return shapeCard(a.properties);
    }
  }

  // Standalone h-card on the page.
  for (const item of parsed.items || []) {
    if (Array.isArray(item.type) && item.type.includes('h-card')) {
      return shapeCard(item.properties);
    }
  }

  // rel="author" → URL only.
  const authorUrls = parsed.rels?.author;
  if (Array.isArray(authorUrls) && authorUrls.length) {
    return { name: null, url: authorUrls[0], photo: null };
  }

  // Fallback: derive a name from the source host.
  try {
    return { name: new URL(sourceUrl).hostname, url: sourceUrl, photo: null };
  } catch {
    return { name: null, url: null, photo: null };
  }
}

/** @param {Record<string, any[]>} props */
function shapeCard(props) {
  return {
    name: stringy(props?.name?.[0]) || null,
    url: stringy(props?.url?.[0]) || null,
    photo: stringy(props?.photo?.[0]) || null,
  };
}

/**
 * Coerce a microformats value (string | { value } | { html, value }) to a string.
 * @param v
 */
function stringy(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (typeof v.value === 'string') return v.value;
    if (typeof v.html === 'string') return v.html;
  }
  return '';
}

/** @param {any} entry */
function extractContent(entry) {
  const c = entry?.properties?.content?.[0];
  if (!c) return null;
  if (typeof c === 'string') return c;
  if (typeof c === 'object') {
    // Prefer the plain-text `.value` (already stripped of tags by
    // microformats-parser); HTML is available via `.html` if needed.
    return c.value || c.html || null;
  }
  return null;
}

/** @param {any} entry */
function extractSummary(entry) {
  const s = entry?.properties?.summary?.[0];
  if (!s) return null;
  if (typeof s === 'string') return s;
  if (typeof s === 'object' && typeof s.value === 'string') return s.value;
  return null;
}

/**
 * Last-resort back-link check: scan the raw HTML for any `<a href>`,
 * `<link href>`, or bare URL that matches the target. Used when the
 * source has no microformats AT ALL but still includes a link.
 *
 * Not a full HTML parser — by design. Webmention validation is the
 * security perimeter (we only render approved + back-linked mentions),
 * so a cheap regex that yields no false-positives-against-the-target
 * is enough. Worst case: a spammer includes our URL in plain text
 * with no actual link → we still might mark it `linksToTarget=true`
 * (admin then rejects via the moderation queue).
 *
 * @param {string} html
 * @param {string} target
 * @returns {boolean}
 */
export function htmlLinksTo(html, target) {
  if (typeof html !== 'string' || !html) return false;
  const normTarget = normaliseUrl(target);
  if (!normTarget) return false;
  // Pull every absolute http(s) URL out of the body and normalise.
  const matches = html.match(/https?:\/\/[^\s"'<>()]+/gi) || [];
  for (const m of matches) {
    if (normaliseUrl(stripTrailingPunct(m)) === normTarget) return true;
  }
  return false;
}

/**
 * Strip a trailing `.`, `,`, `;`, `)`, `"` etc. that the URL regex over-collects.
 * @param s
 */
function stripTrailingPunct(s) {
  return s.replace(/[)\].,;:"'!?]+$/, '');
}

export default { parseSource, normaliseUrl, htmlLinksTo };
