// @ts-check
/**
 * bluesky.js — Phase 9 AT Protocol / Bluesky cross-post service.
 *
 * Wraps `@atproto/api` (the official BskyAgent) so the rest of the
 * admin CMS never has to think about session management, post-record
 * shapes, or the AT URI / web URL split. The publish flow calls
 * `postThread()` after a successful git push; the comments-reply
 * handler calls `replyToPost()` when an admin replies to a webmention
 * whose source lives on bsky.app.
 *
 * Configuration (env vars)
 * ------------------------
 *   BLUESKY_HANDLE        — full handle of the posting account.
 *                           e.g. `blog.webworldwide.online`.
 *   BLUESKY_APP_PASSWORD  — app-password generated at
 *                           https://bsky.app/settings/app-passwords —
 *                           NOT the main account password.
 *   BLUESKY_SERVICE       — PDS to talk to. Default
 *                           `https://bsky.social`. Override for
 *                           self-hosted PDS deployments.
 *
 * Test seam
 * ---------
 * `setAgentFactory(fn)` swaps the BskyAgent constructor for tests so
 * we never make a real network call in CI. Every public method also
 * accepts an injected `agent` argument so the publish flow can hand a
 * pre-authenticated session to a sequence of cross-posts.
 *
 * Design notes
 * ------------
 * - Bluesky's per-post limit is 300 graphemes. We compose conservatively
 *   (300 chars) — overshoot is the long-tail of grapheme-vs-codepoint
 *   weirdness, and we'd rather under-pack than have the agent reject.
 * - The first post carries the link card via `app.bsky.embed.external`
 *   so the in-app preview shows the cover image + title + excerpt
 *   without us having to upload a blob.
 * - Continuation posts (rare; only when the excerpt is huge) chain off
 *   the root as `reply`s. Each one gets a `(2/3)` style numerator so
 *   readers in the BSky timeline see the order even when one post
 *   bubbles up without its siblings.
 * - Failures are NEVER thrown back to the publish caller; the service
 *   logs and returns `{ ok: false, error }`. The publish hook treats
 *   a failed cross-post as a soft warning and keeps going.
 */

import { getSecret } from './app-secrets.js';
import { screenedFetch } from '../utils/ssrf.js';

const DEFAULT_SERVICE = 'https://bsky.social';

/**
 * Resolve Bluesky config. UI-entered values (encrypted in the `app_secrets` DB
 * table via the admin Settings → Syndication panel) take precedence; the
 * docker/.env `BLUESKY_*` vars are the fallback. So the operator can configure
 * it either way and the UI is the source of truth when both are set.
 *
 * @returns {{ handle: string, appPassword: string, service: string }}
 */
export function getBlueskyConfig() {
  return {
    handle: getSecret('bluesky_handle') || process.env.BLUESKY_HANDLE || '',
    appPassword: getSecret('bluesky_app_password') || process.env.BLUESKY_APP_PASSWORD || '',
    service: getSecret('bluesky_service') || process.env.BLUESKY_SERVICE || DEFAULT_SERVICE,
  };
}

// Bluesky's hard limit is 300 graphemes (per richtext); we leave a few
// chars of headroom for the link suffix to dodge grapheme miscounts.
const MAX_POST_CHARS = 300;

/**
 * Factory that returns a BskyAgent-shaped object. Tests can swap this
 * with `setAgentFactory()`; production resolves to the real `@atproto/api`
 * import lazily so a missing package doesn't crash boot when the admin
 * is dev-mode (BLUESKY_* unset).
 *
 * @type {() => Promise<any>}
 */
let agentFactory = async () => {
  const mod = /** @type {any} */ (await import('@atproto/api'));
  const Ctor = mod.BskyAgent || mod.AtpAgent || mod.default?.BskyAgent;
  if (!Ctor) {
    throw new Error('@atproto/api: no BskyAgent / AtpAgent export found');
  }
  return new Ctor({ service: getBlueskyConfig().service });
};

/**
 * Swap the agent factory used by every call below. Pass `null` to reset
 * to the real @atproto/api constructor.
 *
 * @param {(() => Promise<any>) | null | undefined} fn
 */
export function setAgentFactory(fn) {
  agentFactory =
    fn ||
    (async () => {
      const mod = /** @type {any} */ (await import('@atproto/api'));
      const Ctor = mod.BskyAgent || mod.AtpAgent || mod.default?.BskyAgent;
      if (!Ctor) throw new Error('@atproto/api: no BskyAgent / AtpAgent export found');
      return new Ctor({ service: getBlueskyConfig().service });
    });
}

