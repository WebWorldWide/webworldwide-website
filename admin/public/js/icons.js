// @ts-check
/**
 * icons.js — inline-SVG icon registry for the admin chrome.
 *
 * Loads BEFORE common.js on every page and augments window.TE with:
 *   TE.icon(name)      -> SVG markup string (for JS-rendered templates)
 *   TE.fillIcons(root) -> replace [data-icon="name"] placeholders with SVG
 *
 * Line icons (Lucide, ISC-licensed) at a 24x24 viewBox, stroke=currentColor,
 * so each icon inherits the surrounding text color and the WWW active/focus
 * states. Mirrors the inline-SVG approach already used on the public site
 * (site/src/components/sections/Socials.astro) — no build step, no sprite.
 *
 * NOTE: common.js bails if it sees an already-initialised TE, so it keys its
 * guard off TE.__commonInit (not mere existence). Seeding TE here first is
 * therefore safe; common.js merges its helpers into the same object.
 */
(function () {
  /** @type {any} */
  const w = window;
  /** @type {Record<string, any>} */
  const TE = w.TE || (w.TE = {});

  /**
   * @param {string} inner
   * @returns {string}
   */
  const svg = (inner) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    inner +
    '</svg>';

  /** @type {Record<string, string>} */
  const ICONS = {
    // ── Sidebar / chrome ──────────────────────────────────────
    home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
    overview: svg(
      '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    ),
    homepage: svg(
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6" cy="6.5" r="0.6"/><circle cx="8.5" cy="6.5" r="0.6"/><path d="M7 13h6M7 16h4"/>',
    ),
    analytics: svg('<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>'),
    system: svg(
      '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>',
    ),
    posts: svg('<path d="M4 6h16M4 12h16M4 18h11"/>'),
    media: svg(
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    ),
    comments: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
    activity: svg('<path d="M3 12h4l3 8 4-16 3 8h4"/>'),
    redirects: svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
    settings: svg(
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    ),
    terminal: svg('<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>'),

    // ── Topbar / actions ──────────────────────────────────────
    logout: svg(
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    ),
    passkey: svg(
      '<circle cx="9" cy="9" r="4"/><path d="M14.5 9a4 4 0 1 0 4 4"/><path d="M2 21a7 7 0 0 1 11.5-5.4"/>',
    ),
    upload: svg(
      '<path d="M4 14.9V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.1"/><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/>',
    ),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
    chevron_down: svg('<path d="m6 9 6 6 6-6"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    trash: svg(
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
    ),
    grid: svg(
      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    ),
    list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),

    // ── Media types ───────────────────────────────────────────
    file_image: svg(
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    ),
    file_video: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/>'),
    file_audio: svg(
      '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    ),
    file_doc: svg(
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>',
    ),
    file_archive: svg(
      '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    ),
    file_other: svg(
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    ),
  };

  /**
   * Return inline-SVG markup for a named icon (empty string if unknown).
   * @param {string} name
   * @returns {string}
   */
  TE.icon = function (name) {
    // eslint-disable-next-line security/detect-object-injection -- name indexes a fixed internal registry.
    return ICONS[name] || '';
  };

  /**
   * Replace every <… data-icon="name"> placeholder under `root` (default:
   * document) with its SVG. Skips nodes that already hold an element so it
   * is safe to call repeatedly after partial re-renders.
   * @param {(Document|Element)} [root]
   */
  TE.fillIcons = function (root) {
    const scope = root && /** @type {any} */ (root).querySelectorAll ? root : document;
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      const name = el.getAttribute('data-icon');
      // eslint-disable-next-line security/detect-object-injection -- name indexes a fixed internal registry.
      if (name && ICONS[name] && !el.firstElementChild) el.innerHTML = ICONS[name];
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TE.fillIcons(document));
  } else {
    TE.fillIcons(document);
  }
})();
