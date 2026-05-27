// @ts-check
/**
 * codeHighlighter.js — tiny memoized wrapper around Shiki's
 * `createHighlighter`.
 *
 * Shiki bootstraps a WASM oniguruma engine + grammar loader on first
 * call (~150 ms cold, ~50 KB heap retained per loaded grammar). We
 * lazy-load on demand and reuse the same highlighter across handler
 * invocations so a code-heavy workspace (50 source files) doesn't pay
 * the boot cost 50×.
 *
 * The cache key is `theme` — themes are global to a highlighter
 * instance — but the grammar list grows incrementally via
 * `loadLanguage()` so we only pay for the languages we actually see.
 */

import { createHighlighter } from 'shiki';

/** @type {Record<string, Promise<import('shiki').Highlighter>>} */
const cache = {};
/** @type {Record<string, Set<string>>} */
const loadedLangs = {};

/**
 * Fetch (or create) a memoized Shiki highlighter for the given theme,
 * with `lang` loaded into its grammar registry.
 *
 * @param {string} lang
 * @param {string} theme
 * @returns {Promise<import('shiki').Highlighter>}
 */
export async function getHighlighter(lang, theme) {
  if (!Object.prototype.hasOwnProperty.call(cache, theme)) {
    cache[/** @type {string} */ (theme)] = createHighlighter({
      themes: [theme],
      langs: [lang],
    });
    loadedLangs[/** @type {string} */ (theme)] = new Set([lang]);
  }
  const highlighter = await cache[/** @type {string} */ (theme)];
  const seen = loadedLangs[/** @type {string} */ (theme)];
  if (!seen.has(lang)) {
    try {
      await highlighter.loadLanguage(/** @type {any} */ (lang));
      seen.add(lang);
    } catch {
      // Unknown language: caller falls back to plain wrapper. We
      // deliberately do NOT cache the failure — a typo'd lang id
      // shouldn't poison subsequent lookups.
    }
  }
  return highlighter;
}

export const __internal = { cache, loadedLangs };