/**
 * Are the env vars set? Callers use this to short-circuit on dev
 * machines without credentials.
 *
 * @returns {boolean}
 */
export function isConfigured() {
  const { handle, appPassword } = getBlueskyConfig();
  return Boolean(handle && appPassword);
}

/**
 * Authenticate against the configured PDS. Returns the agent ready for
 * a sequence of writes. Throws on a missing config or a failed login —
 * the publish hook is responsible for catching.
 *
 * @returns {Promise<any>}
 */
export async function signIn() {
  if (!isConfigured()) {
    throw new Error('BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not set');
  }
  const { handle, appPassword } = getBlueskyConfig();
  const agent = await agentFactory();
  await agent.login({
    identifier: handle,
    password: appPassword,
  });
  return agent;
}

/**
 * Convert a `bsky.app/profile/<handle>/post/<rkey>` web URL into an
 * `at://<did-or-handle>/app.bsky.feed.post/<rkey>` AT URI. Tolerant of
 * trailing slashes, query strings, and the rare `web+bsky` scheme.
 *
 * Returns `null` if the input doesn't match the expected shape.
 *
 * @param {string} webUrl
 * @returns {string | null}
 */
export function webUrlToAtUri(webUrl) {
  if (!webUrl) return null;
  let u;
  try {
    u = new URL(String(webUrl).trim());
  } catch {
    return null;
  }
  // Exact host or a real subdomain only — a bare `bsky\.app$` regex also
  // matches look-alike registrable domains like `notbsky.app`.
  const host = u.hostname.toLowerCase();
  if (host !== 'bsky.app' && !host.endsWith('.bsky.app')) return null;
  // Expected path: /profile/<handle>/post/<rkey>
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  if (parts[0] !== 'profile' || parts[2] !== 'post') return null;
  const handle = parts[1];
  const rkey = parts[3];
  if (!handle || !rkey) return null;
  return `at://${handle}/app.bsky.feed.post/${rkey}`;
}

/**
 * Inverse of `webUrlToAtUri`: turn an `at://` URI into its public
 * bsky.app web URL. Returns null if the URI isn't a Bluesky post.
 *
 * @param {string} atUri
 * @returns {string | null}
 */
export function atUriToWebUrl(atUri) {
  const parts = parseAtUri(atUri);
  if (!parts) return null;
  if (parts.collection !== 'app.bsky.feed.post') return null;
  return `https://bsky.app/profile/${parts.repo}/post/${parts.rkey}`;
}

/**
 * Decompose an AT URI into its components. Returns null on malformed
 * input. Public so the Hugo partial / embed loader can share the same
 * parser as the service.
 *
 * @param {string} atUri
 * @returns {{ repo: string, collection: string, rkey: string } | null}
 */
export function parseAtUri(atUri) {
  if (!atUri) return null;
  const s = String(atUri).trim();
  if (!s.startsWith('at://')) return null;
  const tail = s.slice('at://'.length);
  const parts = tail.split('/');
  if (parts.length < 3) return null;
  const [repo, collection, rkey] = parts;
  if (!repo || !collection || !rkey) return null;
  return { repo, collection, rkey };
}

/**
 * Compose the post-text payloads for a thread, given the title /
 * excerpt / URL. Pure, side-effect-free; exposed for tests so the
 * truncation + chunking can be exercised without touching `@atproto/api`.
 *
 * Always emits at least one entry. The first post embeds the link card
 * (so the URL is implicit there); chained continuation posts include a
 * `(n/N)` numerator so the order survives the Bluesky timeline.
 *
 * @param {{ title: string, excerpt: string, url: string }} input
 * @returns {{ text: string, isRoot: boolean }[]}
 */
export function composeThread({ title, excerpt, url }) {
  const safeTitle = String(title || '').trim();
  const safeExcerpt = String(excerpt || '').trim();
  const safeUrl = String(url || '').trim();

  // ONE post only — title + hook + URL. We deliberately do NOT thread a blog
  // excerpt across reply posts (it reads as spammy, and the link card already
  // carries the description). If the hook is long, trim it so the post still fits.
  let text = singlePostText(safeTitle, safeExcerpt, safeUrl);
  if (text.length > MAX_POST_CHARS) {
    const fixedLen =
      safeTitle.length + safeUrl.length + (safeTitle && safeExcerpt ? 2 : 0) + (safeUrl ? 2 : 0);
    const room = MAX_POST_CHARS - fixedLen;
    const trimmed = room > 1 ? truncateForRoot(safeExcerpt, room) : '';
    text = singlePostText(safeTitle, trimmed, safeUrl);
    // Last resort (e.g. an enormous title): drop the excerpt + hard-cap.
    if (text.length > MAX_POST_CHARS) {
      text = singlePostText(safeTitle, '', safeUrl).slice(0, MAX_POST_CHARS);
    }
  }
  return [{ text, isRoot: true }];
}

