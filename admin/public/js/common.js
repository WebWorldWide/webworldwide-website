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
 *   fetchJSON(url, opts)            // JSON fetch w/ session redirect on 401
 *   openModal(id) / closeModal(id)  // also installs Esc + focus-trap
 *
 * Also installs (no caller needed):
 *   - Theme toggle for every #btn-theme on the page (FOUC-safe; the
 *     inline <script> in <head> runs before paint to pick light/dark)
 *   - [data-modal-close="id"] click-to-close + Esc close-top-modal
 *   - Cmd/Ctrl-K command palette (#cmdk) — opens, filter, Enter to act
 */

(function () {
  if (/** @type {any} */ (window).TE) return;
  /** @type {Record<string, any>} */
  const TE = {};
  /** @type {any} */ (window).TE = TE;

  // ── Theme ──────────────────────────────────────────────────
  /**
   * Apply a theme to <html> and sync all #btn-theme controls.
   * @param {'light' | 'dark'} theme
   */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('#btn-theme').forEach((btn) => {
      btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      const glyph = btn.querySelector('#btn-theme-glyph') || btn.querySelector('span');
      if (glyph) glyph.textContent = theme === 'dark' ? '☾' : '☀';
    });
    // Notify Remark42 (comments widget) if loaded.
    try {
      const r42 = /** @type {any} */ (window).REMARK42;
      if (r42 && typeof r42.changeTheme === 'function') r42.changeTheme(theme);
    } catch (_) {
      /* noop */
    }
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem('theme');
    } catch (_) {
      /* sandbox / private mode */
    }
    const current = /** @type {'light' | 'dark'} */ (
      saved === 'light' || saved === 'dark'
        ? saved
        : document.documentElement.getAttribute('data-theme') === 'light'
          ? 'light'
          : 'dark'
    );
    applyTheme(current);

    document.querySelectorAll('#btn-theme').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next =
          document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try {
          localStorage.setItem('theme', next);
        } catch (_) {
          /* ignore */
        }
        applyTheme(next);
      });
    });
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
    let data = null;
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

  // ── Modals ─────────────────────────────────────────────────
  /** @param {string} id */
  TE.openModal = function openModal(id) {
    const m = /** @type {HTMLElement | null} */ (document.getElementById(id));
    if (!m) return;
    m.classList.add('open');
    m.removeAttribute('aria-hidden');
    const focusTarget = /** @type {HTMLElement | null} */ (
      m.querySelector('[autofocus]') ||
        m.querySelector('input, select, textarea') ||
        m.querySelector('button:not([data-modal-close])')
    );
    if (focusTarget) {
      try {
        focusTarget.focus();
      } catch (_) {
        /* ignore */
      }
    }
    trapFocus(m);
  };

  /** @param {string} id */
  TE.closeModal = function closeModal(id) {
    const m = /** @type {HTMLElement | null} */ (document.getElementById(id));
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    releaseFocus(m);
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
      // Close the top-most open modal only.
      const open = Array.from(document.querySelectorAll('.modal.open'));
      const top = open[open.length - 1];
      if (top && top.id) {
        e.stopPropagation();
        TE.closeModal(top.id);
      }
    });
  }

  // ── Cmd+K palette ──────────────────────────────────────────
  // Static commands; pages that want page-specific entries can push to
  // window.TE.paletteCommands before boot.
  /** @type {{label: string, hint?: string, href?: string, run?: () => void}[]} */
  const baseCommands = [
    { label: 'Dashboard', hint: 'Go to dashboard', href: '/index.html' },
    { label: 'New post', hint: 'Open a blank editor', href: '/editor.html' },
    { label: 'View site', hint: 'Open the public site', href: 'https://terminaleighty.com' },
    {
      label: 'Toggle theme',
      hint: 'Dark ↔ light',
      run: () => /** @type {HTMLElement | null} */ (document.getElementById('btn-theme'))?.click(),
    },
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
        <ul class="cmdk-list" id="cmdk-list" role="listbox" aria-label="Commands"></ul>
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
    if (!wrap) return;
    wrap.hidden = false;
    wrap.classList.add('open');
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
    if (!wrap) return;
    wrap.hidden = true;
    wrap.classList.remove('open');
    releaseFocus(wrap);
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

  // ── Boot ───────────────────────────────────────────────────
  function boot() {
    initTheme();
    initModals();
    initPalette();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose internals for tests (only when running under jsdom — there's
  // no harm leaving these in prod, but keeping under __test prefix.)
  TE.__test = { applyTheme, openPalette, closePalette, renderPalette };
})();
