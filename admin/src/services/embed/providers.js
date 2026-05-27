// @ts-check
/**
 * providers.js — Phase 7 embed provider registry.
 *
 * Each provider entry knows how to:
 *
 *   1. `match(url)`       — recognise a URL it can handle. Returns a
 *                            small descriptor or `null` if the URL is
 *                            not ours. The descriptor carries the
 *                            extracted id (and any other fields we'll
 *                            need to render the shortcode without
 *                            re-parsing the URL).
 *
 *   2. `resolve(url, ctx)` — produce a uniform record:
 *                            `{ provider, id, shortcode, html, thumbnail,
 *                              title, author, width, height, type }`.
 *                            Most providers do this by calling oEmbed
 *                            (see `oembed.js`); Gist uses a static
 *                            template; the generic provider scrapes OG.
 *
 * The route (`admin/src/routes/embed.js`) walks the registry, returns
 * the first matching provider's record, caches it, and hands the
 * payload to the editor.
 *
 * Forward-compat — Mastodon: there is no single "mastodon.com" host.
 * Every instance ships its own oEmbed endpoint at `/api/oembed`. We
 * pattern-match on `/@<user>/<status-id>` and accept the host from the
 * URL itself, then dial that host's oEmbed. The provider denylist below
 * blocks well-known non-Mastodon hosts that happen to share the same
 * URL shape (Bluesky's `bsky.app` uses `/profile/...` so it doesn't
 * collide; Threads's `threads.net` uses `/@user/post/<id>` which is
 * similar, but we exclude it explicitly — Threads does not ship oEmbed
 * for the public web at time of writing).
 */

import { fetchOEmbed } from './oembed.js';
import { scrapeOpenGraph } from './og-scraper.js';

// Hosts that look like Mastodon but aren't. Add new ones here.
const MASTODON_HOST_DENY = new Set([
  'threads.net',
  'www.threads.net',
  'twitter.com',
  'www.twitter.com',
  'x.com',
  'www.x.com',
]);

/**
 * @typedef {object} EmbedRecord
 * @property {string}  provider   short id ("youtube", "generic", …)
 * @property {string=} id         provider-native id (videoId, gistId, …)
 * @property {string}  shortcode  Hugo shortcode the editor inserts
 * @property {string=} html       provider HTML (oEmbed) — informational
 * @property {string=} thumbnail
 * @property {string=} title
 * @property {string=} author
 * @property {number=} width
 * @property {number=} height
 * @property {string=} description
 * @property {"video"|"rich"|"photo"|"link"} type
 */

// ── per-provider matchers ──────────────────────────────────────────

/**
 * YouTube — accepts youtube.com/watch?v=…, youtu.be/…, /shorts/…,
 * /embed/…. We extract the 11-char video id and let the oEmbed call
 * return canonical metadata.
 *
 * @param {URL} u
 */
function matchYoutube(u) {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (/^[\w-]{6,}$/.test(id)) return { id };
    return null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{6,}$/.test(v)) return { id: v };
    // /embed/ID or /shorts/ID
    const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/);
    if (m) return { id: m[1] };
  }
  return null;
}

/**
 * @param {URL} u
 */
function matchVimeo(u) {
  if (u.hostname.replace(/^www\./, '') !== 'vimeo.com') return null;
  const m = u.pathname.match(/^\/(\d{6,})/);
  if (!m) return null;
  return { id: m[1] };
}

/**
 * @param {URL} u
 */
function matchBluesky(u) {
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'bsky.app') return null;
  // /profile/<handle>/post/<rkey>
  const m = u.pathname.match(/^\/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (!m) return null;
  return { handle: m[1], rkey: m[2] };
}

/**
 * @param {URL} u
 */
function matchMastodon(u) {
  if (MASTODON_HOST_DENY.has(u.hostname)) return null;
  // /@<user>/<status-id>  (status id is numeric, 17+ digits)
  // Also accept /web/@user/<id> for the modern web UI.
  let m = u.pathname.match(/^\/@([^/]+)\/(\d{6,})/);
  if (!m) m = u.pathname.match(/^\/web\/@([^/]+)\/(\d{6,})/);
  if (!m) return null;
  return { host: u.hostname, user: m[1], statusId: m[2] };
}

/**
 * @param {URL} u
 */
function matchTiktok(u) {
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'tiktok.com' && host !== 'vm.tiktok.com') return null;
  // /@<user>/video/<id>  — the canonical paste shape.
  const m = u.pathname.match(/^\/@([^/]+)\/video\/(\d+)/);
  if (m) return { user: m[1], id: m[2] };
  // Short links — keep the id from the path tail; resolution happens
  // at oEmbed time which follows the redirect server-side.
  if (host === 'vm.tiktok.com' && /^\/[A-Za-z0-9]+/.test(u.pathname)) {
    return { shortlink: true };
  }
  return null;
}

/**
 * @param {URL} u
 */
function matchGist(u) {
  if (u.hostname !== 'gist.github.com') return null;
  // /<owner>/<id>
  const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f]{6,})/);
  if (!m) return null;
  return { owner: m[1], id: m[2] };
}

