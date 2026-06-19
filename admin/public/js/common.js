// @ts-check
/**
 * common.js — shared helpers for every admin page.
 *
 * Loaded on login.html, index.html, and editor.html. Single file = single
 * cache hit, no module graph, no bundler. Plain old IIFE.
 *
 * Exposes (on `window.TE`):
 *   toast(message, kind)            // 'info' (default) | 'error' | 'warn'
 *   escape(str)                     // HTML-escape user-supplied text
 *   fmtBytes(n)                     // human-friendly bytes
 *   fmtUptime(seconds)              // "4h 11m" / "2d 3h"
 *   fmtTs(ms)                       // epoch-ms → "just now" / "3h ago" / "YYYY-MM-DD"
 *   csvField(v)                     // CSV-safe quoted field
 *   WPM                             // words-per-minute constant (250) for reading time
 *   fetchJSON(url, opts)            // JSON fetch w/ session redirect on 401
 *   openModal(id) / closeModal(id)  // also installs Esc + focus-trap
 *
 * Also installs (no caller needed):
 *   - [data-modal-close="id"] click-to-close + Esc close-top-modal
 *   - Cmd/Ctrl-K command palette (#cmdk) — opens, filter, Enter to act
 */

(function () {
  /** @type {any} */
  const w = window;
  // Guard off an init flag, not mere existence: icons.js seeds window.TE with
  // its icon helpers before this file loads, so merge into that object rather
  // than bail. The flag still prevents this IIFE from initialising twice.
  if (w.TE && w.TE.__commonInit) return;
  /** @type {Record<string, any>} */
  const TE = w.TE || {};
  w.TE = TE;
  TE.__commonInit = true;

  // ── Theme ──────────────────────────────────────────────────
  // Dark mode is retired — the admin is light-only. Force data-theme="light"
  // on boot (clearing any stale "dark" left in localStorage by older builds)
  // and tell the Remark42 comments embed to match.
  function initTheme() {
    document.documentElement.setAttribute('data-theme', 'light');
    try {
      localStorage.removeItem('theme');
    } catch (_) {
      /* sandbox / private mode */
    }
    try {
      const r42 = /** @type {any} */ (window).REMARK42;
      if (r42 && typeof r42.changeTheme === 'function') r42.changeTheme('light');
    } catch (_) {
      /* noop */
    }
  }

  // ── Toasts ─────────────────────────────────────────────────
  /**
   * Show a transient toast in the bottom-right corner.
   * @param {string} message
   * @param {'info' | 'error' | 'warn'} [kind]
   */
  TE.toast = function toast(message, kind) {
    const root = document.getElementById('toast-root');
    if (!root) {
      // Tests / pages without a toast region: drop the message silently.
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    // Error-class toasts are urgent enough to use role="alert"; the
    // surrounding region is aria-live="polite" so info/warn just announce.
    if (kind === 'error') el.setAttribute('role', 'alert');
    el.textContent = String(message === null || message === undefined ? '' : message);
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      el.style.transition = 'opacity 180ms, transform 180ms';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  };

  // ── Misc helpers ───────────────────────────────────────────
  /**
   * @param {unknown} s
   * @returns {string}
   */
  TE.escape = function escape(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  /**
   * @param {number} bytes
   * @param {number} [decimals]
   * @returns {string}
   */
  TE.fmtBytes = function fmtBytes(bytes, decimals = 1) {
    const n = Number(bytes);
    if (!n) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), sizes.length - 1);
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded number from Math.min above.
    const unit = sizes[i];
    return `${parseFloat((n / Math.pow(k, i)).toFixed(dm))} ${unit}`;
  };

  /**
   * @param {number | null | undefined} seconds
   * @returns {string}
   */
  TE.fmtUptime = function fmtUptime(seconds) {
    if (seconds === null || seconds === undefined || isNaN(Number(seconds))) return '—';
    const s = Number(seconds);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  /**
   * fetch wrapper that JSON-parses, redirects to /login.html on 401,
   * and throws an Error with .status/.data on non-2xx responses.
   * @param {string} url
   * @param {{method?: string, body?: any, headers?: Record<string, string>, credentials?: 'omit' | 'same-origin' | 'include'}} [options]
   * @returns {Promise<any>}
   */
  TE.fetchJSON = async function fetchJSON(url, options) {
    const opts = Object.assign(
      { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' },
      options || {},
    );
    const res = await fetch(url, opts);
    if (res.status === 401) {
      const onLogin = window.location.pathname.startsWith('/login');
      if (!onLogin) {
        window.location.href = '/login.html';
        // Throw so callers don't continue mid-flow.
        throw new Error('Not authenticated');
      }
    }
    /** @type {any} */
    let data;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = { ok: res.ok };
    }
    if (!res.ok) {
      const err = /** @type {Error & {status?: number; data?: any}} */ (
        new Error((data && (data.error || data.message)) || `HTTP ${res.status}`)
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  // ── Focus trap ─────────────────────────────────────────────
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
    ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** @type {WeakMap<Element, (e: KeyboardEvent) => void>} */
  const trapHandlers = new WeakMap();
  /** @type {WeakMap<Element, Element | null>} */
  const returnFocus = new WeakMap();

  /** @param {HTMLElement} container */
  function trapFocus(container) {
    returnFocus.set(container, document.activeElement);
    const handler = /** @param {KeyboardEvent} e */ (e) => {
      if (e.key !== 'Tab') return;
      const nodes = /** @type {HTMLElement[]} */ (
        Array.from(container.querySelectorAll(FOCUSABLE)).filter(
          (n) => /** @type {HTMLElement} */ (n).offsetParent !== null,
        )
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = /** @type {HTMLElement} */ (document.activeElement);
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    trapHandlers.set(container, handler);
    container.addEventListener('keydown', handler);
  }

  /** @param {HTMLElement} container */
  function releaseFocus(container) {
    const handler = trapHandlers.get(container);
    if (handler) {
      container.removeEventListener('keydown', /** @type {any} */ (handler));
      trapHandlers.delete(container);
    }
    const prev = returnFocus.get(container);
    if (prev && /** @type {HTMLElement} */ (prev).focus) {
      try {
        /** @type {HTMLElement} */ (prev).focus();
      } catch (_) {
        /* ignore */
      }
    }
    returnFocus.delete(container);
  }
  // Shared with other modules (router.js uses them for the mobile nav
  // drawer, which follows the same modal keyboard pattern).
  TE.trapFocus = trapFocus;
  TE.releaseFocus = releaseFocus;

  // ── Focusing into overlays ─────────────────────────────────
  /**
   * A destructive control we must never auto-focus when an overlay opens.
   * @param {Element} el
   */
  function isDestructive(el) {
    return (
      el.classList.contains('danger') ||
      el.hasAttribute('data-destructive') ||
      /\b(delete|remove|destroy)\b/i.test(el.getAttribute('data-act') || '')
    );
  }

  /**
   * Move focus to the most sensible control inside a freshly-opened
   * overlay: an explicit [data-autofocus], else the first non-destructive
   * non-close control, else any non-destructive control, else the dialog
   * itself. Never lands on a disabled (FOCUSABLE already excludes those)
   * or destructive button.
   * @param {HTMLElement} container
   */
  function focusFirst(container) {
    // Visibility filter that doesn't depend on layout (offsetParent is
    // always null under jsdom): skip `hidden`, hidden inputs, and anything
    // inside a `[hidden]` subtree.
    const all = /** @type {HTMLElement[]} */ (
      Array.from(container.querySelectorAll(FOCUSABLE)).filter(
        (n) =>
          !(/** @type {HTMLElement} */ (n).hidden) &&
          !(n.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (n).type === 'hidden') &&
          !n.closest('[hidden]'),
      )
    );
    const target =
      /** @type {HTMLElement | null} */ (container.querySelector('[data-autofocus]')) ||
      all.find((n) => !n.hasAttribute('data-modal-close') && !isDestructive(n)) ||
      all.find((n) => !isDestructive(n)) ||
      null;
    if (target) {
      try {
        target.focus();
        return;
      } catch (_) {
        /* ignore */
      }
    }
    // Nothing safe to focus — focus the dialog so it's announced + Esc works.
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    try {
      container.focus();
    } catch (_) {
      /* ignore */
    }
  }
  TE.focusFirst = focusFirst;

  // ── Background inerting (refcounted; tolerates stacked overlays) ──
  // Modals/palette/drawers are siblings of `.shell`, so inerting `.shell`
  // removes the app behind the overlay from both the tab order and the
  // a11y tree without touching the overlay. No-op on pages without a shell
  // (editor/login), where the focus trap alone suffices.
  let overlayDepth = 0;
  function lockBackground() {
    overlayDepth += 1;
    if (overlayDepth !== 1) return;
    const shell = document.querySelector('.shell');
    if (shell && !shell.hasAttribute('data-te-inert')) {
      shell.setAttribute('inert', '');
      shell.setAttribute('aria-hidden', 'true');
      shell.setAttribute('data-te-inert', '');
    }
  }
  function unlockBackground() {
    overlayDepth = Math.max(0, overlayDepth - 1);
    if (overlayDepth !== 0) return;
    const shell = document.querySelector('[data-te-inert]');
    if (shell) {
      shell.removeAttribute('inert');
      shell.removeAttribute('aria-hidden');
      shell.removeAttribute('data-te-inert');
    }
  }
  TE.lockBackground = lockBackground;
  TE.unlockBackground = unlockBackground;

  // ── Modals ─────────────────────────────────────────────────
  /** @param {string} id */
  TE.openModal = function openModal(id) {
    const m = /** @type {HTMLElement | null} */ (document.getElementById(id));
    if (!m || m.classList.contains('open')) return;
    m.classList.add('open');
    m.removeAttribute('aria-hidden');
    lockBackground();
    // trapFocus BEFORE focusFirst so the opener (still the active element)
    // is the focus we restore on close.
    trapFocus(m);
    focusFirst(m);
  };

  /** @param {string} id */
  TE.closeModal = function closeModal(id) {
    const m = /** @type {HTMLElement | null} */ (document.getElementById(id));
    if (!m || !m.classList.contains('open')) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    releaseFocus(m);
    unlockBackground();
  };

  // ── Drawers (slide-over dialogs that aren't `.modal`) ──────
  // Media + comments use these so they get the same focus-in / focus-trap /
  // inert-background / focus-restore treatment as modals.
  /** @param {HTMLElement | null} el */
  TE.openDrawer = function openDrawer(el) {
    if (!el || el.classList.contains('open')) return;
    el.classList.add('open');
    el.removeAttribute('aria-hidden');
    el.removeAttribute('inert');
    /** @type {any} */ (el).inert = false;
    lockBackground();
    trapFocus(el);
    focusFirst(el);
  };
  /** @param {HTMLElement | null} el */
  TE.closeDrawer = function closeDrawer(el) {
    if (!el || !el.classList.contains('open')) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    /** @type {any} */ (el).inert = true;
    releaseFocus(el);
    unlockBackground();
  };

  function initModals() {
    document.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target);
      const closer = target.closest && target.closest('[data-modal-close]');
      if (closer) {
        e.preventDefault();
        const id = closer.getAttribute('data-modal-close');
        if (id) TE.closeModal(id);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Close the top-most open modal first.
      const open = Array.from(document.querySelectorAll('.modal.open'));
      const top = open[open.length - 1];
      if (top && top.id) {
        e.stopPropagation();
        TE.closeModal(top.id);
        return;
      }
      // Otherwise dismiss an open slide-over drawer by clicking its close
      // control (so the owning module's state resets), falling back to
      // closeDrawer if it has none.
      const drawer = /** @type {HTMLElement | null} */ (
        document.querySelector('.te-media-drawer.open, .te-cm-drawer.open')
      );
      if (drawer) {
        e.stopPropagation();
        const closeBtn = /** @type {HTMLElement | null} */ (
          drawer.querySelector('[id$="-close"], [data-drawer-close]')
        );
        if (closeBtn) closeBtn.click();
        else TE.closeDrawer(drawer);
      }
    });
  }

  // ── Keyboard activation for role="button" elements ─────────
  // A single global polyfill so any non-native control marked
  // role="button" tabindex="0" responds to Enter/Space exactly like a
  // <button>, reusing whatever click handler is already wired (often
  // delegated). Lets list rows, cards and section heads be keyboard-
  // operable without per-view keydown plumbing.
  function initKeyboardActivation() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const t = /** @type {HTMLElement | null} */ (e.target);
      if (!t || t.getAttribute('role') !== 'button') return;
      const tag = t.tagName;
      if (
        tag === 'BUTTON' ||
        tag === 'A' ||
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA'
      )
        return; // native elements already activate
      if (t.hasAttribute('disabled') || t.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault(); // Space must not scroll the page
      t.click();
    });
  }

  // ── Cmd+K palette ──────────────────────────────────────────
  // Static commands; pages that want page-specific entries can push to
  // window.TE.paletteCommands before boot.
  /** @type {{label: string, hint?: string, href?: string, run?: () => void}[]} */
  const baseCommands = [
    { label: 'Dashboard', hint: 'Go to dashboard', href: '/index.html' },
    { label: 'New post', hint: 'Open a blank editor', href: '/editor.html' },
    { label: 'View site', hint: 'Open the public site', href: 'https://webworldwide.online' },
    {
      label: 'Sign out',
      hint: 'End the admin session',
      run: () => /** @type {HTMLElement | null} */ (document.getElementById('btn-logout'))?.click(),
    },
  ];
  /** @type {any[]} */
  TE.paletteCommands = baseCommands.slice();

  function ensurePaletteDom() {
    if (document.getElementById('cmdk')) return document.getElementById('cmdk');
    const wrap = document.createElement('div');
    wrap.id = 'cmdk';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Command palette');
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="cmdk-card">
        <div class="cmdk-input">
          <label class="sr-only" for="cmdk-input">Filter commands</label>
          <input id="cmdk-input" type="text" placeholder="Search posts, pages, actions…" autocomplete="off" />
          <span class="kbd">ESC</span>
        </div>
        <!-- tabindex: the results list scrolls when long, and a
             scrollable region must be keyboard-reachable (axe
             scrollable-region-focusable). Arrow-key navigation lives
             on the input; Tab reaches the list for direct scrolling. -->
        <ul class="cmdk-list" id="cmdk-list" role="listbox" aria-label="Commands" tabindex="0"></ul>
        <div class="cmdk-foot"><span class="kbd">↑↓</span> navigate <span class="kbd">↵</span> run <span class="kbd">ESC</span> close</div>
      </div>`;
    document.body.appendChild(wrap);
    return wrap;
  }

  /** @type {number} */
  let cmdkIndex = 0;
  /** @type {any[]} */
  let cmdkVisible = [];

  function renderPalette() {
    const list = /** @type {HTMLElement | null} */ (document.getElementById('cmdk-list'));
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('cmdk-input'));
    if (!list || !input) return;
    const q = input.value.trim().toLowerCase();
    cmdkVisible = TE.paletteCommands.filter(
      (c) =>
        !q ||
        String(c.label).toLowerCase().includes(q) ||
        String(c.hint || '')
          .toLowerCase()
          .includes(q),
    );
    if (!cmdkVisible.length) {
      list.innerHTML = `<li class="cmdk-empty">No matches.</li>`;
      cmdkIndex = -1;
      return;
    }
    if (cmdkIndex >= cmdkVisible.length) cmdkIndex = 0;
    if (cmdkIndex < 0) cmdkIndex = 0;
    list.innerHTML = cmdkVisible
      .map((c, i) => {
        const sel = i === cmdkIndex ? ' aria-selected="true"' : '';
        return `<li role="option" data-i="${i}"${sel}>
          <span class="cmdk-l">${TE.escape(c.label)}</span>
          ${c.hint ? `<span class="cmdk-r">${TE.escape(c.hint)}</span>` : ''}
        </li>`;
      })
      .join('');
    list.querySelectorAll('li').forEach((li) => {
      li.addEventListener('mouseenter', () => {
        const i = Number(li.getAttribute('data-i'));
        if (Number.isFinite(i) && i >= 0 && i < cmdkVisible.length) {
          cmdkIndex = i;
          renderPalette();
        }
      });
      li.addEventListener('click', runActive);
    });
  }

  function openPalette() {
    const wrap = /** @type {HTMLElement | null} */ (ensurePaletteDom());
    if (!wrap || !wrap.hidden) return; // already open — don't double-lock
    wrap.hidden = false;
    wrap.classList.add('open');
    lockBackground();
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('cmdk-input'));
    if (input) {
      input.value = '';
      cmdkIndex = 0;
      renderPalette();
      try {
        input.focus();
      } catch (_) {
        /* ignore */
      }
    }
    trapFocus(wrap);
  }

  function closePalette() {
    const wrap = /** @type {HTMLElement | null} */ (document.getElementById('cmdk'));
    if (!wrap || wrap.hidden) return;
    wrap.hidden = true;
    wrap.classList.remove('open');
    releaseFocus(wrap);
    unlockBackground();
  }

  function runActive() {
    if (cmdkIndex < 0 || cmdkIndex >= cmdkVisible.length) return;
    // eslint-disable-next-line security/detect-object-injection -- cmdkIndex is bounded above.
    const cmd = cmdkVisible[cmdkIndex];
    if (!cmd) return;
    closePalette();
    if (cmd.run) {
      try {
        cmd.run();
      } catch (_err) {
        /* swallow palette callback errors — non-critical */
      }
    } else if (cmd.href) {
      if (/^https?:/.test(cmd.href)) {
        window.open(cmd.href, '_blank', 'noopener,noreferrer');
      } else {
        window.location.href = cmd.href;
      }
    }
  }

  function initPalette() {
    document.addEventListener('keydown', (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const wrap = document.getElementById('cmdk');
        if (wrap && !wrap.hidden) closePalette();
        else openPalette();
        return;
      }
      const wrap = document.getElementById('cmdk');
      if (!wrap || wrap.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePalette();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (cmdkVisible.length) {
          cmdkIndex = (cmdkIndex + 1) % cmdkVisible.length;
          renderPalette();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (cmdkVisible.length) {
          cmdkIndex = (cmdkIndex - 1 + cmdkVisible.length) % cmdkVisible.length;
          renderPalette();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runActive();
      }
    });

    // Filter input
    document.addEventListener('input', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t && t.id === 'cmdk-input') renderPalette();
    });

    // Click outside the card closes
    document.addEventListener('click', (e) => {
      const wrap = document.getElementById('cmdk');
      if (!wrap || wrap.hidden) return;
      if (e.target === wrap) closePalette();
    });

    // ⌘K kbd hint in topbar should also open the palette
    document.querySelectorAll('#topbar-search-input').forEach((input) => {
      input.addEventListener('focus', () => {
        // Don't steal focus — but a keyboard user typing in the topbar
        // search expects ⌘K to still hijack; that's handled above. We
        // do nothing special here.
      });
    });
  }

  // ── Shared utilities ───────────────────────────────────────
  TE.WPM = 250;

  /**
   * Format an epoch-ms timestamp as a human-friendly relative string.
   * @param {number | null | undefined} ms
   * @returns {string}
   */
  TE.fmtTs = function fmtTs(ms) {
    if (!ms) return '—';
    const delta = Date.now() - ms;
    if (delta < 0) return new Date(ms).toISOString().slice(0, 10);
    if (delta < 60 * 1000) return 'just now';
    if (delta < 3600 * 1000) return `${Math.floor(delta / 60000)}m ago`;
    if (delta < 24 * 3600 * 1000) return `${Math.floor(delta / 3600000)}h ago`;
    return new Date(ms).toISOString().slice(0, 10);
  };

  /**
   * Escape a value for inclusion in a CSV field (double-quote wrapping).
   * @param {unknown} v
   * @returns {string}
   */
  TE.csvField = function csvField(v) {
    return `"${String(v).replace(/"/g, '""')}"`;
  };

  // ── Shared empty / loading / error states ──────────────────
  // One canonical look for each, reusing the existing `.empty`/`.e-mark`/
  // `.e-text` vocabulary so every view stops inventing its own. Builders
  // return HTML strings; renderError also wires its Retry button.
  /** @param {{icon?: string, title?: string, text?: string}} [o] */
  TE.emptyState = function emptyState(o) {
    o = o || {};
    return (
      '<div class="te-state te-state-empty">' +
      `<div class="e-mark" aria-hidden="true">${TE.escape(o.icon || '∅')}</div>` +
      (o.title ? `<div class="e-title">${TE.escape(o.title)}</div>` : '') +
      `<div class="e-text">${TE.escape(o.text || 'Nothing here yet.')}</div>` +
      '</div>'
    );
  };
  /** @param {{text?: string}} [o] */
  TE.loadingState = function loadingState(o) {
    o = o || {};
    return (
      '<div class="te-state te-state-loading" role="status">' +
      '<span class="te-spinner" aria-hidden="true"></span>' +
      `<span class="e-text">${TE.escape(o.text || 'Loading…')}</span>` +
      '</div>'
    );
  };
  /** @param {{icon?: string, title?: string, text?: string, retryLabel?: string}} [o] */
  TE.errorState = function errorState(o) {
    o = o || {};
    return (
      '<div class="te-state te-state-error" role="alert">' +
      `<div class="e-mark" aria-hidden="true">${TE.escape(o.icon || '!')}</div>` +
      (o.title ? `<div class="e-title">${TE.escape(o.title)}</div>` : '') +
      `<div class="e-text">${TE.escape(o.text || 'Something went wrong.')}</div>` +
      `<button type="button" class="btn" data-te-retry>${TE.escape(o.retryLabel || 'Retry')}</button>` +
      '</div>'
    );
  };
  /**
   * @param {HTMLElement | null} el
   * @param {object} [o]
   */
  TE.renderEmpty = function renderEmpty(el, o) {
    if (el) el.innerHTML = TE.emptyState(o);
  };
  /**
   * @param {HTMLElement | null} el
   * @param {object} [o]
   */
  TE.renderLoading = function renderLoading(el, o) {
    if (el) el.innerHTML = TE.loadingState(o);
  };
  /**
   * Render an error state into `el` and wire its Retry button.
   * @param {HTMLElement | null} el
   * @param {{icon?: string, title?: string, text?: string, retryLabel?: string, onRetry?: () => void}} [o]
   */
  TE.renderError = function renderError(el, o) {
    if (!el) return;
    o = o || {};
    el.innerHTML = TE.errorState(o);
    if (typeof o.onRetry === 'function') {
      const btn = el.querySelector('[data-te-retry]');
      if (btn) btn.addEventListener('click', o.onRetry);
    }
  };

  // ── Focus retention across innerHTML rebuilds ───────────────
  /**
   * Build a re-find selector for an element: its id, else its data-*
   * signature.
   * @param {Element} el
   * @returns {string | null}
   */
  function focusKey(el) {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
    if (el.id) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const ds = Array.from(el.attributes)
      .filter((a) => a.name.indexOf('data-') === 0)
      .map((a) => `[${a.name}="${esc(a.value)}"]`)
      .join('');
    return ds ? tag + ds : null;
  }
  /**
   * Run `mutate` (which rebuilds part of `container` via innerHTML) while
   * keeping keyboard focus: the focused control is re-found afterwards by
   * id or its data-* signature so reorder/toggle/delete don't drop focus
   * to <body>.
   * @param {HTMLElement} container
   * @param {() => void} mutate
   */
  TE.preserveFocus = function preserveFocus(container, mutate) {
    const a = /** @type {Element | null} */ (document.activeElement);
    const key = a && container.contains(a) ? focusKey(a) : null;
    mutate();
    if (!key) return;
    let next;
    try {
      next = /** @type {HTMLElement | null} */ (container.querySelector(key));
    } catch (_) {
      return;
    }
    if (next && next.focus) {
      try {
        next.focus();
      } catch (_) {
        /* ignore */
      }
    }
  };

  // ── CSP-safe <img> error fallback ──────────────────────────
  // Inline onerror="" is blocked by `script-src-attr 'none'`, so attach
  // the handler in JS. A missing/broken image is replaced by a styled
  // placeholder node instead of the browser's broken-image glyph.
  /**
   * @param {HTMLImageElement | null} img
   * @param {(img: HTMLImageElement) => (Node | null)} makePlaceholder
   */
  TE.imgFallback = function imgFallback(img, makePlaceholder) {
    if (!img) return;
    const fail = function () {
      const ph = makePlaceholder ? makePlaceholder(img) : null;
      if (ph && img.parentNode) img.parentNode.replaceChild(ph, img);
      else img.style.display = 'none';
    };
    img.addEventListener('error', fail, { once: true });
    // Catch images that already failed (e.g. cached 404) before we attached.
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fail();
  };
  /**
   * Attach imgFallback to every img matching `selector` inside `root`.
   * @param {Element | Document | null} root
   * @param {string} selector
   * @param {(img: HTMLImageElement) => (Node | null)} makePlaceholder
   */
  TE.wireImgFallbacks = function wireImgFallbacks(root, selector, makePlaceholder) {
    if (!root) return;
    root
      .querySelectorAll(selector)
      .forEach((img) => TE.imgFallback(/** @type {HTMLImageElement} */ (img), makePlaceholder));
  };

  // ── Mobile nav drawer (hamburger < 800px) ──────────────────
  // Shared by the SPA shell (router.js) and the editor page so BOTH get a
  // working off-canvas nav on phones (the editor page previously had an
  // off-canvas sidebar with no opener). Idempotent — safe to call once per
  // page; needs #nav-toggle + #sidebar in the DOM.
  let mobileNavWired = false;
  TE.wireMobileNav = function wireMobileNav() {
    if (mobileNavWired) return;
    const toggle = document.getElementById('nav-toggle');
    const sidebar = document.getElementById('sidebar');
    if (!toggle || !sidebar) return;
    mobileNavWired = true;

    // The backdrop lives INSIDE .shell (a stacking context) so it can't
    // paint above the sidebar.
    const backdrop = document.createElement('div');
    backdrop.className = 'nav-backdrop';
    (document.querySelector('.shell') || document.body).appendChild(backdrop);

    function setOpen(open) {
      const wasOpen = document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      if (open && !wasOpen) {
        trapFocus(sidebar);
        /** @type {HTMLElement | null} */ (sidebar.querySelector('a, button'))?.focus();
      } else if (!open && wasOpen) {
        releaseFocus(sidebar);
      }
    }
    const close = () => setOpen(false);

    // Crossing back to desktop must release the trap + nav-open state.
    const mq = window.matchMedia('(max-width: 800px)');
    const onBreakpoint = () => {
      if (!mq.matches && document.body.classList.contains('nav-open')) close();
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onBreakpoint);

    toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
    backdrop.addEventListener('click', close);
    sidebar.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest('a')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
        close();
        toggle.focus();
      }
    });
  };

  // ── Keyboard shortcuts cheat-sheet ─────────────────────────
  // A "?"-triggered overlay (also opened by any [data-shortcuts-help]
  // control) listing the app + editor shortcuts. Built lazily and shared by
  // the shell and the editor page — both load common.js + components.css.
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  );
  const K_MOD = IS_MAC ? '⌘' : 'Ctrl';
  const K_ALT = IS_MAC ? '⌥' : 'Alt';
  const K_SHIFT = IS_MAC ? '⇧' : 'Shift';
  const SHORTCUT_GROUPS = [
    {
      title: 'General',
      items: [
        [[K_MOD, 'K'], 'Command palette'],
        [['?'], 'Keyboard shortcuts (this)'],
        [['Esc'], 'Close dialog / palette'],
      ],
    },
    {
      title: 'Editor — formatting',
      items: [
        [[K_MOD, 'B'], 'Bold'],
        [[K_MOD, 'I'], 'Italic'],
        [[K_MOD, K_SHIFT, 'U'], 'Underline'],
        [[K_MOD, K_SHIFT, 'X'], 'Strikethrough'],
        [[K_MOD, 'E'], 'Inline code'],
        [[K_MOD, 'K'], 'Link'],
        [[K_MOD, K_ALT, '1 / 2 / 3'], 'Heading level'],
      ],
    },
    {
      title: 'Editor — actions',
      items: [
        [[K_MOD, 'S'], 'Save draft'],
        [[K_MOD, '↵'], 'Save & publish'],
        [[K_MOD, 'F'], 'Find'],
        [['/'], 'Slash menu (insert block)'],
        [[K_ALT, K_SHIFT, '↑ / ↓'], 'Move block up / down'],
      ],
    },
  ];

  function buildShortcutsModal() {
    let m = document.getElementById('shortcuts-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'shortcuts-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'shortcuts-modal-title');
    m.setAttribute('aria-hidden', 'true');
    const groups = SHORTCUT_GROUPS.map((g) => {
      const rows = g.items
        .map(
          ([keys, label]) =>
            `<div class="kbd-row"><span class="kbd-keys">${keys
              .map((k) => `<span class="kbd">${TE.escape(k)}</span>`)
              .join('')}</span><span class="kbd-label">${TE.escape(label)}</span></div>`,
        )
        .join('');
      return `<div class="kbd-group"><h4>${TE.escape(g.title)}</h4>${rows}</div>`;
    }).join('');
    m.innerHTML =
      '<div class="modal-card">' +
      '<div class="modal-head"><h3 id="shortcuts-modal-title">Keyboard shortcuts</h3>' +
      '<button type="button" class="btn ghost" data-modal-close="shortcuts-modal" aria-label="Close">' +
      '<span class="ico" aria-hidden="true" data-icon="close"></span></button></div>' +
      '<div class="modal-body"><div class="kbd-sheet">' +
      groups +
      '</div></div>';
    document.body.appendChild(m);
    if (typeof TE.fillIcons === 'function') {
      try {
        TE.fillIcons(m);
      } catch (_) {
        /* icon fill is cosmetic */
      }
    }
    return m;
  }

  /** Open the keyboard-shortcuts overlay (lazily built). */
  TE.showShortcuts = function showShortcuts() {
    buildShortcutsModal();
    TE.openModal('shortcuts-modal');
  };

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function initShortcutsHelp() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return; // don't hijack a literal "?" being typed
      if (document.querySelector('.modal.open')) return; // a dialog already has focus
      e.preventDefault();
      TE.showShortcuts();
    });
    document.addEventListener('click', (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t && t.closest && t.closest('[data-shortcuts-help]')) {
        e.preventDefault();
        TE.showShortcuts();
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────
  function boot() {
    initTheme();
    initModals();
    initKeyboardActivation();
    initPalette();
    initShortcutsHelp();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose internals for tests (only when running under jsdom — there's
  // no harm leaving these in prod, but keeping under __test prefix.)
  TE.__test = { initTheme, openPalette, closePalette, renderPalette };
})();
