// @ts-check
/**
 * homepage.js — the Homepage editor view (client side).
 *
 * Renders into #homepage-root: a 392px rail of editable section cards
 * (Hero, Apps, Videos, Socials, Blog CTA) next to a live WYSIWYG
 * preview of the public homepage. The model comes from
 * GET /api/settings/homepage (see admin/src/routes/settings.js);
 * Save PATCHes the full edited model back; Publish PATCHes (if dirty)
 * and then POSTs /api/publish to commit + push site/.
 *
 * State model: `saved` is the last server-acknowledged snapshot,
 * `draft` is the working copy. Text edits re-render ONLY the preview
 * (so inputs keep focus); structural changes (add/remove/reorder/
 * toggle) rebuild the rail too.
 */
(function () {
  /** The five homepage sections — labels + rail subtitles. */
  const SECTION_LABELS = {
    hero: 'Hero',
    apps: 'Apps',
    videos: 'Videos',
    socials: 'Socials',
    blog_cta: 'Blog CTA',
  };

  const STATUS_LABEL = { live: '★ live', soon: 'coming soon', lab: 'in the lab' };

  /**
   * The site renders fixed eyebrow numbers per section (Apps.astro etc.)
   * regardless of section_order — mirror them verbatim for fidelity.
   */
  const EYEBROW = { apps: '01 — Apps', videos: '02 — Videos', socials: '03 — Socials' };

  /**
   * Official brand glyph (Simple Icons, white fill) — matches Socials.astro.
   * @param {string} d  brand glyph path data
   */
  const socialGlyph = (d) =>
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';

  /**
   * Display name, brand fill, handle + brand glyph for the known social
   * keys. Name/brand/handle/glyph mirror site/src/components/sections/
   * Socials.astro so the preview reads exactly like the live tiles
   * (note: the `twitter` key renders as "X"). `email` has no live tile,
   * so it falls back to a monogram in the preview.
   */
  const SOCIAL_META = {
    youtube: {
      name: 'YouTube',
      brand: '#ff0033',
      handle: '@web_world_wide',
      glyph: socialGlyph(
        'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
      ),
    },
    github: {
      name: 'GitHub',
      brand: '#1a1a1a',
      handle: 'github.com/WebWorldWide',
      glyph: socialGlyph(
        'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
      ),
    },
    twitter: {
      name: 'X',
      brand: '#000000',
      handle: '@mywebworldwide',
      glyph: socialGlyph(
        'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
      ),
    },
    bluesky: {
      name: 'Bluesky',
      brand: '#0085ff',
      handle: '@web-world-wide.bsky.social',
      glyph: socialGlyph(
        'M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026',
      ),
    },
    mastodon: {
      name: 'Mastodon',
      brand: '#6364ff',
      handle: '@webworldwide@mastodon.social',
      glyph: socialGlyph(
        'M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z',
      ),
    },
    reddit: {
      name: 'Reddit',
      brand: '#ff4500',
      handle: 'u/web_world_wide',
      glyph: socialGlyph(
        'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z',
      ),
    },
    instagram: {
      name: 'Instagram',
      brand: 'linear-gradient(135deg,#feda75,#fa7e1e 35%,#d62976 65%,#962fbf 85%,#4f5bd5)',
      handle: '@mywebworldwide',
      glyph: socialGlyph(
        'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
      ),
    },
    threads: {
      name: 'Threads',
      brand: '#000000',
      handle: '@mywebworldwide',
      glyph: socialGlyph(
        'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z',
      ),
    },
    email: { name: 'Email', brand: '#0e2960', handle: 'hello@webworldwide.online', glyph: '' },
  };

  const MAX_WORDS = 5;
  const MAX_APPS = 8;
  const SITE_URL = 'https://webworldwide.online';

  /**
   * Colourful placeholder gradients for icon-less / broken-icon app tiles,
   * cycled per tile — mirrors the FALLBACKS in site Apps.astro so a tile
   * with no (or a missing) icon reads intentional, never blank or a
   * broken-image glyph.
   */
  const APP_PH_GRADS = [
    'linear-gradient(135deg,#ffd58b,#ff8a3d)',
    'linear-gradient(135deg,#a0e8c8,#3ec25d)',
  ];

  /** The 8 social tiles the live site renders (Socials.astro), default order. */
  const SITE_SOCIAL_KEYS = [
    'youtube',
    'github',
    'twitter',
    'bluesky',
    'mastodon',
    'reddit',
    'instagram',
    'threads',
  ];

  /** YouTube @handle for the Videos preview — filled from site config on init. */
  let siteYoutubeHandle = SOCIAL_META.youtube.handle;

  // ── Inline icons (stroke = currentColor, same Lucide style as icons.js) ──
  /** @param {string} inner */
  const svg = (inner) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    inner +
    '</svg>';
  const IC = {
    drag: svg(
      '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    ),
    chevUp: svg('<path d="m18 15-6-6-6 6"/>'),
    chevDown: svg('<path d="m6 9 6 6 6-6"/>'),
    eye: svg(
      '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    ),
    eyeOff: svg(
      '<path d="m3 3 18 18"/><path d="M10.6 5.1C11 5 11.5 5 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.9 3.6"/><path d="M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.9-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    ),
    trash: svg(
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
    ),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>'),
    check: svg('<path d="m4 12 5 5L20 6"/>'),
    rocket: svg(
      '<path d="M5 13c-1.5-1.5-1-5 1-7s5.5-2.5 7-1c0 0 6-2 8-1s-1 8-1 8c1.5 1.5 1 5.5-1 7.5s-5.5 2.5-7 1"/><path d="m9 15 6-6"/><path d="M5 19c-1 1-1.5 3-1.5 3s2-.5 3-1.5"/>',
    ),
    globe: svg(
      '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9h17M3.5 15h17"/>',
    ),
    image: svg(
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    ),
    history: svg(
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    ),
  };

  /**
   * Working copy being edited in the rail.
   * @type {any}
   */
  let draft = null;
  /**
   * Last server-acknowledged model (deep snapshot).
   * @type {any}
   */
  let saved = null;
  /** Section id whose card is highlighted + matched in the preview. */
  let selected = 'hero';
  /**
   * Section id whose card body is expanded (one at a time).
   * @type {string | null}
   */
  let open = 'hero';
  /** @type {'desktop' | 'phone'} */
  let device = 'desktop';
  /** @type {'draft' | 'live'} — the unsaved-draft replica vs an iframe of the published site. */
  let viewMode = 'draft';
  /** True after a successful Save until the next Publish. */
  let savedNotLive = false;
  let wired = false;
  /** True for ~1.2s after first load so the preview blocks animate in once. */
  let introActive = false;

  function root() {
    return document.getElementById('homepage-root');
  }

  /** @param {any} m */
  const clone = (m) => JSON.parse(JSON.stringify(m));

  function isDirty() {
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }

  const esc = (/** @type {unknown} */ s) => TE.escape(s);

  /**
   * Set a dot-path (e.g. 'apps.items.0.name') on the draft.
   * @param {string} path
   * @param {string} value
   */
  function setPath(path, value) {
    const parts = path.split('.');
    let t = draft;
    for (let i = 0; i < parts.length - 1; i++) {
      // eslint-disable-next-line security/detect-object-injection -- path comes from our own data-path attributes
      t = t[parts[i]];
      if (t === null || typeof t !== 'object') return;
    }
    t[parts[parts.length - 1]] = value;
  }

  /**
   * Swap arr[i] and arr[i+d] in place (no-op when out of range).
   * @param {any[]} arr
   * @param {number} i
   * @param {number} d
   * @returns {boolean} whether a swap happened
   */
  function swap(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return false;
    // eslint-disable-next-line security/detect-object-injection -- bounds-checked indices
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return true;
  }

  /**
   * Placeholder node for an app tile with no icon (or a broken one): a
   * colourful gradient chip with the app's first initial. Presentation
   * only — never written back into the model.
   * @param {string} letter
   * @param {string} grad
   * @returns {HTMLElement}
   */
  function buildAppPh(letter, grad) {
    const span = document.createElement('span');
    span.className = 'ph';
    if (grad) span.style.setProperty('--ph-bg', grad);
    span.textContent = letter || '№';
    return span;
  }

  /**
   * Small gradient chip for the rail icon thumbnail when its icon is
   * empty or fails to load.
   * @param {string} letter
   * @param {string} grad
   * @returns {HTMLElement}
   */
  function buildIconChip(letter, grad) {
    const span = document.createElement('span');
    span.className = 'hp-icon-chip';
    if (grad) span.style.setProperty('--ph-bg', grad);
    span.textContent = letter || '№';
    return span;
  }

  /**
   * First initial of an app name (uppercased) for placeholders.
   * @param name
   */
  const initialOf = (/** @type {string} */ name) => (name || '№').trim().charAt(0).toUpperCase();

  /**
   * The social keys to render: the model's order plus any site tiles it
   * omits. The live site appends the rest at the end (Socials.astro) — mirror
   * that so the preview, the rail and the count reflect every tile.
   * @returns {string[]}
   */
  function socialOrder() {
    const order = Array.isArray(draft.socials.order) ? draft.socials.order : [];
    return order.concat(SITE_SOCIAL_KEYS.filter((k) => !order.includes(k)));
  }

  /**
   * A usable link/path: http(s):// or site-relative `/…`.
   * @param v
   */
  const isLinkish = (/** @type {string} */ v) =>
    /^https?:\/\//.test(v) || String(v).startsWith('/');

  /**
   * Toggle aria-invalid on a field after an edit, giving inline feedback
   * instead of only failing at Save.
   * @param {HTMLInputElement | HTMLSelectElement} input
   * @param {string} path
   */
  function validateField(input, path) {
    let bad = false;
    if (/^hero\.words\.\d+$/.test(path)) bad = !input.value.trim();
    else if (/^apps\.items\.\d+\.name$/.test(path)) bad = !input.value.trim();
    else if (/\.(link|icon)$/.test(path) || path === 'blog_cta.url')
      bad = Boolean(input.value.trim()) && !isLinkish(input.value.trim());
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }

  // ── Rail: section field editors ────────────────────────────
  function heroFields() {
    const words = draft.hero.words;
    return `
      <div class="hp-field-row">
        ${words
          .map(
            (/** @type {string} */ w, /** @type {number} */ i) => `
          <div class="hp-field">
            <label for="hp-word-${i}">Word ${i + 1}</label>
            <div class="hp-word">
              <input id="hp-word-${i}" type="text" maxlength="24" value="${esc(w)}" data-path="hero.words.${i}" />
              <button type="button" class="hp-mini-ic" data-act="word-del" data-i="${i}" title="Remove word" aria-label="Remove word ${i + 1}" ${words.length <= 1 ? 'disabled' : ''}>${IC.trash}</button>
            </div>
          </div>`,
          )
          .join('')}
      </div>
      <button type="button" class="hp-add" data-act="word-add" ${words.length >= MAX_WORDS ? 'disabled' : ''}>${IC.plus} Add word</button>
      <div class="hp-field" style="margin-top:8px">
        <label for="hp-hero-tagline">Tagline</label>
        <input id="hp-hero-tagline" type="text" maxlength="80" value="${esc(draft.hero.tagline)}" data-path="hero.tagline" />
      </div>
      <div class="hp-field" style="margin-top:8px">
        <label for="hp-hero-subtitle">Subtitle</label>
        <input id="hp-hero-subtitle" type="text" maxlength="120" value="${esc(draft.hero.subtitle || '')}" data-path="hero.subtitle" placeholder="Optional supporting line" />
      </div>`;
  }

  function appsFields() {
    const items = draft.apps.items;
    return `
      ${items
        .map(
          (/** @type {any} */ a, /** @type {number} */ i) => `
        <div class="hp-item">
          <div class="hp-item-head">
            <span class="hi-name">${esc(a.name) || 'Untitled'}</span>
            <span class="hi-tools">
              <button type="button" class="hp-mini-ic" data-act="app-up" data-i="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${IC.chevUp}</button>
              <button type="button" class="hp-mini-ic" data-act="app-down" data-i="${i}" title="Move down" ${i === items.length - 1 ? 'disabled' : ''}>${IC.chevDown}</button>
              <button type="button" class="hp-mini-ic" data-act="app-del" data-i="${i}" title="Remove app">${IC.trash}</button>
            </span>
          </div>
          <div class="hp-field">
            <label for="hp-app-name-${i}">Name</label>
            <input id="hp-app-name-${i}" type="text" maxlength="40" value="${esc(a.name)}" data-path="apps.items.${i}.name" />
          </div>
          <div class="hp-field-row">
            <div class="hp-field">
              <label for="hp-app-status-${i}">Status</label>
              <select id="hp-app-status-${i}" data-path="apps.items.${i}.status">
                ${['live', 'soon', 'lab']
                  .map(
                    (s) =>
                      // eslint-disable-next-line security/detect-object-injection -- s from a constant list
                      `<option value="${s}" ${a.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="hp-field">
              <label for="hp-app-link-${i}">Link</label>
              <input id="hp-app-link-${i}" type="text" placeholder="https://…" value="${esc(a.link)}" data-path="apps.items.${i}.link" />
            </div>
          </div>
          <div class="hp-field hp-icon-field">
            <label for="hp-app-icon-${i}">Icon</label>
            <div class="hp-icon-pick">
              <span class="hp-icon-thumb">${
                a.icon
                  ? `<img class="hp-icon-img" src="${esc(a.icon)}" alt="" data-letter="${esc(initialOf(a.name))}" data-grad="${esc(APP_PH_GRADS[i % APP_PH_GRADS.length])}" />`
                  : `<span class="hp-icon-chip" style="--ph-bg:${esc(APP_PH_GRADS[i % APP_PH_GRADS.length])}">${esc(initialOf(a.name))}</span>`
              }</span>
              <input id="hp-app-icon-${i}" type="text" placeholder="/images/icon.png" value="${esc(a.icon)}" data-path="apps.items.${i}.icon" />
              <button type="button" class="btn sm" data-act="app-icon-pick" data-i="${i}">Choose…</button>
            </div>
          </div>
        </div>`,
        )
        .join('')}
      <button type="button" class="hp-add" data-act="app-add" ${items.length >= MAX_APPS ? 'disabled' : ''}>${IC.plus} Add app</button>`;
  }

  function videosFields() {
    return `
      <div class="hp-field-row">
        <div class="hp-field">
          <label for="hp-videos-episode">Episode</label>
          <input id="hp-videos-episode" type="text" maxlength="80" value="${esc(draft.videos.episode)}" data-path="videos.episode" />
        </div>
        <div class="hp-field">
          <label for="hp-videos-title">Film title</label>
          <input id="hp-videos-title" type="text" maxlength="80" value="${esc(draft.videos.film_title)}" data-path="videos.film_title" />
        </div>
      </div>`;
  }

  function socialsFields() {
    const order = socialOrder();
    const hidden = draft.socials.hidden;
    return order
      .map((/** @type {string} */ key, /** @type {number} */ i) => {
        const meta = Object.prototype.hasOwnProperty.call(SOCIAL_META, key)
          ? // eslint-disable-next-line security/detect-object-injection -- key checked via hasOwnProperty
            SOCIAL_META[key]
          : { name: key, brand: '' };
        const shown = !hidden.includes(key);
        return `
        <div class="hp-item${shown ? '' : ' off'}">
          <div class="hp-item-head">
            <span class="pv-social-ico"${meta.brand ? ` style="--brand:${esc(meta.brand)}"` : ''} aria-hidden="true">${meta.glyph || esc(meta.name.charAt(0))}</span>
            <span class="hi-name">${esc(meta.name)}</span>
            <span class="hi-tools">
              <button type="button" class="hp-mini-ic${shown ? '' : ' off'}" data-act="soc-toggle" data-key="${esc(key)}" title="${shown ? 'Hide' : 'Show'}" aria-pressed="${shown}">${shown ? IC.eye : IC.eyeOff}</button>
              <button type="button" class="hp-mini-ic" data-act="soc-up" data-i="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>${IC.chevUp}</button>
              <button type="button" class="hp-mini-ic" data-act="soc-down" data-i="${i}" title="Move down" ${i === order.length - 1 ? 'disabled' : ''}>${IC.chevDown}</button>
            </span>
          </div>
        </div>`;
      })
      .join('');
  }

  function blogCtaFields() {
    return `
      <div class="hp-field">
        <label for="hp-cta-kicker">Kicker</label>
        <input id="hp-cta-kicker" type="text" maxlength="80" value="${esc(draft.blog_cta.kicker)}" data-path="blog_cta.kicker" />
      </div>
      <div class="hp-field-row">
        <div class="hp-field">
          <label for="hp-cta-title">Title</label>
          <input id="hp-cta-title" type="text" maxlength="80" value="${esc(draft.blog_cta.title)}" data-path="blog_cta.title" />
        </div>
        <div class="hp-field">
          <label for="hp-cta-accent">Title (accent)</label>
          <input id="hp-cta-accent" type="text" maxlength="80" value="${esc(draft.blog_cta.title_accent)}" data-path="blog_cta.title_accent" />
        </div>
      </div>
      <div class="hp-field">
        <label for="hp-cta-url">Link target</label>
        <input id="hp-cta-url" type="text" maxlength="80" value="${esc(draft.blog_cta.url)}" data-path="blog_cta.url" />
      </div>
      <div class="hp-field">
        <label for="hp-cta-desc">Description</label>
        <input id="hp-cta-desc" type="text" maxlength="160" value="${esc(draft.blog_cta.description || '')}" data-path="blog_cta.description" placeholder="Optional supporting line" />
      </div>`;
  }

  /** @param {string} id */
  function sectionFields(id) {
    switch (id) {
      case 'hero':
        return heroFields();
      case 'apps':
        return appsFields();
      case 'videos':
        return videosFields();
      case 'socials':
        return socialsFields();
      case 'blog_cta':
        return blogCtaFields();
      default:
        return '';
    }
  }

  /** @param {string} id */
  function sectionSubtitle(id) {
    switch (id) {
      case 'hero':
        return 'wordmark + tagline';
      case 'apps':
        return `${draft.apps.items.length} apps`;
      case 'videos':
        return 'channel block';
      case 'socials': {
        const all = socialOrder();
        const shownCount = all.filter(
          (/** @type {string} */ k) => !draft.socials.hidden.includes(k),
        ).length;
        return `${shownCount} of ${all.length} shown`;
      }
      case 'blog_cta':
        return 'blog handoff';
      default:
        return '';
    }
  }

  function renderRail() {
    const scroll = document.getElementById('hp-rail-scroll');
    if (!scroll || !draft) return;
    const build = () => {
      scroll.innerHTML = draft.section_order
        .map((/** @type {string} */ id, /** @type {number} */ i) => {
          // eslint-disable-next-line security/detect-object-injection -- id validated against SECTION_LABELS
          const label = SECTION_LABELS[id] || id;
          // eslint-disable-next-line security/detect-object-injection -- id validated against SECTION_LABELS
          const on = draft.sections[id] !== false;
          const isOpen = open === id;
          const bodyId = `hp-secbody-${esc(id)}`;
          // The card header is a real <button> (the disclosure) so it's
          // keyboard-operable + announces aria-expanded; the move/hide tools
          // sit beside it (not nested inside an interactive element).
          return `
        <div class="hp-sec${selected === id ? ' sel' : ''}${isOpen ? ' open' : ''}${on ? '' : ' off'}" data-id="${esc(id)}">
          <div class="hp-sec-head">
            <button type="button" class="hp-sec-disclosure" data-act="sec-head" data-id="${esc(id)}" aria-expanded="${isOpen}" aria-controls="${bodyId}">
              <span class="hp-sec-name">${esc(label)}<span class="tiny">${esc(sectionSubtitle(id))}</span></span>
              <span class="hp-sec-chev" aria-hidden="true">${IC.chevDown}</span>
            </button>
            <span class="hp-sec-tools">
              <button type="button" class="hp-mini-ic" data-act="sec-up" data-i="${i}" title="Move up" aria-label="Move ${esc(label)} up" ${i === 0 ? 'disabled' : ''}>${IC.chevUp}</button>
              <button type="button" class="hp-mini-ic" data-act="sec-down" data-i="${i}" title="Move down" aria-label="Move ${esc(label)} down" ${i === draft.section_order.length - 1 ? 'disabled' : ''}>${IC.chevDown}</button>
              <button type="button" class="hp-mini-ic${on ? '' : ' off'}" data-act="sec-toggle" data-id="${esc(id)}" title="${on ? 'Hide section' : 'Show section'}" aria-label="${on ? 'Hide' : 'Show'} ${esc(label)} section" aria-pressed="${on}">${on ? IC.eye : IC.eyeOff}</button>
            </span>
          </div>
          ${isOpen ? `<div class="hp-sec-body" id="${bodyId}">${sectionFields(id)}</div>` : ''}
        </div>`;
        })
        .join('');
      if (window.TE && TE.wireImgFallbacks) {
        TE.wireImgFallbacks(scroll, '.hp-icon-img', (img) =>
          buildIconChip(img.getAttribute('data-letter') || '', img.getAttribute('data-grad') || ''),
        );
      }
    };
    // Reorder/toggle/add/delete rebuild this list — keep keyboard focus.
    if (window.TE && TE.preserveFocus) TE.preserveFocus(scroll, build);
    else build();
  }

  // ── Preview blocks ──────────────────────────────────────────
  function pvHero() {
    const words = draft.hero.words;
    const globeAfter = Math.floor((words.length - 1) / 2);
    return `
      <div class="pv-hero">
        <div class="pv-words">
          ${words
            .map(
              (/** @type {string} */ w, /** @type {number} */ i) =>
                `<span class="pv-word">${esc(w)}</span>` +
                (i === globeAfter ? `<span class="pv-globe">${IC.globe}</span>` : ''),
            )
            .join('')}
        </div>
        <div class="pv-tagline">${esc(draft.hero.tagline)}</div>
        ${draft.hero.subtitle ? `<div class="pv-subtitle">${esc(draft.hero.subtitle)}</div>` : ''}
      </div>`;
  }

  function pvApps() {
    const items = draft.apps.items || [];
    if (!items.length) {
      return `
      <div class="pv-sec">
        <div class="pv-eyebrow">${EYEBROW.apps}</div>
        <div class="pv-empty">No apps yet — add one with the editor panel on the left.</div>
      </div>`;
    }
    return `
      <div class="pv-sec">
        <div class="pv-eyebrow">${EYEBROW.apps}</div>
        <div class="pv-apps">
          ${items
            .map((/** @type {any} */ a, /** @type {number} */ i) => {
              const status = ['live', 'soon', 'lab'].includes(a.status) ? a.status : 'soon';
              const grad = APP_PH_GRADS[i % APP_PH_GRADS.length];
              const letter = initialOf(a.name);
              // Real icons load off /assets|/images (admin serves both); a
              // missing one is swapped for the gradient chip after render
              // (TE.imgFallback) so the tile never shows a broken glyph.
              const inner = a.icon
                ? `<img class="pv-app-img" src="${esc(a.icon)}" alt="" data-letter="${esc(letter)}" data-grad="${esc(grad)}" />`
                : `<span class="ph" style="--ph-bg:${esc(grad)}">${esc(letter)}</span>`;
              return `
              <div class="pv-app">
                <div class="pv-app-stage" style="--i:${i}">
                  <span class="pv-app-halo" aria-hidden="true"></span>
                  <div class="pv-app-ico">${inner}</div>
                  <span class="pv-app-shadow" aria-hidden="true"></span>
                </div>
                <div class="pv-app-cap">${esc(a.name)}<span class="pv-app-status ${status}">${
                  // eslint-disable-next-line security/detect-object-injection -- status normalized above
                  STATUS_LABEL[status]
                }</span></div>
              </div>`;
            })
            .join('')}
        </div>
      </div>`;
  }

  function pvVideos() {
    const handle = esc(siteYoutubeHandle);
    return `
      <div class="pv-sec">
        <div class="pv-eyebrow">${EYEBROW.videos}</div>
        <div class="pv-film">
          <div class="pv-film-bg" aria-hidden="true"></div>
          <div class="pv-film-clouds" aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="pv-film-handle"><span class="rec"></span>${handle}</div>
          <div class="pv-film-meta"><span>${esc(draft.videos.episode)}</span><span>00:00</span></div>
          <div class="pv-play"><span class="tri"></span></div>
          <div class="pv-film-title">${esc(draft.videos.film_title)}</div>
        </div>
        <div class="pv-sub-row">
          <span class="pv-sub"><span class="g"></span> Subscribe</span>
          <span class="pv-yt-handle">${handle}</span>
        </div>
      </div>`;
  }

  function pvSocials() {
    const shown = socialOrder().filter(
      (/** @type {string} */ k) => !draft.socials.hidden.includes(k),
    );
    return `
      <div class="pv-sec">
        <div class="pv-eyebrow">${EYEBROW.socials}</div>
        <div class="pv-socials">
          ${shown
            .map((/** @type {string} */ key) => {
              const meta = Object.prototype.hasOwnProperty.call(SOCIAL_META, key)
                ? // eslint-disable-next-line security/detect-object-injection -- key checked via hasOwnProperty
                  SOCIAL_META[key]
                : { name: key, brand: '', handle: '', glyph: '' };
              const handle = meta.handle || '@' + meta.name.toLowerCase();
              return `
              <div class="pv-social"${meta.brand ? ` style="--brand:${esc(meta.brand)}"` : ''}>
                <div class="pv-social-ico" aria-hidden="true">${meta.glyph || esc(meta.name.charAt(0))}</div>
                <div class="pv-social-txt">
                  <div class="pv-social-name">${esc(meta.name)}</div>
                  <div class="pv-social-handle">${esc(handle)}</div>
                </div>
                <span class="pv-social-arrow" aria-hidden="true">→</span>
              </div>`;
            })
            .join('')}
        </div>
      </div>`;
  }

  function pvBlogCta() {
    return `
      <div class="pv-footer">
        <div class="pv-footer-kicker">${esc(draft.blog_cta.kicker)}</div>
        <div class="pv-footer-card">
          <div class="pv-footer-text">
            <div class="pv-footer-label">${esc(draft.blog_cta.title)}${
              draft.blog_cta.title_accent
                ? ` <span class="accent">${esc(draft.blog_cta.title_accent)}</span>`
                : ''
            }</div>
            ${
              draft.blog_cta.description
                ? `<div class="pv-footer-desc">${esc(draft.blog_cta.description)}</div>`
                : ''
            }
          </div>
          <div class="pv-footer-arrow">→</div>
        </div>
      </div>`;
  }

  function renderPreview() {
    const canvas = document.getElementById('hp-canvas');
    if (!canvas || !draft) return;
    canvas.className = `hp-canvas${device === 'phone' ? ' phone' : ''}${introActive ? ' intro' : ''}`;
    const visible = draft.section_order.filter(
      // eslint-disable-next-line security/detect-object-injection -- id from the model's own order
      (/** @type {string} */ id) => draft.sections[id] !== false,
    );
    // Drifting sky puffs behind the sections so the canvas isn't flat blue.
    const sky =
      '<div class="pv-sky" aria-hidden="true"><span></span><span></span><span></span></div>';
    canvas.innerHTML =
      sky +
      visible
        .map((/** @type {string} */ id) => {
          let inner = '';
          if (id === 'hero') inner = pvHero();
          else if (id === 'apps') inner = pvApps();
          else if (id === 'videos') inner = pvVideos();
          else if (id === 'socials') inner = pvSocials();
          else if (id === 'blog_cta') inner = pvBlogCta();
          // eslint-disable-next-line security/detect-object-injection -- id validated against SECTION_LABELS
          const label = SECTION_LABELS[id] || id;
          // role=button + tabindex so the block is a keyboard-operable
          // shortcut to its rail card (global Enter/Space handler clicks it).
          return `
        <div class="pv-block${selected === id ? ' sel' : ''}" data-pv="${esc(id)}" role="button" tabindex="0" aria-label="Edit ${esc(label)} section">
          <span class="pv-tag" aria-hidden="true">edit ${esc(label)}</span>
          ${inner}
        </div>`;
        })
        .join('');
    // Swap any broken/missing app icon for its gradient placeholder.
    if (window.TE && TE.wireImgFallbacks) {
      TE.wireImgFallbacks(canvas, '.pv-app-img', (img) =>
        buildAppPh(img.getAttribute('data-letter') || '', img.getAttribute('data-grad') || ''),
      );
    }
  }

  // ── Dirty / action-row state ────────────────────────────────
  function renderDirty() {
    const dirty = isDirty();
    const ind = document.getElementById('hp-dirty');
    if (ind) {
      ind.classList.toggle('unsaved', dirty);
      const txt = document.getElementById('hp-dirty-text');
      if (txt) txt.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
    }
    const discard = /** @type {HTMLButtonElement | null} */ (document.getElementById('hp-discard'));
    if (discard) discard.disabled = !dirty;
    const save = /** @type {HTMLButtonElement | null} */ (document.getElementById('hp-save'));
    if (save) {
      save.disabled = !dirty;
      save.classList.toggle('primary', dirty);
    }
    const hint = document.getElementById('hp-hint');
    if (hint) hint.hidden = !savedNotLive;
  }

  /** Re-render after a structural change (add/remove/reorder/toggle). */
  function renderAll() {
    renderRail();
    renderPreview();
    renderDirty();
  }

  // ── Actions ─────────────────────────────────────────────────
  /**
   * PATCH the full draft; on success both snapshots take the server's
   * normalized model.
   * @returns {Promise<boolean>} whether the save succeeded
   */
  async function saveDraft() {
    try {
      const updated = await TE.fetchJSON('/api/settings/homepage', {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      saved = clone(updated);
      draft = clone(updated);
      savedNotLive = true;
      return true;
    } catch (err) {
      // Prefer the route's human-readable `message` (the joined validation
      // problems) over fetchJSON's terse `error` code.
      const e = /** @type {Error & {data?: {message?: string}}} */ (err);
      TE.toast((e.data && e.data.message) || e.message || 'Save failed', 'error');
      return false;
    }
  }

  async function onSave() {
    if (!(await saveDraft())) return;
    renderAll();
    TE.toast('Homepage saved to the Pi — publish to make it live.');
  }

  async function onPublish() {
    if (isDirty() && !(await saveDraft())) {
      renderAll();
      return;
    }
    try {
      const res = await TE.fetchJSON('/api/publish', { method: 'POST' });
      savedNotLive = false;
      renderAll();
      // The published site just changed — drop the cached iframe so the
      // Live tab reflects it instead of the previous publish.
      refreshLiveFrame();
      TE.toast((res && res.message) || 'Published.');
    } catch (err) {
      renderAll();
      TE.toast(/** @type {Error} */ (err).message || 'Publish failed', 'error');
    }
  }

  function onDiscard() {
    draft = clone(saved);
    renderAll();
  }

  // ── Revision history ────────────────────────────────────────
  // Git-published versions of site.toml + recent local pre-save snapshots
  // (GET /api/settings/homepage/history). Selecting a row fetches that
  // version's MODEL and enables Restore, which loads it into the editor as
  // unsaved changes — the user reviews and Saves; never a silent
  // server-side overwrite. Mirrors the post editor's history panel. The
  // modal is lazily injected into <body> the first time, like image-picker.
  const HISTORY_MODAL_ID = 'hp-history-modal';
  /**
   * The currently-selected version + its fetched model, or null.
   * @type {{ source: string, ref: string, model: any } | null}
   */
  let histSelected = null;
  // Guards against out-of-order responses: rapidly clicking rows could let
  // a slow earlier fetch overwrite a newer selection's restore state.
  let histReqSeq = 0;

  /**
   * Human-friendly time: relative for snapshot epoch-ms, locale string for
   * git ISO dates (mirrors editor.js histWhen).
   * @param {number | string} v
   */
  function histWhen(v) {
    if (typeof v === 'number') {
      const secs = Math.max(1, Math.round((Date.now() - v) / 1000));
      if (secs < 60) return `${secs}s ago`;
      const mins = Math.round(secs / 60);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return new Date(v).toLocaleDateString();
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }

  /** Lazily build + inject the history modal; returns the element. */
  function ensureHistoryModal() {
    let modal = document.getElementById(HISTORY_MODAL_ID);
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = HISTORY_MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('aria-labelledby', 'hp-history-title');
    modal.innerHTML = `
      <div class="modal-card hp-history-card">
        <div class="modal-head">
          <h3 id="hp-history-title">Revision history</h3>
          <button type="button" class="btn ghost" data-modal-close="${HISTORY_MODAL_ID}" aria-label="Close">
            <span class="ico" aria-hidden="true" data-icon="close"></span>
          </button>
        </div>
        <div class="modal-body hp-history-body">
          <ul class="hp-history-list" id="hp-history-list" aria-label="Versions">
            <li class="hp-history-empty">Loading…</li>
          </ul>
        </div>
        <div class="modal-foot hp-history-foot">
          <span class="hp-history-note" id="hp-history-note">Select a version to restore it into the editor.</span>
          <button type="button" class="btn solid" id="hp-history-restore" disabled>Restore this version</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    if (typeof TE.fillIcons === 'function') TE.fillIcons(modal);
    const restoreBtn = modal.querySelector('#hp-history-restore');
    if (restoreBtn) restoreBtn.addEventListener('click', restoreSelected);
    return modal;
  }

  async function openHistory() {
    ensureHistoryModal();
    const listEl = document.getElementById('hp-history-list');
    const restoreBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('hp-history-restore')
    );
    const noteEl = document.getElementById('hp-history-note');
    histSelected = null;
    if (restoreBtn) restoreBtn.disabled = true;
    if (noteEl) noteEl.textContent = 'Select a version to restore it into the editor.';
    if (listEl)
      listEl.innerHTML =
        '<li class="hp-history-empty"><span class="te-spinner"></span> Loading…</li>';
    TE.openModal(HISTORY_MODAL_ID);
    /** @type {{ git?: any[], snapshots?: any[] }} */
    let hist;
    try {
      hist = await TE.fetchJSON('/api/settings/homepage/history');
    } catch (_err) {
      if (listEl) listEl.innerHTML = '<li class="hp-history-empty">Couldn’t load history.</li>';
      return;
    }
    /** @type {Array<{ source: string, ref: string, kind: string, label: string, when: number | string, hash: string }>} */
    const rows = [];
    for (const s of hist.snapshots || []) {
      rows.push({
        source: 'snapshot',
        ref: s.id,
        kind: 'Autosave',
        label: s.title || 'Homepage',
        when: s.ts,
        hash: '',
      });
    }
    for (const c of hist.git || []) {
      const short = String(c.hash || '').slice(0, 7);
      rows.push({
        source: 'git',
        ref: c.hash,
        kind: 'Published',
        label: c.message || short,
        when: c.date,
        hash: short,
      });
    }
    if (!rows.length) {
      if (listEl)
        listEl.innerHTML =
          '<li class="hp-history-empty">No earlier versions yet — they appear here after you save or publish.</li>';
      return;
    }
    if (!listEl) return;
    listEl.innerHTML = '';
    rows.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'hp-history-row';
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.innerHTML =
        `<span class="hp-history-kind k-${r.source}">${esc(r.kind)}</span>` +
        `<span class="hp-history-label">${esc(r.label)}</span>` +
        `<span class="hp-history-meta"><span class="hp-history-when">${esc(histWhen(r.when))}</span>` +
        (r.hash ? `<span class="hp-history-hash">${esc(r.hash)}</span>` : '') +
        `</span>`;
      const choose = () => selectVersion(r, li);
      li.addEventListener('click', choose);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose();
        }
      });
      listEl.appendChild(li);
    });
  }

  /**
   * Fetch the model for a version, mark its row active, and enable Restore.
   * @param {{ source: string, ref: string, when: number | string }} r
   * @param {Element} li
   */
  async function selectVersion(r, li) {
    const listEl = document.getElementById('hp-history-list');
    const restoreBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('hp-history-restore')
    );
    const noteEl = document.getElementById('hp-history-note');
    if (listEl)
      listEl.querySelectorAll('.hp-history-row').forEach((n) => n.classList.remove('active'));
    li.classList.add('active');
    if (restoreBtn) restoreBtn.disabled = true;
    if (noteEl) noteEl.textContent = 'Loading…';
    const seq = ++histReqSeq;
    try {
      const model = await TE.fetchJSON(
        '/api/settings/homepage/version/' +
          encodeURIComponent(r.source) +
          '/' +
          encodeURIComponent(r.ref),
      );
      if (seq !== histReqSeq) return; // a newer selection superseded this one
      histSelected = { source: r.source, ref: r.ref, model };
      if (noteEl)
        noteEl.textContent = `Ready to restore (${histWhen(r.when)}) — loads into the editor for review.`;
      if (restoreBtn) restoreBtn.disabled = false;
    } catch (_err) {
      if (seq === histReqSeq && noteEl) noteEl.textContent = 'Couldn’t load this version.';
    }
  }

  /**
   * Load the selected version into the editor as unsaved changes, then close
   * the modal. Never writes to the server — the user reviews and Saves.
   */
  function restoreSelected() {
    if (!histSelected || !histSelected.model) return;
    draft = clone(histSelected.model);
    renderAll();
    TE.closeModal(HISTORY_MODAL_ID);
    TE.toast('Version loaded into the editor. Review, then Save to apply.', 'info');
  }

  /**
   * Select a section: highlight its preview block, expand + scroll its
   * rail card into view.
   * @param {string} id
   */
  function select(id) {
    selected = id;
    open = id;
    renderRail();
    renderPreview();
    const card = document.querySelector(`.hp-sec[data-id="${CSS.escape(id)}"]`);
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── Event wiring (delegated on stable ancestors) ────────────
  /** @param {Element} el */
  function railAction(el) {
    const act = el.getAttribute('data-act');
    const i = Number(el.getAttribute('data-i'));
    switch (act) {
      case 'discard':
        onDiscard();
        return;
      case 'save':
        onSave();
        return;
      case 'publish':
        onPublish();
        return;
      case 'history':
        openHistory();
        return;
      case 'sec-head': {
        const id = el.getAttribute('data-id') || '';
        open = open === id ? null : id;
        selected = id;
        break;
      }
      case 'sec-up':
      case 'sec-down':
        if (!swap(draft.section_order, i, act === 'sec-up' ? -1 : 1)) return;
        break;
      case 'sec-toggle': {
        const id = el.getAttribute('data-id') || '';
        // eslint-disable-next-line security/detect-object-injection -- id rendered from the model's own order
        draft.sections[id] = draft.sections[id] === false;
        break;
      }
      case 'word-add':
        if (draft.hero.words.length >= MAX_WORDS) return;
        draft.hero.words.push('');
        break;
      case 'word-del':
        if (draft.hero.words.length <= 1) return;
        draft.hero.words.splice(i, 1);
        break;
      case 'app-add':
        if (draft.apps.items.length >= MAX_APPS) return;
        draft.apps.items.push({ name: 'New app', status: 'lab', link: '', icon: '' });
        break;
      case 'app-del': {
        const victim = draft.apps.items[i];
        const nm = (victim && victim.name) || 'this app';
        if (!window.confirm(`Remove “${nm}” from the Apps section?`)) return;
        draft.apps.items.splice(i, 1);
        break;
      }
      case 'app-up':
      case 'app-down':
        if (!swap(draft.apps.items, i, act === 'app-up' ? -1 : 1)) return;
        break;
      case 'app-icon-pick':
        if (window.TE && typeof window.TE.pickImage === 'function') {
          window.TE.pickImage((m) => {
            // eslint-disable-next-line security/detect-object-injection -- bounds-checked row index
            if (draft.apps.items[i]) draft.apps.items[i].icon = (m && m.url) || '';
            renderAll();
          });
        }
        return;
      case 'soc-up':
      case 'soc-down': {
        // Operate on the full (order + appended) list so reordering a tile
        // the TOML omitted persists it into order rather than no-opping.
        const ord = socialOrder();
        if (!swap(ord, i, act === 'soc-up' ? -1 : 1)) return;
        draft.socials.order = ord;
        break;
      }
      case 'soc-toggle': {
        const key = el.getAttribute('data-key') || '';
        const idx = draft.socials.hidden.indexOf(key);
        if (idx >= 0) draft.socials.hidden.splice(idx, 1);
        else draft.socials.hidden.push(key);
        break;
      }
      default:
        return;
    }
    renderAll();
  }

  function wire() {
    if (wired) return;
    wired = true;
    const el = root();
    if (!el) return;

    el.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target);

      // Rail buttons / card heads (buttons win over the head they sit in).
      const actEl = target.closest('[data-act]');
      if (actEl && el.contains(actEl)) {
        railAction(actEl);
        return;
      }

      // Preview block → select the matching rail card.
      const block = target.closest('[data-pv]');
      if (block) {
        select(block.getAttribute('data-pv') || 'hero');
        return;
      }

      // Device segmented control.
      const seg = target.closest('[data-device]');
      if (seg) {
        device = /** @type {'desktop' | 'phone'} */ (seg.getAttribute('data-device') || 'desktop');
        document.querySelectorAll('.hp-seg [data-device]').forEach((b) => {
          const on = b.getAttribute('data-device') === device;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        renderPreview();
        applyViewMode();
        return;
      }

      // Source segmented control: draft replica ⇄ live published site.
      const modeSeg = target.closest('[data-mode]');
      if (modeSeg) {
        viewMode = modeSeg.getAttribute('data-mode') === 'live' ? 'live' : 'draft';
        document.querySelectorAll('.hp-seg-mode [data-mode]').forEach((b) => {
          const on = b.getAttribute('data-mode') === viewMode;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        applyViewMode();
      }
    });

    // Text edits: update the draft + re-render only the preview so the
    // input keeps focus. 'change' covers <select>. The preview is a
    // full innerHTML rebuild — too heavy per keystroke on a Pi — so it
    // trails the typing by 180ms; the dirty indicator updates
    // immediately (a cheap class toggle).
    let previewTimer = 0;
    /** @param {Event} e */
    const onEdit = (e) => {
      const t = /** @type {HTMLInputElement | HTMLSelectElement} */ (e.target);
      const path = t && t.getAttribute && t.getAttribute('data-path');
      if (!path) return;
      setPath(path, t.value);
      validateField(t, path);
      renderDirty();
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(renderPreview, 180);
    };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);

    // Clear the Live-preview loading overlay once the iframe finishes
    // loading (fires even cross-origin).
    const liveFrame = document.getElementById('hp-live');
    if (liveFrame) liveFrame.addEventListener('load', () => setLiveLoading(false));

    window.addEventListener('beforeunload', (e) => {
      if (draft && isDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // beforeunload only fires on full page loads; the router consults
    // this guard before switching views on a hash change.
    window.TE.viewGuards = window.TE.viewGuards || {};
    window.TE.viewGuards.homepage = () =>
      draft && isDirty() ? 'You have unsaved homepage changes.' : null;
  }

  /**
   * Toggle the preview between the unsaved-draft replica and an iframe of the
   * published site, keeping the device width in sync. The iframe src is set
   * lazily on first switch to Live so it doesn't load until asked for.
   */
  /**
   * Toggle the "Loading the live site…" overlay over the iframe.
   * @param show
   */
  function setLiveLoading(show) {
    const s = document.getElementById('hp-live-status');
    if (s) s.hidden = !show;
  }

  /**
   * Reload the Live iframe (cache-busted) so it reflects the newest publish.
   * Only shows the loading overlay if the Live tab is currently visible.
   */
  function refreshLiveFrame() {
    const frame = /** @type {HTMLIFrameElement | null} */ (document.getElementById('hp-live'));
    if (frame && frame.getAttribute('src')) {
      if (viewMode === 'live') setLiveLoading(true);
      frame.setAttribute('src', `${SITE_URL}/?t=${Date.now()}`);
    }
  }

  function applyViewMode() {
    const canvas = document.getElementById('hp-canvas');
    const frame = /** @type {HTMLIFrameElement | null} */ (document.getElementById('hp-live'));
    const label = document.getElementById('hp-pb-label');
    const live = viewMode === 'live';
    if (frame) {
      frame.classList.toggle('phone', device === 'phone');
      if (live && !frame.getAttribute('src')) {
        setLiveLoading(true);
        frame.setAttribute('src', SITE_URL + '/');
      }
      frame.hidden = !live;
    }
    if (canvas) canvas.hidden = live;
    if (!live) setLiveLoading(false);
    if (label) {
      label.innerHTML = live
        ? '<span class="live" aria-hidden="true"></span>Live site · published'
        : '<span class="live" aria-hidden="true"></span>Draft preview';
    }
  }

  function renderShell() {
    const el = root();
    if (!el) return;
    el.innerHTML = `
      <div class="hp">
        <div class="hp-rail">
          <div class="hp-rail-head">
            <span class="hr-title">Homepage</span>
            <span class="hp-dirty" id="hp-dirty" role="status"><span class="d" aria-hidden="true"></span><span id="hp-dirty-text">All changes saved</span></span>
          </div>
          <div class="hp-rail-actions">
            <button type="button" class="btn hp-history-btn" id="hp-history" data-act="history" title="Revision history" aria-label="Revision history">${IC.history}</button>
            <button type="button" class="btn" id="hp-discard" data-act="discard" disabled>${IC.refresh} Discard</button>
            <button type="button" class="btn" id="hp-save" data-act="save" disabled>${IC.check} Save</button>
            <button type="button" class="btn solid" id="hp-publish" data-act="publish">${IC.rocket} Publish</button>
          </div>
          <div class="hp-hint" id="hp-hint" hidden>Saved to Pi · not yet live — Publish pushes the site.</div>
          <div class="hp-rail-scroll" id="hp-rail-scroll"></div>
        </div>
        <div class="hp-preview">
          <div class="hp-preview-bar">
            <span class="pb-label" id="hp-pb-label"><span class="live" aria-hidden="true"></span>Draft preview</span>
            <div class="hp-seg hp-seg-mode" role="group" aria-label="Preview source">
              <button type="button" class="on" data-mode="draft" aria-pressed="true">Draft</button>
              <button type="button" data-mode="live" aria-pressed="false">Live</button>
            </div>
            <div class="hp-seg" role="group" aria-label="Preview device">
              <button type="button" class="on" data-device="desktop" aria-pressed="true">Desktop</button>
              <button type="button" data-device="phone" aria-pressed="false">Phone</button>
            </div>
            <a class="btn sm" href="${SITE_URL}" target="_blank" rel="noopener">Open site ↗</a>
          </div>
          <div class="hp-preview-scroll">
            <div class="hp-canvas" id="hp-canvas"></div>
            <iframe class="hp-live" id="hp-live" title="Live site preview" loading="lazy" hidden></iframe>
            <div class="hp-live-status" id="hp-live-status" role="status" hidden>
              <span class="te-spinner" aria-hidden="true"></span> Loading the live site…
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── Init ────────────────────────────────────────────────────
  async function init() {
    const el = root();
    if (!el) return;
    /** @type {any} */
    let model;
    /** @type {any} */
    let settings;
    try {
      // Site config is best-effort (only the Videos @handle depends on it);
      // never let it block or fail the editor.
      [model, settings] = await Promise.all([
        TE.fetchJSON('/api/settings/homepage'),
        TE.fetchJSON('/api/settings').catch(() => null),
      ]);
    } catch (err) {
      el.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="e-mark">∅</div>
          <div class="e-text">Couldn’t load the homepage model — ${esc(/** @type {Error} */ (err).message)}</div>
        </div></div>`;
      return;
    }
    const yt =
      settings && settings.hugo && settings.hugo.social && settings.hugo.social.youtube_handle;
    if (yt) siteYoutubeHandle = yt;
    saved = clone(model);
    draft = clone(model);
    selected = 'hero';
    open = 'hero';
    savedNotLive = false;
    introActive = true;
    renderShell();
    wire();
    renderAll();
    // Let the one-shot entrance animation play, then drop the class so
    // later re-renders (every keystroke) don't replay it.
    setTimeout(() => {
      introActive = false;
      const c = document.getElementById('hp-canvas');
      if (c) c.classList.remove('intro');
    }, 1200);
  }

  window.TE = window.TE || {};
  window.TE.routes = window.TE.routes || {};
  window.TE.routes.homepage = init;
})();
