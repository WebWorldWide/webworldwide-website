// @ts-check
/**
 * mastodon.js — direct Mastodon cross-post service.
 *
 * Posts a published blog post straight to a Mastodon account you own
 * (e.g. one on mastodon.social) via the REST API. This is the DIRECT path —
 * distinct from the Bridgy Fed bridge, which federates the static site itself.
 * Use one or the other (or both, accepting two presences).
 *
 * Mastodon API used:
 *   POST <instance>/api/v1/statuses                  — publish a status
 *   GET  <instance>/api/v1/accounts/verify_credentials — test the token
 *
 * Configuration — admin Settings → Syndication (encrypted in app_secrets),
 * or env fallback:
 *   MASTODON_INSTANCE      — base URL, e.g. https://mastodon.social
 *   MASTODON_ACCESS_TOKEN  — token with `write:statuses` scope, created at
 *                            <instance>/settings/applications (Development).
 *
 * Test seam: setFetchImpl(fn) swaps fetch so CI never hits the network.
 */

import { getSecret } from './app-secrets.js';

// Mastodon's default status limit is 500 chars; leave headroom for the
// trailing link + the two newlines so a long excerpt never trips a reject.
const MAX_STATUS_CHARS = 500;
const LINK_RESERVE = 30;

/** @type {typeof globalThis.fetch} */
let fetchImpl = (input, init) => globalThis.fetch(input, init);

/**
 * Swap the fetch used by every call below. Pass `null` to reset.
 * @param {typeof globalThis.fetch | null | undefined} fn
 */
export function setFetchImpl(fn) {
  fetchImpl = fn || ((input, init) => globalThis.fetch(input, init));
}

/**
 * Resolve Mastodon config. UI-entered values (encrypted in app_secrets via the
 * Settings → Syndication panel) take precedence; the MASTODON_* env vars are
 * the fallback. The instance is normalised to a bare https origin.
 *
 * @returns {{ instance: string, accessToken: string }}
 */
export function getMastodonConfig() {
  let raw = (getSecret('mastodon_instance') || process.env.MASTODON_INSTANCE || '').trim();
  raw = raw.replace(/\/+$/, '');
  // Tolerate a pasted fediverse handle in the instance field (@user@host or
  // user@host) — extract just the server host so it still resolves. (Common
  // slip: typing "@you@mastodon.social" into Instance URL instead of the URL.)
  const handle = raw.match(/^@?[^@/\s]+@([^@/\s]+)$/);
  if (handle) raw = handle[1];
  // Reduce to a bare host (drop any protocol + path) then re-add https://.
  raw = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return {
    instance: raw ? 'https://' + raw : '',
    accessToken: getSecret('mastodon_access_token') || process.env.MASTODON_ACCESS_TOKEN || '',
  };
}

/**
 * Are both the instance and a token set?
 * @returns {boolean}
 */
export function isConfigured() {
  const { instance, accessToken } = getMastodonConfig();
  return Boolean(instance && accessToken);
}

/**
 * Verify the token against /accounts/verify_credentials. Resolves with the
 * account handle/url on success; throws (never echoes the token) on failure.
 *
 * @returns {Promise<{ acct: string, url: string, displayName: string }>}
 */
export async function verifyCredentials() {
  const { instance, accessToken } = getMastodonConfig();
  if (!instance || !accessToken) throw new Error('not_configured');
  const res = await fetchImpl(`${instance}/api/v1/accounts/verify_credentials`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`verify_failed ${res.status}: ${body.slice(0, 140)}`);
  }
  const acct = await res.json();
  return {
    acct: acct.acct || acct.username || '',
    url: acct.url || '',
    displayName: acct.display_name || '',
  };
}

/**
 * Word-boundary truncation with an ellipsis.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncate(s, max) {
  s = String(s || '');
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, Math.max(0, max));
  const cut = s.lastIndexOf(' ', max - 1);
  return (cut > max * 0.5 ? s.slice(0, cut) : s.slice(0, max - 1)).trim() + '…';
}

/**
 * Compose a single status from a post: title, a blank line, the excerpt,
 * then the canonical URL. Trimmed to fit Mastodon's character budget.
 *
 * @param {{ title: string, excerpt?: string, url: string }} input
 * @returns {string}
 */
export function composeStatus({ title, excerpt, url }) {
  const t = String(title || '').trim();
  const x = String(excerpt || '').trim();
  const budget = MAX_STATUS_CHARS - LINK_RESERVE - (url ? String(url).length : 0);
  let body = t;
  if (x) {
    const full = `${t}\n\n${x}`;
    body =
      full.length <= budget ? full : `${t}\n\n${truncate(x, Math.max(1, budget - t.length - 2))}`;
  }
  if (body.length > budget) body = truncate(body, budget);
  return url ? `${body}\n\n${url}` : body;
}

/**
 * Post a status. Returns the new status's id + permalink. Throws on failure.
 *
 * @param {{ title: string, excerpt?: string, url: string, idempotencyKey?: string }} input
 * @returns {Promise<{ id: string, url: string, uri: string }>}
 */
export async function postStatus(input) {
  const { instance, accessToken } = getMastodonConfig();
  if (!instance || !accessToken) throw new Error('not_configured');
  const status = composeStatus(input);
  /** @type {Record<string,string>} */
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  // Idempotency-Key dedups a retried POST server-side (Mastodon honours it),
  // so a publish retried after a network blip can't double-post.
  if (input.idempotencyKey) headers['Idempotency-Key'] = String(input.idempotencyKey);
  const res = await fetchImpl(`${instance}/api/v1/statuses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status, visibility: 'public' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`post_failed ${res.status}: ${body.slice(0, 140)}`);
  }
  const out = await res.json();
  return {
    id: String(out.id || ''),
    url: out.url || out.uri || '',
    uri: out.uri || out.url || '',
  };
}

export const __test = { setFetchImpl, composeStatus, truncate };

export default {
  getMastodonConfig,
  isConfigured,
  verifyCredentials,
  composeStatus,
  postStatus,
  setFetchImpl,
};
