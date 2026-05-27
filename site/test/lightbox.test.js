// @ts-nocheck
/**
 * Vitest unit tests for site/static/js/lightbox.js (Phase 6).
 *
 * The script is an IIFE that self-installs a delegated click listener
 * on `document`. Re-eval'ing it would double-bind that listener, so we
 * boot it exactly once per test file via `beforeAll` and reset DOM +
 * exposed state between cases.
 *
 * Coverage:
 *   - clicking [data-lightbox-src] opens the dialog with role=dialog
 *     and aria-modal=true
 *   - clicking the close button hides the dialog
 *   - ESC closes the dialog and restores focus to the trigger
 *   - clicking the backdrop closes the dialog
 *   - gallery navigation: clicking inside [data-gallery] uses sibling
 *     URLs for arrow-key stepping
 *   - lightbox does not intercept clicks inside [data-embed-href]
 *     (Phase 7 forward-compat)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Phase 11: canonical source path moved from static/ to assets/ so Hugo
// can fingerprint + SRI through resources.Fingerprint. Test reads the
// canonical file.
const LIGHTBOX_JS = readFileSync(join(__dirname, '..', 'assets', 'js', 'lightbox.js'), 'utf-8');

beforeAll(() => {
  // Run the IIFE once for the file. The script installs a single
  // delegated click listener on `document`, so a per-test boot would
  // multi-bind and break cleanup ordering.

  new Function(LIGHTBOX_JS)();
});

function fireClick(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function resetDom() {
  // Make sure nothing carries over between tests. The lightbox roots
  // its modal at document.body, so an innerHTML wipe also removes the
  // overlay. We also clear the open-state attribute on <html>.
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-lightbox-open');
}

describe('lightbox single-image flow', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('opens dialog with role=dialog aria-modal=true on click', () => {
    document.body.innerHTML = `
      <a id="trigger" href="/images/full.png" data-lightbox-src="/images/full.png">
        <img src="/images/thumb.png" alt="thumb" />
      </a>
    `;
    const trigger = document.getElementById('trigger');
    fireClick(trigger);

    const dialog = document.getElementById('te-lightbox-root');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.hidden).toBe(false);
    expect(document.documentElement.getAttribute('data-lightbox-open')).toBe('true');
    const img = dialog.querySelector('.lightbox-img');
    expect(img.getAttribute('src')).toBe('/images/full.png');
  });

  it('Escape closes the dialog and restores focus to the trigger', () => {
    document.body.innerHTML = `
      <a id="trigger" href="/x.png" data-lightbox-src="/x.png">
        <img src="/t.png" alt="" />
      </a>
    `;
    const trigger = document.getElementById('trigger');
    // Set initial focus so we can verify it gets restored.
    trigger.focus();
    fireClick(trigger);
    const dialog = document.getElementById('te-lightbox-root');
    expect(dialog.hidden).toBe(false);

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(dialog.hidden).toBe(true);
    expect(document.documentElement.getAttribute('data-lightbox-open')).toBeNull();
    // Focus restored to the trigger.
    expect(document.activeElement).toBe(trigger);
  });

  it('clicking the backdrop closes the dialog', () => {
    document.body.innerHTML = `
      <a id="t" href="/y.png" data-lightbox-src="/y.png"><img src="/y.png" /></a>
    `;
    fireClick(document.getElementById('t'));
    const dialog = document.getElementById('te-lightbox-root');
    expect(dialog).toBeTruthy();
    expect(dialog.hidden).toBe(false);
    fireClick(dialog.querySelector('.lightbox-backdrop'));
    expect(dialog.hidden).toBe(true);
  });

  it('close button closes the dialog', () => {
    document.body.innerHTML = `
      <a id="t" href="/y.png" data-lightbox-src="/y.png"><img src="/y.png" /></a>
    `;
    fireClick(document.getElementById('t'));
    const dialog = document.getElementById('te-lightbox-root');
    expect(dialog).toBeTruthy();
    fireClick(dialog.querySelector('.lightbox-close'));
    expect(dialog.hidden).toBe(true);
  });
});

describe('lightbox gallery navigation', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('collects gallery siblings + arrow-key cycles through them', () => {
    document.body.innerHTML = `
      <div data-gallery="post-foo">
        <a id="g0" href="/a.png" data-gallery-href="/a.png"><img src="/a.png" /></a>
        <a id="g1" href="/b.png" data-gallery-href="/b.png"><img src="/b.png" /></a>
        <a id="g2" href="/c.png" data-gallery-href="/c.png"><img src="/c.png" /></a>
      </div>
    `;
    fireClick(document.getElementById('g1'));
    const dialog = document.getElementById('te-lightbox-root');
    expect(dialog).toBeTruthy();
    const img = dialog.querySelector('.lightbox-img');
    expect(img.getAttribute('src')).toBe('/b.png');
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(img.getAttribute('src')).toBe('/c.png');
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    // Wraps to first.
    expect(img.getAttribute('src')).toBe('/a.png');
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    // Wraps backward to last.
    expect(img.getAttribute('src')).toBe('/c.png');
  });
});

describe('lightbox vs embeds (Phase 7 forward-compat)', () => {
  beforeEach(() => resetDom());
  afterEach(() => resetDom());

  it('does not intercept clicks inside [data-embed-href]', () => {
    document.body.innerHTML = `
      <div data-embed-href="https://example.com/v">
        <a id="inner" href="/should-not-fire.png" data-lightbox-src="/should-not-fire.png">
          <img src="/thumb.png" />
        </a>
      </div>
    `;
    fireClick(document.getElementById('inner'));
    expect(document.getElementById('te-lightbox-root')).toBeNull();
  });
});