/**
 * @param {string} title
 * @param {string} excerpt
 * @param {string} url
 */
function singlePostText(title, excerpt, url) {
  const parts = [];
  if (title) parts.push(title);
  if (excerpt) parts.push(excerpt);
  if (url) parts.push(url);
  return parts.join('\n\n');
}

/**
 * @param {string} title
 * @param {number} budget
 */
function truncateForRoot(title, budget) {
  if (title.length <= budget) return title;
  // Hard cut at the budget; leave room for an ellipsis.
  return title.slice(0, Math.max(1, budget - 1)) + '…';
}

/**
 * Post to Bluesky. A single record carries an `app.bsky.embed.external` link
 * card so the in-app preview is rich. (Historically this could chain a long
 * excerpt across reply posts; that was removed — cross-posts are one post.)
 *
 * @param {any} agent — a pre-authenticated BskyAgent (caller's responsibility)
 * @param {{ title: string, excerpt: string, url: string, coverImageUrl?: string | null }} input
 * @returns {Promise<{ rootUri: string, rootCid: string, partial: boolean }>}
 */
export async function postThread(agent, input) {
  if (!agent) throw new Error('postThread: agent required');
  const posts = composeThread(input);
  if (posts.length === 0) throw new Error('postThread: nothing to post');

  const embed = await buildLinkCard(agent, {
    url: input.url,
    title: input.title,
    description: input.excerpt,
    coverImageUrl: input.coverImageUrl || null,
  });

  // Root post.
  const rootRecord = {
    $type: 'app.bsky.feed.post',
    text: posts[0].text,
    createdAt: new Date().toISOString(),
  };
  if (embed) rootRecord.embed = embed;
  const rootRes = await agent.post(rootRecord);
  const rootUri = rootRes?.uri;
  const rootCid = rootRes?.cid;
  if (!rootUri || !rootCid) {
    throw new Error('postThread: agent.post returned no uri/cid for root');
  }

  // Chain continuation posts (reply.root + reply.parent both point at root).
  // The root is already posted and is IRREVERSIBLE, so a continuation
  // failure must NOT throw — if it did, the caller wouldn't record the root
  // URI and the next publish would re-post the whole thread, duplicating the
  // root. Instead we stop, keep the root, and report the thread as partial.
  let parentUri = rootUri;
  let parentCid = rootCid;
  let partial = false;
  for (let i = 1; i < posts.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounded loop index
    const text = posts[i].text;
    const reply = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      reply: {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri, cid: parentCid },
      },
    };
    try {
      const r = await agent.post(reply);
      parentUri = r?.uri || parentUri;
      parentCid = r?.cid || parentCid;
    } catch (err) {
      console.warn(
        `[bluesky] continuation ${i}/${posts.length - 1} failed; thread is partial (root kept):`,
        err?.message || err,
      );
      partial = true;
      break;
    }
  }

  return { rootUri, rootCid, partial };
}

/**
 * Build the `app.bsky.embed.external` payload for a link card. If the
 * agent can upload a blob and we have a cover image URL, fetch + upload
 * it as the thumbnail; otherwise the card renders without an image.
 *
 * Best-effort — a failed thumb upload silently falls back to a text-only
 * card so we never let cover trouble block the cross-post.
 *
 * @param {any} agent
 * @param {{ url: string, title: string, description: string, coverImageUrl: string | null }} input
 * @returns {Promise<any | null>}
 */
