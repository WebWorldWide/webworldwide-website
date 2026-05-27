// @ts-check
/* ============================================================
   Terminal Eighty — frontend behaviors
   ------------------------------------------------------------
   - Theme toggle  (persists to localStorage.theme)
   - Live clock    (HH:MM:SS, updates 1Hz, decorative)
   - Reading progress  (single-post only, rAF-driven)
   - Cmd+K palette (fetches /index.json, fuzzy filter, kbd nav)
   - Lazy-load embed helper (stub for Phase 7)
   - Honors prefers-reduced-motion (transitions zeroed via CSS;
     clock and progress still update — they are state, not motion)
   ============================================================ */

(() => {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ============================================================
  // THEME TOGGLE
  // ============================================================
  function initTheme() {
    const btn = $('#theme-toggle');
    if (!btn) return;
    const html = document.documentElement;

    const sync = () => {
      const isDark = html.getAttribute('data-theme') !== 'light';
      btn.textContent = isDark ? '[DARK]' : '[LIGHT]';
      btn.setAttribute('aria-pressed', String(!isDark));
      btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    };

    sync();

    btn.addEventListener('click', () => {
      const next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      html.setAttribute('data-theme', next);
      try {
        localStorage.setItem('theme', next);
      } catch (_e) {
        /* private mode / disabled storage — ignore */
      }
      sync();
      // Keep Remark42 in sync if already loaded
      const remark = /** @type {{ changeTheme?: (t: string) => void } | undefined} */ (
        /** @type {any} */ (window).REMARK42
      );
      if (remark && typeof remark.changeTheme === 'function') {
        try {
          remark.changeTheme(next);
        } catch (_e) {
          /* ignore */
        }
      }
    });
  }

  // ============================================================
  // LIVE CLOCK
  // ============================================================
  function initClock() {
    const el = $('#site-clock');
    if (!el) return;
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
      const d = new Date();
      el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  // ============================================================
  // READING PROGRESS (single-post only)
  // ============================================================
  function initProgress() {
    if (document.body.dataset.page !== 'post') return;
    const wrap = $('#reading-progress');
    if (!wrap) return;

    const cellsEl = $('.progress-cells', wrap);
    const pctEl = $('.progress-pct', wrap);
    const CELLS = 36;

    // Build cells once
    if (cellsEl && !cellsEl.children.length) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < CELLS; i++) {
        const s = document.createElement('span');
        s.textContent = '.';
        frag.appendChild(s);
      }
      cellsEl.appendChild(frag);
    }
    const cells = cellsEl ? Array.from(cellsEl.children) : [];

    let raf = 0;
    const update = () => {
      raf = 0;
      const total = document.documentElement.scrollHeight - window.innerHeight;
      const progress = total > 0 ? Math.min(1, Math.max(0, window.scrollY / total)) : 0;
      const filled = Math.floor(progress * CELLS);
      for (let i = 0; i < cells.length; i++) {
        const on = i < filled;
        // i is a bounded integer index — security/detect-object-injection false positive
        // eslint-disable-next-line security/detect-object-injection
        const cell = cells[i];
        if (!cell) continue;
        if (on) {
          cell.classList.add('on');
          cell.textContent = ':';
        } else {
          cell.classList.remove('on');
          cell.textContent = '.';
        }
      }
      if (pctEl) pctEl.textContent = Math.round(progress * 100) + '%';
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  // ============================================================
  // Cmd+K COMMAND PALETTE
  // ============================================================
  function initPalette() {
    const overlay = $('#cmdk');
    if (!overlay) return;
    const dialog = $('.cmdk', overlay);
    const input = $('.cmdk-input input', overlay);
    const list = $('.cmdk-list', overlay);
    const trigger = $('#search-toggle');

    let posts = null;
    let activeIndex = 0;
    let prevFocus = null;

    const STATIC = [
      { type: 'page', title: 'Writing — home', url: '/', meta: 'G H' },
      { type: 'page', title: 'About', url: '/about/', meta: 'G A' },
    ];

    async function loadIndex() {
      if (posts) return posts;
      try {
        const res = await fetch('/index.json', { cache: 'no-store' });
        if (!res.ok) throw new Error('index.json ' + res.status);
        const data = await res.json();
        posts = Array.isArray(data) ? data : [];
      } catch (e) {
        console.warn('Search index failed', e);
        posts = [];
      }
      return posts;
    }

    function score(q, item) {
      if (!q) return 0;
      const ql = q.toLowerCase();
      const t = (item.title || '').toLowerCase();
      const d = (item.description || item.content || item.summary || '').toLowerCase();
      const tags = (item.tags || []).join(' ').toLowerCase();
      if (t.startsWith(ql)) return 100;
      if (t.includes(ql)) return 60;
      if (tags.includes(ql)) return 30;
      if (d.includes(ql)) return 10;
      return 0;
    }

    function render() {
      if (!list) return;
      const q = input.value.trim();
      list.innerHTML = '';

      // Jump-to section
      const jumpSec = document.createElement('div');
      jumpSec.className = 'cmdk-section';
      jumpSec.textContent = 'JUMP TO';
      list.appendChild(jumpSec);
      STATIC.forEach((it) => list.appendChild(makeRow(it)));

      // Posts section
      const items = (posts || []).slice();
      let results = items;
      if (q) {
        results = items
          .map((it) => ({ it, s: score(q, it) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.it);
      }
      results = results.slice(0, 8);

      const postSec = document.createElement('div');
      postSec.className = 'cmdk-section';
      postSec.textContent = 'POSTS — ' + results.length;
      list.appendChild(postSec);

      if (!results.length) {
        const empty = document.createElement('div');
        empty.className = 'cmdk-empty';
        empty.textContent = q ? 'no matches.' : 'start typing…';
        list.appendChild(empty);
      } else {
        results.forEach((it) =>
          list.appendChild(
            makeRow({ type: 'post', title: it.title, url: it.url, meta: it.date || '' }),
          ),
        );
      }
      activeIndex = 0;
      highlight();
    }

    function makeRow(it) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cmdk-row';
      row.dataset.url = it.url;
      row.innerHTML =
        '<span class="cmdk-row-l"><span class="cmdk-row-icon">' +
        (it.type === 'page' ? '›' : '▸') +
        '</span><span class="cmdk-row-title"></span></span>' +
        '<span class="cmdk-row-meta"></span>';
      row.querySelector('.cmdk-row-title').textContent = it.title;
      row.querySelector('.cmdk-row-meta').textContent = it.meta || '';
      row.addEventListener('click', () => activate(row));
      row.addEventListener('mousemove', () => {
        const rows = $$('.cmdk-row', list);
        activeIndex = rows.indexOf(row);
        highlight();
      });
      return row;
    }

    function highlight() {
      const rows = $$('.cmdk-row', list);
      rows.forEach((r, i) => r.classList.toggle('is-active', i === activeIndex));
      // activeIndex is internally maintained as a bounded array index
      // eslint-disable-next-line security/detect-object-injection
      const active = rows[activeIndex];
      if (active && typeof (/** @type {any} */ (active).scrollIntoView) === 'function') {
        /** @type {HTMLElement} */ (active).scrollIntoView({ block: 'nearest' });
      }
    }

    function activate(row) {
      const url = row && row.dataset.url;
      if (url) {
        close();
        window.location.href = url;
      }
    }

    function open() {
      prevFocus = document.activeElement;
      overlay.hidden = false;
      overlay.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      input.value = '';
      loadIndex()
        .then(render)
        .catch((err) => console.warn('palette load failed', err));
      input.focus({ preventScroll: true });
    }

    function close() {
      overlay.hidden = true;
      overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      const prev = /** @type {HTMLElement | null} */ (prevFocus);
      if (prev && typeof prev.focus === 'function') {
        try {
          prev.focus();
        } catch (_e) {
          /* ignore */
        }
      }
    }

    function onKey(e) {
      const isOpen = !overlay.hidden;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (isOpen) close();
        else open();
        return;
      }
      if (!isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const rows = $$('.cmdk-row', list);
        if (rows.length) {
          activeIndex = (activeIndex + 1) % rows.length;
          highlight();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = $$('.cmdk-row', list);
        if (rows.length) {
          activeIndex = (activeIndex - 1 + rows.length) % rows.length;
          highlight();
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const rows = $$('.cmdk-row', list);
        // activeIndex is a bounded internal index
        // eslint-disable-next-line security/detect-object-injection
        activate(rows[activeIndex]);
        return;
      }
      if (e.key === 'Tab') {
        const focusables = overlay.querySelectorAll(
          'input, button, [tabindex]:not([tabindex="-1"])',
        );
        const visible = Array.from(focusables).filter(
          (el) => !el.disabled && el.offsetParent !== null,
        );
        if (visible.length === 0) {
          e.preventDefault();
          return;
        }
        const first = visible[0];
        const last = visible[visible.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    if (trigger) trigger.addEventListener('click', open);
    input.addEventListener('input', render);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    if (dialog) dialog.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', onKey);

    // Initial render so the dialog has content if opened quickly
    loadIndex()
      .then(render)
      .catch((err) => console.warn('palette load failed', err));
  }

  // ============================================================
  // LAZY EMBED HELPER (Phase 7 stub — minimal but functional)
  // ============================================================
  /**
   * @param {HTMLElement | Element | null} elArg - Placeholder element to hydrate into an embed.
   */
  function loadEmbed(elArg) {
    const el = /** @type {HTMLElement | null} */ (elArg);
    if (!el || el.dataset.loaded === '1') return;
    el.dataset.loaded = '1';
    const html = el.dataset.embedHtml;
    if (html) {
      el.innerHTML = html;
      return;
    }
    const src = el.dataset.src;
    if (src) {
      const iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.loading = 'lazy';
      iframe.setAttribute('title', el.dataset.title || 'Embedded content');
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('allow', el.dataset.allow || '');
      el.replaceChildren(iframe);
    }
  }
  // Expose globally so future phases / inline scripts can call it
  const w = /** @type {any} */ (window);
  w.TE = w.TE || {};
  w.TE.loadEmbed = loadEmbed;

  function initEmbedPlaceholders() {
    document.addEventListener('click', (e) => {
      const target = /** @type {Element | null} */ (e.target);
      const el = target && target.closest ? target.closest('.embed-placeholder') : null;
      if (!el) return;
      e.preventDefault();
      loadEmbed(el);
    });
  }

  // ============================================================
  // BOOT
  // ============================================================
  function boot() {
    initTheme();
    initClock();
    initProgress();
    initPalette();
    initEmbedPlaceholders();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
