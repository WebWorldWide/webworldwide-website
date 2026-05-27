// @ts-nocheck
/**
 * embed-loader.js — Phase 7 click-to-load embed handler.
 *
 * Hugo's embed-* shortcodes render a small `<button data-embed-href="…"
 * data-embed-type="iframe|script|tiktok">` placeholder. We listen for
 * clicks on the document, locate the nearest `[data-embed-href]`, and
 * swap the placeholder for the heavy element (iframe / external script
 * tag) only at that point. Lighthouse stays in the green because the
 * initial paint is just an `<img>` thumbnail.
 *
 * Forward-compat with the Phase 6 lightbox: lightbox.js already
 * explicitly skips clicks inside `[data-embed-href]` ancestors, and we
 * never look at `[data-lightbox-src]` here — the two selectors are
 * orthogonal by design.
 *
 * Accessibility:
 *   - The placeholder is a real `<button>`, so it's keyboard- and AT-
 *     reachable from day one.
 *   - On activation we replace the button with the new element and
 *     move focus to it, so keyboard users land on the live embed.
 *   - We honour `prefers-reduced-motion` by setting `loading="eager"`
 *     and disabling the brief opacity fade — motion-sensitive users
 *     get an instant swap instead of an animation.
 *
 * No dependencies. Wrapped in an IIFE; safe under `defer`.
 */
(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  var INSERTED_ATTR = 'data-embed-loaded';

  function prefersReducedMotion() {
    try {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * Convert a bsky.app/profile/<handle>/post/<rkey> web URL into the
   * official embed URL: https://embed.bsky.app/embed?uri=at://…
   * Returns the original `webUrl` unchanged if parsing fails, so the
   * iframe still loads something the user can interact with.
   *
   * The Hugo partial also writes `data-embed-uri` directly for the
   * thread embed, so we prefer that when present.
   *
   * @param webUrl
   * @param explicitAtUri
   */
  function bskyEmbedSrc(webUrl, explicitAtUri) {
    if (explicitAtUri) {
      return 'https://embed.bsky.app/embed?uri=' + encodeURIComponent(explicitAtUri);
    }
    if (!webUrl) return webUrl;
    try {
      var u = new URL(webUrl);
      if (!/bsky\.app$/i.test(u.hostname)) return webUrl;
      var parts = u.pathname.split('/').filter(Boolean);
      // /profile/<handle>/post/<rkey>
      if (parts.length < 4) return webUrl;
      if (parts[0] !== 'profile' || parts[2] !== 'post') return webUrl;
      var atUri = 'at://' + parts[1] + '/app.bsky.feed.post/' + parts[3];
      return 'https://embed.bsky.app/embed?uri=' + encodeURIComponent(atUri);
    } catch (_) {
      return webUrl;
    }
  }

  /**
   * Swap the placeholder for the heavy element. Returns the inserted
   * node so callers can move focus to it.
   * @param btn
   */
  function activate(btn) {
    if (!btn || btn.getAttribute(INSERTED_ATTR) === 'true') return null;
    var href = btn.getAttribute('data-embed-href');
    var type = btn.getAttribute('data-embed-type') || 'iframe';
    if (!href) return null;
    btn.setAttribute(INSERTED_ATTR, 'true');

    var parent = btn.parentNode;
    if (!parent) return null;

    var inserted = null;
    var reduced = prefersReducedMotion();

    if (type === 'iframe' || type === 'tiktok' || type === 'bluesky-thread') {
      var iframe = document.createElement('iframe');
      // bluesky-thread: the placeholder stores the web URL in
      // data-embed-href (so the <noscript> fallback link is useful),
      // and the AT URI in data-embed-uri. Convert to the official
      // embed.bsky.app endpoint for the iframe src.
      var src =
        type === 'bluesky-thread' ? bskyEmbedSrc(href, btn.getAttribute('data-embed-uri')) : href;
      iframe.setAttribute('src', src);
      // Locked-down iframe — no top-nav, no popups; allow scripts +
      // same-origin so YouTube/Vimeo/Bluesky players actually work,
      // and presentation for fullscreen video controls.
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('loading', reduced ? 'eager' : 'lazy');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      // Reuse the placeholder's accessible label so screen readers
      // announce something meaningful when focus lands here.
      var label = btn.getAttribute('aria-label');
      if (label) iframe.setAttribute('title', label.replace(/^(Play|Load)\s+/, ''));
      iframe.className = 'embed-frame';
      if (type === 'bluesky-thread') {
        iframe.className += ' embed-frame-bluesky-thread';
        // Bluesky threads can be tall; let them grow rather than
        // squashing into a 16:9 box.
        iframe.style.minHeight = '600px';
      }
      // Allow the parent figure's aspect-ratio CSS to size us; default
      // 16:9 for video and 4:5 for social embeds — themed by the
      // parent's `data-provider`.
      iframe.style.width = '100%';
      iframe.tabIndex = 0;
      inserted = iframe;
    } else if (type === 'script') {
      // GitHub Gist style — load the script tag synchronously into a
      // dedicated wrapper so the resulting `<table>` lands where the
      // placeholder was. We can't simply `appendChild(script)` into
      // <head> because gist.js calls `document.write` at load time;
      // we therefore inject via a `<script async>` and let it write
      // into a sibling wrapper.
      var wrapper = document.createElement('div');
      wrapper.className = 'embed-script-wrapper';
      var script = document.createElement('script');
      script.async = true;
      script.src = href;
      wrapper.appendChild(script);
      inserted = wrapper;
    } else {
      // Unknown type — leave the placeholder in place. Should never
      // happen for content from our editor, but a hand-authored shortcode
      // with a typo shouldn't crash the page.
      btn.removeAttribute(INSERTED_ATTR);
      return null;
    }

    if (!reduced) {
      inserted.style.opacity = '0';
      inserted.style.transition = 'opacity 180ms ease';
    }

    parent.replaceChild(inserted, btn);

    if (!reduced) {
      // Next frame so the transition kicks in.
      requestAnimationFrame(function () {
        inserted.style.opacity = '1';
      });
    }

    // Move focus into the new element so keyboard users land here.
    if (typeof inserted.focus === 'function') {
      try {
        inserted.focus();
      } catch (_) {
        /* ignore */
      }
    }

    return inserted;
  }

  function onClick(e) {
    if (e.defaultPrevented) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest('[data-embed-href]');
    if (!btn) return;
    // Guard: only act on placeholders that haven't been replaced yet.
    if (btn.getAttribute(INSERTED_ATTR) === 'true') return;
    e.preventDefault();
    activate(btn);
  }

  function onKeydown(e) {
    // Buttons handle Enter / Space natively via click — but a few
    // browsers don't synthesise Space → click reliably inside a
    // `<figure>` wrapper. Belt-and-braces.
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var target = e.target;
    if (!target || !target.matches) return;
    if (!target.matches('[data-embed-href]')) return;
    e.preventDefault();
    activate(target);
  }

  function init() {
    document.addEventListener('click', onClick, false);
    document.addEventListener('keydown', onKeydown, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Expose a tiny surface for tests + future programmatic use.
  if (typeof window !== 'undefined') {
    window.TEEmbed = { activate: activate };
  }
})();