/**
 * @param {URL} u
 */
function matchCodepen(u) {
  if (u.hostname.replace(/^www\./, '') !== 'codepen.io') return null;
  // /<user>/pen/<id>
  const m = u.pathname.match(/^\/([^/]+)\/pen\/([A-Za-z]+)/);
  if (!m) return null;
  return { user: m[1], id: m[2] };
}

/**
 * @param {URL} u
 */
function matchSoundcloud(u) {
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'soundcloud.com') return null;
  // /<user>/<track>   or  /<user>/sets/<playlist>
  if (!/^\/[^/]+\/[^/]+/.test(u.pathname)) return null;
  return { path: u.pathname };
}

/**
 * @param {URL} u
 */
function matchSpotify(u) {
  if (u.hostname !== 'open.spotify.com') return null;
  // /<type>/<id>
  const m = u.pathname.match(/^\/(track|album|episode|show|playlist|artist)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  return { kind: m[1], id: m[2] };
}

// ── shortcode formatters ───────────────────────────────────────────
//
// Hugo shortcode params are quoted strings; the inner Markdown writers
// (the editor's paste handler) call `fmt*` directly, so we keep the
// quoting helper here next to the providers.

/**
 * @param {string} s
 */
function q(s) {
  return String(s === null || s === undefined ? '' : s).replace(/"/g, '\\"');
}

// ── provider registry ─────────────────────────────────────────────

/**
 * @typedef {object} Provider
 * @property {string} name
 * @property {(url: URL) => object | null} match
 * @property {(url: URL, m: any) => Promise<EmbedRecord>} resolve
 */

/** @type {Provider[]} */
export const PROVIDERS = [
  {
    name: 'youtube',
    match: matchYoutube,
    /**
     * @param {URL} url @param {{ id: string }} m
     * @param m
     */
    async resolve(url, m) {
      const oembed = await fetchOEmbed(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`,
        { provider: 'youtube' },
      );
      const id = m.id;
      const title = oembed?.title || `YouTube video ${id}`;
      const shortcode = `{{< embed-youtube id="${q(id)}" title="${q(title)}" >}}`;
      return shape('youtube', id, shortcode, oembed, 'video');
    },
  },
  {
    name: 'vimeo',
    match: matchVimeo,
    /**
     * @param {URL} url @param {{ id: string }} m
     * @param m
     */
    async resolve(url, m) {
      const oembed = await fetchOEmbed(
        `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url.href)}`,
        { provider: 'vimeo' },
      );
      const id = m.id;
      const title = oembed?.title || `Vimeo video ${id}`;
      const shortcode = `{{< embed-vimeo id="${q(id)}" title="${q(title)}" >}}`;
      return shape('vimeo', id, shortcode, oembed, 'video');
    },
  },
  {
    name: 'bluesky',
    match: matchBluesky,
    /**
     * @param {URL} url @param {{ handle: string, rkey: string }} m
     * @param m
     */
    async resolve(url, m) {
      const oembed = await fetchOEmbed(
        `https://embed.bsky.app/oembed?url=${encodeURIComponent(url.href)}`,
        { provider: 'bluesky' },
      );
      const title = oembed?.title || `Post by ${m.handle}`;
      const shortcode =
        `{{< embed-bluesky url="${q(url.href)}" handle="${q(m.handle)}" ` +
        `rkey="${q(m.rkey)}" title="${q(title)}" >}}`;
      return shape('bluesky', `${m.handle}/${m.rkey}`, shortcode, oembed, 'rich');
    },
  },
  {
    name: 'mastodon',
    match: matchMastodon,
    /**
     * @param {URL} url @param {{ host: string, user: string, statusId: string }} m
     * @param m
     */
    async resolve(url, m) {
      // Per-instance oEmbed endpoint — the path is identical, but the
      // host comes from the input URL.
      const oembed = await fetchOEmbed(
        `https://${m.host}/api/oembed?url=${encodeURIComponent(url.href)}&format=json`,
        { provider: 'mastodon' },
      );
      const title = oembed?.title || `Post by @${m.user}@${m.host}`;
      const shortcode =
        `{{< embed-mastodon url="${q(url.href)}" host="${q(m.host)}" ` +
        `user="${q(m.user)}" id="${q(m.statusId)}" title="${q(title)}" >}}`;
      return shape('mastodon', `${m.user}@${m.host}/${m.statusId}`, shortcode, oembed, 'rich');
    },
  },
  {
    name: 'tiktok',
    match: matchTiktok,
    /** @param {URL} url */
    async resolve(url) {
      const oembed = await fetchOEmbed(
        `https://www.tiktok.com/oembed?url=${encodeURIComponent(url.href)}`,
        { provider: 'tiktok' },
      );
      const title = oembed?.title || 'TikTok video';
      // oEmbed payload provides the canonical embed id in `embed_product_id`
      // (newer responses) or we fall back to the URL.
      const id = oembed?.embed_product_id || oembed?.video_id || '';
      const shortcode = `{{< embed-tiktok url="${q(url.href)}" title="${q(title)}" >}}`;
      return shape('tiktok', String(id), shortcode, oembed, 'video');
    },
  },
  {
    name: 'gist',
    match: matchGist,
    /**
     * @param {URL} url @param {{ owner: string, id: string }} m
     * @param m
     */
    async resolve(url, m) {
      // Gist doesn't ship oEmbed. We synthesise a record so the cache
      // and shortcode emission stay uniform with the oEmbed providers.
      const shortcode = `{{< embed-gist owner="${q(m.owner)}" id="${q(m.id)}" >}}`;
      return shape(
        'gist',
        `${m.owner}/${m.id}`,
        shortcode,
        {
          html: `<script src="https://gist.github.com/${m.owner}/${m.id}.js"></script>`,
          title: `Gist ${m.id}`,
          author_name: m.owner,
        },
        'rich',
      );
    },
  },
  {
    name: 'codepen',
    match: matchCodepen,
    /**
     * @param {URL} url @param {{ user: string, id: string }} m
     * @param m
     */
    async resolve(url, m) {
      const oembed = await fetchOEmbed(
        `https://codepen.io/api/oembed?url=${encodeURIComponent(url.href)}&format=json`,
        { provider: 'codepen' },
      );
      const title = oembed?.title || `Pen by ${m.user}`;
      const shortcode =
        `{{< embed-codepen user="${q(m.user)}" id="${q(m.id)}" ` + `title="${q(title)}" >}}`;
      return shape('codepen', `${m.user}/${m.id}`, shortcode, oembed, 'rich');
    },
  },
  {
    name: 'soundcloud',
    match: matchSoundcloud,
    /** @param {URL} url */
    async resolve(url) {
      const oembed = await fetchOEmbed(
        `https://soundcloud.com/oembed?url=${encodeURIComponent(url.href)}&format=json`,
        { provider: 'soundcloud' },
      );
      const title = oembed?.title || 'SoundCloud track';
      const shortcode = `{{< embed-soundcloud url="${q(url.href)}" title="${q(title)}" >}}`;
      return shape('soundcloud', url.pathname, shortcode, oembed, 'rich');
    },
  },
  {
    name: 'spotify',
    match: matchSpotify,
    /**
     * @param {URL} url @param {{ kind: string, id: string }} m
     * @param m
     */
    async resolve(url, m) {
      const oembed = await fetchOEmbed(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(url.href)}`,
        { provider: 'spotify' },
      );
      const title = oembed?.title || `Spotify ${m.kind}`;
      const shortcode =
        `{{< embed-spotify kind="${q(m.kind)}" id="${q(m.id)}" ` + `title="${q(title)}" >}}`;
      return shape('spotify', `${m.kind}/${m.id}`, shortcode, oembed, 'rich');
    },
  },
  // Generic fallback — must stay last. Always matches; never throws.
  {
    name: 'generic',
    /** @returns {object} */
    match() {
      return {};
    },
    /** @param {URL} url */
    async resolve(url) {
      const og = await scrapeOpenGraph(url.href);
      // The generic shortcode renders fully server-side as an OG card,
      // so the shortcode params carry the scraped fields directly.
      const title = og.title || url.hostname;
      const desc = og.description || '';
      const img = og.image || '';
      const shortcode =
        `{{< embed-generic url="${q(url.href)}" title="${q(title)}" ` +
        `description="${q(desc)}" image="${q(img)}" >}}`;
      return {
        provider: 'generic',
        id: url.href,
        shortcode,
        html: '',
        thumbnail: img,
        title,
        author: og.siteName || '',
        width: 0,
        height: 0,
        description: desc,
        type: 'link',
      };
    },
  },
];

/**
 * Walk the registry and return the first { provider, match } pair that
 * recognises the URL. The generic fallback always matches, so this
 * function never returns null for an https URL.
 *
 * @param {URL} url
 * @returns {{ provider: Provider, match: object }}
 */
export function pickProvider(url) {
  for (const provider of PROVIDERS) {
    const m = provider.match(url);
    if (m) return { provider, match: m };
  }
  // Unreachable — `generic` always matches — but TypeScript can't see it.
  return { provider: PROVIDERS[PROVIDERS.length - 1], match: {} };
}

/**
 * Shape an oEmbed (or oEmbed-shaped) payload into the uniform record.
 *
 * @param {string} provider
 * @param {string} id
 * @param {string} shortcode
 * @param {any} oembed
 * @param {"video"|"rich"|"photo"|"link"} fallbackType
 * @returns {EmbedRecord}
 */
function shape(provider, id, shortcode, oembed, fallbackType) {
  const o = oembed || {};
  // oEmbed types map to ours; some providers ship 'video' as the type
  // even for non-iframe payloads. We fall back if missing.
  const type =
    o.type === 'video' || o.type === 'rich' || o.type === 'photo' || o.type === 'link'
      ? o.type
      : fallbackType;
  return {
    provider,
    id,
    shortcode,
    html: o.html || '',
    thumbnail: o.thumbnail_url || '',
    title: o.title || '',
    author: o.author_name || '',
    width: Number(o.width) || 0,
    height: Number(o.height) || 0,
    type,
  };
}
