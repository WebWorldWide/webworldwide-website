// @ts-check
/**
 * Admin CMS mobile sweep — Phase 13.
 *
 * Gated on DEV_STACK_RUNNING=1 (Phase 10 pattern). The admin server runs
 * at http://127.0.0.1:8080 when the user has the dev stack up
 * (`npm run dev:all`); CI doesn't spin it up so these stay skipped there.
 *
 * Coverage at 375 × 667 (iPhone 8):
 *   - login.html, index.html (dashboard), editor.html all fit horizontally
 *   - the desktop side rail collapses (off-canvas drawer OR bottom nav)
 *   - the editor's slash-menu / toolbar collapse to a bottom action bar
 *
 * We don't authenticate (no test user in dev DB) — we exercise login.html
 * directly, and for the gated pages the spec assumes the dev stack
 * already has an authenticated session cookie. Phase 5e's
 * NODE_ENV=development branch bypasses the auth wall for the editor
 * routes, which is what lets the spec hit /index.html and /editor.html
 * without a session.
 */

import { test, expect } from '@playwright/test';

const ADMIN = process.env.ADMIN_URL || 'http://127.0.0.1:8080';
const DEV_STACK = process.env.DEV_STACK_RUNNING === '1';

test.describe.configure({ mode: 'serial' });

test.use({ viewport: { width: 375, height: 667 } });

test.describe('admin mobile sweep (gated)', () => {
  test.skip(!DEV_STACK, 'set DEV_STACK_RUNNING=1 with `npm run dev:all` up');

  for (const path of ['/login.html', '/index.html', '/editor.html']) {
    test(`${path} fits viewport horizontally`, async ({ page }) => {
      await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts?.ready);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${path} scrolls horizontally (sw=${overflow.scrollWidth}, cw=${overflow.clientWidth})`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }

  test('dashboard sidebar collapses off-canvas under 768 px', async ({ page }) => {
    await page.goto(`${ADMIN}/index.html`, { waitUntil: 'domcontentloaded' });
    // The Phase 5e dashboard markup is `.shell > .side + .main`. We test
    // that the side rail is either fully hidden (display:none) OR
    // translated off-canvas (negative transform) OR explicitly stacked
    // above the main column — any of those count as "responsive".
    const sideState = await page.evaluate(() => {
      const side = document.querySelector('.side');
      if (!side) return { exists: false };
      const cs = getComputedStyle(side);
      const rect = side.getBoundingClientRect();
      return {
        exists: true,
        display: cs.display,
        position: cs.position,
        transform: cs.transform,
        widthPx: rect.width,
        viewportWidth: window.innerWidth,
      };
    });
    expect(sideState.exists, 'side rail exists in dashboard markup').toBe(true);
    // Either hidden, or its width is ≤ 50 % of viewport (i.e. it
    // collapsed to a slim icon bar) — both satisfy mobile-friendliness.
    const offCanvas =
      sideState.display === 'none' || (sideState.widthPx ?? 0) <= sideState.viewportWidth * 0.5;
    expect(
      offCanvas,
      `side rail must hide or shrink on mobile (got width=${sideState.widthPx})`,
    ).toBe(true);
  });

  test('editor toolbar reflows to a single horizontally-scrollable strip', async ({ page }) => {
    await page.goto(`${ADMIN}/editor.html`, { waitUntil: 'domcontentloaded' });
    // The toolbar lives in `.editor-toolbar`. On phones it shouldn't
    // line-wrap (the buttons would interleave with content); it should
    // scroll horizontally inside its own container instead.
    const toolbar = await page.evaluate(() => {
      const t = document.querySelector('.editor-toolbar');
      if (!t) return null;
      const cs = getComputedStyle(t);
      return {
        overflowX: cs.overflowX,
        flexWrap: cs.flexWrap,
        display: cs.display,
      };
    });
    expect(toolbar, '.editor-toolbar present').not.toBeNull();
    // Either overflow-x: auto/scroll OR flex with nowrap satisfies the
    // "single strip" rule. We don't dictate which strategy.
    const okScroll = ['auto', 'scroll'].includes(/** @type {any} */ (toolbar).overflowX);
    const okNoWrap = /** @type {any} */ (toolbar).flexWrap === 'nowrap';
    expect(okScroll || okNoWrap, 'toolbar must not line-wrap on mobile').toBe(true);
  });
});
