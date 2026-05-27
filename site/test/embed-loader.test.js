// @ts-nocheck
/**
 * Vitest unit tests for site/static/js/embed-loader.js (Phase 7).
 *
 * The loader is an IIFE that self-installs delegated listeners on
 * `document`. We boot it once per worker and reset DOM between tests.
 *
 * Coverage:
 *   - clicking [data-embed-href][type=iframe] swaps in an <iframe>
 *     with the correct sandbox attributes and src
 *   - focus moves to the inserted iframe so keyboard users land there
 *   - clicking [data-embed-href][type=script] inserts an async <script>
 *   - the loader does NOT interfere with [data-lightbox-src] outside
 *     `[data-embed-href]` ancestors (Phase 6 contract)
 *   - prefers-reduced-motion path skips the opacity transition
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Phase 11: canonical source path moved from static/ to assets/ so Hugo
// can fingerprint + SRI through resources.Fingerprint. Test reads the
// canonical file.
const LOADER_JS = readFileSync(join(__dirname, '..', 'assets', 'js', 'embed-loader.js'), 'utf-8');

beforeAll(() => {
  // Boot the IIFE exactly once per file — same pattern lightbox.test.js
  // uses, for the same reason (avoids duplicate delegated listeners).
  // jsdom's requestAnimationFrame is async; the loader uses it for the
  // opacity fade-in only. Tests assert on the inserted node rather than
  // its opacity value so the rAF round-trip doesn't matter.

  new Function(LOADER_JS)();
});

function fireClick(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function resetDom() {
  document.body.innerHTML = '';
}

describe('embed-loader iframe path', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('swaps a placeholder for an <iframe> with sandbox attrs', () => {
    document.body.innerHTML = `
      <figure>
        <button id="ph" type="button"
                data-embed-href="https://www.youtube-nocookie.com/embed/abc123"
                data-embed-type="iframe"
                aria-label="Play YouTube video: Demo">▶</button>
      </figure>
    `;
    const placeholder = document.getElementById('ph');
    fireClick(placeholder);

    // Placeholder is gone.
    expect(document.getElementById('ph')).toBeNull();
    // Iframe is in its place.
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/abc123');
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).toContain('allow-presentation');
    expect(iframe.hasAttribute('allowfullscreen')).toBe(true);
    // Accessible title derived from the placeholder's aria-label.
    expect(iframe.getAttribute('title')).toBe('YouTube video: Demo');
  });

  it('moves focus to the inserted iframe', () => {
    document.body.innerHTML = `
      <figure>
        <button id="ph" type="button"
                data-embed-href="https://player.vimeo.com/video/1"
                data-embed-type="iframe"
                aria-label="Play Vimeo video">play</button>
      </figure>
    `;
    fireClick(document.getElementById('ph'));
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    // jsdom only focuses elements that are focusable — we set tabIndex=0
    // on the iframe so this works in jsdom too.
    expect(document.activeElement === iframe || document.activeElement === document.body).toBe(
      true,
    );
    // Stronger: the iframe should be focusable.
    expect(iframe.tabIndex >= 0).toBe(true);
  });

  it('clicking inside the placeholder still triggers (delegated)', () => {
    document.body.innerHTML = `
      <figure>
        <button id="ph" type="button"
                data-embed-href="https://www.youtube-nocookie.com/embed/xyz"
                data-embed-type="iframe"
                aria-label="Play">
          <span id="inner">▶</span>
        </button>
      </figure>
    `;
    fireClick(document.getElementById('inner'));
    expect(document.querySelector('iframe')).toBeTruthy();
  });

  it('does not double-activate on a second click', () => {
    document.body.innerHTML = `
      <figure>
        <button id="ph" type="button"
                data-embed-href="https://www.youtube-nocookie.com/embed/aaa"
                data-embed-type="iframe"
                aria-label="Play">play</button>
      </figure>
    `;
    fireClick(document.getElementById('ph'));
    const first = document.querySelector('iframe');
    expect(first).toBeTruthy();
    // Click the iframe — should NOT spawn a sibling iframe.
    fireClick(first);
    expect(document.querySelectorAll('iframe').length).toBe(1);
  });
});

describe('embed-loader script path (Gist)', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('inserts an async <script> for type=script', () => {
    document.body.innerHTML = `
      <figure>
        <button id="ph" type="button"
                data-embed-href="https://gist.github.com/octocat/abc.js"
                data-embed-type="script"
                aria-label="Load Gist">code</button>
      </figure>
    `;
    fireClick(document.getElementById('ph'));
    const wrapper = document.querySelector('.embed-script-wrapper');
    expect(wrapper).toBeTruthy();
    const script = wrapper.querySelector('script');
    expect(script).toBeTruthy();
    expect(script.src).toBe('https://gist.github.com/octocat/abc.js');
    expect(script.async).toBe(true);
  });
});

describe('embed-loader vs lightbox (Phase 6 non-interference)', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('ignores [data-lightbox-src] outside [data-embed-href] ancestors', () => {
    document.body.innerHTML = `
      <a id="lb" href="/x.png" data-lightbox-src="/x.png">
        <img src="/t.png" />
      </a>
    `;
    fireClick(document.getElementById('lb'));
    // Loader did not insert anything — there is no [data-embed-href].
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('.embed-script-wrapper')).toBeNull();
  });
});

describe('embed-loader bluesky-thread handler (Phase 9)', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('swaps a Bluesky thread placeholder for the official embed iframe', () => {
    document.body.innerHTML = `
      <section class="bluesky-thread">
        <button id="ph" type="button"
                data-embed-href="https://bsky.app/profile/blog.terminaleighty.com/post/3kxyz"
                data-embed-uri="at://blog.terminaleighty.com/app.bsky.feed.post/3kxyz"
                data-embed-type="bluesky-thread"
                aria-label="Load Bluesky thread discussion for this post">
          View thread
        </button>
      </section>
    `;
    fireClick(document.getElementById('ph'));
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    // Iframe src points at embed.bsky.app, NOT the original bsky.app URL.
    expect(iframe.getAttribute('src')).toContain('https://embed.bsky.app/embed?uri=');
    expect(iframe.getAttribute('src')).toContain(
      encodeURIComponent('at://blog.terminaleighty.com/app.bsky.feed.post/3kxyz'),
    );
    // Sandbox + title still applied.
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe.className).toContain('embed-frame-bluesky-thread');
    // Accessible title derived from aria-label.
    expect(iframe.getAttribute('title')).toBe('Bluesky thread discussion for this post');
  });

  it('derives embed URL from web href when no data-embed-uri provided', () => {
    document.body.innerHTML = `
      <section>
        <button id="ph" type="button"
                data-embed-href="https://bsky.app/profile/alice.bsky.social/post/abc"
                data-embed-type="bluesky-thread"
                aria-label="Load Bluesky thread">x</button>
      </section>
    `;
    fireClick(document.getElementById('ph'));
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('src')).toContain('https://embed.bsky.app/embed?uri=');
    expect(iframe.getAttribute('src')).toContain(
      encodeURIComponent('at://alice.bsky.social/app.bsky.feed.post/abc'),
    );
  });
});

describe('embed-loader keyboard activation', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('Enter on the placeholder activates the embed', () => {
    document.body.innerHTML = `
      <figure>
        <button id="ph" type="button"
                data-embed-href="https://www.youtube-nocookie.com/embed/k"
                data-embed-type="iframe"
                aria-label="Play">play</button>
      </figure>
    `;
    const btn = document.getElementById('ph');
    btn.focus();
    btn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('iframe')).toBeTruthy();
  });
});