async function buildLinkCard(agent, { url, title, description, coverImageUrl }) {
  if (!url) return null;
  /** @type {any} */
  const card = {
    $type: 'app.bsky.embed.external',
    external: {
      uri: url,
      title: String(title || '').slice(0, 300),
      description: String(description || '').slice(0, 1000),
    },
  };
  if (!coverImageUrl) return card;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // Route through screenedFetch (SSRF guard: scheme + private-host screening,
    // manual-redirect re-screening). The cover URL is author-supplied front-matter
    // / first-body-image, so it must not be able to reach a LAN or cloud-metadata
    // host. Hard 5s timeout so a slow/hung cover host can't stall the cross-post.
    const res = await screenedFetch(coverImageUrl, {
      init: { signal: controller.signal },
      maxRedirects: 2,
    });
    if (!res.ok) return card;
    // Stream with a HARD byte cap (Bluesky caps blobs ~1 MB) — a host that omits
    // or understates Content-Length must not be able to force an unbounded
    // in-memory download; the cap is enforced DURING the read, not after.
    const buf = await readCappedBytes(res, 1_000_000);
    if (!buf) return card;
    const mime = res.headers.get('content-type') || 'image/jpeg';
    const upload = await agent.uploadBlob(buf, { encoding: mime });
    if (upload?.data?.blob) {
      card.external.thumb = upload.data.blob;
    }
  } catch (_) {
    // Silent — text-only card still renders fine in the app.
  } finally {
    clearTimeout(timer);
  }
  return card;
}

/**
 * Read a fetch Response body into a Buffer, aborting once `maxBytes` is exceeded
 * DURING the stream (so an absent/understated Content-Length can't blow memory).
 * Returns null if over the cap or no body. Falls back to arrayBuffer when the
 * body isn't a readable stream (test fetch impls).
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer | null>}
 */
async function readCappedBytes(res, maxBytes) {
  const body = /** @type {any} */ (res).body;
  if (!body || typeof body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    return ab.byteLength > maxBytes ? null : Buffer.from(ab);
  }
  const reader = body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch (_) {
        /* ignore */
      }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Post a reply to an existing Bluesky post given its AT URI. Looks up
 * the root + parent CIDs via `getPosts` so the reply chains correctly.
 *
 * @param {any} agent
 * @param {string} atUri — the parent post we're replying to
 * @param {string} text
 * @returns {Promise<{ uri: string, cid: string }>}
 */
export async function replyToPost(agent, atUri, text) {
  if (!agent) throw new Error('replyToPost: agent required');
  if (!atUri) throw new Error('replyToPost: atUri required');
  const parsed = parseAtUri(atUri);
  if (!parsed) throw new Error(`replyToPost: invalid AT URI: ${atUri}`);
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('replyToPost: text required');

  // Look up the parent record so we can populate the reply.root.
  const got = await agent.getPosts({ uris: [atUri] });
  const parent = got?.data?.posts?.[0];
  if (!parent) throw new Error(`replyToPost: parent ${atUri} not found`);
  const parentCid = parent.cid;
  // If the parent is itself a reply, walk to the root; otherwise the
  // parent IS the root.
  const rootRef = parent.record?.reply?.root || { uri: atUri, cid: parentCid };
  const truncated =
    trimmed.length > MAX_POST_CHARS ? trimmed.slice(0, MAX_POST_CHARS - 1) + '…' : trimmed;
  const res = await agent.post({
    $type: 'app.bsky.feed.post',
    text: truncated,
    createdAt: new Date().toISOString(),
    reply: {
      root: rootRef,
      parent: { uri: atUri, cid: parentCid },
    },
  });
  return { uri: res?.uri, cid: res?.cid };
}

/**
 * Fetch a Bluesky thread by AT URI. Returned shape mirrors the
 * `app.bsky.feed.getPostThread` response. Used by the Hugo build to
 * pre-warm metadata; the official embed script handles rendering on the
 * client.
 *
 * @param {any} agent
 * @param {string} atUri
 * @returns {Promise<any>}
 */
export async function getThread(agent, atUri) {
  if (!agent) throw new Error('getThread: agent required');
  if (!atUri) throw new Error('getThread: atUri required');
  const res = await agent.getPostThread({ uri: atUri, depth: 6 });
  return res?.data?.thread || null;
}

// ── Test seam ────────────────────────────────────────────────────────

export const __test = {
  reset() {
    // Reset agentFactory to the default lazy importer.
    setAgentFactory(null);
  },
  // Re-export the private helpers so the unit tests can drive them
  // without touching the network.
  truncateForRoot,
  buildLinkCard,
  MAX_POST_CHARS,
};

export default {
  isConfigured,
  signIn,
  postThread,
  replyToPost,
  getThread,
  composeThread,
  webUrlToAtUri,
  atUriToWebUrl,
  parseAtUri,
  setAgentFactory,
};
