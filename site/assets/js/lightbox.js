// @ts-nocheck
/**
 * lightbox.js — Phase 6 image lightbox + gallery navigation.
 *
 * Hijacks clicks on `[data-lightbox-src]` (single images embedded via
 * the attachment shortcode) and `[data-gallery-href]` (the Phase 5e
 * gallery shortcode's per-item links). Opens an accessible dialog at
 * full image size with focus trap, ESC + backdrop close, arrow-key
 * navigation across gallery siblings, and focus restoration to the
 * original trigger on close.
 *
 * No external deps. Inline styles only — keeps shipping cheap and
 * avoids a CSS dependency for what is essentially a single overlay.
 *
 * Phase 7 forward note: the embed system will also use
 * `[data-embed-href]` for click-to-load. Our selector is narrower
 * (lightbox-src + gallery-href) so we don't conflict. If you add
 * a new selector here, double-check it doesn't shadow embeds.
 */
(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  var OPEN_ATTR = 'data-lightbox-open';
  var ROOT_ID = 'te-lightbox-root';

  var state = {
    root: null,
    img: null,
    overlay: null,
    closeBtn: null,
    prevBtn: null,
    nextBtn: null,
    items: [], // current gallery list
    index: 0,
    trigger: null, // element to restore focus to on close
    keydownBound: false,
  };

  function ensureRoot() {
    // If a prior root was detached from the document (test reset, or a
    // page that wiped its body), recreate. We can't rely on the cached
    // reference alone — that would point at an orphan node and our
    // dialog would never render.
    if (state.root && state.root.isConnected) return state.root;
    if (state.root && !state.root.isConnected) {
      state.root = null;
      state.img = null;
      state.overlay = null;
      state.closeBtn = null;
      state.prevBtn = null;
      state.nextBtn = null;
    }
    var root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'lightbox';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Image preview');
    root.hidden = true;
    // Inline structural styles — keeps the bundle shippable with no
    // dependency on the main stylesheet loading. The .lightbox class
    // in screen.css layers on theme colours.
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.zIndex = '9999';
    root.style.display = 'flex';
    root.style.alignItems = 'center';
    root.style.justifyContent = 'center';

    root.innerHTML =
      '<div class="lightbox-backdrop" tabindex="-1" style="position:absolute;inset:0;background:rgba(0,0,0,0.86);"></div>' +
      '<button type="button" class="lightbox-close" aria-label="Close preview" style="position:absolute;top:16px;right:16px;z-index:2;">Close</button>' +
      '<button type="button" class="lightbox-prev" aria-label="Previous image" style="position:absolute;left:16px;top:50%;transform:translateY(-50%);z-index:2;">‹</button>' +
      '<button type="button" class="lightbox-next" aria-label="Next image" style="position:absolute;right:16px;top:50%;transform:translateY(-50%);z-index:2;">›</button>' +
      '<figure class="lightbox-figure" style="position:relative;z-index:1;max-width:92vw;max-height:92vh;">' +
      '<img class="lightbox-img" alt="" style="display:block;max-width:92vw;max-height:92vh;object-fit:contain;" />' +
      '</figure>';

    document.body.appendChild(root);
    state.root = root;
    state.overlay = root.querySelector('.lightbox-backdrop');
    state.img = root.querySelector('.lightbox-img');
    state.closeBtn = root.querySelector('.lightbox-close');
    state.prevBtn = root.querySelector('.lightbox-prev');
    state.nextBtn = root.querySelector('.lightbox-next');

    state.overlay.addEventListener('click', close);
    state.closeBtn.addEventListener('click', close);
    state.prevBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      step(-1);
    });
    state.nextBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      step(1);
    });

    return root;
  }

  /**
   * Open the dialog with the given image src and (optionally) a list
   * of sibling URLs for arrow-key navigation. `trigger` is the element
   * to restore focus to on close.
   * @param src
   * @param opts
   */
  function open(src, opts) {
    opts = opts || {};
    ensureRoot();
    state.items = Array.isArray(opts.items) && opts.items.length ? opts.items : [src];
    state.index = Math.max(0, state.items.indexOf(src));
    if (state.index < 0) state.index = 0;
    state.trigger = opts.trigger || document.activeElement;
    showCurrent();
    state.root.hidden = false;
    document.documentElement.setAttribute(OPEN_ATTR, 'true');
    if (!state.keydownBound) {
      document.addEventListener('keydown', onKeydown, true);
      state.keydownBound = true;
    }
    // Focus the close button so ESC + visible focus both work.
    if (state.closeBtn && state.closeBtn.focus) {
      try {
        state.closeBtn.focus();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function close() {
    if (!state.root || state.root.hidden) return;
    state.root.hidden = true;
    document.documentElement.removeAttribute(OPEN_ATTR);
    if (state.keydownBound) {
      document.removeEventListener('keydown', onKeydown, true);
      state.keydownBound = false;
    }
    // Restore focus to the triggering element. Use try/catch because
    // the trigger might have been removed from the DOM (rare but
    // possible if the page re-rendered while the dialog was open).
    var t = state.trigger;
    state.trigger = null;
    if (t && typeof t.focus === 'function') {
      try {
        t.focus();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function showCurrent() {
    if (!state.img || !state.items.length) return;
    var src = state.items[state.index];
    state.img.setAttribute('src', src);
    // Hide nav buttons when only one image.
    var multi = state.items.length > 1;
    if (state.prevBtn) state.prevBtn.hidden = !multi;
    if (state.nextBtn) state.nextBtn.hidden = !multi;
  }

  function step(direction) {
    if (state.items.length < 2) return;
    var next = (state.index + direction + state.items.length) % state.items.length;
    state.index = next;
    showCurrent();
  }

  function onKeydown(e) {
    if (!state.root || state.root.hidden) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.stopPropagation();
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
      return;
    }
    if (e.key === 'Tab') {
      // Minimal focus trap: cycle between close/prev/next.
      var focusables = [state.closeBtn, state.prevBtn, state.nextBtn].filter(function (n) {
        return n && !n.hidden;
      });
      if (!focusables.length) return;
      var current = document.activeElement;
      var i = focusables.indexOf(current);
      if (e.shiftKey) {
        e.preventDefault();
        var prev = i <= 0 ? focusables[focusables.length - 1] : focusables[i - 1];
        prev.focus();
      } else {
        e.preventDefault();
        var nxt = i < 0 || i >= focusables.length - 1 ? focusables[0] : focusables[i + 1];
        nxt.focus();
      }
    }
  }

  function siblingUrlsFor(el) {
    // Collect all gallery items in the same `[data-gallery]` group.
    var group = el.closest && el.closest('[data-gallery]');
    if (!group) return null;
    var nodes = group.querySelectorAll('[data-gallery-href]');
    var urls = [];
    for (var i = 0; i < nodes.length; i++) {
      var u = nodes[i].getAttribute('data-gallery-href');
      if (u) urls.push(u);
    }
    return urls.length ? urls : null;
  }

  function onClick(e) {
    // Modifier keys → let the browser do its native thing
    // (Cmd-click = new tab, etc.).
    if (e.defaultPrevented) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var target = e.target;
    if (!target || !target.closest) return;
    // Gallery item takes precedence so a click on an `<img>` inside an
    // `<a data-gallery-href>` is handled the same as a click on the
    // link.
    var galleryEl = target.closest('[data-gallery-href]');
    var singleEl = target.closest('[data-lightbox-src]');
    var node = galleryEl || singleEl;
    if (!node) return;
    // Phase 7 forward-compat: never intercept embeds. The embed system
    // uses [data-embed-href]; we sanity-check here so a future selector
    // misuse can't accidentally fire the lightbox for an embed click.
    if (target.closest && target.closest('[data-embed-href]')) return;

    var src = galleryEl
      ? galleryEl.getAttribute('data-gallery-href')
      : singleEl.getAttribute('data-lightbox-src');
    if (!src) return;

    e.preventDefault();
    var items = galleryEl ? siblingUrlsFor(galleryEl) : null;
    open(src, { items: items, trigger: node });
  }

  function init() {
    document.addEventListener('click', onClick, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Expose a tiny surface for tests + future programmatic use.
  if (typeof window !== 'undefined') {
    window.TELightbox = { open: open, close: close, _state: state };
  }
})();
