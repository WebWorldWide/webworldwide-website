// @ts-check
/**
 * assets.js — cache-busting for the admin's static assets.
 *
 * Admin JS/CSS aren't content-hashed, and the CDN in front of the tunnel can
 * cache them aggressively (its Browser Cache TTL overrides our origin headers),
 * so a deploy could otherwise serve stale JS for hours. Since the HTML pages
 * are served `no-cache`, rewriting their local asset references to carry a
 * per-deploy `?v=<version>` query makes every deploy a guaranteed cache miss
 * for changed assets — no manual purge needed.
 */

/**
 * Append `?v=<version>` to local /js and /css references in an HTML string.
 * Leaves external URLs (http/https/protocol-relative) and refs that already
 * carry a query/hash untouched.
 *
 * @param {string} html - HTML document text.
 * @param {string} version - Cache-busting token (e.g. a git short SHA).
 * @returns {string} HTML with versioned local asset references.
 */
export function versionizeHtml(html, version) {
  if (!html || !version) return html;
  return html.replace(
    /(\b(?:src|href)=")(\/(?:js|css)\/[^"?#]+\.(?:js|css))(")/g,
    (_match, pre, url, post) => `${pre}${url}?v=${version}${post}`,
  );
}
