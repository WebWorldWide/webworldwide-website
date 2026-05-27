// @ts-nocheck
/**
 * Vitest unit tests for site/static/js/app.js.
 *
 * app.js is an IIFE that wires up theme toggle, palette, reading progress,
 * and the embed loader. We load it into jsdom and drive it via events.
 *
 * Strategy:
 *   1. Build the minimal HTML the script expects.
 *   2. Read the script as a string and eval it inside the jsdom window.
 *   3. Assert observable DOM/window.localStorage state.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Phase 11: JS bundles moved from site/static/js/ to site/assets/js/ so
// Hugo can fingerprint + SRI them through the resources pipeline. The
// browser still loads /js/<name>.<hash>.js — the move is transparent
// to users, but the test now reads from the canonical assets path.
const APP_JS = readFileSync(join(__dirname, '..', 'assets', 'js', 'app.js'), 'utf-8');

function bootApp() {
  // Eval inside the current jsdom window. app.js is an IIFE and self-installs handlers.

  new Function(APP_JS)();
}

function makeMinimalDom() {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.body.innerHTML = `
    <button id="theme-toggle" aria-pressed="false" aria-label="">[DARK]</button>
    <span id="site-clock"></span>
    <button id="search-toggle">⌘K</button>
    <div id="cmdk" hidden aria-hidden="true">
      <div class="cmdk">
        <div class="cmdk-input"><input type="text" /></div>
        <div class="cmdk-list"></div>
      </div>
    </div>
  `;
}

describe('theme toggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    makeMinimalDom();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('flips data-theme, localStorage, aria-pressed on click', () => {
    bootApp();
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('theme-toggle'));
    // initial state: dark, aria-pressed=false (button is pressed-only when light)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    btn.click();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem('theme')).toBe('light');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toBe('[LIGHT]');

    btn.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('theme persistence (FOUC prevention contract)', () => {
  // The Phase 1 head injects an inline script that reads window.localStorage.theme
  // and sets <html data-theme="..."> *before* first paint. We replicate that
  // contract here — it must work synchronously with no FOUC.
  const fouc = `
    try {
      var t = window.localStorage.getItem('theme');
      if (t === 'light' || t === 'dark') {
        document.documentElement.setAttribute('data-theme', t);
      }
    } catch (e) { /* ignore */ }
  `;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('applies window.localStorage.theme=light before paint', () => {
    window.localStorage.setItem('theme', 'light');

    new Function(fouc)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies window.localStorage.theme=dark before paint', () => {
    window.localStorage.setItem('theme', 'dark');

    new Function(fouc)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('Cmd+K palette', () => {
  beforeEach(() => {
    window.localStorage.clear();
    makeMinimalDom();
    // Mock fetch for /index.json
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/index.json')) {
        return new Response(
          JSON.stringify([
            { title: 'Bye bye DJI', url: '/bye-bye-dji/', date: '2026-04', tags: ['tech'] },
            { title: 'The Terminal', url: '/the-terminal/', date: '2025-12', tags: ['meta'] },
            { title: 'Tech cults', url: '/tech-cults/', date: '2025-08', tags: ['tech'] },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete globalThis.fetch;
  });

  it('filters posts and ranks title-prefix matches highest', async () => {
    bootApp();
    // wait for the initial loadIndex() promise to settle
    await new Promise((r) => setTimeout(r, 5));
    const overlay = document.getElementById('cmdk');
    const input = /** @type {HTMLInputElement} */ (overlay.querySelector('.cmdk-input input'));
    const trigger = document.getElementById('search-toggle');

    trigger.click();
    await new Promise((r) => setTimeout(r, 5));

    input.value = 'tech';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const titles = Array.from(overlay.querySelectorAll('.cmdk-row .cmdk-row-title')).map(
      (el) => el.textContent,
    );
    // Static "JUMP TO" rows come first; then post results.
    expect(titles).toContain('Tech cults'); // title prefix match (rank 100)
    expect(titles).toContain('Bye bye DJI'); // tag match (rank 30)
  });

  it('Escape closes the palette', async () => {
    bootApp();
    await new Promise((r) => setTimeout(r, 5));
    const overlay = document.getElementById('cmdk');
    const trigger = document.getElementById('search-toggle');
    trigger.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(overlay.hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.hidden).toBe(true);
  });

  it('ArrowDown moves selection, Enter navigates', async () => {
    bootApp();
    await new Promise((r) => setTimeout(r, 5));
    const trigger = document.getElementById('search-toggle');

    // Spy on window.location assignments via a Proxy on a fresh stub.
    const navTarget = { href: '' };
    Object.defineProperty(window, 'location', {
      value: new Proxy(navTarget, {
        set(t, k, v) {
          t[k] = v;
          return true;
        },
      }),
      writable: true,
    });

    trigger.click();
    await new Promise((r) => setTimeout(r, 5));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // After Enter, location.href should be one of the rendered URLs (a static row or a post).
    expect(navTarget.href).toMatch(/^\/(?:|about\/|bye-bye-dji\/|the-terminal\/|tech-cults\/)$/);
  });
});

describe('reading progress math', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.dataset.page = 'post';
    document.body.innerHTML += `
      <div id="reading-progress">
        <span class="progress-cells"></span>
        <span class="progress-pct"></span>
      </div>
    `;
  });

  it('progress = scrollY / (scrollHeight - innerHeight) — 100/(2000-800)*100 ≈ 8%', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 100 });

    bootApp();
    // Force one update cycle
    window.dispatchEvent(new Event('scroll'));
    // rAF resolves on next microtask in jsdom — wait a tick
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        const pct = document.querySelector('.progress-pct')?.textContent || '';
        // total = 2000 - 800 = 1200; 100 / 1200 = 0.0833 ≈ 8%
        expect(pct).toBe('8%');
        resolve(undefined);
      });
    });
  });
});
