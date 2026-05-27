// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Terminal Eighty.
 *
 * Test suites:
 *   - test/playwright/site.spec.js     Hugo public-site smoke tests
 *   - test/playwright/a11y.spec.js     axe-core a11y audit
 *   - test/playwright/admin.spec.js    admin shell smoke (currently skipped — Phase 2)
 *
 * The `hugo server` instance is started automatically via webServer.
 */
export default defineConfig({
  testDir: './test/playwright',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:1414',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'cd site && hugo server -D --port 1414 --bind 127.0.0.1 --disableFastRender',
    url: 'http://127.0.0.1:1414/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
