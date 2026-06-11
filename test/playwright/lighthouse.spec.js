// @ts-check
/**
 * Phase 11 — Lighthouse mobile budget verification.
 *
 * Gated by the LHCI=true env var so it only fires when explicitly
 * requested — a real throttled Lighthouse audit is too slow for the
 * default `npm test` gate. The Phase 1.5 `lighthouserc.json` enforces
 * the same budgets in CI via \@lhci/cli; this file is the local "run it
 * once before opening a PR" check.
 *
 * Budgets (mirror lighthouserc.json):
 *   - performance     ≥ 0.90
 *   - accessibility   ≥ 0.95
 *   - best-practices  ≥ 0.95
 *   - seo             = 1.00
 *
 * Pages covered (same three URLs lighthouserc.json audits):
 *   /                    home (above-the-fold + featured card + first row)
 *   /blog/               listing index (card grid + pager)
 *   /blog/bye-bye-dji/   representative single post (h-entry + cover slot)
 *
 * Run:
 *   LHCI=true npx playwright test test/playwright/lighthouse.spec.js
 *
 * Like the canonical \@lhci/cli gate, this audits the PRODUCTION build
 * (site/dist, built on demand) served over a local static origin — the
 * Astro dev server is unminified and unbundled, so dev-server perf
 * scores are meaningless. Lighthouse drives a dedicated Chromium
 * launched with a remote-debugging port (Playwright's default browser
 * no longer exposes a CDP endpoint).
 *
 * If you can't hit a budget locally:
 *   1. Check `npm run test:lighthouse` — that goes through \@lhci/cli
 *      with the canonical config.
 *   2. If the score gap is environmental (CPU throttling on a hot
 *      laptop, etc.) document it in CONTRIBUTING.md → Performance and
 *      move the assertion behind a softer guard.
 */
import { test, expect, chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticSite } from './helpers/static-site.js';

const SHOULD_RUN = process.env.LHCI === 'true';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'site', 'dist');

const PAGES = [
  { path: '/', name: 'home' },
  { path: '/blog/', name: 'listing' },
  { path: '/blog/bye-bye-dji/', name: 'post' },
];

const BUDGETS = {
  performance: 0.9,
  accessibility: 0.95,
  'best-practices': 0.95,
  seo: 1.0,
};

test.describe('Lighthouse mobile budgets', () => {
  test.skip(!SHOULD_RUN, 'Set LHCI=true to run the full Lighthouse sweep.');

  /** @type {{ url: string, close: () => Promise<void> } | undefined} */
  let site;

  test.beforeAll(async () => {
    if (!SHOULD_RUN) return;
    if (!existsSync(join(DIST_DIR, 'index.html'))) {
      execSync('npm --prefix site run build', {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        timeout: 300_000,
      });
    }
    site = await startStaticSite(DIST_DIR);
  });

  test.afterAll(async () => {
    await site?.close();
  });

  for (const { path, name } of PAGES) {
    test(`${name} (${path}) hits all four budgets`, async ({ browserName }, testInfo) => {
      test.skip(browserName !== 'chromium', 'Lighthouse only runs in Chromium.');
      // A throttled (4× CPU) Lighthouse audit is slow on modest hardware.
      test.setTimeout(300_000);

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

      // Offset the debug port by workerIndex so parallel workers never
      // collide.
      const port = 9222 + testInfo.workerIndex;
      const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
      let result;
      try {
        result = await lighthouse(
          new URL(path, site.url).toString(),
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
      } finally {
        await browser.close();
      }

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
