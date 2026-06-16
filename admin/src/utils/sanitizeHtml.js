// @ts-check
/**
 * sanitizeHtml.js — server-side HTML sanitizer for untrusted comment bodies.
 *
 * Remark42 renders comment markdown to HTML and is expected to sanitize it,
 * but the admin moderation UI injects that HTML into the privileged admin
 * origin (the drawer renders it, not just escaped text). Sanitizing here —
 * before the row is returned to the client — makes that a defence in depth
 * rather than a trust assumption: even malformed/unsanitized upstream HTML
 * can't carry script, event handlers, iframes or javascript: URLs into the
 * admin page.
 *
 * Uses the same DOMPurify + jsdom pair already vendored for SVG cleaning in
 * services/conversion/image.js.
 */
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const purifyWindow = new JSDOM('').window;
const purify = createDOMPurify(/** @type {any} */ (purifyWindow));

/** Conservative allowlist — inline formatting, links, lists, code/quote. */
const ALLOWED_TAGS = [
  'a',
  'b',
  'i',
  'em',
  'strong',
  'code',
  'pre',
  'blockquote',
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'span',
  'del',
  's',
];
const ALLOWED_ATTR = ['href', 'title', 'rel', 'target'];

/**
 * Sanitize untrusted comment HTML to the allowlist above. `on*` handlers,
 * `<script>/<style>/<iframe>`, and javascript: URLs are dropped by DOMPurify.
 * @param {unknown} html
 * @returns {string}
 */
export function sanitizeCommentHtml(html) {
  return String(
    purify.sanitize(String(html === null || html === undefined ? '' : html), {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
    }),
  );
}
