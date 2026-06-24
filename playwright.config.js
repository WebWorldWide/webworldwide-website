// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Web World Wide.
 *
 * Test suites:
 *   - test/playwright/site.spec.js          public-site smoke (home + blog)
 *   - test/playwright/post.spec.js          post detail + comments + ⌘K
 *   - test/playwright/a11y.spec.js          axe-core a11y audit (public)
 *   - test/playwright/admin.spec.js         admin shell smoke (port 3000)
 *   - test/playwright/admin-a11y.spec.js    axe-core a11y audit (admin)
 *   - test/playwright/admin-mobile.spec.js  admin responsive smoke
 *   - test/playwright/mobile.spec.js        public-site mobile viewport
 *   - test/playwright/local-dev.spec.js     dev-experience helpers
 *   - test/playwright/lighthouse.spec.js    Lighthouse CI gate runner
 *
 * The Astro dev server starts automatically via webServer.
 */
export default defineConfig({
  testDir: './test/playwright',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // CI installs only the Chromium engine (see .github/workflows/e2e.yml), so
  // run the Chromium-engine projects there; the full cross-browser matrix
  // runs locally.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ].filter((p) => !process.env.CI || ['chromium', 'mobile-chrome'].includes(p.name)),
  webServer: [
    {
      command: 'npm --prefix site run dev',
      url: 'http://127.0.0.1:4321/',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      // Astro 7 auto-detaches `astro dev` into a background daemon when it
      // detects an automation/agent (CI, Playwright), so the foreground
      // command exits immediately and Playwright reports "webServer exited
      // early". Setting ASTRO_DEV_BACKGROUND keeps it in the foreground so
      // Playwright owns the process lifecycle. (A human `npm run dev` is
      // unaffected — agent mode only triggers under automation.)
      env: { ASTRO_DEV_BACKGROUND: '0' },
    },
  ],
});
