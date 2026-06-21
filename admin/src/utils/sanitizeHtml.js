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

// Allowlist for paste-to-embed provider HTML. Wider than comments (it must keep
// the iframe/blockquote embeds providers return) but still strips the script
// vectors. A surviving cross-origin <iframe> is sandboxed by the same-origin
// policy so it can't script the page; <script>/on*/javascript:/data: are what
// matter, and those are dropped.
const EMBED_ALLOWED_TAGS = [
  'iframe',
  'blockquote',
  'a',
  'p',
  'br',
  'span',
  'div',
  'strong',
  'em',
  'b',
  'i',
  'img',
  'figure',
  'figcaption',
  'cite',
];
const EMBED_ALLOWED_ATTR = [
  'src',
  'href',
  'title',
  'rel',
  'target',
  'width',
  'height',
  'frameborder',
  'allowfullscreen',
  'allow',
  'loading',
  'scrolling',
  'class',
  'lang',
  'cite',
  'alt',
  'referrerpolicy',
  'sandbox',
];

/**
 * Sanitize untrusted paste-to-embed provider HTML. An oEmbed `html` field can
 * come from an ATTACKER-controlled host (the Mastodon provider dials whatever
 * instance host the pasted URL names), and it is published verbatim into the
 * post body which renders as raw HTML on the no-CSP public site. Keep the
 * iframe/blockquote embed but drop <script>, on* handlers, and non-http(s) URLs
 * (so no javascript:/data: iframe src).
 * @param {unknown} html
 * @returns {string}
 */
export function sanitizeEmbedHtml(html) {
  return String(
    purify.sanitize(String(html === null || html === undefined ? '' : html), {
      ALLOWED_TAGS: EMBED_ALLOWED_TAGS,
      ALLOWED_ATTR: EMBED_ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: /^(?:https?:)?\/\//i,
    }),
  );
}
