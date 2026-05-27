// @ts-check
/**
 * Admin shell smoke tests (Phase 2, gated by Phase 12).
 *
 * The admin SPA depends on the Node/Express backend for /api/* and
 * /auth/*. We don't boot Express in this Playwright suite (CI doesn't
 * have a Pi-shaped sqlite binding for every Node release). Instead we
 * load the static HTML files via file:// URLs and assert the shells
 * render the expected DOM landmarks without throwing.
 *
 * The page-level fetches that the JS issues (e.g. /auth/status) will
 * fail with net::ERR_FAILED — that's fine. The frontend wraps those
 * in try/catch and falls through gracefully; we only fail the test on
 * uncaught exceptions or hard JS errors.
 *
 * Two scenarios require a real http(s) origin (live admin server) and
 * are gated on DEV_STACK_RUNNING=1 — the same pattern admin-a11y.spec.js
 * uses. Under file:// the scripts referenced via absolute paths
 * (`/js/common.js`) can't load, so `window.TE` is never populated and
 * the localStorage write path used by the theme toggle can fire before
 * the listener wires up. See CONTRIBUTING.md for how to enable them.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'admin', 'public');
const loginUrl = pathToFileURL(join(PUBLIC_DIR, 'login.html')).href;
const indexUrl = pathToFileURL(join(PUBLIC_DIR, 'index.html')).href;
const editorUrl = pathToFileURL(join(PUBLIC_DIR, 'editor.html')).href;

const stackUp = process.env.DEV_STACK_RUNNING === 'true' || process.env.DEV_STACK_RUNNING === '1';
const liveAdminUrl = process.env.ADMIN_ORIGIN || 'http://127.0.0.1:8787';

/**
 * Set up a console listener that fails the test on any unexpected
 * console.error. Network errors from missing /api/* endpoints are
 * filtered (the page is loaded over file://, so all backend fetches
 * fail expectedly).
 * @param {import('@playwright/test').Page} page Playwright page handle.
 * @returns {string[]} Live array of captured fatal errors.
 */
function collectFatalConsoleErrors(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Skip predictable file:// network failures.
    if (/fetch|XMLHttpRequest|net::ERR/i.test(text)) return;
    if (/Not authenticated/.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe('admin shell', () => {
  test('login.html renders the auth card and theme button', async ({ page }) => {
    const errors = collectFatalConsoleErrors(page);
    await page.goto(loginUrl);
    // Brand + skip-link target
    await expect(page.locator('.auth-brand')).toBeVisible();
    await expect(page.locator('#btn-theme')).toBeVisible();
    // Setup or login panel should be present (the panel toggle is
    // driven by /auth/status which won't resolve over file://, so we
    // just check that both panels exist in the DOM).
    await expect(page.locator('#setup-panel')).toHaveCount(1);
    await expect(page.locator('#login-panel')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('login.html theme toggle flips data-theme', async ({ page }) => {
    test.skip(
      !stackUp,
      'Theme toggle wires up in common.js which only loads from http(s); set DEV_STACK_RUNNING=1.',
    );
    await page.goto(`${liveAdminUrl}/login.html`);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.locator('#btn-theme').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('index.html renders the sidebar, topbar, and posts panel', async ({ page }) => {
    const errors = collectFatalConsoleErrors(page);
    await page.goto(indexUrl);
    await expect(page.locator('aside.sidebar')).toBeVisible();
    await expect(page.locator('header.topbar')).toBeVisible();
    await expect(page.locator('#posts-panel')).toBeVisible();
    // Tabs are present and have role="tab"
    await expect(page.locator('[role="tab"]')).toHaveCount(4);
    // Pi Health metric panel exists
    await expect(page.locator('#health-panel')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('index.html Cmd+K palette opens and closes', async ({ page }) => {
    test.skip(
      !stackUp,
      'Cmd+K palette is wired in common.js which only loads from http(s); set DEV_STACK_RUNNING=1.',
    );
    await page.goto(`${liveAdminUrl}/index.html`);
    await page.waitForFunction(() => Boolean(/** @type {any} */ (window).TE));
    await page.keyboard.press('Meta+K');
    await expect(page.locator('#cmdk')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#cmdk')).toBeHidden();
  });

  test('editor.html renders the title, slug, body, and frontmatter panels', async ({ page }) => {
    const errors = collectFatalConsoleErrors(page);
    await page.goto(editorUrl);
    await expect(page.locator('#post-title')).toBeVisible();
    await expect(page.locator('#post-slug')).toBeVisible();
    await expect(page.locator('#editor-root')).toBeVisible();
    // Phase 3 will replace #editor-fallback with TipTap. For now it's
    // a real <textarea> the editor.js code drives.
    await expect(page.locator('#editor-fallback')).toBeVisible();
    // Right rail frontmatter panels — Phase 5e expanded the rail to:
    // Frontmatter, Schedule, Cover image, Custom CSS/JS, Draft preview,
    // SEO, Media, Publish (8 collapsible <details> panels).
    await expect(page.locator('.ed-side details')).toHaveCount(8);
    expect(errors).toEqual([]);
  });
});
