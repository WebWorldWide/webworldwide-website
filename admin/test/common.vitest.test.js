// @ts-nocheck
/**
 * Vitest unit tests for admin/public/js/common.js.
 *
 * common.js is an IIFE that installs window.TE helpers (toast, escape,
 * fetchJSON, modal open/close), wires up the theme toggle, and registers
 * the Cmd+K palette. We load the script into jsdom and drive it via
 * events.
 *
 * Strategy:
 *   1. Build the minimal HTML the script expects (#btn-theme, toast root).
 *   2. Read the script as a string and eval it inside the jsdom window.
 *   3. Assert observable DOM/window state.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMON_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'common.js'), 'utf-8');

function bootCommon() {
  new Function(COMMON_JS)();
}

function makeShellDom() {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.body.innerHTML = `
    <button type="button" id="btn-theme" aria-pressed="false" aria-label="Toggle theme">
      <span id="btn-theme-glyph">☾</span>
    </button>
    <div id="toast-root" role="status" aria-live="polite" aria-atomic="false"></div>
    <div class="modal" id="m1" role="dialog" aria-modal="true">
      <div class="modal-card">
        <button type="button" data-modal-close="m1">Close</button>
        <input id="m1-input" />
      </div>
    </div>
  `;
}

beforeEach(() => {
  window.localStorage.clear();
  makeShellDom();
  // Allow re-boot between tests. Each test calls bootCommon() so that
  // the IIFE re-initialises against the fresh DOM (theme glyph, toast
  // root, etc.). Duplicate document-level keydown listeners do stack,
  // but tests that exercise the Cmd+K palette explicitly call
  // TE.__test helpers directly to avoid order-dependent behavior.
  delete window.TE;
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('#cmdk').forEach((n) => n.remove());
});

describe('TE.escape', () => {
  it('replaces &, <, >, ", and \'', () => {
    bootCommon();
    expect(window.TE.escape('<b class="x">a&b\'c</b>')).toBe(
      '&lt;b class=&quot;x&quot;&gt;a&amp;b&#39;c&lt;/b&gt;',
    );
  });

  it('treats null/undefined as empty', () => {
    bootCommon();
    expect(window.TE.escape(null)).toBe('');
    expect(window.TE.escape(undefined)).toBe('');
  });
});

describe('TE.fmtBytes', () => {
  it('renders zero and small numbers correctly', () => {
    bootCommon();
    expect(window.TE.fmtBytes(0)).toBe('0 B');
    expect(window.TE.fmtBytes(900)).toBe('900 B');
  });

  it('scales up through KB, MB, GB', () => {
    bootCommon();
    expect(window.TE.fmtBytes(1024)).toMatch(/^1 KB$/);
    expect(window.TE.fmtBytes(1024 * 1024)).toMatch(/^1 MB$/);
    expect(window.TE.fmtBytes(1024 * 1024 * 1024)).toMatch(/^1 GB$/);
  });
});

describe('TE.fmtUptime', () => {
  it('returns em-dash for nullish/NaN', () => {
    bootCommon();
    expect(window.TE.fmtUptime(null)).toBe('—');
    expect(window.TE.fmtUptime(undefined)).toBe('—');
    expect(window.TE.fmtUptime(NaN)).toBe('—');
  });

  it('formats minutes, hours, days', () => {
    bootCommon();
    expect(window.TE.fmtUptime(45)).toBe('0m');
    expect(window.TE.fmtUptime(60 * 5)).toBe('5m');
    expect(window.TE.fmtUptime(60 * 60 * 4 + 60 * 11)).toBe('4h 11m');
    expect(window.TE.fmtUptime(86400 * 2 + 3600 * 3)).toBe('2d 3h');
  });
});

describe('theme toggle', () => {
  it('flips data-theme, localStorage, aria-pressed, and glyph on click', () => {
    bootCommon();
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    btn.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('theme')).toBe('light');
    const glyph = document.getElementById('btn-theme-glyph');
    expect(glyph?.textContent).toBe('☀');

    btn.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(glyph?.textContent).toBe('☾');
  });

  it('respects a pre-saved theme on boot', () => {
    window.localStorage.setItem('theme', 'light');
    bootCommon();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('modals', () => {
  it('openModal adds .open, focuses an input, and closeModal clears it', () => {
    bootCommon();
    window.TE.openModal('m1');
    const m = document.getElementById('m1');
    expect(m?.classList.contains('open')).toBe(true);
    expect(document.activeElement?.id).toBe('m1-input');
    window.TE.closeModal('m1');
    expect(m?.classList.contains('open')).toBe(false);
    expect(m?.getAttribute('aria-hidden')).toBe('true');
  });

  it('[data-modal-close] click closes the modal', () => {
    bootCommon();
    window.TE.openModal('m1');
    const closer = /** @type {HTMLButtonElement} */ (
      document.querySelector('[data-modal-close="m1"]')
    );
    closer.click();
    expect(document.getElementById('m1')?.classList.contains('open')).toBe(false);
  });

  it('Escape closes the top-most open modal', () => {
    bootCommon();
    window.TE.openModal('m1');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('m1')?.classList.contains('open')).toBe(false);
  });
});

describe('toasts', () => {
  it('appends a toast element with the message', () => {
    bootCommon();
    window.TE.toast('Saved!');
    const t = document.querySelector('#toast-root .toast');
    expect(t).not.toBeNull();
    expect(t?.textContent).toBe('Saved!');
  });

  it('an error toast carries role="alert"', () => {
    bootCommon();
    window.TE.toast('Boom', 'error');
    const t = document.querySelector('#toast-root .toast.error');
    expect(t?.getAttribute('role')).toBe('alert');
  });
});

describe('Cmd+K palette', () => {
  // We call openPalette()/closePalette() directly through the TE.__test
  // hooks instead of dispatching synthetic keydown events. The IIFE
  // registers listeners on `document` and (deliberately) doesn't
  // de-dup across re-boots, so synthetic keys would fire N times after
  // N tests. The hooks let us assert the open/close mechanics
  // independently of the keystroke plumbing.
  it('opens and closes', () => {
    bootCommon();
    window.TE.__test.openPalette();
    const wrap = document.getElementById('cmdk');
    expect(wrap).not.toBeNull();
    expect(wrap?.hidden).toBe(false);

    window.TE.__test.closePalette();
    expect(wrap?.hidden).toBe(true);
  });

  it('filters commands by query', () => {
    bootCommon();
    window.TE.__test.openPalette();
    const input = /** @type {HTMLInputElement} */ (document.getElementById('cmdk-input'));
    input.value = 'sign out';
    window.TE.__test.renderPalette();

    const items = document.querySelectorAll('#cmdk-list li');
    // The static palette has "Sign out" among its commands.
    const labels = Array.from(items).map((li) =>
      (li.querySelector('.cmdk-l')?.textContent || '').toLowerCase(),
    );
    expect(labels.some((l) => l.includes('sign out'))).toBe(true);
  });
});
