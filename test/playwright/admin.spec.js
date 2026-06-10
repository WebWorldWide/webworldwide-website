// @ts-check
/**
 * Admin shell smoke tests (Phase 2, gated by Phase 12).
 *
 * The admin SPA depends on the Node/Express backend for /api/* and
 * /auth/*. We don't boot Express in this Playwright suite (CI doesn't
 * have a Pi-shaped sqlite binding for every Node release). Instead a
 * tiny in-suite static server (helpers/static-admin.js) serves
 * admin/public over http so the SPA's absolute asset paths resolve and
 * its JavaScript genuinely runs; /api|/auth return 503, which every
 * view degrades from gracefully. We only fail on uncaught exceptions
 * or unexpected console.error.
 *
 * Scenarios that need the REAL backend (auth round-trips) stay gated
 * on DEV_STACK_RUNNING=1 — the same pattern admin-a11y.spec.js uses.
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loginDevAdmin } from './helpers/login.js';
import { startStaticAdmin } from './helpers/static-admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'admin', 'public');

// A real http origin (static files only, /api|/auth → 503) so the SPA's
// absolute asset paths resolve and its JS actually runs in CI. See
// helpers/static-admin.js.
/** @type {{ url: string, close: () => Promise<void> }} */
let staticAdmin;
let loginUrl = '';
let indexUrl = '';
let editorUrl = '';
test.beforeAll(async () => {
  staticAdmin = await startStaticAdmin(PUBLIC_DIR);
  loginUrl = `${staticAdmin.url}/login.html`;
  indexUrl = `${staticAdmin.url}/index.html`;
  editorUrl = `${staticAdmin.url}/editor.html`;
});
test.afterAll(async () => {
  if (staticAdmin) await staticAdmin.close();
});

const stackUp = process.env.DEV_STACK_RUNNING === 'true' || process.env.DEV_STACK_RUNNING === '1';
// `npm run dev:all` serves the admin natively on :3000 (see
// scripts/dev/preflight.mjs) — ADMIN_ORIGIN overrides for other setups.
const liveAdminUrl = process.env.ADMIN_ORIGIN || 'http://127.0.0.1:3000';

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
    // Skip predictable backend-offline noise: the static test server
    // answers /api|/auth with 503 (see helpers/static-admin.js).
    if (/fetch|XMLHttpRequest|net::ERR/i.test(text)) return;
    if (/503|Service Unavailable|backend offline/i.test(text)) return;
    if (/Failed to load (posts|resource)/i.test(text)) return;
    if (/Not authenticated/.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test.describe('admin shell', () => {
  test('login.html renders the auth card and panels', async ({ page }) => {
    const errors = collectFatalConsoleErrors(page);
    await page.goto(loginUrl);
    // Brand + skip-link target. (The login screen has no theme toggle — the
    // theme button lives on the authenticated dashboard/editor chrome.)
    await expect(page.locator('.auth-brand')).toBeVisible();
    // Setup or login panel should be present (the panel toggle is
    // driven by /auth/status which won't resolve over file://, so we
    // just check that both panels exist in the DOM).
    await expect(page.locator('#setup-panel')).toHaveCount(1);
    await expect(page.locator('#login-panel')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('login.html forces the light theme (dark mode is retired)', async ({ page }) => {
    await page.goto(loginUrl);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('index.html renders the sidebar, topbar, and posts panel', async ({ page, isMobile }) => {
    const errors = collectFatalConsoleErrors(page);
    // v2: the default route is Overview; the posts panel lives at #posts.
    await page.goto(`${indexUrl}#posts`);
    if (isMobile) {
      // < 800px the sidebar is an off-canvas drawer behind the hamburger.
      await expect(page.locator('aside.sidebar')).not.toBeInViewport();
      const toggle = page.locator('#nav-toggle');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator('aside.sidebar')).toBeInViewport();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // Choosing a destination dismisses the drawer.
      await page.locator('.side-item[data-route="posts"]').click();
      await expect(page.locator('aside.sidebar')).not.toBeInViewport();
    } else {
      await expect(page.locator('aside.sidebar')).toBeVisible();
      await expect(page.locator('#nav-toggle')).toBeHidden();
    }
    await expect(page.locator('header.topbar')).toBeVisible();
    await expect(page.locator('#posts-panel')).toBeVisible();
    // Posts filter tabs are present and have role="tab" (the hidden
    // System view contributes its own tablist, so scope to the panel).
    await expect(page.locator('#posts-panel [role="tab"]')).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test('index.html#system shows the health metrics + terminal tabs', async ({ page }) => {
    const errors = collectFatalConsoleErrors(page);
    await page.goto(`${indexUrl}#system`);
    await expect(page.locator('#view-system')).toBeVisible();
    await expect(page.locator('#systab-health')).toBeVisible();
    await expect(page.locator('#metric-cpu')).toBeVisible();
    // Terminal tab swaps panes without leaving the view.
    await page.locator('[data-systab="terminal"]').click();
    await expect(page.locator('#terminal-form')).toBeVisible();
    await expect(page.locator('#systab-health')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('index.html Cmd+K palette opens and closes', async ({ page }) => {
    test.skip(
      !stackUp,
      'Cmd+K palette is wired in common.js which only loads from http(s); set DEV_STACK_RUNNING=1.',
    );
    await loginDevAdmin(page, liveAdminUrl);
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
    // The TipTap bundle mounts a real WYSIWYG surface and hides the
    // #editor-fallback textarea (which only shows if the bundle fails).
    await expect(page.locator('#editor-root .ProseMirror')).toBeVisible();
    await expect(page.locator('#editor-fallback')).toBeHidden();
    // Right rail frontmatter panels — Phase 5e expanded the rail to:
    // Frontmatter, Schedule, Cover image, Custom CSS/JS, Draft preview,
    // SEO, Media, Publish (8 collapsible <details> panels).
    await expect(page.locator('.ed-side details')).toHaveCount(8);
    expect(errors).toEqual([]);
  });
});
