// @ts-nocheck
/**
 * Vitest unit tests for the Homepage editor view
 * (admin/public/js/homepage.js):
 *   - the rail renders the five section cards in section_order
 *   - editing a field flips the dirty indicator to "Unsaved changes"
 *   - Save PATCHes the edited model to /api/settings/homepage and clears dirty
 *   - Discard restores the saved snapshot
 *   - the live preview re-renders edited hero words
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMON_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'common.js'), 'utf-8');
const HOMEPAGE_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'homepage.js'), 'utf-8');

const MODEL = {
  hero: { words: ['Web', 'World', 'Wide'], tagline: 'W · W · W' },
  apps: {
    items: [
      { name: 'FileID', status: 'live', link: 'https://fileid.app', icon: '/assets/fileid.png' },
      { name: 'Document Finder', status: 'soon', link: '', icon: '' },
    ],
  },
  videos: { episode: 'EP. 001', film_title: 'First video — coming soon' },
  socials: {
    order: [
      'youtube',
      'github',
      'twitter',
      'bluesky',
      'mastodon',
      'reddit',
      'instagram',
      'threads',
    ],
    hidden: ['threads'],
  },
  blog_cta: { kicker: 'Latest', title: 'The Web World Wide', title_accent: 'Blog', url: '/blog/' },
  sections: { hero: true, apps: true, videos: true, socials: true, blog_cta: true },
  section_order: ['hero', 'apps', 'videos', 'socials', 'blog_cta'],
};

function makeHomepageDom() {
  document.body.innerHTML = `
    <div id="toast-root"></div>
    <div id="view-homepage"><div id="homepage-root"></div></div>
  `;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/index.html#homepage');
  makeHomepageDom();
  delete window.TE;

  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    if (u === '/api/settings/homepage' && opts.method === 'PATCH') {
      // The real route normalizes + echoes the merged model; the editor
      // sends the FULL model, so echoing the body is contract-faithful.
      return new Response(opts.body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u === '/api/settings/homepage') {
      return new Response(JSON.stringify(MODEL), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u === '/api/publish' && opts.method === 'POST') {
      return new Response(JSON.stringify({ success: true, message: 'Pushed to origin/main.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  new Function(COMMON_JS)();
  new Function(HOMEPAGE_JS)();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Let init()'s async fetch + render settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Boot the view like the hash router does. */
async function boot() {
  window.TE.routes.homepage();
  await flush();
}

/**
 * Type into an input bound to a draft path and fire the input event.
 * @param path
 * @param value
 */
function type(path, value) {
  const input = document.querySelector(`[data-path="${path}"]`);
  expect(input).not.toBeNull();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

describe('rail', () => {
  it('renders the 5 section cards in section_order', async () => {
    await boot();
    const cards = document.querySelectorAll('#hp-rail-scroll .hp-sec');
    expect(cards.length).toBe(5);
    expect(Array.from(cards).map((c) => c.getAttribute('data-id'))).toEqual(MODEL.section_order);
  });

  it('flips the dirty indicator when the tagline is edited', async () => {
    await boot();
    expect(document.getElementById('hp-dirty-text').textContent).toBe('All changes saved');

    type('hero.tagline', 'Hello · Pi');

    const dirty = document.getElementById('hp-dirty');
    expect(dirty.classList.contains('unsaved')).toBe(true);
    expect(document.getElementById('hp-dirty-text').textContent).toBe('Unsaved changes');
    expect(document.getElementById('hp-save').disabled).toBe(false);
    expect(document.getElementById('hp-discard').disabled).toBe(false);
  });
});

describe('save / discard', () => {
  it('PATCHes the edited model on Save and clears the dirty state', async () => {
    await boot();
    type('hero.tagline', 'Hello · Pi');

    document.getElementById('hp-save').click();
    await flush();

    const patchCall = globalThis.fetch.mock.calls.find(([, o]) => o && o.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    expect(patchCall[0]).toBe('/api/settings/homepage');
    const body = JSON.parse(patchCall[1].body);
    expect(body.hero.tagline).toBe('Hello · Pi');
    expect(body.section_order).toEqual(MODEL.section_order);

    expect(document.getElementById('hp-dirty-text').textContent).toBe('All changes saved');
    expect(document.getElementById('hp-dirty').classList.contains('unsaved')).toBe(false);
    expect(document.getElementById('hp-save').disabled).toBe(true);
    // Saved to the Pi but not yet live — the publish hint is visible.
    expect(document.getElementById('hp-hint').hidden).toBe(false);
  });

  it('restores the original tagline on Discard', async () => {
    await boot();
    type('hero.tagline', 'Scratch that');
    expect(document.getElementById('hp-dirty').classList.contains('unsaved')).toBe(true);

    document.getElementById('hp-discard').click();
    await flush();

    // The rail re-renders on discard — re-query the input.
    const input = document.querySelector('[data-path="hero.tagline"]');
    expect(input.value).toBe(MODEL.hero.tagline);
    expect(document.getElementById('hp-dirty-text').textContent).toBe('All changes saved');
    expect(globalThis.fetch.mock.calls.find(([, o]) => o && o.method === 'PATCH')).toBeFalsy();
  });
});

describe('live preview', () => {
  it('re-renders the edited hero word without rebuilding the rail', async () => {
    await boot();
    expect(document.querySelector('#hp-canvas .pv-word').textContent).toBe('Web');

    const input = type('hero.words.0', 'Wob');

    // The preview rebuild trails typing by ~180ms (debounced — a full
    // innerHTML rebuild per keystroke is too heavy on a Pi).
    expect(document.querySelector('#hp-canvas .pv-word').textContent).toBe('Web');
    await new Promise((r) => setTimeout(r, 250));
    expect(document.querySelector('#hp-canvas .pv-word').textContent).toBe('Wob');
    // The input was not re-rendered out from under the typist.
    expect(document.querySelector('[data-path="hero.words.0"]')).toBe(input);
  });
});
