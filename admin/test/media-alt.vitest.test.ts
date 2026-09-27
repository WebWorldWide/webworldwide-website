// @ts-nocheck
/**
 * Vitest unit tests for the media library's alt-text surface
 * (admin/public/js/media.js):
 *   - TE.media.needsAlt — the badge/prompt predicate
 *   - the "No alt" grid badge on images without usable alt text
 *   - the drawer's alt editor saving via PATCH /api/media/:id
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMON_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'common.js'), 'utf-8');
const MEDIA_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'media.js'), 'utf-8');

const ITEMS = [
  {
    id: 'has-alt',
    filename: 'aaa.webp',
    original_name: 'sunrise.webp',
    mime_type: 'image/webp',
    type: 'image',
    url: '/images/2026/01/aaa.webp',
    size: 1000,
    status: 'ready',
    uploaded_at: 1767225600000,
    alt_text: 'A sunrise over the bay',
    hash_prefix: 'abcd1234',
    conversions: {},
  },
  {
    id: 'no-alt',
    filename: 'bbb.webp',
    original_name: 'image-19.webp',
    mime_type: 'image/webp',
    type: 'image',
    url: '/images/2026/01/bbb.webp',
    size: 2000,
    status: 'ready',
    uploaded_at: 1767225600000,
    alt_text: null,
    hash_prefix: 'beef5678',
    conversions: {},
  },
];

function makeMediaDom() {
  document.body.innerHTML = `
    <div id="toast-root"></div>
    <div id="view-dashboard"></div>
    <div id="view-media" hidden>
      <div id="media-library-dropzone"></div>
      <input id="media-search" />
      <select id="media-sort"><option value="date">date</option></select>
      <div id="media-chips"></div>
      <div id="media-grid"></div>
      <div id="media-empty" hidden></div>
      <input id="media-select-all" type="checkbox" />
      <div id="media-bulk-bar" hidden><span id="media-bulk-count"></span><button id="media-bulk-delete"></button></div>
      <aside id="media-drawer" aria-hidden="true"><button id="media-drawer-close"></button><div id="media-drawer-body"></div></aside>
    </div>
    <span id="crumb-section"></span>
  `;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/index.html#media');
  makeMediaDom();
  delete window.TE;
  delete window.__teBodyDropzoneInstalled;

  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    if (u.startsWith('/api/media/') && opts.method === 'PATCH') {
      const id = decodeURIComponent(u.split('/').pop());
      const body = JSON.parse(opts.body);
      const item = ITEMS.find((i) => i.id === id);
      return new Response(JSON.stringify({ ...item, alt_text: body.alt_text || null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (/\/api\/media\/[^/?]+$/.test(u)) {
      const id = decodeURIComponent(u.split('/').pop());
      const item = ITEMS.find((i) => i.id === id);
      return new Response(JSON.stringify({ ...item, usage: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.startsWith('/api/media')) {
      return new Response(
        JSON.stringify({ items: ITEMS, total: ITEMS.length, page: 1, limit: 50 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  new Function(COMMON_JS)();
  new Function(MEDIA_JS)();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Let the async reload()/openDrawer() settle. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('TE.media.needsAlt', () => {
  it('flags empty, filename-ish, and name-echo alts; passes real alt text', () => {
    const needsAlt = window.TE.media.needsAlt;
    expect(needsAlt({ alt_text: null })).toBe(true);
    expect(needsAlt({ alt_text: '   ' })).toBe(true);
    expect(needsAlt({ alt_text: 'image-19.webp' })).toBe(true);
    expect(needsAlt({ alt_text: 'My Photo (1).JPG' })).toBe(true);
    expect(needsAlt({ alt_text: 'whatever', filename: 'whatever' })).toBe(true);
    expect(needsAlt({ alt_text: 'A sunrise over the bay' })).toBe(false);
  });
});

describe('library grid', () => {
  it('badges images without usable alt text', async () => {
    await flush();
    const grid = document.getElementById('media-grid');
    const cards = grid.querySelectorAll('.te-media-card');
    expect(cards.length).toBe(2);
    const withAlt = grid.querySelector('[data-id="has-alt"]');
    const withoutAlt = grid.querySelector('[data-id="no-alt"]');
    expect(withAlt.querySelector('.te-media-status.no-alt')).toBeNull();
    expect(withoutAlt.querySelector('.te-media-status.no-alt')).not.toBeNull();
  });
});

describe('drawer alt editor', () => {
  it('renders the textarea with the stored alt and PATCHes on save', async () => {
    await flush();
    document.querySelector('[data-id="has-alt"] [data-open-id]').click();
    await flush();

    const input = document.getElementById('drawer-alt-input');
    expect(input).not.toBeNull();
    expect(input.value).toBe('A sunrise over the bay');

    input.value = 'A golden sunrise over the bay';
    document.querySelector('[data-drawer-save]').click();
    await flush();

    const patchCall = globalThis.fetch.mock.calls.find(([, o]) => o && o.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    expect(patchCall[0]).toBe('/api/media/has-alt');
    expect(JSON.parse(patchCall[1].body)).toEqual({ alt_text: 'A golden sunrise over the bay' });
  });

  it('shows the warning hint when the image needs alt text', async () => {
    await flush();
    document.querySelector('[data-id="no-alt"] [data-open-id]').click();
    await flush();
    const hint = document.querySelector('.te-drawer-alt-hint');
    expect(hint.textContent).toMatch(/screen readers/);
  });
});
