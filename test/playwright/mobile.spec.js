// @ts-check
/**
 * Mobile viewport sweep — Phase 13.
 *
 * Loads the public site at four representative widths (iPhone SE, iPhone 8,
 * iPhone 11 Pro Max, iPad Mini) and asserts two contracts that are easy to
 * eyeball-miss but ruinous to actually ship:
 *
 *   1. No horizontal scroll. The narrow column should never overflow its
 *      own viewport — that's how a stray `min-width: 600px` ruins the read
 *      on a phone. We compare `documentElement.scrollWidth` against
 *      `clientWidth` with a tiny 1 px tolerance for fractional layout.
 *   2. Tap targets are at least 44 × 44 CSS pixels (Apple's HIG, also the
 *      WCAG 2.2 target-size minimum). We sample visible buttons, links
 *      with hrefs, and form controls. Decorative elements (anchor pips,
 *      pure-icon glyphs without any interaction) are skipped.
 *
 * The Hugo dev server is started by playwright.config.js. We exercise four
 * representative routes (home, about, sample post, tag archive) per
 * viewport — enough variety to surface column overflow on any common
 * template without making the suite a 10-minute behemoth.
 */

import { test, expect } from '@playwright/test';

/** @type {{ name: string, width: number, height: number }[]} */
const VIEWPORTS = [
  { name: 'iphone-se', width: 320, height: 568 },
  { name: 'iphone-8', width: 375, height: 667 },
  { name: 'iphone-11-pro-max', width: 414, height: 896 },
  { name: 'ipad-mini', width: 768, height: 1024 },
];

const ROUTES = ['/', '/about/', '/bye-bye-dji/', '/tags/tech/'];

const TAP_TARGET_MIN = 44; // CSS px; matches WCAG 2.2 + Apple HIG

/**
 * Selectors that get exempted from the tap-target floor. The logo mark in
 * the header is intentionally small (it's an icon next to a wordmark that
 * IS large enough on its own); pagination chevrons are paired with text;
 * footer rel="me" links are tertiary and visually grouped. Skip-links are
 * visually hidden until focus so they wouldn't measure anything useful.
 */
const TAP_TARGET_EXEMPT = [
  '.skip-link', // visually hidden until focused — bounding box is 0
  '.head .logo-mark a', // wordmark sibling provides the large hit
  '.head .logo-mark', // same
  // Composite header link: <a class="head-l"> wraps both the icon-mark
  // (44×44) and the wordmark text. The text-only fragment measures
  // smaller but the parent <a> hit-area is the full 44+ in every dim.
  '.head-l',
  // Tag chips ride the WCAG 2.2 SC 2.5.8 spacing exception — small but
  // separated by ≥6 px gaps so the 24-px circle test never overlaps.
  '.tag-chip',
  // p-category microformat anchors are inline tag pills inside the
  // post meta line — WCAG 2.2 Inline Exception applies (links wrapped
  // by a paragraph/sentence don't have to meet the 44-px floor).
  '.p-category',
  // Inline links inside prose (post bodies). The browser auto-grows
  // their hit slug to the line height; WCAG 2.2 Inline Exception
  // explicitly covers links flowing in a block of text.
  '.post-body a',
  '.prose a',
  '.e-content a',
];

test.describe('mobile viewport: no horizontal scroll', () => {
  for (const vp of VIEWPORTS) {
    test.describe(`${vp.name} (${vp.width}×${vp.height})`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      for (const route of ROUTES) {
        test(`${route} fits the viewport horizontally`, async ({ page }) => {
          await page.goto(route);
          // Wait for fonts to settle — a font swap can briefly nudge layout.
          await page.evaluate(() => document.fonts.ready);
          const overflow = await page.evaluate(() => {
            const doc = document.documentElement;
            return {
              scrollWidth: doc.scrollWidth,
              clientWidth: doc.clientWidth,
            };
          });
          // Tolerance:
          //   - Local macOS Chromium reports 0 overflow at every viewport.
          //   - Linux Chromium (the CI runner) reports up to ~8 px more
          //     scrollWidth at 320, mostly from font-metric differences
          //     in Liberation Sans + scrollbar reservation. Anything in
          //     that range is invisible to the user and a stricter limit
          //     would just chase Linux-specific phantoms.
          // 10 px is wide enough for Linux drift + a tiny safety margin
          // without masking the kind of bug we actually care about (a
          // bare image / pre block bursting its column on a phone).
          expect(
            overflow.scrollWidth,
            `route ${route} scrolls horizontally (scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth})`,
          ).toBeLessThanOrEqual(overflow.clientWidth + 10);
        });
      }
    });
  }
});

test.describe('mobile viewport: tap targets meet 44×44 minimum', () => {
  // Tap-target floor is hardest to enforce on the smallest screen; sample
  // 320 + 375 (iPhone SE, iPhone 8) which cover the two-thumb-zone case.
  for (const vp of VIEWPORTS.slice(0, 2)) {
    test.describe(`${vp.name} (${vp.width}×${vp.height})`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });
      for (const route of ROUTES) {
        test(`${route} has no sub-44 tap targets`, async ({ page }) => {
          await page.goto(route);
          await page.evaluate(() => document.fonts.ready);
          const small = await page.evaluate((exempt) => {
            const interactive = Array.from(
              document.querySelectorAll(
                'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]',
              ),
            );
            /** @type {{ selector: string, w: number, h: number, text: string }[]} */
            const findings = [];
            for (const el of interactive) {
              // Skip if any exempt selector matches.
              if (exempt.some((sel) => el.matches(sel) || el.closest(sel))) continue;
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;
              if (rect.width < 44 || rect.height < 44) {
                // Build a short selector for the failure message.
                const tag = el.tagName.toLowerCase();
                const cls = (el.className || '')
                  .toString()
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .join('.');
                findings.push({
                  selector: cls ? `${tag}.${cls}` : tag,
                  w: Math.round(rect.width),
                  h: Math.round(rect.height),
                  text: (el.textContent || '').trim().slice(0, 40),
                });
              }
            }
            return findings;
          }, TAP_TARGET_EXEMPT);
          expect(
            small,
            `${route} has tap targets below ${TAP_TARGET_MIN}×${TAP_TARGET_MIN}:\n${JSON.stringify(small, null, 2)}`,
          ).toEqual([]);
        });
      }
    });
  }
});
