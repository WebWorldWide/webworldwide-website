// @ts-check
/**
 * Phase 11 — Lighthouse mobile budget verification.
 *
 * Gated by the LHCI=true env var so it only fires when explicitly
 * requested — Chromium download + a real Lighthouse audit is too slow
 * for the default `npm test` gate. The Phase 1.5 `lighthouserc.json`
 * enforces the same budgets in CI via @lhci/cli; this file is the
 * local "run it once before opening a PR" check.
 *
 * Budgets (mirror lighthouserc.json):
 *   - performance     ≥ 0.95
 *   - accessibility   = 1.00
 *   - best-practices  = 1.00
 *   - seo             = 1.00
 *
 * Pages covered:
 *   /              home (above-the-fold + featured card + first row)
 *   /bye-bye-dji/  representative single post (h-entry + cover slot)
 *   /tags/tech/    tag index (list layout under term kind)
 *   /about/        page layout (static prose)
 *
 * Run:
 *   LHCI=true npx playwright test test/playwright/lighthouse.spec.js
 *
 * If you can't hit a budget locally:
 *   1. Check `npm run test:lighthouse` — that goes through @lhci/cli
 *      with the canonical config.
 *   2. If the score gap is environmental (CPU throttling on a hot
 *      laptop, etc.) document it in CONTRIBUTING.md → Performance and
 *      move the assertion behind a softer guard.
 *
 * Implementation note: we use Chrome's built-in Lighthouse runner via
 * a dynamic import so the suite still parses even on machines where
 * `lighthouse` isn't installed. The import failure becomes a graceful
 * skip with a clear message — no false failures for contributors who
 * skipped the optional dep.
 */
import { test, expect } from '@playwright/test';

const SHOULD_RUN = process.env.LHCI === 'true';

const PAGES = [
  { path: '/', name: 'home' },
  { path: '/bye-bye-dji/', name: 'post' },
  { path: '/tags/tech/', name: 'tag-archive' },
  { path: '/about/', name: 'about' },
];

const BUDGETS = {
  performance: 0.95,
  accessibility: 1.0,
  'best-practices': 1.0,
  seo: 1.0,
};

test.describe('Lighthouse mobile budgets', () => {
  test.skip(!SHOULD_RUN, 'Set LHCI=true to run the full Lighthouse sweep.');

  for (const { path, name } of PAGES) {
    test(`${name} (${path}) hits all four budgets`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'Lighthouse only runs in Chromium.');

      let lighthouse;
      try {
        // Dynamic import so the test file parses on machines where
        // lighthouse isn't installed yet.
        const mod = await import('lighthouse');
        lighthouse = mod.default || mod;
      } catch (err) {
        test.skip(
          true,
          `lighthouse package not installed (npm i -D lighthouse). Original error: ${err.message}`,
        );
        return;
      }

      // Reuse Playwright's launched Chromium via the CDP endpoint
      // Playwright exposes on browserContext().
      const browser = page.context().browser();
      const wsEndpoint = browser.wsEndpoint?.();
      if (!wsEndpoint) {
        test.skip(true, 'Playwright Chromium did not expose a wsEndpoint for Lighthouse.');
        return;
      }
      // Lighthouse expects the dev-tools URL; Playwright already
      // returns the right shape. Extract the port from the ws URL.
      const url = new URL(wsEndpoint);
      const port = Number(url.port);

      const result = await lighthouse(
        page.url() + path.slice(1),
        {
          port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: Object.keys(BUDGETS),
        },
        {
          extends: 'lighthouse:default',
          settings: {
            formFactor: 'mobile',
            screenEmulation: {
              mobile: true,
              width: 412,
              height: 823,
              deviceScaleFactor: 1.75,
              disabled: false,
            },
            throttling: {
              rttMs: 150,
              throughputKbps: 1638.4,
              cpuSlowdownMultiplier: 4,
              requestLatencyMs: 0,
              downloadThroughputKbps: 0,
              uploadThroughputKbps: 0,
            },
          },
        },
      );

      const cats = result.lhr.categories;
      for (const [key, min] of Object.entries(BUDGETS)) {
        const score = cats[key]?.score;
        expect(
          score,
          `${name} ${key} = ${score} (need ≥ ${min}). Run \`npm run test:lighthouse\` ` +
            `for the full report.`,
        ).toBeGreaterThanOrEqual(min);
      }
    });
  }
});
